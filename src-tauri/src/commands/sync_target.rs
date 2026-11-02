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
//!
//! ## G1：第二种传输实现（GitHub 私有仓）
//! [`GitHubTarget`] 与 [`WebDavTarget`] 并列，**只**实现同一 [`SyncTarget`] 三原语，
//! 因此推送 / 拉取 / 冲突裁决全部复用既有执行层——GitHub 不是第二套同步引擎。
//! 传输选型由 [`choose_transfer_path`]（R1，阈值 [`CONTENTS_API_MAX_BYTES`]）决定：
//! 小对象走 contents API 单 PUT（带 sha 并发保护），大对象（含备份 zip）走 Git Data API。
//! 凭据域固定为 `nb:github:<account>`（[`validate_github_config`] 在配置期硬拒其他域）。
//!
//! ## G2a：第三种传输实现（本地文件夹）
//! [`LocalFolderTarget`] 与上两者并列，同样只实现 [`SyncTarget`] 三原语；写入通道沿用
//! `commands::fs` 的直读写语义（`std::fs`，不经 HTTP、不经凭据库）。因此本地目标
//! **不需要** `credential_ref`（配置期要求其为空串），凭据链在 UI 上整段隐藏。
//! 传输选型由 `endpoint` 字面量决定：[`LOCAL_ENDPOINT`] / [`GITHUB_ENDPOINT`] / 其余按
//! WebDAV URL；三者在 [`build_target`] 里收敛成同一 [`ConfiguredTarget`]，于是推送 /
//! 拉取 / 冲突裁决 / journal 全部复用既有编排（没有第二套同步引擎）。

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::canon::archive;
use crate::commands::secret_store::{
    self, is_available_sync, read_secret_sync, store_status_sync,
};

/// 传输配置文件名（与项目内既有配置同族）。
pub const SYNC_CONFIG_FILE: &str = ".niko-buddy/sync-config.json";

/// 传输 journal（会话态、可清、**非第二真源**）。
pub const SYNC_JOURNAL_FILE: &str = ".novel/sync-journal.jsonl";

/// 逐项 journal（G2b：每批次逐项状态 / 裁决 / actor / 时间）。
///
/// 与 [`SYNC_JOURNAL_FILE`] **分文件**：`local_state` / `local_revision` 以传输 journal
/// 的单调版本水位为准，逐项行混进去会污染水位（判新旧只能靠传输记录）。
pub const SYNC_ITEM_JOURNAL_FILE: &str = ".novel/sync-item-journal.jsonl";

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

// ── G1：GitHub 私有仓传输目标（D1 传输选型锁定）───────────────────────────────
//
// 定位：与 [`WebDavTarget`] 并列的**第二种传输实现**，同样只实现 [`SyncTarget`]
// 三原语（list / get / put），所以推送 / 拉取 / 冲突裁决零改动地复用。
// 真值边界不变：远端任一副本皆非真值；远端键仍经 [`assert_remote_key_allowed`]。
//
// 传输选型（**R1 锁定**）：≤ [`CONTENTS_API_MAX_BYTES`] 走 contents API 单 PUT
// （含 sha 并发保护）；更大对象（含备份 zip）走 Git Data API
// （create blob → create tree → create commit → update ref）。两路共用
// [`verify_manifest_digest`] 的写后校验。

/// GitHub REST API 仓库根（`/repos/{owner}/{repo}` 之前的固定前缀）。
pub const GITHUB_API_BASE: &str = "https://api.github.com/repos";

/// 配置里选择 GitHub 传输目标的 `endpoint` 字面量（前端 `RawSyncConfig.endpoint`）。
pub const GITHUB_ENDPOINT: &str = "github";

/// GitHub API 版本头（固定值，避免隐式跟随默认版本漂移）。
const GITHUB_API_VERSION: &str = "2022-11-28";

/// 客户端标识（GitHub 要求带 User-Agent）。
const GITHUB_USER_AGENT: &str = "niko-buddy-sync";

/// 目录列举最大深度（异常远端结构不得把列举变成无限循环）。
const GITHUB_LIST_MAX_DEPTH: usize = 8;

/// 传输选型阈值（**R1 锁定**）：≤ 1 MiB 走 contents API 单 PUT，> 1 MiB 走 Git Data API。
///
/// R1 依据：contents API 的写请求要求把内容 base64 内联进 JSON，且单文件在 1 MiB 处
/// 换档（超过时响应里 `content` 为空、`encoding: "none"`）。备份 zip 通常在数 MB 到
/// 数十 MB，必须走 Git Data API（blob → tree → commit → ref）。**同一个分界点同时用于
/// 读与写**，避免「写得进、读不回」的不对称。阈值是具名常量，改它等于改传输契约。
pub const CONTENTS_API_MAX_BYTES: usize = 1024 * 1024;

/// 传输选路结果（具名枚举，便于对阈值边界做单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferPath {
    /// contents API 单 PUT（≤ 1 MiB）。
    ContentsApi,
    /// Git Data API（blob → tree → commit → ref；> 1 MiB）。
    GitDataApi,
}

/// 按字节数选路（R1）。边界含在 contents 一侧（`<=`）。
pub fn choose_transfer_path(byte_len: usize) -> TransferPath {
    if byte_len <= CONTENTS_API_MAX_BYTES {
        TransferPath::ContentsApi
    } else {
        TransferPath::GitDataApi
    }
}

/// `endpoint` 是否选择了 GitHub 传输目标（大小写与首尾空白不敏感）。
pub fn is_github_endpoint(endpoint: &str) -> bool {
    endpoint.trim().eq_ignore_ascii_case(GITHUB_ENDPOINT)
}

/// GitHub 传输块（`endpoint == "github"` 时必填）。
///
/// 线上字段是 camelCase（`pathPrefix`），同时接受 snake_case 别名——前端
/// `RawSyncConfig` 用 `pathPrefix`，Rust 内部字段名保持 snake_case。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitHubConfig {
    /// 仓库所有者。
    pub owner: String,
    /// 仓库名（私有仓）。
    pub repo: String,
    /// 分支（ref 名）。
    pub branch: String,
    /// 仓内对象前缀（相对路径；空串 = 仓库根）。
    #[serde(alias = "path_prefix")]
    pub path_prefix: String,
}

/// GitHub 传输配置校验（**配置期**门禁，纯函数）。
///
/// 关键一条：`credential_ref` 必须形如 `nb:github:<account>`。把别的域的引用配给
/// GitHub 目标会在配置期就失败，而不是等推送时才 401。
pub fn validate_github_config(config: &GitHubConfig, credential_ref: &str) -> Result<(), String> {
    for (label, value) in [("owner", &config.owner), ("repo", &config.repo)] {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(format!("[sync_target] github {label} must not be empty"));
        }
        if !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(format!(
                "[sync_target] github {label} must match [A-Za-z0-9._-]: {trimmed}"
            ));
        }
    }
    let branch = config.branch.trim();
    if branch.is_empty() {
        return Err("[sync_target] github branch must not be empty".to_string());
    }
    if branch.starts_with('/') || branch.ends_with('/') || branch.contains("..") {
        return Err(format!(
            "[sync_target] github branch must be a relative ref without '..': {branch}"
        ));
    }
    if !branch
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
    {
        return Err(format!(
            "[sync_target] github branch must match [A-Za-z0-9._/-]: {branch}"
        ));
    }
    let prefix = config.path_prefix.trim();
    if prefix.starts_with('/') || prefix.contains("..") || prefix.contains('\\') {
        return Err(format!(
            "[sync_target] github pathPrefix must be a relative POSIX prefix without '..': {prefix}"
        ));
    }
    // 凭据域硬门（A2）：只有 nb:github: 引用能配给 GitHub 传输目标。
    secret_store::require_github_credential_ref(credential_ref)?;
    Ok(())
}

/// 一次 GitHub API 调用的原始结果。
struct GitHubResponse {
    status: u16,
    body: String,
    rate_limit_remaining: Option<String>,
    rate_limit_reset: Option<String>,
}

impl GitHubResponse {
    fn json(&self) -> Result<serde_json::Value, String> {
        serde_json::from_str(&self.body).map_err(|e| {
            format!(
                "[sync_target] github response is not JSON (status {}): {e}",
                self.status
            )
        })
    }
}

/// GitHub 调用失败分类（可重试性 + 速率限制重置 + 面向调用方的文案）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubHttpError {
    pub status: u16,
    /// `true` 表示可原样重试（速率限制 / 并发冲突 / 5xx）。
    pub retryable: bool,
    /// `x-ratelimit-reset` 原值（Unix 秒）；速率限制之外为 `None`。
    pub rate_limit_reset: Option<String>,
    /// 文案（**绝不含 token**：分类只吃状态码 / 限流头 / 响应体）。
    pub message: String,
}

/// HTTP 状态码 → 错误分类（纯函数，可单测）。
///
/// - 403（限流耗尽或响应体提示限流）/ 429 → `retryable = true`，文案带 `x-ratelimit-reset`。
/// - 401 / 404 → 直接失败，文案提示检查 token 权限与仓名 / 分支。
/// - 409（contents sha 并发冲突）/ 422（非快进）/ 5xx → 可重试。
pub fn classify_status(
    status: u16,
    rate_limit_remaining: Option<&str>,
    rate_limit_reset: Option<&str>,
    body: &str,
    context: &str,
) -> Result<(), GitHubHttpError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let exhausted = rate_limit_remaining
        .map(|value| value.trim() == "0")
        .unwrap_or(false);
    let rate_limited = exhausted || body.to_ascii_lowercase().contains("rate limit");
    let reset_hint = rate_limit_reset
        .map(|value| format!(" x-ratelimit-reset={value}"))
        .unwrap_or_default();
    let error = |retryable: bool, message: String| GitHubHttpError {
        status,
        retryable,
        rate_limit_reset: rate_limit_reset.map(|value| value.to_string()),
        message,
    };
    match status {
        401 => Err(error(
            false,
            format!(
                "[sync_target] github authentication failed (retryable=false, status=401) on {context}; check that the stored nb:github token is valid and has 'repo' scope for this private repository"
            ),
        )),
        403 if rate_limited => Err(error(
            true,
            format!(
                "[sync_target] github rate limited (retryable=true, status=403){reset_hint} on {context}; wait for the reset window then retry"
            ),
        )),
        403 => Err(error(
            false,
            format!(
                "[sync_target] github forbidden (retryable=false, status=403) on {context}; check the token permissions ('repo' scope, push access) and the branch protection rules"
            ),
        )),
        404 => Err(error(
            false,
            format!(
                "[sync_target] github not found (retryable=false, status=404) on {context}; check the token permissions and the repository name (owner/repo) / branch"
            ),
        )),
        409 => Err(error(
            true,
            format!(
                "[sync_target] github write conflict (retryable=true, status=409) on {context}; the remote object changed between read and write (sha guard), retry the push"
            ),
        )),
        422 => Err(error(
            true,
            format!(
                "[sync_target] github rejected the update (retryable=true, status=422) on {context}; the branch moved (non-fast-forward) or the tree/commit payload was rejected, retry the push"
            ),
        )),
        429 => Err(error(
            true,
            format!(
                "[sync_target] github rate limited (retryable=true, status=429){reset_hint} on {context}; wait for the reset window then retry"
            ),
        )),
        code if code >= 500 => Err(error(
            true,
            format!(
                "[sync_target] github server error (retryable=true, status={code}) on {context}; retry later"
            ),
        )),
        code => Err(error(
            false,
            format!("[sync_target] github request failed (retryable=false, status={code}) on {context}"),
        )),
    }
}

/// 记一条传输健康 journal（速率限制 / 凭据降级 / 可重试失败）。
///
/// 与 [`SyncJournalEntry`] 同文件同格式（JSONL），字段集更宽：额外带 `context` /
/// `retryable` / `rate_limit_reset` / `message`。既有读取器 [`read_journal`] 仍能解析
/// 这些行（未知字段被忽略），[`local_state`] 按 `manifest_id` 过滤故不受影响。
/// **文案里永不出现 token**：调用方只传分类结果，不传请求头。
pub fn append_transport_journal(
    project_path: Option<&Path>,
    direction: &str,
    context: &str,
    rate_limit_reset: Option<&str>,
    message: &str,
) -> Result<(), String> {
    let Some(project_path) = project_path else {
        return Ok(());
    };
    let entry = serde_json::json!({
        "manifest_id": "transport-health",
        "revision": 0,
        "device_id": "github-target",
        "direction": direction,
        "ts": now_ts(),
        "content_hash": "",
        "context": context,
        "retryable": direction == "retryable",
        "rate_limit_reset": rate_limit_reset,
        "message": message,
    });
    let line = serde_json::to_string(&entry)
        .map_err(|e| format!("[sync_target] transport journal encode failed: {e}"))?;
    let path = project_path.join(SYNC_JOURNAL_FILE);
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
    writeln!(sink, "{line}").map_err(|e| format!("[sync_target] append journal failed: {e}"))
}

/// manifest 的 `content_digest`（写后校验的唯一判据）。
fn manifest_digest_of(bytes: &[u8]) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("[sync_target] manifest is not valid JSON: {e}"))?;
    value
        .get("content_digest")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "[sync_target] manifest has no content_digest".to_string())
}

/// manifest 写后校验（**两路共用**）：写进去的与读回来的必须同指纹。
pub fn verify_manifest_digest(written: &[u8], read_back: &[u8]) -> Result<(), String> {
    let expected = manifest_digest_of(written)?;
    let actual = manifest_digest_of(read_back)?;
    if expected != actual {
        return Err(format!(
            "[sync_target] manifest content_hash mismatch after write: wrote {expected}, remote returned {actual}"
        ));
    }
    Ok(())
}

/// 最小 URL 路径编码：只放行 `[A-Za-z0-9._~/-]`，其余按 `%XX` 转义。
fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'~' | b'/' | b'-' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 去掉 base64 文本里的换行/空白（GitHub 会在 60 字符处换行）。
fn strip_whitespace(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// base64 解码（GitHub blob / contents 响应；`base64` 已是既有依赖，不新增包）。
fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text.as_bytes())
        .map_err(|e| format!("[sync_target] github base64 decode failed: {e}"))
}

/// GitHub 私有仓传输目标。
pub struct GitHubTarget {
    owner: String,
    repo: String,
    branch: String,
    path_prefix: String,
    credential_ref: String,
    /// 传输 journal 落点（项目根）；`None` = 不记 journal（单测/无项目上下文）。
    journal_root: Option<PathBuf>,
}

impl GitHubTarget {
    /// 由配置构造（不做 I/O；凭据惰性读取，但**配置期**先过校验）。
    pub fn new(config: &GitHubConfig, credential_ref: &str) -> Result<Self, String> {
        validate_github_config(config, credential_ref)?;
        // 引用归一化：存储查找只认 `nb:github:<account>` 的规范形态。
        let (_, account) = secret_store::require_github_credential_ref(credential_ref)?;
        Ok(GitHubTarget {
            owner: config.owner.trim().to_string(),
            repo: config.repo.trim().to_string(),
            branch: config.branch.trim().to_string(),
            path_prefix: config.path_prefix.trim().trim_matches('/').to_string(),
            credential_ref: secret_store::github_credential_ref(&account)?,
            journal_root: None,
        })
    }

    /// 绑定传输 journal 落点（项目根）。
    pub fn with_journal_root(mut self, project_path: &Path) -> Self {
        self.journal_root = Some(project_path.to_path_buf());
        self
    }

    /// 远端对象路径（相对仓库根）：`<pathPrefix>/<key>`。
    fn remote_path(&self, key: &str) -> String {
        let key = key.trim_matches('/');
        if self.path_prefix.is_empty() {
            key.to_string()
        } else if key.is_empty() {
            self.path_prefix.clone()
        } else {
            format!("{}/{key}", self.path_prefix)
        }
    }

    /// 仓库根相对路径 → 对象键（不在 `pathPrefix` 下则 `None`）。
    fn relative_key(&self, remote: &str) -> Option<String> {
        if self.path_prefix.is_empty() {
            return Some(remote.trim_matches('/').to_string());
        }
        remote
            .strip_prefix(&self.path_prefix)
            .and_then(|rest| rest.strip_prefix('/'))
            .map(|rest| rest.to_string())
    }

    fn api_url(&self, suffix: &str) -> String {
        format!("{GITHUB_API_BASE}/{}/{}{suffix}", self.owner, self.repo)
    }

    /// 惰性取 token：**凭据库探针先行**——不可用时返回降级文案（不裸抛平台错误）。
    fn token(&self) -> Result<String, String> {
        if !store_status_sync() {
            return Err(secret_store::github_store_degraded_message());
        }
        let token = read_secret_sync("", &self.credential_ref)?;
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err(format!(
                "[sync_target] the stored credential for {} is empty; store a GitHub token first",
                self.credential_ref
            ));
        }
        Ok(token)
    }

    fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .user_agent(GITHUB_USER_AGENT)
            .build()
            .map_err(|e| format!("[sync_target] build github http client failed: {e}"))
    }

    /// 发一次 API 调用（不做状态映射；调用方决定 404 等语义）。
    async fn call(
        &self,
        method: &str,
        suffix: &str,
        body: Option<serde_json::Value>,
    ) -> Result<GitHubResponse, String> {
        let url = self.api_url(suffix);
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| format!("[sync_target] github method is invalid: {e}"))?;
        let mut request = Self::client()?
            .request(method, &url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            // token 只进请求头：**永不**进 journal / 错误文案 / 配置文件。
            .header("Authorization", format!("Bearer {}", self.token()?));
        if let Some(body) = body {
            let encoded = serde_json::to_string(&body)
                .map_err(|e| format!("[sync_target] github request encode failed: {e}"))?;
            request = request
                .header("Content-Type", "application/json")
                .body(encoded);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("[sync_target] github request {suffix} failed: {e}"))?;
        let status = response.status().as_u16();
        let rate_limit_remaining = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let rate_limit_reset = response
            .headers()
            .get("x-ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let body = response
            .text()
            .await
            .map_err(|e| format!("[sync_target] github response read failed: {e}"))?;
        Ok(GitHubResponse {
            status,
            body,
            rate_limit_remaining,
            rate_limit_reset,
        })
    }

    /// 状态映射：可重试错误同时落传输 journal（含 `x-ratelimit-reset`）。
    fn ensure_success(&self, response: &GitHubResponse, context: &str) -> Result<(), String> {
        match classify_status(
            response.status,
            response.rate_limit_remaining.as_deref(),
            response.rate_limit_reset.as_deref(),
            &response.body,
            context,
        ) {
            Ok(()) => Ok(()),
            Err(error) => {
                if error.retryable {
                    let context = format!("{context} (status={})", error.status);
                    let _ = append_transport_journal(
                        self.journal_root.as_deref(),
                        "retryable",
                        &context,
                        error.rate_limit_reset.as_deref(),
                        &error.message,
                    );
                }
                Err(error.message)
            }
        }
    }

    async fn get_json(&self, suffix: &str, context: &str) -> Result<serde_json::Value, String> {
        let response = self.call("GET", suffix, None).await?;
        self.ensure_success(&response, context)?;
        response.json()
    }

    async fn post_json(
        &self,
        suffix: &str,
        body: serde_json::Value,
        context: &str,
    ) -> Result<serde_json::Value, String> {
        let response = self.call("POST", suffix, Some(body)).await?;
        self.ensure_success(&response, context)?;
        response.json()
    }

    async fn patch_json(
        &self,
        suffix: &str,
        body: serde_json::Value,
        context: &str,
    ) -> Result<serde_json::Value, String> {
        let response = self.call("PATCH", suffix, Some(body)).await?;
        self.ensure_success(&response, context)?;
        response.json()
    }

    /// 读远端当前对象 sha（不存在 → `None`）；contents API 的并发保护输入。
    async fn contents_sha(&self, remote: &str, key: &str) -> Result<Option<String>, String> {
        let suffix = format!("/contents/{}?ref={}", encode_path(remote), self.branch);
        let response = self.call("GET", &suffix, None).await?;
        if response.status == 404 {
            return Ok(None);
        }
        self.ensure_success(&response, &format!("read sha for {key}"))?;
        let value = response.json()?;
        Ok(value
            .get("sha")
            .and_then(|value| value.as_str())
            .map(|sha| sha.to_string()))
    }

    /// 小对象路径（≤ [`CONTENTS_API_MAX_BYTES`]）：contents API 单 PUT。
    async fn put_via_contents(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        let remote = self.remote_path(key);
        let existing_sha = self.contents_sha(&remote, key).await?;
        let mut body = serde_json::json!({
            "message": format!("niko-buddy backup: {key}"),
            "content": base64_encode(bytes),
            "branch": self.branch,
        });
        if let Some(sha) = existing_sha {
            // sha 并发保护：远端在两个请求之间变化时 GitHub 返回 409（可重试），
            // 而不是让后写者静默覆盖先写者。
            body["sha"] = serde_json::Value::String(sha);
        }
        let suffix = format!("/contents/{}", encode_path(&remote));
        let response = self.call("PUT", &suffix, Some(body)).await?;
        self.ensure_success(&response, &format!("put {key} (contents api)"))
    }

    /// 大对象路径（> [`CONTENTS_API_MAX_BYTES`]）：blob → tree → commit → update ref。
    async fn put_via_git_data(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        let remote = self.remote_path(key);
        // 1) create blob
        let blob = self
            .post_json(
                "/git/blobs",
                serde_json::json!({
                    "content": base64_encode(bytes),
                    "encoding": "base64",
                }),
                &format!("create blob for {key}"),
            )
            .await?;
        let blob_sha = json_str(&blob, "sha", "create blob")?;
        // 2) 当前分支头 commit（读取基线）
        let reference = self
            .get_json(
                &format!("/git/ref/heads/{}", encode_path(&self.branch)),
                "read branch ref",
            )
            .await?;
        let head_sha = reference
            .get("object")
            .and_then(|object| object.get("sha"))
            .and_then(|value| value.as_str())
            .ok_or_else(|| "[sync_target] github branch ref has no object sha".to_string())?
            .to_string();
        // 3) 基线 commit → base tree
        let commit = self
            .get_json(&format!("/git/commits/{head_sha}"), "read head commit")
            .await?;
        let base_tree = commit
            .get("tree")
            .and_then(|tree| tree.get("sha"))
            .and_then(|value| value.as_str())
            .ok_or_else(|| "[sync_target] github head commit has no tree sha".to_string())?
            .to_string();
        // 4) create tree（在基线树之上只加本对象）
        let tree = self
            .post_json(
                "/git/trees",
                serde_json::json!({
                    "base_tree": base_tree,
                    "tree": [{
                        "path": remote,
                        "mode": "100644",
                        "type": "blob",
                        "sha": blob_sha,
                    }],
                }),
                &format!("create tree for {key}"),
            )
            .await?;
        let tree_sha = json_str(&tree, "sha", "create tree")?;
        // 5) create commit
        let new_commit = self
            .post_json(
                "/git/commits",
                serde_json::json!({
                    "message": format!("niko-buddy backup: {key}"),
                    "tree": tree_sha,
                    "parents": [head_sha],
                }),
                &format!("create commit for {key}"),
            )
            .await?;
        let commit_sha = json_str(&new_commit, "sha", "create commit")?;
        // 6) update ref（`force: false`：非快进 → 422 可重试，绝不强推覆盖别人）
        self.patch_json(
            &format!("/git/refs/heads/{}", encode_path(&self.branch)),
            serde_json::json!({"sha": commit_sha, "force": false}),
            &format!("update ref for {key}"),
        )
        .await?;
        Ok(())
    }

    /// 取 blob 原始字节（contents API 对 >1 MiB 文件不返回内容时的兜底）。
    async fn get_blob(&self, sha: &str) -> Result<Vec<u8>, String> {
        let value = self
            .get_json(&format!("/git/blobs/{sha}"), "get blob")
            .await?;
        let encoded = value
            .get("content")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("[sync_target] github blob {sha} has no content"))?;
        base64_decode(&strip_whitespace(encoded))
    }

    /// manifest 写后读回校验（**两路共用**；其它对象不额外往返一次）。
    async fn verify_manifest_write_back(&self, key: &str, written: &[u8]) -> Result<(), String> {
        if !key.ends_with(REMOTE_MANIFEST_FILE) {
            return Ok(());
        }
        let read_back = self.get(key).await?;
        verify_manifest_digest(written, &read_back)
    }
}

fn json_str(value: &serde_json::Value, field: &str, context: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| format!("[sync_target] github {context} response has no '{field}'"))
}

impl SyncTarget for GitHubTarget {
    async fn list(&self, path: &str) -> Result<Vec<String>, String> {
        let mut objects: Vec<String> = Vec::new();
        let mut queue: Vec<(String, usize)> = vec![(path.trim_matches('/').to_string(), 0)];
        while let Some((dir, depth)) = queue.pop() {
            if depth > GITHUB_LIST_MAX_DEPTH {
                return Err(format!(
                    "[sync_target] github directory listing exceeded depth {GITHUB_LIST_MAX_DEPTH} at {dir}"
                ));
            }
            let remote = self.remote_path(&dir);
            let suffix = if remote.is_empty() {
                format!("/contents?ref={}", self.branch)
            } else {
                format!("/contents/{}?ref={}", encode_path(&remote), self.branch)
            };
            let response = self.call("GET", &suffix, None).await?;
            if response.status == 404 {
                // 目录不存在 = 空（推送首个版本时远端还没有任何对象）。
                continue;
            }
            self.ensure_success(&response, &format!("list {dir}"))?;
            let value = response.json()?;
            let entries = value.as_array().ok_or_else(|| {
                format!("[sync_target] github listing for '{dir}' is not a directory")
            })?;
            for entry in entries {
                let entry_path = entry
                    .get("path")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let entry_type = entry
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let Some(key) = self.relative_key(entry_path) else {
                    continue;
                };
                if key.is_empty() {
                    continue;
                }
                if entry_type == "dir" {
                    queue.push((key, depth + 1));
                } else {
                    objects.push(key);
                }
            }
        }
        objects.sort();
        objects.dedup();
        Ok(objects)
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        let remote = self.remote_path(path);
        if remote.is_empty() {
            return Err("[sync_target] github get requires an object key".to_string());
        }
        let suffix = format!("/contents/{}?ref={}", encode_path(&remote), self.branch);
        let response = self.call("GET", &suffix, None).await?;
        self.ensure_success(&response, &format!("get {path}"))?;
        let value = response.json()?;
        if let Some(encoded) = value.get("content").and_then(|value| value.as_str()) {
            let cleaned = strip_whitespace(encoded);
            if !cleaned.is_empty() {
                return base64_decode(&cleaned);
            }
        }
        // 超过 CONTENTS_API_MAX_BYTES（R1 同一分界点）时 contents API 不返回内容
        // （`encoding: "none"`）→ 用 blob sha 走 Git Data API 取原始字节。
        let sha = value.get("sha").and_then(|value| value.as_str()).ok_or_else(|| {
            format!("[sync_target] github get {path} returned neither content nor sha")
        })?;
        self.get_blob(sha).await
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        assert_remote_key_allowed(path)?;
        // R1：按字节数选路（阈值是具名常量 [`CONTENTS_API_MAX_BYTES`]）。
        match choose_transfer_path(bytes.len()) {
            TransferPath::ContentsApi => self.put_via_contents(path, bytes).await?,
            TransferPath::GitDataApi => self.put_via_git_data(path, bytes).await?,
        }
        // 两路共用：manifest 写后读回校验 content_hash（写成功 ≠ 内容正确）。
        self.verify_manifest_write_back(path, bytes).await
    }
}

// ── G2a：本地文件夹传输目标（第三种传输实现）──────────────────────────────────
//
// 定位：与 [`WebDavTarget`] / [`GitHubTarget`] 并列的第三种传输实现，同样只实现
// [`SyncTarget`] 三原语（list / get / put），所以推送 / 拉取 / 冲突裁决零改动地复用。
// 写入通道沿用 `commands::fs` 的直读写语义（`std::fs`，不经 HTTP）。
// 真值边界不变：目标目录里的副本**永不**是真值；对象键仍经 [`assert_remote_key_allowed`]。

/// 配置里选择本地文件夹传输目标的 `endpoint` 字面量（前端 `RawSyncConfig.endpoint`）。
pub const LOCAL_ENDPOINT: &str = "local";

/// 本地文件夹传输块（`endpoint == "local"` 时必填）。
///
/// 线上字段是 camelCase（`localPath`），同时接受 snake_case 别名——前端
/// `RawSyncConfig` 用 `localPath`，Rust 内部字段名保持 snake_case。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalFolderConfig {
    /// 目标目录绝对路径（用户在「本地文件夹」目标里选定的目录）。
    #[serde(alias = "local_path")]
    pub local_path: String,
}

/// `endpoint` 是否选择了本地文件夹传输目标（大小写与首尾空白不敏感）。
pub fn is_local_endpoint(endpoint: &str) -> bool {
    endpoint.trim().eq_ignore_ascii_case(LOCAL_ENDPOINT)
}

/// 本地文件夹配置校验（**配置期**门禁，纯函数）。返回归一化后的目标目录。
///
/// 关键一条：`credential_ref` 必须为空。本地文件夹不需要任何凭据，把凭据引用配给
/// 本地目标会让 UI 露出整段凭据链（B4 要求本地目标隐藏凭据行），因此在配置期就拒绝。
pub fn validate_local_config(
    config: &LocalFolderConfig,
    credential_ref: &str,
) -> Result<PathBuf, String> {
    let raw = config.local_path.trim();
    if raw.is_empty() {
        return Err("[sync_target] local localPath must not be empty".to_string());
    }
    if raw.contains('\0') {
        return Err("[sync_target] local localPath must not contain NUL".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!(
            "[sync_target] local localPath must be an absolute directory path: {raw}"
        ));
    }
    for segment in raw.split(['/', '\\']) {
        if segment == ".." {
            return Err(format!(
                "[sync_target] local localPath must not contain '..': {raw}"
            ));
        }
    }
    if !credential_ref.trim().is_empty() {
        return Err(
            "[sync_target] endpoint=local requires an empty credential_ref (a local folder needs no credentials)"
                .to_string(),
        );
    }
    Ok(path)
}

/// 本地文件夹传输目标（文件拷贝 + manifest content_hash 写后比对）。
pub struct LocalFolderTarget {
    root: PathBuf,
}

impl LocalFolderTarget {
    /// 由配置构造（不做 I/O；配置期校验先行）。
    pub fn new(config: &LocalFolderConfig, credential_ref: &str) -> Result<Self, String> {
        Ok(LocalFolderTarget {
            root: validate_local_config(config, credential_ref)?,
        })
    }

    /// 直接以目录构造（供调度器 / 单测使用；调用方已保证路径合法）。
    pub fn at_root(root: PathBuf) -> Self {
        LocalFolderTarget { root }
    }

    /// 对象键 → 目标目录内的绝对路径。
    ///
    /// 键守卫（[`assert_remote_key_allowed`]）在**触碰文件系统之前**执行：拒绝绝对路径、
    /// `..`、反斜杠与真值面路径段，因此 `join` 之后不可能逃出 `root`。
    fn resolve(&self, key: &str) -> Result<PathBuf, String> {
        assert_remote_key_allowed(key)?;
        Ok(self.root.join(key.trim_start_matches('/')))
    }

    /// manifest 写后读回校验（与 GitHub 目标同判据）：写进去的与读回来的必须同指纹。
    fn verify_manifest_write_back(&self, key: &str, written: &[u8]) -> Result<(), String> {
        if !key.ends_with(REMOTE_MANIFEST_FILE) {
            return Ok(());
        }
        let read_back = fs::read(self.resolve(key)?)
            .map_err(|e| format!("[sync_target] local read-back failed: {e}"))?;
        verify_manifest_digest(written, &read_back)
    }
}

impl SyncTarget for LocalFolderTarget {
    async fn list(&self, path: &str) -> Result<Vec<String>, String> {
        // 目标目录尚不存在 = 空目标（首次推送时才会创建），不是错误。
        if !self.root.is_dir() {
            return Ok(Vec::new());
        }
        let prefix = path.trim_matches('/');
        let mut objects: Vec<String> = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root).follow_links(false) {
            let entry = entry.map_err(|e| format!("[sync_target] local walk failed: {e}"))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|e| format!("[sync_target] local strip_prefix failed: {e}"))?;
            let key = relative.to_string_lossy().replace('\\', "/");
            if prefix.is_empty() || key == prefix || key.starts_with(&format!("{prefix}/")) {
                objects.push(key);
            }
        }
        objects.sort();
        objects.dedup();
        Ok(objects)
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        let source = self.resolve(path)?;
        fs::read(&source)
            .map_err(|e| format!("[sync_target] local read {} failed: {e}", source.display()))
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let destination = self.resolve(path)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[sync_target] local create {} failed: {e}", parent.display()))?;
        }
        fs::write(&destination, bytes).map_err(|e| {
            format!(
                "[sync_target] local write {} failed: {e}",
                destination.display()
            )
        })?;
        // manifest 是提交点：写完必须读回比对 content_hash（写成功 ≠ 内容正确）。
        self.verify_manifest_write_back(path, bytes)
    }
}

// ── 目标收敛：三传输实现 → 一个 [`ConfiguredTarget`] ──────────────────────────

/// 由配置选出的传输目标（三种实现的枚举包装）。
///
/// 存在理由：`SyncTarget` 的 async 方法不可直接做 trait object，而调度器与命令层
/// 都需要「按配置选一个目标，然后走既有编排」。枚举 + 转发把选型收敛到一处，
/// 于是 `push_impl` / `pull_impl` 的调用方不再各自 `match endpoint`（此前
/// `sync_push` / `sync_pull` 各有一份重复分派）。
pub enum ConfiguredTarget {
    /// WebDAV 远端。
    WebDav(WebDavTarget),
    /// GitHub 私有仓。
    GitHub(GitHubTarget),
    /// 本地文件夹。
    Local(LocalFolderTarget),
}

impl SyncTarget for ConfiguredTarget {
    async fn list(&self, path: &str) -> Result<Vec<String>, String> {
        match self {
            ConfiguredTarget::WebDav(target) => target.list(path).await,
            ConfiguredTarget::GitHub(target) => target.list(path).await,
            ConfiguredTarget::Local(target) => target.list(path).await,
        }
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        match self {
            ConfiguredTarget::WebDav(target) => target.get(path).await,
            ConfiguredTarget::GitHub(target) => target.get(path).await,
            ConfiguredTarget::Local(target) => target.get(path).await,
        }
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        match self {
            ConfiguredTarget::WebDav(target) => target.put(path, bytes).await,
            ConfiguredTarget::GitHub(target) => target.put(path, bytes).await,
            ConfiguredTarget::Local(target) => target.put(path, bytes).await,
        }
    }
}

/// 按 `endpoint` 构造传输目标（配置期校验已在 [`load_config_file`] 内完成）。
pub fn build_target(file: &SyncConfigFile, project_path: &Path) -> Result<ConfiguredTarget, String> {
    if file.is_local() {
        let local = file.local.as_ref().ok_or_else(|| {
            "[sync_target] endpoint=local requires a local block {localPath}".to_string()
        })?;
        return Ok(ConfiguredTarget::Local(LocalFolderTarget::new(
            local,
            &file.credential_ref,
        )?));
    }
    if file.is_github() {
        let github = file.github.as_ref().ok_or_else(|| {
            "[sync_target] endpoint=github requires a github block".to_string()
        })?;
        return Ok(ConfiguredTarget::GitHub(
            GitHubTarget::new(github, &file.credential_ref)?.with_journal_root(project_path),
        ));
    }
    let config = file.transport_config();
    Ok(ConfiguredTarget::WebDav(WebDavTarget::new(
        &config.endpoint,
        &config.root,
        &config.credential_ref,
    )))
}

/// 按已启用配置推送导出产物（命令层与调度器共用同一入口）。
pub async fn push_configured(
    project_path: &Path,
    artifact_path: &Path,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPushResult, String> {
    let file = open_target_file(project_path)?;
    let target = build_target(&file, project_path)?;
    push_impl(&target, project_path, artifact_path, device_id, timestamp).await
}

/// 按已启用配置拉取（命令层与调度器共用同一入口；冲突 / journal 语义零改动）。
pub async fn pull_configured(
    project_path: &Path,
    manifest_id: &str,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPullResult, String> {
    let file = open_target_file(project_path)?;
    let target = build_target(&file, project_path)?;
    pull_impl(&target, project_path, manifest_id, device_id, timestamp).await
}

// ── 配置 / 守卫 / 版本裁决 / journal / 远端布局 / 结果 DTO ────────────────────

// M3-3：决策纯支撑层已剥离至 `sync_target_decision.rs`——增量剥离先例模式：新文件 + 原文件 re-export，外部 import 面零变化。
// 留守原文件：6 个 Tauri 命令（sync_configure/sync_test/sync_status/sync_push/sync_pull/sync_conflicts）、
// `status_impl` / `push_impl` / `pull_impl` / `conflicts_impl` 等 IO 执行层与 `WebDavTarget` 传输实现。
pub use super::sync_target_decision::{
    append_item_journal, append_journal, apply_item_decisions_impl, assert_local_target_allowed,
    assert_no_secret_plaintext, assert_remote_key_allowed, base_state_before, batch_id_of,
    batches_impl, decide_pull, local_revision, local_state, parse_remote_revision, read_journal,
    remote_revision_dir, validate_config, PullDecision,
    RevisionState, SyncBatch, SyncConfig, SyncConflict, SyncItemDecisionRequest,
    SyncItemDecisionResult, SyncItemRecord, SyncJournalEntry, SyncPullResult, SyncPushResult,
    SyncStatus, SyncTestResult, ITEM_STATUS_APPLIED, ITEM_STATUS_KEEP_BOTH,
    ITEM_STATUS_REFUSED,
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

/// 落盘配置形态：WebDAV 四字段 + 可选的 GitHub 传输块（G1 增量）+ 可选的本地文件夹
/// 传输块（G2a）+ 可选的后台调度块（G2a）。
///
/// 为什么不直接给决策层的 [`SyncConfig`] 加字段：那个结构带 `deny_unknown_fields`
/// 且被既有调用面按四字段构造/断言（`config_has_no_secret_plaintext`）。传输选型块
/// 放在**落盘形态**上，四字段语义与既有校验零变化；未知键仍被拒
/// （见 [`assert_config_no_secret_plaintext`]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncConfigFile {
    /// `"local"`（G2a 本地文件夹）、`"github"`（G1 私有仓目标）或 WebDAV 端点 URL。
    pub endpoint: String,
    /// WebDAV 根前缀；GitHub 传输下由 `github.pathPrefix` 承担、本地传输下由
    /// `local.localPath` 承担（本字段忽略）。
    pub root: String,
    /// 凭据引用（`nb:github:<account>` / `nb:webdav:<account>`）；**不是**凭据本体。
    /// 本地文件夹目标不需要凭据，配置期要求其为空串。
    pub credential_ref: String,
    /// 全局同步开关（`sync_enabled`）：关闭时调度器与一切自动触发全停。
    pub enabled: bool,
    /// G1：仅当 `endpoint == "github"` 时必填。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<GitHubConfig>,
    /// G2a：仅当 `endpoint == "local"` 时必填。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalFolderConfig>,
    /// G2a：后台调度间隔（未配置时按 [`SCHEDULE_DEFAULT_INTERVAL_MINUTES`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<SyncScheduleFile>,
}

/// 后台调度间隔档位（分钟）。三档是**契约**：配置期硬校验，越界档位直接拒收。
pub const SCHEDULE_INTERVAL_MINUTES: [u32; 3] = [15, 30, 60];

/// 默认调度间隔（未在配置里指定 `intervalMinutes` 时使用）。
pub const SCHEDULE_DEFAULT_INTERVAL_MINUTES: u32 = 15;

/// 后台调度块（G2a）。线上字段是 camelCase（`intervalMinutes`），同时接受
/// snake_case 别名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SyncScheduleFile {
    /// 间隔分钟数；只接受 [`SCHEDULE_INTERVAL_MINUTES`] 里的档位。
    #[serde(alias = "interval_minutes")]
    pub interval_minutes: u32,
}

/// 调度块校验（纯函数）：档位必须落在三档之内。
pub fn validate_schedule(schedule: &SyncScheduleFile) -> Result<(), String> {
    if SCHEDULE_INTERVAL_MINUTES.contains(&schedule.interval_minutes) {
        return Ok(());
    }
    Err(format!(
        "[sync_target] schedule interval_minutes must be one of {SCHEDULE_INTERVAL_MINUTES:?} (got {})",
        schedule.interval_minutes
    ))
}

impl SyncConfigFile {
    /// 由决策层四字段配置构造（WebDAV / 既有调用面）。
    ///
    /// 非测试构建下唯一调用者是 [`save_config`]；两者共同构成**四字段兼容入口**
    /// （`sync_configure` 现在走 [`save_config_file`]），保留给既有调用面与单测。
    #[allow(dead_code)]
    pub fn from_transport(config: &SyncConfig) -> Self {
        SyncConfigFile {
            endpoint: config.endpoint.clone(),
            root: config.root.clone(),
            credential_ref: config.credential_ref.clone(),
            enabled: config.enabled,
            github: None,
            local: None,
            schedule: None,
        }
    }

    /// 决策层视图。
    ///
    /// GitHub 传输下 `root` 报 `pathPrefix`、本地文件夹传输下 `root` 报 `localPath`
    /// ——状态出口（[`SyncStatus`]）只有 `root` 一个前缀字段，让 UI 看到**有效**
    /// 目标，而不是一个永远为空的 WebDAV 残留。
    pub fn transport_config(&self) -> SyncConfig {
        let root = if self.is_github() {
            self.github
                .as_ref()
                .map(|github| github.path_prefix.trim().trim_matches('/').to_string())
                .unwrap_or_default()
        } else if self.is_local() {
            self.local
                .as_ref()
                .map(|local| local.local_path.trim().to_string())
                .unwrap_or_default()
        } else {
            self.root.clone()
        };
        SyncConfig {
            endpoint: self.endpoint.trim().to_string(),
            root,
            credential_ref: self.credential_ref.trim().to_string(),
            enabled: self.enabled,
        }
    }

    /// 是否选择了 GitHub 传输目标。
    pub fn is_github(&self) -> bool {
        is_github_endpoint(&self.endpoint)
    }

    /// 是否选择了本地文件夹传输目标。
    pub fn is_local(&self) -> bool {
        is_local_endpoint(&self.endpoint)
    }

    /// 调度间隔（分钟）：显式配置优先，否则默认档。
    pub fn interval_minutes(&self) -> u32 {
        self.schedule
            .as_ref()
            .map(|schedule| schedule.interval_minutes)
            .unwrap_or(SCHEDULE_DEFAULT_INTERVAL_MINUTES)
    }
}

/// 落盘配置校验（纯函数）：按 `endpoint` 分流到 WebDAV / GitHub / 本地三套规则。
pub fn validate_config_file(file: &SyncConfigFile) -> Result<(), String> {
    if file.is_local() {
        let local = file.local.as_ref().ok_or_else(|| {
            "[sync_target] endpoint=local requires a local block {localPath}".to_string()
        })?;
        if file.github.is_some() {
            return Err(
                "[sync_target] a github block is only valid when endpoint=github".to_string(),
            );
        }
        validate_local_config(local, &file.credential_ref)?;
    } else if file.is_github() {
        if file.local.is_some() {
            return Err(
                "[sync_target] a local block is only valid when endpoint=local".to_string(),
            );
        }
        let github = file.github.as_ref().ok_or_else(|| {
            "[sync_target] endpoint=github requires a github block {owner, repo, branch, pathPrefix}"
                .to_string()
        })?;
        validate_github_config(github, &file.credential_ref)?;
    } else {
        if file.github.is_some() {
            return Err(
                "[sync_target] a github block is only valid when endpoint=github".to_string(),
            );
        }
        if file.local.is_some() {
            return Err(
                "[sync_target] a local block is only valid when endpoint=local".to_string(),
            );
        }
        validate_config(&file.transport_config())?;
    }
    if let Some(schedule) = file.schedule.as_ref() {
        validate_schedule(schedule)?;
    }
    Ok(())
}

/// 配置 JSON 的无明文断言（G2a 版）：既有四字段走决策层原断言；带 `github` /
/// `local` / `schedule` 块时额外把子键限死（任何密钥材料字段名一律拒收）。
pub fn assert_config_no_secret_plaintext(raw_json: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(raw_json)
        .map_err(|e| format!("[sync_target] config is not valid JSON: {e}"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| "[sync_target] config must be a JSON object".to_string())?;
    let has_block = ["github", "local", "schedule"]
        .iter()
        .any(|key| object.contains_key(*key));
    if !has_block {
        // 既有四字段配置：直接复用决策层断言（零重复）。
        return assert_no_secret_plaintext(raw_json);
    }
    for key in object.keys() {
        if ![
            "endpoint",
            "root",
            "credential_ref",
            "enabled",
            "github",
            "local",
            "schedule",
        ]
        .contains(&key.as_str())
        {
            return Err(format!(
                "[sync_target] config key '{key}' is not allowed (only endpoint/root/credential_ref/enabled/github/local/schedule)"
            ));
        }
    }
    if let Some(github) = object.get("github") {
        let github = github
            .as_object()
            .ok_or_else(|| "[sync_target] config key 'github' must be an object".to_string())?;
        for key in github.keys() {
            if !["owner", "repo", "branch", "pathPrefix"].contains(&key.as_str()) {
                return Err(format!(
                    "[sync_target] github config key '{key}' is not allowed (only owner/repo/branch/pathPrefix)"
                ));
            }
        }
    }
    if let Some(local) = object.get("local") {
        let local = local
            .as_object()
            .ok_or_else(|| "[sync_target] config key 'local' must be an object".to_string())?;
        for key in local.keys() {
            if !["localPath"].contains(&key.as_str()) {
                return Err(format!(
                    "[sync_target] local config key '{key}' is not allowed (only localPath)"
                ));
            }
        }
    }
    if let Some(schedule) = object.get("schedule") {
        let schedule = schedule
            .as_object()
            .ok_or_else(|| "[sync_target] config key 'schedule' must be an object".to_string())?;
        for key in schedule.keys() {
            if !["intervalMinutes"].contains(&key.as_str()) {
                return Err(format!(
                    "[sync_target] schedule config key '{key}' is not allowed (only intervalMinutes)"
                ));
            }
        }
    }
    Ok(())
}

/// 读取配置（缺失返回 None；存在但非法则报错，不静默降级）。
pub fn load_config(project_path: &Path) -> Result<Option<SyncConfig>, String> {
    Ok(load_config_file(project_path)?.map(|file| file.transport_config()))
}

/// 读取落盘配置（保留 `github` 块；传输执行层需要它来构造目标）。
pub fn load_config_file(project_path: &Path) -> Result<Option<SyncConfigFile>, String> {
    let path = project_path.join(SYNC_CONFIG_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("[sync_target] read config failed: {e}"))?;
    assert_config_no_secret_plaintext(&raw)?;
    let file: SyncConfigFile = serde_json::from_str(&raw)
        .map_err(|e| format!("[sync_target] parse config failed: {e}"))?;
    validate_config_file(&file)?;
    Ok(Some(file))
}

/// 写入配置（先经无明文断言与结构校验）。
///
/// 四字段兼容入口：`sync_configure` 现在统一走 [`save_config_file`]（需要保留
/// `github` 块），本函数保留给「只有四字段」的调用面与既有单测。
#[allow(dead_code)]
pub fn save_config(project_path: &Path, config: &SyncConfig) -> Result<(), String> {
    save_config_file(project_path, &SyncConfigFile::from_transport(config))
}

/// 写入落盘配置（含 `github` 块；先经无明文断言与结构校验）。
pub fn save_config_file(project_path: &Path, file: &SyncConfigFile) -> Result<(), String> {
    validate_config_file(file)?;
    let encoded = serde_json::to_string_pretty(file)
        .map_err(|e| format!("[sync_target] encode config failed: {e}"))?;
    assert_config_no_secret_plaintext(&encoded)?;
    let path = project_path.join(SYNC_CONFIG_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[sync_target] create config dir failed: {e}"))?;
    }
    fs::write(&path, encoded).map_err(|e| format!("[sync_target] write config failed: {e}"))
}

// ── Tauri commands：配置 / 测试 / 状态 ─────────────────────────────────────

/// 保存云端备份配置。
///
/// `endpoint == "github"` 时 payload 为 `{endpoint, root, credential_ref, enabled,
/// github: {owner, repo, branch, pathPrefix}}`；`credential_ref` 必须是
/// `nb:github:<account>`，否则**配置期**即拒绝（[`validate_github_config`]）。
#[tauri::command]
pub async fn sync_configure(project_path: String, config: SyncConfigFile) -> Result<(), String> {
    save_config_file(Path::new(&project_path), &config)
}

/// 读回落盘配置（含 `github` / `local` / `schedule` 块）。
///
/// 为什么需要这个出口：`sync_status` 只报有效前缀（`root`），不足以让 UI 编辑
/// GitHub 的 owner/repo/branch 或本地文件夹路径。本命令把落盘形态原样返回，
/// 且**仍经完整校验**（非法配置不静默降级，直接报错）。
///
/// G2a：`endpoint == "local"` 的 payload 为 `{endpoint, root, credential_ref: "",
/// enabled, local: {localPath}}`——`localPath` 必须是绝对路径且不含 `..`，
/// 凭据引用必须为空串（[`validate_local_config`]）。`schedule: {intervalMinutes}`
/// 可选，只接受 15 / 30 / 60 三档（[`validate_schedule`]）。
#[tauri::command]
pub async fn sync_config_read(project_path: String) -> Result<Option<SyncConfigFile>, String> {
    load_config_file(Path::new(&project_path))
}

/// 连接测试。凭据不可用时**不降级**：直接回报不可用并要求关闭该目标。
#[tauri::command]
pub async fn sync_test(project_path: String) -> Result<SyncTestResult, String> {
    let project = Path::new(&project_path);
    let Some(file) = load_config_file(project)? else {
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
    // 凭据库探针（G1）：`secret_available` / `store_status` 门禁先行。
    let credential_available = store_status_sync() && is_available_sync();
    if file.is_local() {
        let local = file.local.as_ref().ok_or_else(|| {
            "[sync_target] endpoint=local requires a local block".to_string()
        })?;
        return local_test(local, &file.credential_ref).await;
    }
    if file.is_github() {
        let github = file.github.as_ref().ok_or_else(|| {
            "[sync_target] endpoint=github requires a github block".to_string()
        })?;
        return github_test(project, github, &file.credential_ref, credential_available).await;
    }
    let config = file.transport_config();
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

/// GitHub 目标的连接测试（凭据库不可用时**返回降级文案并记 journal**，不裸抛）。
async fn github_test(
    project_path: &Path,
    github: &GitHubConfig,
    credential_ref: &str,
    credential_available: bool,
) -> Result<SyncTestResult, String> {
    let base = SyncTestResult {
        ok: false,
        endpoint: GITHUB_ENDPOINT.to_string(),
        root: github.path_prefix.trim().trim_matches('/').to_string(),
        credential_available,
        reachable: false,
        object_count: 0,
        message: String::new(),
    };
    if !credential_available {
        // A1 降级：凭据库不可用 → 返回**可读降级文案**并记 journal，不裸抛平台错误。
        let message = match secret_store::github_store_probe() {
            secret_store::CredentialProbe::Degraded(message) => message,
            // 探针与布尔门禁不同源时（探测间竞态）仍不静默：退回通用降级文案。
            secret_store::CredentialProbe::Available => {
                secret_store::github_store_degraded_message()
            }
        };
        append_transport_journal(
            Some(project_path),
            "credential_degraded",
            "sync_test",
            None,
            &message,
        )?;
        return Ok(SyncTestResult { message, ..base });
    }
    let target = GitHubTarget::new(github, credential_ref)?.with_journal_root(project_path);
    match target.list("").await {
        Ok(objects) => Ok(SyncTestResult {
            ok: true,
            reachable: true,
            object_count: objects.len(),
            message: "[sync_target] github reachable".to_string(),
            ..base
        }),
        Err(reason) => Ok(SyncTestResult {
            message: reason,
            ..base
        }),
    }
}

/// 本地文件夹目标的连接测试：本地目标**不需要凭据**，所以 `credential_available`
/// 恒为 true（不把「凭据库不可用」误报成本地目标不可用）。
async fn local_test(
    local: &LocalFolderConfig,
    credential_ref: &str,
) -> Result<SyncTestResult, String> {
    let root = validate_local_config(local, credential_ref)?;
    let target = LocalFolderTarget::at_root(root.clone());
    let exists = root.is_dir();
    let creatable = root.parent().map(|parent| parent.is_dir()).unwrap_or(false);
    let object_count = if exists {
        target.list("").await.map(|objects| objects.len()).unwrap_or(0)
    } else {
        0
    };
    let (ok, message) = if exists {
        (true, "[sync_target] local folder reachable".to_string())
    } else if creatable {
        (
            true,
            "[sync_target] local folder does not exist yet; it will be created on the first push"
                .to_string(),
        )
    } else {
        (
            false,
            format!(
                "[sync_target] local folder parent does not exist: {}",
                root.display()
            ),
        )
    };
    Ok(SyncTestResult {
        ok,
        endpoint: LOCAL_ENDPOINT.to_string(),
        root: root.to_string_lossy().replace('\\', "/"),
        credential_available: true,
        reachable: exists,
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
    let timestamp = now_ts();
    push_configured(
        Path::new(&project_path),
        Path::new(&artifact_path),
        &device_id,
        &timestamp,
    )
    .await
}

/// [`sync_push`] 的同步实现（目标可注入，便于测试）。
///
/// **互斥**：入口即尝试取得该项目的同步互斥权（F-009）。推送 / 拉取共用同一把锁，
/// 所以手动同步与后台调度不会在同一项目上并发改暂存目录 / revision 水位 / journal。
pub async fn push_impl<T: SyncTarget>(
    target: &T,
    project_path: &Path,
    artifact_path: &Path,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPushResult, String> {
    let _guard = try_acquire_sync_run(project_path)?;
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

    // 暂存目录不可碰撞：时间戳只到秒，加 pid + 进程内序号（即使互斥失效/跨进程也不撞）。
    let staging = project_path.join(format!(".sync-staging-{}", unique_run_token(timestamp)));
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

    let started = std::time::Instant::now();
    let manifest = archive::build_manifest(staging)?;
    archive::pack_blocks(staging, &manifest, staging)?;

    // G2b 基线指针：本次推送所基于的**本地态**（首次推送 → rev 0 且无指纹）。
    let base = local_state(project_path, manifest_id);
    let base_content_hash = if base.content_hash.is_empty() {
        None
    } else {
        Some(base.content_hash.clone())
    };

    // F-010：内容未变则**不抬版本、不重传、不写 journal**。
    //
    // 为什么先算指纹再决定：导出产物通常每 15 分钟没变，无条件 push 会让远端 rev 号与
    // 本地 snapshots 目录按周期线性增长（一天 96 个完整副本 + 96 次 GitHub commit）。
    // 判据用 manifest 的内容指纹（= 块内容聚合），不是 zip 字节（zip 带时间戳，
    // 字节变了不代表内容变了）。此时还没写过任何远端对象，直接返回是安全的。
    if base.revision > 0 && !base.content_hash.is_empty() && base.content_hash == manifest.content_digest {
        return Ok(SyncPushResult {
            manifest_id: manifest_id.to_string(),
            revision: base.revision,
            content_hash: manifest.content_digest.clone(),
            block_count: manifest.blocks.len(),
            total_bytes: 0,
            remote_prefix: remote_revision_dir(manifest_id, base.revision),
            unchanged: true,
        });
    }

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

    // G2b：推送成功后回填 base 指针（`base_rev` / `base_content_hash`）。
    append_journal(
        project_path,
        &SyncJournalEntry {
            manifest_id: manifest_id.to_string(),
            revision,
            device_id: device_id.to_string(),
            direction: "push".to_string(),
            ts: timestamp.to_string(),
            content_hash: manifest.content_digest.clone(),
            base_rev: Some(base.revision),
            base_content_hash,
        },
    )?;

    // G2b 批次明细：推送的唯一同步对象就是该产物文件（逐项落账）。
    append_item_journal(
        project_path,
        &SyncItemRecord {
            batch_id: batch_id_of(manifest_id, timestamp, "push"),
            manifest_id: manifest_id.to_string(),
            revision,
            direction: "push".to_string(),
            ts: timestamp.to_string(),
            device_id: device_id.to_string(),
            path: file_name.to_string(),
            status: ITEM_STATUS_APPLIED.to_string(),
            duration_ms: started.elapsed().as_millis() as u64,
            error: None,
            decision: None,
            actor: None,
            decided_at: None,
        },
    )?;

    Ok(SyncPushResult {
        manifest_id: manifest_id.to_string(),
        revision,
        content_hash: manifest.content_digest.clone(),
        block_count: manifest.blocks.len(),
        total_bytes,
        remote_prefix: prefix,
        unchanged: false,
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
    let timestamp = now_ts();
    pull_configured(
        Path::new(&project_path),
        &manifest_id,
        &device_id,
        &timestamp,
    )
    .await
}

/// [`sync_pull`] 的同步实现（目标可注入）。
///
/// **互斥**：与 [`push_impl`] 共用同一把项目级锁（F-009）。
pub async fn pull_impl<T: SyncTarget>(
    target: &T,
    project_path: &Path,
    manifest_id: &str,
    device_id: &str,
    timestamp: &str,
) -> Result<SyncPullResult, String> {
    let _guard = try_acquire_sync_run(project_path)?;
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

    // F-010：远端版本与本地一致、且该版本的快照目录已存在（已入库过）→ 什么都不做。
    //
    // 为什么要求“快照已存在”：首次周期 push 后本地尚无该 rev 的快照，那次拉取必须
    // 真的落地（拉回快照入库是设计行为）；只有**重复**拉同一个 rev 才是冗余拷贝。
    // 这一层跳过同时免掉了全量块下载（命中时一个块都不取）。
    let local = local_state(project_path, manifest_id);
    let snapshot_present = project_path
        .join(".novel/snapshots")
        .join(format!("remote-{manifest_id}-rev-{remote_revision}"))
        .is_dir();
    if snapshot_present
        && local.revision == remote_revision
        && local.content_hash == manifest.content_digest
    {
        return Ok(SyncPullResult {
            manifest_id: manifest_id.to_string(),
            remote_revision,
            decision: "unchanged".to_string(),
            snapshot_dir: None,
            conflict_path: None,
            message:
                "[sync_target] remote revision matches the local state and is already snapshotted; nothing to do"
                    .to_string(),
        });
    }

    // 远端任一副本皆非真值 → 逐块校验后才落地。
    // 暂存目录不可碰撞：时间戳只到秒，加 pid + 进程内序号（F-009）。
    let remote_staging = project_path.join(format!(".sync-pull-{}", unique_run_token(timestamp)));
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
    // G2b 基线指针：本批次所基于的上一版本（无更早记录 → 无 base，不编造）。
    let base = base_state_before(project_path, manifest_id, remote_revision);
    let base_rev = base.as_ref().map(|state| state.revision);
    let base_content_hash = base.as_ref().map(|state| state.content_hash.clone());
    let started = std::time::Instant::now();
    match decide_pull(&local, &remote, device_id, timestamp)? {
        PullDecision::RefuseStale { local, remote } => {
            // direction = `refused`（**不是** `conflict`）：这是「远端更旧、本地新态被保留」，
            // 从未做过三路展开、也不存在 `.conflict-<device>-<ts>` 副本目录。
            // 旧实现写成 conflict → batch_status 无条件返回 keep_both，refused 永不
            // 可达，且 batches_impl 会把一个没有 theirs 侧的批次当冲突做三路展开。
            append_journal(
                project_path,
                &SyncJournalEntry {
                    manifest_id: manifest_id.to_string(),
                    revision: remote,
                    device_id: device_id.to_string(),
                    direction: "refused".to_string(),
                    ts: timestamp.to_string(),
                    content_hash: manifest.content_digest.clone(),
                    base_rev,
                    base_content_hash: base_content_hash.clone(),
                },
            )?;
            record_pull_items(
                project_path,
                manifest_id,
                remote,
                "refused",
                device_id,
                timestamp,
                manifest,
                ITEM_STATUS_REFUSED,
                started.elapsed().as_millis() as u64,
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
                    base_rev,
                    base_content_hash: base_content_hash.clone(),
                },
            )?;
            // G2b：冲突批次的逐项明细（远端侧 = 刚落的冲突副本）。
            record_pull_items(
                project_path,
                manifest_id,
                remote_revision,
                "conflict",
                device_id,
                timestamp,
                manifest,
                ITEM_STATUS_KEEP_BOTH,
                started.elapsed().as_millis() as u64,
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
                    base_rev,
                    base_content_hash: base_content_hash.clone(),
                },
            )?;
            record_pull_items(
                project_path,
                manifest_id,
                remote_revision,
                "pull",
                device_id,
                timestamp,
                manifest,
                ITEM_STATUS_APPLIED,
                started.elapsed().as_millis() as u64,
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

/// G2b：把一批「拉取载荷」的逐项明细落账（manifest + 每个内容块）。
///
/// 逐项状态与耗时逐项独立（内容块本身不单独计时 → `0`；批次总耗时由调用方汇总）；
/// 逐项 journal 与传输 journal 分文件，绝不污染 `local_state` 的版本水位。
#[allow(clippy::too_many_arguments)]
fn record_pull_items(
    project_path: &Path,
    manifest_id: &str,
    revision: u64,
    direction: &str,
    device_id: &str,
    timestamp: &str,
    manifest: &archive::ArchiveManifest,
    status: &str,
    duration_ms: u64,
) -> Result<(), String> {
    // 方向入批次键：同一 ts 下 push / pull / refused / conflict 是不同批次（F-002）。
    let batch_id = batch_id_of(manifest_id, timestamp, direction);
    let record = |path: String, status: &str, duration_ms: u64| -> Result<(), String> {
        append_item_journal(
            project_path,
            &SyncItemRecord {
                batch_id: batch_id.clone(),
                manifest_id: manifest_id.to_string(),
                revision,
                direction: direction.to_string(),
                ts: timestamp.to_string(),
                device_id: device_id.to_string(),
                path,
                status: status.to_string(),
                duration_ms,
                error: None,
                decision: None,
                actor: None,
                decided_at: None,
            },
        )
    };
    record(REMOTE_MANIFEST_FILE.to_string(), status, duration_ms)?;
    for block in &manifest.blocks {
        record(
            format!("{REMOTE_BLOCKS_DIR}/{}", block.hash),
            status,
            0,
        )?;
    }
    Ok(())
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

/// 批次明细默认回看批数（UI 首屏足够；超过即截断，不扫全部历史）。
pub const BATCH_DETAIL_LIMIT: usize = 20;

// ── 批次明细与逐项裁决（G2b） ───────────────────────────────────────────────

/// 批次明细：逐批次返回传输结果 + 逐项结果（含双改项的 base 语义）。
///
/// 只读：不写 journal、不改任何落盘物。老批次缺 `base_rev` / `base_content_hash`
/// → `base_available = false`（**不迁移、不重写历史批次**）。
#[tauri::command]
pub async fn sync_batches(project_path: String) -> Result<Vec<SyncBatch>, String> {
    batches_impl(Path::new(&project_path), BATCH_DETAIL_LIMIT)
}

/// 逐项裁决落盘（pick-and-apply）：每项独立落盘 + 回写逐项 journal。
///
/// - 默认裁决恒为 `keep_both`；`pick_mine` / `pick_theirs` 必须显式传入且带 `actor`。
/// - 无 base 指针的批次只接受 `keep_both`（无 base 禁覆盖）。
/// - 任一单项失败不滚整体：其余项继续，失败项标 `error` 可原样重试。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_apply_per_item_decision(
    project_path: String,
    manifest_id: String,
    revision: u64,
    direction: String,
    ts: String,
    device_id: String,
    actor: String,
    items: Vec<SyncItemDecisionRequest>,
) -> Result<Vec<SyncItemDecisionResult>, String> {
    apply_item_decisions_impl(
        Path::new(&project_path),
        &manifest_id,
        revision,
        &direction,
        &ts,
        &device_id,
        &actor,
        &items,
        &now_ts(),
    )
}

/// 打开已启用的传输目标配置（缺失/未启用即报错，不静默降级）。
fn open_target_file(project_path: &Path) -> Result<SyncConfigFile, String> {
    let file = load_config_file(project_path)?
        .ok_or_else(|| "[sync_target] cloud backup is not configured".to_string())?;
    if !file.enabled {
        return Err("[sync_target] cloud backup target is disabled".to_string());
    }
    Ok(file)
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

// ── 同步周期互斥（F-009） ─────────────────────────────────────────────────
//
// 为什么需要它：推送 / 拉取的暂存目录、revision 水位（`local_revision + 1`）与 journal
// 追加都是**项目级**共享写面。手动「立即同步」（`sync_now`）与后台调度（`scheduler_loop`）
// 各自取秒级时间戳、互不感知 —— 同一秒内两次触发会：① 同一暂存目录被对方的
// `remove_dir_all` 清空；② 同一 `rev-N+1` 被写两遍（后写覆盖先写）；③ 一方的 manifest
// 指向另一方已删的 block。两个按钮（同步面板 / 设置页）各一个，重叠是正常使用路径。
//
// 语义：**按项目路径**的进程级互斥（不排队，忙即返回可读错误）。调度器与手动同步
// 用同一个 key（项目路径）→ 共用同一把锁；不同项目之间无共享写面，不应被串行化。

/// 互斥表：项目路径 → 占用标志。
fn sync_run_locks() -> &'static Mutex<HashMap<PathBuf, Arc<AtomicBool>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<AtomicBool>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 同步周期互斥守卫（`Drop` 即释放；不持任何跨 await 的 std 锁）。
pub struct SyncRunGuard {
    flag: Arc<AtomicBool>,
}

impl Drop for SyncRunGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

/// 尝试取得该项目的同步互斥权（已被占用 → Err，调用方自行决定是忙返回还是重试）。
pub fn try_acquire_sync_run(project_path: &Path) -> Result<SyncRunGuard, String> {
    // 规范化路径：同一项目经不同写法（相对 / 绝对 / 符号链接）必须落到同一把锁。
    let key = fs::canonicalize(project_path).unwrap_or_else(|_| project_path.to_path_buf());
    let flag = {
        let mut locks = sync_run_locks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(
            locks
                .entry(key)
                .or_insert_with(|| Arc::new(AtomicBool::new(false))),
        )
    };
    if flag
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(
            "[sync_target] another sync cycle is already running for this project; retry after it finishes"
                .to_string(),
        );
    }
    Ok(SyncRunGuard { flag })
}

/// 暂存目录后缀：时间戳 + pid + 进程内序号 → **不可碰撞**。
///
/// 时间戳只到秒：同一秒内两次推送（即使互斥失效、或另一个进程）也不能共用目录。
fn unique_run_token(timestamp: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}-{}-{}",
        sanitize_token(timestamp),
        std::process::id(),
        seq
    )
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
            base_rev: None,
            base_content_hash: None,
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

            // F-010：内容指纹没变 → 不抬版本、不重传（幂等）。
            let again = push_impl(
                &target,
                &project.root,
                &artifact,
                "device-a",
                "20260912140100",
            )
            .await
            .expect("push again");
            assert!(again.unchanged, "identical content must not create a new revision");
            assert_eq!(again.revision, 1);
            assert_eq!(again.total_bytes, 0, "unchanged push must upload nothing");

            // 内容真的变了才抬版本（单调性只在真实内容变化时成立）。
            let artifact_v2 = project.write(
                "backups/auto/20260912-artifact.zip",
                b"artifact-bytes-v2-changed",
            );
            let bumped = push_impl(
                &target,
                &project.root,
                &artifact_v2,
                "device-a",
                "20260912140200",
            )
            .await
            .expect("push v2");
            assert!(!bumped.unchanged);
            assert_eq!(bumped.revision, 2, "revision must be monotonic on content change");
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

    // ── G1：GitHub 私有仓传输目标 ────────────────────────────────────────────

    fn github_fixture() -> GitHubConfig {
        GitHubConfig {
            owner: "niko".to_string(),
            repo: "novel-backups".to_string(),
            branch: "main".to_string(),
            path_prefix: "backups/qmai".to_string(),
        }
    }


    // ── G1 真机验收：真实私有仓三原语往返 ──────────────────────────────────
    //
    // 目的：证明 GitHubTarget 的 contents API（≤1MiB）与 Git Data API（>1MiB）
    // 两条传输路径在真实私有仓上可用，而不只是 mock 通过。
    //
    // 运行方式（默认 ignore，CI 不联网）：
    //   NIKO_GITHUB_LIVE_TOKEN=$(gh auth token)     //   NIKO_GITHUB_LIVE_OWNER=Smith-106     //   NIKO_GITHUB_LIVE_REPO=niko-sync-probe     //     cargo test --manifest-path src-tauri/Cargo.toml github_live_push_pull_roundtrip -- --ignored --nocapture
    //
    // 该测试会临时把 token 写入系统钥匙串的 `nb:github:<owner>` 域（应用真实读取
    // 路径），结束后删除该条目；不会留下明文。
    #[tokio::test]
    #[ignore = "live: needs NIKO_GITHUB_LIVE_TOKEN + throwaway private repo"]
    async fn github_live_push_pull_roundtrip() {
        let token = std::env::var("NIKO_GITHUB_LIVE_TOKEN")
            .expect("NIKO_GITHUB_LIVE_TOKEN must be set for the live test");
        let owner = std::env::var("NIKO_GITHUB_LIVE_OWNER").unwrap_or_else(|_| "Smith-106".to_string());
        let repo = std::env::var("NIKO_GITHUB_LIVE_REPO").unwrap_or_else(|_| "niko-sync-probe".to_string());

        // 凭据写入应用真实读取的域：service=nb:github，account 已绑定本机设备指纹
        // （`<device_binding_prefix>:<logical>`，见 secret_store::bind_account）。
        let bound_account = format!(
            "{}:{}",
            crate::commands::secret_store::device_binding_prefix(),
            owner
        );
        let entry = keyring::Entry::new("nb:github", &bound_account).expect("keyring entry");
        entry.set_password(&token).expect("store live token in keyring");

        let credential_ref = format!("nb:github:{owner}");
        let config = GitHubConfig {
            owner: owner.clone(),
            repo: repo.clone(),
            branch: "main".to_string(),
            path_prefix: "probe".to_string(),
        };

        let target = GitHubTarget::new(&config, &credential_ref).expect("GitHubTarget::new");

        // ① ≤1MiB：contents API 单 PUT
        let small = b"{\"probe\":\"small\"}".to_vec();
        target
            .put("small.json", &small)
            .await
            .expect("put small (contents API)");
        let got_small = target.get("small.json").await.expect("get small");
        assert_eq!(got_small, small, "small file roundtrip must be byte-identical");

        // ② >1MiB：Git Data API（blob → tree → commit → ref）
        let big = vec![b'x'; 1_200_000];
        target
            .put("big.bin", &big)
            .await
            .expect("put big (Git Data API)");
        let got_big = target.get("big.bin").await.expect("get big");
        assert_eq!(got_big.len(), big.len(), "big file length must match");
        assert_eq!(got_big, big, "big file roundtrip must be byte-identical");

        // ③ list：两个对象都在
        let keys = target.list("").await.expect("list");
        assert!(keys.iter().any(|k| k.ends_with("small.json")), "list must contain small.json: {keys:?}");
        assert!(keys.iter().any(|k| k.ends_with("big.bin")), "list must contain big.bin: {keys:?}");

        // 清理钥匙串条目
        let _ = entry.delete_credential();
        println!("G1 live roundtrip OK: {} object(s) in {}/{}", keys.len(), owner, repo);
    }

    #[test]
    fn github_config_gate_rejects_foreign_credential_domain() {
        let github = github_fixture();
        validate_github_config(&github, "nb:github:niko").expect("nb:github: ref accepted");
        // 跨域复用被拒（配置期，不等推送时 401）。
        for bad in ["nb:webdav:niko", "nb:githubx:niko", "ghp_plaintext", ""] {
            assert!(
                validate_github_config(&github, bad).is_err(),
                "credential_ref must be rejected at configure time: {bad}"
            );
        }
        // 结构校验：owner/repo/branch/pathPrefix。
        for broken in [
            GitHubConfig {
                owner: "".to_string(),
                ..github.clone()
            },
            GitHubConfig {
                repo: "bad/repo".to_string(),
                ..github.clone()
            },
            GitHubConfig {
                branch: "../evil".to_string(),
                ..github.clone()
            },
            GitHubConfig {
                path_prefix: "/abs".to_string(),
                ..github.clone()
            },
            GitHubConfig {
                path_prefix: "a/../b".to_string(),
                ..github.clone()
            },
        ] {
            assert!(
                validate_github_config(&broken, "nb:github:niko").is_err(),
                "invalid github config must be rejected: {broken:?}"
            );
        }
        // 端点字面量（大小写/空白不敏感）。
        assert!(is_github_endpoint("github"));
        assert!(is_github_endpoint(" GitHub "));
        assert!(!is_github_endpoint("https://dav.example.com"));
        assert!(!is_github_endpoint(""));
    }

    #[test]
    fn github_transfer_selection_is_locked_at_one_mib() {
        // R1 阈值是具名常量（改它等于改传输契约）。
        assert_eq!(CONTENTS_API_MAX_BYTES, 1024 * 1024);
        assert_eq!(choose_transfer_path(0), TransferPath::ContentsApi);
        assert_eq!(
            choose_transfer_path(CONTENTS_API_MAX_BYTES),
            TransferPath::ContentsApi
        );
        assert_eq!(
            choose_transfer_path(CONTENTS_API_MAX_BYTES + 1),
            TransferPath::GitDataApi
        );
        // 备份 zip 级别的体积必须走 Git Data API。
        assert_eq!(choose_transfer_path(8 * 1024 * 1024), TransferPath::GitDataApi);
    }

    #[test]
    fn github_status_mapping_and_token_redaction() {
        // 成功码不产生错误。
        assert!(classify_status(200, None, None, "", "ctx").is_ok());
        assert!(classify_status(201, None, None, "", "ctx").is_ok());

        // 403 限流（remaining=0）→ 可重试 + 带 reset。
        let limited = classify_status(403, Some("0"), Some("1735689600"), "", "put x")
            .expect_err("403 must fail");
        assert!(limited.retryable, "rate limited must be retryable");
        assert_eq!(limited.rate_limit_reset.as_deref(), Some("1735689600"));
        assert!(limited.message.contains("retryable=true"));
        assert!(
            limited.message.contains("x-ratelimit-reset=1735689600"),
            "journal/message must carry the reset: {}",
            limited.message
        );

        // 二级限流（403 + 响应体提示）同样可重试。
        let secondary = classify_status(
            403,
            Some("42"),
            None,
            "You have exceeded a secondary rate limit",
            "put x",
        )
        .expect_err("403 must fail");
        assert!(secondary.retryable);
        assert!(secondary.message.contains("retryable=true"));

        // 429 → 可重试。
        let too_many =
            classify_status(429, None, Some("1735689600"), "", "put x").expect_err("429");
        assert!(too_many.retryable);
        assert!(too_many.message.contains("retryable=true"));

        // 401 / 404 → 直接失败，提示 token 权限与仓名。
        let unauthorized = classify_status(401, None, None, "", "put x").expect_err("401");
        assert!(!unauthorized.retryable);
        assert!(unauthorized.message.contains("token"));
        assert!(unauthorized.message.contains("'repo' scope"));
        let missing = classify_status(404, None, None, "", "put x").expect_err("404");
        assert!(!missing.retryable);
        assert!(missing.message.contains("owner/repo"));

        // 并发冲突 / 非快进 / 5xx → 可重试。
        assert!(classify_status(409, None, None, "", "ctx")
            .expect_err("409")
            .retryable);
        assert!(classify_status(422, None, None, "", "ctx")
            .expect_err("422")
            .retryable);
        assert!(classify_status(503, None, None, "", "ctx")
            .expect_err("503")
            .retryable);

        // token 永不进错误文案（分类只吃状态码 / 限流头 / 上下文）。
        let secret = "ghp_must_not_leak";
        for error in [&limited, &unauthorized, &missing] {
            assert!(!error.message.contains(secret));
            assert!(!error.message.contains("Bearer"));
        }
    }

    #[test]
    fn github_manifest_write_back_is_verified() {
        let manifest = serde_json::json!({
            "schema_version": 1,
            "id": "x",
            "version": "1",
            "created_at": "2026-01-01T00:00:00Z",
            "blocks": [],
            "content_digest": "a".repeat(64),
        });
        let written = serde_json::to_vec(&manifest).expect("encode");
        verify_manifest_digest(&written, &written).expect("identical digest passes");

        // 写后读回指纹不同 → 硬失败（不能把不一致当成功）。
        let mut tampered = manifest.clone();
        tampered["content_digest"] = serde_json::Value::String("b".repeat(64));
        let tampered_bytes = serde_json::to_vec(&tampered).expect("encode");
        let mismatch = verify_manifest_digest(&written, &tampered_bytes)
            .expect_err("digest mismatch must fail");
        assert!(mismatch.contains("content_hash mismatch"));

        // 没有 content_digest 的载荷不能冒充 manifest。
        assert!(verify_manifest_digest(b"{}", b"{}").is_err());
    }

    #[test]
    fn github_paths_and_transport_journal() {
        let github = github_fixture();
        let target = GitHubTarget::new(&github, "nb:github:niko").expect("target");
        assert_eq!(
            target.api_url("/contents/x"),
            "https://api.github.com/repos/niko/novel-backups/contents/x"
        );
        assert_eq!(
            target.remote_path("demo/rev-1/manifest.json"),
            "backups/qmai/demo/rev-1/manifest.json"
        );
        assert_eq!(
            target.relative_key("backups/qmai/demo/rev-1/manifest.json"),
            Some("demo/rev-1/manifest.json".to_string())
        );
        // 前缀之外的条目不得被当成本目标的对象。
        assert_eq!(target.relative_key("other/demo"), None);
        assert_eq!(target.relative_key("backups/qmai-other/x"), None);

        // 空 pathPrefix → 键就是仓库根相对路径。
        let root_target = GitHubTarget::new(
            &GitHubConfig {
                path_prefix: String::new(),
                ..github.clone()
            },
            "nb:github:niko",
        )
        .expect("target");
        assert_eq!(
            root_target.remote_path("demo/rev-1/manifest.json"),
            "demo/rev-1/manifest.json"
        );
        assert_eq!(root_target.remote_path(""), String::new());

        // URL 编码只放行安全字符。
        assert_eq!(encode_path("a/b c#d"), "a/b%20c%23d");
        // base64 往返（GitHub 响应带换行）。
        assert_eq!(
            base64_decode(&strip_whitespace("aGVs\nbG8=")).expect("decode"),
            b"hello".to_vec()
        );
        assert!(base64_decode("not base64!!").is_err());

        // 传输 journal：可重试事件落盘，含 reset，不含 token。
        let project = TempTree::new("github-journal");
        append_transport_journal(
            Some(&project.root),
            "retryable",
            "put demo/rev-1/manifest.json",
            Some("1735689600"),
            "[sync_target] github rate limited (retryable=true, status=403)",
        )
        .expect("journal");
        let raw = fs::read_to_string(project.root.join(SYNC_JOURNAL_FILE)).expect("read journal");
        assert!(raw.contains("rate limited"));
        assert!(raw.contains("1735689600"));
        assert!(raw.contains("\"retryable\":true"));
        assert!(!raw.contains("ghp_"), "journal must never hold a token");

        // 既有读取器仍能解析这些行（同格式 JSONL，宽字段被忽略）。
        let entries = read_journal(&project.root);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].direction, "retryable");
        assert_eq!(entries[0].manifest_id, "transport-health");

        // 未绑定项目根 → 不记也不报错。
        append_transport_journal(None, "retryable", "ctx", None, "msg").expect("no-op");
    }

    #[test]
    fn github_config_file_roundtrip_and_gates() {
        let project = TempTree::new("github-config");
        let file = SyncConfigFile {
            endpoint: GITHUB_ENDPOINT.to_string(),
            root: String::new(),
            credential_ref: "nb:github:niko".to_string(),
            enabled: true,
            github: Some(github_fixture()),
            local: None,
            schedule: None,
        };
        save_config_file(&project.root, &file).expect("save github config");
        let raw = fs::read_to_string(project.root.join(SYNC_CONFIG_FILE)).expect("read");
        // 线上字段是 camelCase（与前端 `GitHubConfig` 同构）。
        assert!(raw.contains("\"pathPrefix\""), "camelCase on the wire: {raw}");
        assert!(raw.contains("nb:github:niko"));
        assert!(!raw.contains("ghp_"));
        assert_eq!(
            load_config_file(&project.root).expect("load file"),
            Some(file.clone())
        );

        // 状态出口：GitHub 的 `root` 报 pathPrefix（UI 看到有效前缀）。
        let transport = load_config(&project.root)
            .expect("load")
            .expect("configured");
        assert_eq!(transport.endpoint, "github");
        assert_eq!(transport.root, "backups/qmai");
        assert_eq!(transport.credential_ref, "nb:github:niko");

        // 配置期拒绝：非 nb:github: 凭据引用。
        assert!(save_config_file(
            &project.root,
            &SyncConfigFile {
                credential_ref: "nb:webdav:niko".to_string(),
                ..file.clone()
            }
        )
        .is_err());
        // 配置期拒绝：endpoint=github 但缺 github 块。
        assert!(save_config_file(
            &project.root,
            &SyncConfigFile {
                github: None,
                ..file.clone()
            }
        )
        .is_err());
        // 配置期拒绝：WebDAV 端点带 github 块（歧义配置）。
        assert!(save_config_file(
            &project.root,
            &SyncConfigFile {
                endpoint: "https://dav.example.com".to_string(),
                root: "niko-buddy/backups".to_string(),
                ..file.clone()
            }
        )
        .is_err());
        // 无明文断言：github 块里塞 token 字段直接拒收。
        assert!(assert_config_no_secret_plaintext(
            r#"{"endpoint":"github","root":"","credential_ref":"nb:github:x","enabled":true,"github":{"owner":"a","repo":"b","branch":"c","pathPrefix":"","token":"ghp_x"}}"#
        )
        .is_err());
        // 四字段配置仍走决策层原断言（未知键被拒）。
        assert!(assert_config_no_secret_plaintext(
            r#"{"endpoint":"https://dav.example.com","root":"r","credential_ref":"nb:webdav:p","enabled":true,"password":"hunter2"}"#
        )
        .is_err());
    }

    // ── G2a：本地文件夹传输目标 ────────────────────────────────────────────

    fn local_fixture(root: &Path) -> LocalFolderConfig {
        LocalFolderConfig {
            local_path: root.to_string_lossy().replace('\\', "/"),
        }
    }

    #[test]
    fn local_config_gate_and_roundtrip() {
        let project = TempTree::new("local-config");
        let paired = TempTree::new("local-paired");
        let file = SyncConfigFile {
            endpoint: LOCAL_ENDPOINT.to_string(),
            root: String::new(),
            credential_ref: String::new(),
            enabled: true,
            github: None,
            local: Some(local_fixture(&paired.root)),
            schedule: Some(SyncScheduleFile {
                interval_minutes: 30,
            }),
        };
        save_config_file(&project.root, &file).expect("save local config");
        let raw = fs::read_to_string(project.root.join(SYNC_CONFIG_FILE)).expect("read");
        // 线上字段 camelCase（与前端 `LocalFolderConfig` / `SyncSchedule` 同构）。
        assert!(raw.contains("\"localPath\""), "camelCase on the wire: {raw}");
        assert!(raw.contains("\"intervalMinutes\": 30"), "camelCase on the wire: {raw}");
        assert_eq!(
            load_config_file(&project.root).expect("load file"),
            Some(file.clone())
        );
        // 状态出口：本地目标的 `root` 报 localPath（UI 看到有效目标）。
        let transport = load_config(&project.root).expect("load").expect("configured");
        assert_eq!(transport.endpoint, "local");
        assert_eq!(
            transport.root,
            paired.root.to_string_lossy().replace('\\', "/")
        );
        assert!(transport.credential_ref.is_empty());
        assert_eq!(file.interval_minutes(), 30);

        // 配置期硬门：凭据引用非空 / 相对路径 / 含 `..` / 越界档位 一律拒收。
        for broken in [
            SyncConfigFile {
                credential_ref: "nb:webdav:x".to_string(),
                ..file.clone()
            },
            SyncConfigFile {
                local: Some(LocalFolderConfig {
                    local_path: "relative/dir".to_string(),
                }),
                ..file.clone()
            },
            SyncConfigFile {
                local: Some(LocalFolderConfig {
                    local_path: format!("{}/../escape", paired.root.to_string_lossy()),
                }),
                ..file.clone()
            },
            SyncConfigFile {
                local: None,
                ..file.clone()
            },
            SyncConfigFile {
                schedule: Some(SyncScheduleFile {
                    interval_minutes: 7,
                }),
                ..file.clone()
            },
            SyncConfigFile {
                endpoint: "https://dav.example.com".to_string(),
                root: "niko-buddy/backups".to_string(),
                credential_ref: "nb:webdav:p".to_string(),
                ..file.clone()
            },
        ] {
            assert!(
                save_config_file(&project.root, &broken).is_err(),
                "invalid local config must be rejected: {broken:?}"
            );
        }
        // 无明文断言：local 块只允许 localPath。
        assert!(assert_config_no_secret_plaintext(
            r#"{"endpoint":"local","root":"","credential_ref":"","enabled":true,"local":{"localPath":"C:/b","token":"x"}}"#
        )
        .is_err());
    }

    #[test]
    fn local_target_copies_blocks_and_verifies_manifest() {
        // 档位常量是契约（三档：15 / 30 / 60）。
        assert_eq!(SCHEDULE_INTERVAL_MINUTES, [15, 30, 60]);
        assert_eq!(SCHEDULE_DEFAULT_INTERVAL_MINUTES, 15);
        assert!(validate_schedule(&SyncScheduleFile {
            interval_minutes: 15
        })
        .is_ok());
        assert!(validate_schedule(&SyncScheduleFile {
            interval_minutes: 60
        })
        .is_ok());
        assert!(validate_schedule(&SyncScheduleFile {
            interval_minutes: 0
        })
        .is_err());

        // 端点字面量（大小写/空白不敏感）。
        assert!(is_local_endpoint("local"));
        assert!(is_local_endpoint(" Local "));
        assert!(!is_local_endpoint("github"));
        assert!(!is_local_endpoint("https://dav.example.com"));

        runtime().block_on(async {
            let project = TempTree::new("local-push");
            let artifact =
                project.write("backups/auto/20260912-artifact.zip", b"local-artifact-v1");
            let paired = TempTree::new("local-target");
            let target = LocalFolderTarget::new(&local_fixture(&paired.root), "").expect("target");

            // 目标目录尚不存在 → list 为空（不是错误）。
            assert!(target.list("").await.expect("empty list").is_empty());

            let pushed = push_impl(
                &target,
                &project.root,
                &artifact,
                "device-a",
                "20260912140000",
            )
            .await
            .expect("local push");
            assert_eq!(pushed.manifest_id, "20260912-artifact");
            assert_eq!(pushed.revision, 1);

            // 文件拷贝落地：manifest + 内容寻址块都在目标目录里。
            let keys = target.list(&pushed.manifest_id).await.expect("list");
            assert!(keys.iter().any(|key| key.ends_with(REMOTE_MANIFEST_FILE)));
            assert!(keys.iter().any(|key| key.contains("/blocks/")));
            assert!(paired
                .root
                .join(&pushed.remote_prefix)
                .join(REMOTE_MANIFEST_FILE)
                .is_file());

            // 拉取复用既有编排：远端更新 → 快照入库（不替换工作树）。
            let pulled = pull_impl(
                &target,
                &project.root,
                &pushed.manifest_id,
                "device-b",
                "20260912150000",
            )
            .await
            .expect("local pull");
            assert_eq!(pulled.decision, "apply");
            let snapshot = PathBuf::from(pulled.snapshot_dir.expect("snapshot dir"));
            assert!(snapshot.join(REMOTE_MANIFEST_FILE).is_file());
            assert!(!project.root.join("QM").exists());

            // manifest 写后读回比对已接线：载荷没有 content_digest → 不能冒充已提交的清单。
            let manifest_key = format!("{}/{}", pushed.remote_prefix, REMOTE_MANIFEST_FILE);
            let rejected = target
                .put(&manifest_key, b"{}")
                .await
                .expect_err("a payload without content_digest must not pass the write-back check");
            assert!(rejected.contains("no content_digest"));
            // 指纹比对本身的行为（同指纹通过 / 异指纹硬失败）由 `verify_manifest_digest` 单测锁定。

            // 键守卫在触盘之前生效：真值面 / 绝对路径 / `..` 一律拒。
            for forbidden in ["demo/rev-1/QM/x", "demo/rev-1/canon/x", "/abs", "../escape"] {
                assert!(target.put(forbidden, b"x").await.is_err());
            }

            // 目标目录之外的残留检查：只允许 pushed 前缀下的对象。
            let leftovers: Vec<String> = fs::read_dir(&paired.root)
                .expect("read paired root")
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect();
            assert_eq!(leftovers, vec![pushed.manifest_id.clone()]);
        });
    }

    #[test]
    fn sync_run_lock_is_per_project_and_released_on_drop() {
        // F-009：同一项目同一时刻只能有一个同步周期（push / pull 共用同一把锁）；
        // 不同项目互不影响（不把无关项目串行化，也让并行测试不互相干扰）。
        let project = TempTree::new("lock-a");
        let other = TempTree::new("lock-b");

        let first = try_acquire_sync_run(&project.root).expect("first acquire");
        let busy = try_acquire_sync_run(&project.root);
        assert!(busy.is_err(), "second acquire on the same project must fail");
        assert!(
            busy.err().unwrap().contains("already running"),
            "busy error must be readable"
        );
        // 另一个项目不受影响。
        let other_guard = try_acquire_sync_run(&other.root).expect("other project acquire");

        drop(first);
        let again = try_acquire_sync_run(&project.root).expect("acquire after release");
        drop(again);
        drop(other_guard);
    }

    #[test]
    fn concurrent_push_and_pull_on_one_project_cannot_overlap() {
        // F-009（行为面）：手动同步与调度共用同一入口 —— 第二次进入直接忙返回，
        // 不会去动暂存目录 / revision 水位。
        let project = TempTree::new("lock-serialized");
        let artifact = project.write("backups/auto/20260912-lock.zip", b"lock-payload");
        let target = MemoryTarget::new();

        runtime().block_on(async {
            let guard = try_acquire_sync_run(&project.root).expect("hold lock");
            let blocked_push = push_impl(
                &target,
                &project.root,
                &artifact,
                "device-a",
                "20260912170000",
            )
            .await;
            assert!(blocked_push.is_err(), "push must not run while the lock is held");
            let blocked_pull = pull_impl(
                &target,
                &project.root,
                "20260912-lock",
                "device-a",
                "20260912170000",
            )
            .await;
            assert!(blocked_pull.is_err(), "pull must not run while the lock is held");
            drop(guard);

            // 锁释放后同一操作可正常执行（忙返回不是永久阻塞）。
            let pushed = push_impl(
                &target,
                &project.root,
                &artifact,
                "device-a",
                "20260912170001",
            )
            .await
            .expect("push after release");
            assert_eq!(pushed.revision, 1);
        });
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
            base_rev: None,
            base_content_hash: None,
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
