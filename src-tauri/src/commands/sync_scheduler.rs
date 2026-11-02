// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! G2a：手动 / 后台调度（按间隔触发 推送 + 拉取）。
//!
//! ## 定位（为什么不是第二套同步引擎）
//! 每次触发只做一件事：按既有编排跑一次 [`push_configured`] + [`pull_configured`]。
//! 传输选型、块寻址、冲突裁决（默认 `keep_both`）、journal 全部复用
//! `commands/sync_target.rs`——本模块**不新增任何同步语义**，只决定「什么时候跑」。
//!
//! ## 门禁（显式 it，不是隐含约定）
//! [`evaluate_gate`] 的第一判据就是全局开关（`SyncConfigFile.enabled` / `sync_enabled`）。
//! 开关关闭时：调度器不做任何 I/O、记一条 `skip` journal 并**自行停机**；手动入口
//! （[`sync_now`]）也走同一条 [`run_cycle`]，因此同样被 `open_target_file` 拒绝。
//! 关窗 / 休眠 / 断网属于「跳过本次」而非失败：记 journal（含 skip 原因）后继续下一档。
//!
//! ## 为什么跳过也要写 journal
//! 「上次同步是 3 小时前」必须能解释。跳过原因（`window_closed` / `sleeping` /
//! `offline` / `no_artifact`）写进既有 `.novel/sync-journal.jsonl`，读取器
//! （`read_journal`）无需改动即可解析——journal 仍是会话态、可清、非第二真源。
//!
//! ## 导出产物的唯一性
//! 后台触发没有「显式传入产物路径」的调用者，因此固定取 `backups/auto/` 下最新的
//! `.zip`（既有自动备份落点）。找不到产物 → `skip:no_artifact`，绝不凭空造一个产物。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::sync_target::{
    append_transport_journal, is_local_endpoint, load_config_file, pull_configured,
    push_configured, SyncConfigFile,
};

pub use super::sync_target::{SCHEDULE_DEFAULT_INTERVAL_MINUTES, SCHEDULE_INTERVAL_MINUTES};

/// 自动备份落点（既有约定；后台触发从这里取唯一同步对象）。
pub const AUTO_BACKUP_DIR: &str = "backups/auto";

/// 休眠判定容差（秒）：实际墙钟间隔超出「计划间隔 + 容差」即认为本次休眠过。
///
/// 用墙钟而不是 `Instant`：系统休眠期间墙钟一定前进，`Instant` 在部分平台会暂停。
const SLEEP_DRIFT_TOLERANCE_SECS: i64 = 90;

/// 网络探针超时（毫秒）：只判断「有没有路」，不做业务请求。
const NETWORK_PROBE_TIMEOUT_MS: u64 = 800;

// ── 跳过原因 / 环境快照 / 门禁 ─────────────────────────────────────────────

/// 一次触发被跳过的原因（具名枚举，便于单测与 journal 分类）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// 全局开关关闭（**第一判据**：调度器与一切自动触发全停）。
    Disabled,
    /// 尚未配置传输目标。
    NotConfigured,
    /// 没有任何可见窗口（关窗 / 隐藏）。
    WindowClosed,
    /// 刚从头一次休眠里醒来（墙钟跳变）。
    Sleeping,
    /// 网络不可达。
    Offline,
    /// `backups/auto/` 下没有可推送的导出产物。
    NoArtifact,
    /// 内容未变（manifest 指纹与本地水位一致）→ 本轮不产生新版本、不拉取。
    Unchanged,
}

impl SkipReason {
    /// journal 里的稳定 token（面向诊断，不面向界面文案）。
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::Disabled => "disabled",
            SkipReason::NotConfigured => "not_configured",
            SkipReason::WindowClosed => "window_closed",
            SkipReason::Sleeping => "sleeping",
            SkipReason::Offline => "offline",
            SkipReason::NoArtifact => "no_artifact",
            SkipReason::Unchanged => "unchanged",
        }
    }

    /// journal 文案（英文诊断串；界面文案走 i18n `sync.schedule.skip.*`）。
    pub fn message(self) -> &'static str {
        match self {
            SkipReason::Disabled => {
                "[sync_scheduler] skipped: the global sync switch is off; the scheduler and every automatic trigger stay stopped"
            }
            SkipReason::NotConfigured => {
                "[sync_scheduler] skipped: cloud backup is not configured"
            }
            SkipReason::WindowClosed => "[sync_scheduler] skipped: no visible window",
            SkipReason::Sleeping => "[sync_scheduler] skipped: the device just woke from sleep",
            SkipReason::Offline => "[sync_scheduler] skipped: the network is unreachable",
            SkipReason::NoArtifact => {
                "[sync_scheduler] skipped: no export artifact under backups/auto"
            }
            SkipReason::Unchanged => {
                "[sync_scheduler] skipped: the export artifact content is unchanged since the last sync"
            }
        }
    }
}

/// 触发前看到的环境（纯数据，便于单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncEnvironment {
    /// 全局开关（`sync_enabled`）。
    pub enabled: bool,
    /// 是否有可见窗口。
    pub window_open: bool,
    /// 本档是否刚从休眠里醒来。
    pub sleeping: bool,
    /// 网络是否可达（本地文件夹目标恒为 true）。
    pub online: bool,
}

/// 显式门禁：全局开关是第一判据，其后依次是关窗 / 休眠 / 断网。
///
/// 顺序不是随意排的：开关关闭必须**优先于**所有其他原因，否则「关窗跳过」会把
/// 「用户明确关掉了同步」这件事掩盖掉。
pub fn evaluate_gate(env: &SyncEnvironment) -> Result<(), SkipReason> {
    if !env.enabled {
        return Err(SkipReason::Disabled);
    }
    if !env.window_open {
        return Err(SkipReason::WindowClosed);
    }
    if env.sleeping {
        return Err(SkipReason::Sleeping);
    }
    if !env.online {
        return Err(SkipReason::Offline);
    }
    Ok(())
}

/// 把「跳过本次」记进既有传输 journal（含 skip 原因）。
///
/// 复用 [`append_transport_journal`] 而不是新增一套格式：journal 仍是一条
/// JSONL 通道，`read_journal` 无需改动即可解析（未知字段被忽略）。
pub fn append_skip_journal(project_path: &Path, reason: SkipReason) -> Result<(), String> {
    append_transport_journal(
        Some(project_path),
        "skip",
        &format!("scheduler:{}", reason.as_str()),
        None,
        reason.message(),
    )
}

// ── 环境探测 ───────────────────────────────────────────────────────────────

/// 是否存在可见窗口（关窗 / 全部隐藏 → 视为关窗）。
fn window_open(app: &AppHandle) -> bool {
    let windows = app.webview_windows();
    if windows.is_empty() {
        return false;
    }
    windows
        .values()
        .any(|window| window.is_visible().unwrap_or(true))
}

/// 端点主机与端口（只认 http/https；其他形态返回 `None` = 不做网络判定）。
fn endpoint_host_port(endpoint: &str) -> Option<(String, u16)> {
    let trimmed = endpoint.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() {
        return None;
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => port
            .parse::<u16>()
            .ok()
            .map(|port| (host.to_string(), port)),
        _ => Some((authority.to_string(), default_port)),
    }
}

/// 网络可达性探针（本地文件夹目标不依赖网络 → 恒 true）。
///
/// 只做一次带超时的 TCP connect：不解析业务响应、不携带凭据。
pub fn network_reachable(endpoint: &str) -> bool {
    if endpoint.trim().is_empty() || is_local_endpoint(endpoint) {
        return true;
    }
    let Some((host, port)) = endpoint_host_port(endpoint) else {
        // 非 http(s) 端点：没有可靠的探针语义 → 不阻断（交给真实推送去报错）。
        return true;
    };
    use std::net::ToSocketAddrs;
    let Ok(addresses) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    let timeout = Duration::from_millis(NETWORK_PROBE_TIMEOUT_MS);
    addresses
        .into_iter()
        .any(|address| std::net::TcpStream::connect_timeout(&address, timeout).is_ok())
}

/// 间隔归一化：不在三档之内一律回落到默认档（调度器不因非法档位空转）。
pub fn normalize_interval(interval_minutes: u32) -> u32 {
    if SCHEDULE_INTERVAL_MINUTES.contains(&interval_minutes) {
        interval_minutes
    } else {
        SCHEDULE_DEFAULT_INTERVAL_MINUTES
    }
}

/// 配置里的调度间隔（未配置 → 默认档）。
fn configured_interval(file: Option<&SyncConfigFile>) -> u32 {
    normalize_interval(
        file.map(|file| file.interval_minutes())
            .unwrap_or(SCHEDULE_DEFAULT_INTERVAL_MINUTES),
    )
}

// ── 一次同步周期 ───────────────────────────────────────────────────────────

/// 一次同步周期的结果（前端 raw 字段是 snake_case）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncTickResult {
    /// 是否真的执行了推送 / 拉取。
    pub ran: bool,
    /// 跳过原因（`ran == false` 时非空；与 [`SkipReason::as_str`] 同值域）。
    pub skip_reason: Option<String>,
    /// 本次同步对象（导出产物的 manifest id）。
    pub manifest_id: String,
    /// 推送后达到的本地版本水位。
    pub revision: u64,
    /// 拉取裁决（`apply` / `refuse_stale` / `keep_both`）。
    pub decision: String,
    /// 诊断串（Rust 侧英文；界面文案走 i18n）。
    pub message: String,
}

impl SyncTickResult {
    /// 内容未变：没有新版本、没有传输，但**保留真实版本水位**（不是“没跑成”）。
    fn unchanged(manifest_id: String, revision: u64) -> Self {
        SyncTickResult {
            ran: false,
            skip_reason: Some(SkipReason::Unchanged.as_str().to_string()),
            manifest_id,
            revision,
            decision: "unchanged".to_string(),
            message: SkipReason::Unchanged.message().to_string(),
        }
    }

    fn skipped(reason: SkipReason) -> Self {
        SyncTickResult {
            ran: false,
            skip_reason: Some(reason.as_str().to_string()),
            manifest_id: String::new(),
            revision: 0,
            decision: String::new(),
            message: reason.message().to_string(),
        }
    }
}

/// `backups/auto/` 下最新的 `.zip`（按修改时间；目录不存在 → `None`）。
pub fn latest_auto_artifact(project_path: &Path) -> Option<PathBuf> {
    let dir = project_path.join(AUTO_BACKUP_DIR);
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_zip = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("zip"))
            .unwrap_or(false);
        if !is_zip {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best
            .as_ref()
            .map(|(current, _)| modified > *current)
            .unwrap_or(true)
        {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

/// 跑一次完整同步周期：推送最新导出产物，再把同一清单拉回（快照入库）。
///
/// 手动按钮与后台调度**共用**这一条路径（任务要求「手动按钮复用同一命令」），
/// 因此「开关关闭 / 未配置 / 无产物 / 内容未变」的判定只写一份。
///
/// **幂等**（F-010）：产物内容指纹与本地水位一致时 push 不抬版本、pull 不重拷快照，
/// 本轮记 `skip:unchanged` —— 否则每个调度周期都会造一个新版本 + 一份完整本地快照
/// （15 分钟档 = 一天 96 个完整副本 + 96 次远端 commit）。
pub async fn run_cycle(
    project_path: &Path,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncTickResult, String> {
    let Some(file) = load_config_file(project_path)? else {
        append_skip_journal(project_path, SkipReason::NotConfigured)?;
        return Ok(SyncTickResult::skipped(SkipReason::NotConfigured));
    };
    if !file.enabled {
        append_skip_journal(project_path, SkipReason::Disabled)?;
        return Ok(SyncTickResult::skipped(SkipReason::Disabled));
    }
    let Some(artifact) = latest_auto_artifact(project_path) else {
        append_skip_journal(project_path, SkipReason::NoArtifact)?;
        return Ok(SyncTickResult::skipped(SkipReason::NoArtifact));
    };
    let pushed = push_configured(project_path, &artifact, device_id, timestamp).await?;
    let pulled = pull_configured(project_path, &pushed.manifest_id, device_id, timestamp).await?;
    // F-010：内容未变 → 不产生新版本、不重传、不重复拷快照，记一条 skip:unchanged。
    //
    // 两个条件都要求：push 说「内容指纹与本地水位一致」，pull 说「远端版本与本地一致
    // 且该版本已入库」。任一不成立（例如另一台设备推了新版本）就必须按正常结果返回，
    // 否则会把「远端有新内容」误报成「什么都没发生」。
    if pushed.unchanged && pulled.decision == "unchanged" {
        append_skip_journal(project_path, SkipReason::Unchanged)?;
        return Ok(SyncTickResult::unchanged(
            pushed.manifest_id,
            pushed.revision,
        ));
    }
    Ok(SyncTickResult {
        ran: true,
        skip_reason: None,
        manifest_id: pushed.manifest_id,
        revision: pushed.revision,
        decision: pulled.decision,
        message: pulled.message,
    })
}

// ── 调度器状态 ─────────────────────────────────────────────────────────────

/// 调度器内部状态（`Mutex` 保护；所有跨 await 的地方都不持锁）。
#[derive(Debug, Default)]
struct SchedulerInner {
    /// 代际：`start` / `stop` 递增；旧循环发现代际变了就自行退出（不得双跑）。
    generation: u64,
    running: bool,
    project_path: Option<PathBuf>,
    device_id: String,
    interval_minutes: u32,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_outcome: Option<String>,
}

/// 调度器句柄（`Arc` 内部共享，供 `tauri::State` 与后台任务同时持有）。
#[derive(Debug, Clone, Default)]
pub struct SyncSchedulerState {
    inner: Arc<Mutex<SchedulerInner>>,
}

impl SyncSchedulerState {
    fn lock(&self) -> MutexGuard<'_, SchedulerInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn clone_handle(&self) -> Self {
        SyncSchedulerState {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// 调度器对外状态（前端 raw 字段是 snake_case）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncSchedulerStatus {
    /// 调度器是否在跑（全局开关关闭时会自行停机 → false）。
    pub running: bool,
    /// 被调度的项目根。
    pub project_path: Option<String>,
    /// 间隔分钟数（三档之一）。
    pub interval_minutes: u32,
    /// 全局开关（`sync_enabled`）的当前值。
    pub sync_enabled: bool,
    /// 上次触发时间（RFC3339，UTC）。
    pub last_run_at: Option<String>,
    /// 下次预计触发时间（RFC3339，UTC）；未运行时为空。
    pub next_run_at: Option<String>,
    /// 上次结果（`apply:3` / `skip:offline` / `error: …`）。
    pub last_outcome: Option<String>,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn now_plus_minutes(minutes: u32) -> String {
    (chrono::Utc::now() + chrono::Duration::minutes(i64::from(minutes)))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn status_of(inner: &SchedulerInner, sync_enabled: bool) -> SyncSchedulerStatus {
    SyncSchedulerStatus {
        running: inner.running,
        project_path: inner
            .project_path
            .as_ref()
            .map(|path| path.to_string_lossy().replace('\\', "/")),
        interval_minutes: inner.interval_minutes,
        sync_enabled,
        last_run_at: inner.last_run_at.clone(),
        next_run_at: if inner.running {
            inner.next_run_at.clone()
        } else {
            None
        },
        last_outcome: inner.last_outcome.clone(),
    }
}

/// 当前配置里的全局开关（缺失/非法 → false，绝不把不可读当成「开着」）。
fn sync_enabled_of(project_path: Option<&Path>) -> bool {
    project_path
        .and_then(|path| load_config_file(path).ok().flatten())
        .map(|file| file.enabled)
        .unwrap_or(false)
}

fn outcome_label(result: &SyncTickResult) -> String {
    if result.ran {
        format!("{}:{}", result.decision, result.revision)
    } else {
        format!(
            "skip:{}",
            result.skip_reason.as_deref().unwrap_or("unknown")
        )
    }
}

// ── 后台循环 ───────────────────────────────────────────────────────────────

/// 后台间隔循环（每档跑一次 [`run_cycle`]）。
///
/// 退出条件（任一）：代际变了（stop / restart）、全局开关关闭（自行停机）。
async fn scheduler_loop(
    app: AppHandle,
    state: SyncSchedulerState,
    project_path: PathBuf,
    device_id: String,
    interval_minutes: u32,
    generation: u64,
) {
    let interval_secs = i64::from(interval_minutes) * 60;
    let mut last_tick = chrono::Utc::now();
    loop {
        tokio::time::sleep(Duration::from_secs(interval_secs as u64)).await;
        // 代际检查：stop / restart 之后旧循环必须自行退出（不得双跑）。
        {
            let inner = state.lock();
            if !inner.running || inner.generation != generation {
                return;
            }
        }

        // 休眠检测：墙钟跳变超过「计划间隔 + 容差」→ 本档判定为刚醒。
        let now = chrono::Utc::now();
        let elapsed = (now - last_tick).num_seconds();
        let sleeping = elapsed > interval_secs + SLEEP_DRIFT_TOLERANCE_SECS;
        last_tick = now;

        let file = load_config_file(&project_path).ok().flatten();
        let enabled = file.as_ref().map(|file| file.enabled).unwrap_or(false);
        let endpoint = file
            .as_ref()
            .map(|file| file.transport_config().endpoint)
            .unwrap_or_default();
        let probe_endpoint = endpoint.clone();
        let online =
            tauri::async_runtime::spawn_blocking(move || network_reachable(&probe_endpoint))
                .await
                .unwrap_or(true);

        let environment = SyncEnvironment {
            enabled,
            window_open: window_open(&app),
            sleeping,
            online,
        };

        match evaluate_gate(&environment) {
            Err(reason) => {
                let _ = append_skip_journal(&project_path, reason);
                let mut inner = state.lock();
                inner.last_outcome = Some(format!("skip:{}", reason.as_str()));
                if reason == SkipReason::Disabled {
                    // 全局开关关闭：调度器与一切自动触发全停（显式门禁 → 自行停机）。
                    inner.running = false;
                    inner.next_run_at = None;
                    return;
                }
                inner.next_run_at = Some(now_plus_minutes(interval_minutes));
            }
            Ok(()) => {
                let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
                let outcome = run_cycle(&project_path, &device_id, &timestamp).await;
                let mut inner = state.lock();
                match outcome {
                    Ok(result) => {
                        inner.last_outcome = Some(outcome_label(&result));
                        if result.ran {
                            inner.last_run_at = Some(now_rfc3339());
                        }
                    }
                    Err(reason) => {
                        // 一次失败不算停机：记结果，等下一档重试。
                        inner.last_outcome = Some(format!("error: {reason}"));
                    }
                }
                inner.next_run_at = Some(now_plus_minutes(interval_minutes));
            }
        }
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// 启动后台调度（全局开关关闭时**拒绝启动**：这是显式门禁，不是隐式约定）。
#[tauri::command]
pub async fn sync_scheduler_start(
    app: AppHandle,
    state: State<'_, SyncSchedulerState>,
    project_path: String,
    device_id: String,
    interval_minutes: Option<u32>,
) -> Result<SyncSchedulerStatus, String> {
    let project = PathBuf::from(project_path.trim());
    if project.as_os_str().is_empty() {
        return Err("[sync_scheduler] project_path must not be empty".to_string());
    }
    let file = load_config_file(&project)?;
    let enabled = file.as_ref().map(|file| file.enabled).unwrap_or(false);
    if !enabled {
        return Err(
            "[sync_scheduler] the global sync switch is off; enable it before starting the scheduler"
                .to_string(),
        );
    }
    let interval = interval_minutes
        .map(normalize_interval)
        .unwrap_or_else(|| configured_interval(file.as_ref()));

    let generation = {
        let mut inner = state.lock();
        inner.generation += 1;
        inner.running = true;
        inner.project_path = Some(project.clone());
        inner.device_id = device_id.clone();
        inner.interval_minutes = interval;
        inner.next_run_at = Some(now_plus_minutes(interval));
        inner.last_outcome = None;
        inner.generation
    };

    let task_state = state.clone_handle();
    tauri::async_runtime::spawn(scheduler_loop(
        app, task_state, project, device_id, interval, generation,
    ));

    let inner = state.lock();
    Ok(status_of(&inner, enabled))
}

/// 停止后台调度（代际递增 → 旧循环自行退出）。
#[tauri::command]
pub async fn sync_scheduler_stop(
    state: State<'_, SyncSchedulerState>,
) -> Result<SyncSchedulerStatus, String> {
    let mut inner = state.lock();
    inner.generation += 1;
    inner.running = false;
    inner.next_run_at = None;
    let enabled = sync_enabled_of(inner.project_path.as_deref());
    Ok(status_of(&inner, enabled))
}

/// 读取调度器状态（不触网、不触盘以外的副作用）。
#[tauri::command]
pub async fn sync_scheduler_status(
    state: State<'_, SyncSchedulerState>,
) -> Result<SyncSchedulerStatus, String> {
    let inner = state.lock();
    let enabled = sync_enabled_of(inner.project_path.as_deref());
    Ok(status_of(&inner, enabled))
}

/// 「立即同步」：手动触发一次完整周期（与后台调度**同一条** [`run_cycle`] 路径）。
///
/// 全局开关关闭时 `run_cycle` 返回 `skip:disabled`（不是静默成功）；未配置传输目标
/// 时返回 `skip:not_configured`。界面按 `skip_reason` 展示原因，而不是当成异常。
#[tauri::command]
pub async fn sync_now(
    state: State<'_, SyncSchedulerState>,
    project_path: String,
    device_id: String,
) -> Result<SyncTickResult, String> {
    let project = PathBuf::from(project_path.trim());
    if project.as_os_str().is_empty() {
        return Err("[sync_scheduler] project_path must not be empty".to_string());
    }
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let result = run_cycle(&project, &device_id, &timestamp).await?;
    {
        let mut inner = state.lock();
        inner.last_outcome = Some(outcome_label(&result));
        if result.ran {
            inner.last_run_at = Some(now_rfc3339());
            if inner.running {
                inner.next_run_at = Some(now_plus_minutes(inner.interval_minutes));
            }
        }
    }
    Ok(result)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sync_target::{
        save_config_file, LocalFolderConfig, SyncConfigFile, LOCAL_ENDPOINT,
    };
    use std::fs;

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "nbsched-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&root).expect("create temp root");
            TempTree { root }
        }

        fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(&path, bytes).expect("write fixture");
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn local_config(target: &Path, enabled: bool) -> SyncConfigFile {
        SyncConfigFile {
            endpoint: LOCAL_ENDPOINT.to_string(),
            root: String::new(),
            credential_ref: String::new(),
            enabled,
            github: None,
            local: Some(LocalFolderConfig {
                local_path: target.to_string_lossy().replace('\\', "/"),
            }),
            schedule: None,
        }
    }

    #[test]
    fn gate_stops_everything_when_the_global_switch_is_off() {
        let all_clear = SyncEnvironment {
            enabled: true,
            window_open: true,
            sleeping: false,
            online: true,
        };
        assert_eq!(evaluate_gate(&all_clear), Ok(()));

        // 全局开关是第一判据：即使同时关窗/休眠/断网，也必须报 Disabled。
        assert_eq!(
            evaluate_gate(&SyncEnvironment {
                enabled: false,
                window_open: false,
                sleeping: true,
                online: false,
            }),
            Err(SkipReason::Disabled)
        );
        assert_eq!(
            evaluate_gate(&SyncEnvironment {
                enabled: true,
                window_open: false,
                sleeping: false,
                online: true,
            }),
            Err(SkipReason::WindowClosed)
        );
        assert_eq!(
            evaluate_gate(&SyncEnvironment {
                enabled: true,
                window_open: true,
                sleeping: true,
                online: true,
            }),
            Err(SkipReason::Sleeping)
        );
        assert_eq!(
            evaluate_gate(&SyncEnvironment {
                enabled: true,
                window_open: true,
                sleeping: false,
                online: false,
            }),
            Err(SkipReason::Offline)
        );

        // 跳过原因有稳定 token（journal 分类靠它）。
        for (reason, token) in [
            (SkipReason::Disabled, "disabled"),
            (SkipReason::NotConfigured, "not_configured"),
            (SkipReason::WindowClosed, "window_closed"),
            (SkipReason::Sleeping, "sleeping"),
            (SkipReason::Offline, "offline"),
            (SkipReason::NoArtifact, "no_artifact"),
            (SkipReason::Unchanged, "unchanged"),
        ] {
            assert_eq!(reason.as_str(), token);
            assert!(!reason.message().is_empty());
        }
    }

    #[test]
    fn schedule_intervals_are_three_tiers() {
        assert_eq!(SCHEDULE_INTERVAL_MINUTES, [15, 30, 60]);
        assert_eq!(normalize_interval(15), 15);
        assert_eq!(normalize_interval(30), 30);
        assert_eq!(normalize_interval(60), 60);
        // 越界档位回落到默认档（调度器不因非法档位空转）。
        assert_eq!(normalize_interval(7), SCHEDULE_DEFAULT_INTERVAL_MINUTES);
        assert_eq!(normalize_interval(0), SCHEDULE_DEFAULT_INTERVAL_MINUTES);

        // 端点 → 探针地址解析。
        assert_eq!(
            endpoint_host_port("https://dav.example.com/x"),
            Some(("dav.example.com".to_string(), 443))
        );
        assert_eq!(
            endpoint_host_port("http://127.0.0.1:8792"),
            Some(("127.0.0.1".to_string(), 8792))
        );
        assert_eq!(endpoint_host_port("ftp://nope"), None);
        assert_eq!(endpoint_host_port(""), None);

        // 本地目标不依赖网络 → 恒可达（不把「断网」误判成本地同步失败）。
        assert!(network_reachable("local"));
        assert!(network_reachable(""));
    }

    #[test]
    fn latest_auto_artifact_picks_newest_zip() {
        let project = TempTree::new("artifact");
        assert_eq!(latest_auto_artifact(&project.root), None);

        project.write("backups/auto/20260912-080000.zip", b"old");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let newest = project.write("backups/auto/20260912-090000.zip", b"new");
        project.write("backups/auto/notes.txt", b"ignored");

        assert_eq!(latest_auto_artifact(&project.root), Some(newest));
    }

    #[tokio::test]
    async fn run_cycle_honours_the_global_switch_and_journals_the_skip() {
        let project = TempTree::new("cycle-disabled");
        let paired = TempTree::new("cycle-disabled-paired");
        // 开关关闭：调度器与一切自动触发全停 → 不推送、不拉取，只记 skip。
        save_config_file(&project.root, &local_config(&paired.root, false)).expect("save");
        project.write("backups/auto/20260912-100000.zip", b"artifact");

        let result = run_cycle(&project.root, "device-a", "20260912100000")
            .await
            .expect("cycle");
        assert!(!result.ran);
        assert_eq!(result.skip_reason.as_deref(), Some("disabled"));
        assert!(
            !paired.root.join("20260912-100000").exists(),
            "disabled switch must not write to the target"
        );
        let journal =
            fs::read_to_string(project.root.join(".novel/sync-journal.jsonl")).expect("journal");
        assert!(journal.contains("\"direction\":\"skip\""));
        assert!(journal.contains("scheduler:disabled"));
        assert!(journal.contains("global sync switch is off"));
    }

    #[tokio::test]
    async fn run_cycle_pushes_then_pulls_a_paired_local_folder() {
        let project = TempTree::new("cycle-local");
        let paired = TempTree::new("cycle-local-paired");
        save_config_file(&project.root, &local_config(&paired.root, true)).expect("save");
        project.write("backups/auto/20260912-110000.zip", b"local-cycle-payload");

        let result = run_cycle(&project.root, "device-a", "20260912110000")
            .await
            .expect("cycle");
        assert!(result.ran, "enabled local target must run: {result:?}");
        assert_eq!(result.manifest_id, "20260912-110000");
        assert_eq!(result.revision, 1);
        assert_eq!(result.decision, "apply");

        // 目标目录里真的有内容（文件拷贝，不是 HTTP 镜像）。
        assert!(paired.root.join("20260912-110000").is_dir());
        // 快照入库（拉取不做工作树替换）。
        assert!(project.root.join(".novel/snapshots").is_dir());
        assert!(!project.root.join("QM").exists());

        // 推送 + 拉取各一条 journal（复用既有编排）。
        let journal =
            fs::read_to_string(project.root.join(".novel/sync-journal.jsonl")).expect("journal");
        assert!(journal.contains("\"direction\":\"push\""));
        assert!(journal.contains("\"direction\":\"pull\""));

        // 没有导出产物 → skip:no_artifact（不凭空造产物）。
        let empty = TempTree::new("cycle-no-artifact");
        save_config_file(&empty.root, &local_config(&paired.root, true)).expect("save");
        let skipped = run_cycle(&empty.root, "device-a", "20260912120000")
            .await
            .expect("cycle");
        assert!(!skipped.ran);
        assert_eq!(skipped.skip_reason.as_deref(), Some("no_artifact"));
    }

    #[tokio::test]
    async fn run_cycle_reports_unconfigured_target() {
        let project = TempTree::new("cycle-unconfigured");
        let result = run_cycle(&project.root, "device-a", "20260912130000")
            .await
            .expect("cycle");
        assert!(!result.ran);
        assert_eq!(result.skip_reason.as_deref(), Some("not_configured"));
    }

    #[tokio::test]
    async fn sync_now_shares_the_same_cycle_and_records_the_outcome() {
        let project = TempTree::new("now");
        let paired = TempTree::new("now-paired");
        save_config_file(&project.root, &local_config(&paired.root, true)).expect("save");
        project.write("backups/auto/20260912-140000.zip", b"manual-payload");

        // 直接走 `run_cycle`（`sync_now` 的命令壳只额外写状态字段）。
        let result = run_cycle(&project.root, "device-a", "20260912140000")
            .await
            .expect("cycle");
        assert_eq!(outcome_label(&result), "apply:1");

        let state = SyncSchedulerState::default();
        {
            let mut inner = state.lock();
            inner.last_outcome = Some(outcome_label(&result));
            inner.last_run_at = Some(now_rfc3339());
        }
        let status = status_of(&state.lock(), true);
        assert_eq!(status.last_outcome.as_deref(), Some("apply:1"));
        assert!(status.last_run_at.is_some());
        assert!(!status.running);
        // 未运行时不下发「下次时间」（避免 UI 显示一个不会发生的时刻）。
        assert!(status.next_run_at.is_none());
    }
    #[tokio::test]
    async fn run_cycle_is_idempotent_when_the_artifact_content_is_unchanged() {
        // F-010：同一产物连跑两轮不得产生第二个版本 / 第二份快照，只记 skip:unchanged。
        let project = TempTree::new("cycle-idempotent");
        let paired = TempTree::new("cycle-idempotent-paired");
        save_config_file(&project.root, &local_config(&paired.root, true)).expect("save");
        project.write("backups/auto/20260912-150000.zip", b"stable-payload");

        let first = run_cycle(&project.root, "device-a", "20260912150000")
            .await
            .expect("first cycle");
        assert!(first.ran);
        assert_eq!(first.revision, 1);

        let second = run_cycle(&project.root, "device-a", "20260912151500")
            .await
            .expect("second cycle");
        assert!(
            !second.ran,
            "unchanged content must not run a transfer: {second:?}"
        );
        assert_eq!(second.skip_reason.as_deref(), Some("unchanged"));
        assert_eq!(second.decision, "unchanged");
        assert_eq!(second.revision, 1, "no new revision for identical content");

        // 只有一份远端版本、一份本地快照；journal 里多了一条 skip:unchanged。
        assert!(paired.root.join("20260912-150000/rev-1").is_dir());
        assert!(
            !paired.root.join("20260912-150000/rev-2").exists(),
            "unchanged content must not create rev-2"
        );
        let snapshots: Vec<String> = fs::read_dir(project.root.join(".novel/snapshots"))
            .expect("snapshots dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            snapshots.len(),
            1,
            "exactly one snapshot expected: {snapshots:?}"
        );
        let journal =
            fs::read_to_string(project.root.join(".novel/sync-journal.jsonl")).expect("journal");
        assert!(journal.contains("scheduler:unchanged"));
    }
}
