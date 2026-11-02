//! 对外 MCP 控制面（方案 `d23eb1df`，P0）。
//!
//! 应用内起一个**仅监听 `127.0.0.1`** 的 MCP 服务端，供 Claude Code / PI 等外部
//! Agent 以 MCP 客户端身份接入。P0 阶段**只读**：注册表里不得出现任何写工具
//! （`architecture-constraints-400`：控制台=只读投影锁定）。
//!
//! ## 边界
//!
//! * 只绑回环。没有 `0.0.0.0` 分支，没有端口转发支持——外部 Agent 必须与本应用同机。
//! * 鉴权是唯一一道门：无 token / 错 token 一律 401，且 token 为空时 fail-closed。
//! * 端口被占**明确报错**，不静默换端口（换端口会让已配好的客户端连到别的进程）。
//! * 启动失败不影响应用启动：调用方拿到 `Err` 后把「外部控制」标记为不可用即可。
//!
//! ## 为什么不用已有的 `mcp-test` feature
//!
//! 仓库里已有 `tauri-plugin-mcp-bridge`（feature `mcp-test`，WebSocket 9223），但那是
//! **dev-only 的 webview 调试控制面**——它驱动真实 webview 做 IPC 验真，且 release
//! 物理剥离。本模块是**产品能力**：类型化领域工具、随 release 发布、权限分层。
//! 两者用途不同，不能互相替代，也不共用端口。

pub mod auth;
pub mod protocol;
pub mod registry;
pub mod session;
pub mod state_bridge;
pub mod tools;

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{json, Value};

use protocol::{
    error_response, initialize_result, ok_response, tool_error, tool_result, JsonRpcRequest,
    INTERNAL_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR,
};
use registry::{ToolError, ToolRegistry};
use tools::ToolContext;

/// 默认监听端口。选 45871 是因为它不在既有占用表里（9223 是 mcp-bridge，
/// 2420 是 Vite dev，1420/1421 是 Tauri 默认 dev）。
pub const DEFAULT_PORT: u16 = 45871;

/// 服务端运行态。
pub struct ServerState {
    /// 当前有效 token。轮换后由上层替换整个 `ServerState`，不做原地变更。
    pub token: String,
    pub port: u16,
    pub registry: Arc<ToolRegistry>,
    /// 工具执行上下文（状态桥句柄 + 可选 AppHandle）。
    pub ctx: Arc<ToolContext>,
    /// 活跃会话表（设置页的「已连接会话」与可掐断依据）。
    pub sessions: Arc<session::SessionRegistry>,
}

/// 一次运行中的服务端句柄。
///
/// `stop()` 会 abort 监听任务——listener 随任务一起被 drop，端口真正释放。
/// 只把标志位置 false 不叫停止监听。
pub struct RunningServer {
    pub port: u16,
    abort: tokio::task::AbortHandle,
    /// 保留状态句柄，让 `mcp_server_status` 能读到会话表。
    state: Arc<ServerState>,
}

impl RunningServer {
    pub fn stop(&self) {
        self.abort.abort();
        // 监听一停，已握手会话就不该继续显示为「连着」。
        self.state.sessions.clear();
    }

    /// 当前会话快照。
    pub fn sessions(&self) -> Vec<session::SessionInfo> {
        self.state.sessions.list()
    }
}

/// 分发一条 JSON-RPC 请求。
///
/// 返回 `None` 表示这是通知（无 `id`），按 MCP 规范不得回响应体。
pub async fn dispatch(state: &ServerState, req: &JsonRpcRequest) -> Option<Value> {
    if req.is_notification() {
        // 通知一律不回响应；`notifications/initialized` 就是唯一会来的那种。
        return None;
    }
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => {
            let requested = req
                .params
                .as_ref()
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str());
            Some(ok_response(id, initialize_result(requested)))
        }
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, state.registry.list())),
        "tools/call" => Some(handle_tools_call(state, id, req.params.as_ref()).await),
        other => Some(error_response(
            Some(id),
            METHOD_NOT_FOUND,
            &format!("method not found: {other}"),
        )),
    }
}

/// `tools/call` 分支。
///
/// 区分两类失败，这个区分是 MCP 规范要求的、也是客户端重试逻辑的依据：
/// * **协议层**失败（参数缺失/工具不存在）→ JSON-RPC `error`
/// * **业务层**失败（工具跑了但没成）→ HTTP 200 + `isError: true`
async fn handle_tools_call(state: &ServerState, id: Value, params: Option<&Value>) -> Value {
    let Some(params) = params else {
        return error_response(Some(id), INVALID_REQUEST, "tools/call requires params");
    };
    let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
        return error_response(Some(id), INVALID_REQUEST, "tools/call requires params.name");
    };
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);

    match state.registry.call(&state.ctx, name, args).await {
        None => error_response(Some(id), METHOD_NOT_FOUND, &format!("unknown tool: {name}")),
        Some(Ok(value)) => ok_response(id, tool_result(&value)),
        Some(Err(ToolError { code, message })) => {
            // 参数类错误走 JSON-RPC error；其余按业务失败处理（200 + isError）。
            if code == protocol::INVALID_PARAMS {
                error_response(Some(id), code, &message)
            } else {
                ok_response(id, tool_error(&message))
            }
        }
    }
}

/// HTTP 入口。
async fn handle_mcp(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !auth::verify_authorization(auth_header, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "missing or invalid bearer token" })),
        )
            .into_response();
    }

    let req: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::OK,
                axum::Json(error_response(None, PARSE_ERROR, &format!("invalid JSON: {e}"))),
            )
                .into_response()
        }
    };

    // jsonrpc 字段必须是 "2.0"，否则按无效请求处理（不做宽松兼容）。
    if req.jsonrpc != "2.0" {
        return (
            StatusCode::OK,
            axum::Json(error_response(
                req.id.clone(),
                INVALID_REQUEST,
                "jsonrpc must be \"2.0\"",
            )),
        )
            .into_response();
    }

    // 会话：`initialize` 新建（并用 Mcp-Session-Id 头下发），其余请求按头更新活跃时间。
    // P0 不靠会话做鉴权——鉴权是 bearer token 的事，两者不混。
    let session_id = if req.method == "initialize" {
        Some(state.sessions.create())
    } else {
        if let Some(sid) = headers
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            state.sessions.touch(sid);
        }
        None
    };

    let mut resp = match dispatch(&state, &req).await {
        None => StatusCode::ACCEPTED.into_response(),
        Some(value) => (StatusCode::OK, axum::Json(value)).into_response(),
    };
    if let Some(sid) = session_id {
        if let Ok(value) = axum::http::HeaderValue::from_str(&sid) {
            resp.headers_mut()
                .insert(axum::http::HeaderName::from_static("mcp-session-id"), value);
        }
    }
    resp
}

/// 构造 router。单独抽出来便于在测试里直接驱动。
pub fn router(state: Arc<ServerState>) -> Router {
    Router::new().route("/mcp", post(handle_mcp)).with_state(state)
}

/// 绑定端口并启动监听（不持有 AppHandle，供测试与生产共用）。
async fn serve(state: ServerState, port: u16) -> Result<RunningServer, String> {
    if state.token.is_empty() {
        return Err("[mcp_server] refusing to start without a bearer token".to_string());
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("[mcp_server] bind 127.0.0.1:{port} failed: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("[mcp_server] local_addr failed: {e}"))?
        .port();

    let state = Arc::new(ServerState {
        port: bound,
        ..state
    });
    let app = router(Arc::clone(&state));

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("[mcp_server] serve stopped: {e}");
        }
    });

    Ok(RunningServer {
        port: bound,
        abort: handle.abort_handle(),
        state,
    })
}

/// 生产入口：带 AppHandle 启动（工具需要经状态桥读 WebView）。
pub async fn start(
    app: tauri::AppHandle,
    bridge: state_bridge::StateBridgeState,
    port: u16,
    token: String,
) -> Result<RunningServer, String> {
    let state = ServerState {
        token,
        port,
        registry: Arc::new(tools::build_registry()),
        ctx: Arc::new(ToolContext {
            app: Some(app),
            bridge,
            port,
        }),
        sessions: Arc::new(session::SessionRegistry::new()),
    };
    serve(state, port).await
}

/// 注册表里是否存在疑似写入类工具（P0/P1 安全断言用）。
///
/// 判据是**名字前缀/动词**，不是 schema 分析——故意做得保守：宁可误报也不要漏报。
pub fn contains_write_like_tool(registry: &ToolRegistry) -> Option<&'static str> {
    const WRITE_HINTS: [&str; 8] = [
        "set", "write", "update", "delete", "remove", "create", "save", "accept",
    ];
    registry.names().into_iter().find(|name| {
        let tail = name.rsplit('.').next().unwrap_or(name);
        WRITE_HINTS.iter().any(|h| tail.starts_with(h))
    })
}

/// 构造内部错误（供工具实现使用）。
pub fn internal_error(message: impl Into<String>) -> ToolError {
    ToolError {
        code: INTERNAL_ERROR,
        message: message.into(),
    }
}

// ── 生命周期托管与 Tauri 命令 ───────────────────────────────────────────────

/// 托管的服务端句柄。
///
/// **默认不启动**：开启外部控制是用户的显式动作，不是应用启动时的默认行为
/// （沿用仓库既有「最小攻击面」取向）。设置页的「外部控制」开关调
/// [`mcp_server_start`] / [`mcp_server_stop`]。
#[derive(Default)]
pub struct McpServerHandle {
    inner: std::sync::Mutex<Option<RunningServer>>,
}

impl McpServerHandle {
    /// 当前监听端口（未运行为 `None`）。
    pub fn port(&self) -> Option<u16> {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.port))
    }

    /// 当前会话快照（未运行则为空）。
    pub fn sessions(&self) -> Vec<session::SessionInfo> {
        match self.inner.lock() {
            Ok(g) => g.as_ref().map(|s| s.sessions()).unwrap_or_default(),
            Err(poisoned) => poisoned
                .into_inner()
                .as_ref()
                .map(|s| s.sessions())
                .unwrap_or_default(),
        }
    }

    fn replace(&self, next: Option<RunningServer>) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(previous) = guard.take() {
            previous.stop();
        }
        *guard = next;
    }
}

/// 服务端状态快照（供设置页展示）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub tool_count: usize,
    pub tools: Vec<&'static str>,
    /// 已连接会话（未运行时为空）。
    pub sessions: Vec<session::SessionInfo>,
    /// 连接地址（未运行时仍给出，供用户提前配置客户端）。
    pub endpoint: String,
}

/// 启动对外控制面。已在运行时幂等返回当前端口。
#[tauri::command]
pub async fn mcp_server_start(
    app: tauri::AppHandle,
    handle: tauri::State<'_, McpServerHandle>,
    bridge: tauri::State<'_, state_bridge::StateBridgeState>,
) -> Result<u16, String> {
    if let Some(port) = handle.port() {
        return Ok(port);
    }
    let token = auth::ensure_token()?;
    // `StateBridgeState` 内部持 `Arc`，克隆即共享同一张待决表。
    let server = start(app, bridge.inner().clone(), DEFAULT_PORT, token).await?;
    let port = server.port;
    handle.replace(Some(server));
    log::info!("[mcp_server] listening on 127.0.0.1:{port}");
    Ok(port)
}

/// 停止对外控制面；端口真正释放。未运行时为空操作。
#[tauri::command]
pub async fn mcp_server_stop(handle: tauri::State<'_, McpServerHandle>) -> Result<(), String> {
    handle.replace(None);
    Ok(())
}

/// 查询服务端状态。
#[tauri::command]
pub async fn mcp_server_status(
    handle: tauri::State<'_, McpServerHandle>,
) -> Result<McpServerStatus, String> {
    let port = handle.port();
    let registry = tools::build_registry();
    Ok(McpServerStatus {
        running: port.is_some(),
        port,
        tool_count: registry.len(),
        tools: registry.names(),
        sessions: handle.sessions(),
        endpoint: format!("http://127.0.0.1:{}/mcp", port.unwrap_or(DEFAULT_PORT)),
    })
}

/// 读取当前 bearer token（设置页默认掩码展示，点「显示」才用这个）。
#[tauri::command]
pub async fn mcp_server_token() -> Result<String, String> {
    auth::ensure_token()
}

/// 轮换 bearer token；若服务端在运行，则用新 token 重启，旧 token 立即失效。
#[tauri::command]
pub async fn mcp_server_rotate_token(
    app: tauri::AppHandle,
    handle: tauri::State<'_, McpServerHandle>,
    bridge: tauri::State<'_, state_bridge::StateBridgeState>,
) -> Result<String, String> {
    let token = auth::rotate_token()?;
    if handle.port().is_some() {
        let server = start(app, bridge.inner().clone(), DEFAULT_PORT, token.clone()).await?;
        handle.replace(Some(server));
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(token: &str) -> Arc<ServerState> {
        Arc::new(ServerState {
            token: token.to_string(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
        })
    }

    fn req(method: &str, params: Option<Value>) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: method.into(),
            params,
        }
    }

    #[tokio::test]
    async fn initialize_returns_server_info() {
        let out = dispatch(&state("t"), &req("initialize", None))
            .await
            .expect("has response");
        assert_eq!(out["result"]["serverInfo"]["name"], protocol::SERVER_NAME);
        assert!(out["result"]["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn tools_list_contains_read_only_tools() {
        let out = dispatch(&state("t"), &req("tools/list", None))
            .await
            .expect("has response");
        let names: Vec<&str> = out["result"]["tools"]
            .as_array()
            .expect("array")
            .iter()
            .map(|t| t["name"].as_str().unwrap_or(""))
            .collect();
        assert!(names.contains(&"app.ping"));
        assert!(names.contains(&"settings.get"));
    }

    #[tokio::test]
    async fn tools_call_unknown_tool_is_jsonrpc_error() {
        let out = dispatch(
            &state("t"),
            &req(
                "tools/call",
                Some(json!({"name": "nope.nope", "arguments": {}})),
            ),
        )
        .await
        .expect("has response");
        assert_eq!(out["error"]["code"], METHOD_NOT_FOUND);
        assert!(out["result"].is_null());
    }

    #[tokio::test]
    async fn tools_call_ping_returns_content_block() {
        let out = dispatch(
            &state("t"),
            &req("tools/call", Some(json!({"name": "app.ping", "arguments": {}}))),
        )
        .await
        .expect("has response");
        assert_eq!(out["result"]["isError"], false);
        assert_eq!(out["result"]["content"][0]["type"], "text");
    }

    #[tokio::test]
    async fn tools_call_app_status_reports_read_only() {
        let out = dispatch(
            &state("t"),
            &req(
                "tools/call",
                Some(json!({"name": "app.status", "arguments": {}})),
            ),
        )
        .await
        .expect("has response");
        assert_eq!(out["result"]["isError"], false);
        let text = out["result"]["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("\"readOnly\": true"), "{text}");
    }

    #[tokio::test]
    async fn tools_call_without_name_is_invalid_request() {
        let out = dispatch(&state("t"), &req("tools/call", Some(json!({}))))
            .await
            .expect("has response");
        assert_eq!(out["error"]["code"], INVALID_REQUEST);
    }

    #[tokio::test]
    async fn settings_get_without_key_is_invalid_params() {
        // 参数缺失属协议层错误 → JSON-RPC error（不是 200 + isError）。
        let out = dispatch(
            &state("t"),
            &req(
                "tools/call",
                Some(json!({"name": "settings.get", "arguments": {}})),
            ),
        )
        .await
        .expect("has response");
        assert_eq!(out["error"]["code"], protocol::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn settings_list_without_app_is_business_error() {
        // 测试上下文无 AppHandle：工具应报内部错误并走 200 + isError，
        // 而不是 panic 或静默返回空值。
        let out = dispatch(
            &state("t"),
            &req(
                "tools/call",
                Some(json!({"name": "settings.list", "arguments": {}})),
            ),
        )
        .await
        .expect("has response");
        assert_eq!(out["result"]["isError"], true);
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let out = dispatch(&state("t"), &req("nope/method", None))
            .await
            .expect("has response");
        assert_eq!(out["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn notification_gets_no_response() {
        let n = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: None,
            method: "notifications/initialized".into(),
            params: None,
        };
        assert!(dispatch(&state("t"), &n).await.is_none());
    }

    #[test]
    fn p0_registry_has_no_write_like_tool() {
        // 只读投影锁定的机械断言：P0 注册表不得出现写类工具。
        let reg = tools::build_registry();
        assert_eq!(contains_write_like_tool(&reg), None);
    }

    // ── 端到端：真起监听、真发 HTTP ────────────────────────────────────────

    async fn start_test_server() -> RunningServer {
        let state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
        };
        serve(state, 0).await.expect("start")
    }

    #[tokio::test]
    async fn server_rejects_missing_token() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 401);
        server.stop();
    }

    #[tokio::test]
    async fn server_rejects_wrong_token() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth("wrong")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 401);
        server.stop();
    }

    #[tokio::test]
    async fn server_serves_tools_list_with_valid_token() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 200);
        let body: Value = resp.json().await.expect("json");
        assert_eq!(body["result"]["tools"][0]["name"], "app.ping");
        server.stop();
    }

    #[tokio::test]
    async fn server_returns_202_for_notification() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 202);
        server.stop();
    }

    #[tokio::test]
    async fn initialize_issues_session_header_and_registers_session() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 200);
        let sid = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("initialize 必须下发 Mcp-Session-Id")
            .to_string();
        let sessions = server.sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, sid);
        assert_eq!(sessions[0].scope, "read");
        server.stop();
    }

    #[tokio::test]
    async fn stop_clears_sessions() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(server.sessions().len(), 1);
        server.stop();
        // 监听一停，已握手会话就不该继续显示为「连着」。
        assert_eq!(server.sessions().len(), 0);
    }

    #[tokio::test]
    async fn stop_releases_the_port() {
        let server = start_test_server().await;
        let port = server.port;
        server.stop();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let rebound = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
        assert!(rebound.is_ok(), "stop() 必须真正释放端口");
    }
}
