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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemotePayload {
    pub server_id: String,
    pub transport: String,
    pub body: String,
    /// 恒为 true：提示调用方「未经审计不得入库」。
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

fn endpoint_of(server_id: &str) -> Result<String, McpError> {
    let value = std::env::var(format!(
        "NB_MCP_ENDPOINT_{}",
        server_id.to_ascii_uppercase().replace('-', "_")
    ))
    .ok()
    .or_else(|| std::env::var("NB_MCP_ENDPOINT").ok());
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            McpError::NotConnected(
                "no remote endpoint configured for this server (set NB_MCP_ENDPOINT)".to_string(),
            )
        })
}

/// 建立远程会话：先过 opt-in 门，再从凭据库取 bearer。
pub fn mcp_remote_connect(
    project_root: &Path,
    server_id: &str,
) -> Result<RemoteSession, McpError> {
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
        guard
            .as_ref()
            .and_then(|map| map.get(server).cloned())
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

    let target = project_root.join(target_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let gate = crate::agent_gate::gate_authorize(
        "writeFile",
        &target.to_string_lossy(),
        crate::agent_gate::GateActor::External,
    );
    if !gate.may_proceed() {
        return Err(McpError::AuditBlocked(crate::agent_gate::gate_error(&gate)));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| McpError::Transport(format!("create dir failed: {e}")))?;
    }
    std::fs::write(&target, &payload.body)
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
        super::mcp_transport_set_mode(Path::new(&project_path), &transport, allow_http)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn mcp_remote_connect(
        project_path: String,
        server_id: String,
    ) -> Result<RemoteSession, String> {
        super::mcp_remote_connect(Path::new(&project_path), &server_id).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn mcp_remote_request(
        project_path: String,
        server_id: String,
        payload: String,
    ) -> Result<RemotePayload, String> {
        let plan = super::mcp_remote_request(Path::new(&project_path), &server_id, &payload)
            .map_err(|e| e.to_string())?;
        let body = send_plan(&plan).await.map_err(|e| e.to_string())?;
        Ok(RemotePayload {
            server_id: plan.server_id,
            transport: plan.transport,
            body,
            audit_pending: true,
            origin: plan.endpoint,
        })
    }

    #[tauri::command]
    pub async fn mcp_remote_close(server_id: String) -> Result<bool, String> {
        super::mcp_remote_close(&server_id).map_err(|e| e.to_string())
    }

    /// 按计划发送一次请求。鉴权仅 Bearer；响应体超限即拒绝。
    async fn send_plan(plan: &RemoteRequestPlan) -> Result<String, McpError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(plan.timeout_ms))
            .build()
            .map_err(|e| McpError::Transport(format!("client build failed: {e}")))?;

        let mut request = client
            .post(&plan.endpoint)
            .header("content-type", "application/json")
            .header("accept", "application/json");
        if plan.transport == "sse" {
            request = request.header("accept", "text/event-stream");
        }
        if let Ok(Some(token)) = crate::credential_vault::vault_get_secret(
            super::credential_key(&plan.server_id),
        ) {
            request = request.header("authorization", format!("Bearer {token}"));
        }

        let response = request
            .body(plan.body.clone())
            .send()
            .await
            .map_err(|e| McpError::Transport(format!("request failed: {e}")))?;

        if !response.status().is_success() {
            return Err(McpError::Transport(format!(
                "remote returned status {}",
                response.status()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| McpError::Transport(format!("read body failed: {e}")))?;
        if bytes.len() > plan.max_response_bytes {
            return Err(McpError::Transport(format!(
                "response exceeds {} bytes",
                plan.max_response_bytes
            )));
        }
        String::from_utf8(bytes.to_vec())
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

    #[test]
    fn remote_connect_requires_optin() {
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
        std::fs::write(&config_path, "{\"transport\":\"http\",\"allow_http\":false}")
            .expect("write config");
        let revoked = mcp_remote_request(&root, "demo", "{}").expect_err("opt-in 被撤销后必须拒");
        assert!(matches!(revoked, McpError::NotConnected(_)), "got {revoked:?}");
        mcp_remote_close("demo").unwrap();
        std::env::remove_var("NB_MCP_ENDPOINT");
        let _ = std::fs::remove_dir_all(&root);
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
                !root.join(".novel").join("mcp-incoming").join("payload.json").exists(),
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

    #[test]
    fn credential_key_is_namespaced() {
        assert_eq!(credential_key("github"), "mcp:github");
        assert!(!credential_key("github").contains('/'));
    }
}
