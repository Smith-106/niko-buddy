// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! F-004 云端备份（WebDAV 传输目标适配器 + 推送 / 拉取 / 冲突保留）。
//!
//! ## 定位（为什么不是第二个传输引擎）
//! 本能力是既有备份链的**传输目标适配器**，不是新能力（data-architect 结论）：
//! 推送对象只能是既有导出产物，拉取结果是**快照入库**，绝不做工作文件树替换。
//! 既有那条持续性文件监听通道是另一条语义（它把传输状态渗进运行时真源），
//! 本模块**刻意不与其共享任何抽象**：合并二者会污染 `.novel/status.json`（违反 C-001）。
//! 模块内因此不出现该通道的任何标识符（见 `does_not_merge_live_sync_engine` 自检）。
//!
//! ## 真值边界（INV-3）
//! - **远端任一副本皆非真值**：远端只是传输镜像；版本水位留在本地过程库。
//! - 远端对象键不得镜像本地真值面（[`assert_remote_key_allowed`]）。
//! - 本地落点一律经 TASK-002 的写入权威判定，且**只接受 `Allow`**
//!   （[`assert_local_target_allowed`]）——严于矩阵：`QM/`、`canon` 在矩阵里只是
//!   `RequireGate`，但一份远端副本连「过门」的资格都没有。
//! - 拉取是**显式确认**的恢复动作，且表现为**快照入库**（`.novel/snapshots/`）。
//!
//! ## 冲突语义
//! `conflict` 是**终止态而非失败**：远端较旧时拒绝覆盖本地新态（防旧快照回退），
//! 确有不一致（同版本号、异内容指纹）时保留 `.conflict-<device>-<timestamp>` 副本，
//! **MUST NOT 静默覆盖**。本地侧因「从不被覆盖」而天然保留 → 默认裁决即「保留两者」。
//!
//! ## 凭据
//! 配置只存 `credential_ref`（`nb:<domain>:<account>`），密钥本体惰性取自 OS keyring
//! （TASK-003）。凭据不可用时调用方 MUST 关闭该传输目标，**禁止**明文回退。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::canon::archive;
use crate::commands::secret_store::{is_available_sync, read_secret_sync};

/// 传输配置文件名（与项目内既有配置同族）。
pub const SYNC_CONFIG_FILE: &str = ".niko-buddy/sync-config.json";

/// 传输 journal（会话态、可清、**非第二真源**）。
pub const SYNC_JOURNAL_FILE: &str = ".novel/sync-journal.jsonl";

/// 冲突副本前缀：`.conflict-<device>-<timestamp>`。
pub const CONFLICT_PREFIX: &str = ".conflict-";

/// 远端块目录名（与归档布局一致：清单与内容分离）。
pub const REMOTE_BLOCKS_DIR: &str = "blocks";

/// 远端清单文件名。
pub const REMOTE_MANIFEST_FILE: &str = "manifest.json";

/// 版本目录前缀（远端以 `rev-<n>/` 承载单调版本）。
pub const REMOTE_REVISION_PREFIX: &str = "rev-";

// ── 传输目标抽象 ───────────────────────────────────────────────────────────

/// 传输目标（远端对象存储的最小面）。
///
/// 只保留三原语：列举、读取、写入。没有 delete —— 远端删除不在本能力语义内
/// （冲突副本与旧版本必须可追溯，「保留两者」是默认裁决）。
pub trait SyncTarget {
    /// 列举 `path` 前缀下的对象键（相对目标根，POSIX 分隔符）。
    async fn list(&self, path: &str) -> Result<Vec<String>, String>;
    /// 读取单个对象的字节。
    async fn get(&self, path: &str) -> Result<Vec<u8>, String>;
    /// 写入单个对象。
    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String>;
}

/// WebDAV 传输目标。
pub struct WebDavTarget {
    endpoint: String,
    root: String,
    credential_ref: String,
}

impl WebDavTarget {
    /// 由配置构造（不做 I/O；凭据惰性读取）。
    pub fn new(endpoint: &str, root: &str, credential_ref: &str) -> Self {
        WebDavTarget {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            root: root.trim_matches('/').to_string(),
            credential_ref: credential_ref.to_string(),
        }
    }

    /// 换算远端对象 URL。
    fn url_for(&self, path: &str) -> String {
        let suffix = path.trim_start_matches('/');
        if self.root.is_empty() {
            format!("{}/{}", self.endpoint, suffix)
        } else {
            format!("{}/{}/{}", self.endpoint, self.root, suffix)
        }
    }

    /// 惰性取凭据（不可用即失败，**不降级为匿名**）。
    fn authorization(&self) -> Result<String, String> {
        let raw = read_secret_sync("", &self.credential_ref)?;
        encode_authorization(&raw)
    }

    fn client() -> Result<tauri_plugin_http::reqwest::Client, String> {
        tauri_plugin_http::reqwest::Client::builder()
            .build()
            .map_err(|e| format!("[sync_target] build http client failed: {e}"))
    }
}

/// 凭据编码：`<user>:<password>` → Basic；已含空格的 `<Scheme> <value>` 原样传递。
///
/// 无冒号且无 Scheme 的值**报错**而非静默透传：凭据通道的配置错误必须暴露，
/// 不能把一个格式非法的字符串当 Authorization 头发出去。
pub fn encode_authorization(raw: &str) -> Result<String, String> {
    if let Some((user, password)) = raw.split_once(':') {
        let token = base64_encode(format!("{user}:{password}").as_bytes());
        return Ok(format!("Basic {token}"));
    }
    match raw.split_once(' ') {
        Some((scheme, value))
            if scheme.eq_ignore_ascii_case("basic") || scheme.eq_ignore_ascii_case("bearer") =>
        {
            if value.trim().is_empty() {
                return Err(
                    "[sync_target] credential has an empty token after the scheme".to_string(),
                );
            }
            Ok(raw.to_string())
        }
        _ => Err(
            "[sync_target] credential must be '<user>:<password>' or an already-encoded '<Scheme> <value>' Authorization header"
                .to_string(),
        ),
    }
}

/// 最小 base64 编码（只为 Authorization 头；不引入额外依赖）。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 从 WebDAV multistatus 响应中抽取 `<href>` 值。
///
/// 刻意不引入 XML 解析依赖：只需对象键清单，而标签名大小写与命名空间前缀均不可靠，
/// 故按标签名做大小写无关扫描。
pub fn extract_hrefs(xml: &str) -> Vec<String> {
    let lowered = xml.to_ascii_lowercase();
    let mut found: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_rel) = lowered[cursor..].find('<') {
        let open = cursor + open_rel;
        let Some(close_rel) = lowered[open..].find('>') else {
            break;
        };
        let close = open + close_rel;
        let tag = &lowered[open + 1..close];
        if !tag.starts_with("d:href") && !tag.starts_with("href") {
            cursor = close + 1;
            continue;
        }
        let Some(end_rel) = lowered[close + 1..].find("</") else {
            break;
        };
        let end = close + 1 + end_rel;
        let value = xml[close + 1..end].trim().to_string();
        if !value.is_empty() {
            found.push(value);
        }
        cursor = end;
    }
    found
}

impl SyncTarget for WebDavTarget {
    async fn list(&self, path: &str) -> Result<Vec<String>, String> {
        let method = tauri_plugin_http::reqwest::Method::from_bytes(b"PROPFIND")
            .map_err(|e| format!("[sync_target] PROPFIND method failed: {e}"))?;
        let response = WebDavTarget::client()?
            .request(method, self.url_for(path))
            .header("Authorization", self.authorization()?)
            .header("Depth", "1")
            .send()
            .await
            .map_err(|e| format!("[sync_target] PROPFIND {} failed: {e}", self.url_for(path)))?;
        let status = response.status();
        if !status.is_success() && status.as_u16() != 207 {
            return Err(format!("[sync_target] PROPFIND returned {status}"));
        }
        let body = response
            .text()
            .await
            .map_err(|e| format!("[sync_target] read PROPFIND body failed: {e}"))?;
        Ok(extract_hrefs(&body))
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        let response = WebDavTarget::client()?
            .get(self.url_for(path))
            .header("Authorization", self.authorization()?)
            .send()
            .await
            .map_err(|e| format!("[sync_target] GET {} failed: {e}", self.url_for(path)))?;
        if !response.status().is_success() {
            return Err(format!(
                "[sync_target] GET {} returned {}",
                self.url_for(path),
                response.status()
            ));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|e| format!("[sync_target] read GET body failed: {e}"))
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        assert_remote_key_allowed(path)?;
        let response = WebDavTarget::client()?
            .put(self.url_for(path))
            .header("Authorization", self.authorization()?)
            .header("Content-Type", "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| format!("[sync_target] PUT {} failed: {e}", self.url_for(path)))?;
        if !response.status().is_success() {
            return Err(format!(
                "[sync_target] PUT {} returned {}",
                self.url_for(path),
                response.status()
            ));
        }
        Ok(())
    }
}

// ── 配置 / 守卫 / 版本裁决 / journal / 远端布局 / 结果 DTO ────────────────────

// M3-3：决策纯支撑层已剥离至 `sync_target_decision.rs`——增量剥离先例模式：新文件 + 原文件 re-export，外部 import 面零变化。
// 留守原文件：6 个 Tauri 命令（sync_configure/sync_test/sync_status/sync_push/sync_pull/sync_conflicts）、
// `status_impl` / `push_impl` / `pull_impl` / `conflicts_impl` 等 IO 执行层与 `WebDavTarget` 传输实现。
pub use super::sync_target_decision::{
    append_journal, assert_local_target_allowed, assert_no_secret_plaintext,
    assert_remote_key_allowed, decide_pull, local_revision, local_state, parse_remote_revision,
    read_journal, remote_revision_dir, validate_config, PullDecision, RevisionState, SyncConfig,
    SyncConflict, SyncJournalEntry, SyncPullResult, SyncPushResult, SyncStatus, SyncTestResult,
};

// M3-3 注：`conflict_file_name` / `journal_line` 留守本文件（未随块迁移）：
// 其唯一非单测调用者（`decide_pull` / `append_journal`）已迁入 `sync_target_decision`；
// 若随块迁移，本文件的 `pub use` 回引将无引用并触发 `-D warnings` 下 unused_imports 硬门。
// 两函数仍被新文件经 `super::sync_target::…` 回引，调用路径不变。

/// 冲突副本文件名：`.conflict-<device>-<timestamp>`。
pub fn conflict_file_name(device_id: &str, timestamp: &str) -> Result<String, String> {
    let device: String = device_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if device.is_empty() {
        return Err("[sync_target] device id must yield a non-empty safe token".to_string());
    }
    let ts: String = timestamp
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '-')
        .collect();
    if !ts.chars().any(|c| c.is_ascii_digit()) {
        return Err("[sync_target] timestamp must contain digits".to_string());
    }
    Ok(format!("{CONFLICT_PREFIX}{device}-{ts}"))
}

/// 序列化为单行 JSONL。
pub fn journal_line(entry: &SyncJournalEntry) -> Result<String, String> {
    serde_json::to_string(entry).map_err(|e| format!("[sync_target] journal encode failed: {e}"))
}

// ── 配置读写 ───────────────────────────────────────────────────────────────

/// 读取配置（缺失返回 None；存在但非法则报错，不静默降级）。
pub fn load_config(project_path: &Path) -> Result<Option<SyncConfig>, String> {
    let path = project_path.join(SYNC_CONFIG_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("[sync_target] read config failed: {e}"))?;
    assert_no_secret_plaintext(&raw)?;
    let config: SyncConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("[sync_target] parse config failed: {e}"))?;
    validate_config(&config)?;
    Ok(Some(config))
}

/// 写入配置（先经无明文断言与结构校验）。
pub fn save_config(project_path: &Path, config: &SyncConfig) -> Result<(), String> {
    validate_config(config)?;
    let encoded = serde_json::to_string_pretty(config)
        .map_err(|e| format!("[sync_target] encode config failed: {e}"))?;
    assert_no_secret_plaintext(&encoded)?;
    let path = project_path.join(SYNC_CONFIG_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[sync_target] create config dir failed: {e}"))?;
    }
    fs::write(&path, encoded).map_err(|e| format!("[sync_target] write config failed: {e}"))
}

// ── Tauri commands：配置 / 测试 / 状态 ─────────────────────────────────────

/// 保存云端备份配置。
#[tauri::command]
pub async fn sync_configure(project_path: String, config: SyncConfig) -> Result<(), String> {
    save_config(Path::new(&project_path), &config)
}

/// 连接测试。凭据不可用时**不降级**：直接回报不可用并要求关闭该目标。
#[tauri::command]
pub async fn sync_test(project_path: String) -> Result<SyncTestResult, String> {
    let project = Path::new(&project_path);
    let Some(config) = load_config(project)? else {
        return Ok(SyncTestResult {
            ok: false,
            endpoint: String::new(),
            root: String::new(),
            credential_available: false,
            reachable: false,
            object_count: 0,
            message: "[sync_target] cloud backup is not configured".to_string(),
        });
    };
    let credential_available = is_available_sync();
    let target = WebDavTarget::new(&config.endpoint, &config.root, &config.credential_ref);
    let (reachable, object_count, message) = if !credential_available {
        (
            false,
            0usize,
            "[sync_target] credential store unavailable; keep this cloud backup target disabled"
                .to_string(),
        )
    } else {
        match target.list("").await {
            Ok(objects) => (true, objects.len(), "[sync_target] reachable".to_string()),
            Err(reason) => (false, 0usize, reason),
        }
    };
    Ok(SyncTestResult {
        ok: reachable && credential_available,
        endpoint: config.endpoint,
        root: config.root,
        credential_available,
        reachable,
        object_count,
        message,
    })
}

/// 传输状态（不触网）。
#[tauri::command]
pub async fn sync_status(project_path: String) -> Result<SyncStatus, String> {
    status_impl(Path::new(&project_path))
}

/// [`sync_status`] 的同步实现（供命令与测试共用）。
pub fn status_impl(project_path: &Path) -> Result<SyncStatus, String> {
    let config = load_config(project_path)?;
    let journal = read_journal(project_path);
    let last = journal.last();
    Ok(SyncStatus {
        configured: config.is_some(),
        enabled: config.as_ref().map(|c| c.enabled).unwrap_or(false),
        endpoint: config
            .as_ref()
            .map(|c| c.endpoint.clone())
            .unwrap_or_default(),
        root: config.as_ref().map(|c| c.root.clone()).unwrap_or_default(),
        credential_ref: config
            .as_ref()
            .map(|c| c.credential_ref.clone())
            .unwrap_or_default(),
        credential_available: is_available_sync(),
        journal_entries: journal.len(),
        last_direction: last.map(|entry| entry.direction.clone()),
        last_manifest_id: last.map(|entry| entry.manifest_id.clone()),
        last_revision: last.map(|entry| entry.revision),
    })
}

// ── 推送 ───────────────────────────────────────────────────────────────────

/// 推送：以**既有导出产物**为唯一同步对象，经块寻址分块。
///
/// `artifact_path` 显式传入而非猜测目录：既保证「唯一同步对象」可审计，
/// 也避免把「导出目录约定」这种易漂移的假设写进传输层。
///
/// 远端布局 `manifest` 与 `blocks` 分离、块以内容哈希命名；**manifest 最后写**
/// （半途中断的远端版本不会被误认为完整）。
#[tauri::command]
pub async fn sync_push(
    project_path: String,
    artifact_path: String,
    device_id: String,
) -> Result<SyncPushResult, String> {
    let project = Path::new(&project_path);
    let config = open_target(project)?;
    let target = WebDavTarget::new(&config.endpoint, &config.root, &config.credential_ref);
    push_impl(
        &target,
        project,
        Path::new(&artifact_path),
        &device_id,
        &now_ts(),
    )
    .await
}

/// [`sync_push`] 的同步实现（目标可注入，便于测试）。
pub async fn push_impl<T: SyncTarget>(
    target: &T,
    project_path: &Path,
    artifact_path: &Path,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPushResult, String> {
    if !artifact_path.is_file() {
        return Err(format!(
            "[sync_target] export artifact not found: {} (run an export first)",
            artifact_path.display()
        ));
    }
    let manifest_id = artifact_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| "[sync_target] artifact has no usable file stem".to_string())?;
    let file_name = artifact_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "[sync_target] artifact has no file name".to_string())?;

    let staging = project_path.join(format!(".sync-staging-{}", sanitize_token(timestamp)));
    let _ = fs::remove_dir_all(&staging);
    let outcome = push_staged(
        target,
        project_path,
        &staging,
        artifact_path,
        &file_name,
        &manifest_id,
        device_id,
        timestamp,
    )
    .await;
    let _ = fs::remove_dir_all(&staging);
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn push_staged<T: SyncTarget>(
    target: &T,
    project_path: &Path,
    staging: &Path,
    artifact_path: &Path,
    file_name: &str,
    manifest_id: &str,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPushResult, String> {
    fs::create_dir_all(staging).map_err(|e| format!("[sync_target] create staging failed: {e}"))?;
    fs::copy(artifact_path, staging.join(file_name))
        .map_err(|e| format!("[sync_target] stage artifact failed: {e}"))?;

    let manifest = archive::build_manifest(staging)?;
    archive::pack_blocks(staging, &manifest, staging)?;

    let revision = local_revision(project_path, manifest_id) + 1;
    let prefix = remote_revision_dir(manifest_id, revision);

    let mut total_bytes = 0u64;
    for block in &manifest.blocks {
        let key = format!("{prefix}/{REMOTE_BLOCKS_DIR}/{}", block.hash);
        assert_remote_key_allowed(&key)?;
        let bytes = fs::read(staging.join(REMOTE_BLOCKS_DIR).join(&block.hash))
            .map_err(|e| format!("[sync_target] read staged block failed: {e}"))?;
        total_bytes += bytes.len() as u64;
        target.put(&key, &bytes).await?;
    }
    // 清单最后写（提交点）。
    let manifest_key = format!("{prefix}/{REMOTE_MANIFEST_FILE}");
    assert_remote_key_allowed(&manifest_key)?;
    let encoded = fs::read(staging.join(REMOTE_MANIFEST_FILE))
        .map_err(|e| format!("[sync_target] read staged manifest failed: {e}"))?;
    target.put(&manifest_key, &encoded).await?;

    append_journal(
        project_path,
        &SyncJournalEntry {
            manifest_id: manifest_id.to_string(),
            revision,
            device_id: device_id.to_string(),
            direction: "push".to_string(),
            ts: timestamp.to_string(),
            content_hash: manifest.content_digest.clone(),
        },
    )?;

    Ok(SyncPushResult {
        manifest_id: manifest_id.to_string(),
        revision,
        content_hash: manifest.content_digest.clone(),
        block_count: manifest.blocks.len(),
        total_bytes,
        remote_prefix: prefix,
    })
}

// ── 拉取 ───────────────────────────────────────────────────────────────────

/// 拉取：显式确认的恢复动作，表现为**快照入库**（`.novel/snapshots/`），
/// 绝不替换工作文件树；远端更旧时拒绝覆盖本地新态。
#[tauri::command]
pub async fn sync_pull(
    project_path: String,
    manifest_id: String,
    device_id: String,
) -> Result<SyncPullResult, String> {
    let project = Path::new(&project_path);
    let config = open_target(project)?;
    let target = WebDavTarget::new(&config.endpoint, &config.root, &config.credential_ref);
    pull_impl(&target, project, &manifest_id, &device_id, &now_ts()).await
}

/// [`sync_pull`] 的同步实现（目标可注入）。
pub async fn pull_impl<T: SyncTarget>(
    target: &T,
    project_path: &Path,
    manifest_id: &str,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPullResult, String> {
    let keys = target.list(manifest_id).await?;
    let remote_revision = keys
        .iter()
        .filter_map(|key| parse_remote_revision(key))
        .max()
        .ok_or_else(|| {
            format!("[sync_target] no remote revision found for manifest {manifest_id}")
        })?;
    let prefix = remote_revision_dir(manifest_id, remote_revision);

    let manifest_bytes = target
        .get(&format!("{prefix}/{REMOTE_MANIFEST_FILE}"))
        .await?;
    let manifest: archive::ArchiveManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("[sync_target] remote manifest parse failed: {e}"))?;
    archive::validate_manifest(&manifest)?;

    // 远端任一副本皆非真值 → 逐块校验后才落地。
    let remote_staging = project_path.join(format!(".sync-pull-{}", sanitize_token(timestamp)));
    let _ = fs::remove_dir_all(&remote_staging);
    let result = pull_verified(
        target,
        project_path,
        &remote_staging,
        manifest_id,
        remote_revision,
        &prefix,
        &manifest,
        &manifest_bytes,
        device_id,
        timestamp,
    )
    .await;
    let _ = fs::remove_dir_all(&remote_staging);
    result
}

#[allow(clippy::too_many_arguments)]
async fn pull_verified<T: SyncTarget>(
    target: &T,
    project_path: &Path,
    remote_staging: &Path,
    manifest_id: &str,
    remote_revision: u64,
    prefix: &str,
    manifest: &archive::ArchiveManifest,
    manifest_bytes: &[u8],
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPullResult, String> {
    fs::create_dir_all(remote_staging.join(REMOTE_BLOCKS_DIR))
        .map_err(|e| format!("[sync_target] create pull staging failed: {e}"))?;
    for block in &manifest.blocks {
        let key = format!("{prefix}/{REMOTE_BLOCKS_DIR}/{}", block.hash);
        let bytes = target.get(&key).await?;
        if archive::block_hash(&bytes) != block.hash {
            return Err(format!(
                "[sync_target] remote block {} failed hash verification",
                block.hash
            ));
        }
        fs::write(
            remote_staging.join(REMOTE_BLOCKS_DIR).join(&block.hash),
            &bytes,
        )
        .map_err(|e| format!("[sync_target] write pull staging failed: {e}"))?;
    }

    let local = local_state(project_path, manifest_id);
    let remote = RevisionState {
        revision: remote_revision,
        content_hash: manifest.content_digest.clone(),
    };
    match decide_pull(&local, &remote, device_id, timestamp)? {
        PullDecision::RefuseStale { local, remote } => {
            append_journal(
                project_path,
                &SyncJournalEntry {
                    manifest_id: manifest_id.to_string(),
                    revision: remote,
                    device_id: device_id.to_string(),
                    direction: "conflict".to_string(),
                    ts: timestamp.to_string(),
                    content_hash: manifest.content_digest.clone(),
                },
            )?;
            Ok(SyncPullResult {
                manifest_id: manifest_id.to_string(),
                remote_revision,
                decision: "refuse_stale".to_string(),
                snapshot_dir: None,
                conflict_path: None,
                message: format!(
                    "[sync_target] remote revision {remote} is older than local {local}; local newer state preserved"
                ),
            })
        }
        PullDecision::KeepBoth { conflict_name } => {
            // 冲突是终止态：远端副本原样保留；本地侧因从不被覆盖而天然保留 → 保留两者。
            let conflict_dir = project_path.join(".novel").join(&conflict_name);
            assert_local_target_allowed(&conflict_dir.join(REMOTE_MANIFEST_FILE))?;
            fs::create_dir_all(&conflict_dir)
                .map_err(|e| format!("[sync_target] create conflict dir failed: {e}"))?;
            copy_dir(remote_staging, &conflict_dir)?;
            fs::write(conflict_dir.join(REMOTE_MANIFEST_FILE), manifest_bytes)
                .map_err(|e| format!("[sync_target] write conflict manifest failed: {e}"))?;
            append_journal(
                project_path,
                &SyncJournalEntry {
                    manifest_id: manifest_id.to_string(),
                    revision: remote_revision,
                    device_id: device_id.to_string(),
                    direction: "conflict".to_string(),
                    ts: timestamp.to_string(),
                    content_hash: manifest.content_digest.clone(),
                },
            )?;
            Ok(SyncPullResult {
                manifest_id: manifest_id.to_string(),
                remote_revision,
                decision: "keep_both".to_string(),
                snapshot_dir: None,
                conflict_path: Some(conflict_dir.to_string_lossy().replace('\\', "/")),
                message:
                    "[sync_target] diverged content at the same revision; both copies preserved"
                        .to_string(),
            })
        }
        PullDecision::Apply => {
            let snapshot_dir = project_path
                .join(".novel/snapshots")
                .join(format!("remote-{manifest_id}-rev-{remote_revision}"));
            assert_local_target_allowed(&snapshot_dir.join(REMOTE_MANIFEST_FILE))?;
            fs::create_dir_all(&snapshot_dir)
                .map_err(|e| format!("[sync_target] create snapshot dir failed: {e}"))?;
            copy_dir(remote_staging, &snapshot_dir)?;
            fs::write(snapshot_dir.join(REMOTE_MANIFEST_FILE), manifest_bytes)
                .map_err(|e| format!("[sync_target] write snapshot manifest failed: {e}"))?;
            append_journal(
                project_path,
                &SyncJournalEntry {
                    manifest_id: manifest_id.to_string(),
                    revision: remote_revision,
                    device_id: device_id.to_string(),
                    direction: "pull".to_string(),
                    ts: timestamp.to_string(),
                    content_hash: manifest.content_digest.clone(),
                },
            )?;
            Ok(SyncPullResult {
                manifest_id: manifest_id.to_string(),
                remote_revision,
                decision: "apply".to_string(),
                snapshot_dir: Some(snapshot_dir.to_string_lossy().replace('\\', "/")),
                conflict_path: None,
                message: "[sync_target] restored as a snapshot (no working tree replacement)"
                    .to_string(),
            })
        }
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(from).follow_links(false) {
        let entry = entry.map_err(|e| format!("[sync_target] walk failed: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(from)
            .map_err(|e| format!("[sync_target] strip_prefix failed: {e}"))?;
        let destination = to.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[sync_target] create {} failed: {e}", parent.display()))?;
        }
        fs::copy(entry.path(), &destination)
            .map_err(|e| format!("[sync_target] copy {} failed: {e}", destination.display()))?;
    }
    Ok(())
}

// ── 冲突裁决 ───────────────────────────────────────────────────────────────

/// 列出本地冲突副本（默认裁决恒为「保留两者」）。
#[tauri::command]
pub async fn sync_conflicts(project_path: String) -> Result<Vec<SyncConflict>, String> {
    conflicts_impl(Path::new(&project_path))
}

/// [`sync_conflicts`] 的同步实现。
pub fn conflicts_impl(project_path: &Path) -> Result<Vec<SyncConflict>, String> {
    let mut found: Vec<SyncConflict> = Vec::new();
    let Ok(entries) = fs::read_dir(project_path.join(".novel")) else {
        return Ok(found);
    };
    let mut names: BTreeMap<String, PathBuf> = BTreeMap::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(CONFLICT_PREFIX) {
            names.insert(name, entry.path());
        }
    }
    for (name, path) in names {
        let size = walkdir::WalkDir::new(&path)
            .follow_links(false)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter_map(|entry| fs::metadata(entry.path()).ok())
            .map(|meta| meta.len())
            .sum();
        found.push(SyncConflict {
            name,
            path: path.to_string_lossy().replace('\\', "/"),
            size,
            default_resolution: "keep_both".to_string(),
        });
    }
    Ok(found)
}

/// 打开已启用的传输目标配置（缺失/未启用即报错，不静默降级）。
fn open_target(project_path: &Path) -> Result<SyncConfig, String> {
    let config = load_config(project_path)?
        .ok_or_else(|| "[sync_target] cloud backup is not configured".to_string())?;
    if !config.enabled {
        return Err("[sync_target] cloud backup target is disabled".to_string());
    }
    Ok(config)
}

fn sanitize_token(value: &str) -> String {
    let token: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if token.is_empty() {
        "0".to_string()
    } else {
        token
    }
}

fn now_ts() -> String {
    chrono::Utc::now().format("%Y%m%d%H%M%S").to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存传输目标（测试专用；不触网）。
    struct MemoryTarget {
        objects: std::sync::Mutex<BTreeMap<String, Vec<u8>>>,
    }

    impl MemoryTarget {
        fn new() -> Self {
            MemoryTarget {
                objects: std::sync::Mutex::new(BTreeMap::new()),
            }
        }
        fn keys(&self) -> Vec<String> {
            self.objects.lock().unwrap().keys().cloned().collect()
        }
    }

    impl SyncTarget for MemoryTarget {
        async fn list(&self, path: &str) -> Result<Vec<String>, String> {
            let guard = self.objects.lock().unwrap();
            Ok(guard
                .keys()
                .filter(|key| path.is_empty() || key.starts_with(path))
                .cloned()
                .collect())
        }
        async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
            let guard = self.objects.lock().unwrap();
            guard
                .get(path)
                .cloned()
                .ok_or_else(|| format!("[test] missing object {path}"))
        }
        async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
            assert_remote_key_allowed(path)?;
            self.objects
                .lock()
                .unwrap()
                .insert(path.to_string(), bytes.to_vec());
            Ok(())
        }
    }

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "nbsync-{tag}-{}-{}",
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

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build runtime")
    }

    /// 在 `target` 上手工造一个 `rev-<n>` 远端版本（内容 `payload`）。
    async fn seed_remote<T: SyncTarget>(
        target: &T,
        manifest_id: &str,
        revision: u64,
        payload: &[u8],
        scratch: &TempTree,
    ) -> archive::ArchiveManifest {
        let staging = scratch.root.join(format!("remote-{revision}"));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).expect("staging");
        fs::write(staging.join("payload.bin"), payload).expect("payload");
        let manifest = archive::build_manifest(&staging).expect("manifest");
        archive::pack_blocks(&staging, &manifest, &staging).expect("pack");
        let prefix = remote_revision_dir(manifest_id, revision);
        for block in &manifest.blocks {
            let bytes = fs::read(staging.join(REMOTE_BLOCKS_DIR).join(&block.hash)).expect("block");
            target
                .put(
                    &format!("{prefix}/{REMOTE_BLOCKS_DIR}/{}", block.hash),
                    &bytes,
                )
                .await
                .expect("put block");
        }
        target
            .put(
                &format!("{prefix}/{REMOTE_MANIFEST_FILE}"),
                &serde_json::to_vec(&manifest).expect("encode"),
            )
            .await
            .expect("put manifest");
        let _ = fs::remove_dir_all(&staging);
        manifest
    }

    fn journal_entry(
        manifest_id: &str,
        revision: u64,
        direction: &str,
        hash: &str,
    ) -> SyncJournalEntry {
        SyncJournalEntry {
            manifest_id: manifest_id.to_string(),
            revision,
            device_id: "device-a".to_string(),
            direction: direction.to_string(),
            ts: "20260912120000".to_string(),
            content_hash: hash.to_string(),
        }
    }

    #[test]
    fn config_has_no_secret_plaintext() {
        let config = SyncConfig {
            endpoint: "https://dav.example.com".to_string(),
            root: "niko-buddy/backups".to_string(),
            credential_ref: "nb:webdav:proj-42".to_string(),
            enabled: true,
        };
        validate_config(&config).expect("config validates");
        let encoded = serde_json::to_string_pretty(&config).expect("encode");
        assert_no_secret_plaintext(&encoded).expect("no plaintext key material");

        // 字段集恰好是白名单四个。
        let parsed: serde_json::Value = serde_json::from_str(&encoded).expect("parse");
        let mut keys: Vec<&str> = parsed
            .as_object()
            .expect("object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["credential_ref", "enabled", "endpoint", "root"]);

        // 存盘往返后仍是四个键。
        let project = TempTree::new("config");
        save_config(&project.root, &config).expect("save");
        let raw = fs::read_to_string(project.root.join(SYNC_CONFIG_FILE)).expect("read");
        assert_no_secret_plaintext(&raw).expect("persisted config is clean");
        assert_eq!(
            load_config(&project.root).expect("load"),
            Some(config.clone())
        );

        // 试图写入口令 → 结构层拒绝（deny_unknown_fields + 键白名单双重拦截）。
        let with_password = r#"{"endpoint":"https://dav.example.com","root":"r","credential_ref":"nb:webdav:p","enabled":true,"password":"hunter2"}"#;
        assert!(serde_json::from_str::<SyncConfig>(with_password).is_err());
        assert!(assert_no_secret_plaintext(with_password).is_err());

        // 凭据引用里塞口令同样被拒；非法端点/根路径亦然。
        let leaked = SyncConfig {
            credential_ref: "nb:webdav:token-abc".to_string(),
            ..config.clone()
        };
        assert!(validate_config(&leaked).is_err());
        assert!(validate_config(&SyncConfig {
            endpoint: "ftp://nope".to_string(),
            ..config.clone()
        })
        .is_err());
        assert!(validate_config(&SyncConfig {
            root: "../escape".to_string(),
            ..config
        })
        .is_err());
    }

    #[test]
    fn does_not_merge_live_sync_engine() {
        // 硬否决判据：本文件不得出现既有持续性文件监听通道的标识符。
        // 字面量在运行时拼接，避免断言本身污染判据。
        let forbidden = ["file", "sync"].join("_");
        let source = include_str!("sync_target.rs");
        assert!(
            !source.contains(&forbidden),
            "sync_target must not reference the live file-watch engine (hard veto)"
        );

        // 独立性功能证据：本模块的状态出口不写运行时真源，也不需要那条通道存在。
        let project = TempTree::new("independence");
        let status = status_impl(&project.root).expect("status works standalone");
        assert!(!status.configured);
        assert!(!project.root.join(".novel/status.json").exists());
        assert!(
            !project.root.join(SYNC_CONFIG_FILE).exists(),
            "status must not create config as a side effect"
        );
    }

    #[test]
    fn older_remote_does_not_overwrite() {
        let local = RevisionState {
            revision: 5,
            content_hash: "a".repeat(64),
        };
        let remote = RevisionState {
            revision: 4,
            content_hash: "b".repeat(64),
        };
        assert_eq!(
            decide_pull(&local, &remote, "device-a", "20260912120000").expect("decide"),
            PullDecision::RefuseStale {
                local: 5,
                remote: 4
            }
        );

        // 同版本同内容 → 幂等入库；远端更新 → 入库新快照。
        assert_eq!(
            decide_pull(&local, &local.clone(), "device-a", "20260912120000").expect("decide"),
            PullDecision::Apply
        );
        let newer = RevisionState {
            revision: 6,
            content_hash: "c".repeat(64),
        };
        assert_eq!(
            decide_pull(&local, &newer, "device-a", "20260912120000").expect("decide"),
            PullDecision::Apply
        );

        runtime().block_on(async {
            let project = TempTree::new("stale");
            let scratch = TempTree::new("stale-scratch");
            let target = MemoryTarget::new();
            seed_remote(&target, "demo", 2, b"remote-old", &scratch).await;
            // 本地已推进到 rev-3 → 远端 rev-2 更旧。
            append_journal(
                &project.root,
                &journal_entry("demo", 3, "push", &"d".repeat(64)),
            )
            .expect("journal");

            let result = pull_impl(&target, &project.root, "demo", "device-b", "20260912130000")
                .await
                .expect("pull");
            assert_eq!(result.decision, "refuse_stale");
            assert!(result.snapshot_dir.is_none());
            assert!(result.conflict_path.is_none());
            assert!(
                !project.root.join(".novel/snapshots").exists(),
                "stale remote must not produce a snapshot"
            );
            assert!(!project.root.join(".novel").join(CONFLICT_PREFIX).exists());
        });
    }

    #[test]
    fn conflict_preserves_copy() {
        // 命名契约。
        assert_eq!(
            conflict_file_name("device-a", "20260912130000").expect("name"),
            ".conflict-device-a-20260912130000"
        );
        // 不安全字符被剥离（避免把路径片段带进文件名）。
        assert_eq!(
            conflict_file_name("dev/../x", "2026-09-12").expect("name"),
            ".conflict-devx-2026-09-12"
        );
        assert!(conflict_file_name("", "2026").is_err());
        assert!(conflict_file_name("dev", "no-digits").is_err());

        runtime().block_on(async {
            let project = TempTree::new("conflict");
            let scratch = TempTree::new("conflict-scratch");
            let target = MemoryTarget::new();
            let manifest = seed_remote(&target, "demo", 7, b"remote-diverged", &scratch).await;

            // 本地 rev-7 但指纹不同 → 真分歧（同版本异内容）。
            append_journal(
                &project.root,
                &journal_entry("demo", 7, "push", &"f".repeat(64)),
            )
            .expect("journal");

            let result = pull_impl(&target, &project.root, "demo", "device-b", "20260912130000")
                .await
                .expect("pull");
            assert_eq!(result.decision, "keep_both");
            assert!(result.snapshot_dir.is_none());
            let conflict_path = result.conflict_path.expect("conflict path");
            assert!(conflict_path.ends_with(".conflict-device-b-20260912130000"));

            // 冲突副本落盘：manifest 与块都在，且与远端内容一致。
            let conflict_dir = Path::new(&conflict_path);
            assert!(conflict_dir.join(REMOTE_MANIFEST_FILE).is_file());
            let recovered: archive::ArchiveManifest = serde_json::from_slice(
                &fs::read(conflict_dir.join(REMOTE_MANIFEST_FILE)).expect("read manifest"),
            )
            .expect("parse manifest");
            assert_eq!(recovered.content_digest, manifest.content_digest);
            for block in &recovered.blocks {
                let bytes = fs::read(conflict_dir.join(REMOTE_BLOCKS_DIR).join(&block.hash))
                    .expect("read block");
                assert_eq!(archive::block_hash(&bytes), block.hash);
            }
            // 同版本异内容 → 冲突从未被误判为「本地更新」而被丢弃。
            assert_eq!(
                local_state(&project.root, "demo").content_hash,
                "f".repeat(64),
                "local state must remain the local truth, never the remote copy"
            );

            // 冲突是终止态：journal 记 conflict，且不污染真源。
            let journal = read_journal(&project.root);
            assert_eq!(
                journal.last().map(|entry| entry.direction.as_str()),
                Some("conflict")
            );
            assert!(!project.root.join(".novel/status.json").exists());

            // 裁决出口：默认「保留两者」。
            let conflicts = conflicts_impl(&project.root).expect("conflicts");
            assert_eq!(conflicts.len(), 1);
            assert_eq!(conflicts[0].default_resolution, "keep_both");
            assert!(conflicts[0].size > 0);
            assert_eq!(conflicts[0].name, ".conflict-device-b-20260912130000");
        });
    }

    #[test]
    fn pull_cannot_write_qm() {
        // 本地真值面一律拒绝（远端副本永非真值；严于矩阵的 RequireGate）。
        for target in [
            "QM/book-analysis/x.md",
            "canon/ch-01.md",
            ".novel/status.json",
            ".novel/schema.md",
        ] {
            assert!(
                assert_local_target_allowed(Path::new(target)).is_err(),
                "target must be refused: {target}"
            );
        }
        // 快照入库与草稿域是允许的落点。
        assert_local_target_allowed(Path::new(
            ".novel/snapshots/remote-demo-rev-3/manifest.json",
        ))
        .expect("snapshot target allowed");
        assert_local_target_allowed(Path::new(".novel/.conflict-d-rev/manifest.json"))
            .expect("conflict target allowed");

        // 远端键不得镜像本地真值面。
        assert!(assert_remote_key_allowed("demo/rev-1/QM/x").is_err());
        assert!(assert_remote_key_allowed("demo/rev-1/canon/x").is_err());
        assert!(assert_remote_key_allowed("demo/rev-1/status.json").is_err());
        assert!(assert_remote_key_allowed("../escape").is_err());
        assert!(assert_remote_key_allowed("/abs").is_err());
        assert!(assert_remote_key_allowed("demo/rev-1/blocks/abc").is_ok());

        runtime().block_on(async {
            // 推送：块寻址、manifest 最后写、journal 记方向、版本单调。
            let project = TempTree::new("push");
            let artifact =
                project.write("backups/auto/20260912-artifact.zip", b"artifact-bytes-v1");
            let target = MemoryTarget::new();
            let pushed = push_impl(
                &target,
                &project.root,
                &artifact,
                "device-a",
                "20260912140000",
            )
            .await
            .expect("push");
            assert_eq!(pushed.manifest_id, "20260912-artifact");
            assert_eq!(pushed.revision, 1);
            assert!(pushed.block_count >= 1);
            let keys = target.keys();
            assert!(
                keys.iter().any(|key| key.ends_with("manifest.json")),
                "remote manifest must exist: {keys:?}"
            );
            assert!(
                keys.iter().any(|key| key.contains("/blocks/")),
                "remote blocks must be content-addressed: {keys:?}"
            );

            let again = push_impl(
                &target,
                &project.root,
                &artifact,
                "device-a",
                "20260912140100",
            )
            .await
            .expect("push again");
            assert_eq!(again.revision, 2, "revision must be monotonic");
            assert!(read_journal(&project.root)
                .iter()
                .all(|entry| entry.direction == "push"));

            // 拉取最新（远端更新）→ 快照入库，工作树与真源不动。
            let pulled = pull_impl(
                &target,
                &project.root,
                &pushed.manifest_id,
                "device-b",
                "20260912150000",
            )
            .await
            .expect("pull");
            assert_eq!(pulled.decision, "apply");
            let snapshot_dir = PathBuf::from(pulled.snapshot_dir.expect("snapshot dir"));
            assert!(snapshot_dir.join(REMOTE_BLOCKS_DIR).is_dir());
            assert!(snapshot_dir.join(REMOTE_MANIFEST_FILE).is_file());
            assert!(
                !project.root.join("QM").exists(),
                "pull must never create truth surfaces"
            );
            assert!(!project.root.join("canon").exists());

            // 推送目录只做临时 staging，跑完即回收。
            let leftovers: Vec<String> = fs::read_dir(&project.root)
                .expect("read root")
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name.starts_with(".sync-"))
                .collect();
            assert!(
                leftovers.is_empty(),
                "staging must be reclaimed: {leftovers:?}"
            );
        });
    }

    #[test]
    fn authorization_and_href_parsing() {
        // 凭据编码：user:password → Basic；已编码的 Scheme 值原样传递；其余报错。
        assert_eq!(
            encode_authorization("user:pass").expect("basic"),
            "Basic dXNlcjpwYXNz"
        );
        assert_eq!(encode_authorization("Basic abc").expect("raw"), "Basic abc");
        assert_eq!(
            encode_authorization("Bearer tok").expect("raw"),
            "Bearer tok"
        );
        // 无冒号、无 Scheme → 报错（不静默把非法值当 Authorization 头发出去）。
        assert!(encode_authorization("a").is_err());
        assert!(encode_authorization("Basic ").is_err());
        assert!(encode_authorization("").is_err());
        // 单冒号切分（口令自身含冒号时保留）。
        assert_eq!(
            encode_authorization("u:p:q").expect("basic"),
            format!("Basic {}", base64_encode(b"u:p:q"))
        );

        // PROPFIND 响应解析（大小写与命名空间前缀无关）。
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/demo/rev-1/manifest.json</D:href></D:response>
  <D:response><D:href>/dav/demo/rev-1/blocks/abc</D:href></D:response>
</D:multistatus>"#;
        let hrefs = extract_hrefs(xml);
        assert_eq!(hrefs.len(), 2);
        assert!(hrefs[0].ends_with("manifest.json"));
        assert_eq!(parse_remote_revision(&hrefs[0]), Some(1));
        assert_eq!(parse_remote_revision("no-revision-here"), None);
    }
}

/// A-F-004 真机冒烟（**默认忽略**）：真实 HTTP WebDAV 靶端上的 推送 / 拉取 / 冲突保留。
///
/// ```text
/// cd Niko Buddy
/// node scripts/smoke-webdav-server.mjs 8792 .smoke-webdav smoke-webdav.jsonl smoke-user:smoke-pass &
/// cd src-tauri
/// cargo test --lib sync_target::webdav_smoke -- --ignored --nocapture
/// ```
///
/// 与同文件 `tests` 模块的区别：那些用例用 `MemoryTarget` 验证**语义**；本模块用真实的
/// [`WebDavTarget`]（真 reqwest HTTP）打本机靶端，凭据写**真实 OS 凭据库**，因此验证的是
/// 「传输层真的在说 HTTP 且真的带上了授权头」。靶端把每个请求记进 JSONL，可事后核对。
#[cfg(test)]
mod webdav_smoke {
    use super::*;
    use crate::commands::secret_store;

    const ENDPOINT: &str = "http://127.0.0.1:8792";
    const ROOT: &str = "smoke-webdav";
    const DOMAIN: &str = "webdav";
    const ACCOUNT: &str = "smoke-af004";
    /// `<user>:<password>` 形态 → 传输层编码为 `Basic`（见 [`encode_authorization`]）。
    const SECRET: &str = "smoke-user:smoke-pass";
    const DEVICE_A: &str = "smoke-device-a";

    fn smoke_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".smoke-af004")
    }

    fn seed_project(root: &Path) {
        std::fs::create_dir_all(root.join(".novel")).expect("mkdir .novel");
        std::fs::write(root.join(".novel/status.json"), "{\"chapter\":1}\n").expect("status.json");
        std::fs::write(root.join("book.md"), "林舟推开门，屋里的灯还亮着。\n").expect("book.md");
    }

    fn conflict_dirs(root: &Path) -> Vec<String> {
        let novel = root.join(".novel");
        let Ok(entries) = std::fs::read_dir(&novel) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".conflict-"))
            .collect()
    }

    fn journal_entry(manifest_id: &str, revision: u64, hash: &str, ts: &str) -> SyncJournalEntry {
        SyncJournalEntry {
            manifest_id: manifest_id.to_string(),
            revision,
            device_id: "smoke-local".to_string(),
            direction: "push".to_string(),
            ts: ts.to_string(),
            content_hash: hash.to_string(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "真机冒烟：需要本机 WebDAV 靶端（scripts/smoke-webdav-server.mjs）与真实 OS 凭据库"]
    async fn real_webdav_push_pull_and_conflict_keep_both() {
        let root = smoke_root();
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mkdir smoke root");

        // [0] 凭据入真实 OS 凭据库：只持有 ref，不持有明文。
        let credential_ref = secret_store::secret_put(DOMAIN.into(), ACCOUNT.into(), SECRET.into())
            .await
            .expect("写入真实凭据库");
        println!("[0] credential_ref={credential_ref}");
        assert!(
            credential_ref.starts_with("nb:"),
            "ref 形态应为 nb:<domain>:<account>，实际 {credential_ref}"
        );
        assert!(!credential_ref.contains("smoke-pass"), "ref 绝不能回带明文");

        let artifact = root.join("smoke-artifact-1.zip");
        let payload: String = (0..200)
            .map(|i| format!("第{i}行：林舟推开门，屋里的灯还亮着。\n"))
            .collect();
        std::fs::write(&artifact, &payload).expect("写导出产物");

        let project_a = root.join("proj-a");
        seed_project(&project_a);
        let target = WebDavTarget::new(ENDPOINT, ROOT, &credential_ref);

        // [1] 推送：真实 HTTP PUT（块 + manifest，manifest 最后写）。
        let pushed = push_impl(
            &target,
            &project_a,
            &artifact,
            DEVICE_A,
            "2026-09-12T10-00-00",
        )
        .await
        .expect("push 应成功");
        println!(
            "[1] push manifest={} rev={} blocks={} bytes={} prefix={}",
            pushed.manifest_id,
            pushed.revision,
            pushed.block_count,
            pushed.total_bytes,
            pushed.remote_prefix
        );
        assert_eq!(pushed.manifest_id, "smoke-artifact-1");
        assert_eq!(pushed.revision, 1);
        assert!(pushed.block_count >= 1);

        // [2] PROPFIND 真列远端：对象确实存在于真实服务上。
        let keys = target.list(&pushed.manifest_id).await.expect("list 远端");
        println!("[2] 远端对象 {} 个：{:?}", keys.len(), keys);
        assert!(keys.iter().any(|k| k.contains("manifest.json")));
        assert!(keys.iter().any(|k| k.contains("/blocks/")));
        // 同步对象白名单：真源面与 canon/status.json 绝不进入远端。
        for key in &keys {
            let lowered = key.to_lowercase();
            for forbidden in ["/qm/", "canon", "status.json", "/.novel/"] {
                assert!(
                    !lowered.contains(forbidden),
                    "远端出现了禁用键 {forbidden}：{key}"
                );
            }
        }

        // [3] 拉到全新项目 B：远端更新 → Apply，入库为快照（不做文件树替换）。
        let project_b = root.join("proj-b");
        seed_project(&project_b);
        let pulled = pull_impl(
            &target,
            &project_b,
            &pushed.manifest_id,
            "smoke-device-b",
            "2026-09-12T10-05-00",
        )
        .await
        .expect("pull 应成功");
        println!(
            "[3] pull decision={} rev={} snapshot={:?}",
            pulled.decision, pulled.remote_revision, pulled.snapshot_dir
        );
        assert_eq!(pulled.decision, "apply");
        let snapshot = PathBuf::from(pulled.snapshot_dir.as_deref().expect("快照目录"));
        assert!(snapshot.is_dir(), "快照目录应存在：{}", snapshot.display());
        assert!(
            conflict_dirs(&project_b).is_empty(),
            "幂等 apply 不该产生冲突副本"
        );

        // [4] 再次拉取：同版本同指纹 → 幂等 Apply。
        let again = pull_impl(
            &target,
            &project_b,
            &pushed.manifest_id,
            "smoke-device-b",
            "2026-09-12T10-06-00",
        )
        .await
        .expect("二次 pull 应成功");
        println!("[4] 二次 pull decision={}", again.decision);
        assert_eq!(again.decision, "apply");
        assert!(conflict_dirs(&project_b).is_empty());

        // [5] 同版本但本地内容不同 → KeepBoth：两边都留，绝不覆盖。
        let local = local_state(&project_b, &pushed.manifest_id);
        println!(
            "[5] 本地状态 rev={} hash={}",
            local.revision, local.content_hash
        );
        append_journal(
            &project_b,
            &journal_entry(
                &pushed.manifest_id,
                local.revision,
                "divergent-local-hash",
                "2026-09-12T10-07-00",
            ),
        )
        .expect("写入分叉 journal");
        let conflicted = pull_impl(
            &target,
            &project_b,
            &pushed.manifest_id,
            "smoke-device-b",
            "2026-09-12T10-08-00",
        )
        .await
        .expect("分歧 pull 应返回 KeepBoth 而非失败");
        println!(
            "[5] 分歧 decision={} conflict_path={:?} msg={}",
            conflicted.decision, conflicted.conflict_path, conflicted.message
        );
        assert_eq!(conflicted.decision, "keep_both");
        let conflict_path =
            PathBuf::from(conflicted.conflict_path.as_deref().expect("冲突副本路径"));
        assert!(
            conflict_path.is_dir(),
            "冲突副本目录应存在：{}",
            conflict_path.display()
        );
        assert!(
            conflict_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".conflict-"),
            "冲突副本命名应带 .conflict- 前缀：{}",
            conflict_path.display()
        );

        // [6] 远端更旧 → RefuseStale：拒绝用旧快照回退本地新态。
        append_journal(
            &project_b,
            &journal_entry(
                &pushed.manifest_id,
                local.revision + 5,
                "ahead-local-hash",
                "2026-09-12T10-09-00",
            ),
        )
        .expect("写入领先 journal");
        let stale = pull_impl(
            &target,
            &project_b,
            &pushed.manifest_id,
            "smoke-device-b",
            "2026-09-12T10-10-00",
        )
        .await
        .expect("更旧远端应被拒绝而非报错");
        println!(
            "[6] 更旧远端 decision={} msg={}",
            stale.decision, stale.message
        );
        assert_eq!(stale.decision, "refuse_stale");

        // [7] 白名单是**传输前**的硬拦（不是事后过滤）。
        for forbidden in [
            "qm/notes.md",
            "canon/entities.json",
            "status.json",
            ".novel/x",
        ] {
            assert!(
                assert_remote_key_allowed(forbidden).is_err(),
                "禁用远端键必须被拒：{forbidden}"
            );
        }
        assert!(assert_remote_key_allowed("smoke-artifact-1/rev-1/manifest.json").is_ok());

        // [8] 收尾：凭据从真实 OS 凭据库删除（不留残留）。
        let removed = secret_store::secret_delete(DOMAIN.into(), ACCOUNT.into())
            .await
            .expect("删除凭据");
        assert!(removed, "凭据应被真实删除");
        let journal = read_journal(&project_b);
        println!(
            "[8] journal {} 条，方向={:?}",
            journal.len(),
            journal
                .iter()
                .map(|e| e.direction.clone())
                .collect::<Vec<_>>()
        );
        println!("[9] A-F-004 真机冒烟 PASS：真实 HTTP 推送/拉取/幂等/冲突保留/防回退/白名单");
    }
}
