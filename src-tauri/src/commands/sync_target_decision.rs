// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! sync-target 决策纯支撑层——M3-3 自 `sync_target.rs` 增量剥离（S4 单轮收敛：新文件 + 原文件 re-export，外部 import 面零变化）。
//!
//! 收容：传输配置 [`SyncConfig`] 及其校验 [`validate_config`] / 无明文断言
//! [`assert_no_secret_plaintext`]、远端键守卫 [`assert_remote_key_allowed`] / 本地落点守卫
//! [`assert_local_target_allowed`]、版本与冲突裁决（[`RevisionState`] / [`PullDecision`] /
//! [`conflict_file_name`] / [`decide_pull`]）、journal 编解码与本地水位
//! （[`SyncJournalEntry`] / [`journal_line`] / [`append_journal`] / [`read_journal`] /
//! [`local_state`] / [`local_revision`]）、远端布局（[`remote_revision_dir`] /
//! [`parse_remote_revision`]）与结果 DTO（[`SyncTestResult`] / [`SyncStatus`] /
//! [`SyncPushResult`] / [`SyncPullResult`] / [`SyncConflict`]）。
//! `sync_target.rs` 经 `pub use` 回引，外部 import 面零变化
//! （外部引用留守原文件：6 个 Tauri 命令、`status_impl` / `push_impl` / `pull_impl` /
//! `conflicts_impl` 等 IO 执行层与 `WebDavTarget` 传输实现）。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::canon::archive;
use crate::canon::write_authority::{may_write, WriteDecision, WriteSource};

use super::sync_target::{
    conflict_file_name, journal_line, REMOTE_REVISION_PREFIX, SYNC_ITEM_JOURNAL_FILE,
    SYNC_JOURNAL_FILE,
};

/// 远端对象键中**禁止**出现的路径段（远端不得镜像本地真值面）。
const FORBIDDEN_REMOTE_SEGMENTS: [&str; 4] = ["qm", "canon", "status.json", ".novel"];

// ── 配置 ───────────────────────────────────────────────────────────────────

/// 传输配置：**只有**四个字段，且不含任何密钥明文。
///
/// `deny_unknown_fields` 是结构层护栏：试图把口令塞进配置的包会被直接拒绝解析，
/// 而不是被静默忽略。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncConfig {
    /// WebDAV 端点（http/https）。
    pub endpoint: String,
    /// 目标根前缀（相对形态；不得含 `..`）。
    pub root: String,
    /// 凭据引用（`nb:<domain>:<account>`）；**不是**凭据本体。
    pub credential_ref: String,
    /// 是否启用。
    pub enabled: bool,
}

/// 配置校验（纯函数）。
pub fn validate_config(config: &SyncConfig) -> Result<(), String> {
    if !(config.endpoint.starts_with("https://") || config.endpoint.starts_with("http://")) {
        return Err("[sync_target] endpoint must be an http(s) URL".to_string());
    }
    if config.endpoint.contains(' ') {
        return Err("[sync_target] endpoint must not contain spaces".to_string());
    }
    if config.root.contains("..") || config.root.starts_with('/') {
        return Err("[sync_target] root must be a relative path without '..'".to_string());
    }
    if !config.credential_ref.starts_with("nb:") {
        return Err(
            "[sync_target] credential_ref must look like nb:<domain>:<account>".to_string(),
        );
    }
    // 拒绝把疑似明文口令写进凭据引用字段。
    for suspicious in ["password", "passwd", "token", "secret", "apikey", "api_key"] {
        if config
            .credential_ref
            .to_ascii_lowercase()
            .contains(suspicious)
        {
            return Err(format!(
                "[sync_target] credential_ref must be a reference, not key material (found '{suspicious}')"
            ));
        }
    }
    Ok(())
}

/// 配置 JSON 的无明文断言（供测试与启动自检复用）。
///
/// 除四个白名单键之外出现任何键即判失败；键名命中口令家族关键字亦判失败。
pub fn assert_no_secret_plaintext(raw_json: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(raw_json)
        .map_err(|e| format!("[sync_target] config is not valid JSON: {e}"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| "[sync_target] config must be a JSON object".to_string())?;
    let allowed = ["endpoint", "root", "credential_ref", "enabled"];
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "[sync_target] config key '{key}' is not allowed (only endpoint/root/credential_ref/enabled)"
            ));
        }
        let lowered = key.to_ascii_lowercase();
        for suspicious in ["password", "passwd", "token", "secret", "key"] {
            if lowered.contains(suspicious) {
                return Err(format!(
                    "[sync_target] config key '{key}' looks like key material storage"
                ));
            }
        }
    }
    Ok(())
}

// ── 远端键与本地落点守卫 ───────────────────────────────────────────────────

/// 远端对象键守卫：不得为绝对路径、不得含 `..`、不得镜像本地真值面。
pub fn assert_remote_key_allowed(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("[sync_target] remote key must not be empty".to_string());
    }
    if key.starts_with('/') || key.contains('\\') {
        return Err(format!(
            "[sync_target] remote key must be a relative POSIX path: {key}"
        ));
    }
    for segment in key.split('/') {
        if segment == ".." || segment.is_empty() {
            return Err(format!("[sync_target] malformed remote key: {key}"));
        }
        let lowered = segment.to_ascii_lowercase();
        if FORBIDDEN_REMOTE_SEGMENTS.contains(&lowered.as_str()) {
            return Err(format!(
                "[sync_target] remote key must never mirror a local truth surface: {key}"
            ));
        }
    }
    Ok(())
}

/// 本地落点守卫：经 TASK-002 的写入权威判定（`SyncPull` 来源），**只接受 `Allow`**。
///
/// 严于矩阵：矩阵给 `QM/`、`canon` 的是 `RequireGate`，但远端副本永非真值，
/// 连过门的资格都没有 → 一并拒绝。
pub fn assert_local_target_allowed(target: &Path) -> Result<(), String> {
    match may_write(WriteSource::SyncPull, target) {
        WriteDecision::Allow => Ok(()),
        other => Err(format!(
            "[sync_target] write_authority={} for {} (a remote copy is never truth)",
            other.as_str(),
            target.display()
        )),
    }
}

// ── 版本与冲突 ─────────────────────────────────────────────────────────────

/// 单调版本 + 内容指纹（判新旧只认这两项；时间戳仅作显示）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionState {
    pub revision: u64,
    pub content_hash: String,
}

/// 拉取裁决。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullDecision {
    /// 远端为同一状态（幂等）或更新 → 入库为新快照。
    Apply,
    /// 远端更旧 → 拒绝覆盖本地新态（**防旧快照回退**）。
    RefuseStale { local: u64, remote: u64 },
    /// 同版本号但内容不一致 → 保留冲突副本（终止态，不是失败）。
    KeepBoth { conflict_name: String },
}

/// 拉取裁决（纯函数）。
///
/// - 远端更旧 → `RefuseStale`（**绝不静默覆盖**本地新态）。
/// - 同版本号且指纹相同 → `Apply`（幂等无操作）。
/// - 同版本号但指纹不同 → `KeepBoth`（真分歧，保留双方）。
/// - 远端更新 → `Apply`（仍以快照入库，不做文件树替换）。
///
/// `KeepBoth` 的逐项展开见 [`decide_pull_items`]（G2b）：只有该终止态需要「逐项选哪侧」。
pub fn decide_pull(
    local: &RevisionState,
    remote: &RevisionState,
    device_id: &str,
    timestamp: &str,
) -> Result<PullDecision, String> {
    if remote.revision < local.revision {
        return Ok(PullDecision::RefuseStale {
            local: local.revision,
            remote: remote.revision,
        });
    }
    if remote.revision == local.revision && remote.content_hash != local.content_hash {
        return Ok(PullDecision::KeepBoth {
            conflict_name: conflict_file_name(device_id, timestamp)?,
        });
    }
    Ok(PullDecision::Apply)
}

/// [`decide_pull`] 的 `KeepBoth` 终止态**逐项展开**（G2b）。
///
/// 只有 `KeepBoth` 需要逐项裁决：`Apply` 是幂等入库、`RefuseStale` 是拒绝覆盖，
/// 两者都没有「选哪一侧」的问题 → 一律返回空清单（不做多余计算，也不给 UI 递假选项）。
pub fn decide_pull_items(
    decision: &PullDecision,
    has_base: bool,
    base_dir: Option<&Path>,
    mine_dir: Option<&Path>,
    theirs_dir: Option<&Path>,
) -> Result<Vec<SyncDiffItem>, String> {
    if !matches!(decision, PullDecision::KeepBoth { .. }) {
        return Ok(Vec::new());
    }
    diff_trees(has_base, base_dir, mine_dir, theirs_dir)
}

// ── journal ────────────────────────────────────────────────────────────────

/// journal 条目：`(manifest_id, revision, device_id, direction, ts)` + 内容指纹。
///
/// `content_hash` 是本实现对卡片元组的**扩展**：没有它就无从判定「同版本异内容」
/// 这一真分歧分支，冲突裁决只能靠猜。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncJournalEntry {
    pub manifest_id: String,
    pub revision: u64,
    pub device_id: String,
    /// `push` | `pull` | `conflict` | `refused`。
    ///
    /// `conflict` = 同版本异内容的 KeepBoth 终止态；`refused` = 远端更旧、本地新态被保留
    /// （RefuseStale，**不是** keep_both：从未做过三路展开，也不存在冲突副本目录）。
    pub direction: String,
    pub ts: String,
    #[serde(default)]
    pub content_hash: String,
    /// G2b 基线指针：本批次所基于的版本号。
    ///
    /// **老 manifest 缺此字段 → `None` = 无 base**：既不迁移也不重写历史批次，
    /// 无 base 的批次在逐项裁决里只能「保留两者」（见 [`diff_item`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_rev: Option<u64>,
    /// G2b 基线指针：本批次所基于的内容指纹（与 `base_rev` 成对；缺一即视为无 base）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_content_hash: Option<String>,
}

fn journal_path(project_path: &Path) -> PathBuf {
    project_path.join(SYNC_JOURNAL_FILE)
}

/// 追加一条 journal 记录（逐行 JSONL；坏行在读取时被跳过，不阻塞主流程）。
pub fn append_journal(project_path: &Path, entry: &SyncJournalEntry) -> Result<(), String> {
    let path = journal_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[sync_target] create journal dir failed: {e}"))?;
    }
    let mut sink = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("[sync_target] open journal failed: {e}"))?;
    use std::io::Write;
    writeln!(sink, "{}", journal_line(entry)?)
        .map_err(|e| format!("[sync_target] append journal failed: {e}"))
}

/// 读取 journal（跳过无法解析的行）。
pub fn read_journal(project_path: &Path) -> Vec<SyncJournalEntry> {
    let Ok(raw) = fs::read_to_string(journal_path(project_path)) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<SyncJournalEntry>(line).ok())
        .collect()
}

/// 该方向的 journal 行是否携带「已应用的版本态」。
///
/// `conflict`（KeepBoth）与 `refused`（RefuseStale）都是**未应用**的终止态：
/// 它们记录的 revision / content_hash 是远端值，不是本地已达成的状态，
/// 因此绝不能进 `local_state` 水位，也不能当 `base_state_before` 的基线候选。
fn direction_carries_state(direction: &str) -> bool {
    direction != "conflict" && direction != "refused"
}

/// 本地已知状态：该 `manifest_id` 在 journal 中 revision 最大的那条记录。
pub fn local_state(project_path: &Path, manifest_id: &str) -> RevisionState {
    read_journal(project_path)
        .into_iter()
        .filter(|entry| {
            entry.manifest_id == manifest_id && direction_carries_state(&entry.direction)
        })
        .max_by_key(|entry| entry.revision)
        .map(|entry| RevisionState {
            revision: entry.revision,
            content_hash: entry.content_hash,
        })
        .unwrap_or(RevisionState {
            revision: 0,
            content_hash: String::new(),
        })
}

/// 本地单调版本（无记录为 0）。
pub fn local_revision(project_path: &Path, manifest_id: &str) -> u64 {
    local_state(project_path, manifest_id).revision
}

/// 指定版本**之前**的最近一次同步态（= 该版本所基于的 base）。
///
/// 单调版本语义下 rev N 的父态就是 rev N-1：`push` 把本地推到 N 时把
/// `base_rev` 记成 N-1，于是「同版本异内容」的真分歧可以按
/// mine / theirs / base 三路展开，而不是只能整体保留两者。
///
/// 无更早记录（首次传输）或指纹为空（传输健康行）→ `None`（= 无 base）。
pub fn base_state_before(
    project_path: &Path,
    manifest_id: &str,
    revision: u64,
) -> Option<RevisionState> {
    read_journal(project_path)
        .into_iter()
        .filter(|entry| {
            entry.manifest_id == manifest_id
                && direction_carries_state(&entry.direction)
                && entry.revision < revision
                && !entry.content_hash.is_empty()
        })
        .max_by_key(|entry| entry.revision)
        .map(|entry| RevisionState {
            revision: entry.revision,
            content_hash: entry.content_hash,
        })
}

// ── 远端布局 ───────────────────────────────────────────────────────────────

/// 远端版本目录：`<manifest_id>/rev-<n>`。
pub fn remote_revision_dir(manifest_id: &str, revision: u64) -> String {
    format!("{manifest_id}/{REMOTE_REVISION_PREFIX}{revision}")
}

/// 从远端对象键中解析 `rev-<n>`（无则 None）。
pub fn parse_remote_revision(key: &str) -> Option<u64> {
    key.split('/')
        .find_map(|segment| segment.strip_prefix(REMOTE_REVISION_PREFIX))
        .and_then(|digits| digits.parse::<u64>().ok())
}

// ── 结果类型 ───────────────────────────────────────────────────────────────

/// 连接测试结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncTestResult {
    pub ok: bool,
    pub endpoint: String,
    pub root: String,
    pub credential_available: bool,
    pub reachable: bool,
    pub object_count: usize,
    pub message: String,
}

/// 传输状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatus {
    pub configured: bool,
    pub enabled: bool,
    pub endpoint: String,
    pub root: String,
    pub credential_ref: String,
    pub credential_available: bool,
    pub journal_entries: usize,
    pub last_direction: Option<String>,
    pub last_manifest_id: Option<String>,
    pub last_revision: Option<u64>,
}

/// 推送结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncPushResult {
    pub manifest_id: String,
    pub revision: u64,
    pub content_hash: String,
    pub block_count: usize,
    pub total_bytes: u64,
    pub remote_prefix: String,
    /// 内容指纹与本地水位一致 → **未产生新版本**（没传任何块、没写 journal）。
    ///
    /// `revision` / `remote_prefix` 此时指向已存在的那个版本；`total_bytes = 0`。
    /// 老后端不返回该字段 → `#[serde(default)]` 视为 false（不会把“不知道”当成“没变”）。
    #[serde(default)]
    pub unchanged: bool,
}

/// 拉取结果。
///
/// `decision` 值域：
///   - `apply`：快照入库（首次拉取该版本）
///   - `unchanged`：远端版本与本地一致且该版本的快照已存在 → 不下载块、不重写快照
///   - `refuse_stale`：远端更旧，本地新态被保留（journal direction = `refused`）
///   - `keep_both`：同版本异内容，两份都保留（journal direction = `conflict`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncPullResult {
    pub manifest_id: String,
    pub remote_revision: u64,
    pub decision: String,
    pub snapshot_dir: Option<String>,
    pub conflict_path: Option<String>,
    pub message: String,
}

/// 冲突副本描述（默认裁决：保留两者）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConflict {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// 默认裁决恒为 `keep_both`（MUST NOT 静默覆盖）。
    pub default_resolution: String,
}

// ── 逐项裁决（G2b）：base 指针 / 三路 diff / 逐项 journal / 批次明细 ────────────
//
// 语义边界（改动前先读）：
//   - **默认裁决恒为 `keep_both`**：本节的任何解析失败、无 base、缺侧、路径不可信
//     都回落到「保留两者」，绝不因为代码路径而升级成覆盖。
//   - **逐项选择必须显式**：`PickMine` / `PickTheirs` 只能由 [`apply_item_decisions_impl`]
//     在带 `actor`（显式用户动作来源）的调用里落地；没有 actor 一律拒绝。
//   - **落盘不碰工作文件树**：裁决结果写到 `.novel/resolutions/<batch>/<path>`，
//     与 `.novel/.conflict-*` 同属过程面；远端副本永非真值（INV-3）。
//   - **单项失败不滚整体**：每项独立落盘 + 独立记账，失败项标 `error` 可重试。

/// 逐项裁决取值：采用本地侧。
pub const PICK_MINE: &str = "pick_mine";
/// 逐项裁决取值：采用远端侧。
pub const PICK_THEIRS: &str = "pick_theirs";
/// 逐项裁决取值：保留两者（**恒为兜底**）。
pub const PICK_KEEP_BOTH: &str = "keep_both";

/// 逐项状态码：已按裁决落盘。
pub const ITEM_STATUS_APPLIED: &str = "applied";
/// 逐项状态码：保留两者（无落盘动作）。
pub const ITEM_STATUS_KEEP_BOTH: &str = "keep_both";
/// 逐项状态码：被拒绝（远端更旧等终止态）。
pub const ITEM_STATUS_REFUSED: &str = "refused";
/// 逐项状态码：失败（可重试；不影响同批其他项）。
pub const ITEM_STATUS_ERROR: &str = "error";

/// 三路状态码：三侧一致。
pub const DIFF_UNCHANGED: &str = "unchanged";
/// 三路状态码：仅本地侧变化。
pub const DIFF_MINE_ONLY: &str = "mine_only";
/// 三路状态码：仅远端侧变化。
pub const DIFF_THEIRS_ONLY: &str = "theirs_only";
/// 三路状态码：两侧都变但内容一致（伪冲突）。
pub const DIFF_BOTH_SAME: &str = "both_same";
/// 三路状态码：**双改**（两侧都变且互不相同）→ 唯一可逐项选择的形态。
pub const DIFF_BOTH_CHANGED: &str = "both_changed";
/// 三路状态码：无 base 指针（或三侧不齐）→ 逐项只能保留两者。
pub const DIFF_NO_BASE: &str = "no_base";

/// 逐项裁决取值（强类型面；wire 仍用上面的稳定字面量）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickChoice {
    /// 采用本地侧。
    PickMine,
    /// 采用远端侧。
    PickTheirs,
    /// 保留两者（兜底）。
    KeepBoth,
}

impl PickChoice {
    /// 稳定字面量（journal 与 IPC 同值）。
    pub fn as_str(self) -> &'static str {
        match self {
            PickChoice::PickMine => PICK_MINE,
            PickChoice::PickTheirs => PICK_THEIRS,
            PickChoice::KeepBoth => PICK_KEEP_BOTH,
        }
    }

    /// 严格解析：只接受三个稳定字面量，其余一律报错（命令入口用）。
    pub fn parse_strict(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            PICK_MINE => Ok(PickChoice::PickMine),
            PICK_THEIRS => Ok(PickChoice::PickTheirs),
            PICK_KEEP_BOTH => Ok(PickChoice::KeepBoth),
            other => Err(format!(
                "[sync_target] unknown per-item decision '{other}' (expected pick_mine / pick_theirs / keep_both)"
            )),
        }
    }

    /// 宽松解析：未知值**回落 keep_both**（读历史 journal 用；fail-closed，绝不升级为覆盖）。
    pub fn parse_lenient(raw: &str) -> Self {
        Self::parse_strict(raw).unwrap_or(PickChoice::KeepBoth)
    }

    /// 无 base 时是否允许：只有 `keep_both` 允许（无 base 禁覆盖，缓解 R2）。
    pub fn allowed_without_base(self) -> bool {
        matches!(self, PickChoice::KeepBoth)
    }
}

/// 三路 diff 的单项（纯数据；不含内容本体，只含指纹与长度）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncDiffItem {
    /// 相对路径（POSIX 分隔符）。
    pub path: String,
    /// 见 `DIFF_*` 常量。
    pub status: String,
    /// 是否可逐项选择（仅「双改 + 三侧齐全」为 true）。
    pub pickable: bool,
    /// 是否存在可用的 base 内容（无 → 逐项只能保留两者）。
    pub base_available: bool,
    /// 允许的裁决值（无 base / 不可选 → 仅 `keep_both`）。
    pub choices: Vec<String>,
    /// 默认裁决：**恒为 keep_both**。
    pub default_decision: String,
    pub base_hash: Option<String>,
    pub mine_hash: Option<String>,
    pub theirs_hash: Option<String>,
    pub base_bytes: Option<u64>,
    pub mine_bytes: Option<u64>,
    pub theirs_bytes: Option<u64>,
}

/// 单文件三路分类（纯函数）。
///
/// `has_base` 是**可用性**判定（有 base 指针 **且** base 内容可取），不是「该文件在 base 里存在」：
/// 文件在 base 里不存在（新增）仍是合法三路形态，只要 base 树本身在。
pub fn diff_item(
    path: &str,
    has_base: bool,
    base: Option<&[u8]>,
    mine: Option<&[u8]>,
    theirs: Option<&[u8]>,
) -> SyncDiffItem {
    let base_hash = base.map(archive::block_hash);
    let mine_hash = mine.map(archive::block_hash);
    let theirs_hash = theirs.map(archive::block_hash);
    let mine_changed = mine_hash != base_hash;
    let theirs_changed = theirs_hash != base_hash;
    let (status, pickable) = if !has_base {
        (DIFF_NO_BASE, false)
    } else if !mine_changed && !theirs_changed {
        (DIFF_UNCHANGED, false)
    } else if mine_changed && !theirs_changed {
        (DIFF_MINE_ONLY, false)
    } else if !mine_changed && theirs_changed {
        (DIFF_THEIRS_ONLY, false)
    } else if mine_hash == theirs_hash {
        (DIFF_BOTH_SAME, false)
    } else {
        (DIFF_BOTH_CHANGED, true)
    };
    SyncDiffItem {
        path: path.to_string(),
        status: status.to_string(),
        pickable,
        base_available: has_base,
        choices: if pickable {
            vec![
                PICK_MINE.to_string(),
                PICK_THEIRS.to_string(),
                PICK_KEEP_BOTH.to_string(),
            ]
        } else {
            vec![PICK_KEEP_BOTH.to_string()]
        },
        default_decision: PICK_KEEP_BOTH.to_string(),
        base_hash,
        mine_hash,
        theirs_hash,
        base_bytes: base.map(|bytes| bytes.len() as u64),
        mine_bytes: mine.map(|bytes| bytes.len() as u64),
        theirs_bytes: theirs.map(|bytes| bytes.len() as u64),
    }
}

/// 枚举 `root` 下的相对文件路径（跳过隐藏组件，与归档枚举同口径）。
fn collect_relative_files(root: &Path, out: &mut BTreeSet<String>) -> Result<(), String> {
    if !root.is_dir() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry =
            entry.map_err(|e| format!("[sync_target] walk {} failed: {e}", root.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("[sync_target] strip_prefix failed: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        out.insert(relative);
    }
    Ok(())
}

fn read_optional(root: Option<&Path>, relative: &str) -> Option<Vec<u8>> {
    let root = root?;
    fs::read(root.join(relative)).ok()
}

/// 三路目录 diff（纯读；不写任何东西）。
///
/// - `has_base`：本批次是否有 base 指针（journal `base_rev` + `base_content_hash` 成对）。
/// - 任一侧目录缺失 → 该侧视为「不可知」：清单仍生成，但**一律不可逐项选择**
///   （缺侧时「变化」判定不可信，任何自动选择都可能变成隐式覆盖）。
pub fn diff_trees(
    has_base: bool,
    base_dir: Option<&Path>,
    mine_dir: Option<&Path>,
    theirs_dir: Option<&Path>,
) -> Result<Vec<SyncDiffItem>, String> {
    let base_root = if has_base {
        base_dir.filter(|path| path.is_dir())
    } else {
        None
    };
    let mine_root = mine_dir.filter(|path| path.is_dir());
    let theirs_root = theirs_dir.filter(|path| path.is_dir());
    if mine_root.is_none() && theirs_root.is_none() {
        return Ok(Vec::new());
    }
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for root in [base_root, mine_root, theirs_root].into_iter().flatten() {
        collect_relative_files(root, &mut paths)?;
    }
    let sides_known = mine_root.is_some() && theirs_root.is_some();
    let mut items: Vec<SyncDiffItem> = Vec::with_capacity(paths.len());
    for path in paths {
        let base = read_optional(base_root, &path);
        let mine = read_optional(mine_root, &path);
        let theirs = read_optional(theirs_root, &path);
        let mut item = diff_item(
            &path,
            base_root.is_some(),
            base.as_deref(),
            mine.as_deref(),
            theirs.as_deref(),
        );
        if !sides_known {
            if item.status == DIFF_BOTH_CHANGED {
                item.status = DIFF_NO_BASE.to_string();
            }
            item.pickable = false;
            item.choices = vec![PICK_KEEP_BOTH.to_string()];
        }
        items.push(item);
    }
    Ok(items)
}

// ── 逐项 journal（与传输 journal 分文件） ───────────────────────────────────

/// 逐项 journal 记录（JSONL）。
///
/// 为什么不写进 [`SYNC_JOURNAL_FILE`]：`local_state` / `local_revision` 以该文件的
/// **单调版本水位**为准，混入逐项行会污染水位（判新旧只能靠传输记录）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncItemRecord {
    /// 批次键：`<manifest_id>@<ts>@<direction>`（与传输 journal 行一一对应）。
    ///
    /// 方向入键是硬要求：同一 ts 下 push 与 pull 是两条不同批次（见 [`batch_id_of`]）。
    /// 历史记录可能仍是无方向旧键（`<manifest_id>@<ts>`），读取侧靠 `direction` 兜底匹配。
    pub batch_id: String,
    pub manifest_id: String,
    pub revision: u64,
    /// `push` | `pull` | `conflict`。
    pub direction: String,
    pub ts: String,
    pub device_id: String,
    /// 相对路径（POSIX；push 为产物文件名，pull 为 `manifest.json` / `blocks/<hash>`）。
    pub path: String,
    /// 见 `ITEM_STATUS_*` / `DIFF_*` 常量。
    pub status: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 逐项裁决（`pick_mine` / `pick_theirs` / `keep_both`；未裁决 → None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    /// 显式用户动作来源（无 actor 不允许 `pick_*`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// 裁决时间（RFC 3339 / ISO 8601）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
}

/// 批次键（传输 journal 行与逐项记录共用同一键）。
///
/// **方向必须入键**：`run_cycle` 在同一 timestamp 下先 push 后 pull，若键只由
/// `(manifest_id, ts)` 组成，push 与 pull 两行会撞成同一个键：
///   1. 前端按 `batch.batch_id` 做 key 会撞键（React 复用/错位节点）；
///   2. `items_from_records` 按 batch_id 过滤 → 两条批次各自显示 push+pull 并集项；
///   3. `apply_item_decisions_impl` 的 `.rev().find(...)` 永远命中后写的那条
///      （push 批次的 base 语义被静默替换）。
/// 所以键形为 `<manifest_id>@<ts>@<direction>`。
pub fn batch_id_of(manifest_id: &str, ts: &str, direction: &str) -> String {
    format!("{manifest_id}@{ts}@{direction}")
}

/// 旧版批次键（无方向后缀）：**只用于读历史 journal**，新写入一律用 [`batch_id_of`]。
///
/// 历史数据里 push / pull 两行本来就共用这个键，这个歧义无法事后拆开；
/// 保留它的唯一目的是让老逐项记录仍然能挂回自己的批次（不迁移、不重写历史）。
fn legacy_batch_id(manifest_id: &str, ts: &str) -> String {
    format!("{manifest_id}@{ts}")
}

/// 逐项记录是否属于某个（已带方向的）批次：兼容旧无方向键的历史记录。
///
/// 旧记录的键里没有方向，但它自己的 `direction` 字段有——所以老记录只在
/// 「方向也相同」时才算匹配，避免同 ts 的 push / pull 两条批次都抢同一批老记录。
fn record_belongs_to_batch(
    record: &SyncItemRecord,
    manifest_id: &str,
    ts: &str,
    direction: &str,
) -> bool {
    record.batch_id == batch_id_of(manifest_id, ts, direction)
        || (record.batch_id == legacy_batch_id(manifest_id, ts) && record.direction == direction)
}

fn item_journal_path(project_path: &Path) -> PathBuf {
    project_path.join(SYNC_ITEM_JOURNAL_FILE)
}

/// 追加一条逐项记录（坏行在读取时跳过，不阻塞主流程）。
pub fn append_item_journal(project_path: &Path, record: &SyncItemRecord) -> Result<(), String> {
    let path = item_journal_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[sync_target] create item journal dir failed: {e}"))?;
    }
    let line = serde_json::to_string(record)
        .map_err(|e| format!("[sync_target] item journal encode failed: {e}"))?;
    let mut sink = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("[sync_target] open item journal failed: {e}"))?;
    use std::io::Write;
    writeln!(sink, "{line}").map_err(|e| format!("[sync_target] append item journal failed: {e}"))
}

/// 读取逐项记录（跳过无法解析的行）。
pub fn read_item_journal(project_path: &Path) -> Vec<SyncItemRecord> {
    let Ok(raw) = fs::read_to_string(item_journal_path(project_path)) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<SyncItemRecord>(line).ok())
        .collect()
}

// ── 批次明细 DTO ────────────────────────────────────────────────────────────

/// 批次里的单项（文件 / 内容块）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncBatchItem {
    pub path: String,
    /// `push` | `pull` | `conflict` | `refused`（与所属批次方向一致）。
    pub direction: String,
    pub status: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    /// 是否可逐项三选一（无 base / 缺侧恒 false）。
    pub pickable: bool,
    pub base_available: bool,
    pub choices: Vec<String>,
    pub default_decision: String,
}

/// 批次明细：一条传输 journal 记录 + 其逐项记录 + （冲突批次的）三路 diff。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncBatch {
    pub batch_id: String,
    pub manifest_id: String,
    pub revision: u64,
    pub direction: String,
    pub device_id: String,
    pub ts: String,
    pub content_hash: String,
    /// G2b 基线指针（老批次 → None = 无 base，不迁移）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_rev: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_content_hash: Option<String>,
    /// base 指针是否成对存在。
    pub base_available: bool,
    /// `applied` | `keep_both` | `refused` | `resolved` | `partial`。
    pub status: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mine_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theirs_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_root: Option<String>,
    pub items: Vec<SyncBatchItem>,
}

/// 传输健康行的 `manifest_id`（不是批次，不进批次明细）。
const TRANSPORT_HEALTH_MANIFEST: &str = "transport-health";

/// 本地快照目录（`remote-<id>-rev-<n>`；不存在 → None）。
fn snapshot_dir(project_path: &Path, manifest_id: &str, revision: u64) -> Option<PathBuf> {
    let dir = project_path
        .join(".novel/snapshots")
        .join(format!("remote-{manifest_id}-rev-{revision}"));
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// 批次三侧根目录（**从 journal + 落盘布局推导**，不额外持久化）。
struct BatchRoots {
    mine: Option<PathBuf>,
    theirs: Option<PathBuf>,
    base: Option<PathBuf>,
}

fn batch_roots(project_path: &Path, entry: &SyncJournalEntry) -> BatchRoots {
    let mine = snapshot_dir(project_path, &entry.manifest_id, entry.revision);
    let base = entry
        .base_rev
        .and_then(|revision| snapshot_dir(project_path, &entry.manifest_id, revision));
    // 冲突批次的远端侧 = 冲突副本目录（命名由 (device, ts) 唯一确定）。
    // RefuseStale（`refused`）从不创建冲突副本 → theirs 恒为 None（不假装有三路明细）。
    let theirs = if entry.direction == "conflict" {
        conflict_file_name(&entry.device_id, &entry.ts)
            .ok()
            .map(|name| project_path.join(".novel").join(name))
            .filter(|path| path.is_dir())
    } else {
        None
    };
    BatchRoots { mine, theirs, base }
}

/// base 是否**真的**可用：指针成对 **且** base 快照目录存在。
///
/// 为什么不能只看指针：纯 push 工作流从不生成 base 快照；`.novel/snapshots/` 也可能
/// 被清理。展示侧（`diff_trees`）用 `base_dir.filter(is_dir)` 判定可用性，逐项裁决
/// 的写入门禁必须用**同一个判据**——否则会出现「UI 显示不可选，直接 IPC 却写得进去」
/// 的两套标准（R2 的「无 base 时 mine/theirs 真被拒」只在指针缺失时成立）。
fn base_available_for(project_path: &Path, entry: &SyncJournalEntry) -> bool {
    let Some(base_rev) = entry.base_rev else {
        return false;
    };
    if entry.base_content_hash.is_none() {
        return false;
    }
    snapshot_dir(project_path, &entry.manifest_id, base_rev).is_some()
}

fn display_relative(project_path: &Path, path: &Option<PathBuf>) -> Option<String> {
    let path = path.as_ref()?;
    let relative = path.strip_prefix(project_path).unwrap_or(path.as_path());
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn batch_status(entry: &SyncJournalEntry, items: &[SyncBatchItem]) -> String {
    if items.iter().any(|item| item.status == ITEM_STATUS_ERROR) {
        return "partial".to_string();
    }
    if items.iter().any(|item| {
        item.decision.as_deref() == Some(PICK_MINE) || item.decision.as_deref() == Some(PICK_THEIRS)
    }) {
        return "resolved".to_string();
    }
    // RefuseStale **必须先于** conflict 判：它写的是「远端更新被拒」，不是
    // 「用户选择保留两边」。旧实现把两者都写成 direction=conflict，于是 refused
    // 永远不可达（DTO 声明的 status 值域里的 refused 成了死值）。
    if entry.direction == "refused" {
        return ITEM_STATUS_REFUSED.to_string();
    }
    if entry.direction == "conflict" {
        return ITEM_STATUS_KEEP_BOTH.to_string();
    }
    if entry.direction == "push" || entry.direction == "pull" {
        return ITEM_STATUS_APPLIED.to_string();
    }
    entry.direction.clone()
}

/// 逐项记录 → 批次单项（同一路径取**最后一条**：后来的裁决覆盖先前的传输态）。
fn items_from_records(records: &[SyncItemRecord], base_available: bool) -> Vec<SyncBatchItem> {
    let mut latest: Vec<&SyncItemRecord> = Vec::new();
    for record in records {
        if let Some(existing) = latest.iter_mut().find(|item| item.path == record.path) {
            *existing = record;
        } else {
            latest.push(record);
        }
    }
    latest
        .into_iter()
        .map(|record| SyncBatchItem {
            path: record.path.clone(),
            direction: record.direction.clone(),
            status: record.status.clone(),
            duration_ms: record.duration_ms,
            error: record.error.clone(),
            // 历史 journal 里的未知取值一律归一到 keep_both（fail-closed，绝不升级为覆盖）。
            decision: record
                .decision
                .as_deref()
                .map(|raw| PickChoice::parse_lenient(raw).as_str().to_string()),
            actor: record.actor.clone(),
            decided_at: record.decided_at.clone(),
            pickable: false,
            base_available,
            choices: vec![PICK_KEEP_BOTH.to_string()],
            default_decision: PICK_KEEP_BOTH.to_string(),
        })
        .collect()
}

/// 把三路 diff 合进批次单项（同路径：diff 决定「是否可逐项选择」）。
fn merge_diff_items(items: &mut Vec<SyncBatchItem>, diff: Vec<SyncDiffItem>) {
    for entry in diff {
        if let Some(existing) = items.iter_mut().find(|item| item.path == entry.path) {
            existing.pickable = entry.pickable;
            existing.base_available = entry.base_available;
            existing.choices = entry.choices.clone();
            existing.default_decision = entry.default_decision.clone();
            if entry.pickable {
                existing.status = DIFF_BOTH_CHANGED.to_string();
            }
        } else {
            items.push(SyncBatchItem {
                path: entry.path,
                direction: "pull".to_string(),
                status: entry.status,
                duration_ms: 0,
                error: None,
                decision: None,
                actor: None,
                decided_at: None,
                pickable: entry.pickable,
                base_available: entry.base_available,
                choices: entry.choices,
                default_decision: entry.default_decision,
            });
        }
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
}

/// 批次明细（最近 `limit` 批，时间升序返回）。
pub fn batches_impl(project_path: &Path, limit: usize) -> Result<Vec<SyncBatch>, String> {
    let entries = read_journal(project_path);
    let records = read_item_journal(project_path);
    let mut batches: Vec<SyncBatch> = Vec::new();
    for entry in entries.iter().rev() {
        if batches.len() >= limit {
            break;
        }
        if entry.manifest_id == TRANSPORT_HEALTH_MANIFEST {
            continue;
        }
        let batch_id = batch_id_of(&entry.manifest_id, &entry.ts, &entry.direction);
        // 展示判据与写入门禁同源：指针成对 **且** base 快照目录存在。
        let base_available = base_available_for(project_path, entry);
        let batch_records: Vec<SyncItemRecord> = records
            .iter()
            .filter(|record| {
                record_belongs_to_batch(record, &entry.manifest_id, &entry.ts, &entry.direction)
            })
            .cloned()
            .collect();
        let mut items = items_from_records(&batch_records, base_available);
        let roots = batch_roots(project_path, entry);
        if entry.direction == "conflict" {
            // 只有真正的 KeepBoth 冲突批次才做三路展开。`refused` 从不创建
            // `.conflict-<device>-<ts>` 副本（theirs_root 恒为 None），展开出来的
            // 三路明细本身不成立 → 一律不展开。
            let decision = PullDecision::KeepBoth {
                conflict_name: conflict_file_name(&entry.device_id, &entry.ts).unwrap_or_default(),
            };
            let diff = decide_pull_items(
                &decision,
                base_available,
                roots.base.as_deref(),
                roots.mine.as_deref(),
                roots.theirs.as_deref(),
            )?;
            merge_diff_items(&mut items, diff);
        }
        let duration_ms = items.iter().map(|item| item.duration_ms).sum();
        batches.push(SyncBatch {
            batch_id,
            manifest_id: entry.manifest_id.clone(),
            revision: entry.revision,
            direction: entry.direction.clone(),
            device_id: entry.device_id.clone(),
            ts: entry.ts.clone(),
            content_hash: entry.content_hash.clone(),
            base_rev: entry.base_rev,
            base_content_hash: entry.base_content_hash.clone(),
            base_available,
            status: batch_status(entry, &items),
            duration_ms,
            error: items.iter().find_map(|item| item.error.clone()),
            mine_root: display_relative(project_path, &roots.mine),
            theirs_root: display_relative(project_path, &roots.theirs),
            base_root: display_relative(project_path, &roots.base),
            items,
        });
    }
    batches.reverse();
    Ok(batches)
}

// ── 逐项裁决落盘 ────────────────────────────────────────────────────────────

/// 逐项裁决请求（一次调用可带多项：单项失败不影响其他项）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncItemDecisionRequest {
    pub path: String,
    pub decision: String,
}

/// 逐项裁决结果（每项独立成功/失败，失败项可原样重试）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncItemDecisionResult {
    pub path: String,
    pub decision: String,
    /// `applied` | `keep_both` | `error`。
    pub status: String,
    /// 落盘位置（相对项目根；`keep_both` 无落盘动作 → None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 相对路径守卫：不得绝对、不得含 `..`、不得含反斜杠或空段（防路径穿越）。
pub fn assert_safe_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("[sync_target] item path must not be empty".to_string());
    }
    if path.starts_with('/') || path.contains('\\') || path.contains(':') {
        return Err(format!(
            "[sync_target] item path must be a relative POSIX path: {path}"
        ));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!("[sync_target] malformed item path: {path}"));
        }
    }
    Ok(())
}

/// 批次键 → 可安全落盘的目录名（只留 ASCII 字母数字与 `-` `_`）。
fn sanitize_batch_token(value: &str) -> String {
    let token: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if token.is_empty() {
        "batch".to_string()
    } else {
        token
    }
}

/// 逐项裁决落盘（**每项独立**）+ 回写逐项 journal（decision / actor / 时间 / 状态）。
///
/// 规则（不可放松）：
/// 1. `actor` 为空 → 整次调用拒绝（逐项选择必须是显式用户动作，禁止静默自动裁决）。
/// 2. 无 base → 只接受 `keep_both`；`pick_mine` / `pick_theirs` 记 `error`。
///    「无 base」的判据与展示侧同源：`base_rev` + `base_content_hash` 成对 **且**
///    `.novel/snapshots/remote-<id>-rev-<base>` 目录存在（`base_available_for`）。
///    只看指针不看目录时，纯 push 工作流（从不生成 base 快照）会出现「UI 不可选、
///    直接 IPC 却写得进去」的两套标准。
/// 3. 缺任一侧目录 → 同样只接受 `keep_both`（缺侧时无法判定「谁改了什么」）。
/// 4. 落盘目标恒为 `.novel/resolutions/<batch>/<path>`，并经写入权威判定
///    （`SyncPull` 来源只接受 `Allow`）；**永不覆盖工作文件树**。
/// 5. 任一项失败只标该项 `error`，其余项继续（不整体回滚）。
#[allow(clippy::too_many_arguments)]
pub fn apply_item_decisions_impl(
    project_path: &Path,
    manifest_id: &str,
    revision: u64,
    direction: &str,
    ts: &str,
    device_id: &str,
    actor: &str,
    requests: &[SyncItemDecisionRequest],
    decided_at: &str,
) -> Result<Vec<SyncItemDecisionResult>, String> {
    let actor = actor.trim();
    if actor.is_empty() {
        return Err(
            "[sync_target] per-item decision requires an explicit actor (no silent auto-pick)"
                .to_string(),
        );
    }
    if requests.is_empty() {
        return Err("[sync_target] no per-item decisions supplied".to_string());
    }
    let batch_id = batch_id_of(manifest_id, ts, direction);
    // 批次查找也必须带方向：同一 ts 下 push / pull 是两条不同批次，不能靠 `.rev()`
    // 取“最后一条”了事（旧实现会把 push 批次的 base 语义静默换成 pull 的）。
    let stored = read_journal(project_path).into_iter().rev().find(|entry| {
        entry.manifest_id == manifest_id && entry.ts == ts && entry.direction == direction
    });
    // 写入门禁与展示判据同源（指针成对 + base 快照目录存在）。
    let base_available = stored
        .as_ref()
        .map(|entry| base_available_for(project_path, entry))
        .unwrap_or(false);
    let mine_root = snapshot_dir(project_path, manifest_id, revision);
    let theirs_root = conflict_file_name(device_id, ts)
        .ok()
        .map(|name| project_path.join(".novel").join(name))
        .filter(|path| path.is_dir());

    let mut results: Vec<SyncItemDecisionResult> = Vec::with_capacity(requests.len());
    for request in requests {
        let started = std::time::Instant::now();
        let decision = PickChoice::parse_strict(&request.decision);
        let recorded_decision = match &decision {
            Ok(choice) => choice.as_str().to_string(),
            Err(_) => PICK_KEEP_BOTH.to_string(),
        };
        let outcome = apply_single_item(
            project_path,
            &batch_id,
            base_available,
            mine_root.as_deref(),
            theirs_root.as_deref(),
            request,
            decision,
        );
        let (status, output_path, error) = match outcome {
            Ok(landed) => landed,
            Err(message) => (ITEM_STATUS_ERROR.to_string(), None, Some(message)),
        };
        let record = SyncItemRecord {
            batch_id: batch_id.clone(),
            manifest_id: manifest_id.to_string(),
            revision,
            direction: direction.to_string(),
            ts: ts.to_string(),
            device_id: device_id.to_string(),
            path: request.path.clone(),
            status: status.clone(),
            duration_ms: started.elapsed().as_millis() as u64,
            error: error.clone(),
            decision: Some(recorded_decision.clone()),
            actor: Some(actor.to_string()),
            decided_at: Some(decided_at.to_string()),
        };
        append_item_journal(project_path, &record)?;
        results.push(SyncItemDecisionResult {
            path: request.path.clone(),
            decision: recorded_decision,
            status,
            output_path,
            error,
        });
    }
    Ok(results)
}

/// 单项落盘（内部；错误即该项失败，调用方负责记账与继续）。
fn apply_single_item(
    project_path: &Path,
    batch_id: &str,
    base_available: bool,
    mine_root: Option<&Path>,
    theirs_root: Option<&Path>,
    request: &SyncItemDecisionRequest,
    decision: Result<PickChoice, String>,
) -> Result<(String, Option<String>, Option<String>), String> {
    let choice = decision?;
    assert_safe_relative_path(&request.path)?;
    if !choice.allowed_without_base() && !base_available {
        return Err(
            "[sync_target] this batch has no base pointer: only keep_both is allowed (old batches are never rewritten)"
                .to_string(),
        );
    }
    let source_root = match choice {
        // 保留两者：两侧本已各自保留，无落盘动作。
        PickChoice::KeepBoth => return Ok((ITEM_STATUS_KEEP_BOTH.to_string(), None, None)),
        PickChoice::PickMine => mine_root.ok_or_else(|| {
            "[sync_target] local (mine) side is not available for this batch".to_string()
        })?,
        PickChoice::PickTheirs => theirs_root.ok_or_else(|| {
            "[sync_target] remote (theirs) side is not available for this batch".to_string()
        })?,
    };
    let source = source_root.join(&request.path);
    let bytes = fs::read(&source)
        .map_err(|e| format!("[sync_target] read {} failed: {e}", source.display()))?;
    let destination = project_path
        .join(".novel/resolutions")
        .join(sanitize_batch_token(batch_id))
        .join(&request.path);
    assert_local_target_allowed(&destination)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[sync_target] create {} failed: {e}", parent.display()))?;
    }
    fs::write(&destination, &bytes)
        .map_err(|e| format!("[sync_target] write {} failed: {e}", destination.display()))?;
    let relative = destination
        .strip_prefix(project_path)
        .unwrap_or(destination.as_path())
        .to_string_lossy()
        .replace('\\', "/");
    Ok((ITEM_STATUS_APPLIED.to_string(), Some(relative), None))
}

#[cfg(test)]
mod g2b_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "qm-g2b-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&base).expect("temp dir");
        base
    }

    fn journal_entry(
        manifest_id: &str,
        revision: u64,
        direction: &str,
        ts: &str,
    ) -> SyncJournalEntry {
        SyncJournalEntry {
            manifest_id: manifest_id.to_string(),
            revision,
            device_id: "device-a".to_string(),
            direction: direction.to_string(),
            ts: ts.to_string(),
            content_hash: "a".repeat(64),
            base_rev: None,
            base_content_hash: None,
        }
    }

    #[test]
    fn pick_choice_parses_strictly_and_falls_back() {
        assert_eq!(
            PickChoice::parse_strict(PICK_MINE),
            Ok(PickChoice::PickMine)
        );
        assert_eq!(
            PickChoice::parse_strict(PICK_THEIRS),
            Ok(PickChoice::PickTheirs)
        );
        assert_eq!(
            PickChoice::parse_strict(PICK_KEEP_BOTH),
            Ok(PickChoice::KeepBoth)
        );
        assert!(PickChoice::parse_strict("overwrite").is_err());
        // 未知值一律回落「保留两者」——绝不升级成覆盖。
        assert_eq!(PickChoice::parse_lenient("overwrite"), PickChoice::KeepBoth);
        assert!(!PickChoice::PickMine.allowed_without_base());
        assert!(PickChoice::KeepBoth.allowed_without_base());
    }

    #[test]
    fn three_way_classification_covers_both_changed_and_no_base() {
        let base = b"base";
        let mine = b"mine";
        let theirs = b"theirs";
        // 无 base → 不可选，只能 keep_both。
        let no_base = diff_item("a.md", false, None, Some(mine), Some(theirs));
        assert_eq!(no_base.status, DIFF_NO_BASE);
        assert!(!no_base.pickable);
        assert_eq!(no_base.choices, vec![PICK_KEEP_BOTH.to_string()]);
        assert_eq!(no_base.default_decision, PICK_KEEP_BOTH);
        // 双改 → 三选一。
        let both = diff_item("a.md", true, Some(base), Some(mine), Some(theirs));
        assert_eq!(both.status, DIFF_BOTH_CHANGED);
        assert!(both.pickable);
        assert_eq!(
            both.choices,
            vec![
                PICK_MINE.to_string(),
                PICK_THEIRS.to_string(),
                PICK_KEEP_BOTH.to_string()
            ]
        );
        // 单侧变化 → 不需要逐项裁决。
        assert_eq!(
            diff_item("a.md", true, Some(base), Some(mine), Some(base)).status,
            DIFF_MINE_ONLY
        );
        assert_eq!(
            diff_item("a.md", true, Some(base), Some(base), Some(theirs)).status,
            DIFF_THEIRS_ONLY
        );
        assert_eq!(
            diff_item("a.md", true, Some(base), Some(base), Some(base)).status,
            DIFF_UNCHANGED
        );
        assert_eq!(
            diff_item("a.md", true, Some(base), Some(mine), Some(mine)).status,
            DIFF_BOTH_SAME
        );
    }

    #[test]
    fn decide_pull_items_only_expands_keep_both() {
        // Apply / RefuseStale 没有「选哪侧」的问题 → 空清单。
        let apply = PullDecision::Apply;
        assert!(decide_pull_items(&apply, true, None, None, None)
            .expect("items")
            .is_empty());
        let stale = PullDecision::RefuseStale {
            local: 3,
            remote: 2,
        };
        assert!(decide_pull_items(&stale, true, None, None, None)
            .expect("items")
            .is_empty());
        // KeepBoth 才展开（无目录 → 空清单但走的是 diff 路径，不 panic）。
        let keep = PullDecision::KeepBoth {
            conflict_name: ".conflict-device-b-20261102120000".to_string(),
        };
        assert!(decide_pull_items(&keep, false, None, None, None)
            .expect("items")
            .is_empty());
    }

    #[test]
    fn diff_trees_marks_pickable_only_when_three_sides_known() {
        let root = temp_dir("diff");
        let base = root.join("base");
        let mine = root.join("mine");
        let theirs = root.join("theirs");
        for dir in [&base, &mine, &theirs] {
            fs::create_dir_all(dir).expect("dir");
        }
        fs::write(base.join("a.md"), b"base").expect("w");
        fs::write(mine.join("a.md"), b"mine").expect("w");
        fs::write(theirs.join("a.md"), b"theirs").expect("w");
        let items = diff_trees(true, Some(&base), Some(&mine), Some(&theirs)).expect("diff");
        assert_eq!(items.len(), 1);
        assert!(items[0].pickable);
        // 缺 base 内容 → 全部降级为「不可选」。
        let no_base = diff_trees(false, None, Some(&mine), Some(&theirs)).expect("diff");
        assert!(!no_base[0].pickable);
        assert_eq!(no_base[0].status, DIFF_NO_BASE);
        // 缺 mine 侧 → 不可选（缺侧时任何自动选择都可能是隐式覆盖）。
        let no_mine = diff_trees(true, Some(&base), None, Some(&theirs)).expect("diff");
        assert!(!no_mine[0].pickable);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_requires_actor_and_refuses_pick_without_base() {
        let root = temp_dir("apply");
        let manifest = "demo";
        let ts = "20261102120000";
        fs::create_dir_all(root.join(".novel/snapshots/remote-demo-rev-2")).expect("dir");
        fs::create_dir_all(root.join(".novel/.conflict-device-b-20261102120000")).expect("dir");
        fs::write(
            root.join(".novel/snapshots/remote-demo-rev-2/a.md"),
            b"mine",
        )
        .expect("w");
        fs::write(
            root.join(".novel/.conflict-device-b-20261102120000/a.md"),
            b"theirs",
        )
        .expect("w");
        // 无 base 指针的批次：pick_theirs 一律记 error（无 base 禁覆盖）。
        let refused = apply_item_decisions_impl(
            &root,
            manifest,
            2,
            "conflict",
            ts,
            "device-b",
            "niko",
            &[SyncItemDecisionRequest {
                path: "a.md".to_string(),
                decision: PICK_THEIRS.to_string(),
            }],
            "2026-11-02T12:00:01Z",
        )
        .expect("apply");
        assert_eq!(refused[0].status, ITEM_STATUS_ERROR);
        // 无 actor → 整次拒绝（显式用户动作是硬前置）。
        assert!(apply_item_decisions_impl(
            &root,
            manifest,
            2,
            "conflict",
            ts,
            "device-b",
            "  ",
            &[SyncItemDecisionRequest {
                path: "a.md".to_string(),
                decision: PICK_KEEP_BOTH.to_string(),
            }],
            "2026-11-02T12:00:01Z",
        )
        .is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_writes_resolution_and_journals_decision() {
        let root = temp_dir("land");
        let manifest = "demo";
        let ts = "20261102130000";
        // 基线态（base 指针来源）+ 本地快照 + 冲突副本。
        append_journal(
            &root,
            &SyncJournalEntry {
                base_rev: Some(0),
                base_content_hash: None,
                ..journal_entry(manifest, 1, "push", "20261102100000")
            },
        )
        .expect("journal");
        fs::create_dir_all(root.join(".novel/snapshots/remote-demo-rev-1")).expect("base dir");
        fs::create_dir_all(root.join(".novel/snapshots/remote-demo-rev-2")).expect("dir");
        fs::create_dir_all(root.join(".novel/.conflict-device-b-20261102130000")).expect("dir");
        fs::write(
            root.join(".novel/snapshots/remote-demo-rev-2/a.md"),
            b"mine",
        )
        .expect("w");
        fs::write(
            root.join(".novel/.conflict-device-b-20261102130000/a.md"),
            b"theirs",
        )
        .expect("w");
        append_journal(
            &root,
            &SyncJournalEntry {
                base_rev: Some(1),
                base_content_hash: Some("a".repeat(64)),
                ..journal_entry(manifest, 2, "conflict", ts)
            },
        )
        .expect("journal");
        let results = apply_item_decisions_impl(
            &root,
            manifest,
            2,
            "conflict",
            ts,
            "device-b",
            "niko",
            &[
                SyncItemDecisionRequest {
                    path: "a.md".to_string(),
                    decision: PICK_THEIRS.to_string(),
                },
                // 故意失败项（不存在的路径）——不得影响上一项。
                SyncItemDecisionRequest {
                    path: "missing.md".to_string(),
                    decision: PICK_MINE.to_string(),
                },
                SyncItemDecisionRequest {
                    path: "../escape.md".to_string(),
                    decision: PICK_MINE.to_string(),
                },
            ],
            "2026-11-02T13:00:01Z",
        )
        .expect("apply");
        assert_eq!(results[0].status, ITEM_STATUS_APPLIED);
        assert_eq!(results[1].status, ITEM_STATUS_ERROR);
        assert_eq!(results[2].status, ITEM_STATUS_ERROR);
        let landed = root
            .join(".novel/resolutions")
            .join(sanitize_batch_token(&batch_id_of(manifest, ts, "conflict")))
            .join("a.md");
        assert_eq!(fs::read(&landed).expect("read"), b"theirs");
        let records = read_item_journal(&root);
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].actor.as_deref(), Some("niko"));
        assert_eq!(
            records[0].decided_at.as_deref(),
            Some("2026-11-02T13:00:01Z")
        );
        assert_eq!(records[0].decision.as_deref(), Some(PICK_THEIRS));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn batches_expose_base_pointers_and_items() {
        let root = temp_dir("batches");
        fs::create_dir_all(root.join(".novel/snapshots/remote-demo-rev-2")).expect("base dir");
        append_journal(
            &root,
            &SyncJournalEntry {
                base_rev: Some(2),
                base_content_hash: Some("b".repeat(64)),
                ..journal_entry("demo", 3, "push", "20261102140000")
            },
        )
        .expect("journal");
        append_item_journal(
            &root,
            &SyncItemRecord {
                batch_id: batch_id_of("demo", "20261102140000", "push"),
                manifest_id: "demo".to_string(),
                revision: 3,
                direction: "push".to_string(),
                ts: "20261102140000".to_string(),
                device_id: "device-a".to_string(),
                path: "backup.zip".to_string(),
                status: ITEM_STATUS_APPLIED.to_string(),
                duration_ms: 12,
                error: None,
                decision: None,
                actor: None,
                decided_at: None,
            },
        )
        .expect("item journal");
        let batches = batches_impl(&root, 10).expect("batches");
        assert_eq!(batches.len(), 1);
        assert!(batches[0].base_available);
        assert_eq!(batches[0].base_rev, Some(2));
        assert_eq!(batches[0].items.len(), 1);
        assert_eq!(batches[0].items[0].path, "backup.zip");
        assert_eq!(batches[0].items[0].duration_ms, 12);
        // 老批次（无 base 字段）→ 无 base，不迁移、不重写。
        append_journal(&root, &journal_entry("demo", 4, "push", "20261102150000"))
            .expect("journal");
        let batches = batches_impl(&root, 10).expect("batches");
        assert_eq!(batches.len(), 2);
        assert!(!batches[1].base_available);
        fs::remove_dir_all(&root).ok();
    }
    #[test]
    fn batch_ids_carry_direction_so_push_and_pull_never_collide() {
        // F-002 回归：同一 timestamp 下 push / pull 必须是两条不同批次。
        let push = batch_id_of("demo", "20261102160000", "push");
        let pull = batch_id_of("demo", "20261102160000", "pull");
        let refused = batch_id_of("demo", "20261102160000", "refused");
        assert_ne!(push, pull);
        assert_ne!(push, refused);
        assert_ne!(pull, refused);
        assert_eq!(push, "demo@20261102160000@push");
        assert_eq!(pull, "demo@20261102160000@pull");
    }

    #[test]
    fn batches_from_the_same_timestamp_stay_separate_and_keep_their_own_items() {
        // F-002 回归（行为面）：同 ts 的 push + pull 两条 journal 行 → 两条批次，
        // 各自只挂自己方向的逐项记录，且 batch_id 互不相同（前端 key 不撞键）。
        let root = temp_dir("direction-batches");
        let ts = "20261102161000";
        append_journal(&root, &journal_entry("demo", 1, "push", ts)).expect("push journal");
        append_journal(&root, &journal_entry("demo", 1, "pull", ts)).expect("pull journal");
        for (direction, path) in [("push", "backup.zip"), ("pull", "manifest.json")] {
            append_item_journal(
                &root,
                &SyncItemRecord {
                    batch_id: batch_id_of("demo", ts, direction),
                    manifest_id: "demo".to_string(),
                    revision: 1,
                    direction: direction.to_string(),
                    ts: ts.to_string(),
                    device_id: "device-a".to_string(),
                    path: path.to_string(),
                    status: ITEM_STATUS_APPLIED.to_string(),
                    duration_ms: 1,
                    error: None,
                    decision: None,
                    actor: None,
                    decided_at: None,
                },
            )
            .expect("item journal");
        }
        let batches = batches_impl(&root, 10).expect("batches");
        assert_eq!(batches.len(), 2);
        assert_ne!(batches[0].batch_id, batches[1].batch_id);
        let push_batch = batches
            .iter()
            .find(|b| b.direction == "push")
            .expect("push batch");
        let pull_batch = batches
            .iter()
            .find(|b| b.direction == "pull")
            .expect("pull batch");
        assert_eq!(push_batch.items.len(), 1);
        assert_eq!(push_batch.items[0].path, "backup.zip");
        assert_eq!(pull_batch.items.len(), 1);
        assert_eq!(pull_batch.items[0].path, "manifest.json");
        // 传输 journal 里同一批次键最多出现一次。
        let journal = read_journal(&root);
        let keys: Vec<String> = journal
            .iter()
            .map(|entry| batch_id_of(&entry.manifest_id, &entry.ts, &entry.direction))
            .collect();
        let mut unique = keys.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            keys.len(),
            "batch keys must be unique: {keys:?}"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refused_batches_report_refused_not_keep_both() {
        // F-003 回归：RefuseStale（direction=refused）不得被映射成 keep_both。
        let root = temp_dir("refused-status");
        let ts = "20261102162000";
        append_journal(&root, &journal_entry("demo", 3, "refused", ts)).expect("journal");
        append_item_journal(
            &root,
            &SyncItemRecord {
                batch_id: batch_id_of("demo", ts, "refused"),
                manifest_id: "demo".to_string(),
                revision: 3,
                direction: "refused".to_string(),
                ts: ts.to_string(),
                device_id: "device-a".to_string(),
                path: "manifest.json".to_string(),
                status: ITEM_STATUS_REFUSED.to_string(),
                duration_ms: 1,
                error: None,
                decision: None,
                actor: None,
                decided_at: None,
            },
        )
        .expect("item journal");
        let batches = batches_impl(&root, 10).expect("batches");
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].direction, "refused");
        assert_eq!(batches[0].status, ITEM_STATUS_REFUSED);
        assert_ne!(batches[0].status, ITEM_STATUS_KEEP_BOTH);
        // 从未创建冲突副本目录 → 三路明细不成立，theirs_root 必须为 None。
        assert!(batches[0].theirs_root.is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn base_pointer_without_base_dir_is_not_usable() {
        // F-004 回归：journal 有 base 指针但 base 快照目录不存在（纯 push 工作流 /
        // 目录被清理）→ 门禁必须与展示侧同判：pick_* 一律 error。
        let root = temp_dir("base-dir-missing");
        let ts = "20261102163000";
        fs::create_dir_all(root.join(".novel/snapshots/remote-demo-rev-3")).expect("mine dir");
        fs::create_dir_all(root.join(".novel/.conflict-device-b-20261102163000"))
            .expect("theirs dir");
        fs::write(
            root.join(".novel/snapshots/remote-demo-rev-3/a.md"),
            b"mine",
        )
        .expect("w");
        fs::write(
            root.join(".novel/.conflict-device-b-20261102163000/a.md"),
            b"theirs",
        )
        .expect("w");
        append_journal(
            &root,
            &SyncJournalEntry {
                base_rev: Some(2),
                base_content_hash: Some("a".repeat(64)),
                ..journal_entry("demo", 3, "conflict", ts)
            },
        )
        .expect("journal");
        // 展示侧：base_available = false（目录不在）。
        let batches = batches_impl(&root, 10).expect("batches");
        assert_eq!(batches.len(), 1);
        assert!(!batches[0].base_available);
        // 写入门禁：同一判据 → pick_theirs 被拒（不是静默落盘）。
        let results = apply_item_decisions_impl(
            &root,
            "demo",
            3,
            "conflict",
            ts,
            "device-b",
            "niko",
            &[SyncItemDecisionRequest {
                path: "a.md".to_string(),
                decision: PICK_THEIRS.to_string(),
            }],
            "2026-11-02T16:30:01Z",
        )
        .expect("apply");
        assert_eq!(results[0].status, ITEM_STATUS_ERROR);
        assert!(results[0].output_path.is_none());
        assert!(!root
            .join(".novel/resolutions")
            .join(sanitize_batch_token(&batch_id_of("demo", ts, "conflict")))
            .join("a.md")
            .exists());
        fs::remove_dir_all(&root).ok();
    }
}
