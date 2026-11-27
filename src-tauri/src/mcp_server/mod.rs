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
pub mod writes;

pub use session::ToolProfile;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
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

/// 单次 HTTP 请求体硬上限（4 MiB）。
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// 滑动窗口限流时长（秒）与窗口内最大请求数。
pub const RATE_LIMIT_WINDOW_SECS: u64 = 60;
pub const RATE_LIMIT_MAX_REQUESTS: usize = 300;

/// 鉴权连续失败触发退避的阈值与退避时长区间（秒）。
pub const AUTH_FAIL_BACKOFF_THRESHOLD: u32 = 5;
pub const AUTH_FAIL_BASE_BACKOFF_SECS: u64 = 2;
pub const AUTH_FAIL_MAX_BACKOFF_SECS: u64 = 60;

/// T5 叶子限流器：滑动窗口限流 + 鉴权失败指数退避（锁绝不跨 `.await` 持有）。
struct RateLimiter {
    window: Duration,
    max_requests: usize,
    timestamps: VecDeque<Instant>,
    consecutive_auth_failures: u32,
    auth_blocked_until: Option<Instant>,
}

impl RateLimiter {
    fn new(window: Duration, max_requests: usize) -> Self {
        Self {
            window,
            max_requests,
            timestamps: VecDeque::new(),
            consecutive_auth_failures: 0,
            auth_blocked_until: None,
        }
    }

    fn default_policy() -> Self {
        Self::new(
            Duration::from_secs(RATE_LIMIT_WINDOW_SECS),
            RATE_LIMIT_MAX_REQUESTS,
        )
    }

    fn check_and_record_request(&mut self, now: Instant) -> Result<(), u64> {
        if let Some(until) = self.auth_blocked_until {
            if now < until {
                return Err(until.saturating_duration_since(now).as_secs().max(1));
            }
            self.auth_blocked_until = None;
        }
        while let Some(&front) = self.timestamps.front() {
            if now.saturating_duration_since(front) >= self.window {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.timestamps.len() >= self.max_requests {
            let retry = self
                .timestamps
                .front()
                .map(|oldest| {
                    self.window
                        .saturating_sub(now.saturating_duration_since(*oldest))
                        .as_secs()
                        .max(1)
                })
                .unwrap_or(1);
            return Err(retry);
        }
        self.timestamps.push_back(now);
        Ok(())
    }

    fn record_auth_failure(&mut self, now: Instant) -> Option<u64> {
        self.consecutive_auth_failures = self.consecutive_auth_failures.saturating_add(1);
        if self.consecutive_auth_failures >= AUTH_FAIL_BACKOFF_THRESHOLD {
            let shift = (self.consecutive_auth_failures - AUTH_FAIL_BACKOFF_THRESHOLD).min(5);
            let backoff_secs =
                (AUTH_FAIL_BASE_BACKOFF_SECS << shift).min(AUTH_FAIL_MAX_BACKOFF_SECS);
            self.auth_blocked_until = Some(now + Duration::from_secs(backoff_secs));
            return Some(backoff_secs);
        }
        None
    }

    fn record_auth_success(&mut self) {
        self.consecutive_auth_failures = 0;
        self.auth_blocked_until = None;
    }
}

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
    /// 服务端授予的权限域。新会话在 `initialize` 时继承它，之后不随服务端变化。
    pub granted_scope: session::SessionScope,
    revoked: std::sync::atomic::AtomicBool,
    rate_limiter: Mutex<RateLimiter>,
}

/// 本地回环 MCP 服务的运行期绑定指纹（供同进程 ACP 会话活体检测漂移/停机）。
///
/// 安全不变量：
/// - 刻意不派生 `Serialize`，绝不直接透传给 WebView；
/// - 仅保存 Bearer token 的 SHA-256 十六进制摘要，绝不存明文 token；
/// - 手动实现 `Debug` 并对 `token_fingerprint` 脱敏，防止日志泄露凭据或摘要。
#[derive(Clone, PartialEq, Eq)]
pub struct LocalMcpBinding {
    pub port: u16,
    pub scope: session::SessionScope,
    pub token_fingerprint: String,
    pub generation: u64,
}

impl std::fmt::Debug for LocalMcpBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalMcpBinding")
            .field("port", &self.port)
            .field("scope", &self.scope)
            .field("token_fingerprint", &"<redacted>")
            .field("generation", &self.generation)
            .finish()
    }
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
    /// 单调递增实例代数（每次启动/重启/token 轮换递增），供 `LocalMcpBinding` 区分重启实例。
    generation: u64,
}

impl RunningServer {
    pub fn stop(&self) {
        self.state
            .revoked
            .store(true, std::sync::atomic::Ordering::Release);
        self.abort.abort();
        // 监听一停，已握手会话就不该继续显示为「连着」。
        self.state.sessions.clear();
    }

    /// 当前会话快照（先清理空闲超时会话）。
    pub fn sessions(&self) -> Vec<session::SessionInfo> {
        self.state.sessions.evict_expired();
        self.state.sessions.list()
    }

    /// 构造当前运行实例的脱敏绑定指纹（SHA-256 摘要，不含明文 token）。
    fn binding(&self) -> LocalMcpBinding {
        LocalMcpBinding {
            port: self.port,
            scope: self.state.granted_scope,
            token_fingerprint: writes::sha256_hex(self.state.token.as_bytes()),
            generation: self.generation,
        }
    }
}

/// 分发一条 JSON-RPC 请求。
///
/// 返回 `None` 表示这是通知（无 `id`），按 MCP 规范不得回响应体。
pub async fn dispatch(state: &ServerState, req: &JsonRpcRequest) -> Option<Value> {
    // 默认按**最小权限** + `FullLegacy` 分发：调用方没声明身份时不得获得写权限。
    dispatch_as(state, req, session::SessionScope::Read).await
}

/// 按调用方权限域分发（默认 `ToolProfile::FullLegacy`，保持既有全量兼容行为）。
pub async fn dispatch_as(
    state: &ServerState,
    req: &JsonRpcRequest,
    caller: session::SessionScope,
) -> Option<Value> {
    dispatch_as_with_profile(state, req, caller, session::ToolProfile::FullLegacy).await
}

/// 按调用方 `(SessionScope, ToolProfile)` 分发。
pub async fn dispatch_as_with_profile(
    state: &ServerState,
    req: &JsonRpcRequest,
    caller: session::SessionScope,
    profile: session::ToolProfile,
) -> Option<Value> {
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
        "tools/list" => Some(ok_response(id, state.registry.list_for(caller, profile))),
        "tools/call" => {
            Some(handle_tools_call(state, id, req.params.as_ref(), caller, profile).await)
        }
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
/// * **业务层**失败（工具被 Profile 隐藏 / scope 不足 / 工具执行失败）→ HTTP 200 + `isError: true`
async fn handle_tools_call(
    state: &ServerState,
    id: Value,
    params: Option<&Value>,
    caller: session::SessionScope,
    profile: session::ToolProfile,
) -> Value {
    let Some(params) = params else {
        return error_response(Some(id), INVALID_REQUEST, "tools/call requires params");
    };
    let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
        return error_response(Some(id), INVALID_REQUEST, "tools/call requires params.name");
    };
    let empty = json!({});
    let args = params.get("arguments").unwrap_or(&empty);

    // 1. 未知工具优先报标准 JSON-RPC -32601（不得被误归类为 Profile 隐藏）。
    let Some(required) = state.registry.required_scope(name) else {
        return error_response(Some(id), METHOD_NOT_FOUND, &format!("unknown tool: {name}"));
    };

    // 2. Profile 门控优先于 scope 门控：订阅写作模式下隐藏工具应直接给出零 LLM 替代方案。
    if !profile.allows(name) {
        let (replacements, message) = profile.blocked_guidance(name);
        let payload = json!({
            "code": "TOOL_HIDDEN_BY_PROFILE",
            "tool": name,
            "activeProfile": profile.as_str(),
            "replacementTools": replacements,
            "message": message,
        });
        let text = serde_json::to_string(&payload).unwrap_or_else(|_| payload.to_string());
        return ok_response(id, tool_error(&text));
    }

    // 3. 权限闸门放在请求管线里而不是工具实现里：授权是请求上下文的事，
    //    让每个工具自己判断会被漏掉一个。工具声明所需 scope，这里统一比对。
    if !caller.satisfies(required) {
        return ok_response(
            id,
            tool_error(&format!(
                "权限不足：{name} 需要 scope=\"{}\"，当前会话是 scope=\"{}\"。请在设置页「外部控制」里打开写入授权并重新连接客户端。",
                required.as_str(),
                caller.as_str()
            )),
        );
    }

    // 单个调用走请求局部上下文：把这一次的 caller + profile 带进工具，共享 `state.ctx`
    // 本身不被改写（它会被后续请求复用，写进去等于把授权串给别的会话）。
    let ctx = state.ctx.for_caller_with_profile(caller, profile);
    match state.registry.call(&ctx, name, args).await {
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

fn parse_strict_port(port_str: &str) -> Option<u16> {
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port_str.parse::<u16>().ok()
}

/// 解析回环 authority（`127.0.0.1` / `localhost` / `[::1]`，可选 `:port`）。
fn parse_loopback_authority(raw: &str) -> Option<Option<u16>> {
    if raw.is_empty() || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    if raw.starts_with('[') {
        let end = raw.find(']')?;
        if &raw[..=end] != "[::1]" {
            return None;
        }
        let rest = &raw[end + 1..];
        if rest.is_empty() {
            return Some(None);
        }
        let port_str = rest.strip_prefix(':')?;
        return Some(Some(parse_strict_port(port_str)?));
    }
    let (host, port) = match raw.split_once(':') {
        Some((h, p)) => (h, Some(parse_strict_port(p)?)),
        None => (raw, None),
    };
    if host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost") {
        Some(port)
    } else {
        None
    }
}

/// 校验 `Host` 头防 DNS Rebinding：须为回环地址且端口匹配（`expected_port == 0` 许任意合法 `u16`）。
fn is_allowed_host(headers: &HeaderMap, expected_port: u16) -> bool {
    let mut all = headers.get_all(axum::http::header::HOST).iter();
    let Some(first) = all.next() else {
        return false;
    };
    if all.next().is_some() {
        return false;
    }
    let Ok(host) = first.to_str() else {
        return false;
    };
    let Some(port_opt) = parse_loopback_authority(host) else {
        return false;
    };
    match port_opt {
        None => true,
        Some(port) => expected_port == 0 || port == expected_port,
    }
}

/// 校验 `Origin` 头防跨站 CSRF：缺失放行（非浏览器客户端），存在时仅允许回环与 Tauri WebView 源。
fn is_allowed_origin(headers: &HeaderMap) -> bool {
    let mut all = headers.get_all(axum::http::header::ORIGIN).iter();
    let Some(first) = all.next() else {
        return true;
    };
    if all.next().is_some() {
        return false;
    }
    let Ok(origin) = first.to_str() else {
        return false;
    };
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    if authority.is_empty()
        || authority
            .chars()
            .any(|c| matches!(c, '/' | '?' | '#' | '@') || c.is_control() || c.is_whitespace())
    {
        return false;
    }
    if scheme.eq_ignore_ascii_case("tauri") {
        return authority.eq_ignore_ascii_case("localhost");
    }
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        if authority.eq_ignore_ascii_case("tauri.localhost") {
            return true;
        }
        return parse_loopback_authority(authority).is_some();
    }
    false
}

fn rate_limited_response(error: &str, retry_after_secs: u64) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        axum::Json(json!({
            "error": error,
            "retryAfterSeconds": retry_after_secs,
        })),
    )
        .into_response();
    if let Ok(val) = HeaderValue::from_str(&retry_after_secs.to_string()) {
        resp.headers_mut()
            .insert(axum::http::header::RETRY_AFTER, val);
    }
    resp
}

/// 共享 HTTP 安全与鉴权闸门（`POST /mcp` 与 `DELETE /mcp` 同源复用，零绕过）：
/// 依次校验 Host（DNS Rebinding）、Origin（CSRF）、限流/退避与 Bearer Token。
fn verify_mcp_http_guards(state: &ServerState, headers: &HeaderMap) -> Option<Response> {
    if !is_allowed_host(headers, state.port) {
        return Some(
            (
                StatusCode::FORBIDDEN,
                axum::Json(json!({ "error": "forbidden host header" })),
            )
                .into_response(),
        );
    }
    if !is_allowed_origin(headers) {
        return Some(
            (
                StatusCode::FORBIDDEN,
                axum::Json(json!({ "error": "forbidden origin header" })),
            )
                .into_response(),
        );
    }

    let now = Instant::now();
    {
        let mut limiter = state.rate_limiter.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(retry_after) = limiter.check_and_record_request(now) {
            return Some(rate_limited_response("rate limit exceeded", retry_after));
        }
    }

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if state.revoked.load(std::sync::atomic::Ordering::Acquire) {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": "missing or invalid bearer token" })),
            )
                .into_response(),
        );
    }
    if !auth::verify_authorization(auth_header, &state.token) {
        let backoff = {
            let mut limiter = state.rate_limiter.lock().unwrap_or_else(|e| e.into_inner());
            limiter.record_auth_failure(now)
        };
        if let Some(retry_after) = backoff {
            return Some(rate_limited_response(
                "too many authentication failures",
                retry_after,
            ));
        }
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": "missing or invalid bearer token" })),
            )
                .into_response(),
        );
    }
    {
        let mut limiter = state.rate_limiter.lock().unwrap_or_else(|e| e.into_inner());
        limiter.record_auth_success();
    }
    None
}

const MAX_CLIENT_INFO_NAME_CHARS: usize = 128;
const MAX_CLIENT_INFO_VERSION_CHARS: usize = 64;

/// 清洗 `initialize` 的 `params.clientInfo.{name, version}`：剥离控制字符并按字符数截断（UTF-8 安全）。
fn sanitize_client_info_field(raw: Option<&str>, max_chars: usize) -> Option<String> {
    let value = raw?;
    let cleaned: String = value
        .chars()
        .filter(|c| !c.is_control())
        .skip_while(|c| c.is_whitespace())
        .take(max_chars)
        .collect();
    let trimmed = cleaned.trim_end();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 解析并严格校验请求携带的 MCP `ToolProfile`（来自 `?profile=` 查询参数与 `X-Niko-Profile` 头）。
///
/// 全部异常场景均 fail-closed 返回 `Err`（由 `handle_mcp` 映射为 HTTP `400 Bad Request`）：
/// - 空值或未知 profile（如 `?profile`、`?profile=`、`?profile=admin`、`X-Niko-Profile: invalid`）；
/// - 重复 `?profile` 查询参数或重复 `X-Niko-Profile` 请求头；
/// - `X-Niko-Profile` 含非 ASCII/无效编码；
/// - query 与 header 同时存在但值冲突。
fn resolve_requested_profile(
    raw_query: Option<&str>,
    headers: &HeaderMap,
) -> Result<Option<session::ToolProfile>, String> {
    let mut query_profile: Option<session::ToolProfile> = None;
    if let Some(query) = raw_query {
        for segment in query.split('&') {
            if segment.is_empty() {
                continue;
            }
            let (key, val_opt) = match segment.split_once('=') {
                Some((k, v)) => (k, Some(v)),
                None => (segment, None),
            };
            if key == "profile" {
                if query_profile.is_some() {
                    return Err("duplicate `profile` query parameter".to_string());
                }
                let raw_val = val_opt.unwrap_or("");
                let parsed = session::ToolProfile::parse(raw_val).ok_or_else(|| {
                    format!(
                        "invalid MCP tool profile in query: `{raw_val}` (expected writer-sub | reviewer | architect | full-legacy)"
                    )
                })?;
                query_profile = Some(parsed);
            }
        }
    }

    let mut header_values = headers.get_all("x-niko-profile").iter();
    let header_profile = match header_values.next() {
        None => None,
        Some(first) => {
            if header_values.next().is_some() {
                return Err("duplicate `X-Niko-Profile` header".to_string());
            }
            let raw_val = first
                .to_str()
                .map_err(|_| "invalid `X-Niko-Profile` header encoding".to_string())?;
            let parsed = session::ToolProfile::parse(raw_val).ok_or_else(|| {
                format!(
                    "invalid MCP tool profile in `X-Niko-Profile` header: `{raw_val}` (expected writer-sub | reviewer | architect | full-legacy)"
                )
            })?;
            Some(parsed)
        }
    };

    match (query_profile, header_profile) {
        (Some(q), Some(h)) if q != h => Err(format!(
            "conflicting MCP tool profile: query `{}` vs header `{}`",
            q.as_str(),
            h.as_str()
        )),
        (Some(q), _) => Ok(Some(q)),
        (None, Some(h)) => Ok(Some(h)),
        (None, None) => Ok(None),
    }
}

/// HTTP 入口（MCP Streamable HTTP `POST /mcp`）。
async fn handle_mcp(
    State(state): State<Arc<ServerState>>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(json!({ "error": "request body exceeds limit" })),
        )
            .into_response();
    }
    if let Some(resp) = verify_mcp_http_guards(&state, &headers) {
        return resp;
    }

    let requested_profile = match resolve_requested_profile(raw_query.as_deref(), &headers) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, axum::Json(json!({ "error": msg }))).into_response();
        }
    };

    let req: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::OK,
                axum::Json(error_response(
                    None,
                    PARSE_ERROR,
                    &format!("invalid JSON: {e}"),
                )),
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

    // 会话：`initialize` 新建（并用 Mcp-Session-Id 头下发，同时冻结 ToolProfile），
    // 其余请求按头更新活跃时间并核验冻结 Profile（禁止中途切换/提权）。
    // P0 不靠会话做鉴权——鉴权是 bearer token 的事，两者不混。
    // 调用方权限域：`initialize` 时按服务端授予值新建会话；其余请求按会话 id 查表，
    // 未知/缺失 id 一律降到最小权限 `Read`（不隐式创建、不默认放行）。
    let (session_id, caller_scope, caller_profile) = if req.method == "initialize" {
        let client_info = req.params.as_ref().and_then(|p| p.get("clientInfo"));
        let client_name = sanitize_client_info_field(
            client_info
                .and_then(|ci| ci.get("name"))
                .and_then(|v| v.as_str()),
            MAX_CLIENT_INFO_NAME_CHARS,
        );
        let client_version = sanitize_client_info_field(
            client_info
                .and_then(|ci| ci.get("version"))
                .and_then(|v| v.as_str()),
            MAX_CLIENT_INFO_VERSION_CHARS,
        );
        let frozen_profile = requested_profile.unwrap_or(session::ToolProfile::FullLegacy);
        (
            Some(state.sessions.create_with_client_and_profile(
                state.granted_scope,
                client_name,
                client_version,
                frozen_profile,
            )),
            state.granted_scope,
            frozen_profile,
        )
    } else {
        let sid = headers.get("mcp-session-id").and_then(|v| v.to_str().ok());
        let (scope, profile) = match sid {
            Some(id) => {
                // 先驱逐过期会话，避免陈旧冻结 profile 被命中；且把 `touch(id)` 放在
                // profile 校验通过之后，防止被 400 拒绝的提权尝试刷新活跃时间或计数。
                state.sessions.evict_expired();
                if let Some(frozen) = state.sessions.profile_of(id) {
                    if let Some(req_prof) = requested_profile {
                        if req_prof != frozen {
                            return (
                                StatusCode::BAD_REQUEST,
                                axum::Json(json!({
                                    "error": format!(
                                        "MCP tool profile is frozen for this session: requested `{}` does not match session profile `{}`",
                                        req_prof.as_str(),
                                        frozen.as_str()
                                    )
                                })),
                            )
                                .into_response();
                        }
                    }
                    state.sessions.touch(id);
                    // 必须走 `effective_scope`（scope 叠加逐会话 full/auto 授权）。
                    let scope = state
                        .sessions
                        .effective_scope(id)
                        .unwrap_or(session::SessionScope::Read);
                    (scope, frozen)
                } else {
                    (
                        session::SessionScope::Read,
                        requested_profile.unwrap_or(session::ToolProfile::FullLegacy),
                    )
                }
            }
            None => (
                session::SessionScope::Read,
                requested_profile.unwrap_or(session::ToolProfile::FullLegacy),
            ),
        };
        (None, scope, profile)
    };

    let mut resp = match dispatch_as_with_profile(&state, &req, caller_scope, caller_profile).await
    {
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

/// MCP Streamable HTTP 会话终止入口（`DELETE /mcp`）：校验同一套安全/鉴权闸门后移除对应 `Mcp-Session-Id`。
async fn handle_mcp_delete(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    if let Some(resp) = verify_mcp_http_guards(&state, &headers) {
        return resp;
    }
    if let Some(sid) = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        state.sessions.remove(sid);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// 构造 router。单独抽出来便于在测试里直接驱动。
/// 支持 `POST /mcp`（请求/通知）与 `DELETE /mcp`（会话终止）；`GET /mcp` 按 MCP Streamable HTTP 规范返回 `405 Method Not Allowed`。
pub fn router(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/mcp", post(handle_mcp).delete(handle_mcp_delete))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

/// 绑定端口并启动监听（不持有 AppHandle，供测试与生产共用）。
async fn serve(state: ServerState, port: u16) -> Result<RunningServer, String> {
    if state.token.is_empty() {
        return Err("[mcp_server] refusing to start without a bearer token".to_string());
    }
    // 换 scope / 轮换 token 都是「先停旧监听再起新监听」。旧监听是 `abort` 掉的，
    // 内核释放端口比 abort 返回稍晚，紧接着重绑会撞 `10048 端口占用`。
    // 这里做有界重试：端口最终一定会释放，但第一次 bind 常常抢不过内核。
    // 重试是兜底而不是延迟预算——正常情况下第一次就成功。
    let mut listener = None;
    let mut last_err = None;
    for attempt in 0..20u32 {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt == 0 {
                    // 只在第一次留痕，避免正常重启刷出 20 行日志。
                    log::debug!("[mcp_server] bind 127.0.0.1:{port} 暂不可用，重试中");
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
    let listener = listener.ok_or_else(|| {
        format!(
            "[mcp_server] bind 127.0.0.1:{port} failed after retries: {}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )
    })?;
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
        generation: 0,
    })
}

/// 生产入口：带 AppHandle 启动（工具需要经状态桥读 WebView）。
pub async fn start(
    app: tauri::AppHandle,
    bridge: state_bridge::StateBridgeState,
    port: u16,
    token: String,
    granted_scope: session::SessionScope,
) -> Result<RunningServer, String> {
    let state = ServerState {
        token,
        port,
        registry: Arc::new(tools::build_registry()),
        ctx: Arc::new(ToolContext {
            app: Some(app),
            bridge,
            port,
            // 共享上下文的基线是「无调用方」= 最小权限 + FullLegacy。每次请求由
            // `handle_tools_call` 用 `for_caller_with_profile` 派生局部副本。
            caller_scope: session::SessionScope::Read,
            caller_profile: session::ToolProfile::FullLegacy,
        }),
        sessions: Arc::new(session::SessionRegistry::new()),
        granted_scope,
        revoked: std::sync::atomic::AtomicBool::new(false),
        rate_limiter: Mutex::new(RateLimiter::default_policy()),
    };
    serve(state, port).await
}

/// 注册表里是否有**名字像写**的工具（安全断言用）。
///
/// 判据是**名字前缀/动词**，不是 schema 分析——故意做得保守：宁可误报也不要漏报。
/// P1 起 `settings.set` 是唯一允许的例外（它也确实需要 `Settings` scope，
/// 见 [`ToolRegistry::write_scope_tools`]）；两者要一起看：
/// * 名字像写但 `required_scope() == Read` → 危险（名字在撒谎，权限没拦住）
/// * 需要写 scope 但名字不像写 → 可疑（客户端难以从名字判断副作用）
pub fn contains_write_like_tool(registry: &ToolRegistry) -> Vec<&'static str> {
    const WRITE_HINTS: [&str; 12] = [
        "set", "write", "update", "delete", "remove", "create", "save", "accept", "patch",
        "record", "upsert", "commit",
    ];
    registry
        .names()
        .into_iter()
        .filter(|name| {
            let tail = name.rsplit('.').next().unwrap_or(name);
            WRITE_HINTS.iter().any(|h| tail.starts_with(h))
        })
        .collect()
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
    lifecycle: tokio::sync::Mutex<()>,
    generation: std::sync::atomic::AtomicU64,
}

impl McpServerHandle {
    /// 当前监听端口（未运行为 `None`）。
    pub fn port(&self) -> Option<u16> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|s| s.port)
    }

    /// 当前授予的权限域（未运行为 `None`）。
    pub fn scope(&self) -> Option<session::SessionScope> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|s| s.state.granted_scope)
    }

    /// 返回当前运行实例的脱敏绑定指纹（端口、scope、token SHA-256 摘要、单调代数）。
    /// 绝不暴露明文 Bearer token。
    pub async fn running_binding_fingerprint(&self) -> Option<LocalMcpBinding> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(RunningServer::binding)
    }

    /// 供同进程官方 ACP 会话（`antigravity_acp_new_session`）读取当前运行中的本地回环端口、
    /// Bearer token 与脱敏绑定指纹。仅限 Rust crate 内部使用（`pub(crate)`），绝不向 webview 或日志泄露明文 token。
    pub(crate) async fn running_connection_info_with_binding(
        &self,
    ) -> Option<(u16, String, LocalMcpBinding)> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .map(|server| (server.port, server.state.token.clone(), server.binding()))
    }

    /// 供同进程官方 ACP 会话读取当前运行中的本地回环端口、Bearer token 与授予权限域。
    /// 仅限 Rust crate 内部使用（`pub(crate)`），绝不向 webview 泄露明文 token。
    #[allow(dead_code)]
    pub(crate) fn running_connection_info_with_scope(
        &self,
    ) -> Option<(u16, String, session::SessionScope)> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|server| {
            (
                server.port,
                server.state.token.clone(),
                server.state.granted_scope,
            )
        })
    }

    /// 供同进程官方 ACP 会话读取当前运行中的本地回环端口与 Bearer token。
    /// 仅限 Rust crate 内部使用（`pub(crate)`），绝不向 webview 泄露明文 token。
    #[allow(dead_code)]
    pub(crate) fn running_connection_info(&self) -> Option<(u16, String)> {
        self.running_connection_info_with_scope()
            .map(|(port, token, _scope)| (port, token))
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

    /// 在运行中服务端的状态上执行一段闭包；未运行返回 `None`。
    ///
    /// 给 `mcp_session_grant_full` / `revoke_full` 用：它们要改的是会话表本体，
    /// 而不是快照。
    fn with_state<R>(&self, f: impl FnOnce(&ServerState) -> R) -> Option<R> {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.as_ref().map(|running| f(&running.state))
    }

    fn replace(&self, next: Option<RunningServer>) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(previous) = guard.take() {
            previous.stop();
        }
        *guard = next.map(|mut server| {
            server.generation = self
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                + 1;
            server
        });
    }

    /// 停止运行中的服务端并释放监听端口（进程退出清理用）。
    pub fn stop(&self) {
        self.replace(None);
    }
}

/// 服务端状态快照（供设置页展示）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub tool_count: usize,
    pub tools: Vec<&'static str>,
    /// 当前授予外部 Agent 的权限域（未运行时给出「将会授予」的值，便于界面回显）。
    pub scope: session::SessionScope,
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
    scope: Option<String>,
) -> Result<u16, String> {
    // 缺省 = 只读：不传 scope 的老调用方（含测试）不会因为这次改动凭空拿到写权限。
    let granted = match scope.as_deref() {
        None => session::SessionScope::Read,
        Some(raw) => session::SessionScope::parse(raw)
            .ok_or_else(|| format!("未知 scope: {raw}（只接受 read / settings / project）"))?,
    };
    // `full` 与 `auto` 不能在启动时授予：客户端带着 token 重新 initialize 就能拿到，
    // 而用户根本不知道发过。它们只能逐会话授权（见 `mcp_session_grant_full` /
    // `mcp_session_grant_auto`）。
    if granted == session::SessionScope::Full {
        return Err(
            "full 不能在启动时授予。请先用 read / settings / project 启动，再到设置页「外部控制」里对具体会话点「授予完整写入」。".to_string(),
        );
    }
    if granted == session::SessionScope::Auto {
        return Err(
            "auto 不能在启动时授予。请先用 read / settings / project 启动，再到设置页「外部控制」里对具体会话点「授予自动编排」。".to_string(),
        );
    }

    let _lifecycle = handle.lifecycle.lock().await;
    if let Some(port) = handle.port() {
        // 已在运行：scope 未变则幂等返回；变了就按新 scope 重启。
        // 静默忽略 scope 变化会让界面上的开关看起来生效了、实际没生效。
        if handle.scope() == Some(granted) {
            return Ok(port);
        }
        handle.replace(None);
        log::info!("[mcp_server] scope changed to {granted:?}, restarting");
    }

    let token = auth::ensure_token()?;
    // `StateBridgeState` 内部持 `Arc`，克隆即共享同一张待决表。
    let server = start(app, bridge.inner().clone(), DEFAULT_PORT, token, granted).await?;
    let port = server.port;
    handle.replace(Some(server));
    log::info!("[mcp_server] listening on 127.0.0.1:{port} (scope={granted:?})");
    Ok(port)
}

/// 对**具体会话**授予完整写入（`full`）。
///
/// ## 为什么不给「整个服务端」开一个 full 档
///
/// 服务端级 full 等于「从现在起连上来的任何人都能直写正文」。用户点这一下时心里
/// 想的是「让屏幕上这个客户端能写」，不是「给未来所有客户端开门」。所以授权落在
/// 会话上：用户看到的是哪个会话，授权的就是哪个。
#[tauri::command]
pub async fn mcp_session_grant_full(
    handle: tauri::State<'_, McpServerHandle>,
    session_id: String,
) -> Result<(), String> {
    let granted = handle
        .with_state(|state| {
            state.sessions.evict_expired();
            state.sessions.grant_full(&session_id)
        })
        .ok_or_else(|| "服务未运行，没有可授权的会话".to_string())?;
    if granted {
        log::info!("[mcp_server] full write granted to session {session_id}");
        Ok(())
    } else {
        Err(format!(
            "没有这个会话：{session_id}（可能已断开，请刷新会话列表）"
        ))
    }
}

/// 吊销某会话的完整写入。不影响它原有的 scope。
#[tauri::command]
pub async fn mcp_session_revoke_full(
    handle: tauri::State<'_, McpServerHandle>,
    session_id: String,
) -> Result<(), String> {
    let revoked = handle
        .with_state(|state| state.sessions.revoke_full(&session_id))
        .ok_or_else(|| "服务未运行，没有可吊销的会话".to_string())?;
    if revoked {
        log::info!("[mcp_server] full write revoked for session {session_id}");
        Ok(())
    } else {
        Err(format!(
            "没有这个会话：{session_id}（可能已断开，请刷新会话列表）"
        ))
    }
}

/// 对**具体会话**授予自动编排（`auto` = settings + project，不含直写正文）。
///
/// 与 `full` 同理落在会话上而不是服务端：「让屏幕上这个客户端能跑全流程」不等于
/// 「给未来所有客户端开门」。它与 `full` 分开的只是「能不能不经草稿改正文」。
#[tauri::command]
pub async fn mcp_session_grant_auto(
    handle: tauri::State<'_, McpServerHandle>,
    session_id: String,
) -> Result<(), String> {
    let granted = handle
        .with_state(|state| {
            state.sessions.evict_expired();
            state.sessions.grant_auto(&session_id)
        })
        .ok_or_else(|| "服务未运行，没有可授权的会话".to_string())?;
    if granted {
        log::info!("[mcp_server] auto orchestration granted to session {session_id}");
        Ok(())
    } else {
        Err(format!(
            "没有这个会话：{session_id}（可能已断开，请刷新会话列表）"
        ))
    }
}

/// 吊销某会话的自动编排。不影响它原有的 scope 与 `full` 授权。
#[tauri::command]
pub async fn mcp_session_revoke_auto(
    handle: tauri::State<'_, McpServerHandle>,
    session_id: String,
) -> Result<(), String> {
    let revoked = handle
        .with_state(|state| state.sessions.revoke_auto(&session_id))
        .ok_or_else(|| "服务未运行，没有可吊销的会话".to_string())?;
    if revoked {
        log::info!("[mcp_server] auto orchestration revoked for session {session_id}");
        Ok(())
    } else {
        Err(format!(
            "没有这个会话：{session_id}（可能已断开，请刷新会话列表）"
        ))
    }
}

/// 停止对外控制面；端口真正释放。未运行时为空操作。
#[tauri::command]
pub async fn mcp_server_stop(handle: tauri::State<'_, McpServerHandle>) -> Result<(), String> {
    let _lifecycle = handle.lifecycle.lock().await;
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
        scope: handle.scope().unwrap_or(session::SessionScope::Read),
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
    let _lifecycle = handle.lifecycle.lock().await;
    let previous_scope = handle.scope();
    handle.replace(None);
    let token = auth::rotate_token()?;
    if let Some(granted) = previous_scope {
        let server = start(
            app,
            bridge.inner().clone(),
            DEFAULT_PORT,
            token.clone(),
            granted,
        )
        .await?;
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
            granted_scope: session::SessionScope::Read,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
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

    /// `tools/call` 返回的 content 文本里是紧凑单行 JSON（`serde_json::to_string`）的工具结果。
    fn tool_payload(out: &Value) -> Value {
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text");
        serde_json::from_str(text).expect("app.status payload 必须是 JSON")
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
            &req(
                "tools/call",
                Some(json!({"name": "app.ping", "arguments": {}})),
            ),
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
        assert!(!text.contains('\n'), "compact JSON 必须是单行: {text}");
        let parsed: Value = serde_json::from_str(text).expect("valid JSON");
        assert_eq!(parsed["readOnly"], json!(true), "{text}");
        // 默认 dispatch 没有声明调用方 → 最小权限 + full-legacy profile。
        assert_eq!(parsed["scope"], json!("read"), "{text}");
        assert_eq!(parsed["profile"], json!("full-legacy"), "{text}");
    }

    /// 五档 scope 各自正确，且请求局部 scope 不污染共享上下文。
    #[tokio::test]
    async fn app_status_reports_the_request_local_caller_scope() {
        let state = state("t");
        let cases = [
            (session::SessionScope::Read, true, "read"),
            (session::SessionScope::Settings, false, "settings"),
            (session::SessionScope::Project, false, "project"),
            (session::SessionScope::Auto, false, "auto"),
            (session::SessionScope::Full, false, "full"),
        ];
        for (caller, read_only, scope) in cases {
            let out = dispatch_as(
                &state,
                &req(
                    "tools/call",
                    Some(json!({"name": "app.status", "arguments": {}})),
                ),
                caller,
            )
            .await
            .expect("has response");
            let payload = tool_payload(&out);
            assert_eq!(
                payload["readOnly"],
                json!(read_only),
                "{caller:?}: {payload}"
            );
            assert_eq!(payload["scope"], json!(scope), "{caller:?}: {payload}");
            // 共享 ctx 是全局资源：任何一次请求都不能把自己的 scope 写回去。
            assert_eq!(
                state.ctx.caller_scope,
                session::SessionScope::Read,
                "{caller:?} 的请求 scope 污染了共享上下文"
            );
        }
        // 紧接着的默认（Read）请求仍然只读。
        let out = dispatch(
            &state,
            &req(
                "tools/call",
                Some(json!({"name": "app.status", "arguments": {}})),
            ),
        )
        .await
        .expect("has response");
        assert_eq!(tool_payload(&out)["readOnly"], json!(true));
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
    fn only_settings_set_carries_write_scope() {
        // P0 只读态由 scope 闸门保证，而不是靠"注册表里没有写工具"：
        // 唯一的写类工具必须声明 Settings scope，其余一律 Read。
        let reg = tools::build_registry();
        let write_like = contains_write_like_tool(&reg);
        assert!(write_like.contains(&"settings.set"), "实际: {write_like:?}");
        assert!(
            write_like.contains(&"chapter.write"),
            "实际: {write_like:?}"
        );
        assert!(
            write_like.contains(&"outline.write"),
            "实际: {write_like:?}"
        );
        assert!(write_like.contains(&"memory.write"), "实际: {write_like:?}");
        assert!(write_like.contains(&"draft.patch"), "实际: {write_like:?}");
        assert!(
            write_like.contains(&"draft.record_review"),
            "实际: {write_like:?}"
        );
        for new_write in [
            "character.upsert",
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(
                write_like.contains(&new_write),
                "WRITE_HINTS 必须命中 {new_write}，实际: {write_like:?}"
            );
        }
        let privileged = reg.privileged_tools();
        for name in &write_like {
            assert!(privileged.contains(name), "{name} 名字像写却没声明权限");
        }
    }

    #[tokio::test]
    async fn settings_set_is_rejected_for_read_scope_sessions() {
        // 最小权限：dispatch（默认 Read）调写工具必须被拒，且错误要说清怎么开权限。
        let out = dispatch(
            &state("t"),
            &req(
                "tools/call",
                Some(
                    json!({"name": "settings.set", "arguments": {"key": "theme", "value": "dark"}}),
                ),
            ),
        )
        .await
        .expect("has response");
        let result = &out["result"];
        assert_eq!(result["isError"], json!(true));
        let text = result["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("权限不足"), "实际: {text}");
        assert!(text.contains("settings"), "实际: {text}");
    }

    #[tokio::test]
    async fn settings_set_passes_the_gate_with_settings_scope() {
        // 有权限时不再被闸门拦，而是走到工具实现（此处无 AppHandle → 桥不可用）。
        let out = dispatch_as(
            &state("t"),
            &req(
                "tools/call",
                Some(
                    json!({"name": "settings.set", "arguments": {"key": "theme", "value": "dark"}}),
                ),
            ),
            session::SessionScope::Settings,
        )
        .await
        .expect("has response");
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(!text.contains("权限不足"), "不应被权限闸门拦截: {text}");
        assert!(text.contains("状态桥"), "应因缺少 AppHandle 失败: {text}");
    }

    /// P2：五个项目动作工具在 Read / Settings 下必须全部被拒。
    #[tokio::test]
    async fn project_tools_are_rejected_below_project_scope() {
        let project_tools: [(&str, Value); 4] = [
            ("pipeline.run_chapter", json!({"userRequest": "写一章"})),
            ("pipeline.status", json!({"taskId": "ptask_x"})),
            ("gate.run", json!({"taskId": "ptask_x"})),
            (
                "chapter.write",
                json!({"chapterName": "第一章", "content": "正文"}),
            ),
        ];
        for caller in [session::SessionScope::Read, session::SessionScope::Settings] {
            for (name, args) in project_tools.clone() {
                let out = dispatch_as(
                    &state("t"),
                    &req("tools/call", Some(json!({"name": name, "arguments": args}))),
                    caller,
                )
                .await
                .expect("has response");
                let text = out["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default();
                assert!(
                    text.contains("权限不足"),
                    "{name} 在 {caller:?} 下应被拒，实际: {text}"
                );
                assert!(
                    text.contains("project"),
                    "{name} 的拒绝信息应点出需要的 scope，实际: {text}"
                );
            }
        }
    }

    /// 只读会话不得因为新增项目工具而顺带拿到设置写权限，反之亦然。
    #[tokio::test]
    async fn settings_set_still_works_under_settings_scope_with_project_tools_present() {
        let out = dispatch_as(
            &state("t"),
            &req(
                "tools/call",
                Some(
                    json!({"name": "settings.set", "arguments": {"key": "theme", "value": "dark"}}),
                ),
            ),
            session::SessionScope::Settings,
        )
        .await
        .expect("has response");
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(
            !text.contains("权限不足"),
            "Settings 应能调 settings.set: {text}"
        );
        // 而 Project scope 不得顺带拿到设置写权限
        let out2 = dispatch_as(
            &state("t"),
            &req(
                "tools/call",
                Some(
                    json!({"name": "settings.set", "arguments": {"key": "theme", "value": "dark"}}),
                ),
            ),
            session::SessionScope::Project,
        )
        .await
        .expect("has response");
        let text2 = out2["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(
            text2.contains("权限不足"),
            "Project 不应顺带写设置: {text2}"
        );
    }

    /// 非法参数必须在**起任务之前**被拒：留一个注定失败的任务会误导调用方。
    #[tokio::test]
    async fn pipeline_run_chapter_rejects_invalid_arguments_before_starting() {
        let cases = [
            (json!({}), "userRequest"),
            (json!({"userRequest": ""}), "userRequest"),
            (json!({"userRequest": "x", "chapterNumber": 0}), "正整数"),
            (json!({"userRequest": "x", "chapterNumber": -3}), "正整数"),
            (
                json!({"userRequest": "x", "workflowMode": "turbo"}),
                "fast / standard / strict",
            ),
        ];
        for (args, needle) in cases {
            let out = dispatch_as(
                &state("t"),
                &req(
                    "tools/call",
                    Some(json!({"name": "pipeline.run_chapter", "arguments": args})),
                ),
                session::SessionScope::Project,
            )
            .await
            .expect("has response");
            // 参数缺失/非法是**协议层**错误：走 JSON-RPC error，不是 200+isError。
            let text = out["error"]["message"].as_str().unwrap_or_default();
            assert!(text.contains(needle), "期望错误含 {needle}，实际: {text}");
        }
    }

    #[tokio::test]
    async fn pipeline_status_and_gate_run_require_task_id() {
        for name in ["pipeline.status", "gate.run"] {
            let out = dispatch_as(
                &state("t"),
                &req("tools/call", Some(json!({"name": name, "arguments": {}}))),
                session::SessionScope::Project,
            )
            .await
            .expect("has response");
            let text = out["error"]["message"].as_str().unwrap_or_default();
            assert!(
                text.contains("taskId"),
                "{name} 应要求 taskId，实际: {text}"
            );
        }
    }

    #[tokio::test]
    async fn draft_write_tools_require_both_fields() {
        let cases: [(&str, Value, session::SessionScope); 4] = [
            (
                "chapter.write",
                json!({"content": "正文"}),
                session::SessionScope::Project,
            ),
            (
                "chapter.write",
                json!({"chapterName": "第一章"}),
                session::SessionScope::Project,
            ),
            (
                "memory.write",
                json!({"name": "设定"}),
                session::SessionScope::Full,
            ),
            (
                "chapter.write_direct",
                json!({"chapterName": "第一章"}),
                session::SessionScope::Full,
            ),
        ];
        for (name, args, caller) in cases {
            let out = dispatch_as(
                &state("t"),
                &req("tools/call", Some(json!({"name": name, "arguments": args}))),
                caller,
            )
            .await
            .expect("has response");
            let text = out["error"]["message"].as_str().unwrap_or_default();
            assert!(
                text.contains("缺少") || text.contains("不能为空"),
                "{name} 缺参数应报错，实际: {text}"
            );
        }
    }

    /// P3：直写与回滚工具在 full 以下必须全部被拒，且错误点出需要 full。
    #[tokio::test]
    async fn full_write_tools_are_rejected_below_full_scope() {
        let full_tools: [(&str, Value); 3] = [
            (
                "chapter.write_direct",
                json!({"chapterName": "第一章", "content": "正文"}),
            ),
            ("memory.write", json!({"name": "设定", "content": "内容"})),
            ("undo_last", json!({"n": 1})),
        ];
        for caller in [
            session::SessionScope::Read,
            session::SessionScope::Settings,
            session::SessionScope::Project,
        ] {
            for (name, args) in full_tools.clone() {
                let out = dispatch_as(
                    &state("t"),
                    &req("tools/call", Some(json!({"name": name, "arguments": args}))),
                    caller,
                )
                .await
                .expect("has response");
                let text = out["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default();
                assert!(
                    text.contains("权限不足"),
                    "{name} 在 {caller:?} 下应被拒，实际: {text}"
                );
                assert!(
                    text.contains("full"),
                    "{name} 的拒绝信息应点出需要 full，实际: {text}"
                );
            }
        }
    }

    /// P3：full 会话不被闸门拦（会因缺少 AppHandle 在桥这一层失败，说明已过闸门）。
    #[tokio::test]
    async fn full_scope_passes_the_gate() {
        let out = dispatch_as(
            &state("t"),
            &req(
                "tools/call",
                Some(json!({"name": "undo_last", "arguments": {"n": 1}})),
            ),
            session::SessionScope::Full,
        )
        .await
        .expect("has response");
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(!text.contains("权限不足"), "不应被权限闸门拦截: {text}");
        assert!(text.contains("状态桥"), "应因缺少 AppHandle 失败: {text}");
    }

    #[tokio::test]
    async fn read_tools_are_not_gated_by_scope() {
        // `tools/list` 按 (scope, profile) 过滤：
        // - Read + FullLegacy 包含 settings.get、排除 settings.set；
        // - Settings + FullLegacy 同时包含 settings.get 与 settings.set。
        let srv = state("t");
        let read_out = dispatch(&srv, &req("tools/list", None))
            .await
            .expect("has response");
        let read_names: Vec<&str> = read_out["result"]["tools"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(read_names.contains(&"settings.get"));
        assert!(!read_names.contains(&"settings.set"));

        let settings_out = dispatch_as(
            &srv,
            &req("tools/list", None),
            session::SessionScope::Settings,
        )
        .await
        .expect("has response");
        let settings_names: Vec<&str> = settings_out["result"]["tools"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(settings_names.contains(&"settings.get"));
        assert!(settings_names.contains(&"settings.set"));
    }

    // ── 端到端：真起监听、真发 HTTP ────────────────────────────────────────

    async fn start_test_server() -> RunningServer {
        let state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Read,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        serve(state, 0).await.expect("start")
    }

    /// 经真实 HTTP 入口握一次手，拿到服务端下发的会话 id。
    async fn http_initialize(server: &RunningServer) -> String {
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("initialize");
        assert_eq!(resp.status(), 200);
        resp.headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("initialize 必须下发 Mcp-Session-Id")
            .to_string()
    }

    /// 经真实 HTTP 入口调 `app.status`（`sid` 即请求头 `Mcp-Session-Id`）。
    async fn http_app_status(server: &RunningServer, sid: Option<&str>) -> Value {
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let mut request = reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": { "name": "app.status", "arguments": {} }
                })
                .to_string(),
            );
        if let Some(sid) = sid {
            request = request.header("mcp-session-id", sid);
        }
        let resp = request.send().await.expect("tools/call");
        assert_eq!(resp.status(), 200);
        let body: Value = resp.json().await.expect("json");
        tool_payload(&body)
    }

    /// HTTP 入口读的是注册表里的**有效** scope：逐会话 grant / revoke 必须
    /// 真的让 `app.status` 变档，而另一个会话不得被连带升级。
    #[tokio::test]
    async fn http_app_status_tracks_per_session_grants() {
        let server = start_test_server().await;
        let sid_a = http_initialize(&server).await;
        let sid_b = http_initialize(&server).await;

        let payload = http_app_status(&server, Some(&sid_a)).await;
        assert_eq!(
            payload["readOnly"],
            json!(true),
            "新会话继承的仍是 Read: {payload}"
        );
        assert_eq!(payload["scope"], json!("read"), "{payload}");

        // 逐会话授予 auto：只有被授予的那个会话看到 readOnly=false。
        assert!(
            server.state.sessions.grant_auto(&sid_a),
            "会话表里应有刚握手的会话"
        );
        let payload = http_app_status(&server, Some(&sid_a)).await;
        assert_eq!(payload["readOnly"], json!(false), "{payload}");
        assert_eq!(payload["scope"], json!("auto"), "{payload}");

        let other = http_app_status(&server, Some(&sid_b)).await;
        assert_eq!(
            other["readOnly"],
            json!(true),
            "第二会话不得被连带升级: {other}"
        );
        assert_eq!(other["scope"], json!("read"), "{other}");

        // 叠加 full 以 full 为准；吊销 full 回落 auto；再吊销 auto 回只读。
        assert!(server.state.sessions.grant_full(&sid_a));
        let payload = http_app_status(&server, Some(&sid_a)).await;
        assert_eq!(payload["readOnly"], json!(false), "{payload}");
        assert_eq!(payload["scope"], json!("full"), "{payload}");

        assert!(server.state.sessions.revoke_full(&sid_a));
        let payload = http_app_status(&server, Some(&sid_a)).await;
        assert_eq!(
            payload["scope"],
            json!("auto"),
            "吊销 full 应回落 auto: {payload}"
        );

        assert!(server.state.sessions.revoke_auto(&sid_a));
        let payload = http_app_status(&server, Some(&sid_a)).await;
        assert_eq!(payload["readOnly"], json!(true), "{payload}");
        assert_eq!(payload["scope"], json!("read"), "{payload}");

        server.stop();
    }

    /// 缺失 / 未知 session id 一律最小权限（不隐式创建、不默认放行）。
    #[tokio::test]
    async fn http_app_status_missing_or_unknown_session_is_read_only() {
        let server = start_test_server().await;

        let missing = http_app_status(&server, None).await;
        assert_eq!(missing["readOnly"], json!(true), "{missing}");
        assert_eq!(missing["scope"], json!("read"), "{missing}");

        let unknown = http_app_status(&server, Some("no-such-session")).await;
        assert_eq!(unknown["readOnly"], json!(true), "{unknown}");
        assert_eq!(unknown["scope"], json!("read"), "{unknown}");
        assert_eq!(
            server.state.sessions.len(),
            0,
            "未知 session id 不得被隐式创建"
        );

        server.stop();
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
        assert_eq!(sessions[0].scope, session::SessionScope::Read);
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

    #[tokio::test]
    async fn server_rejects_disallowed_host_and_origin_before_auth_with_403() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let wrong_port = if server.port == u16::MAX {
            server.port - 1
        } else {
            server.port + 1
        };
        let client = reqwest::Client::new();

        // 非法 Host（即使不带 token，也必须在鉴权之前返回 403 而非 401）。
        for bad_host in [
            "evil.com".to_string(),
            format!("evil.com:{}", server.port),
            format!("127.0.0.1.evil.com:{}", server.port),
            format!("127.0.0.1:{wrong_port}"),
            format!("localhost:{wrong_port}"),
            format!("[::1]:{wrong_port}"),
            "127.0.0.1:99999".to_string(),
        ] {
            let resp = client
                .post(&url)
                .header(reqwest::header::HOST, &bad_host)
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
                .send()
                .await
                .expect("request");
            assert_eq!(
                resp.status(),
                403,
                "非法 Host `{bad_host}` 必须在鉴权前返回 403"
            );
        }

        // 非法 Origin（即使不带 token，也必须在鉴权之前返回 403 而非 401）。
        for bad_origin in [
            "https://evil.com",
            "http://evil.com:45871",
            "http://localhost.evil.com",
            "http://127.0.0.1@evil.com",
            "http://tauri.localhost.evil.com",
            "null",
            "file:///tmp/index.html",
        ] {
            let resp = client
                .post(&url)
                .header(reqwest::header::ORIGIN, bad_origin)
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
                .send()
                .await
                .expect("request");
            assert_eq!(
                resp.status(),
                403,
                "非法 Origin `{bad_origin}` 必须在鉴权前返回 403"
            );
        }

        // 合法 Host 变体（含无端口与匹配端口的回环地址）带合法 token 必须放行 200。
        for ok_host in [
            format!("127.0.0.1:{}", server.port),
            format!("localhost:{}", server.port),
            format!("LOCALHOST:{}", server.port),
            format!("[::1]:{}", server.port),
            "127.0.0.1".to_string(),
            "localhost".to_string(),
            "[::1]".to_string(),
        ] {
            let resp = client
                .post(&url)
                .header(reqwest::header::HOST, &ok_host)
                .bearer_auth("secret-token")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
                .send()
                .await
                .expect("request");
            assert_eq!(resp.status(), 200, "合法 Host `{ok_host}` 应放行");
        }

        // 合法 Origin（回环与 Tauri WebView 源）带合法 token 必须放行 200。
        for ok_origin in [
            "http://127.0.0.1:1420",
            "http://localhost:2420",
            "https://[::1]:8443",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            let resp = client
                .post(&url)
                .header(reqwest::header::ORIGIN, ok_origin)
                .bearer_auth("secret-token")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
                .send()
                .await
                .expect("request");
            assert_eq!(resp.status(), 200, "合法 Origin `{ok_origin}` 应放行");
        }

        // state.port == 0 时允许任意合法 u16 端口，仍拒绝非回环与越界端口。
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::HOST, "localhost:12345".parse().unwrap());
        assert!(is_allowed_host(&headers, 0));
        headers.insert(axum::http::header::HOST, "localhost:99999".parse().unwrap());
        assert!(!is_allowed_host(&headers, 0));
        headers.remove(axum::http::header::HOST);
        assert!(!is_allowed_host(&headers, 0));

        server.stop();
    }

    #[tokio::test]
    async fn handle_stop_stops_running_server() {
        let server = start_test_server().await;
        let port = server.port;
        let handle = McpServerHandle::default();
        handle.replace(Some(server));
        assert_eq!(handle.port(), Some(port));

        handle.stop();
        assert_eq!(handle.port(), None);
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let rebound = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
        assert!(rebound.is_ok(), "McpServerHandle::stop() 必须释放端口");
    }

    #[tokio::test]
    async fn server_rejects_body_exceeding_4_mib_with_413() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let oversized = vec![b'a'; MAX_BODY_BYTES + 128];
        let resp = reqwest::Client::new()
            .post(&url)
            .bearer_auth("secret-token")
            .body(oversized)
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 413, "超过 4 MiB 的请求体必须返回 413");
        server.stop();
    }

    #[tokio::test]
    async fn server_rate_limits_auth_failures_and_sliding_window_with_429() {
        // 1) 连续鉴权失败触发指数退避 429 + Retry-After
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let client = reqwest::Client::new();
        for i in 1..AUTH_FAIL_BACKOFF_THRESHOLD {
            let resp = client
                .post(&url)
                .bearer_auth("wrong-token")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
                .send()
                .await
                .expect("request");
            assert_eq!(resp.status(), 401, "第 {i} 次失败应返回 401");
        }
        let resp_backoff = client
            .post(&url)
            .bearer_auth("wrong-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp_backoff.status(), 429, "达到阈值后必须返回 429");
        assert!(resp_backoff.headers().get("retry-after").is_some());

        // 冷却期内即使换回正确 token 也必须被 429 挡住。
        let resp_during_cooldown = client
            .post(&url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(resp_during_cooldown.status(), 429);
        server.stop();

        // 2) 滑动窗口限流触发 429 + Retry-After
        let tight_state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Read,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::new(Duration::from_secs(60), 3)),
        };
        let tight_server = serve(tight_state, 0).await.expect("start tight server");
        let tight_url = format!("http://127.0.0.1:{}/mcp", tight_server.port);
        for _ in 0..3 {
            let resp = client
                .post(&tight_url)
                .bearer_auth("secret-token")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
                .send()
                .await
                .expect("request");
            assert_eq!(resp.status(), 200);
        }
        let limited = client
            .post(&tight_url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .send()
            .await
            .expect("request");
        assert_eq!(limited.status(), 429, "超过滑动窗口上限必须返回 429");
        assert!(limited.headers().get("retry-after").is_some());
        tight_server.stop();
    }

    #[tokio::test]
    async fn handle_port_and_scope_recover_from_poisoned_mutex() {
        let server = start_test_server().await;
        let expected_port = server.port;
        let expected_scope = server.state.granted_scope;
        let handle = Arc::new(McpServerHandle::default());
        handle.replace(Some(server));

        let poisoned = Arc::clone(&handle);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.inner.lock().unwrap();
            panic!("intentional poison for McpServerHandle::inner");
        })
        .join();

        assert!(handle.inner.is_poisoned());
        assert_eq!(handle.port(), Some(expected_port));
        assert_eq!(handle.scope(), Some(expected_scope));
        handle.stop();
    }

    #[tokio::test]
    async fn streamable_http_post_delete_and_get_405_for_antigravity_mcp() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let client = reqwest::Client::new();

        // 1) Antigravity Streamable HTTP 客户端握手（Accept 同时声明 json 与 event-stream）
        let init_resp = client
            .post(&url)
            .bearer_auth("secret-token")
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#)
            .send()
            .await
            .expect("init post");
        assert_eq!(init_resp.status(), 200);
        let sid = init_resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("mcp-session-id header")
            .to_string();
        assert_eq!(server.sessions().len(), 1);

        // 2) GET /mcp 无独立 SSE 流时返回标准 405 Method Not Allowed
        let get_resp = client
            .get(&url)
            .bearer_auth("secret-token")
            .header("accept", "text/event-stream")
            .send()
            .await
            .expect("get probe");
        assert_eq!(get_resp.status(), 405);

        // 3) DELETE /mcp 无鉴权必须被 401 拒绝且保留会话
        let unauth_del = client
            .delete(&url)
            .header("mcp-session-id", &sid)
            .send()
            .await
            .expect("unauth delete");
        assert_eq!(unauth_del.status(), 401);
        assert_eq!(server.sessions().len(), 1);

        // 4) DELETE /mcp 携带正确 Bearer + Mcp-Session-Id 返回 204 并清理会话
        let del_resp = client
            .delete(&url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", &sid)
            .send()
            .await
            .expect("auth delete");
        assert_eq!(del_resp.status(), 204);
        assert!(server.sessions().is_empty());

        server.stop();
    }

    #[tokio::test]
    async fn initialize_captures_and_sanitizes_client_info() {
        let server = start_test_server().await;
        let url = format!("http://127.0.0.1:{}/mcp", server.port);
        let client = reqwest::Client::new();

        // 含控制字符、超长名字与超长版本（含多字节 UTF-8），必须安全剥离并截断至 128 / 64 字符。
        let long_name = format!("  \r\n\t{}\x00\x1f  ", "甲".repeat(140));
        let long_version = format!("\n\x07{}\r\n", "v".repeat(80));
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "clientInfo": {
                    "name": long_name,
                    "version": long_version
                }
            }
        });
        let resp = client
            .post(&url)
            .bearer_auth("secret-token")
            .body(body.to_string())
            .send()
            .await
            .expect("init with clientInfo");
        assert_eq!(resp.status(), 200);
        let sid = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("mcp-session-id")
            .to_string();

        // 仅含控制字符与空白时应归一化为 None。
        let blank_body = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "\x00\r\n   ",
                    "version": "\t\x1b"
                }
            }
        });
        let blank_resp = client
            .post(&url)
            .bearer_auth("secret-token")
            .body(blank_body.to_string())
            .send()
            .await
            .expect("init blank clientInfo");
        assert_eq!(blank_resp.status(), 200);
        let blank_sid = blank_resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("blank mcp-session-id")
            .to_string();

        let sessions = server.sessions();
        let first = sessions
            .iter()
            .find(|s| s.id == sid)
            .expect("first session");
        assert_eq!(
            first.client_name.as_deref(),
            Some("甲".repeat(MAX_CLIENT_INFO_NAME_CHARS).as_str())
        );
        assert_eq!(
            first.client_version.as_deref(),
            Some("v".repeat(MAX_CLIENT_INFO_VERSION_CHARS).as_str())
        );
        assert!(first
            .client_name
            .as_deref()
            .unwrap()
            .chars()
            .all(|c| !c.is_control()));
        assert!(first
            .client_version
            .as_deref()
            .unwrap()
            .chars()
            .all(|c| !c.is_control()));

        let second = sessions
            .iter()
            .find(|s| s.id == blank_sid)
            .expect("second session");
        assert_eq!(second.client_name, None);
        assert_eq!(second.client_version, None);

        server.stop();
    }

    #[tokio::test]
    async fn running_connection_info_with_scope_delegates_and_recovers_from_poison() {
        let handle = Arc::new(McpServerHandle::default());
        assert_eq!(handle.running_connection_info_with_scope(), None);
        assert_eq!(handle.running_connection_info(), None);

        let project_state = ServerState {
            token: "scoped-secret".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Project,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let server = serve(project_state, 0).await.expect("start scoped server");
        let port = server.port;
        handle.replace(Some(server));

        assert_eq!(
            handle.running_connection_info_with_scope(),
            Some((
                port,
                "scoped-secret".to_string(),
                session::SessionScope::Project
            ))
        );
        assert_eq!(
            handle.running_connection_info(),
            Some((port, "scoped-secret".to_string()))
        );

        let poisoned = Arc::clone(&handle);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.inner.lock().unwrap();
            panic!("intentional poison for running_connection_info_with_scope");
        })
        .join();
        assert!(handle.inner.is_poisoned());
        assert_eq!(
            handle.running_connection_info_with_scope(),
            Some((
                port,
                "scoped-secret".to_string(),
                session::SessionScope::Project
            ))
        );
        assert_eq!(
            handle.running_connection_info(),
            Some((port, "scoped-secret".to_string()))
        );

        handle.stop();
        assert_eq!(handle.running_connection_info_with_scope(), None);
    }

    #[tokio::test]
    async fn local_mcp_binding_tracks_generation_redacts_debug_and_recovers_from_poison() {
        let handle = Arc::new(McpServerHandle::default());
        assert_eq!(handle.running_binding_fingerprint().await, None);
        assert_eq!(handle.running_connection_info_with_binding().await, None);

        let raw_token_1 = "super-secret-bearer-token-v1";
        let state_1 = ServerState {
            token: raw_token_1.into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Read,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let server_1 = serve(state_1, 0).await.expect("start server 1");
        let port_1 = server_1.port;
        handle.replace(Some(server_1));

        let binding_1 = handle
            .running_binding_fingerprint()
            .await
            .expect("binding 1");
        assert_eq!(binding_1.port, port_1);
        assert_eq!(binding_1.scope, session::SessionScope::Read);
        assert_eq!(binding_1.generation, 1);
        assert_eq!(
            binding_1.token_fingerprint,
            writes::sha256_hex(raw_token_1.as_bytes())
        );
        assert_eq!(binding_1.token_fingerprint.len(), 64);
        assert_ne!(binding_1.token_fingerprint, raw_token_1);

        // Debug 输出必须脱敏：严禁泄露明文 token 或完整 SHA-256 指纹。
        let debug_str = format!("{binding_1:?}");
        assert!(debug_str.contains("<redacted>"), "{debug_str}");
        assert!(!debug_str.contains(raw_token_1), "{debug_str}");
        assert!(
            !debug_str.contains(&binding_1.token_fingerprint),
            "{debug_str}"
        );

        let conn_1 = handle
            .running_connection_info_with_binding()
            .await
            .expect("conn info 1");
        assert_eq!(conn_1, (port_1, raw_token_1.to_string(), binding_1.clone()));

        // 重启（即使 token 与 scope 相同）必须单调递增 generation。
        let state_2 = ServerState {
            token: raw_token_1.into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Read,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let server_2 = serve(state_2, 0).await.expect("start server 2");
        handle.replace(Some(server_2));
        let binding_2 = handle
            .running_binding_fingerprint()
            .await
            .expect("binding 2");
        assert_eq!(binding_2.generation, 2);
        assert_ne!(binding_1, binding_2);

        // 停服后返回 None；再次启动继续单调递增至 3，且轮换 token 会改变 token_fingerprint。
        handle.stop();
        assert_eq!(handle.running_binding_fingerprint().await, None);

        let raw_token_3 = "rotated-secret-bearer-token-v3";
        let state_3 = ServerState {
            token: raw_token_3.into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Project,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let server_3 = serve(state_3, 0).await.expect("start server 3");
        handle.replace(Some(server_3));
        let binding_3 = handle
            .running_binding_fingerprint()
            .await
            .expect("binding 3");
        assert_eq!(binding_3.generation, 3);
        assert_eq!(binding_3.scope, session::SessionScope::Project);
        assert_ne!(binding_3.token_fingerprint, binding_1.token_fingerprint);

        // Mutex 投毒后仍能安全恢复，不 panic。
        let poisoned = Arc::clone(&handle);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.inner.lock().unwrap();
            panic!("intentional poison for LocalMcpBinding");
        })
        .join();
        assert!(handle.inner.is_poisoned());
        assert_eq!(
            handle.running_binding_fingerprint().await,
            Some(binding_3.clone())
        );

        handle.stop();
    }

    /// 注册表驱动的 P2/P3 全量权限矩阵测试：
    /// - 遍历注册表中所有工具 × 全部 5 档 scope，验证拒绝边界与放行边界零漂移；
    /// - 显式验证 `Auto` 被所有 `Full` 专属工具拒绝；
    /// - 显式验证 `outline.write` 需 `Project` 且拒 `Read`/`Settings`；
    /// - 显式验证 `context.prepare_write` 与 `director.check` 在 `Read` 下过闸门；
    /// - 显式验证 `draft.accept` 永不注册。
    #[tokio::test]
    async fn registry_driven_scope_rejection_matrix_enforces_all_tiers_and_auto_isolation() {
        let srv_state = state("t");
        let reg = &srv_state.registry;
        let all_names = reg.names();
        assert!(!all_names.contains(&"draft.accept"));
        assert!(all_names.contains(&"context.prepare_write"));
        assert!(all_names.contains(&"director.check"));
        assert!(all_names.contains(&"outline.write"));

        let all_scopes = [
            session::SessionScope::Read,
            session::SessionScope::Settings,
            session::SessionScope::Project,
            session::SessionScope::Auto,
            session::SessionScope::Full,
        ];

        for name in &all_names {
            let required = reg.required_scope(name).expect("registered scope");
            for caller in all_scopes {
                let out = dispatch_as(
                    &srv_state,
                    &req("tools/call", Some(json!({ "name": name, "arguments": {} }))),
                    caller,
                )
                .await
                .expect("response");
                if !caller.satisfies(required) {
                    assert_eq!(
                        out["result"]["isError"],
                        json!(true),
                        "{name} (required={required:?}) 在 {caller:?} 下必须返回权限拒绝"
                    );
                    let text = out["result"]["content"][0]["text"]
                        .as_str()
                        .unwrap_or_default();
                    assert!(
                        text.contains("权限不足") && text.contains(required.as_str()),
                        "{name} 在 {caller:?} 下拒绝文案异常: {text}"
                    );
                } else if let Some(text) = out["result"]["content"][0]["text"].as_str() {
                    assert!(
                        !text.contains("权限不足"),
                        "{name} (required={required:?}) 在 {caller:?} 下不应被权限闸门拦截: {text}"
                    );
                }
            }
        }

        // 显式核对 Auto 被所有 Full 专属工具拒绝（即使携带合法参数）。
        let full_only_tools: Vec<&str> = all_names
            .iter()
            .copied()
            .filter(|n| reg.required_scope(n) == Some(session::SessionScope::Full))
            .collect();
        assert!(full_only_tools.contains(&"chapter.write_direct"));
        assert!(full_only_tools.contains(&"memory.write"));
        assert!(full_only_tools.contains(&"undo_last"));
        for full_tool in full_only_tools {
            let out = dispatch_as(
                &srv_state,
                &req(
                    "tools/call",
                    Some(json!({ "name": full_tool, "arguments": {} })),
                ),
                session::SessionScope::Auto,
            )
            .await
            .expect("response");
            let text = out["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            assert!(
                text.contains("权限不足") && text.contains("full"),
                "Auto 绝不能调用 Full 工具 {full_tool}: {text}"
            );
        }

        // 显式核对 Round 2 三个新工具与 Phase 2 八个新工具的权限档位。
        assert_eq!(
            reg.required_scope("context.prepare_write"),
            Some(session::SessionScope::Read)
        );
        assert_eq!(
            reg.required_scope("director.check"),
            Some(session::SessionScope::Read)
        );
        assert_eq!(
            reg.required_scope("outline.write"),
            Some(session::SessionScope::Project)
        );
        for phase2_read in [
            "workflow.next",
            "foreshadowing.list",
            "character.read",
            "outline.read",
            "style.exemplars",
            "chapter.search",
            "draft.diff",
            "audit.longform_health",
        ] {
            assert!(all_names.contains(&phase2_read));
            assert_eq!(
                reg.required_scope(phase2_read),
                Some(session::SessionScope::Read),
                "{phase2_read} 必须为 Read scope"
            );
        }
        for phase2_project in [
            "draft.patch",
            "draft.record_review",
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(all_names.contains(&phase2_project));
            assert_eq!(
                reg.required_scope(phase2_project),
                Some(session::SessionScope::Project),
                "{phase2_project} 必须为 Project scope"
            );
        }
    }

    async fn http_call_tool(
        client: &reqwest::Client,
        url: &str,
        sid: &str,
        name: &str,
        arguments: Value,
    ) -> Value {
        let resp = client
            .post(url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", sid)
            .body(
                json!({
                    "jsonrpc": "2.0",
                    "id": 10,
                    "method": "tools/call",
                    "params": { "name": name, "arguments": arguments }
                })
                .to_string(),
            )
            .send()
            .await
            .expect("http tools/call");
        assert_eq!(resp.status(), 200);
        resp.json().await.expect("json response")
    }

    /// 真实 HTTP `POST /mcp` 集成测试：覆盖全部 6 个零 LLM 只读工具与 `outline.write`
    /// （含权限闸门、路径穿越、Windows 保留设备名、非 `.md`、超大正文及 `director.check` 非空参数拒绝）。
    #[tokio::test]
    async fn http_post_mcp_covers_six_zero_llm_read_tools_and_outline_write() {
        let client = reqwest::Client::new();

        // 1) Read 会话：6 个零 LLM 只读工具均过鉴权+权限+校验到达桥层；`outline.write` 被权限闸门拦截。
        let read_server = start_test_server().await;
        let read_url = format!("http://127.0.0.1:{}/mcp", read_server.port);
        let read_sid = http_initialize(&read_server).await;

        let valid_six_read_calls: [(&str, Value); 6] = [
            ("draft.list", json!({})),
            ("draft.read", json!({ "draftId": "draft_01-ok" })),
            ("rules.get", json!({ "sections": ["antiAi", "bookRules"] })),
            (
                "gate.check_mechanical",
                json!({ "text": "这是一段用于机械门控检查的正文。" }),
            ),
            (
                "context.prepare_write",
                json!({ "targetChapter": 3, "includePlanningView": true }),
            ),
            ("director.check", json!({})),
        ];
        for (name, args) in valid_six_read_calls {
            let body = http_call_tool(&client, &read_url, &read_sid, name, args).await;
            assert!(
                body["error"].is_null(),
                "{name} 合法参数不应触发协议层 error: {body}"
            );
            assert_eq!(body["result"]["isError"], json!(true), "{name}: {body}");
            let text = body["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            assert!(!text.contains("权限不足"), "{name} 不应被权限拦截: {text}");
            assert!(
                text.contains("状态桥"),
                "{name} 应通过鉴权/权限/参数校验到达状态桥: {text}"
            );
        }

        // `director.check` 拒绝任何非空参数（协议层 INVALID_PARAMS）。
        let bad_dir = http_call_tool(
            &client,
            &read_url,
            &read_sid,
            "director.check",
            json!({ "unexpected": true }),
        )
        .await;
        assert_eq!(
            bad_dir["error"]["code"],
            json!(protocol::INVALID_PARAMS),
            "{bad_dir}"
        );

        // `context.prepare_write` 拒绝非法参数（协议层 INVALID_PARAMS）。
        let bad_prep = http_call_tool(
            &client,
            &read_url,
            &read_sid,
            "context.prepare_write",
            json!({ "targetChapter": 0 }),
        )
        .await;
        assert_eq!(
            bad_prep["error"]["code"],
            json!(protocol::INVALID_PARAMS),
            "{bad_prep}"
        );

        // Read 会话下调用 `outline.write` 必须被权限闸门拦截。
        let denied_outline = http_call_tool(
            &client,
            &read_url,
            &read_sid,
            "outline.write",
            json!({ "filename": "main.md", "content": "# 大纲" }),
        )
        .await;
        let denied_text = denied_outline["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert_eq!(denied_outline["result"]["isError"], json!(true));
        assert!(
            denied_text.contains("权限不足") && denied_text.contains("project"),
            "Read 调 outline.write 应被拒绝: {denied_text}"
        );
        read_server.stop();

        // 2) Project 会话：`outline.write` 在 HTTP 层严格拦截所有危险文件名/超大正文，合法入参到达状态桥。
        let project_state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Project,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let project_server = serve(project_state, 0).await.expect("start project server");
        let project_url = format!("http://127.0.0.1:{}/mcp", project_server.port);
        let project_sid = http_initialize(&project_server).await;

        let bad_outline_cases = [
            json!({ "filename": "../escape.md", "content": "# 穿越" }),
            json!({ "filename": "dir/sub.md", "content": "# 路径" }),
            json!({ "filename": r"dir\sub.md", "content": "# 反斜杠" }),
            json!({ "filename": "CON.md", "content": "# 保留名" }),
            json!({ "filename": "CON .md", "content": "# 保留名尾空格" }),
            json!({ "filename": "nul.md", "content": "# 保留名" }),
            json!({ "filename": "NUL .md", "content": "# 保留名尾空格" }),
            json!({ "filename": "COM1.md", "content": "# 保留名" }),
            json!({ "filename": "lpt9.md", "content": "# 保留名" }),
            json!({ "filename": "outline.txt", "content": "# 非 md" }),
            json!({ "filename": ".md", "content": "# 空主干" }),
            json!({ "filename": ".hidden.md", "content": "# 点开头隐藏文件" }),
            json!({ "filename": "bad:ads.md", "content": "# ADS" }),
            json!({ "filename": "ok.md", "content": "   " }),
            json!({ "filename": "ok.md", "content": "字".repeat(200_001) }),
        ];
        for bad_args in bad_outline_cases {
            let body = http_call_tool(
                &client,
                &project_url,
                &project_sid,
                "outline.write",
                bad_args.clone(),
            )
            .await;
            assert_eq!(
                body["error"]["code"],
                json!(protocol::INVALID_PARAMS),
                "outline.write 非法参数必须返回 INVALID_PARAMS: args={bad_args}, body={body}"
            );
        }

        let valid_outline = http_call_tool(
            &client,
            &project_url,
            &project_sid,
            "outline.write",
            json!({ "filename": "第一卷-总纲.md", "content": "# 第一卷\n大纲内容", "syncModel": true }),
        )
        .await;
        assert!(valid_outline["error"].is_null(), "{valid_outline}");
        let valid_text = valid_outline["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(!valid_text.contains("权限不足"), "{valid_text}");
        assert!(
            valid_text.contains("状态桥"),
            "合法 outline.write 应通过权限与校验到达桥层: {valid_text}"
        );

        project_server.stop();
    }

    #[test]
    fn resolve_requested_profile_fails_closed_on_invalid_duplicate_or_conflicting_inputs() {
        let empty_headers = HeaderMap::new();
        assert_eq!(resolve_requested_profile(None, &empty_headers), Ok(None));
        assert_eq!(
            resolve_requested_profile(Some(""), &empty_headers),
            Ok(None)
        );
        assert_eq!(
            resolve_requested_profile(Some("foo=bar"), &empty_headers),
            Ok(None)
        );
        assert_eq!(
            resolve_requested_profile(Some("profile=writer-sub"), &empty_headers),
            Ok(Some(ToolProfile::WriterSub))
        );
        assert_eq!(
            resolve_requested_profile(Some("foo=1&profile=reviewer&bar=2"), &empty_headers),
            Ok(Some(ToolProfile::Reviewer))
        );

        let mut hdr = HeaderMap::new();
        hdr.insert("x-niko-profile", HeaderValue::from_static("architect"));
        assert_eq!(
            resolve_requested_profile(None, &hdr),
            Ok(Some(ToolProfile::Architect))
        );
        assert_eq!(
            resolve_requested_profile(Some("profile=architect"), &hdr),
            Ok(Some(ToolProfile::Architect))
        );
        // 冲突（query vs header）必须拒绝。
        assert!(resolve_requested_profile(Some("profile=reviewer"), &hdr).is_err());

        // 空值、未知值、重复 query、重复 header 全部 fail-closed。
        for bad_q in [
            "profile",
            "profile=",
            "profile=unknown",
            "profile=WRITER-SUB",
            "profile=writer-sub&profile=writer-sub",
            "profile=writer-sub&profile=reviewer",
        ] {
            assert!(
                resolve_requested_profile(Some(bad_q), &empty_headers).is_err(),
                "bad query `{bad_q}` 必须报错"
            );
        }

        let mut dup_hdr = HeaderMap::new();
        dup_hdr.append("x-niko-profile", HeaderValue::from_static("writer-sub"));
        dup_hdr.append("x-niko-profile", HeaderValue::from_static("writer-sub"));
        assert!(resolve_requested_profile(None, &dup_hdr).is_err());

        let mut bad_hdr = HeaderMap::new();
        bad_hdr.insert("x-niko-profile", HeaderValue::from_static("invalid"));
        assert!(resolve_requested_profile(None, &bad_hdr).is_err());

        let mut empty_hdr = HeaderMap::new();
        empty_hdr.insert("x-niko-profile", HeaderValue::from_static(""));
        assert!(resolve_requested_profile(None, &empty_hdr).is_err());
    }

    #[tokio::test]
    async fn http_mcp_profile_freezing_filtering_guidance_and_anti_escalation() {
        let project_state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Project,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let server = serve(project_state, 0).await.expect("start project server");
        let base_url = format!("http://127.0.0.1:{}/mcp", server.port);
        let client = reqwest::Client::new();

        // 1) 非法/冲突/重复 profile 均返回 HTTP 400（鉴权之后）。
        for (suffix, header) in [
            ("?profile=bogus", None),
            ("?profile=", None),
            ("?profile", None),
            ("?profile=writer-sub&profile=writer-sub", None),
            ("", Some("unknown")),
            ("?profile=reviewer", Some("writer-sub")),
        ] {
            let mut req_builder = client
                .post(format!("{base_url}{suffix}"))
                .bearer_auth("secret-token")
                .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
            if let Some(h) = header {
                req_builder = req_builder.header("X-Niko-Profile", h);
            }
            let resp = req_builder.send().await.expect("send bad profile");
            assert_eq!(
                resp.status(),
                400,
                "suffix={suffix:?} header={header:?} 必须返回 HTTP 400"
            );
        }

        // 2) 以 `?profile=writer-sub` + 匹配 `X-Niko-Profile: writer-sub` 握手并冻结。
        let init_resp = client
            .post(format!("{base_url}?profile=writer-sub"))
            .bearer_auth("secret-token")
            .header("X-Niko-Profile", "writer-sub")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"niko-buddy","version":"2.30.0"}}}"#)
            .send()
            .await
            .expect("init writer-sub");
        assert_eq!(init_resp.status(), 200);
        let sid = init_resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("sid")
            .to_string();
        assert_eq!(
            server.state.sessions.profile_of(&sid),
            Some(ToolProfile::WriterSub)
        );

        // 3) 后续请求不带 profile 时沿用冻结的 `writer-sub`：`tools/list` 仅返回 26 工具。
        let list_resp = client
            .post(&base_url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", &sid)
            .body(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)
            .send()
            .await
            .expect("tools/list");
        assert_eq!(list_resp.status(), 200);
        let list_json: Value = list_resp.json().await.expect("json");
        let list_names: Vec<&str> = list_json["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(list_names.len(), 32);
        assert!(list_names.contains(&"chapter.write"));
        assert!(list_names.contains(&"workflow.next"));
        assert!(list_names.contains(&"draft.patch"));
        assert!(list_names.contains(&"draft.record_review"));
        assert!(list_names.contains(&"draft.diff"));
        assert!(list_names.contains(&"audit.longform_health"));
        for planning_tool in [
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(list_names.contains(&planning_tool));
        }
        assert!(!list_names.contains(&"pipeline.run_chapter"));
        assert!(!list_names.contains(&"settings.get"));

        // `app.status` 回报冻结的 `profile: "writer-sub"`。
        let status_body = http_call_tool(&client, &base_url, &sid, "app.status", json!({})).await;
        let status_payload = tool_payload(&status_body);
        assert_eq!(status_payload["profile"], json!("writer-sub"));
        assert_eq!(status_payload["scope"], json!("project"));

        // 4) 尝试带不同 profile 提权必须 fail-closed 返回 HTTP 400，且不得刷新会话 calls 计数。
        let calls_before_escalation = server
            .sessions()
            .into_iter()
            .find(|s| s.id == sid)
            .expect("active session")
            .calls;
        let escalate_q = client
            .post(format!("{base_url}?profile=full-legacy"))
            .bearer_auth("secret-token")
            .header("mcp-session-id", &sid)
            .body(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)
            .send()
            .await
            .expect("escalate query");
        assert_eq!(escalate_q.status(), 400);

        let escalate_h = client
            .post(&base_url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", &sid)
            .header("X-Niko-Profile", "architect")
            .body(r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#)
            .send()
            .await
            .expect("escalate header");
        assert_eq!(escalate_h.status(), 400);

        let calls_after_escalation = server
            .sessions()
            .into_iter()
            .find(|s| s.id == sid)
            .expect("active session")
            .calls;
        assert_eq!(
            calls_after_escalation, calls_before_escalation,
            "被 400 拒绝的 profile 提权请求不得增加会话 calls 计数"
        );

        // 带匹配的 profile 仍放行 200 并正常计数。
        let matching = client
            .post(format!("{base_url}?profile=writer-sub"))
            .bearer_auth("secret-token")
            .header("mcp-session-id", &sid)
            .header("X-Niko-Profile", "writer-sub")
            .body(r#"{"jsonrpc":"2.0","id":5,"method":"ping"}"#)
            .send()
            .await
            .expect("matching profile");
        assert_eq!(matching.status(), 200);
        let calls_after_matching = server
            .sessions()
            .into_iter()
            .find(|s| s.id == sid)
            .expect("active session")
            .calls;
        assert_eq!(calls_after_matching, calls_before_escalation + 1);

        // 5) 调用被 Profile 隐藏的工具返回 HTTP 200 + isError:true + 紧凑单行 TOOL_HIDDEN_BY_PROFILE JSON；
        //    调用未知工具仍返回 JSON-RPC -32601。
        let hidden = http_call_tool(
            &client,
            &base_url,
            &sid,
            "pipeline.run_chapter",
            json!({ "userRequest": "写一章" }),
        )
        .await;
        assert!(hidden["error"].is_null(), "{hidden}");
        assert_eq!(hidden["result"]["isError"], json!(true));
        let hidden_text = hidden["result"]["content"][0]["text"]
            .as_str()
            .expect("hidden text");
        assert!(
            !hidden_text.contains('\n'),
            "必须紧凑单行 JSON: {hidden_text}"
        );
        let hidden_json: Value = serde_json::from_str(hidden_text).expect("valid JSON");
        assert_eq!(hidden_json["code"], json!("TOOL_HIDDEN_BY_PROFILE"));
        assert_eq!(hidden_json["tool"], json!("pipeline.run_chapter"));
        assert_eq!(hidden_json["activeProfile"], json!("writer-sub"));
        assert_eq!(
            hidden_json["replacementTools"],
            json!([
                "context.prepare_write",
                "rules.get",
                "gate.check_mechanical",
                "chapter.write"
            ])
        );

        let unknown = http_call_tool(&client, &base_url, &sid, "nope.unknown", json!({})).await;
        assert_eq!(unknown["error"]["code"], json!(METHOD_NOT_FOUND));

        // 6) `reviewer` 会话即便在 Project 服务端下也仅可见 21 个 Read 工具，且调写工具报 TOOL_HIDDEN_BY_PROFILE。
        let rev_init = client
            .post(format!("{base_url}?profile=reviewer"))
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":6,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("init reviewer");
        assert_eq!(rev_init.status(), 200);
        let rev_sid = rev_init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("rev sid")
            .to_string();
        let rev_list: Value = client
            .post(&base_url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", &rev_sid)
            .body(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#)
            .send()
            .await
            .expect("rev list")
            .json()
            .await
            .expect("json");
        let rev_names: Vec<&str> = rev_list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(rev_names.len(), 21);
        assert!(rev_names.contains(&"workflow.next"));
        assert!(rev_names.contains(&"style.exemplars"));
        assert!(rev_names.contains(&"draft.diff"));
        assert!(rev_names.contains(&"audit.longform_health"));
        assert!(!rev_names.contains(&"draft.patch"));
        assert!(!rev_names.contains(&"draft.record_review"));

        for hidden_in_reviewer in [
            "chapter.write",
            "draft.patch",
            "draft.record_review",
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(!rev_names.contains(&hidden_in_reviewer));
            let rev_hidden =
                http_call_tool(&client, &base_url, &rev_sid, hidden_in_reviewer, json!({})).await;
            let rev_hidden_json: Value = serde_json::from_str(
                rev_hidden["result"]["content"][0]["text"]
                    .as_str()
                    .expect("text"),
            )
            .expect("json");
            assert_eq!(rev_hidden_json["code"], json!("TOOL_HIDDEN_BY_PROFILE"));
            assert_eq!(rev_hidden_json["tool"], json!(hidden_in_reviewer));
            assert_eq!(rev_hidden_json["activeProfile"], json!("reviewer"));
        }

        // 7) `architect` 会话可见 18 个工具，放行 audit.longform_health，隐藏 draft.patch / draft.record_review / style.exemplars / draft.diff。
        let arch_init = client
            .post(format!("{base_url}?profile=architect"))
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":8,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("init architect");
        assert_eq!(arch_init.status(), 200);
        let arch_sid = arch_init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("arch sid")
            .to_string();
        let arch_list: Value = client
            .post(&base_url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", &arch_sid)
            .body(r#"{"jsonrpc":"2.0","id":9,"method":"tools/list"}"#)
            .send()
            .await
            .expect("arch list")
            .json()
            .await
            .expect("json");
        let arch_names: Vec<&str> = arch_list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(arch_names.len(), 24);
        assert!(arch_names.contains(&"workflow.next"));
        assert!(arch_names.contains(&"outline.read"));
        assert!(arch_names.contains(&"character.read"));
        assert!(arch_names.contains(&"audit.longform_health"));
        for planning_tool in [
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(arch_names.contains(&planning_tool));
        }
        assert!(!arch_names.contains(&"draft.patch"));
        assert!(!arch_names.contains(&"draft.record_review"));
        assert!(!arch_names.contains(&"style.exemplars"));
        assert!(!arch_names.contains(&"draft.diff"));

        for hidden_in_architect in [
            "draft.patch",
            "draft.record_review",
            "style.exemplars",
            "draft.diff",
        ] {
            let arch_hidden = http_call_tool(
                &client,
                &base_url,
                &arch_sid,
                hidden_in_architect,
                json!({}),
            )
            .await;
            let arch_hidden_json: Value = serde_json::from_str(
                arch_hidden["result"]["content"][0]["text"]
                    .as_str()
                    .expect("text"),
            )
            .expect("json");
            assert_eq!(arch_hidden_json["code"], json!("TOOL_HIDDEN_BY_PROFILE"));
            assert_eq!(arch_hidden_json["tool"], json!(hidden_in_architect));
            assert_eq!(arch_hidden_json["activeProfile"], json!("architect"));
            if hidden_in_architect == "draft.diff" {
                assert_eq!(
                    arch_hidden_json["replacementTools"],
                    json!([
                        "audit.longform_health",
                        "draft.list",
                        "chapter.read",
                        "context.prepare_write"
                    ])
                );
            }
        }

        // 8) 核对 FullLegacy + Full scope 服务端下全量 tools/list 为 46 个工具。
        let full_state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Full,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let full_server = serve(full_state, 0).await.expect("start full server");
        let full_url = format!("http://127.0.0.1:{}/mcp", full_server.port);
        let full_init = client
            .post(&full_url)
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":10,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("init full");
        assert_eq!(full_init.status(), 200);
        let full_sid = full_init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("full sid")
            .to_string();
        let full_list: Value = client
            .post(&full_url)
            .bearer_auth("secret-token")
            .header("mcp-session-id", &full_sid)
            .body(r#"{"jsonrpc":"2.0","id":11,"method":"tools/list"}"#)
            .send()
            .await
            .expect("full list")
            .json()
            .await
            .expect("json");
        assert_eq!(full_list["result"]["tools"].as_array().unwrap().len(), 46);
        full_server.stop();

        server.stop();
    }

    /// Phase 2 端到端 HTTP `POST /mcp` 测试：覆盖 8 个新零 LLM 工具与 `context.prepare_write`
    /// 的 `prepareId` + `page`（含 Read vs Project 权限闸门、INVALID_PARAMS 拦截与桥层可达性）。
    #[tokio::test]
    async fn http_post_mcp_covers_phase2_eight_tools_and_prepare_id() {
        let client = reqwest::Client::new();
        let valid_sha = "a".repeat(64);

        // 1) Read 会话：6 个 Phase 2 只读工具 + prepareId/page 过闸到达状态桥；
        //    draft.patch 与 draft.record_review 在 Read 下被权限闸门拦截。
        let read_server = start_test_server().await;
        let read_url = format!("http://127.0.0.1:{}/mcp", read_server.port);
        let read_sid = http_initialize(&read_server).await;

        let valid_read_calls: [(&str, Value); 7] = [
            (
                "context.prepare_write",
                json!({ "prepareId": "prep_01", "page": 2, "limit": 8000 }),
            ),
            ("workflow.next", json!({ "targetChapter": 5 })),
            (
                "foreshadowing.list",
                json!({ "status": "overdue", "includeDebt": true }),
            ),
            (
                "character.read",
                json!({ "name": "林清", "includeState": true }),
            ),
            ("outline.read", json!({ "chapterNumber": 5, "window": 2 })),
            (
                "style.exemplars",
                json!({ "markTypes": ["style", "voice"], "topK": 5 }),
            ),
            (
                "chapter.search",
                json!({ "query": "黑铁剑", "scope": "chapters", "chapterStart": 1, "chapterEnd": 10 }),
            ),
        ];
        for (name, args) in valid_read_calls {
            let body = http_call_tool(&client, &read_url, &read_sid, name, args).await;
            assert!(
                body["error"].is_null(),
                "{name} 合法参数不应触发协议层 error: {body}"
            );
            assert_eq!(body["result"]["isError"], json!(true), "{name}: {body}");
            let text = body["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            assert!(!text.contains("权限不足"), "{name} 不应被权限拦截: {text}");
            assert!(
                text.contains("状态桥"),
                "{name} 应通过鉴权/权限/校验到达状态桥: {text}"
            );
        }

        // Read 工具的非法参数在桥前返回协议层 INVALID_PARAMS。
        for (name, bad_args) in [
            ("context.prepare_write", json!({ "offset": 0, "page": 1 })),
            (
                "outline.read",
                json!({ "filename": "main.md", "volume": 1 }),
            ),
            (
                "chapter.search",
                json!({ "query": "剑", "chapterStart": 8, "chapterEnd": 3 }),
            ),
            ("foreshadowing.list", json!({ "status": "invalid_status" })),
        ] {
            let body = http_call_tool(&client, &read_url, &read_sid, name, bad_args).await;
            assert_eq!(
                body["error"]["code"],
                json!(protocol::INVALID_PARAMS),
                "{name} 非法参数必须返回 INVALID_PARAMS: {body}"
            );
        }

        // Read 会话下调用 draft.patch / draft.record_review 必须被权限闸门拦截。
        for (name, args) in [
            (
                "draft.patch",
                json!({
                    "draftId": "d1",
                    "expectedSha256": valid_sha,
                    "edits": [{ "find": "a", "replace": "b" }]
                }),
            ),
            (
                "draft.record_review",
                json!({
                    "draftId": "d1",
                    "expectedSha256": valid_sha,
                    "gates": { "consistency": "pass", "anti_ai": "pass" }
                }),
            ),
        ] {
            let denied = http_call_tool(&client, &read_url, &read_sid, name, args).await;
            assert_eq!(denied["result"]["isError"], json!(true));
            let text = denied["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            assert!(
                text.contains("权限不足") && text.contains("project"),
                "Read 调 {name} 必须被拒绝: {text}"
            );
        }
        read_server.stop();

        // 2) Project 会话：draft.patch 与 draft.record_review 非法参数报 INVALID_PARAMS，合法入参到达状态桥。
        let project_state = ServerState {
            token: "secret-token".into(),
            port: 0,
            registry: Arc::new(tools::build_registry()),
            ctx: Arc::new(ToolContext::for_test()),
            sessions: Arc::new(session::SessionRegistry::new()),
            granted_scope: session::SessionScope::Project,
            revoked: std::sync::atomic::AtomicBool::new(false),
            rate_limiter: Mutex::new(RateLimiter::default_policy()),
        };
        let project_server = serve(project_state, 0).await.expect("start project server");
        let project_url = format!("http://127.0.0.1:{}/mcp", project_server.port);
        let project_sid = http_initialize(&project_server).await;

        for (name, bad_args) in [
            (
                "draft.patch",
                json!({
                    "draftId": "d1",
                    "expectedSha256": "not-a-sha",
                    "edits": [{ "find": "a", "replace": "b" }]
                }),
            ),
            (
                "draft.patch",
                json!({
                    "draftId": "d1",
                    "expectedSha256": valid_sha,
                    "edits": [{ "find": "a", "replace": "b", "startLine": 1 }]
                }),
            ),
            (
                "draft.record_review",
                json!({
                    "draftId": "d1",
                    "expectedSha256": valid_sha,
                    "gates": { "consistency": "warning", "anti_ai": "pass" }
                }),
            ),
        ] {
            let body = http_call_tool(&client, &project_url, &project_sid, name, bad_args).await;
            assert_eq!(
                body["error"]["code"],
                json!(protocol::INVALID_PARAMS),
                "{name} 非法参数必须返回 INVALID_PARAMS: {body}"
            );
        }

        for (name, valid_args) in [
            (
                "draft.patch",
                json!({
                    "draftId": "d1",
                    "expectedSha256": valid_sha,
                    "edits": [{ "startLine": 1, "endLine": 2, "replacement": "修订段落" }],
                    "note": "修复 P0 连续性"
                }),
            ),
            (
                "draft.record_review",
                json!({
                    "draftId": "d1",
                    "expectedSha256": valid_sha,
                    "gates": { "consistency": "pass", "anti_ai": "pass", "quality": "pass" },
                    "overallScore": 9.1,
                    "reviewerRole": "canon-auditor"
                }),
            ),
        ] {
            let body = http_call_tool(&client, &project_url, &project_sid, name, valid_args).await;
            assert!(
                body["error"].is_null(),
                "{name} 合法参数不应报协议错误: {body}"
            );
            let text = body["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            assert!(!text.contains("权限不足"), "{name} 不应被权限拦截: {text}");
            assert!(
                text.contains("状态桥"),
                "{name} 合法入参应到达状态桥: {text}"
            );
        }

        project_server.stop();
    }

    /// Phase 3 端到端 HTTP `POST /mcp` 测试：覆盖 `draft.diff` 与 `audit.longform_health`
    /// （合法参数直达状态桥、非法参数协议层 `INVALID_PARAMS`、以及 `architect` 放行 `audit.longform_health` 且隐藏 `draft.diff`）。
    #[tokio::test]
    async fn http_post_mcp_covers_phase3_draft_diff_and_audit_longform_health() {
        let client = reqwest::Client::new();
        let read_server = start_test_server().await;
        let read_url = format!("http://127.0.0.1:{}/mcp", read_server.port);
        let read_sid = http_initialize(&read_server).await;

        // 1) Read 会话下合法调用全部到达状态桥。
        for (name, args) in [
            (
                "draft.diff",
                json!({ "baseDraftId": "draft_a", "targetDraftId": "draft_b", "contextLines": 2 }),
            ),
            (
                "draft.diff",
                json!({ "draftId": "draft_a", "chapterNumber": 4, "maxHunks": 20, "maxChars": 8000 }),
            ),
            ("audit.longform_health", json!({})),
            (
                "audit.longform_health",
                json!({
                    "currentChapter": 25,
                    "chapterStart": 1,
                    "chapterEnd": 25,
                    "sections": ["foreshadowing", "chaseDebt", "emotion", "drafts", "canonRisk"],
                    "topK": 10,
                    "includeDetails": true,
                    "emotionBreakerThreshold": -0.6
                }),
            ),
        ] {
            let body = http_call_tool(&client, &read_url, &read_sid, name, args).await;
            assert!(
                body["error"].is_null(),
                "{name} 合法参数不应触发协议层 error: {body}"
            );
            assert_eq!(body["result"]["isError"], json!(true), "{name}: {body}");
            let text = body["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default();
            assert!(!text.contains("权限不足"), "{name} 不应被权限拦截: {text}");
            assert!(
                text.contains("状态桥"),
                "{name} 合法入参应到达状态桥: {text}"
            );
        }

        // 2) 非法参数在桥前被拒绝为协议层 INVALID_PARAMS。
        for (name, bad_args) in [
            ("draft.diff", json!({})),
            (
                "draft.diff",
                json!({ "baseDraftId": "d1", "targetDraftId": "d2", "draftId": "d3" }),
            ),
            (
                "draft.diff",
                json!({ "draftId": "d1", "compareToFormal": false }),
            ),
            (
                "audit.longform_health",
                json!({ "volume": 1, "chapterStart": 1 }),
            ),
            (
                "audit.longform_health",
                json!({ "chapterStart": 10, "chapterEnd": 5 }),
            ),
            ("audit.longform_health", json!({ "sections": [] })),
            (
                "audit.longform_health",
                json!({ "emotionBreakerThreshold": 0.5 }),
            ),
        ] {
            let body = http_call_tool(&client, &read_url, &read_sid, name, bad_args).await;
            assert_eq!(
                body["error"]["code"],
                json!(protocol::INVALID_PARAMS),
                "{name} 非法参数必须返回 INVALID_PARAMS: {body}"
            );
        }

        // 3) `architect` Profile 会话：放行 `audit.longform_health` 至状态桥，隐藏 `draft.diff` 并返回 Architect 允许的替代工具。
        let arch_init = client
            .post(format!("{read_url}?profile=architect"))
            .bearer_auth("secret-token")
            .body(r#"{"jsonrpc":"2.0","id":101,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("init architect");
        assert_eq!(arch_init.status(), 200);
        let arch_sid = arch_init
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .expect("arch sid")
            .to_string();

        let arch_health = http_call_tool(
            &client,
            &read_url,
            &arch_sid,
            "audit.longform_health",
            json!({ "volume": 1, "sections": ["foreshadowing", "canonRisk"] }),
        )
        .await;
        assert!(arch_health["error"].is_null(), "{arch_health}");
        let arch_health_text = arch_health["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(
            arch_health_text.contains("状态桥"),
            "architect 调用 audit.longform_health 应放行至状态桥: {arch_health_text}"
        );

        let arch_diff = http_call_tool(
            &client,
            &read_url,
            &arch_sid,
            "draft.diff",
            json!({ "draftId": "d1" }),
        )
        .await;
        assert!(arch_diff["error"].is_null(), "{arch_diff}");
        assert_eq!(arch_diff["result"]["isError"], json!(true));
        let arch_diff_json: Value = serde_json::from_str(
            arch_diff["result"]["content"][0]["text"]
                .as_str()
                .expect("hidden text"),
        )
        .expect("hidden json");
        assert_eq!(arch_diff_json["code"], json!("TOOL_HIDDEN_BY_PROFILE"));
        assert_eq!(arch_diff_json["tool"], json!("draft.diff"));
        assert_eq!(arch_diff_json["activeProfile"], json!("architect"));
        assert_eq!(
            arch_diff_json["replacementTools"],
            json!([
                "audit.longform_health",
                "draft.list",
                "chapter.read",
                "context.prepare_write"
            ])
        );

        read_server.stop();
    }
}
