//! 远程 MCP 传输（F-005）：显式 opt-in + 鉴权 + **先审后入库**。
//!
//! 分工（诚实边界）：
//! * 本模块负责：传输模式门禁、会话建立计划、远程请求计划、审计门（`AuditBlocked`）。
//! * 真正发起 HTTP 的部分在 `api` 子模块（`reqwest`），只做「按计划发送」这一件事。
//! * 审计器是前端模块（`prompt-injection-auditor` / `rag-trust-audit`）。因此
//!   Rust 侧只强制执行**结论**：`ingest_remote_payload` 在没有 `Allow` 结论时
//!   一律 `AuditBlocked` 且不写任何字节（C6）。
//!
//! 鉴权：仅 `Authorization: Bearer <token>`；token 从 OS 凭据库读取
//! （`credential_vault`，键 `mcp:<server_id>`），**禁止**落盘到项目数据区。
//! OAuth 授权码流程列为后续分期，本模块不实现。

use std::collections::HashMap;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::credential_vault::vault_get_secret;
use crate::mcp_transport::{self, TransportConfig};

/// 远程请求超时（毫秒）。
pub const REMOTE_TIMEOUT_MS: u64 = 30_000;
/// 单次远程响应体上限（字节）——超过即拒绝，避免把巨量内容当上下文。
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpError {
    /// 传输模式不支持（例如 sse 在本期实现范围内的限制）。
    TransportUnsupported(String),
    /// 未 opt-in 或会话不存在。
    NotConnected(String),
    /// 审计未放行 → 拒绝入库（C6）。
    AuditBlocked(String),
    /// 传输层失败。
    Transport(String),
    /// 凭据读取失败。
    Vault(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::TransportUnsupported(m) => write!(f, "MCP_TRANSPORT_UNSUPPORTED: {m}"),
            McpError::NotConnected(m) => write!(f, "MCP_NOT_CONNECTED: {m}"),
            McpError::AuditBlocked(m) => write!(f, "MCP_AUDIT_BLOCKED: {m}"),
            McpError::Transport(m) => write!(f, "MCP_TRANSPORT: {m}"),
            McpError::Vault(m) => write!(f, "MCP_VAULT: {m}"),
        }
    }
}

impl std::error::Error for McpError {}

/// 传输模式设置（薄转发到注册表；命令层与注册表共用同一入口）。
pub fn mcp_transport_set_mode(
    project_root: &Path,
    transport: &str,
    allow_http: bool,
) -> Result<TransportConfig, McpError> {
    mcp_transport::set_mode(project_root, transport, allow_http).map_err(McpError::Transport)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSession {
    pub server_id: String,
    pub transport: String,
    pub endpoint: String,
    /// 是否持有 bearer 凭据（**不返回凭据本身**）。
    pub credential_present: bool,
    /// 会话建立时是否已完成 opt-in。
    pub opt_in: bool,
}

/// 远程请求计划：把「能否发」与「怎么发」分开，前者可同步单测。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteRequestPlan {
    pub server_id: String,
    pub transport: String,
    pub endpoint: String,
    pub timeout_ms: u64,
    pub max_response_bytes: usize,
    pub body: String,
}

/// 远程取回的载荷。**必须**先过审计才允许入库。
// 四-6：读侧加法兼容 camel（serverId/auditPending），主名 snake 不变——
// 当前线协议为 Rust→TS 单向（remote-transport.ts 以 snake 镜像），零写变更。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemotePayload {
    #[serde(alias = "serverId")]
    pub server_id: String,
    pub transport: String,
    pub body: String,
    /// 恒为 true：提示调用方「未经审计不得入库」。
    #[serde(alias = "auditPending")]
    pub audit_pending: bool,
    /// 审计放行后由调用方置为 false 的来源标记。
    pub origin: String,
}

/// 审计结论（由前端审计器给出）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditVerdict {
    Allow,
    Block,
    Review,
}

impl AuditVerdict {
    pub fn parse(value: &str) -> Result<AuditVerdict, McpError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "allow" => Ok(AuditVerdict::Allow),
            "block" => Ok(AuditVerdict::Block),
            "review" => Ok(AuditVerdict::Review),
            other => Err(McpError::AuditBlocked(format!(
                "unknown audit verdict '{other}'"
            ))),
        }
    }
}

static SESSIONS: Mutex<Option<HashMap<String, RemoteSession>>> = Mutex::new(None);

fn sessions() -> std::sync::MutexGuard<'static, Option<HashMap<String, RemoteSession>>> {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 凭据库里的键名（`mcp:<server_id>`）。凭据**只**在 OS 凭据库，不落数据区。
pub fn credential_key(server_id: &str) -> String {
    format!("mcp:{}", server_id.trim())
}

/// 脱敏远程端点 URL：隐藏 userinfo 凭据（复用 `proxy::redact_url`）、剥离 query/fragment，
/// 并将控制字符替换为空格，避免在报错中回显敏感信息。
fn redact_endpoint(raw: &str) -> String {
    let without_query = raw.split(['?', '#']).next().unwrap_or(raw);
    let redacted = crate::proxy::redact_url(without_query);
    let sanitized: String = redacted
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if without_query.len() < raw.len() {
        format!("{sanitized}?***")
    } else {
        sanitized
    }
}

/// 校验远程 MCP 端点 URL：仅允许 `http://` 或 `https://`，拒绝空 host、userinfo (`@`)、
/// 任意空白与控制字符，且报错 URL 均经 [`crate::proxy::redact_url`] 脱敏。
fn validate_remote_endpoint(raw: &str) -> Result<String, McpError> {
    if raw.is_empty() {
        return Err(McpError::NotConnected(
            "no remote endpoint configured for this server (set NB_MCP_ENDPOINT)".to_string(),
        ));
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(McpError::Transport(format!(
            "invalid remote endpoint (contains whitespace or control characters): {}",
            redact_endpoint(raw)
        )));
    }
    let Some((scheme, after_scheme)) = raw.split_once("://") else {
        return Err(McpError::Transport(format!(
            "remote endpoint must use http:// or https:// scheme: {}",
            redact_endpoint(raw)
        )));
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(McpError::Transport(format!(
            "remote endpoint must use http:// or https:// scheme: {}",
            redact_endpoint(raw)
        )));
    }
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.contains('@') {
        return Err(McpError::Transport(format!(
            "remote endpoint must not embed userinfo credentials: {}",
            redact_endpoint(raw)
        )));
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        let Some((ipv6_host, after_bracket)) = rest.split_once(']') else {
            return Err(McpError::Transport(format!(
                "remote endpoint has malformed IPv6 host: {}",
                redact_endpoint(raw)
            )));
        };
        if !after_bracket.is_empty() {
            let Some(port_str) = after_bracket.strip_prefix(':') else {
                return Err(McpError::Transport(format!(
                    "remote endpoint has malformed authority: {}",
                    redact_endpoint(raw)
                )));
            };
            if port_str.is_empty() || port_str.parse::<u16>().is_err() {
                return Err(McpError::Transport(format!(
                    "remote endpoint has invalid port: {}",
                    redact_endpoint(raw)
                )));
            }
        }
        ipv6_host
    } else if let Some((h, port_str)) = authority.rsplit_once(':') {
        if port_str.is_empty() || port_str.parse::<u16>().is_err() {
            return Err(McpError::Transport(format!(
                "remote endpoint has invalid port: {}",
                redact_endpoint(raw)
            )));
        }
        h
    } else {
        authority
    };
    if host.is_empty() {
        return Err(McpError::Transport(format!(
            "remote endpoint must have a non-empty host: {}",
            redact_endpoint(raw)
        )));
    }
    Ok(raw.to_string())
}

fn endpoint_of(server_id: &str) -> Result<String, McpError> {
    let value = std::env::var(format!(
        "NB_MCP_ENDPOINT_{}",
        server_id.to_ascii_uppercase().replace('-', "_")
    ))
    .ok()
    .or_else(|| std::env::var("NB_MCP_ENDPOINT").ok());
    match value {
        Some(v) if !v.is_empty() => validate_remote_endpoint(&v),
        _ => Err(McpError::NotConnected(
            "no remote endpoint configured for this server (set NB_MCP_ENDPOINT)".to_string(),
        )),
    }
}

/// 建立远程会话：先过 opt-in 门，再从凭据库取 bearer。
pub fn mcp_remote_connect(project_root: &Path, server_id: &str) -> Result<RemoteSession, McpError> {
    let server = server_id.trim();
    if server.is_empty() {
        return Err(McpError::NotConnected("server_id must not be empty".into()));
    }
    let config = mcp_transport::load_config(project_root);
    if !config.is_remote() {
        return Err(McpError::NotConnected(format!(
            "transport is '{}'; remote connect requires http or sse",
            config.transport
        )));
    }
    if !config.may_connect_remote() {
        return Err(McpError::NotConnected(format!(
            "remote transport '{}' requires allow_http = true",
            config.transport
        )));
    }
    let endpoint = endpoint_of(server)?;
    let credential_present = vault_get_secret(credential_key(server))
        .map_err(McpError::Vault)?
        .is_some();

    let session = RemoteSession {
        server_id: server.to_string(),
        transport: config.transport.clone(),
        endpoint,
        credential_present,
        opt_in: true,
    };
    sessions()
        .get_or_insert_with(HashMap::new)
        .insert(server.to_string(), session.clone());
    Ok(session)
}

/// 生成远程请求计划（同步、无网络）：把门禁与会话校验做成可单测的一步。
pub fn mcp_remote_request(
    project_root: &Path,
    server_id: &str,
    payload: &str,
) -> Result<RemoteRequestPlan, McpError> {
    let server = server_id.trim();
    let session = {
        let guard = sessions();
        guard.as_ref().and_then(|map| map.get(server).cloned())
    }
    .ok_or_else(|| McpError::NotConnected(format!("no open session for '{server}'")))?;

    let config = mcp_transport::load_config(project_root);
    if !config.may_connect_remote() {
        return Err(McpError::NotConnected(
            "opt-in was revoked; reopen with allow_http = true".into(),
        ));
    }
    if session.transport != config.transport {
        return Err(McpError::TransportUnsupported(format!(
            "session transport '{}' no longer matches configured '{}'",
            session.transport, config.transport
        )));
    }
    if payload.len() > MAX_RESPONSE_BYTES {
        return Err(McpError::Transport(format!(
            "payload exceeds {MAX_RESPONSE_BYTES} bytes"
        )));
    }
    if matches!(session.transport.as_str(), "http" | "sse") && session.endpoint.trim().is_empty() {
        return Err(McpError::NotConnected("session has no endpoint".into()));
    }

    Ok(RemoteRequestPlan {
        server_id: session.server_id.clone(),
        transport: session.transport.clone(),
        endpoint: session.endpoint.clone(),
        timeout_ms: REMOTE_TIMEOUT_MS,
        max_response_bytes: MAX_RESPONSE_BYTES,
        body: payload.to_string(),
    })
}

/// 关闭会话。
pub fn mcp_remote_close(server_id: &str) -> Result<bool, McpError> {
    let server = server_id.trim();
    if server.is_empty() {
        return Err(McpError::NotConnected("server_id must not be empty".into()));
    }
    let removed = sessions()
        .get_or_insert_with(HashMap::new)
        .remove(server)
        .is_some();
    Ok(removed)
}

/// 已开启的会话数（面板用）。
pub fn open_session_count() -> usize {
    sessions().as_ref().map(|m| m.len()).unwrap_or(0)
}

/// 远程载荷入库门（C6）：先审后入库。
///
/// * `verdict != Allow` → `AuditBlocked`，**不写任何字节**；
/// * 非远程来源（`audit_pending == false` 或 origin 非远程通道）→ 同样拒绝，
///   防止把本地内容伪装成「已审计的远程内容」绕过审计；
/// * 目标路径必须过 TASK-001 的确认门。
pub fn ingest_remote_payload(
    project_root: &Path,
    target_rel: &str,
    payload: &RemotePayload,
    verdict: AuditVerdict,
) -> Result<String, McpError> {
    if verdict != AuditVerdict::Allow {
        return Err(McpError::AuditBlocked(format!(
            "payload from '{}' not allowed by audit ({:?})",
            payload.server_id, verdict
        )));
    }
    if !payload.audit_pending {
        return Err(McpError::AuditBlocked(
            "payload is not marked as pending audit; refusing to ingest".into(),
        ));
    }
    if payload.origin.trim().is_empty() {
        return Err(McpError::AuditBlocked(
            "payload has no provenance origin".into(),
        ));
    }

    // TASK-001 门的包容性自证：writeFile 不在 DESTRUCTIVE_OPS，gate 对非受保护路径
    // 不会介入（直接 Allowed），因此「目标必须在项目根内」必须由本模块自行强制。
    // 拒绝空路径、控制字符、冒号（ADS）、绝对路径与 `..` 组件（目录逃逸）。
    let trimmed_rel = target_rel.trim();
    if trimmed_rel.is_empty()
        || trimmed_rel
            .chars()
            .any(|c| c == '\0' || c.is_control() || c == ':')
    {
        return Err(McpError::AuditBlocked(format!(
            "target path contains invalid characters: {target_rel}"
        )));
    }
    let rel_path = Path::new(trimmed_rel);
    if rel_path.is_absolute() {
        return Err(McpError::AuditBlocked(format!(
            "target must be relative to project root, got: {target_rel}"
        )));
    }
    let mut has_normal_segment = false;
    for component in rel_path.components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::Prefix(_)
            | std::path::Component::RootDir => {
                return Err(McpError::AuditBlocked(format!(
                    "target must stay inside the project root; forbidden path component in: {target_rel}"
                )));
            }
            std::path::Component::Normal(seg) => {
                has_normal_segment = true;
                let seg_str = seg.to_string_lossy();
                if crate::agent_gate_policy::is_windows_reserved_device_name(&seg_str) {
                    return Err(McpError::AuditBlocked(format!(
                        "target path uses reserved device name: {target_rel}"
                    )));
                }
            }
            std::path::Component::CurDir => {}
        }
    }
    if !has_normal_segment {
        return Err(McpError::AuditBlocked(format!(
            "target path has no file name: {target_rel}"
        )));
    }

    // 全局锁序 T4 (FILE_MUTATION_LOCK) -> T5 (GATE / file_sync)。
    let _mutation = crate::commands::fs::lock_file_mutations().map_err(McpError::Transport)?;

    let target = project_root.join(trimmed_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let gate = crate::agent_gate::gate_authorize(
        "writeFile",
        &target.to_string_lossy(),
        crate::agent_gate::GateActor::External,
    );
    if !gate.may_proceed() {
        return Err(McpError::AuditBlocked(crate::agent_gate::gate_error(&gate)));
    }
    crate::agent_gate_policy::assert_no_symlink_in_ancestors(project_root, &target)
        .map_err(McpError::AuditBlocked)?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| McpError::Transport(format!("create dir failed: {e}")))?;
        crate::agent_gate_policy::assert_no_symlink_in_ancestors(project_root, &target)
            .map_err(McpError::AuditBlocked)?;
        // 双保险：磁盘规范化后仍须在项目根内（防项目内 symlink 指向外部）。
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| McpError::Transport(format!("resolve parent failed: {e}")))?;
        let root_canon = project_root
            .canonicalize()
            .map_err(|e| McpError::Transport(format!("resolve root failed: {e}")))?;
        if !parent_canon.starts_with(&root_canon) {
            return Err(McpError::AuditBlocked(format!(
                "target escapes project root after canonicalization: {}",
                parent_canon.display()
            )));
        }
    }
    match std::fs::symlink_metadata(&target) {
        Ok(meta) => {
            if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
                return Err(McpError::AuditBlocked(format!(
                    "target is a symlink or reparse point: {}",
                    target.display()
                )));
            }
            if !meta.is_file() {
                return Err(McpError::AuditBlocked(format!(
                    "target is not a regular file: {}",
                    target.display()
                )));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(McpError::Transport(format!("inspect target failed: {e}")));
        }
    }
    crate::commands::fs::write_atomic_physical_bytes(&target, payload.body.as_bytes())
        .map_err(|e| McpError::Transport(format!("write failed: {e}")))?;
    Ok(target.to_string_lossy().to_string())
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────

pub mod api {
    use super::*;

    #[tauri::command]
    pub async fn mcp_transport_set_mode(
        project_path: String,
        transport: String,
        allow_http: bool,
    ) -> Result<TransportConfig, String> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::panic_guard::run_guarded("mcp_transport_set_mode", || {
                super::mcp_transport_set_mode(Path::new(&project_path), &transport, allow_http)
                    .map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("mcp_transport_set_mode blocking task join error: {e}"))?
    }

    #[tauri::command]
    pub async fn mcp_remote_connect(
        project_path: String,
        server_id: String,
    ) -> Result<RemoteSession, String> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::panic_guard::run_guarded("mcp_remote_connect", || {
                super::mcp_remote_connect(Path::new(&project_path), &server_id)
                    .map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("mcp_remote_connect blocking task join error: {e}"))?
    }

    #[tauri::command]
    pub async fn mcp_remote_request(
        project_path: String,
        server_id: String,
        payload: String,
    ) -> Result<RemotePayload, String> {
        crate::panic_guard::run_guarded_async("mcp_remote_request", async move {
            let plan = tauri::async_runtime::spawn_blocking(move || {
                crate::panic_guard::run_guarded("mcp_remote_request", || {
                    super::mcp_remote_request(Path::new(&project_path), &server_id, &payload)
                        .map_err(|e| e.to_string())
                })
            })
            .await
            .map_err(|e| format!("mcp_remote_request blocking task join error: {e}"))??;
            let body = send_plan(&plan).await.map_err(|e| e.to_string())?;
            Ok(RemotePayload {
                server_id: plan.server_id,
                transport: plan.transport,
                body,
                audit_pending: true,
                origin: plan.endpoint,
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn mcp_remote_close(server_id: String) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::panic_guard::run_guarded("mcp_remote_close", || {
                super::mcp_remote_close(&server_id).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("mcp_remote_close blocking task join error: {e}"))?
    }

    /// 按计划发送一次请求。鉴权仅 Bearer；禁用 HTTP 重定向、设置连接/总超时、
    /// 不吞凭据库错误；先校验 `Content-Length`，再流式分块限长，拒绝超大响应。
    pub(super) async fn send_plan(plan: &RemoteRequestPlan) -> Result<String, McpError> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_millis(plan.timeout_ms))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| McpError::Transport(format!("client build failed: {e}")))?;

        let mut request = client
            .post(&plan.endpoint)
            .header("content-type", "application/json")
            .header("accept", "application/json");
        if plan.transport == "sse" {
            request = request.header("accept", "text/event-stream");
        }
        let cred_key = super::credential_key(&plan.server_id);
        let token_opt = tokio::task::spawn_blocking(move || {
            crate::credential_vault::vault_get_secret(cred_key)
        })
        .await
        .map_err(|e| McpError::Vault(format!("vault read task join error: {e}")))?
        .map_err(McpError::Vault)?;
        if let Some(token) = token_opt {
            request = request.header("authorization", format!("Bearer {token}"));
        }

        let mut response = request.body(plan.body.clone()).send().await.map_err(|e| {
            McpError::Transport(format!(
                "request to {} failed: {}",
                super::redact_endpoint(&plan.endpoint),
                e.without_url()
            ))
        })?;

        if !response.status().is_success() {
            return Err(McpError::Transport(format!(
                "remote returned status {}",
                response.status()
            )));
        }
        if let Some(declared_len) = response.content_length() {
            if declared_len > plan.max_response_bytes as u64 {
                return Err(McpError::Transport(format!(
                    "response exceeds {} bytes",
                    plan.max_response_bytes
                )));
            }
        }
        let initial_cap = response
            .content_length()
            .map(|n| (n as usize).min(plan.max_response_bytes).min(64 * 1024))
            .unwrap_or(0);
        let mut buf = Vec::with_capacity(initial_cap);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| McpError::Transport(format!("read body failed: {e}")))?
        {
            if buf.len().saturating_add(chunk.len()) > plan.max_response_bytes {
                return Err(McpError::Transport(format!(
                    "response exceeds {} bytes",
                    plan.max_response_bytes
                )));
            }
            buf.extend_from_slice(&chunk);
        }
        String::from_utf8(buf)
            .map_err(|e| McpError::Transport(format!("response is not utf-8: {e}")))
    }
}

#[cfg(test)]
mod mcp {
    use super::*;
    use crate::mcp_transport::set_mode;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nb-mcp-remote-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("mkdir");
        root
    }

    /// 进程级会话表 + 环境变量 → 测试串行。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[derive(Default)]
    struct TestMemoryVault {
        entries: Mutex<HashMap<(String, String), String>>,
    }

    impl crate::credential_vault::VaultBackend for TestMemoryVault {
        fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
            self.entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    (service.to_string(), account.to_string()),
                    secret.to_string(),
                );
            Ok(())
        }

        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            Ok(self
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&(service.to_string(), account.to_string()))
                .cloned())
        }

        fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
            Ok(self
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&(service.to_string(), account.to_string()))
                .is_some())
        }
    }

    struct FailingVault {
        message: String,
    }

    impl crate::credential_vault::VaultBackend for FailingVault {
        fn set(&self, _service: &str, _account: &str, _secret: &str) -> Result<(), String> {
            Err(self.message.clone())
        }

        fn get(&self, _service: &str, _account: &str) -> Result<Option<String>, String> {
            Err(self.message.clone())
        }

        fn delete(&self, _service: &str, _account: &str) -> Result<bool, String> {
            Err(self.message.clone())
        }
    }

    struct VaultBackendScope;

    impl VaultBackendScope {
        fn install(backend: std::sync::Arc<dyn crate::credential_vault::VaultBackend>) -> Self {
            crate::credential_vault::__set_test_backend(Some(backend));
            Self
        }
    }

    impl Drop for VaultBackendScope {
        fn drop(&mut self) {
            crate::credential_vault::__set_test_backend(None);
        }
    }

    #[test]
    fn remote_connect_requires_optin() {
        let _vault_lock = crate::credential_vault::vault_test_serial();
        let _vault_scope =
            VaultBackendScope::install(std::sync::Arc::new(TestMemoryVault::default()));
        let _guard = lock();
        let root = temp_root("optin");
        // 默认 stdio：远程连接必须被拒。
        let err = mcp_remote_connect(&root, "demo").expect_err("stdio 下不得远程连接");
        assert!(matches!(err, McpError::NotConnected(_)), "got {err:?}");

        set_mode(&root, "http", true).expect("opt-in");
        std::env::set_var("NB_MCP_ENDPOINT", "http://127.0.0.1:9/mcp");
        let session = mcp_remote_connect(&root, "demo").expect("opt-in 后应建会话");
        assert_eq!(session.transport, "http");
        assert!(session.opt_in);
        assert!(!session.credential_present, "测试环境无凭据");
        assert_eq!(open_session_count(), 1);
        assert!(mcp_remote_close("demo").unwrap());
        assert_eq!(open_session_count(), 0);
        std::env::remove_var("NB_MCP_ENDPOINT");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn request_requires_open_session_and_matching_transport() {
        let _vault_lock = crate::credential_vault::vault_test_serial();
        let _vault_scope =
            VaultBackendScope::install(std::sync::Arc::new(TestMemoryVault::default()));
        let _guard = lock();
        let root = temp_root("plan");
        let err = mcp_remote_request(&root, "nope", "{}").expect_err("无会话必须拒");
        assert!(matches!(err, McpError::NotConnected(_)), "got {err:?}");

        set_mode(&root, "http", true).expect("opt-in");
        std::env::set_var("NB_MCP_ENDPOINT", "http://127.0.0.1:9/mcp");
        mcp_remote_connect(&root, "demo").expect("connect");
        let plan = mcp_remote_request(&root, "demo", "{\"jsonrpc\":\"2.0\"}").expect("plan");
        assert_eq!(plan.timeout_ms, REMOTE_TIMEOUT_MS);
        assert_eq!(plan.max_response_bytes, MAX_RESPONSE_BYTES);
        assert_eq!(plan.transport, "http");

        // 切回 stdio 后，同一 http 会话不得继续发送（传输不匹配）。
        set_mode(&root, "stdio", false).expect("回退 stdio");
        let switched = mcp_remote_request(&root, "demo", "{}").expect_err("切回 stdio 后必须拒");
        assert!(
            matches!(switched, McpError::TransportUnsupported(_)),
            "got {switched:?}"
        );

        // 手改配置把 opt-in 摸掉的场景：配置仍是 http 但 allow_http=false → 必须被 opt-in 门拦住。
        let config_path = crate::mcp_transport::transport_config_path(&root);
        std::fs::create_dir_all(config_path.parent().unwrap()).expect("mkdir");
        std::fs::write(
            &config_path,
            "{\"transport\":\"http\",\"allow_http\":false}",
        )
        .expect("write config");
        let revoked = mcp_remote_request(&root, "demo", "{}").expect_err("opt-in 被撤销后必须拒");
        assert!(
            matches!(revoked, McpError::NotConnected(_)),
            "got {revoked:?}"
        );
        mcp_remote_close("demo").unwrap();
        std::env::remove_var("NB_MCP_ENDPOINT");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_payload_accepts_snake_and_camel_spellings() {
        // 四-6：读侧双拼写兼容（主名 snake；camel 经 alias）。
        let snake: RemotePayload = serde_json::from_str(
            r#"{"server_id":"s","transport":"http","body":"b","audit_pending":true,"origin":"o"}"#,
        )
        .unwrap();
        let camel: RemotePayload = serde_json::from_str(
            r#"{"serverId":"s","transport":"http","body":"b","auditPending":true,"origin":"o"}"#,
        )
        .unwrap();
        assert_eq!(snake.server_id, camel.server_id);
        assert_eq!(snake.audit_pending, camel.audit_pending);
    }

    #[test]
    fn remote_payload_blocked_before_ingest() {
        let _guard = lock();
        let root = temp_root("audit");
        let payload = RemotePayload {
            server_id: "demo".into(),
            transport: "http".into(),
            body: "remote content".into(),
            audit_pending: true,
            origin: "http://127.0.0.1:9/mcp".into(),
        };
        let target = ".novel/mcp-incoming/payload.json";

        for verdict in [AuditVerdict::Block, AuditVerdict::Review] {
            let err = ingest_remote_payload(&root, target, &payload, verdict)
                .expect_err("非 Allow 必须被拦截");
            assert!(matches!(err, McpError::AuditBlocked(_)), "got {err:?}");
            assert!(
                !root
                    .join(".novel")
                    .join("mcp-incoming")
                    .join("payload.json")
                    .exists(),
                "被拦截的载荷不得落盘"
            );
        }

        // 未标记待审计的载荷同样拒绝（防伪装）。
        let disguised = RemotePayload {
            audit_pending: false,
            ..payload.clone()
        };
        assert!(matches!(
            ingest_remote_payload(&root, target, &disguised, AuditVerdict::Allow)
                .expect_err("未标记必须拒"),
            McpError::AuditBlocked(_)
        ));

        // Allow + 标记齐全 → 写入成功。
        let written = ingest_remote_payload(&root, target, &payload, AuditVerdict::Allow)
            .expect("allow 应写入");
        assert!(Path::new(&written).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// F-005/C6 收口：目标路径必须被包含在项目根内（模块文档承诺的 TASK-001 门）。
    /// writeFile 不在 DESTRUCTIVE_OPS，gate 不会介入 —— 包容性必须由本模块自证。
    #[test]
    fn ingest_rejects_paths_escaping_project_root() {
        let root = temp_root("escape");
        // 共享 Temp 下的逃逸目标可能被上次 panic 的红跑残留：先清场再断言。
        let outside = root.parent().unwrap().join("escape.md");
        let abs = root.parent().unwrap().join("abs-escape.md");
        let nested_out = root.parent().unwrap().join("out.md");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_file(&abs);
        let _ = std::fs::remove_file(&nested_out);
        let payload = RemotePayload {
            server_id: "demo".into(),
            transport: "http".into(),
            body: "remote content".into(),
            audit_pending: true,
            origin: "http://127.0.0.1:9/mcp".into(),
        };

        // ① 相对路径 .. 逃逸
        let err = ingest_remote_payload(&root, "../escape.md", &payload, AuditVerdict::Allow)
            .expect_err(".. 逃逸必须被拒");
        assert!(matches!(err, McpError::AuditBlocked(_)), "got {err:?}");
        assert!(!outside.exists(), "逃逸目标不得落盘");

        // ② 绝对路径（Path::join 语义：绝对路径整体替换基座）
        let err =
            ingest_remote_payload(&root, &abs.to_string_lossy(), &payload, AuditVerdict::Allow)
                .expect_err("绝对路径必须被拒");
        assert!(matches!(err, McpError::AuditBlocked(_)), "got {err:?}");
        assert!(!abs.exists(), "绝对路径目标不得落盘");

        // ③ 嵌套 .. 组件
        let err = ingest_remote_payload(
            &root,
            "components/../../out.md",
            &payload,
            AuditVerdict::Allow,
        )
        .expect_err("嵌套 .. 必须被拒");
        assert!(matches!(err, McpError::AuditBlocked(_)), "got {err:?}");
        assert!(!nested_out.exists(), "嵌套逃逸目标不得落盘");

        // ④ 正常项目内路径仍可写（不因守卫误伤正常入库）
        let ok = ingest_remote_payload(
            &root,
            ".novel/mcp-incoming/payload.json",
            &payload,
            AuditVerdict::Allow,
        )
        .expect("项目内路径应写入成功");
        assert!(Path::new(&ok).exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_file(&abs);
        let _ = std::fs::remove_file(&nested_out);
    }

    #[test]
    fn credential_key_is_namespaced() {
        assert_eq!(credential_key("github"), "mcp:github");
        assert!(!credential_key("github").contains('/'));
    }

    #[test]
    fn ingest_rejects_symlink_target_and_reserved_names() {
        let _guard = lock();
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        let payload = RemotePayload {
            server_id: "demo".into(),
            transport: "http".into(),
            body: "payload".into(),
            audit_pending: true,
            origin: "http://127.0.0.1:9/mcp".into(),
        };

        assert!(matches!(
            ingest_remote_payload(
                &root,
                ".novel/mcp-incoming/CON.json",
                &payload,
                AuditVerdict::Allow
            )
            .expect_err("reserved device name must be rejected"),
            McpError::AuditBlocked(_)
        ));

        #[cfg(unix)]
        {
            let incoming = root.join(".novel").join("mcp-incoming");
            std::fs::create_dir_all(&incoming).unwrap();
            let link_target = incoming.join("link.json");
            let outside_file = outside.join("victim.json");
            std::fs::write(&outside_file, b"keep").unwrap();
            std::os::unix::fs::symlink(&outside_file, &link_target).unwrap();
            assert!(matches!(
                ingest_remote_payload(
                    &root,
                    ".novel/mcp-incoming/link.json",
                    &payload,
                    AuditVerdict::Allow
                )
                .expect_err("symlink target must be rejected"),
                McpError::AuditBlocked(_)
            ));
            assert_eq!(std::fs::read(&outside_file).unwrap(), b"keep");
        }

        #[cfg(windows)]
        {
            let incoming_parent = root.join(".novel");
            std::fs::create_dir_all(&incoming_parent).unwrap();
            let junction = incoming_parent.join("mcp-incoming");
            let linked = std::os::windows::fs::symlink_dir(&outside, &junction).is_ok()
                || std::process::Command::new("cmd")
                    .args([
                        "/c",
                        "mklink",
                        "/J",
                        &junction.to_string_lossy(),
                        &outside.to_string_lossy(),
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success());
            if linked {
                assert!(matches!(
                    ingest_remote_payload(
                        &root,
                        ".novel/mcp-incoming/victim.json",
                        &payload,
                        AuditVerdict::Allow
                    )
                    .expect_err("reparse ancestor must be rejected"),
                    McpError::AuditBlocked(_)
                ));
                assert!(!outside.join("victim.json").exists());
                let _ = std::fs::remove_dir(&junction);
            }
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn send_plan_enforces_streaming_and_content_length_limits() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let _vault_lock = crate::credential_vault::vault_test_serial_async().await;
        let _vault_scope =
            VaultBackendScope::install(std::sync::Arc::new(TestMemoryVault::default()));

        async fn spawn_raw_server(raw_response: &'static [u8]) -> u16 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                if let Ok((mut socket, _)) = listener.accept().await {
                    let mut req_buf = [0u8; 2048];
                    let _ = socket.read(&mut req_buf).await;
                    let _ = socket.write_all(raw_response).await;
                    let _ = socket.shutdown().await;
                }
            });
            port
        }

        // 1) Content-Length 声明超限 → 立即拒绝
        let port_cl = spawn_raw_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n01234567890123456789",
        )
        .await;
        let plan_cl = RemoteRequestPlan {
            server_id: "test-limit-cl".into(),
            transport: "http".into(),
            endpoint: format!("http://127.0.0.1:{port_cl}/mcp"),
            timeout_ms: 5_000,
            max_response_bytes: 16,
            body: "{}".into(),
        };
        let err_cl = api::send_plan(&plan_cl)
            .await
            .expect_err("oversized Content-Length must fail");
        assert!(matches!(err_cl, McpError::Transport(ref m) if m.contains("exceeds 16 bytes")));

        // 2) 无 Content-Length 的 chunked 流超限 → 流式读取阶段拒绝
        let port_stream = spawn_raw_server(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n14\r\n01234567890123456789\r\n0\r\n\r\n",
        )
        .await;
        let plan_stream = RemoteRequestPlan {
            server_id: "test-limit-stream".into(),
            transport: "http".into(),
            endpoint: format!("http://127.0.0.1:{port_stream}/mcp"),
            timeout_ms: 5_000,
            max_response_bytes: 16,
            body: "{}".into(),
        };
        let err_stream = api::send_plan(&plan_stream)
            .await
            .expect_err("oversized chunked body must fail");
        assert!(matches!(err_stream, McpError::Transport(ref m) if m.contains("exceeds 16 bytes")));

        // 3) 限额内的正常响应放行
        let port_ok = spawn_raw_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\n{\"ok\":1}\n",
        )
        .await;
        let plan_ok = RemoteRequestPlan {
            server_id: "test-limit-ok".into(),
            transport: "http".into(),
            endpoint: format!("http://127.0.0.1:{port_ok}/mcp"),
            timeout_ms: 5_000,
            max_response_bytes: 16,
            body: "{}".into(),
        };
        let body = api::send_plan(&plan_ok)
            .await
            .expect("within limit should succeed");
        assert_eq!(body, "{\"ok\":1}\n");
    }

    #[test]
    fn validate_remote_endpoint_rejects_bad_scheme_userinfo_and_control_chars() {
        assert_eq!(
            validate_remote_endpoint("http://127.0.0.1:9/mcp").unwrap(),
            "http://127.0.0.1:9/mcp"
        );
        assert_eq!(
            validate_remote_endpoint("https://mcp.example.com/v1").unwrap(),
            "https://mcp.example.com/v1"
        );
        assert_eq!(
            validate_remote_endpoint("HTTPS://[::1]:8443/mcp").unwrap(),
            "HTTPS://[::1]:8443/mcp"
        );

        for bad in [
            "ftp://example.com/mcp",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http:///mcp",
            "http://:8080/mcp",
            "http://127.0.0.1:9/mcp\r\nX-Inject: 1",
            "https://example.com/mcp\tbad",
            "https://example.com/mcp with space",
            "https://example.com/mcp\0null",
        ] {
            assert!(
                validate_remote_endpoint(bad).is_err(),
                "invalid endpoint must be rejected: {bad:?}"
            );
        }

        // userinfo 与 query 凭据不得回显到报错中。
        let err = validate_remote_endpoint(
            "https://alice:top-secret-pw@mcp.example.com/v1?api_key=leak-me",
        )
        .expect_err("userinfo must be rejected");
        let msg = err.to_string();
        assert!(!msg.contains("top-secret-pw"), "password leaked: {msg}");
        assert!(!msg.contains("leak-me"), "query leaked: {msg}");
        assert!(msg.contains("***@"), "expected redacted userinfo: {msg}");
    }

    #[tokio::test]
    async fn send_plan_propagates_vault_error_without_sending_http_request() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let _vault_lock = crate::credential_vault::vault_test_serial_async().await;
        let _vault_scope = VaultBackendScope::install(Arc::new(FailingVault {
            message: "[credential_vault] read: no-storage-access".to_string(),
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let contacted = Arc::new(AtomicBool::new(false));
        let contacted_flag = Arc::clone(&contacted);
        let server_task = tokio::spawn(async move {
            if let Ok((_socket, _)) = listener.accept().await {
                contacted_flag.store(true, Ordering::SeqCst);
            }
        });

        let plan = RemoteRequestPlan {
            server_id: "vault-err-server".into(),
            transport: "http".into(),
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            timeout_ms: 5_000,
            max_response_bytes: 1024,
            body: "{}".into(),
        };
        let err = api::send_plan(&plan)
            .await
            .expect_err("vault read error must not be swallowed");
        assert!(
            matches!(err, McpError::Vault(ref m) if m.contains("no-storage-access")),
            "expected McpError::Vault, got: {err:?}"
        );

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            !contacted.load(Ordering::SeqCst),
            "HTTP request must not be sent when credential vault lookup fails"
        );
        server_task.abort();
    }

    #[tokio::test]
    async fn send_plan_blocks_http_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let _vault_lock = crate::credential_vault::vault_test_serial_async().await;
        let _vault_scope =
            VaultBackendScope::install(std::sync::Arc::new(TestMemoryVault::default()));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut req_buf = [0u8; 2048];
                let _ = socket.read(&mut req_buf).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                let _ = socket.shutdown().await;
            }
        });

        let plan = RemoteRequestPlan {
            server_id: "redirect-server".into(),
            transport: "http".into(),
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            timeout_ms: 5_000,
            max_response_bytes: 1024,
            body: "{}".into(),
        };
        let err = api::send_plan(&plan)
            .await
            .expect_err("HTTP redirects must be rejected");
        assert!(
            matches!(err, McpError::Transport(ref m) if m.contains("302")),
            "expected 302 rejection, got: {err:?}"
        );
    }
}
