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

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::canon::write_authority::{may_write, WriteDecision, WriteSource};

use super::sync_target::{
    conflict_file_name, journal_line, REMOTE_REVISION_PREFIX, SYNC_JOURNAL_FILE,
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
    /// `push` | `pull` | `conflict`。
    pub direction: String,
    pub ts: String,
    #[serde(default)]
    pub content_hash: String,
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

/// 本地已知状态：该 `manifest_id` 在 journal 中 revision 最大的那条记录。
pub fn local_state(project_path: &Path, manifest_id: &str) -> RevisionState {
    read_journal(project_path)
        .into_iter()
        .filter(|entry| entry.manifest_id == manifest_id && entry.direction != "conflict")
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
}

/// 拉取结果。
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
