//! 工具集（P0 只读 → P1 设置写入 → P2 项目动作 → P3 直写，以及一窗口全流程的编排工具）。
//!
//! 本文件包含各权限档的工具，权限不在文件名上分：每个工具用
//! `required_scope()` 声明自己最低需要的档位，调度器在 `dispatch_as` 里逐次校验
//! （见 `mod.rs`）。因此“本文件只放只读工具”这类按文件分的约定已不成立——
//! 新增工具必须做的事是**声明 scope**，并在 `build_registry` 的权限集合断言里
//! 主动改一行。
//!
//! ## 工具为什么是异步的
//!
//! `settings.*` / `project.*` / `chapter.*` 需要经状态桥往返 WebView 读
//! `localStorage`、`status.json` 与章节文件，而桥是异步的（oneshot + 超时）。
//! 用 `block_on` 在 axum 的异步上下文里同步等待会阻塞 worker 线程，所以 trait
//! 直接返回 boxed future，不引入 `async_trait` 依赖。
//!
//! ## 为什么项目相关工具走桥而不是在 Rust 里读文件
//!
//! `status.json` 的读取链路（锁、降级、字段兼容）已经在
//! `src/lib/novel/novel-session-status.ts`；章节文件读取走前端 fs 命令。
//! 在 Rust 另写一份 JSON 解析与目录扫描就是第二套真源，迟早不一致。
//! 唯一留在 Rust 的是 `canon.query`——canon 存储本来就在 Rust 侧。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::protocol::SERVER_VERSION;
use super::registry::ToolError;
use super::session::SessionScope;
use super::state_bridge::{self, StateBridgeState, StateQuery};

/// boxed future 别名（避免引入 async_trait）。
pub type ToolFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 工具执行上下文：需要运行时资源才能实现的工具从这里取。
///
/// `app` 是 `Option` 而不是必填：单元测试里没有真实 `AppHandle`，而纯计算类工具
/// （`app.ping` / `app.status`）本来就不需要它。需要 app 的工具在缺失时返回明确
/// 内部错误——这正好也是应用早期阶段的真实失败模式，不需要另造一套。
pub struct ToolContext {
    pub app: Option<AppHandle>,
    pub bridge: StateBridgeState,
    /// 服务端当前监听端口（`app.status` 回报）。
    pub port: u16,
    /// **本次请求**调用方的有效权限域（`app.status` 如实回报它）。
    ///
    /// 由 `handle_tools_call` 逐请求带入（见 [`ToolContext::for_caller`]），不在
    /// `ServerState` 上原地改：`ctx` 是全局共享资源，把某个会话的 scope 写进去会
    /// 让之后任何请求都读到别人的授权。共享实例上的值只是安全基线（`Read`）。
    pub caller_scope: SessionScope,
}

impl ToolContext {
    /// 仅供测试：无 AppHandle 的上下文。
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            app: None,
            bridge: StateBridgeState::new(),
            port: 0,
            caller_scope: SessionScope::Read,
        }
    }

    /// 派生一个**请求局部**的上下文：共享同一批运行时资源，只替换调用方 scope。
    ///
    /// `AppHandle` 与 `StateBridgeState` 的克隆不复制状态（桥内部是 `Arc`，克隆
    /// 共享同一张待决表），因此这里只把「谁在调」这一条**请求事实**带进工具，
    /// 不新增任何持久状态、也不把 scope 写回共享句柄。
    pub fn for_caller(&self, caller: SessionScope) -> Self {
        Self {
            app: self.app.clone(),
            bridge: self.bridge.clone(),
            port: self.port,
            caller_scope: caller,
        }
    }

    fn app(&self) -> Result<&AppHandle, ToolError> {
        self.app
            .as_ref()
            .ok_or_else(|| ToolError::internal("状态桥不可用：应用句柄未就绪"))
    }

    /// 经状态桥读 WebView 侧状态。
    async fn bridge_query(&self, query: StateQuery) -> Result<Value, ToolError> {
        let app = self.app()?;
        state_bridge::request(app, &self.bridge, query)
            .await
            .map_err(ToolError::internal)
    }

    /// 取当前项目路径（状态桥 `project` op）。
    async fn project_path(&self) -> Result<String, ToolError> {
        let value = self.bridge_query(StateQuery::new("project")).await?;
        value
            .get("projectPath")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| ToolError::internal("状态桥未返回 projectPath"))
    }
}

/// `app.status` —— 应用与 MCP 服务端自身的状态。
///
/// 不读项目、不读设置：它回答的是「我在跟谁说话、它什么版本、什么模式」，以及
/// **这一次请求**带着哪一档权限（`readOnly` / `scope` 都取自请求局部上下文，
/// 不取服务器基础 scope，也不取客户端参数推断）。
pub struct AppStatusTool;

impl super::registry::McpTool for AppStatusTool {
    fn name(&self) -> &'static str {
        "app.status"
    }

    fn description(&self) -> &'static str {
        "Application and MCP server status: version, build mode, listen port. Reads nothing from the project."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        _args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let scope = ctx.caller_scope;
            Ok(json!({
                "version": SERVER_VERSION,
                "mode": if cfg!(debug_assertions) { "dev" } else { "production" },
                "listen": format!("127.0.0.1:{}", ctx.port),
                // 只读档 = 没有任何写能力；其余档虽非只读，也不等于有直写正文
                // 权限（那仍是 `full` 的逐会话授权），故同时回 `scope` 让人看清。
                "readOnly": scope == SessionScope::Read,
                "scope": scope.as_str(),
            }))
        })
    }
}

/// `settings.schema` —— 设置目录全量。
pub struct SettingsSchemaTool;

impl super::registry::McpTool for SettingsSchemaTool {
    fn name(&self) -> &'static str {
        "settings.schema"
    }

    fn description(&self) -> &'static str {
        "Full settings catalog: key, storage, kind, defaultValue, enumValues, scope, human label."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        _args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move { ctx.bridge_query(StateQuery::new("schema")).await })
    }
}

/// `settings.list` —— 全部设置的当前值。
///
/// 凭据类只回「已配置/未配置」，永不明文——这是 C-009 在工具层的落实。
pub struct SettingsListTool;

impl super::registry::McpTool for SettingsListTool {
    fn name(&self) -> &'static str {
        "settings.list"
    }

    fn description(&self) -> &'static str {
        "Current value of every registered setting. Secret categories report configured/not-configured only, never plaintext."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        _args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move { ctx.bridge_query(StateQuery::new("list")).await })
    }
}

/// `settings.get` —— 单个设置的值。未登记键由前端白名单拒绝。
pub struct SettingsGetTool;

impl super::registry::McpTool for SettingsGetTool {
    fn name(&self) -> &'static str {
        "settings.get"
    }

    fn description(&self) -> &'static str {
        "Read one registered setting by key. Unregistered keys are rejected by the bridge whitelist."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": { "type": "string", "description": "Registered setting key, e.g. lk-graph-edge-style" }
            },
            "required": ["key"],
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let key = args.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
                ToolError::invalid_params("settings.get requires string argument `key`")
            })?;
            if key.trim().is_empty() {
                return Err(ToolError::invalid_params("`key` must not be empty"));
            }
            ctx.bridge_query(StateQuery::with_key("get", key)).await
        })
    }
}

/// `project.state` —— 当前项目与 `.novel/status.json` 的只读投影。
/// `settings.set` —— 修改一个已登记设置项（P1 唯一的写工具）。
///
/// ## 为什么审计写在 Rust 而不是前端
///
/// 审计的用途是「事后能查外部 Agent 改过什么」。如果由前端写，前端崩了/被绕过就
/// 没有痕迹，而 Rust 这一层是每次调用必经之路。审计**没有开关**：不是配置项，
/// 没有「关闭审计」的分支——这是设计约束，不是遗漏。
///
/// ## 为什么先开文件再写入
///
/// 顺序是「先确保审计可落盘 → 再改设置 → 再写审计行」。反过来（先改再写审计）
/// 一旦落盘失败就会出现「改了但没有痕迹」的状态。先开文件把这种情况挡在前面。
///
/// ## 为什么没有项目就拒绝
///
/// 审计路径是项目相对的 `.novel/audit/external-writes.jsonl`。没有项目就没有
/// 审计落点；此时放行等于允许一次无痕写入，所以直接拒绝并说明原因。
pub struct SettingsSetTool;

/// 一条外部写入审计记录（append-only JSONL 的一行）。
#[derive(Debug, serde::Serialize)]
struct ExternalWriteAudit<'a> {
    ts: String,
    source: &'a str,
    tool: &'a str,
    key: &'a str,
    before_hash: String,
    after_hash: String,
}

/// 值 → 稳定字符串 → sha256 十六进制。
///
/// 用 JSON 序列化而不是 `Debug`：前者对同一值稳定，且能区分 `"1"` 与 `1`。
fn value_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let text = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

impl super::registry::McpTool for SettingsSetTool {
    fn name(&self) -> &'static str {
        "settings.set"
    }

    fn description(&self) -> &'static str {
        "Change one registered setting. Takes effect immediately in the UI and persists across restart. Every write is appended to .novel/audit/external-writes.jsonl. Secret values cannot be written."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": { "type": "string", "description": "Registered setting key, e.g. theme or niko-buddy-ui-font-size-scale" },
                "value": {
                    "description": "New value. Type must match the schema: number for numeric keys, boolean for switches, string for enums/models. Out-of-range values are rejected, never clamped."
                }
            },
            "required": ["key", "value"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        // 唯一的写工具：权限闸门在 mod.rs 的请求管线里统一比对。
        super::session::SessionScope::Settings
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let key = args.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
                ToolError::invalid_params("settings.set requires string argument `key`")
            })?;
            if key.trim().is_empty() {
                return Err(ToolError::invalid_params("`key` must not be empty"));
            }
            // `value` 必须显式给出：`null` 是合法值（清除模型选择），缺字段不是。
            let value = args.get("value").ok_or_else(|| {
                ToolError::invalid_params("settings.set requires argument `value`")
            })?;

            // 审计落点先就位，避免"改了但没有痕迹"；验证可写后立即释放句柄，不在 .await 期间占用文件锁。
            let project_path = ctx.project_path().await?;
            let project_path_probe = project_path.clone();
            let audit_path = tokio::task::spawn_blocking(move || -> Result<PathBuf, ToolError> {
                let (audit_file, audit_path) = open_audit_log(Path::new(&project_path_probe))?;
                drop(audit_file);
                Ok(audit_path)
            })
            .await
            .map_err(|e| ToolError::internal(format!("settings.set 审计检查任务异常: {e}")))??;

            let outcome = ctx
                .bridge_query(StateQuery::with_key("set", key).with_value(value.clone()))
                .await?;

            let before_hash = value_hash(outcome.get("before").unwrap_or(&Value::Null));
            let after_hash = value_hash(outcome.get("after").unwrap_or(&Value::Null));
            let key_owned = key.to_string();
            let before_hash_for_audit = before_hash.clone();
            let after_hash_for_audit = after_hash.clone();
            let audit_write = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let (mut audit_file, _) =
                    open_audit_log(Path::new(&project_path)).map_err(|e| e.message)?;
                let record = ExternalWriteAudit {
                    ts: chrono::Utc::now().to_rfc3339(),
                    source: "external_agent",
                    tool: "settings.set",
                    key: &key_owned,
                    before_hash: before_hash_for_audit,
                    after_hash: after_hash_for_audit,
                };
                sync_audit_line(&mut audit_file, &record)
            })
            .await
            .map_err(|e| {
                ToolError::internal(format!(
                    "设置已修改（{key}），但审计落盘任务异常: {e}。请检查 {} 的可写性。",
                    audit_path.display()
                ))
            })?;
            if let Err(e) = audit_write {
                // 写入已生效、审计没落盘：必须显式报出来，不能让调用方以为没发生。
                return Err(ToolError::internal(format!(
                    "设置已修改（{key}），但审计落盘失败: {e}。请检查 {} 的可写性。",
                    audit_path.display()
                )));
            }

            Ok(json!({
                "key": key,
                "storage": outcome.get("storage").cloned().unwrap_or(Value::Null),
                "before": outcome.get("before").cloned().unwrap_or(Value::Null),
                "after": outcome.get("after").cloned().unwrap_or(Value::Null),
                "audit": {
                    "path": audit_path.display().to_string(),
                    "beforeHash": before_hash,
                    "afterHash": after_hash,
                }
            }))
        })
    }
}

pub struct ProjectStateTool;

impl super::registry::McpTool for ProjectStateTool {
    fn name(&self) -> &'static str {
        "project.state"
    }

    fn description(&self) -> &'static str {
        "Current project path plus the read-only projection of .novel/status.json (session status, current chapter, decision gates). Errors if no project is open."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        _args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            // 桥超时/未打开项目都是「调用成功但没办成」：bridge_query 已把它们标成
            // INTERNAL_ERROR，因此走 200 + isError，客户端不会误以为是参数写错去重试。
            ctx.bridge_query(StateQuery::new("project-state")).await
        })
    }
}

/// `chapter.list` —— 章节文件列表。
pub struct ChapterListTool;

impl super::registry::McpTool for ChapterListTool {
    fn name(&self) -> &'static str {
        "chapter.list"
    }

    fn description(&self) -> &'static str {
        "List chapter markdown files under <project>/wiki/chapters, ordered by filename with 1-based index."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        _args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move { ctx.bridge_query(StateQuery::new("chapter-list")).await })
    }
}

/// `chapter.read` —— 单章正文，带行窗口。
///
/// 默认只回 200 行：单章动辄上万字，不设窗口会撑爆 MCP 响应（客户端有内容上限，
/// 超了就是一次静默失败）。`truncated` 明确告诉调用方还有没读完的部分。
pub struct ChapterReadTool;

impl super::registry::McpTool for ChapterReadTool {
    fn name(&self) -> &'static str {
        "chapter.read"
    }

    fn description(&self) -> &'static str {
        "Read one chapter's text by 1-based index or filename. Returns at most `limit` lines (default 200) starting at `offset`; `truncated` says whether more remains."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "chapter": {
                    "type": "string",
                    "description": "1-based chapter index (e.g. \"3\") or filename (e.g. \"chapter-003.md\")"
                },
                "offset": { "type": "integer", "minimum": 0, "description": "0-based first line (default 0)" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 2000, "description": "Max lines to return (default 200)" }
            },
            "required": ["chapter"],
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let chapter = args
                .get("chapter")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ToolError::invalid_params("chapter.read requires string argument `chapter`")
                })?;
            if chapter.trim().is_empty() {
                return Err(ToolError::invalid_params("`chapter` must not be empty"));
            }
            let offset = args.get("offset").and_then(|v| v.as_u64());
            let limit = args.get("limit").and_then(|v| v.as_u64());
            ctx.bridge_query(
                StateQuery::with_path("chapter-read", chapter).with_window(offset, limit),
            )
            .await
        })
    }
}

/// 取可选布尔参数。给了就必须是 boolean——把字符串 "true" 当真的话，调用方
/// 会以为自己开了网络授权，实际没开（或反之）。
fn optional_bool(args: &Value, tool: &str, field: &str) -> Result<Option<bool>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(other) => Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 必须是 boolean，收到 {other}"
        ))),
    }
}

/// 取可选的 [min, max] 整数参数。负数/小数/字符串一律报错，不静默钳制。
fn optional_int_in_range(
    args: &Value,
    tool: &str,
    field: &str,
    min: u64,
    max: u64,
) -> Result<Option<u64>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_u64() {
            Some(n) if n >= min && n <= max => Ok(Some(n)),
            _ => Err(ToolError::invalid_params(format!(
                "{tool}: `{field}` 必须是 {min}..={max} 的整数，收到 {v}"
            ))),
        },
    }
}

/// `context.inspect` —— 只读上下文回读（生效配置 + 选定章来源/窗口/哈希）。
///
/// 默认 **0 次 pack 构建**：只回真实生效配置、章节来源与 review 窗口。
/// 显式 `includePack` / `dimension` 才触发一次生产 `buildContextPack`；
/// embedding/rerank 生效时检索会真出网，故 `allowRetrievalNetwork` 默认 false
/// 并在构建前拒绝，只有显式 true 才按真实配置构建（绝不改写成 disabled）。
///
/// `dimension` 在 schema 里刻意保持 `string` 而不列 enum：六维真源是前端
/// `SIX_REVIEW_DIMENSION_ORDER`，在 Rust 再抄一份枚举就会出现「Rust 列了但生产
/// 没有」/「生产加了但 Rust 漏了」的漂移。非法键由前端真源严格拒绝。
pub struct ContextInspectTool;

/// 与前端 `MAX_PROMPT_PAGE_CHARS` 对齐的单页硬上限。
const CONTEXT_INSPECT_PROMPT_LIMIT_MAX: u64 = 50_000;

impl super::registry::McpTool for ContextInspectTool {
    fn name(&self) -> &'static str {
        "context.inspect"
    }

    fn description(&self) -> &'static str {
        "Read-only context readback: the effective runtime config (public fields only), the selected chapter's exact source path/size/UTF-8 SHA-256, and the review window. Builds no ContextPack by default; includePack=true returns a full production ContextPack copy and a new opaque inspectionId. Reuse that ID with the same chapter/task/network policy for six dimensions and pages (8 in-memory snapshots, 5-minute TTL; unknown, expired or drifted IDs fail without rebuilding). dimension returns the base production user analysis prompt; runtime skill hook fragments and system prompt are not included. promptOffset/promptLimit use UTF-16 code units. includeChapter=true returns the exact chapter text. Building requires allowRetrievalNetwork=true when embedding/rerank retrieval is enabled because that build really uses the network. Never writes chapter text, drafts, memory, settings or telemetry."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "chapter": {
                    "type": "string",
                    "description": "1-based chapter index (e.g. \"3\") or exact listed filename; never an arbitrary filesystem path"
                },
                "task": {
                    "type": "string",
                    "description": "Caller-supplied frozen task passed to the production builder (default: 六维审查第N章)"
                },
                "inspectionId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Opaque ID returned by a prior includePack or dimension call. Reuse only with the same chapter, task and allowRetrievalNetwork policy; unknown/expired/drifted IDs are rejected without a new build."
                },
                "includePack": {
                    "type": "boolean",
                    "description": "Return the actual full ContextPack produced by the production builder (default false)"
                },
                "dimension": {
                    "type": "string",
                    "description": "One production six-dimension key: thrill, consistency, pacing, character, continuity, pull. Validated in the WebView against SIX_REVIEW_DIMENSION_ORDER; one dimension per call."
                },
                "includeChapter": {
                    "type": "boolean",
                    "description": "Return the exact chapter text read through the existing Tauri FS (default false)"
                },
                "allowRetrievalNetwork": {
                    "type": "boolean",
                    "description": "Explicit opt-in for a build while embedding/rerank retrieval is enabled (default false: the build is refused before any network call)"
                },
                "promptOffset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "0-based UTF-16 code-unit offset into the frozen base production prompt (default 0)"
                },
                "promptLimit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50_000,
                    "description": "Page length in UTF-16 code units (default 16000); never changes the review chapter window"
                }
            },
            "required": ["chapter"],
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let tool = "context.inspect";
            let object = args
                .as_object()
                .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 参数必须是 object")))?;
            let allowed_fields = [
                "chapter",
                "task",
                "inspectionId",
                "dimension",
                "includePack",
                "includeChapter",
                "allowRetrievalNetwork",
                "promptOffset",
                "promptLimit",
            ];
            for (field, value) in object {
                if !allowed_fields.contains(&field.as_str()) {
                    return Err(ToolError::invalid_params(format!(
                        "{tool}: 未知参数 `{field}`"
                    )));
                }
                if value.is_null() {
                    return Err(ToolError::invalid_params(format!(
                        "{tool}: `{field}` 不接受显式 null"
                    )));
                }
            }
            let chapter = require_str(args, tool, "chapter")?;
            let mut params = json!({ "chapter": chapter });

            match args.get("task") {
                None => {}
                Some(Value::String(task)) if !task.trim().is_empty() => {
                    params["task"] = json!(task);
                }
                Some(other) => {
                    return Err(ToolError::invalid_params(format!(
                        "{tool}: `task` 必须是非空字符串，收到 {other}"
                    )))
                }
            }
            match args.get("dimension") {
                None => {}
                Some(Value::String(dim)) if !dim.trim().is_empty() => {
                    params["dimension"] = json!(dim);
                }
                Some(other) => {
                    return Err(ToolError::invalid_params(format!(
                        "{tool}: `dimension` 必须是非空字符串，收到 {other}"
                    )))
                }
            }
            match args.get("inspectionId") {
                None => {}
                Some(Value::String(id)) if !id.trim().is_empty() => {
                    params["inspectionId"] = json!(id);
                }
                Some(other) => {
                    return Err(ToolError::invalid_params(format!(
                        "{tool}: `inspectionId` 必须是非空字符串，收到 {other}"
                    )))
                }
            }

            for field in ["includePack", "includeChapter", "allowRetrievalNetwork"] {
                if let Some(value) = optional_bool(args, tool, field)? {
                    params[field] = json!(value);
                }
            }
            if let Some(offset) = optional_int_in_range(args, tool, "promptOffset", 0, u64::MAX)? {
                params["promptOffset"] = json!(offset);
            }
            if let Some(limit) = optional_int_in_range(
                args,
                tool,
                "promptLimit",
                1,
                CONTEXT_INSPECT_PROMPT_LIMIT_MAX,
            )? {
                params["promptLimit"] = json!(limit);
            }

            let needs_async_build = params.get("includePack").and_then(|v| v.as_bool())
                == Some(true)
                || params.get("dimension").is_some()
                || params.get("inspectionId").is_some();
            if !needs_async_build {
                return ctx
                    .bridge_query(StateQuery::new("context-inspect").with_params(params))
                    .await;
            }
            run_context_inspect_async(
                params,
                CONTEXT_INSPECT_POLL_INTERVAL,
                CONTEXT_INSPECT_MAX_WAIT,
                |query| ctx.bridge_query(query),
            )
            .await
        })
    }
}

const CONTEXT_INSPECT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
const CONTEXT_INSPECT_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(180);

/// 通用异步桥任务轮询执行器（由 `context.inspect` 与 `context.prepare_write` 共享）。
///
/// 先发 `start_op`：若前端同步完成则直接返回；若进入后台异步任务，则按
/// `poll_interval` 轮询 `poll_op` 直至 `done` / `failed` 或超过 `max_wait`。
async fn run_async_bridge_job<F, Fut>(
    tool_name: &str,
    start_op: &str,
    poll_op: &str,
    params: Value,
    poll_interval: std::time::Duration,
    max_wait: std::time::Duration,
    mut query_bridge: F,
) -> Result<Value, ToolError>
where
    F: FnMut(StateQuery) -> Fut,
    Fut: Future<Output = Result<Value, ToolError>>,
{
    let started = query_bridge(StateQuery::new(start_op).with_params(params)).await?;
    match started.get("status").and_then(|v| v.as_str()) {
        Some("done") => return Ok(started.get("value").cloned().unwrap_or(Value::Null)),
        Some("failed") => {
            let msg = started
                .get("error")
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("{tool_name} 失败"));
            return Err(ToolError::internal(msg));
        }
        Some("running") => {}
        other => {
            return Err(ToolError::internal(format!(
                "{start_op} 返回未知状态：{other:?}"
            )))
        }
    }
    let job_id = started
        .get("jobId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::internal(format!("{start_op} 缺少 jobId")))?
        .to_string();

    let deadline = std::time::Instant::now() + max_wait;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(ToolError::internal(format!(
                "{tool_name} 任务超时（>{}s，jobId={job_id}）",
                max_wait.as_secs()
            )));
        }
        tokio::time::sleep(poll_interval).await;
        let polled =
            query_bridge(StateQuery::new(poll_op).with_params(json!({ "jobId": job_id }))).await?;
        match polled.get("status").and_then(|v| v.as_str()) {
            Some("running") => continue,
            Some("done") => return Ok(polled.get("value").cloned().unwrap_or(Value::Null)),
            Some("failed") => {
                let msg = polled
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("{tool_name} 失败"));
                return Err(ToolError::internal(msg));
            }
            other => {
                return Err(ToolError::internal(format!(
                    "{poll_op} 返回未知状态：{other:?}"
                )))
            }
        }
    }
}

async fn run_context_inspect_async<F, Fut>(
    params: Value,
    poll_interval: std::time::Duration,
    max_wait: std::time::Duration,
    query_bridge: F,
) -> Result<Value, ToolError>
where
    F: FnMut(StateQuery) -> Fut,
    Fut: Future<Output = Result<Value, ToolError>>,
{
    run_async_bridge_job(
        "context.inspect",
        "context-inspect-start",
        "context-inspect-poll",
        params,
        poll_interval,
        max_wait,
        query_bridge,
    )
    .await
}

/// `canon.query` —— 复用既有 `canon_query_impl` 读 canon 边。
///
/// **参数是真实的 `CanonEdgeFilter` 形状，不是自由文本 `q`。** 任务描述写的
/// `canon.query(q)` 是简写；canon 的过滤维度是认知轴（known_by）/世界时态
/// （valid_at_chapter）/谓词/端点/类别/模态，没有「全文搜索」这一维。凭空把 q
/// 映射成 entity_ids 或 predicates 就是编造数据语义——那会让调用方以为自己在做
/// 全文检索，实际只做了精确匹配。因此这里暴露真实字段，让过滤语义与存储一致。
pub struct CanonQueryTool;

impl super::registry::McpTool for CanonQueryTool {
    fn name(&self) -> &'static str {
        "canon.query"
    }

    fn description(&self) -> &'static str {
        "Query canon edges of the current project. `filter` accepts the real CanonEdgeFilter fields: knownBy, validAtChapter, includeInvalidated, edgeKinds, modalities, predicates, entityIds, archived, limit, offset."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filter": {
                    "type": "object",
                    "description": "CanonEdgeFilter fields; omit for all non-archived edges",
                    "properties": {
                        "knownBy": { "type": "string" },
                        "validAtChapter": { "type": "integer" },
                        "includeInvalidated": { "type": "boolean" },
                        "maxRecordedRevision": { "type": "integer", "minimum": 0 },
                        "edgeKinds": { "type": "array", "items": { "type": "string" } },
                        "modalities": { "type": "array", "items": { "type": "string" } },
                        "predicates": { "type": "array", "items": { "type": "string" } },
                        "entityIds": { "type": "array", "items": { "type": "string" } },
                        "archived": { "type": "boolean" },
                        "limit": { "type": "integer", "minimum": 1 },
                        "offset": { "type": "integer", "minimum": 0 }
                    },
                    "additionalProperties": false
                }
            },
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            use crate::canon::commands::CanonCommandState;
            use crate::canon::commands_core::canon_query_impl;
            use crate::canon::types_query::CanonEdgeFilter;

            let app = ctx.app()?.clone();
            let project_path = ctx.project_path().await?;

            let filter_value = args.get("filter").cloned().unwrap_or_else(|| json!({}));
            let filter: CanonEdgeFilter = serde_json::from_value(filter_value)
                .map_err(|e| ToolError::invalid_params(format!("`filter` is invalid: {e}")))?;

            let state = app.state::<CanonCommandState>();
            let response = canon_query_impl(&state, project_path, filter)
                .await
                .map_err(|e| ToolError {
                    code: crate::mcp_server::protocol::INTERNAL_ERROR,
                    message: e,
                })?;
            serde_json::to_value(response).map_err(|e| ToolError::internal(e.to_string()))
        })
    }
}

// ── Zero-LLM 只读创作辅助工具（draft.* / rules.get / gate.check_mechanical）───

const DRAFT_ID_MAX_LEN: usize = 128;
const DRAFT_READ_DEFAULT_LIMIT: u64 = 200;
const DRAFT_READ_MAX_LIMIT: u64 = 2000;
const RULES_GET_MAX_SECTIONS: usize = 16;
const RULES_GET_ALLOWED_SECTIONS: [&str; 4] = ["writingStyle", "antiAi", "bookRules", "planning"];
const MECHANICAL_GATE_MAX_CHAPTER_CHARS: usize = 256;
const MECHANICAL_GATE_MAX_TEXT_CHARS: usize = 100_000;

/// 严格校验工具入参：必须是 JSON object，拒绝未知键与显式 `null`。
fn validate_strict_object_args<'a>(
    args: &'a Value,
    tool: &str,
    allowed_fields: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, ToolError> {
    let object = args
        .as_object()
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 参数必须是 object")))?;
    for (field, value) in object {
        if !allowed_fields.contains(&field.as_str()) {
            return Err(ToolError::invalid_params(format!(
                "{tool}: 未知参数 `{field}`"
            )));
        }
        if value.is_null() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `{field}` 不接受显式 null"
            )));
        }
    }
    Ok(object)
}

/// 严格校验 `draftId`：1..=128 个 ASCII `[a-zA-Z0-9_-]` 字符。
fn validate_draft_id<'a>(raw: &'a str, tool: &str) -> Result<&'a str, ToolError> {
    if raw.is_empty()
        || raw.len() > DRAFT_ID_MAX_LEN
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `draftId` 必须是 1..={DRAFT_ID_MAX_LEN} 个 ASCII [a-zA-Z0-9_-] 字符"
        )));
    }
    Ok(raw)
}

/// 严格校验机械门控的 `chapter` 选择器：1..=256 字符、非空白、无控制字符、无 `..`、无路径分隔符。
fn validate_mechanical_chapter<'a>(raw: &'a str, tool: &str) -> Result<&'a str, ToolError> {
    let char_len = raw.chars().count();
    if char_len == 0
        || char_len > MECHANICAL_GATE_MAX_CHAPTER_CHARS
        || raw.trim().is_empty()
        || raw.chars().any(char::is_control)
        || raw.contains("..")
        || raw.contains('/')
        || raw.contains('\\')
    {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `chapter` 必须是 1..={MECHANICAL_GATE_MAX_CHAPTER_CHARS} 字符的非空章节编号或文件名，且不得包含控制字符、`..`、`/` 或 `\\`"
        )));
    }
    Ok(raw)
}

fn build_draft_list_query(args: &Value) -> Result<StateQuery, ToolError> {
    validate_strict_object_args(args, "draft.list", &[])?;
    Ok(StateQuery::new("draft-list"))
}

fn build_draft_read_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "draft.read";
    validate_strict_object_args(args, tool, &["draftId", "offset", "limit"])?;
    let draft_id = args
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `draftId`")))?;
    let draft_id = validate_draft_id(draft_id, tool)?;
    let offset = optional_int_in_range(args, tool, "offset", 0, u64::MAX)?.unwrap_or(0);
    let limit = optional_int_in_range(args, tool, "limit", 1, DRAFT_READ_MAX_LIMIT)?
        .unwrap_or(DRAFT_READ_DEFAULT_LIMIT);
    Ok(StateQuery::new("draft-read").with_params(json!({
        "draftId": draft_id,
        "offset": offset,
        "limit": limit,
    })))
}

fn build_rules_get_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "rules.get";
    validate_strict_object_args(args, tool, &["sections"])?;
    let sections: Vec<&'static str> = match args.get("sections") {
        None => RULES_GET_ALLOWED_SECTIONS.to_vec(),
        Some(value) => {
            let arr = value.as_array().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `sections` 必须是非空数组"))
            })?;
            if arr.is_empty() {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `sections` 不能为空数组"
                )));
            }
            if arr.len() > RULES_GET_MAX_SECTIONS {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `sections` 长度不能超过 {RULES_GET_MAX_SECTIONS}，收到 {}",
                    arr.len()
                )));
            }
            let mut deduped = Vec::with_capacity(arr.len());
            let mut seen = HashSet::with_capacity(arr.len());
            for (idx, item) in arr.iter().enumerate() {
                let raw = item.as_str().ok_or_else(|| {
                    ToolError::invalid_params(format!(
                        "{tool}: `sections[{idx}]` 必须是字符串，收到 {item}"
                    ))
                })?;
                let matched = RULES_GET_ALLOWED_SECTIONS
                    .iter()
                    .copied()
                    .find(|allowed| *allowed == raw)
                    .ok_or_else(|| {
                        ToolError::invalid_params(format!(
                            "{tool}: `sections[{idx}]` 只接受 writingStyle / antiAi / bookRules / planning，收到 {raw}"
                        ))
                    })?;
                if seen.insert(matched) {
                    deduped.push(matched);
                }
            }
            deduped
        }
    };
    Ok(StateQuery::new("rules-get").with_params(json!({ "sections": sections })))
}

fn build_gate_check_mechanical_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "gate.check_mechanical";
    let object =
        validate_strict_object_args(args, tool, &["draftId", "chapter", "text", "chapterNumber"])?;
    let source_count = ["draftId", "chapter", "text"]
        .iter()
        .filter(|field| object.contains_key(**field))
        .count();
    if source_count != 1 {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 必须且只能提供 `draftId`、`chapter`、`text` 三者之一"
        )));
    }

    let mut params = json!({});
    if let Some(v) = object.get("draftId") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `draftId` 必须是字符串，收到 {v}"))
        })?;
        let draft_id = validate_draft_id(raw, tool)?;
        params["draftId"] = json!(draft_id);
    } else if let Some(v) = object.get("chapter") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `chapter` 必须是字符串，收到 {v}"))
        })?;
        let chapter = validate_mechanical_chapter(raw, tool)?;
        params["chapter"] = json!(chapter);
    } else if let Some(v) = object.get("text") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `text` 必须是字符串，收到 {v}"))
        })?;
        let char_len = raw.chars().count();
        if raw.trim().is_empty() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `text` 不能为空"
            )));
        }
        if char_len > MECHANICAL_GATE_MAX_TEXT_CHARS {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `text` 长度不能超过 {MECHANICAL_GATE_MAX_TEXT_CHARS} 字符，收到 {char_len}"
            )));
        }
        params["text"] = json!(raw);
    }

    if let Some(chapter_number) = optional_int_in_range(args, tool, "chapterNumber", 1, u64::MAX)? {
        params["chapterNumber"] = json!(chapter_number);
    }

    Ok(StateQuery::new("gate-check-mechanical").with_params(params))
}

/// `draft.list` —— 列出当前项目的待审/就绪草稿（只读，零 LLM 调用）。
pub struct DraftListTool;

impl super::registry::McpTool for DraftListTool {
    fn name(&self) -> &'static str {
        "draft.list"
    }

    fn description(&self) -> &'static str {
        "List chapter drafts in the current project's draft area (.qm-drafts). Read-only, zero LLM calls."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_draft_list_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

/// `draft.read` —— 按行窗口只读某个草稿正文（零 LLM 调用）。
pub struct DraftReadTool;

impl super::registry::McpTool for DraftReadTool {
    fn name(&self) -> &'static str {
        "draft.read"
    }

    fn description(&self) -> &'static str {
        "Read one draft's text by draftId. Returns at most `limit` lines (default 200, max 2000) starting at 0-based `offset` (default 0). Read-only, zero LLM calls."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "draftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Draft ID returned by draft.list or chapter.write"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "0-based first line (default 0)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": DRAFT_READ_MAX_LIMIT,
                    "description": "Max lines to return (default 200)"
                }
            },
            "required": ["draftId"],
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_draft_read_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

/// `rules.get` —— 读取当前项目的写作规范/反 AI 规则/书规/规划摘要（只读，零 LLM 调用）。
pub struct RulesGetTool;

impl super::registry::McpTool for RulesGetTool {
    fn name(&self) -> &'static str {
        "rules.get"
    }

    fn description(&self) -> &'static str {
        "Read active writing rules and planning guidance for the current project. Optional `sections` filters any subset of [writingStyle, antiAi, bookRules, planning] (default: all four). Read-only, zero LLM calls."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "sections": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": RULES_GET_MAX_SECTIONS,
                    "items": {
                        "type": "string",
                        "enum": RULES_GET_ALLOWED_SECTIONS
                    },
                    "description": "Rule sections to fetch (default: all four)"
                }
            },
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_rules_get_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

/// `gate.check_mechanical` —— 对草稿/章节/纯文本执行零 LLM 机械门控检查（只读）。
pub struct GateCheckMechanicalTool;

impl super::registry::McpTool for GateCheckMechanicalTool {
    fn name(&self) -> &'static str {
        "gate.check_mechanical"
    }

    fn description(&self) -> &'static str {
        "Run deterministic zero-LLM mechanical gate checks (anti-AI patterns, formatting, word/line metrics) on exactly one of `draftId`, `chapter`, or raw `text`. Read-only; never modifies chapters, drafts, or memory."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "draftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Draft ID to check (mutually exclusive with chapter and text)"
                },
                "chapter": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MECHANICAL_GATE_MAX_CHAPTER_CHARS,
                    "description": "1-based chapter index or filename to check (mutually exclusive with draftId and text)"
                },
                "text": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MECHANICAL_GATE_MAX_TEXT_CHARS,
                    "description": "Raw chapter text to check mechanically (mutually exclusive with draftId and chapter)"
                },
                "chapterNumber": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based chapter number for mechanical check context"
                }
            },
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_gate_check_mechanical_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

const CONTEXT_PREPARE_MAX_TASK_CHARS: usize = 4_000;
const CONTEXT_PREPARE_MAX_DIMENSION_CHARS: usize = 64;
const CONTEXT_PREPARE_DEFAULT_LIMIT: u64 = 16_000;
const CONTEXT_PREPARE_LIMIT_MAX: u64 = 50_000;
/// JS `Number.MAX_SAFE_INTEGER`（2^53 - 1），避免透传到 WebView JSON 时发生双精度截断。
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn build_context_prepare_write_params(args: &Value) -> Result<Value, ToolError> {
    let tool = "context.prepare_write";
    let object = validate_strict_object_args(
        args,
        tool,
        &[
            "targetChapter",
            "draftId",
            "task",
            "includePack",
            "includeDraft",
            "includePlanningView",
            "dimension",
            "allowRetrievalNetwork",
            "offset",
            "limit",
        ],
    )?;

    let mut params = json!({});

    if let Some(target_chapter) =
        optional_int_in_range(args, tool, "targetChapter", 1, JS_MAX_SAFE_INTEGER)?
    {
        params["targetChapter"] = json!(target_chapter);
    }

    if let Some(v) = object.get("draftId") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `draftId` 必须是字符串，收到 {v}"))
        })?;
        let draft_id = validate_draft_id(raw, tool)?;
        params["draftId"] = json!(draft_id);
    }

    if let Some(v) = object.get("task") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `task` 必须是字符串，收到 {v}"))
        })?;
        if raw.trim().is_empty() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `task` 必须是非空字符串"
            )));
        }
        let char_len = raw.chars().count();
        if char_len > CONTEXT_PREPARE_MAX_TASK_CHARS {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `task` 长度不能超过 {CONTEXT_PREPARE_MAX_TASK_CHARS} 字符，收到 {char_len}"
            )));
        }
        params["task"] = json!(raw);
    }

    for field in ["includePack", "includeDraft", "includePlanningView"] {
        if let Some(flag) = optional_bool(args, tool, field)? {
            params[field] = json!(flag);
        }
    }

    if let Some(v) = object.get("dimension") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `dimension` 必须是字符串，收到 {v}"))
        })?;
        if raw.trim().is_empty() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `dimension` 必须是非空字符串"
            )));
        }
        let char_len = raw.chars().count();
        if char_len > CONTEXT_PREPARE_MAX_DIMENSION_CHARS {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `dimension` 长度不能超过 {CONTEXT_PREPARE_MAX_DIMENSION_CHARS} 字符，收到 {char_len}"
            )));
        }
        params["dimension"] = json!(raw);
    }

    let allow_retrieval_network =
        optional_bool(args, tool, "allowRetrievalNetwork")?.unwrap_or(false);
    let offset = optional_int_in_range(args, tool, "offset", 0, JS_MAX_SAFE_INTEGER)?.unwrap_or(0);
    let limit = optional_int_in_range(args, tool, "limit", 1, CONTEXT_PREPARE_LIMIT_MAX)?
        .unwrap_or(CONTEXT_PREPARE_DEFAULT_LIMIT);

    params["allowRetrievalNetwork"] = json!(allow_retrieval_network);
    params["offset"] = json!(offset);
    params["limit"] = json!(limit);

    Ok(params)
}

fn build_director_check_query(args: &Value) -> Result<StateQuery, ToolError> {
    validate_strict_object_args(args, "director.check", &[])?;
    Ok(StateQuery::new("director-check"))
}

/// `context.prepare_write` —— 为下一章写作准备只读上下文包与规划视图（零 LLM 调用）。
///
/// 复用共享异步桥轮询机制（`context-prepare-start` / `context-prepare-poll`），
/// 默认 `allowRetrievalNetwork = false` 避免隐式出网；`dimension` 不在 Rust 侧列举枚举，
/// 统一由前端真源 `SIX_REVIEW_DIMENSION_ORDER` 校验。
pub struct ContextPrepareWriteTool;

impl super::registry::McpTool for ContextPrepareWriteTool {
    fn name(&self) -> &'static str {
        "context.prepare_write"
    }

    fn description(&self) -> &'static str {
        "Assemble read-only writing preparation context (effective config, planning view, optional draft snippet, optional ContextPack/dimension prompt) for the target chapter or draft. Zero LLM calls; allowRetrievalNetwork defaults to false and refuses network retrieval unless explicitly opted in. Never modifies chapters, drafts, memory, or settings."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": JS_MAX_SAFE_INTEGER,
                    "description": "Optional 1-based target chapter number to prepare context for"
                },
                "draftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Optional draft ID to inspect alongside writing preparation context"
                },
                "task": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": CONTEXT_PREPARE_MAX_TASK_CHARS,
                    "description": "Optional writing goal or scene brief (max 4000 chars)"
                },
                "includePack": {
                    "type": "boolean",
                    "description": "Whether to build and include a production ContextPack"
                },
                "includeDraft": {
                    "type": "boolean",
                    "description": "Whether to include the referenced draft content window"
                },
                "includePlanningView": {
                    "type": "boolean",
                    "description": "Whether to include structured planning/outline/foreshadowing view (default true)"
                },
                "dimension": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": CONTEXT_PREPARE_MAX_DIMENSION_CHARS,
                    "description": "Optional six-dimension review key validated in the WebView against SIX_REVIEW_DIMENSION_ORDER"
                },
                "allowRetrievalNetwork": {
                    "type": "boolean",
                    "description": "Explicit opt-in for network embedding/rerank retrieval when building a pack (default false)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": JS_MAX_SAFE_INTEGER,
                    "description": "0-based character offset for paged output (default 0)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CONTEXT_PREPARE_LIMIT_MAX,
                    "description": "Character limit per page (1..=50000, default 16000)"
                }
            },
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let params = build_context_prepare_write_params(args)?;
            run_async_bridge_job(
                "context.prepare_write",
                "context-prepare-start",
                "context-prepare-poll",
                params,
                CONTEXT_INSPECT_POLL_INTERVAL,
                CONTEXT_INSPECT_MAX_WAIT,
                |query| ctx.bridge_query(query),
            )
            .await
        })
    }
}

/// `director.check` —— 只读检查开书导演管线的当前阶段门与阻塞原因（零 LLM 调用）。
pub struct DirectorCheckTool;

impl super::registry::McpTool for DirectorCheckTool {
    fn name(&self) -> &'static str {
        "director.check"
    }

    fn description(&self) -> &'static str {
        "Read-only diagnostic of the book-setup director pipeline gates (idea -> world -> character -> outline -> chapter). Zero LLM calls; never advances phases or writes files."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_director_check_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

// 构造 P0 只读注册表。
// ── P2：项目动作（全部转发既有管线/命令，不新造写路径）─────────────────────

/// 取必填字符串参数。缺失/类型不符一律 `INVALID_PARAMS`（协议层错误）。
fn require_str<'a>(args: &'a Value, tool: &str, field: &str) -> Result<&'a str, ToolError> {
    match args.get(field).and_then(|v| v.as_str()) {
        Some(v) if !v.trim().is_empty() => Ok(v),
        Some(_) => Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 不能为空"
        ))),
        None => Err(ToolError::invalid_params(format!(
            "{tool}: 缺少字符串参数 `{field}`"
        ))),
    }
}

/// 取可选正整数参数。给了就必须是正整数——静默忽略非法值会让调用方以为生效了。
fn optional_positive_int(args: &Value, tool: &str, field: &str) -> Result<Option<u64>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_u64() {
            Some(n) if n > 0 => Ok(Some(n)),
            _ => Err(ToolError::invalid_params(format!(
                "{tool}: `{field}` 必须是正整数，收到 {v}"
            ))),
        },
    }
}

/// `pipeline.run_chapter` —— 起一章深章生成，**立刻**返回 taskId。
///
/// 不等待结果：深章管线跑几分钟，同步等必然撞上状态桥 15s 超时，超时后前端还在跑
/// 而调用方以为失败——最糟的一种不一致。结果靠 `pipeline.status` 轮询。
pub struct PipelineRunChapterTool;

impl super::registry::McpTool for PipelineRunChapterTool {
    fn name(&self) -> &'static str {
        "pipeline.run_chapter"
    }

    fn description(&self) -> &'static str {
        "Start generating one chapter through the existing deep-chapter pipeline and return a taskId immediately. Poll pipeline.status for progress and gates. Generation takes minutes, so this never blocks. Output stays in the draft area; the user must accept it in the app."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "userRequest": { "type": "string", "description": "What this chapter should accomplish, in natural language" },
                "chapterNumber": { "type": "integer", "minimum": 1, "description": "Target chapter number (optional)" },
                "workflowMode": { "type": "string", "enum": ["fast", "standard", "strict"], "description": "Depth preset bound to the pipeline's real switches: fast turns off consensus writing/review and the post-gate literary polish (fewer stages, faster); standard follows app settings (default); strict turns both on (multi-model consensus still needs configured consensus model lists). No preset ever skips the consistency gate." }
            },
            "required": ["userRequest"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let user_request = require_str(args, "pipeline.run_chapter", "userRequest")?;
            let chapter_number =
                optional_positive_int(args, "pipeline.run_chapter", "chapterNumber")?;
            if let Some(mode) = args.get("workflowMode").and_then(|v| v.as_str()) {
                if !matches!(mode, "fast" | "standard" | "strict") {
                    return Err(ToolError::invalid_params(format!(
                        "pipeline.run_chapter: `workflowMode` 只接受 fast / standard / strict，收到 {mode}"
                    )));
                }
            }
            let mut params = json!({ "userRequest": user_request });
            if let Some(n) = chapter_number {
                params["chapterNumber"] = json!(n);
            }
            if let Some(mode) = args.get("workflowMode") {
                params["workflowMode"] = mode.clone();
            }

            let started = ctx
                .bridge_query(StateQuery::new("pipeline-start").with_params(params))
                .await?;
            Ok(json!({
                "taskId": started.get("taskId").cloned().unwrap_or(Value::Null),
                "stage": started.get("stage").cloned().unwrap_or(Value::Null),
                "note": "任务已起，用 pipeline.status 轮询。正文不会直接落到正式章节：管线产出草稿，需用户在应用内确认。",
            }))
        })
    }
}

/// `pipeline.status` 的投影：把前端快照整形成对外 JSON。
///
/// 抽成不依赖 `AppHandle` 的纯函数，才能用 `json!` 直接单测键名与缺省语义——
/// 埋在 `call` 里就没有真实桥接可测。10 个老键的名字与取值来源保持不变；
/// `kind` / `phase` / `advanced` / `advancedCount` / `artifactPath` 是 additive 补充，
/// 缺省 `null`（key 恒出，调用方不必判断存在性）。
fn project_pipeline_status(snapshot: &Value, fallback_task_id: &str) -> Value {
    json!({
        "taskId": snapshot.get("taskId").cloned().unwrap_or_else(|| json!(fallback_task_id)),
        "status": snapshot.get("status").cloned().unwrap_or(Value::Null),
        "stage": snapshot.get("stage").cloned().unwrap_or(Value::Null),
        "startedAt": snapshot.get("startedAt").cloned().unwrap_or(Value::Null),
        "finishedAt": snapshot.get("finishedAt").cloned().unwrap_or(Value::Null),
        "error": snapshot.get("error").cloned().unwrap_or(Value::Null),
        "overallVerdict": snapshot
            .get("gates")
            .and_then(|g| g.get("overall"))
            .cloned()
            .unwrap_or(Value::Null),
        "manualReviewRequired": snapshot
            .get("manualReviewRequired")
            .cloned()
            .unwrap_or(Value::Null),
        "partial": snapshot.get("partial").cloned().unwrap_or(Value::Null),
        "contentChars": snapshot.get("contentChars").cloned().unwrap_or(Value::Null),
        "kind": snapshot.get("kind").cloned().unwrap_or(Value::Null),
        "phase": snapshot.get("phase").cloned().unwrap_or(Value::Null),
        "advanced": snapshot.get("advanced").cloned().unwrap_or(Value::Null),
        "advancedCount": snapshot.get("advancedCount").cloned().unwrap_or(Value::Null),
        "artifactPath": snapshot.get("artifactPath").cloned().unwrap_or(Value::Null),
        "partialReason": snapshot.get("partialReason").cloned().unwrap_or(Value::Null),
        "adoptionGate": snapshot.get("adoptionGate").cloned().unwrap_or(Value::Null),
        "lastStage": snapshot.get("lastStage").cloned().unwrap_or(Value::Null),
        "durationMs": snapshot.get("durationMs").cloned().unwrap_or(Value::Null),
        "gateVerdicts": snapshot
            .get("gates")
            .map(|gates| {
                json!({
                    "consistency": gates["consistency"]["verdict"],
                    "anti_ai": gates["anti_ai"]["verdict"],
                    "quality": gates["quality"]["verdict"],
                })
            })
            .unwrap_or(Value::Null),
    })
}

/// `pipeline.status` —— 长任务快照。
pub struct PipelineStatusTool;

impl super::registry::McpTool for PipelineStatusTool {
    fn name(&self) -> &'static str {
        "pipeline.status"
    }

    fn description(&self) -> &'static str {
        "Poll a pipeline task started by any pipeline starter (run_chapter, run_chapter_batch, director.advance, outline.generate). Returns status, current stage, timings, the overall gate verdict, and any error. Never returns generated body text — artifactPath (when present) points at the task output file (e.g. the draft the pipeline wrote), not at a formal chapter."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "taskId": { "type": "string", "description": "Task id returned by pipeline.run_chapter" }
            },
            "required": ["taskId"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let task_id = require_str(args, "pipeline.status", "taskId")?;
            let snapshot = ctx
                .bridge_query(
                    StateQuery::new("pipeline-status").with_params(json!({ "taskId": task_id })),
                )
                .await?;
            Ok(project_pipeline_status(&snapshot, task_id))
        })
    }
}

/// `gate.run` —— 取某次生成的门控结论。
///
/// 门控**不是**独立跑的：结论由深章管线产出（`decisionGates`），这里只做读取与
/// 整形。另起一套门控判定等于第二套真源，两边给出不同结论时无从判断谁对。
pub struct GateRunTool;

impl super::registry::McpTool for GateRunTool {
    fn name(&self) -> &'static str {
        "gate.run"
    }

    fn description(&self) -> &'static str {
        "Read the gate verdict for a pipeline task: consistency, anti-AI, and quality gates plus the overall verdict and repair suggestions. Fails clearly while the task is still running. Gates come from the pipeline itself, not a second engine."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "taskId": { "type": "string", "description": "Task id returned by pipeline.run_chapter" }
            },
            "required": ["taskId"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let task_id = require_str(args, "gate.run", "taskId")?;
            let snapshot = ctx
                .bridge_query(
                    StateQuery::new("pipeline-status").with_params(json!({ "taskId": task_id })),
                )
                .await?;

            let status = snapshot
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if status == "failed" {
                let err = snapshot
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知原因");
                return Err(ToolError::internal(format!(
                    "任务 {task_id} 生成失败，没有门控结论：{err}"
                )));
            }
            let gates = snapshot.get("gates").filter(|g| !g.is_null());
            let Some(gates) = gates else {
                // 运行中/未完成：明确说清现在没有结论，而不是回一个空对象让调用方猜。
                let stage = snapshot
                    .get("stage")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知");
                return Err(ToolError::internal(format!(
                    "任务 {task_id} 尚未产出门控结论（status={status}, stage={stage}）。请用 pipeline.status 继续轮询。"
                )));
            };

            let summarize = |key: &str| {
                let gate = gates.get(key);
                json!({
                    "verdict": gate.and_then(|g| g.get("verdict")).cloned().unwrap_or(Value::Null),
                    "status": gate.and_then(|g| g.get("status")).cloned().unwrap_or(Value::Null),
                    "findingCount": gate
                        .and_then(|g| g.get("findings"))
                        .and_then(|f| f.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0),
                    "repairSuggestions": gate
                        .and_then(|g| g.get("repair_suggestions"))
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                })
            };

            Ok(json!({
                "taskId": task_id,
                "overall": gates.get("overall").cloned().unwrap_or(Value::Null),
                "consistency": summarize("consistency"),
                "anti_ai": summarize("anti_ai"),
                "quality": summarize("quality"),
                "manualReviewRequired": snapshot
                    .get("manualReviewRequired")
                    .cloned()
                    .unwrap_or(Value::Null),
                "partial": snapshot.get("partial").cloned().unwrap_or(Value::Null),
                "note": "门控优先级固定 Consistency(P0) > Anti-AI(P1) > Quality(P2)；Quality 不得覆盖 Consistency 的失败。",
            }))
        })
    }
}

/// `chapter.write` —— 写章节草稿（Draft-first，绝不直写正式章节）。
pub struct ChapterWriteTool;

impl super::registry::McpTool for ChapterWriteTool {
    fn name(&self) -> &'static str {
        "chapter.write"
    }

    fn description(&self) -> &'static str {
        "Write a chapter draft into the project draft area (.qm-drafts). Never writes a formal chapter: the user must accept the draft in the app first. Returns the draft id and path."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "chapterName": { "type": "string", "description": "Chapter name, e.g. 第171章-破局" },
                "content": { "type": "string", "description": "Full chapter draft text" }
            },
            "required": ["chapterName", "content"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let chapter_name = require_str(args, "chapter.write", "chapterName")?;
            let content = require_str(args, "chapter.write", "content")?;
            let result = ctx
                .bridge_query(StateQuery::new("draft-write").with_params(json!({
                    "chapterName": chapter_name,
                    "content": content,
                })))
                .await?;
            Ok(result)
        })
    }
}

/// `director.advance` —— 推进开书管线（idea → world → character → outline）。
///
/// ## 为什么也是异步任务
///
/// 每个阶段都是一次 LLM 生成，跑几十秒到几分钟。状态桥 15s 超时，同步等必然超时，
/// 超时后前端还在跑而调用方以为失败。所以这里只起任务并立刻返回 taskId，进度与结果
/// 一律用 `pipeline.status` 轮询（与 `pipeline.run_chapter` 同一张登记表）。
///
/// ## 为什么一阶段一次
///
/// 单一真源 `advanceDirectorAutomatically` 的语义就是「推进一步，由调用方循环」——
/// 阶段门（`advanceDirectorPhase`）要逐阶段判。这里用 `maxPhases` 表达循环次数，
/// 不给它另造一套「一口气跑完」的状态机。
pub struct DirectorAdvanceTool;

impl super::registry::McpTool for DirectorAdvanceTool {
    fn name(&self) -> &'static str {
        "director.advance"
    }

    fn description(&self) -> &'static str {
        "Advance the book-setup pipeline (idea -> world -> character -> outline) and return a taskId immediately. Poll pipeline.status for progress; the state machine keeps the last-good phase and never rolls backward. Outline and character artifacts land in wiki/ as planning documents; the first chapter (if the pipeline reaches it) lands in the draft area, never as a formal chapter."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "maxPhases": { "type": "integer", "minimum": 1, "maximum": 4, "description": "How many phases to advance in this task (default 1). Stops early on a blocked gate or failure." },
                "brief": { "type": "string", "description": "Extra authorial constraints (tone, length, taboos). Participates in the stage digest." },
                "targetVolumes": { "type": "integer", "minimum": 1, "maximum": 30, "description": "Desired volume count for the outline phase (optional)" }
            },
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let mut params = json!({});
            if let Some(n) = optional_positive_int(args, "director.advance", "maxPhases")? {
                if n > 4 {
                    return Err(ToolError::invalid_params(format!(
                        "director.advance: `maxPhases` 最多 4（管线只有 4 个阶段），收到 {n}"
                    )));
                }
                params["maxPhases"] = json!(n);
            }
            if let Some(brief) = args.get("brief").and_then(|v| v.as_str()) {
                params["brief"] = json!(brief);
            }
            if let Some(n) = optional_positive_int(args, "director.advance", "targetVolumes")? {
                if n > 30 {
                    return Err(ToolError::invalid_params(format!(
                        "director.advance: `targetVolumes` 最多 30，收到 {n}"
                    )));
                }
                params["targetVolumes"] = json!(n);
            }

            let started = ctx
                .bridge_query(StateQuery::new("director-advance").with_params(params))
                .await?;
            Ok(json!({
                "taskId": started.get("taskId").cloned().unwrap_or(Value::Null),
                "stage": started.get("stage").cloned().unwrap_or(Value::Null),
                "note": "任务已起，用 pipeline.status 轮询。阶段门未过时任务不推进，原因在 status 的 error 里。",
            }))
        })
    }
}

/// `outline.generate` —— 生成/重生成大纲。
///
/// 复用设置页大纲生成器的同一个函数（`generateOutlineFile`）：大纲是**规划产物**，
/// 落 `wiki/outlines/`，不是正文，因此不触发 Draft-first；正文边界不受影响。
pub struct OutlineGenerateTool;

impl super::registry::McpTool for OutlineGenerateTool {
    fn name(&self) -> &'static str {
        "outline.generate"
    }

    fn description(&self) -> &'static str {
        "Generate or regenerate the book outline from a natural-language brief and return a taskId immediately. Poll pipeline.status. The outline is a planning artifact written under wiki/outlines; no chapter text and no formal memory are touched."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "What the outline should cover: genre, scale, structure, hard constraints" },
                "multiAgent": { "type": "boolean", "description": "Use the multi-agent outline workflow instead of the single-pass generator (default false)" }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let prompt = require_str(args, "outline.generate", "prompt")?;
            let mut params = json!({ "prompt": prompt });
            if let Some(flag) = args.get("multiAgent") {
                let flag = flag.as_bool().ok_or_else(|| {
                    ToolError::invalid_params(
                        "outline.generate: `multiAgent` 必须是布尔值".to_string(),
                    )
                })?;
                params["multiAgent"] = json!(flag);
            }
            let started = ctx
                .bridge_query(StateQuery::new("outline-generate").with_params(params))
                .await?;
            Ok(json!({
                "taskId": started.get("taskId").cloned().unwrap_or(Value::Null),
                "stage": started.get("stage").cloned().unwrap_or(Value::Null),
                "note": "任务已起，用 pipeline.status 轮询；完成后 outline 路径在结果的 error/末态里。",
            }))
        })
    }
}

const OUTLINE_WRITE_MAX_FILENAME_CHARS: usize = 128;
const OUTLINE_WRITE_MAX_CONTENT_CHARS: usize = 200_000;

/// 严格校验 `outline.write` 的文件名：1..=128 字符、单段安全文件名、禁止点开头/路径穿越/ADS/控制字符/Windows 保留设备名、强制 `.md` 后缀（大小写不敏感）。
fn validate_outline_filename<'a>(raw: &'a str, tool: &str) -> Result<&'a str, ToolError> {
    let char_len = raw.chars().count();
    if char_len == 0 || char_len > OUTLINE_WRITE_MAX_FILENAME_CHARS {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 长度必须在 1..={OUTLINE_WRITE_MAX_FILENAME_CHARS} 字符之间，收到 {char_len}"
        )));
    }
    if raw.starts_with('.') {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 不允许以 `.` 开头：{raw}"
        )));
    }
    if raw.contains("..") {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 不允许包含 `..`：{raw}"
        )));
    }
    crate::agent_gate_policy::validate_safe_single_segment(raw, "filename")
        .map_err(|e| ToolError::invalid_params(format!("{tool}: {e}")))?;
    // 补充防御：`CON .md` / `NUL .md` 等在首段与 `.md` 间夹尾随空格的 Windows 保留设备名变体。
    let first_segment = raw
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    if crate::agent_gate_policy::is_windows_reserved_device_name(first_segment) {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 不允许使用 Windows 保留设备名：{raw}"
        )));
    }
    if !raw.to_ascii_lowercase().ends_with(".md") {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 必须使用 `.md` 后缀：{raw}"
        )));
    }
    let stem = &raw[..raw.len() - 3];
    if stem.trim().is_empty() || stem.ends_with('.') {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 主干不能为空且不能以 `.` 结尾：{raw}"
        )));
    }
    Ok(raw)
}

fn build_outline_write_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "outline.write";
    let object = validate_strict_object_args(args, tool, &["filename", "content", "syncModel"])?;

    let filename_raw = object
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `filename`")))?;
    let filename = validate_outline_filename(filename_raw, tool)?;

    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `content`")))?;
    if content.trim().is_empty() {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `content` 不能为空"
        )));
    }
    let content_chars = content.chars().count();
    if content_chars > OUTLINE_WRITE_MAX_CONTENT_CHARS {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `content` 长度不能超过 {OUTLINE_WRITE_MAX_CONTENT_CHARS} 字符，收到 {content_chars}"
        )));
    }

    let sync_model = optional_bool(args, tool, "syncModel")?.unwrap_or(true);
    Ok(StateQuery::new("outline-write").with_params(json!({
        "filename": filename,
        "content": content,
        "syncModel": sync_model,
    })))
}

/// `outline.write` —— 直接写入一个受控大纲文档（`wiki/outlines/<filename>.md`），零 LLM 调用。
///
/// 大纲属于规划产物而非正式章节正文，受 `Project` 权限域保护，不修改正式章节与正式记忆。
pub struct OutlineWriteTool;

impl super::registry::McpTool for OutlineWriteTool {
    fn name(&self) -> &'static str {
        "outline.write"
    }

    fn description(&self) -> &'static str {
        "Write a planning outline markdown file under wiki/outlines/<filename>. Requires Project scope. Zero LLM calls; validates safe single-segment .md filename and optionally syncs the structured outline model (default syncModel=true). Never writes formal chapters or formal memory."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": OUTLINE_WRITE_MAX_FILENAME_CHARS,
                    "description": "Safe single-segment .md filename under wiki/outlines/ (e.g. main-outline.md)"
                },
                "content": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": OUTLINE_WRITE_MAX_CONTENT_CHARS,
                    "description": "Non-empty markdown outline content (max 200000 chars)"
                },
                "syncModel": {
                    "type": "boolean",
                    "description": "Whether to sync the structured outline planning model after writing (default true)"
                }
            },
            "required": ["filename", "content"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_outline_write_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

/// `character.upsert` —— 建/改一个角色实体（`wiki/entities/characters/<name>.md`）。
///
/// 落盘格式复用导演管线同一个 `characterEntityDoc`（同一个真源），因此外部 Agent
/// 建的角色与导演阶段产出的角色长得一样，后续 `character` 阶段门看到的是同一批实体。
/// 只写实体文档，不碰正式章节、正式记忆与角色状态账本。
pub struct CharacterUpsertTool;

impl super::registry::McpTool for CharacterUpsertTool {
    fn name(&self) -> &'static str {
        "character.upsert"
    }

    fn description(&self) -> &'static str {
        "Create or overwrite one character entity under wiki/entities/characters. Same document format as the director pipeline produces, so later stages and gates see the same ledger. Does not write chapters, formal memory, or character state."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Character name; also the file name (path separators are sanitized)" },
                "role": { "type": "string", "enum": ["protagonist", "antagonist", "supporting"], "description": "Narrative role" },
                "desire": { "type": "string", "description": "What this character wants" },
                "flaw": { "type": "string", "description": "This character's fatal flaw" }
            },
            "required": ["name", "role", "desire", "flaw"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let name = require_str(args, "character.upsert", "name")?;
            let role = require_str(args, "character.upsert", "role")?;
            if !matches!(role, "protagonist" | "antagonist" | "supporting") {
                return Err(ToolError::invalid_params(format!(
                    "character.upsert: `role` 只接受 protagonist / antagonist / supporting，收到 {role}"
                )));
            }
            let desire = require_str(args, "character.upsert", "desire")?;
            let flaw = require_str(args, "character.upsert", "flaw")?;
            let written = ctx
                .bridge_query(StateQuery::new("character-upsert").with_params(json!({
                    "name": name,
                    "role": role,
                    "desire": desire,
                    "flaw": flaw,
                })))
                .await?;
            Ok(written)
        })
    }
}

/// `chapter.batch` —— 一次起多章深章生成。
///
/// 不另写批量逻辑：每个元素都走同一个 `startPipelineTask`（与单章工具同一入口），
/// 只是把「起任务」这一步循环起来。参数校验在**起任何任务之前**完成，所以一个坏
/// 元素不会留下半批已启动的任务。
pub struct ChapterBatchTool;

/// 一次批量请求的上限。定上限是为了让一个写错循环的调用方不能一口气起上百章。
const MAX_BATCH_CHAPTERS: usize = 10;

impl super::registry::McpTool for ChapterBatchTool {
    fn name(&self) -> &'static str {
        "chapter.batch"
    }

    fn description(&self) -> &'static str {
        "Start deep-chapter generation for up to 10 chapters at once and return one taskId per chapter. Same pipeline as pipeline.run_chapter, so every result stays in the draft area and still needs user acceptance. Poll each task with pipeline.status."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "requests": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_BATCH_CHAPTERS,
                    "description": "Chapters to start, in reading order",
                    "items": {
                        "type": "object",
                        "properties": {
                            "userRequest": { "type": "string", "description": "What this chapter should accomplish" },
                            "chapterNumber": { "type": "integer", "minimum": 1 },
                            "workflowMode": { "type": "string", "enum": ["fast", "standard", "strict"], "description": "Depth preset: fast = no consensus/polish extras; standard = app settings (default); strict = both on. The consistency gate always runs." }
                        },
                        "required": ["userRequest"],
                        "additionalProperties": false
                    }
                },
                "workflowMode": { "type": "string", "enum": ["fast", "standard", "strict"], "description": "Default for entries that omit their own. Depth preset: fast = no consensus/polish extras; standard = app settings (default); strict = both on. The consistency gate always runs." }
            },
            "required": ["requests"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let requests = args
                .get("requests")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    ToolError::invalid_params(
                        "chapter.batch: `requests` 必须是非空数组".to_string(),
                    )
                })?;
            if requests.is_empty() {
                return Err(ToolError::invalid_params(
                    "chapter.batch: `requests` 不能为空".to_string(),
                ));
            }
            if requests.len() > MAX_BATCH_CHAPTERS {
                return Err(ToolError::invalid_params(format!(
                    "chapter.batch: 一次最多 {MAX_BATCH_CHAPTERS} 章，收到 {}",
                    requests.len()
                )));
            }
            let default_mode = args.get("workflowMode").and_then(|v| v.as_str());
            if let Some(mode) = default_mode {
                if !matches!(mode, "fast" | "standard" | "strict") {
                    return Err(ToolError::invalid_params(format!(
                        "chapter.batch: `workflowMode` 只接受 fast / standard / strict，收到 {mode}"
                    )));
                }
            }
            // 先全量校验再起任务：半个批次启动、半个批次报错是最难收拾的状态。
            let mut normalized: Vec<Value> = Vec::with_capacity(requests.len());
            for (index, entry) in requests.iter().enumerate() {
                let user_request = entry
                    .get("userRequest")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ToolError::invalid_params(format!(
                            "chapter.batch: requests[{index}].userRequest 必须是非空字符串"
                        ))
                    })?;
                let mut item = json!({ "userRequest": user_request });
                if let Some(n) = optional_positive_int(entry, "chapter.batch", "chapterNumber")? {
                    item["chapterNumber"] = json!(n);
                }
                let mode = entry
                    .get("workflowMode")
                    .and_then(|v| v.as_str())
                    .or(default_mode);
                if let Some(mode) = mode {
                    if !matches!(mode, "fast" | "standard" | "strict") {
                        return Err(ToolError::invalid_params(format!(
                            "chapter.batch: requests[{index}].workflowMode 只接受 fast / standard / strict，收到 {mode}"
                        )));
                    }
                    item["workflowMode"] = json!(mode);
                }
                normalized.push(item);
            }

            let started = ctx
                .bridge_query(
                    StateQuery::new("pipeline-start-batch")
                        .with_params(json!({ "requests": normalized })),
                )
                .await?;
            Ok(json!({
                "tasks": started.get("tasks").cloned().unwrap_or_else(|| json!([])),
                "started": started.get("started").cloned().unwrap_or(Value::Null),
                "note": "每章一个 taskId，用 pipeline.status 逐个轮询；正文仍留在草稿区，需用户在应用内确认。",
            }))
        })
    }
}

fn is_symlink_or_reparse_point(meta: &std::fs::Metadata) -> bool {
    crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(meta)
}

fn component_matches_dir_name(comp: Option<Component<'_>>, expected: &str) -> bool {
    let expected = std::ffi::OsStr::new(expected);
    matches!(
        comp,
        Some(Component::Normal(name))
            if name == expected || (cfg!(windows) && name.eq_ignore_ascii_case(expected))
    )
}

/// 逐级检查 `base` 下目录链：所有已存在目录必须非符号链接/Windows 重解析点、必须为目录，
/// 且规范路径不得逃逸出父级；尚未创建的目录段按原名拼接。
fn verify_controlled_subdir_chain(
    base: &Path,
    components: &[&std::ffi::OsStr],
) -> Result<PathBuf, ToolError> {
    let mut current = base.to_path_buf();
    let mut anchored_parent = base.to_path_buf();
    let mut ancestor_missing = false;
    for part in components {
        current.push(part);
        if ancestor_missing {
            continue;
        }
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                if is_symlink_or_reparse_point(&meta) {
                    return Err(ToolError::permission(format!(
                        "export.run: 受控导出目录链路不允许符号链接或重解析点：{}",
                        current.display()
                    )));
                }
                if !meta.is_dir() {
                    return Err(ToolError::invalid_params(format!(
                        "export.run: 导出路径的父级不是目录：{}",
                        current.display()
                    )));
                }
                let canon = std::fs::canonicalize(&current).map_err(|e| {
                    ToolError::internal(format!(
                        "export.run: 无法解析导出目录 {}: {e}",
                        current.display()
                    ))
                })?;
                if !canon.starts_with(&anchored_parent) || canon == anchored_parent {
                    return Err(ToolError::permission(format!(
                        "export.run: 受控导出目录发生路径逃逸：{}",
                        current.display()
                    )));
                }
                anchored_parent = canon.clone();
                current = canon;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor_missing = true;
            }
            Err(e) => {
                return Err(ToolError::internal(format!(
                    "export.run: 无法检查导出目录 {}: {e}",
                    current.display()
                )));
            }
        }
    }
    Ok(current)
}

/// 将 `export.run` 的输出路径收口到活动项目 `<root>/backups/exports/` 受控沙箱内。
///
/// 安全不变量：
/// - 默认路径落在 `<root>/backups/exports/niko-buddy-backup-<secs>-<uuid8>.zip`（绝不写 `temp_dir`）；
/// - 拒绝控制字符、ADS `:`、`..`、半相对路径、符号链接/Windows 重解析点、项目外或非受控目录；
/// - 强制有效文件名、非空 stem、`.zip` 扩展名；
/// - 目标 `.zip` 与 `.zip.sha256` sidecar 均通过 `symlink_metadata` 禁止覆写已存在文件或符号链接。
fn resolve_controlled_export_path(
    project_path: &Path,
    raw_output: Option<&str>,
) -> Result<PathBuf, ToolError> {
    let root = super::writes::canonical_project(project_path).map_err(ToolError::internal)?;
    let exports_dir = verify_controlled_subdir_chain(
        &root,
        &[
            std::ffi::OsStr::new("backups"),
            std::ffi::OsStr::new("exports"),
        ],
    )?;

    let candidate = match raw_output.map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let uuid8: String = uuid::Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect();
            exports_dir.join(format!("niko-buddy-backup-{secs}-{uuid8}.zip"))
        }
        Some(raw) => {
            if raw.chars().any(|c| c.is_control()) {
                return Err(ToolError::invalid_params(
                    "export.run: `outputZipPath` 不允许包含控制字符",
                ));
            }
            if raw.ends_with('/') || raw.ends_with('\\') {
                return Err(ToolError::invalid_params(
                    "export.run: `outputZipPath` 必须指向具体 .zip 文件而非目录",
                ));
            }
            if raw.replace('\\', "/").split('/').any(|seg| seg == "..") {
                return Err(ToolError::invalid_params(
                    "export.run: `outputZipPath` 不允许包含 `..`",
                ));
            }
            let raw_path = Path::new(raw);
            if !raw_path.is_absolute()
                && (raw_path.has_root()
                    || raw.starts_with('\\')
                    || matches!(raw_path.components().next(), Some(Component::Prefix(_))))
            {
                return Err(ToolError::invalid_params(
                    "export.run: `outputZipPath` 不允许使用半相对路径",
                ));
            }
            for comp in raw_path.components() {
                match comp {
                    Component::ParentDir => {
                        return Err(ToolError::invalid_params(
                            "export.run: `outputZipPath` 不允许包含 `..`",
                        ));
                    }
                    Component::Normal(seg) => {
                        let seg_str = seg.to_string_lossy();
                        if seg_str.contains(':') {
                            return Err(ToolError::invalid_params(
                                "export.run: `outputZipPath` 不允许包含冒号或 NTFS 数据流（ADS）",
                            ));
                        }
                        if crate::agent_gate_policy::is_windows_reserved_device_name(&seg_str) {
                            return Err(ToolError::invalid_params(format!(
                                "export.run: `outputZipPath` 不允许使用 Windows 保留设备名：{seg_str}"
                            )));
                        }
                    }
                    _ => {}
                }
            }

            if !raw_path.is_absolute() {
                let rel_parts: Vec<&std::ffi::OsStr> = raw_path
                    .components()
                    .filter_map(|comp| match comp {
                        Component::Normal(seg) => Some(seg),
                        Component::CurDir => None,
                        _ => None,
                    })
                    .collect();
                let Some((&file_name, parent_parts)) = rel_parts.split_last() else {
                    return Err(ToolError::invalid_params(
                        "export.run: `outputZipPath` 缺少有效文件名",
                    ));
                };
                let parent_dir = verify_controlled_subdir_chain(&exports_dir, parent_parts)?;
                parent_dir.join(file_name)
            } else {
                let (Some(raw_parent), Some(raw_file_name)) =
                    (raw_path.parent(), raw_path.file_name())
                else {
                    return Err(ToolError::invalid_params(
                        "export.run: `outputZipPath` 缺少有效文件名或父目录",
                    ));
                };

                let mut existing = raw_parent;
                let mut missing_tail = Vec::new();
                loop {
                    match std::fs::symlink_metadata(existing) {
                        Ok(_) => break,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            let (Some(name), Some(parent)) =
                                (existing.file_name(), existing.parent())
                            else {
                                return Err(ToolError::permission(format!(
                                    "export.run: 输出路径不在活动项目的受控导出目录内：{raw}"
                                )));
                            };
                            missing_tail.push(name);
                            existing = parent;
                        }
                        Err(e) => {
                            return Err(ToolError::internal(format!(
                                "export.run: 无法检查输出路径 {}: {e}",
                                existing.display()
                            )));
                        }
                    }
                }

                let existing_canon = std::fs::canonicalize(existing).map_err(|e| {
                    ToolError::internal(format!(
                        "export.run: 无法解析输出路径祖先 {}: {e}",
                        existing.display()
                    ))
                })?;
                if !existing_canon.is_dir() {
                    return Err(ToolError::invalid_params(format!(
                        "export.run: 导出路径的父级不是目录：{}",
                        existing.display()
                    )));
                }
                if !existing_canon.starts_with(&root) {
                    return Err(ToolError::permission(format!(
                        "export.run: 绝对输出路径必须位于活动项目的 backups/exports 目录内：{raw}"
                    )));
                }

                // 从已存在祖先逐级回溯到活动项目根，拒绝项目内任何符号链接或重解析点。
                let mut walk = existing;
                loop {
                    let walk_canon = std::fs::canonicalize(walk).map_err(|e| {
                        ToolError::internal(format!(
                            "export.run: 无法解析输出路径 {}: {e}",
                            walk.display()
                        ))
                    })?;
                    let meta = std::fs::symlink_metadata(walk).map_err(|e| {
                        ToolError::internal(format!(
                            "export.run: 无法检查输出路径 {}: {e}",
                            walk.display()
                        ))
                    })?;
                    if walk_canon == root {
                        if is_symlink_or_reparse_point(&meta)
                            && walk
                                .parent()
                                .and_then(|p| std::fs::canonicalize(p).ok())
                                .is_some_and(|p_canon| p_canon.starts_with(&root))
                        {
                            return Err(ToolError::permission(format!(
                                "export.run: 导出路径包含符号链接或重解析点：{}",
                                walk.display()
                            )));
                        }
                        break;
                    }
                    if is_symlink_or_reparse_point(&meta) {
                        return Err(ToolError::permission(format!(
                            "export.run: 导出路径包含符号链接或重解析点：{}",
                            walk.display()
                        )));
                    }
                    let Some(parent) = walk.parent() else {
                        return Err(ToolError::permission(format!(
                            "export.run: 输出路径不在活动项目的受控导出目录内：{raw}"
                        )));
                    };
                    walk = parent;
                }

                let mut resolved_parent = existing_canon;
                for part in missing_tail.into_iter().rev() {
                    resolved_parent.push(part);
                }
                let rel_from_root = resolved_parent.strip_prefix(&root).map_err(|_| {
                    ToolError::permission(format!(
                        "export.run: 绝对输出路径必须位于活动项目的 backups/exports 目录内：{raw}"
                    ))
                })?;
                let mut rel_comps = rel_from_root.components();
                let in_backups = component_matches_dir_name(rel_comps.next(), "backups");
                let in_exports = component_matches_dir_name(rel_comps.next(), "exports");
                if !in_backups || !in_exports {
                    return Err(ToolError::permission(format!(
                        "export.run: 绝对输出路径必须位于活动项目的 backups/exports 目录内：{raw}"
                    )));
                }
                let sub_parts: Vec<&std::ffi::OsStr> = rel_comps
                    .filter_map(|comp| match comp {
                        Component::Normal(seg) => Some(seg),
                        _ => None,
                    })
                    .collect();
                let parent_dir = verify_controlled_subdir_chain(&exports_dir, &sub_parts)?;
                parent_dir.join(raw_file_name)
            }
        }
    };

    let file_name = candidate
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| ToolError::invalid_params("export.run: 输出路径缺少有效文件名"))?;
    if crate::agent_gate_policy::is_windows_reserved_device_name(file_name) {
        return Err(ToolError::invalid_params(format!(
            "export.run: 输出文件名不允许使用 Windows 保留设备名：{file_name}"
        )));
    }
    let ext = candidate.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("zip") {
        return Err(ToolError::invalid_params(
            "export.run: 输出文件必须使用 .zip 扩展名",
        ));
    }
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or("");
    if stem.trim().is_empty() {
        return Err(ToolError::invalid_params(
            "export.run: 输出文件名主干（stem）不能为空",
        ));
    }

    let sidecar = crate::canon::export::sidecar_path(&candidate);
    for (label, target) in [
        ("导出目标", candidate.as_path()),
        ("校验和文件", sidecar.as_path()),
    ] {
        match std::fs::symlink_metadata(target) {
            Ok(_) => {
                return Err(ToolError::invalid_params(format!(
                    "export.run: {label}已存在，禁止覆写：{}",
                    target.display()
                )));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(ToolError::internal(format!(
                    "export.run: 无法检查{label} {}: {e}",
                    target.display()
                )));
            }
        }
    }

    Ok(candidate)
}

/// `export.run` —— 导出项目备份包（zip + SHA-256 旁挂）。
///
/// 在 Rust 侧直接调既有 `canon_export_project` 命令：它自己会过 `agent_gate` 并在失败
/// 时给出原因。这里**不**另写打包逻辑——备份包的格式、校验和与加密只有一份实现。
pub struct ExportRunTool;

impl super::registry::McpTool for ExportRunTool {
    fn name(&self) -> &'static str {
        "export.run"
    }

    fn description(&self) -> &'static str {
        "Export the whole project as a zip backup with a SHA-256 sidecar and an optional passphrase, using the same exporter as the in-app backup view. Output is strictly sandboxed under <project>/backups/exports/ with a .zip extension and never overwrites an existing .zip or .sha256 file. Defaults to a unique timestamped .zip inside <project>/backups/exports/ when no path is given."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "outputZipPath": { "type": "string", "description": "Optional .zip path inside <project>/backups/exports/ (relative path under exports/ or absolute path inside <project>/backups/exports/; forbids '..', symlinks, and overwriting existing .zip/.sha256; defaults to <project>/backups/exports/niko-buddy-backup-<secs>-<uuid8>.zip)" },
                "passphrase": { "type": "string", "description": "Optional local passphrase for AES-256 encryption" }
            },
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Project
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let app = ctx.app()?.clone();
            let raw_output = match args.get("outputZipPath") {
                None | Some(Value::Null) => None,
                Some(Value::String(raw)) => Some(raw.as_str()),
                Some(other) => {
                    return Err(ToolError::invalid_params(format!(
                        "export.run: `outputZipPath` 必须是字符串，收到 {other}"
                    )))
                }
            };
            let passphrase = match args.get("passphrase") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => (!s.is_empty()).then(|| s.clone()),
                Some(other) => {
                    return Err(ToolError::invalid_params(format!(
                        "export.run: `passphrase` 必须是字符串，收到 {other}"
                    )))
                }
            };
            let project_path = ctx.project_path().await?;
            let raw_output_owned = raw_output.map(str::to_string);
            let project_path_for_resolve = project_path.clone();
            let controlled = tokio::task::spawn_blocking(move || {
                resolve_controlled_export_path(
                    Path::new(&project_path_for_resolve),
                    raw_output_owned.as_deref(),
                )
            })
            .await
            .map_err(|e| ToolError::internal(format!("export.run 路径校验任务异常: {e}")))??;
            let output = controlled
                .to_str()
                .ok_or_else(|| ToolError::internal("导出路径不是有效 UTF-8"))?
                .to_string();
            let request = crate::canon::export::CanonExportRequest {
                project_path,
                output_zip_path: output.clone(),
                passphrase,
            };
            let result = crate::canon::export::canon_export_project(app, request)
                .await
                .map_err(ToolError::internal)?;
            Ok(json!({
                "success": result.success,
                "zipPath": output,
                "fileCount": result.file_count,
                "totalSize": result.total_size,
                "checksumSha256": result.checksum_sha256,
                "sidecarPath": result.sidecar_path,
                "warnings": result.warnings,
                "error": result.error,
            }))
        })
    }
}

// `memory.write` —— 当前**明确拒绝**（应用没有记忆草稿审阅入口）。
//
// 保留注册是为了给调用方一个说清原因的答复，而不是让它对着 "unknown tool" 猜。
// 详见 `src/lib/mcp/draft-actions.ts` 文件头的推导。

// ───────────────────────── P3：直写 + 快照 + 回滚 ─────────────────────────

/// 一次外部直写的审计记录（append-only JSONL 的一行）。
///
/// 与 `settings.set` 那条共用同一个文件、同一套 hash 口径，靠 `kind` 区分：
/// `direct_write` / `undo`（提交）与 `direct_write_intent` / `undo_intent`（意图，
/// 先于目标写入落盘；意图 ≠ 已完成，读者不得自动视为完成或回放）。
/// 没有 `kind` 的是 P1 的设置写入（历史条目，不回溯改）。
#[derive(Debug, serde::Serialize)]
struct DirectWriteAudit<'a> {
    ts: String,
    source: &'a str,
    tool: &'a str,
    kind: &'a str,
    path: &'a str,
    before_hash: String,
    after_hash: String,
    /// 回滚所需的快照 id；`null` 表示该目标按矩阵不需要快照（草稿 / 缓存）。
    snapshot_ref: Option<String>,
}

/// 打开审计文件（fail-closed：拿不到审计落点就不许写）。
fn open_audit_log(project: &Path) -> Result<(std::fs::File, PathBuf), ToolError> {
    let audit_path = super::writes::external_audit_path(project).map_err(ToolError::internal)?;
    let audit_dir = audit_path
        .parent()
        .ok_or_else(|| ToolError::internal("审计路径没有父目录"))?;
    std::fs::create_dir_all(audit_dir).map_err(|e| {
        ToolError::internal(format!(
            "无法创建审计目录 {}: {e}；为安全起见本次写入未执行",
            audit_dir.display()
        ))
    })?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&audit_path)
        .map_err(|e| {
            ToolError::internal(format!(
                "审计文件不可写 {}: {e}；为安全起见本次写入未执行",
                audit_path.display()
            ))
        })?;
    Ok((file, audit_path))
}

fn sync_audit_line(file: &mut std::fs::File, record: &impl serde::Serialize) -> Result<(), String> {
    use std::io::Write;
    let mut line = serde_json::to_string(record).map_err(|e| format!("审计记录序列化失败: {e}"))?;
    line.push('\n');
    file.write_all(line.as_bytes())
        .and_then(|()| file.sync_data())
        .map_err(|e| format!("审计落盘失败: {e}"))
}

fn append_audit_line(
    file: &mut std::fs::File,
    record: &DirectWriteAudit<'_>,
) -> Result<(), String> {
    sync_audit_line(file, record)
}

/// 已存在文件的 hash；文件不存在返回 `None`（而不是空串——两者语义不同）。
fn file_hash(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(super::writes::sha256_hex(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法读取 {} 以计算 hash: {e}", path.display())),
    }
}

#[derive(Debug, serde::Deserialize)]
struct UndoAuditIdentity {
    #[serde(rename = "kind")]
    _kind: String,
    path: String,
    snapshot_ref: String,
    before_hash: String,
    after_hash: String,
}

#[derive(Debug)]
struct PendingDirectWrite {
    entry: Value,
    identity: Result<UndoAuditIdentity, serde_json::Error>,
}

fn normalize_audit_hash(raw: &str) -> Option<String> {
    if raw.eq_ignore_ascii_case("absent") {
        None
    } else {
        Some(raw.to_ascii_lowercase())
    }
}

fn audit_path_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(crate::commands::file_sync_watch::normalize_path_key(path))
    } else {
        path.to_path_buf()
    }
}

/// 把审计行里的 `direct_write` 条目读出来（回滚用），并对未配对悬挂的
/// `direct_write_intent` / `undo_intent` 结合磁盘 `file_hash` 执行崩溃恢复对账：
/// * 若悬挂 `undo_intent` 对应磁盘（或后续已提交写入的 `before_hash`）已到达其 `after_hash`，
///   则视为回滚已落盘并在撤销栈中摘除该快照；
/// * 若悬挂 `direct_write_intent` 对应磁盘（或后续已提交写入的 `before_hash`）已到达其 `after_hash`，
///   则将其按原写入顺序恢复进可回滚队列，避免崩溃后失去 `undo_last` 能力；
/// * 若磁盘仍停留在变更前或路径校验失败（fail-closed），绝不把未落地意图误认作已提交。
fn read_direct_writes(project: &Path) -> Result<Vec<PendingDirectWrite>, ToolError> {
    let audit_path = super::writes::external_audit_path(project).map_err(ToolError::internal)?;
    let text = match std::fs::read_to_string(&audit_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::internal(
                "还没有任何外部直写记录（审计文件不存在），没有可回滚的内容".to_string(),
            ))
        }
        Err(e) => {
            return Err(ToolError::internal(format!(
                "审计文件不可读 {}: {e}",
                audit_path.display()
            )))
        }
    };

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum AuditEventKind {
        DirectWrite,
        DirectWriteIntent,
        Undo,
        UndoIntent,
    }

    struct ParsedAuditEvent {
        kind: AuditEventKind,
        entry: Value,
        identity: Result<UndoAuditIdentity, serde_json::Error>,
    }

    let mut events = Vec::new();
    let mut committed_direct_refs = HashSet::new();
    let mut committed_undo_refs = HashSet::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            // 坏行跳过而不是整体失败：审计是 append-only 的历史，一行损坏不该让
            // 全部回滚能力失效。坏行也不会造成错误回滚（它没有可用的 snapshot_ref）。
            continue;
        };
        let kind = match value.get("kind").and_then(|v| v.as_str()) {
            Some("direct_write") => AuditEventKind::DirectWrite,
            Some("direct_write_intent") => AuditEventKind::DirectWriteIntent,
            Some("undo") => AuditEventKind::Undo,
            Some("undo_intent") => AuditEventKind::UndoIntent,
            _ => continue,
        };
        // Value 会折叠重复键；单独解析审计身份，拒绝重复或非字符串的必填字段。
        let identity: Result<UndoAuditIdentity, serde_json::Error> = serde_json::from_str(line);
        match kind {
            AuditEventKind::DirectWrite => {
                if let Ok(ref id) = identity {
                    committed_direct_refs.insert(id.snapshot_ref.clone());
                } else if let Some(reference) = value.get("snapshot_ref").and_then(|v| v.as_str()) {
                    committed_direct_refs.insert(reference.to_string());
                }
            }
            AuditEventKind::Undo => {
                if let Ok(ref id) = identity {
                    committed_undo_refs.insert(id.snapshot_ref.clone());
                } else if let Some(reference) = value.get("snapshot_ref").and_then(|v| v.as_str()) {
                    committed_undo_refs.insert(reference.to_string());
                }
            }
            AuditEventKind::DirectWriteIntent | AuditEventKind::UndoIntent => {}
        }
        events.push(ParsedAuditEvent {
            kind,
            entry: value,
            identity,
        });
    }

    let has_dangling_intent = events.iter().any(|ev| match ev.kind {
        AuditEventKind::DirectWriteIntent => ev
            .identity
            .as_ref()
            .is_ok_and(|id| !committed_direct_refs.contains(&id.snapshot_ref)),
        AuditEventKind::UndoIntent => ev
            .identity
            .as_ref()
            .is_ok_and(|id| !committed_undo_refs.contains(&id.snapshot_ref)),
        AuditEventKind::DirectWrite | AuditEventKind::Undo => false,
    });

    let mut undone = committed_undo_refs;
    let mut recovered_direct_indices = HashSet::new();

    if has_dangling_intent {
        if let Ok(canonical_proj) = super::writes::canonical_project(project) {
            let mut expected_state_by_path: HashMap<PathBuf, Option<String>> = HashMap::new();
            let mut recovered_direct_refs = HashSet::new();

            for (idx, ev) in events.iter().enumerate().rev() {
                let Ok(ref id) = ev.identity else {
                    continue;
                };
                match ev.kind {
                    AuditEventKind::DirectWrite | AuditEventKind::Undo => {
                        if let Ok(physical) = super::writes::resolve_external_truth_target(
                            &canonical_proj,
                            Path::new(&id.path),
                        ) {
                            expected_state_by_path.insert(
                                audit_path_key(&physical),
                                normalize_audit_hash(&id.before_hash),
                            );
                        }
                    }
                    AuditEventKind::UndoIntent => {
                        if undone.contains(&id.snapshot_ref) {
                            continue;
                        }
                        let Ok(physical) = super::writes::resolve_external_truth_target(
                            &canonical_proj,
                            Path::new(&id.path),
                        ) else {
                            continue;
                        };
                        let key = audit_path_key(&physical);
                        if !expected_state_by_path.contains_key(&key) {
                            let Ok(disk) = file_hash(&physical) else {
                                continue;
                            };
                            expected_state_by_path
                                .insert(key.clone(), disk.map(|h| h.to_ascii_lowercase()));
                        }
                        let want_after = normalize_audit_hash(&id.after_hash);
                        let want_before = normalize_audit_hash(&id.before_hash);
                        if want_before != want_after
                            && expected_state_by_path.get(&key) == Some(&want_after)
                        {
                            undone.insert(id.snapshot_ref.clone());
                            expected_state_by_path.insert(key, want_before);
                        }
                    }
                    AuditEventKind::DirectWriteIntent => {
                        if committed_direct_refs.contains(&id.snapshot_ref)
                            || recovered_direct_refs.contains(&id.snapshot_ref)
                        {
                            continue;
                        }
                        let Ok(physical) = super::writes::resolve_external_truth_target(
                            &canonical_proj,
                            Path::new(&id.path),
                        ) else {
                            continue;
                        };
                        let key = audit_path_key(&physical);
                        if !expected_state_by_path.contains_key(&key) {
                            let Ok(disk) = file_hash(&physical) else {
                                continue;
                            };
                            expected_state_by_path
                                .insert(key.clone(), disk.map(|h| h.to_ascii_lowercase()));
                        }
                        let want_after = normalize_audit_hash(&id.after_hash);
                        let want_before = normalize_audit_hash(&id.before_hash);
                        if want_before != want_after
                            && expected_state_by_path.get(&key) == Some(&want_after)
                        {
                            recovered_direct_indices.insert(idx);
                            recovered_direct_refs.insert(id.snapshot_ref.clone());
                            expected_state_by_path.insert(key, want_before);
                        }
                    }
                }
            }
        }
    }

    // 保持写入顺序，只留下已提交（或经磁盘哈希对账恢复）且还没被撤销的。
    Ok(events
        .into_iter()
        .enumerate()
        .filter_map(|(idx, ev)| {
            let keep = match ev.kind {
                AuditEventKind::DirectWrite => true,
                AuditEventKind::DirectWriteIntent => recovered_direct_indices.contains(&idx),
                AuditEventKind::Undo | AuditEventKind::UndoIntent => false,
            };
            if !keep {
                return None;
            }
            let not_undone = ev
                .identity
                .as_ref()
                .map(|identity| !undone.contains(&identity.snapshot_ref))
                .unwrap_or(true);
            if not_undone {
                Some(PendingDirectWrite {
                    entry: ev.entry,
                    identity: ev.identity,
                })
            } else {
                None
            }
        })
        .collect())
}

/// 外部直写的统一入口：**快照 → 写 → 审计**，任一环失败就明确报错。
///
/// ## 为什么审计文件必须在动目标之前打开
///
/// 顺序反过来（先写再开审计）一旦落盘失败，就会出现「正文已改、但没有任何痕迹」
/// 的状态——这正是 C-008 要防的那一种。先开文件把这种情况挡在写入之前。
///
/// 虚拟路径只映射一次，按活动项目验证后固定物理路径供快照、原子写入和回读使用。
fn direct_write(
    project_path: &str,
    tool: &'static str,
    virtual_path: &str,
    contents: &str,
) -> Result<Value, ToolError> {
    direct_write_with_audit(
        project_path,
        tool,
        virtual_path,
        contents,
        append_audit_line,
    )
}

fn direct_write_with_audit(
    project_path: &str,
    tool: &'static str,
    virtual_path: &str,
    contents: &str,
    append: impl Fn(&mut std::fs::File, &DirectWriteAudit<'_>) -> Result<(), String>,
) -> Result<Value, ToolError> {
    let _mutation = crate::commands::fs::lock_file_mutations().map_err(ToolError::internal)?;
    let project =
        super::writes::canonical_project(Path::new(project_path)).map_err(ToolError::internal)?;
    let mapped = crate::commands::fs::resolve_project_storage_path(virtual_path)
        .map_err(|e| ToolError::internal(format!("目标路径不合法（{virtual_path}）: {e}")))?;
    let physical = super::writes::resolve_external_truth_target(&project, Path::new(&mapped))
        .map_err(ToolError::permission)?;

    let (mut audit_file, audit_path) = open_audit_log(&project)?;
    let snapshot = super::writes::create_snapshot(&project, &physical)
        .map_err(|e| ToolError::internal(format!("{e}；为安全起见本次写入未执行")))?;
    let before = snapshot.existed.then_some(snapshot.hash);
    let parent = physical
        .parent()
        .ok_or_else(|| ToolError::internal("直写目标没有父目录"))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| ToolError::internal(format!("无法创建直写目标父目录: {e}")))?;
    if file_hash(&physical).map_err(ToolError::internal)? != before {
        return Err(ToolError::internal(
            "直写冲突：目标在建立快照后已变化，未执行写入",
        ));
    }

    let bytes = contents.as_bytes();
    let expected_after = super::writes::sha256_hex(bytes);
    let intent = DirectWriteAudit {
        ts: chrono::Utc::now().to_rfc3339(),
        source: "external_agent",
        tool,
        kind: "direct_write_intent",
        path: &snapshot.target,
        before_hash: before.clone().unwrap_or_else(|| "absent".to_string()),
        after_hash: expected_after.clone(),
        snapshot_ref: Some(snapshot.id.clone()),
    };
    append(&mut audit_file, &intent)
        .map_err(|e| ToolError::internal(format!("写入意图未能同步到审计，未执行目标写入: {e}")))?;
    crate::commands::fs::write_atomic_physical_bytes(&physical, bytes)
        .map_err(|e| ToolError::internal(format!("写入失败（目标未改动）: {e}")))?;
    let readback = file_hash(&physical);

    // rename 已发生：即使回读见到更晚的内容，审计也只记录本次实际提交的字节身份。
    let record = DirectWriteAudit {
        ts: chrono::Utc::now().to_rfc3339(),
        kind: "direct_write",
        ..intent
    };
    if let Err(e) = append(&mut audit_file, &record) {
        return Err(ToolError::internal(format!(
            "写入已生效，但审计落盘失败: {e}。写入意图和快照已保留，请检查 {} 的可写性。快照: {}",
            audit_path.display(),
            snapshot.id
        )));
    }
    let after =
        readback.map_err(|e| ToolError::internal(format!("写入已审计，但无法回读校验: {e}")))?;
    if after.as_deref() != Some(expected_after.as_str()) {
        return Err(ToolError::internal(format!(
            "写入已审计，但回读冲突：{} 已不是本次直写的内容，请手工核对",
            physical.display()
        )));
    }

    // 先留下回滚所需的审计身份，再尝试维护；清理失败不能丢掉已提交写入的记录。
    let pruned =
        super::writes::prune_snapshots(&project, super::writes::now_ms()).map_err(|e| {
            ToolError::internal(format!(
                "写入已完成并审计，但快照裁剪失败: {e}（仅影响旧快照清理）"
            ))
        })?;

    Ok(json!({
        "path": snapshot.target,
        "virtualPath": virtual_path,
        "chars": contents.chars().count(),
        "beforeHash": before,
        "afterHash": after,
        "snapshotRef": snapshot.id,
        "prunedSnapshots": pruned,
        "audit": { "path": audit_path.display().to_string() },
        "note": "已直接写入正式文件（未经草稿确认）。可用 undo_last 回滚。",
    }))
}

/// `chapter.write_direct` —— 直写正式章节正文（P3，需 full scope）。
///
/// 与 `chapter.write` 的区别：那个写草稿区（默认模式，需用户 accept），这个直接改
/// 正式正文。C-002 修订后这条路是允许的，代价是必须留审计与快照。
pub struct ChapterWriteDirectTool;

impl super::registry::McpTool for ChapterWriteDirectTool {
    fn name(&self) -> &'static str {
        "chapter.write_direct"
    }

    fn description(&self) -> &'static str {
        "Write a chapter's formal text directly (no draft, no user confirmation). Requires full scope, which must be granted per-session in Settings > External Control. Every write snapshots the previous content and appends to .novel/audit/external-writes.jsonl; undo_last can roll it back. Prefer chapter.write (draft) unless the user explicitly asked for direct writes."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "chapterName": { "type": "string", "description": "Chapter name; becomes <project>/wiki/chapters/<chapterName>.md" },
                "content": { "type": "string", "description": "Full chapter text (replaces the file, does not append)" }
            },
            "required": ["chapterName", "content"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Full
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let chapter_name = require_str(args, "chapter.write_direct", "chapterName")?;
            let content = require_str(args, "chapter.write_direct", "content")?.to_string();
            let resolved = ctx
                .bridge_query(StateQuery::new("formal-path").with_params(json!({
                    "kind": "chapter",
                    "name": chapter_name,
                })))
                .await?;
            let path = resolved
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::internal("状态桥没有返回正式章节路径"))?
                .to_string();
            let project_path = ctx.project_path().await?;
            tokio::task::spawn_blocking(move || {
                direct_write(&project_path, "chapter.write_direct", &path, &content)
            })
            .await
            .map_err(|e| ToolError::internal(format!("chapter.write_direct 后台任务异常: {e}")))?
        })
    }
}

/// `memory.write` —— 直写正式记忆（P3，需 full scope）。
///
/// P2 阶段这里是「明确拒绝」，因为当时没有记忆草稿的审阅入口，写进任何草稿目录都
/// 没人看得到。C-002 修订后有了另一条正路：带审计与快照的**直写**——它不再依赖
/// 草稿收件箱，代价是必须可回滚。于是这里从"拒绝"改成"需要 full scope 的直写"。
pub struct MemoryWriteTool;

impl super::registry::McpTool for MemoryWriteTool {
    fn name(&self) -> &'static str {
        "memory.write"
    }

    fn description(&self) -> &'static str {
        "Write one formal memory entry directly. Requires full scope, which must be granted per-session in Settings > External Control. Every write snapshots the previous content and appends to .novel/audit/external-writes.jsonl; undo_last can roll it back."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Memory entry name; becomes <project>/wiki/memory/<name>.md" },
                "content": { "type": "string", "description": "Memory entry body (replaces the file)" }
            },
            "required": ["name", "content"],
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Full
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let name = require_str(args, "memory.write", "name")?;
            let content = require_str(args, "memory.write", "content")?.to_string();
            let resolved = ctx
                .bridge_query(StateQuery::new("formal-path").with_params(json!({
                    "kind": "memory",
                    "name": name,
                })))
                .await?;
            let path = resolved
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::internal("状态桥没有返回正式记忆路径"))?
                .to_string();
            let project_path = ctx.project_path().await?;
            tokio::task::spawn_blocking(move || {
                direct_write(&project_path, "memory.write", &path, &content)
            })
            .await
            .map_err(|e| ToolError::internal(format!("memory.write 后台任务异常: {e}")))?
        })
    }
}

fn undo_direct_writes(project_path: &str, n: usize) -> Result<Value, ToolError> {
    let _mutation = crate::commands::fs::lock_file_mutations().map_err(ToolError::internal)?;
    let project =
        super::writes::canonical_project(Path::new(project_path)).map_err(ToolError::internal)?;
    let writes = read_direct_writes(&project)?;
    if writes.is_empty() {
        return Err(ToolError::internal(
            "没有可回滚的外部直写记录（审计里没有 kind=direct_write 的条目）",
        ));
    }
    let (mut audit_file, audit_path) = open_audit_log(&project)?;
    let mut restored = Vec::new();
    let mut failures = Vec::new();
    let mut failed_paths = HashSet::new();
    let path_key = |path: &Path| {
        if cfg!(windows) {
            PathBuf::from(crate::commands::file_sync_watch::normalize_path_key(path))
        } else {
            path.to_path_buf()
        }
    };

    // 从最新往回退：只要该实际路径的一步失败，就不能跳过它去退更老的写入。
    for pending in writes.iter().rev().take(n) {
        let target = pending
            .identity
            .as_ref()
            .ok()
            .map(|identity| identity.path.as_str())
            .or_else(|| pending.entry.get("path").and_then(Value::as_str))
            .unwrap_or_default();
        let raw_key = path_key(Path::new(target));
        let mut resolved_key = None;
        let outcome = (|| -> Result<Value, String> {
            if target.is_empty() {
                return Err("审计条目缺少目标路径，无法回滚".into());
            }
            let skipped = "同一目标较新的记录回滚失败，未尝试这条更早的记录";
            if failed_paths.contains(&raw_key) {
                return Err(skipped.into());
            }
            let physical =
                super::writes::resolve_external_truth_target(&project, Path::new(target))?;
            let key = path_key(&physical);
            if failed_paths.contains(&key) {
                return Err(skipped.into());
            }
            resolved_key = Some(key);
            let identity = pending
                .identity
                .as_ref()
                .map_err(|e| format!("审计条目缺少或含有歧义的必填字段，无法回滚: {e}"))?;
            let intent = DirectWriteAudit {
                ts: chrono::Utc::now().to_rfc3339(),
                source: "external_agent",
                tool: "undo_last",
                kind: "undo_intent",
                path: &identity.path,
                before_hash: identity.after_hash.to_ascii_lowercase(),
                after_hash: identity.before_hash.to_ascii_lowercase(),
                snapshot_ref: Some(identity.snapshot_ref.clone()),
            };
            append_audit_line(&mut audit_file, &intent)
                .map_err(|e| format!("回滚意图未能同步到审计，未执行还原: {e}"))?;
            let result = super::writes::restore_snapshot(
                &project,
                &identity.snapshot_ref,
                &physical,
                &identity.before_hash,
                &identity.after_hash,
            )?;
            let after_hash = if result.existed {
                result.hash
            } else {
                "absent".to_owned()
            };
            let record = DirectWriteAudit {
                ts: chrono::Utc::now().to_rfc3339(),
                kind: "undo",
                path: &result.target,
                after_hash,
                ..intent
            };
            append_audit_line(&mut audit_file, &record)
                .map_err(|e| format!("已还原但审计落盘失败: {e}；回滚意图和快照已保留"))?;
            Ok(json!({
                "path": target,
                "snapshotRef": identity.snapshot_ref,
                "restoredTo": if result.existed { "content" } else { "absent" },
                "hash": record.after_hash,
                "bytes": result.bytes,
                "undoneTs": pending.entry.get("ts").cloned().unwrap_or(Value::Null),
            }))
        })();
        match outcome {
            Ok(item) => restored.push(item),
            Err(reason) => {
                if !target.is_empty() {
                    failed_paths.insert(raw_key);
                    failed_paths.extend(resolved_key);
                }
                failures.push(json!({ "path": target, "reason": reason }));
            }
        }
    }

    if !failures.is_empty() {
        return Err(ToolError::internal(format!(
            "回滚未全部成功：{} 项已还原，{} 项失败。已还原项：{}。失败项：{}。审计：{}",
            restored.len(),
            failures.len(),
            json!(restored),
            json!(failures),
            audit_path.display()
        )));
    }

    Ok(json!({
        "requested": n,
        "rolledBack": restored.len(),
        "items": restored,
        "audit": { "path": audit_path.display().to_string() },
    }))
}

/// `undo_last` —— 回滚最近 n 次外部直写（P3，需 full scope）。
///
/// ## 语义：这是一个栈，不是「最后 N 条直写」
///
/// 已经回滚过的直写会从候选里摘掉（按审计里的 `kind=undo` 条目判定）。否则连调
/// 两次 `undo_last(1)` 会重复还原同一条——用户以为退了两步，实际只退了一步，
/// 而第二次调用还"成功"返回了。真机验收就是靠这一条发现该问题的。
///
/// ## 为什么回滚也要记审计
///
/// 回滚本身是一次写入，而且是最容易出问题的一次（它会把用户没看过的旧内容盖回
/// 正式文件）。不记下来，"为什么这章突然变回三天前"就无从回答。
///
/// ## 为什么失败必须整体报出来
///
/// 回滚中途失败时，前面几个文件已经还原、后面几个没有。这时候回一个「成功」是
/// 最坏的结果——用户以为都退回去了。所以逐条汇报，并明确列出失败项。
pub struct UndoLastTool;

impl super::registry::McpTool for UndoLastTool {
    fn name(&self) -> &'static str {
        "undo_last"
    }

    fn description(&self) -> &'static str {
        "Roll back the most recent N direct writes (newest first) using their snapshots. Requires full scope. Rollback only changes a file that still matches the audited write. Each verified rollback is recorded in the audit log. A failed step blocks older rollbacks of the same file and makes the call report a partial failure."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "n": { "type": "integer", "minimum": 1, "maximum": 20, "description": "How many of the most recent direct writes to roll back (default 1)" }
            },
            "additionalProperties": false
        })
    }

    fn required_scope(&self) -> super::session::SessionScope {
        super::session::SessionScope::Full
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let n = match args.get("n") {
                None | Some(Value::Null) => 1usize,
                Some(value) => {
                    let raw = value.as_u64().ok_or_else(|| {
                        ToolError::invalid_params("undo_last: `n` must be a positive integer")
                    })?;
                    if raw == 0 || raw > 20 {
                        return Err(ToolError::invalid_params(
                            "undo_last: `n` must be between 1 and 20",
                        ));
                    }
                    raw as usize
                }
            };

            let project_path = ctx.project_path().await?;
            tokio::task::spawn_blocking(move || undo_direct_writes(&project_path, n))
                .await
                .map_err(|e| ToolError::internal(format!("undo_last 后台任务异常: {e}")))?
        })
    }
}

pub fn build_registry() -> super::registry::ToolRegistry {
    let mut r = super::registry::ToolRegistry::new();
    r.register(Arc::new(super::registry::PingTool));
    r.register(Arc::new(AppStatusTool));
    r.register(Arc::new(SettingsSchemaTool));
    r.register(Arc::new(SettingsListTool));
    r.register(Arc::new(SettingsGetTool));
    r.register(Arc::new(SettingsSetTool));
    r.register(Arc::new(ProjectStateTool));
    r.register(Arc::new(ChapterListTool));
    r.register(Arc::new(ChapterReadTool));
    r.register(Arc::new(ContextInspectTool));
    r.register(Arc::new(CanonQueryTool));
    r.register(Arc::new(DraftListTool));
    r.register(Arc::new(DraftReadTool));
    r.register(Arc::new(RulesGetTool));
    r.register(Arc::new(GateCheckMechanicalTool));
    r.register(Arc::new(ContextPrepareWriteTool));
    r.register(Arc::new(DirectorCheckTool));
    r.register(Arc::new(PipelineRunChapterTool));
    r.register(Arc::new(PipelineStatusTool));
    r.register(Arc::new(GateRunTool));
    r.register(Arc::new(ChapterWriteTool));
    r.register(Arc::new(DirectorAdvanceTool));
    r.register(Arc::new(OutlineGenerateTool));
    r.register(Arc::new(OutlineWriteTool));
    r.register(Arc::new(CharacterUpsertTool));
    r.register(Arc::new(ChapterBatchTool));
    r.register(Arc::new(ExportRunTool));
    r.register(Arc::new(MemoryWriteTool));
    r.register(Arc::new(ChapterWriteDirectTool));
    r.register(Arc::new(UndoLastTool));
    // 编译期自检（两条，缺一不可）：
    // 1. 名字像写的工具**必须**声明高于只读的权限——名字像写但 scope 仍是 Read 是
    //    最危险的组合：客户端以为被拦住了，实际没有。
    // 2. 需要权限的工具集合必须与下面这行完全一致——新增一个能改东西的工具就必须
    //    主动改这里，不能靠"名字不像写"蒙过去。
    let write_like = super::contains_write_like_tool(&r);
    let privileged = r.privileged_tools();
    for name in &write_like {
        debug_assert!(
            privileged.contains(name),
            "{name} 名字像写工具却没声明写权限"
        );
    }
    debug_assert_eq!(
        privileged,
        vec![
            "settings.set",
            "pipeline.run_chapter",
            "pipeline.status",
            "gate.run",
            "chapter.write",
            "director.advance",
            "outline.generate",
            "outline.write",
            "character.upsert",
            "chapter.batch",
            "export.run",
            "memory.write",
            "chapter.write_direct",
            "undo_last",
        ],
        "需要权限的工具集合变了：确认新工具确实需要 Project/Settings，再改这行"
    );
    r
}

use std::sync::Arc;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_server::registry::McpTool;

    #[test]
    fn registry_contains_expected_tools() {
        let r = build_registry();
        assert_eq!(
            r.names(),
            vec![
                "app.ping",
                "app.status",
                "settings.schema",
                "settings.list",
                "settings.get",
                "settings.set",
                "project.state",
                "chapter.list",
                "chapter.read",
                "context.inspect",
                "canon.query",
                "draft.list",
                "draft.read",
                "rules.get",
                "gate.check_mechanical",
                "context.prepare_write",
                "director.check",
                "pipeline.run_chapter",
                "pipeline.status",
                "gate.run",
                "chapter.write",
                "director.advance",
                "outline.generate",
                "outline.write",
                "character.upsert",
                "chapter.batch",
                "export.run",
                "memory.write",
                "chapter.write_direct",
                "undo_last",
            ]
        );
    }

    #[test]
    fn orchestration_tools_appear_in_tools_list_payload() {
        // names() 是内部内省，客户端看到的是 list() 的 JSON。两者分离才防得住
        // 「结构体在、impl 在、名字在断言里，但 tools/list 永远看不到」。
        let r = build_registry();
        let payload = r.list();
        let names: Vec<&str> = payload["tools"]
            .as_array()
            .expect("tools 必须是数组")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        for name in [
            "director.advance",
            "outline.generate",
            "character.upsert",
            "chapter.batch",
            "export.run",
        ] {
            assert!(
                names.contains(&name),
                "tools/list 的 JSON 结果里没有 {name}；说明 build_registry() 漏注册",
            );
        }
        assert_eq!(names.len(), r.len(), "list() 与 registry 长度不一致");
    }

    #[test]
    fn no_registered_tool_requires_auto_scope() {
        // satisfies(Auto) 自反是偏序语义：被要求时自己当然满足自己。
        // 真正要守的是「没有任何工具把 Auto 当 required」——只有这条能让组合档
        // 变成「被要求方」，从而出现语义歧义。
        let r = build_registry();
        let offenders: Vec<&'static str> = r
            .names()
            .into_iter()
            .filter(|n| r.required_scope(n) == Some(crate::mcp_server::session::SessionScope::Auto))
            .collect();
        assert!(
            offenders.is_empty(),
            "这些工具要求了 auto 档；auto 只能作被满足方：{offenders:?}"
        );
    }

    #[test]
    fn every_tool_declares_object_schema() {
        // 客户端按 schema 生成参数；非 object 会让 MCP 客户端拒绝调用。
        let r = build_registry();
        let list = r.list();
        for tool in list["tools"].as_array().expect("array") {
            assert_eq!(
                tool["inputSchema"]["type"], "object",
                "tool {} schema must be object",
                tool["name"]
            );
            assert!(
                tool["description"]
                    .as_str()
                    .map(|d| !d.trim().is_empty())
                    .unwrap_or(false),
                "tool {} must have a description",
                tool["name"]
            );
        }
    }

    // ── app.status / chapter.write 元数据 ───────────────────────────

    #[tokio::test]
    async fn app_status_defaults_to_read_only() {
        // 默认上下文（无调用方）就是最小权限：readOnly=true、scope=read，且
        // version / mode / listen 三个既有字段的名称与结构都不变。
        let ctx = ToolContext::for_test();
        let out = AppStatusTool
            .call(&ctx, &json!({}))
            .await
            .expect("app.status 不依赖 AppHandle，必须成功");
        assert_eq!(out["readOnly"], json!(true), "{out}");
        assert_eq!(out["scope"], json!("read"), "{out}");
        assert_eq!(out["version"], json!(SERVER_VERSION), "{out}");
        assert_eq!(out["listen"], json!("127.0.0.1:0"), "{out}");
        assert!(out["mode"].is_string(), "mode 必须保留: {out}");
    }

    #[tokio::test]
    async fn app_status_read_only_tracks_the_request_scope() {
        use crate::mcp_server::session::SessionScope;
        let shared = ToolContext::for_test();
        for (caller, read_only) in [
            (SessionScope::Read, true),
            (SessionScope::Settings, false),
            (SessionScope::Project, false),
            (SessionScope::Auto, false),
            (SessionScope::Full, false),
        ] {
            let out = AppStatusTool
                .call(&shared.for_caller(caller), &json!({}))
                .await
                .expect("ok");
            assert_eq!(out["readOnly"], json!(read_only), "{caller:?}: {out}");
            assert_eq!(
                out["scope"],
                json!(caller.as_str()),
                "{caller:?} 的 scope 字符串不对: {out}"
            );
        }
        // 请求局部副本不得污染共享上下文：派生之后共享句柄仍是 Read，
        // 随后一次「没有调用方」的调用仍必须回到只读。
        assert_eq!(shared.caller_scope, SessionScope::Read);
        let after = AppStatusTool.call(&shared, &json!({})).await.expect("ok");
        assert_eq!(after["readOnly"], json!(true), "共享上下文被污染: {after}");
        assert_eq!(after["scope"], json!("read"), "{after}");
    }

    #[test]
    fn chapter_write_metadata_points_at_qm_drafts() {
        // 描述是客户端看到的唯一目录线索：写的是 .qm-drafts 就不能说 .novel/drafts。
        let r = build_registry();
        let payload = r.list();
        let tool = payload["tools"]
            .as_array()
            .expect("tools 必须是数组")
            .iter()
            .find(|t| t["name"].as_str() == Some("chapter.write"))
            .expect("chapter.write 必须在 tools/list 里");
        let desc = tool["description"].as_str().expect("description");
        assert!(
            desc.contains(".qm-drafts"),
            "草稿目录是 .qm-drafts，描述却没写出来: {desc}"
        );
        assert!(
            !desc.contains(".novel/drafts"),
            "描述里不得再出现 .novel/drafts: {desc}"
        );
        // 只改文档字符串：权限仍是 Project（本次不动任何权限语义）。
        assert_eq!(
            r.required_scope("chapter.write"),
            Some(crate::mcp_server::session::SessionScope::Project)
        );
    }

    #[test]
    fn settings_get_requires_key_argument() {
        // 参数校验不依赖 AppHandle，因此可以在无 tauri 环境里直接断言错误码。
        let tool = SettingsGetTool;
        assert_eq!(tool.input_schema()["required"], json!(["key"]));
    }

    // ── 一窗口全流程编排工具 ───────────────────────────────────────

    #[test]
    fn orchestration_tools_require_project_scope() {
        let r = build_registry();
        for name in [
            "director.advance",
            "outline.generate",
            "character.upsert",
            "chapter.batch",
            "export.run",
        ] {
            assert_eq!(
                r.required_scope(name),
                Some(crate::mcp_server::session::SessionScope::Project),
                "{name} 必须要求 Project 档（auto 档也应能满足它）"
            );
            assert!(
                crate::mcp_server::session::SessionScope::Auto
                    .satisfies(r.required_scope(name).expect("scope")),
                "{name} 必须在 auto 档下可调"
            );
            assert!(
                !crate::mcp_server::session::SessionScope::Read
                    .satisfies(r.required_scope(name).expect("scope")),
                "{name} 不得在只读档下可调"
            );
        }
    }

    #[tokio::test]
    async fn character_upsert_rejects_unknown_role_before_bridge() {
        // 校验在状态桥之前完成：坏参数不应该先去碰项目文件。
        let ctx = ToolContext::for_test();
        let err = CharacterUpsertTool
            .call(
                &ctx,
                &json!({ "name": "甲", "role": "villain", "desire": "x", "flaw": "y" }),
            )
            .await
            .expect_err("role 不是三档之一必须报参数错");
        assert_eq!(err.code, crate::mcp_server::protocol::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn chapter_batch_validates_before_starting_anything() {
        let ctx = ToolContext::for_test();
        let empty = ChapterBatchTool
            .call(&ctx, &json!({ "requests": [] }))
            .await
            .expect_err("空批次必须报错");
        assert_eq!(empty.code, crate::mcp_server::protocol::INVALID_PARAMS);

        let too_many: Vec<Value> = (0..(MAX_BATCH_CHAPTERS + 1))
            .map(|i| json!({ "userRequest": format!("第 {i} 章") }))
            .collect();
        let oversized = ChapterBatchTool
            .call(&ctx, &json!({ "requests": too_many }))
            .await
            .expect_err("超上限必须报错");
        assert_eq!(oversized.code, crate::mcp_server::protocol::INVALID_PARAMS);

        // 单个元素坏掉时整批不启动（不会先起前三章再报错）。
        let bad_member = ChapterBatchTool
            .call(
                &ctx,
                &json!({ "requests": [
                    { "userRequest": "好的" },
                    { "userRequest": "   " },
                ] }),
            )
            .await
            .expect_err("空 userRequest 必须报错");
        assert_eq!(bad_member.code, crate::mcp_server::protocol::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn director_advance_caps_phase_count() {
        let ctx = ToolContext::for_test();
        let err = DirectorAdvanceTool
            .call(&ctx, &json!({ "maxPhases": 9 }))
            .await
            .expect_err("超过四阶段必须报错");
        assert_eq!(err.code, crate::mcp_server::protocol::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn outline_generate_requires_prompt() {
        let ctx = ToolContext::for_test();
        let err = OutlineGenerateTool
            .call(&ctx, &json!({}))
            .await
            .expect_err("缺 prompt 必须报错");
        assert_eq!(err.code, crate::mcp_server::protocol::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn export_run_reports_missing_app_handle() {
        // 无 AppHandle 时必须报内部错误（真实失败模式），不得伪造成功。
        let ctx = ToolContext::for_test();
        let err = ExportRunTool
            .call(&ctx, &json!({}))
            .await
            .expect_err("无 app 句柄不得成功");
        assert_eq!(err.code, crate::mcp_server::protocol::INTERNAL_ERROR);
    }

    #[test]
    fn chapter_read_requires_chapter_argument() {
        let tool = ChapterReadTool;
        assert_eq!(tool.input_schema()["required"], json!(["chapter"]));
    }

    // ── context.inspect（只读上下文回读） ──────────────────────────────

    #[test]
    fn context_inspect_is_registered_with_read_scope() {
        let r = build_registry();
        assert_eq!(
            r.required_scope("context.inspect"),
            Some(crate::mcp_server::session::SessionScope::Read),
            "context.inspect 必须只需只读档"
        );
        // 原有 privileged 名单不变：只读回读不得进入授权面。
        assert!(
            !r.privileged_tools().contains(&"context.inspect"),
            "只读回读不得进 privileged 集合"
        );
        let payload = r.list();
        let tool = payload["tools"]
            .as_array()
            .expect("tools 必须是数组")
            .iter()
            .find(|t| t["name"].as_str() == Some("context.inspect"))
            .expect("context.inspect 必须在 tools/list 里");
        assert_eq!(tool["inputSchema"]["type"], json!("object"));
        assert_eq!(tool["inputSchema"]["required"], json!(["chapter"]));
    }

    #[test]
    fn context_inspect_dimension_stays_a_string_so_no_production_key_is_dropped() {
        // 六维真源在前端 `SIX_REVIEW_DIMENSION_ORDER`。Rust 若再抄一份 enum，
        // 生产新增/改名维度时这里就会静默丢掉一维。所以 schema 只声明 string，
        // 合法性由前端真源拒绝——本用例钉住这个决定与六个键的可达性。
        let schema = ContextInspectTool.input_schema();
        let dim = &schema["properties"]["dimension"];
        assert_eq!(dim["type"], json!("string"));
        assert!(
            dim.get("enum").is_none(),
            "dimension 不得在 Rust 侧列 enum（会与生产真源漂移）: {dim}"
        );
        for key in [
            "thrill",
            "consistency",
            "pacing",
            "character",
            "continuity",
            "pull",
        ] {
            assert_eq!(
                json!({ "dimension": key })["dimension"].as_str(),
                Some(key),
                "合法六维键 {key} 必须能作为 string 传入"
            );
        }
    }

    #[test]
    fn context_inspect_schema_declares_inspection_id_and_strict_keys() {
        let schema = ContextInspectTool.input_schema();
        assert_eq!(
            schema["properties"]["inspectionId"]["type"],
            json!("string")
        );
        assert_eq!(schema["properties"]["inspectionId"]["minLength"], json!(1));
        assert_eq!(schema["additionalProperties"], json!(false));
        assert!(schema["properties"]["promptOffset"]["description"]
            .as_str()
            .expect("offset 描述必须是字符串")
            .contains("UTF-16"));
    }

    #[tokio::test]
    async fn context_inspect_rejects_unknown_keys_and_explicit_nulls_before_bridge() {
        let ctx = ToolContext::for_test();
        let mut cases = vec![
            json!({ "chapter": "1", "includePacks": true }),
            json!({ "chapter": "1", "dimenion": "thrill" }),
            json!({ "chapter": "1", "extra": 1 }),
            json!({ "chapter": "1", "inspectionId": 42 }),
            json!({ "chapter": "1", "inspectionId": " " }),
            json!([]),
            Value::Null,
        ];
        for field in [
            "chapter",
            "task",
            "inspectionId",
            "dimension",
            "includePack",
            "includeChapter",
            "allowRetrievalNetwork",
            "promptOffset",
            "promptLimit",
        ] {
            let mut args = json!({ "chapter": "1" });
            args[field] = Value::Null;
            cases.push(args);
        }
        for args in cases {
            let err = ContextInspectTool
                .call(&ctx, &args)
                .await
                .expect_err("未知键和显式 null 必须在 bridge 前拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "args={args}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn context_inspect_accepts_nonempty_inspection_id_before_bridge() {
        let ctx = ToolContext::for_test();
        let err = ContextInspectTool.call(&ctx, &json!({
            "chapter": "1", "inspectionId": "test-batch-id", "dimension": "thrill",
            "task": "冻结任务", "allowRetrievalNetwork": false, "promptOffset": 0, "promptLimit": 500
        })).await.expect_err("无 AppHandle 不得假成功");
        assert_eq!(err.code, crate::mcp_server::protocol::INTERNAL_ERROR);
    }

    #[tokio::test]
    async fn context_inspect_rejects_wrong_types_before_the_bridge() {
        // 参数校验不依赖 AppHandle，因此可在无 tauri 环境里直接断言错误码。
        // 关键点："true" 这类字符串不得被当成布尔、负 offset / 0 limit 不得静默钳制。
        let ctx = ToolContext::for_test();
        let cases: [Value; 9] = [
            json!({}),
            json!({ "chapter": "   " }),
            json!({ "chapter": 3 }),
            json!({ "chapter": "1", "includePack": "true" }),
            json!({ "chapter": "1", "includeChapter": 1 }),
            json!({ "chapter": "1", "allowRetrievalNetwork": "yes" }),
            json!({ "chapter": "1", "promptOffset": -1 }),
            json!({ "chapter": "1", "promptLimit": 0 }),
            json!({ "chapter": "1", "promptLimit": 50_001 }),
        ];
        for args in cases {
            let err = ContextInspectTool
                .call(&ctx, &args)
                .await
                .expect_err("非法参数必须在状态桥之前被拒");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "args={args} 应报 INVALID_PARAMS，实际: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn context_inspect_reports_missing_app_handle_as_internal() {
        // 参数合法时唯一失败点是「没有 AppHandle」——不得伪造成成功。
        let ctx = ToolContext::for_test();
        let err = ContextInspectTool
            .call(&ctx, &json!({ "chapter": "1", "dimension": "thrill" }))
            .await
            .expect_err("无 app 句柄不得成功");
        assert_eq!(err.code, crate::mcp_server::protocol::INTERNAL_ERROR);
    }

    #[tokio::test]
    async fn context_inspect_async_polls_until_done_and_surfaces_failures() {
        let polls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let polls_ref = polls.clone();
        let ok = run_context_inspect_async(
            json!({ "chapter": "1", "includePack": true }),
            std::time::Duration::from_millis(1),
            std::time::Duration::from_secs(2),
            move |q| {
                let p = polls_ref.clone();
                async move {
                    match q.op.as_str() {
                        "context-inspect-start" => {
                            Ok(json!({ "status": "running", "jobId": "job-1" }))
                        }
                        "context-inspect-poll" => {
                            let n = p.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            if n == 0 {
                                Ok(json!({ "status": "running", "jobId": "job-1" }))
                            } else {
                                Ok(json!({ "status": "done", "jobId": "job-1", "value": { "contextPackBuilt": true } }))
                            }
                        }
                        other => Err(ToolError::internal(format!("unexpected op {other}"))),
                    }
                }
            },
        )
        .await
        .expect("async poll should resolve");
        assert_eq!(ok["contextPackBuilt"], json!(true));
        assert_eq!(polls.load(std::sync::atomic::Ordering::SeqCst), 2);

        let err = run_context_inspect_async(
            json!({ "chapter": "1", "includePack": true }),
            std::time::Duration::from_millis(1),
            std::time::Duration::from_secs(2),
            |q| async move {
                match q.op.as_str() {
                    "context-inspect-start" => {
                        Ok(json!({ "status": "running", "jobId": "job-2" }))
                    }
                    "context-inspect-poll" => {
                        Ok(json!({ "status": "failed", "jobId": "job-2", "error": "retrieval refused" }))
                    }
                    other => Err(ToolError::internal(format!("unexpected op {other}"))),
                }
            },
        )
        .await
        .expect_err("failed job must error");
        assert_eq!(err.code, crate::mcp_server::protocol::INTERNAL_ERROR);
        assert!(err.message.contains("retrieval refused"));
    }

    #[test]
    fn only_settings_set_is_write_like_and_it_declares_write_scope() {
        // 名字像写 + 声明写权限 = 一致；名字像写但 scope 仍是 Read 才是最危险的组合。
        let r = build_registry();
        let write_like = crate::mcp_server::contains_write_like_tool(&r);
        let privileged = r.privileged_tools();
        // 名字像写的必须都被授权（不能出现"名字像写但 scope=Read"）
        for name in &write_like {
            assert!(privileged.contains(name), "{name} 名字像写却没声明权限");
        }
        assert_eq!(
            privileged,
            vec![
                "settings.set",
                "pipeline.run_chapter",
                "pipeline.status",
                "gate.run",
                "chapter.write",
                "director.advance",
                "outline.generate",
                "outline.write",
                "character.upsert",
                "chapter.batch",
                "export.run",
                "memory.write",
                "chapter.write_direct",
                "undo_last",
            ]
        );
        assert_eq!(
            r.required_scope("settings.set"),
            Some(crate::mcp_server::session::SessionScope::Settings)
        );
        assert_eq!(
            r.required_scope("settings.get"),
            Some(crate::mcp_server::session::SessionScope::Read)
        );
        assert_eq!(r.required_scope("no.such.tool"), None);
    }

    // ── P3：直写审计与回滚的纯 fs 部分 ──────────────────────────────────

    struct TempProject(std::path::PathBuf);

    impl TempProject {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nb-direct-{tag}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("temp project");
            Self(dir)
        }
        fn path_str(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn append_test_write(project: &TempProject, target: &str, snapshot: Option<&str>) {
        let (mut file, _path) = open_audit_log(&project.0).expect("audit");
        let record = DirectWriteAudit {
            ts: chrono::Utc::now().to_rfc3339(),
            source: "external_agent",
            tool: "chapter.write_direct",
            kind: "direct_write",
            path: target,
            before_hash: "before".to_string(),
            after_hash: "after".to_string(),
            snapshot_ref: snapshot.map(|s| s.to_string()),
        };
        append_audit_line(&mut file, &record).expect("append");
    }

    #[test]
    fn settings_audit_reports_a_write_failure() {
        let project = TempProject::new("settings-audit-failure");
        let (file, path) = open_audit_log(&project.0).expect("audit open");
        drop(file);
        let mut read_only = std::fs::File::open(&path).expect("audit readable");
        let record = ExternalWriteAudit {
            ts: "2026-01-01T00:00:00Z".into(),
            source: "external_agent",
            tool: "settings.set",
            key: "theme",
            before_hash: value_hash(&json!("before")),
            after_hash: value_hash(&json!("after")),
        };
        assert!(sync_audit_line(&mut read_only, &record).is_err());
        assert_eq!(std::fs::metadata(path).unwrap().len(), 0);
    }

    #[test]
    fn audit_log_creates_dir_and_appends_one_line_per_write() {
        let project = TempProject::new("audit");
        append_test_write(&project, "/p/canon/a.md", Some("snap_1"));
        append_test_write(&project, "/p/canon/b.md", None);
        let audit = project
            .0
            .join(".novel")
            .join("audit")
            .join("external-writes.jsonl");
        let text = std::fs::read_to_string(&audit).expect("audit readable");
        assert_eq!(text.lines().count(), 2, "每次写入一行，append-only");
        assert!(text.contains("\"snapshot_ref\":\"snap_1\""));
        assert!(
            text.contains("\"snapshot_ref\":null"),
            "无快照要显式写 null"
        );
    }

    #[test]
    fn read_direct_writes_ignores_settings_entries_and_keeps_order() {
        let project = TempProject::new("readaudit");
        // 混入一条 P1 的设置写入（没有 kind 字段）与一条坏行。
        let audit_dir = project.0.join(".novel").join("audit");
        std::fs::create_dir_all(&audit_dir).unwrap();
        let audit = audit_dir.join("external-writes.jsonl");
        std::fs::write(
            &audit,
            "{\"ts\":\"t0\",\"source\":\"external_agent\",\"tool\":\"settings.set\",\"key\":\"theme\",\"before_hash\":\"a\",\"after_hash\":\"b\"}
{ not json
",
        )
        .unwrap();
        append_test_write(&project, "/p/canon/a.md", Some("snap_a"));
        append_test_write(&project, "/p/canon/b.md", Some("snap_b"));

        let writes = read_direct_writes(&project.0).expect("read");
        assert_eq!(writes.len(), 2, "设置条目与坏行都不算直写");
        assert_eq!(writes[0].entry["path"], "/p/canon/a.md");
        assert_eq!(
            writes[1].entry["path"], "/p/canon/b.md",
            "顺序必须保持写入顺序"
        );
    }

    #[test]
    fn read_direct_writes_skips_already_undone_entries() {
        // 回滚是栈：已撤销的直写不能再被 undo_last 选中，否则连调两次会重复还原
        // 同一条（用户以为退了两步，实际只退了一步）。
        let project = TempProject::new("undostack");
        append_test_write(&project, "/p/canon/a.md", Some("snap_a"));
        append_test_write(&project, "/p/canon/b.md", Some("snap_b"));

        // 模拟 b 被回滚过：追加一条 kind=undo 的审计。
        let (mut file, _path) = open_audit_log(&project.0).expect("audit");
        let record = DirectWriteAudit {
            ts: chrono::Utc::now().to_rfc3339(),
            source: "external_agent",
            tool: "undo_last",
            kind: "undo",
            path: "/p/canon/b.md",
            before_hash: "x".to_string(),
            after_hash: "y".to_string(),
            snapshot_ref: Some("snap_b".to_string()),
        };
        append_audit_line(&mut file, &record).expect("append undo");

        let writes = read_direct_writes(&project.0).expect("read");
        assert_eq!(writes.len(), 1, "已撤销的那条必须从栈里摘掉");
        assert_eq!(writes[0].entry["path"], "/p/canon/a.md");
        assert_eq!(writes[0].entry["snapshot_ref"], "snap_a");
    }

    #[test]
    fn read_direct_writes_without_audit_file_says_so() {
        let project = TempProject::new("noaudit");
        let err = read_direct_writes(&project.0).unwrap_err();
        assert!(
            err.message.contains("没有可回滚的内容"),
            "错误要说清是没记录: {}",
            err.message
        );
    }

    #[test]
    fn file_hash_distinguishes_absent_from_empty() {
        let project = TempProject::new("hash");
        let missing = project.0.join("nope.md");
        assert_eq!(file_hash(&missing).unwrap(), None, "不存在 ≠ 空文件");
        let empty = project.0.join("empty.md");
        std::fs::write(&empty, b"").unwrap();
        assert!(file_hash(&empty).unwrap().is_some(), "空文件也有 hash");
    }

    #[test]
    fn direct_write_keeps_audit_when_pruning_fails() {
        let project = TempProject::new("prune-failure");
        let project_path = project.path_str();
        std::fs::create_dir_all(
            project
                .0
                .join(".novel")
                .join("snapshots")
                .join("snap_blocked.meta.json"),
        )
        .unwrap();
        let virtual_path = project.0.join("wiki").join("chapters").join("ch.md");
        let physical = project.0.join("QM").join("chapters").join("ch.md");
        let content = "\u{FEFF}written\r\n";
        let err = direct_write(
            &project_path,
            "chapter.write_direct",
            virtual_path.to_str().unwrap(),
            content,
        )
        .unwrap_err();
        assert!(err.message.contains("快照裁剪失败"), "{}", err.message);
        assert_eq!(std::fs::read(&physical).unwrap(), content.as_bytes());
        assert!(!virtual_path.exists());
        let audit_path = super::super::writes::external_audit_path(&project.0).unwrap();
        let audit = std::fs::read_to_string(audit_path).unwrap();
        let kinds: Vec<_> = audit
            .lines()
            .map(|line| {
                serde_json::from_str::<Value>(line).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(kinds, vec!["direct_write_intent", "direct_write"]);
        let writes = read_direct_writes(&project.0).unwrap();
        assert_eq!(writes.len(), 1);
        let identity = writes[0].identity.as_ref().unwrap();
        assert_eq!(identity.before_hash, "absent");
        assert_eq!(
            identity.after_hash,
            super::super::writes::sha256_hex(content.as_bytes())
        );
        assert_eq!(Path::new(&identity.path), physical.canonicalize().unwrap());
    }

    #[test]
    fn undo_conflict_blocks_older_same_target_but_audits_other_paths() {
        let project = TempProject::new("undo-conflict-order");
        let project_path = project.path_str();
        let dir = project.0.join("QM").join("chapters");
        let target = dir.join("target.md");
        let other = dir.join("other.md");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&target, b"\xEF\xBB\xBForiginal\xFF").unwrap();
        let write = |path: &Path, contents: &str| {
            direct_write(
                &project_path,
                "chapter.write_direct",
                path.to_str().unwrap(),
                contents,
            )
            .unwrap()
        };
        write(&target, "first");
        let created = write(&other, "new elsewhere");
        write(&target, "second");
        // 内容恰好与较老直写一致，但不能越过更新记录的冲突来还原它。
        std::fs::write(&target, b"first").unwrap();

        let err = undo_direct_writes(&project_path, 3).unwrap_err();
        assert!(
            err.message.contains("1 项已还原，2 项失败"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("未尝试这条更早的记录"),
            "{}",
            err.message
        );
        assert!(err
            .message
            .contains(created["snapshotRef"].as_str().unwrap()));
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert!(!other.exists());

        let audit_path = super::super::writes::external_audit_path(&project.0).unwrap();
        let audit = std::fs::read_to_string(audit_path).unwrap();
        let undos: Vec<_> = audit
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| entry["kind"] == "undo")
            .collect();
        assert_eq!(undos.len(), 1);
        assert_eq!(undos[0]["snapshot_ref"], created["snapshotRef"]);
        assert_eq!(undos[0]["before_hash"], created["afterHash"]);
        assert_eq!(undos[0]["after_hash"], "absent");
    }

    #[test]
    fn direct_write_does_not_modify_target_when_audit_intent_fails() {
        let project = TempProject::new("audit-intent-failure");
        let project_path = project.path_str();
        let target = project.0.join("QM").join("chapters").join("ch.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"original\r\n").unwrap();
        let err = direct_write_with_audit(
            &project_path,
            "chapter.write_direct",
            target.to_str().unwrap(),
            "new",
            |_, record| {
                assert_eq!(record.kind, "direct_write_intent");
                Err("synthetic audit failure".into())
            },
        )
        .unwrap_err();
        assert!(
            err.message.contains("synthetic audit failure"),
            "{}",
            err.message
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"original\r\n");
        assert!(read_direct_writes(&project.0).unwrap().is_empty());
    }

    #[test]
    fn direct_write_audit_serializes_all_required_fields() {
        // 验收要求：直写条目必须含 before_hash / after_hash / snapshot_ref。
        let record = DirectWriteAudit {
            ts: "t".to_string(),
            source: "external_agent",
            tool: "chapter.write_direct",
            kind: "direct_write",
            path: "/p/canon/a.md",
            before_hash: "b".to_string(),
            after_hash: "a".to_string(),
            snapshot_ref: Some("snap_x".to_string()),
        };
        let json = serde_json::to_value(&record).expect("serialize");
        for field in [
            "ts",
            "source",
            "tool",
            "kind",
            "path",
            "before_hash",
            "after_hash",
            "snapshot_ref",
        ] {
            assert!(json.get(field).is_some(), "审计缺字段 {field}: {json}");
        }
        assert_eq!(json["source"], "external_agent");
        assert_eq!(json["kind"], "direct_write");
    }

    #[test]
    fn settings_set_requires_key_and_value_in_schema() {
        let tool = SettingsSetTool;
        assert_eq!(tool.input_schema()["required"], json!(["key", "value"]));
    }

    #[test]
    fn value_hash_is_stable_and_distinguishes_types() {
        assert_eq!(value_hash(&json!("1")), value_hash(&json!("1")));
        assert_ne!(value_hash(&json!("1")), value_hash(&json!(1)));
        assert_ne!(value_hash(&json!(null)), value_hash(&json!(false)));
    }

    // ===== pipeline.status 投影：additive 补 5 键，10 个老键名字/来源不变 =====

    #[test]
    fn pipeline_status_projection_keeps_legacy_fields() {
        let snapshot = json!({
            "taskId": "ptask_1",
            "status": "done",
            "stage": "done",
            "startedAt": 1,
            "finishedAt": 2,
            "error": null,
            "gates": { "overall": "pass" },
            "manualReviewRequired": false,
            "partial": false,
            "contentChars": 123
        });
        let out = project_pipeline_status(&snapshot, "ptask_fallback");
        assert_eq!(out["taskId"], json!("ptask_1"));
        assert_eq!(out["status"], json!("done"));
        assert_eq!(out["stage"], json!("done"));
        assert_eq!(out["startedAt"], json!(1));
        assert_eq!(out["finishedAt"], json!(2));
        assert_eq!(out["error"], Value::Null);
        assert_eq!(out["overallVerdict"], json!("pass"));
        assert_eq!(out["manualReviewRequired"], json!(false));
        assert_eq!(out["partial"], json!(false));
        assert_eq!(out["contentChars"], json!(123));
    }

    #[test]
    fn pipeline_status_projection_adds_five_additive_fields() {
        let snapshot = json!({
            "taskId": "ptask_1",
            "status": "done",
            "stage": "done",
            "startedAt": 1,
            "finishedAt": 2,
            "error": null,
            "gates": {
                "overall": "pass",
                "consistency": { "verdict": "pass", "findings": [{"secret": "x"}] },
                "anti_ai": { "verdict": "warning" },
                "quality": { "verdict": "pass" },
            },
            "manualReviewRequired": false,
            "partial": false,
            "partialReason": null,
            "adoptionGate": "passed",
            "contentChars": 123,
            "kind": "chapter",
            "phase": "world",
            "advanced": true,
            "advancedCount": 2,
            "artifactPath": "/proj/.qm-drafts/draft_1.md"
        });
        let out = project_pipeline_status(&snapshot, "ptask_fallback");
        assert_eq!(out["kind"], json!("chapter"));
        assert_eq!(out["phase"], json!("world"));
        assert_eq!(out["advanced"], json!(true));
        assert_eq!(out["advancedCount"], json!(2));
        assert_eq!(out["artifactPath"], json!("/proj/.qm-drafts/draft_1.md"));
        assert_eq!(out["partialReason"], Value::Null);
        assert_eq!(out["adoptionGate"], json!("passed"));
        assert_eq!(
            out["gateVerdicts"],
            json!({"consistency": "pass", "anti_ai": "warning", "quality": "pass"})
        );
        // 门投影只含 verdict 字符串：findings/正文/错误细节不外泄。
        let gv = out["gateVerdicts"].to_string();
        assert!(!gv.contains("findings") && !gv.contains("secret"), "{gv}");
        // 老键不受新增影响（逐键再钉一次，防「补字段时把 taskId 换成 fallback」这类事故）。
        assert_eq!(out["taskId"], json!("ptask_1"));
        assert_eq!(out["status"], json!("done"));
        assert_eq!(out["stage"], json!("done"));
        assert_eq!(out["startedAt"], json!(1));
        assert_eq!(out["finishedAt"], json!(2));
        assert_eq!(out["error"], Value::Null);
        assert_eq!(out["overallVerdict"], json!("pass"));
        assert_eq!(out["manualReviewRequired"], json!(false));
        assert_eq!(out["partial"], json!(false));
        assert_eq!(out["contentChars"], json!(123));
    }

    #[test]
    fn pipeline_status_projection_nulls_missing_fields() {
        let legacy_only = json!({
            "taskId": "ptask_1",
            "status": "running",
            "stage": "queued",
            "startedAt": 7,
            "gates": { "overall": "pending" }
        });
        let out = project_pipeline_status(&legacy_only, "ptask_fallback");
        // key 恒出（不省略），值缺省 null：调用方不必判断键存在性。
        for key in ["kind", "phase", "advanced", "advancedCount", "artifactPath"] {
            assert!(out.get(key).is_some(), "投影缺键 {key}: {out}");
            assert_eq!(out[key], Value::Null, "{key} 缺省应为 null: {out}");
        }
        // 快照里没有 taskId 时回落到入参（老语义：调用方传了 id，桥接没有再兜底）。
        let no_task_id = json!({ "status": "running" });
        let fell_back = project_pipeline_status(&no_task_id, "ptask_fallback");
        assert_eq!(fell_back["taskId"], json!("ptask_fallback"));
    }

    // ── S3-03：export.run 受控目录沙箱单测 ─────────────────────────────────

    #[test]
    fn controlled_export_default_path_lands_under_project_backups_exports() {
        let project = TempProject::new("export-default");
        let root = super::super::writes::canonical_project(&project.0).unwrap();
        let exports_dir = root.join("backups").join("exports");

        let p_none = resolve_controlled_export_path(&project.0, None).unwrap();
        let p_empty = resolve_controlled_export_path(&project.0, Some("   ")).unwrap();

        for p in [&p_none, &p_empty] {
            assert_eq!(p.parent(), Some(exports_dir.as_path()));
            let name = p.file_name().unwrap().to_str().unwrap();
            assert!(
                name.starts_with("niko-buddy-backup-") && name.ends_with(".zip"),
                "默认文件名格式不对：{name}"
            );
            // 必须是项目内受控目录，绝不直接落到 OS temp_dir 顶层。
            assert_ne!(p.parent(), Some(std::env::temp_dir().as_path()));
        }
        assert_ne!(p_none, p_empty, "连续默认导出应带唯一 uuid 后缀，不得撞名");
    }

    #[test]
    fn controlled_export_accepts_legal_relative_and_absolute_paths() {
        let project = TempProject::new("export-legal");
        let root = super::super::writes::canonical_project(&project.0).unwrap();
        let exports_dir = root.join("backups").join("exports");

        let rel_flat = resolve_controlled_export_path(&project.0, Some("manual.zip")).unwrap();
        assert_eq!(rel_flat, exports_dir.join("manual.zip"));

        let rel_nested =
            resolve_controlled_export_path(&project.0, Some("2026/nov/snapshot.ZIP")).unwrap();
        assert_eq!(
            rel_nested,
            exports_dir.join("2026").join("nov").join("snapshot.ZIP")
        );

        let abs_input = project
            .0
            .join("backups")
            .join("exports")
            .join("abs-dir")
            .join("release.zip");
        let abs_resolved = resolve_controlled_export_path(&project.0, abs_input.to_str()).unwrap();
        assert_eq!(
            abs_resolved,
            exports_dir.join("abs-dir").join("release.zip")
        );

        // 目录已存在时同样放行（且保留受控目录边界）。
        let existing_sub = project.0.join("backups").join("exports").join("ready");
        std::fs::create_dir_all(&existing_sub).unwrap();
        let abs_existing = existing_sub.join("ok.zip");
        let abs_existing_resolved =
            resolve_controlled_export_path(&project.0, abs_existing.to_str()).unwrap();
        assert_eq!(
            abs_existing_resolved,
            exports_dir.join("ready").join("ok.zip")
        );
    }

    #[test]
    fn controlled_export_rejects_escape_uncontrolled_dirs_traversal_and_bad_names() {
        let project = TempProject::new("export-reject");
        let other = TempProject::new("export-other");

        // 项目外路径
        let outside = other.0.join("backups").join("exports").join("escape.zip");
        assert!(resolve_controlled_export_path(&project.0, outside.to_str()).is_err());
        let in_temp = std::env::temp_dir().join("outside-export.zip");
        assert!(resolve_controlled_export_path(&project.0, in_temp.to_str()).is_err());

        // 项目内但非 backups/exports 受控目录
        for bad_abs in [
            project.0.join("root-level.zip"),
            project.0.join("backups").join("auto").join("auto.zip"),
            project.0.join("QM").join("hijack.zip"),
            project.0.join(".novel").join("status.zip"),
        ] {
            assert!(
                resolve_controlled_export_path(&project.0, bad_abs.to_str()).is_err(),
                "非受控目录必须拒绝：{}",
                bad_abs.display()
            );
        }

        // `..` 穿越、控制字符、ADS `:`、半相对路径、非 `.zip`、空 stem、目录斜杠
        for bad_raw in [
            "../escape.zip",
            "sub/../../escape.zip",
            r"sub\..\escape.zip",
            "bad\0name.zip",
            "bad\nname.zip",
            "out.zip::$DATA",
            "sub:stream/out.zip",
            "C:relative.zip",
            r"\root-rel.zip",
            "not-a-zip.tar",
            "no-ext",
            ".zip",
            "   .zip",
            "sub/   .zip",
            "folder.zip/",
        ] {
            assert!(
                resolve_controlled_export_path(&project.0, Some(bad_raw)).is_err(),
                "非法路径必须拒绝：{bad_raw:?}"
            );
        }

        #[cfg(windows)]
        assert!(
            resolve_controlled_export_path(&project.0, Some("/root-relative.zip")).is_err(),
            "Windows 上以 `/` 开头的半相对路径必须拒绝"
        );
    }

    #[test]
    fn controlled_export_forbids_overwriting_existing_zip_or_sidecar() {
        let project = TempProject::new("export-no-overwrite");
        let exports_dir = project.0.join("backups").join("exports");
        std::fs::create_dir_all(&exports_dir).unwrap();

        let existing_zip = exports_dir.join("taken.zip");
        std::fs::write(&existing_zip, b"existing zip").unwrap();
        let err_zip = resolve_controlled_export_path(&project.0, Some("taken.zip")).unwrap_err();
        assert!(
            err_zip.message.contains("禁止覆写"),
            "已存在 .zip 必须禁止覆写：{}",
            err_zip.message
        );

        // 即使 .zip 不存在，只要 .zip.sha256 sidecar 已存在，也必须禁止覆写。
        let only_sidecar = exports_dir.join("sidecar-only.zip.sha256");
        std::fs::write(&only_sidecar, b"deadbeef  sidecar-only.zip\n").unwrap();
        let err_sidecar =
            resolve_controlled_export_path(&project.0, Some("sidecar-only.zip")).unwrap_err();
        assert!(
            err_sidecar.message.contains("禁止覆写"),
            "已存在 .sha256 sidecar 必须禁止覆写：{}",
            err_sidecar.message
        );
    }

    #[test]
    fn controlled_export_rejects_symlink_or_reparse_in_chain_and_target() {
        let project = TempProject::new("export-symlink");
        let outside = TempProject::new("export-symlink-outside");

        #[cfg(unix)]
        {
            // 1. exports 目录本身是符号链接 -> 拒绝
            let backups = project.0.join("backups");
            std::fs::create_dir_all(&backups).unwrap();
            let exports_link = backups.join("exports");
            std::os::unix::fs::symlink(&outside.0, &exports_link).unwrap();
            assert!(resolve_controlled_export_path(&project.0, None).is_err());
            assert!(resolve_controlled_export_path(&project.0, Some("a.zip")).is_err());
            std::fs::remove_file(&exports_link).unwrap();

            // 2. exports 下子目录是符号链接（即使指向项目内）-> 拒绝
            std::fs::create_dir_all(&exports_link).unwrap();
            let real_sub = exports_link.join("real");
            std::fs::create_dir_all(&real_sub).unwrap();
            let link_sub = exports_link.join("alias");
            std::os::unix::fs::symlink(&real_sub, &link_sub).unwrap();
            assert!(resolve_controlled_export_path(&project.0, Some("alias/a.zip")).is_err());
            let abs_via_link = link_sub.join("a.zip");
            assert!(resolve_controlled_export_path(&project.0, abs_via_link.to_str()).is_err());

            // 3. 目标 .zip 或 .sha256 是悬空符号链接 -> symlink_metadata 捕获并拒绝
            let dangling_zip = exports_link.join("dangling.zip");
            std::os::unix::fs::symlink(outside.0.join("nonexistent.zip"), &dangling_zip).unwrap();
            assert!(resolve_controlled_export_path(&project.0, Some("dangling.zip")).is_err());
            let dangling_sha = exports_link.join("dangling2.zip.sha256");
            std::os::unix::fs::symlink(outside.0.join("nonexistent.sha256"), &dangling_sha)
                .unwrap();
            assert!(resolve_controlled_export_path(&project.0, Some("dangling2.zip")).is_err());
        }

        #[cfg(windows)]
        {
            let make_dir_link = |target: &Path, link: &Path| -> bool {
                std::os::windows::fs::symlink_dir(target, link).is_ok()
                    || std::process::Command::new("cmd")
                        .args([
                            "/c",
                            "mklink",
                            "/J",
                            &link.to_string_lossy(),
                            &target.to_string_lossy(),
                        ])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .is_ok_and(|s| s.success())
            };

            // 1. exports 目录本身是目录联接/符号链接 -> 拒绝
            let backups = project.0.join("backups");
            std::fs::create_dir_all(&backups).unwrap();
            let exports_link = backups.join("exports");
            assert!(
                make_dir_link(&outside.0, &exports_link),
                "Windows 测试应能建立目录联接或符号链接"
            );
            assert!(resolve_controlled_export_path(&project.0, None).is_err());
            assert!(resolve_controlled_export_path(&project.0, Some("a.zip")).is_err());
            let abs_via_junction = exports_link.join("a.zip");
            assert!(resolve_controlled_export_path(&project.0, abs_via_junction.to_str()).is_err());
            let _ = std::fs::remove_dir(&exports_link);

            // 2. exports 下子目录是目录联接（即使指向项目内）-> 拒绝
            std::fs::create_dir_all(&exports_link).unwrap();
            let real_sub = exports_link.join("real");
            std::fs::create_dir_all(&real_sub).unwrap();
            let link_sub = exports_link.join("alias");
            assert!(make_dir_link(&real_sub, &link_sub));
            assert!(resolve_controlled_export_path(&project.0, Some("alias/a.zip")).is_err());
            let abs_via_sub_link = link_sub.join("a.zip");
            assert!(resolve_controlled_export_path(&project.0, abs_via_sub_link.to_str()).is_err());
            let _ = std::fs::remove_dir(&link_sub);
        }
    }

    #[test]
    fn controlled_export_rejects_windows_reserved_device_names() {
        let project = TempProject::new("export-reserved");
        for bad_raw in [
            "CON.zip",
            "prn.zip",
            "aux.tar.zip",
            "NUL.zip",
            "COM1.zip",
            "lpt9.zip",
            "CON/backup.zip",
            "sub/aux/out.zip",
        ] {
            let err = resolve_controlled_export_path(&project.0, Some(bad_raw))
                .expect_err("Windows reserved device names must be rejected");
            assert!(
                err.message.contains("保留设备名"),
                "unexpected error for {bad_raw}: {}",
                err.message
            );
        }
        let abs_reserved = project.0.join("backups").join("exports").join("NUL.zip");
        assert!(resolve_controlled_export_path(&project.0, abs_reserved.to_str()).is_err());
    }

    #[test]
    fn read_direct_writes_reconciles_dangling_direct_write_and_undo_intents() {
        let project = TempProject::new("wal-reconcile");
        let project_path = project.path_str();
        let dir = project.0.join("QM").join("chapters");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("wal.md");
        std::fs::write(&target, b"v0").unwrap();

        // 1) 模拟 direct_write_intent 落盘且磁盘写入已生效，但在写入 direct_write 提交行前崩溃。
        let err = direct_write_with_audit(
            &project_path,
            "chapter.write_direct",
            target.to_str().unwrap(),
            "v1",
            |file, record| {
                if record.kind == "direct_write" {
                    Err("simulated crash before commit audit".into())
                } else {
                    append_audit_line(file, record)
                }
            },
        )
        .unwrap_err();
        assert!(err.message.contains("simulated crash"), "{}", err.message);
        assert_eq!(std::fs::read(&target).unwrap(), b"v1");

        // 对账应基于磁盘 file_hash 恢复这条悬挂 direct_write_intent，使 undo_last 可正常回滚。
        let recovered = read_direct_writes(&project.0).unwrap();
        assert_eq!(
            recovered.len(),
            1,
            "已落盘的悬挂 direct_write_intent 必须恢复"
        );
        let snap1 = recovered[0].identity.as_ref().unwrap().snapshot_ref.clone();

        // 未落盘的悬挂 direct_write_intent（磁盘仍停留在 v1，而非 fake_v2）绝不得被恢复。
        let canon_target = target.canonicalize().unwrap();
        let (mut audit_file, _) = open_audit_log(&project.0).unwrap();
        let uncommitted_intent = DirectWriteAudit {
            ts: chrono::Utc::now().to_rfc3339(),
            source: "external_agent",
            tool: "chapter.write_direct",
            kind: "direct_write_intent",
            path: &canon_target.to_string_lossy(),
            before_hash: super::super::writes::sha256_hex(b"v1"),
            after_hash: super::super::writes::sha256_hex(b"never-written-v2"),
            snapshot_ref: Some("snap_uncommitted".to_string()),
        };
        append_audit_line(&mut audit_file, &uncommitted_intent).unwrap();
        let after_uncommitted = read_direct_writes(&project.0).unwrap();
        assert_eq!(after_uncommitted.len(), 1);
        assert_eq!(
            after_uncommitted[0].identity.as_ref().unwrap().snapshot_ref,
            snap1
        );

        // 通过 undo_last 成功回滚恢复出来的写入 → 回到 v0。
        undo_direct_writes(&project_path, 1).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"v0");
        assert!(read_direct_writes(&project.0).unwrap().is_empty());

        // 2) 模拟正常提交后，undo_intent 落盘且磁盘已恢复，但在写入 undo 提交行前崩溃。
        let w2 = direct_write(
            &project_path,
            "chapter.write_direct",
            target.to_str().unwrap(),
            "v2",
        )
        .unwrap();
        let snap2 = w2["snapshotRef"].as_str().unwrap().to_string();
        assert_eq!(read_direct_writes(&project.0).unwrap().len(), 1);

        let (mut audit_file, _) = open_audit_log(&project.0).unwrap();
        let dangling_undo_intent = DirectWriteAudit {
            ts: chrono::Utc::now().to_rfc3339(),
            source: "external_agent",
            tool: "undo_last",
            kind: "undo_intent",
            path: &canon_target.to_string_lossy(),
            before_hash: super::super::writes::sha256_hex(b"v2"),
            after_hash: super::super::writes::sha256_hex(b"v0"),
            snapshot_ref: Some(snap2.clone()),
        };
        append_audit_line(&mut audit_file, &dangling_undo_intent).unwrap();

        // 磁盘仍在 v2（回滚尚未生效）→ 仍应保留在可回滚栈中。
        assert_eq!(read_direct_writes(&project.0).unwrap().len(), 1);

        // 模拟磁盘已恢复回 v0（回滚已生效但 undo 提交行缺失）→ 对账后视为已撤销。
        std::fs::write(&target, b"v0").unwrap();
        assert!(
            read_direct_writes(&project.0).unwrap().is_empty(),
            "磁盘已到达 undo_intent.after_hash 时必须识别为已撤销"
        );
    }

    // ── Zero-LLM 只读工具（draft.list / draft.read / rules.get / gate.check_mechanical）──

    #[test]
    fn four_zero_llm_tools_are_registered_read_only_and_not_privileged() {
        let r = build_registry();
        assert_eq!(r.names()[0], "app.ping", "app.ping 必须保持在索引 0");
        let privileged = r.privileged_tools();
        let list = r.list();
        let listed_names: Vec<&str> = list["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();

        for name in [
            "draft.list",
            "draft.read",
            "rules.get",
            "gate.check_mechanical",
        ] {
            assert_eq!(
                r.required_scope(name),
                Some(crate::mcp_server::session::SessionScope::Read),
                "{name} 必须只需 Read scope"
            );
            assert!(
                !privileged.contains(&name),
                "{name} 不得进入 privileged 列表"
            );
            assert!(listed_names.contains(&name), "{name} 必须出现在 tools/list");
        }
    }

    #[tokio::test]
    async fn draft_list_accepts_only_empty_object_and_uses_no_params_envelope() {
        let query = build_draft_list_query(&json!({})).expect("empty object ok");
        assert_eq!(query.op, "draft-list");
        assert!(query.params.is_none());
        assert!(query.key.is_none());
        assert!(query.path.is_none());
        assert!(query.offset.is_none());
        assert!(query.limit.is_none());

        let ctx = ToolContext::for_test();
        let err_missing_app = DraftListTool
            .call(&ctx, &json!({}))
            .await
            .expect_err("无 AppHandle 应报内部错");
        assert_eq!(
            err_missing_app.code,
            crate::mcp_server::protocol::INTERNAL_ERROR
        );

        for bad in [
            json!(null),
            json!([]),
            json!("x"),
            json!({ "extra": 1 }),
            json!({ "extra": null }),
        ] {
            let err = DraftListTool
                .call(&ctx, &bad)
                .await
                .expect_err("非法参数必须在桥前拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn draft_read_validates_strictly_and_builds_locked_params_envelope() {
        let q_default =
            build_draft_read_query(&json!({ "draftId": "draft_01-abc" })).expect("valid default");
        assert_eq!(q_default.op, "draft-read");
        assert!(q_default.path.is_none());
        assert!(q_default.offset.is_none());
        assert!(q_default.limit.is_none());
        assert_eq!(
            q_default.params,
            Some(json!({ "draftId": "draft_01-abc", "offset": 0, "limit": 200 }))
        );

        let q_custom = build_draft_read_query(&json!({
            "draftId": "A".repeat(128),
            "offset": 15,
            "limit": 2000
        }))
        .expect("valid custom");
        assert_eq!(
            q_custom.params,
            Some(json!({ "draftId": "A".repeat(128), "offset": 15, "limit": 2000 }))
        );

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            json!({}),
            json!({ "draftId": "" }),
            json!({ "draftId": " " }),
            json!({ "draftId": "draft 1" }),
            json!({ "draftId": "../secret" }),
            json!({ "draftId": "草稿1" }),
            json!({ "draftId": "a".repeat(129) }),
            json!({ "draftId": 123 }),
            json!({ "draftId": null }),
            json!({ "draftId": "ok_1", "offset": null }),
            json!({ "draftId": "ok_1", "limit": null }),
            json!({ "draftId": "ok_1", "offset": -1 }),
            json!({ "draftId": "ok_1", "offset": "0" }),
            json!({ "draftId": "ok_1", "offset": 1.5 }),
            json!({ "draftId": "ok_1", "limit": 0 }),
            json!({ "draftId": "ok_1", "limit": 2001 }),
            json!({ "draftId": "ok_1", "limit": "200" }),
            json!({ "draftId": "ok_1", "unknown": true }),
        ] {
            let err = DraftReadTool
                .call(&ctx, &bad)
                .await
                .expect_err("draft.read 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn rules_get_defaults_dedups_and_enforces_whitelist() {
        let q_default = build_rules_get_query(&json!({})).expect("default sections");
        assert_eq!(q_default.op, "rules-get");
        assert_eq!(
            q_default.params,
            Some(json!({ "sections": ["writingStyle", "antiAi", "bookRules", "planning"] }))
        );

        let q_dedup = build_rules_get_query(&json!({
            "sections": ["planning", "antiAi", "planning", "writingStyle", "antiAi"]
        }))
        .expect("dedup preserving order");
        assert_eq!(
            q_dedup.params,
            Some(json!({ "sections": ["planning", "antiAi", "writingStyle"] }))
        );

        // 16 项重复项也合法（未超过 max len 16），去重后只留 1 项。
        let max_valid = vec!["bookRules"; 16];
        let q_max = build_rules_get_query(&json!({ "sections": max_valid })).expect("len 16 ok");
        assert_eq!(q_max.params, Some(json!({ "sections": ["bookRules"] })));

        let ctx = ToolContext::for_test();
        let too_many = vec!["bookRules"; 17];
        for bad in [
            json!(null),
            json!([]),
            json!({ "sections": null }),
            json!({ "sections": "antiAi" }),
            json!({ "sections": [] }),
            json!({ "sections": ["unknownSection"] }),
            json!({ "sections": ["antiAi", 42] }),
            json!({ "sections": ["antiAi", null] }),
            json!({ "sections": too_many }),
            json!({ "extra": 1 }),
        ] {
            let err = RulesGetTool
                .call(&ctx, &bad)
                .await
                .expect_err("rules.get 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn gate_check_mechanical_enforces_1_of_3_exclusivity_and_bounds() {
        let q_draft = build_gate_check_mechanical_query(&json!({
            "draftId": "draft-1",
            "chapterNumber": 12
        }))
        .expect("draftId valid");
        assert_eq!(q_draft.op, "gate-check-mechanical");
        assert_eq!(
            q_draft.params,
            Some(json!({ "draftId": "draft-1", "chapterNumber": 12 }))
        );

        let q_chapter = build_gate_check_mechanical_query(&json!({
            "chapter": "chapter-003.md"
        }))
        .expect("chapter valid");
        assert_eq!(
            q_chapter.params,
            Some(json!({ "chapter": "chapter-003.md" }))
        );

        let q_text = build_gate_check_mechanical_query(&json!({
            "text": "正文段落，用于零 LLM 机械检查。"
        }))
        .expect("text valid");
        assert_eq!(
            q_text.params,
            Some(json!({ "text": "正文段落，用于零 LLM 机械检查。" }))
        );

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            // 0-of-3
            json!({}),
            json!({ "chapterNumber": 1 }),
            // >1-of-3
            json!({ "draftId": "d1", "chapter": "1" }),
            json!({ "draftId": "d1", "text": "hello" }),
            json!({ "chapter": "1", "text": "hello" }),
            json!({ "draftId": "d1", "chapter": "1", "text": "hello" }),
            // explicit nulls / unknown keys
            json!({ "draftId": null, "text": "hello" }),
            json!({ "text": "hello", "chapterNumber": null }),
            json!({ "text": "hello", "extra": 1 }),
            // invalid draftId
            json!({ "draftId": "" }),
            json!({ "draftId": "bad/id" }),
            json!({ "draftId": "a".repeat(129) }),
            // invalid chapter
            json!({ "chapter": "" }),
            json!({ "chapter": "   " }),
            json!({ "chapter": "a".repeat(257) }),
            json!({ "chapter": "ch\n1.md" }),
            json!({ "chapter": "ch\0.md" }),
            json!({ "chapter": "../secret.md" }),
            json!({ "chapter": "a/b.md" }),
            json!({ "chapter": r"a\b.md" }),
            // invalid text
            json!({ "text": "" }),
            json!({ "text": "   " }),
            json!({ "text": "字".repeat(100_001) }),
            json!({ "text": 42 }),
            // invalid chapterNumber
            json!({ "text": "ok", "chapterNumber": 0 }),
            json!({ "text": "ok", "chapterNumber": -1 }),
            json!({ "text": "ok", "chapterNumber": "1" }),
            json!({ "text": "ok", "chapterNumber": 1.5 }),
        ] {
            let err = GateCheckMechanicalTool
                .call(&ctx, &bad)
                .await
                .expect_err("gate.check_mechanical 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    // ── Round 2 新增工具（context.prepare_write / director.check / outline.write）──

    #[test]
    fn round2_zero_llm_tools_have_expected_scopes_and_listing() {
        let r = build_registry();
        let privileged = r.privileged_tools();
        let write_like = crate::mcp_server::contains_write_like_tool(&r);
        let list = r.list();
        let listed_names: Vec<&str> = list["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();

        for read_tool in ["context.prepare_write", "director.check"] {
            assert_eq!(
                r.required_scope(read_tool),
                Some(crate::mcp_server::session::SessionScope::Read),
                "{read_tool} 必须只需 Read scope"
            );
            assert!(
                !privileged.contains(&read_tool),
                "{read_tool} 不得进入 privileged 列表"
            );
            assert!(listed_names.contains(&read_tool));
        }

        assert_eq!(
            r.required_scope("outline.write"),
            Some(crate::mcp_server::session::SessionScope::Project),
            "outline.write 必须要求 Project scope"
        );
        assert!(privileged.contains(&"outline.write"));
        assert!(write_like.contains(&"outline.write"));
        assert!(listed_names.contains(&"outline.write"));
        // 硬安全红线：绝不注册 draft.accept
        assert!(!r.names().contains(&"draft.accept"));
        assert!(!listed_names.contains(&"draft.accept"));

        // context.prepare_write 的 dimension 不得在 Rust 侧锁死 enum（TS 侧按 SIX_REVIEW_DIMENSION_ORDER 校验）。
        let schema = ContextPrepareWriteTool.input_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["dimension"]["type"], json!("string"));
        assert!(schema["properties"]["dimension"].get("enum").is_none());
        assert_eq!(
            schema["properties"]["targetChapter"]["maximum"],
            json!(JS_MAX_SAFE_INTEGER)
        );
        assert_eq!(
            schema["properties"]["offset"]["maximum"],
            json!(JS_MAX_SAFE_INTEGER)
        );
        assert!(schema["properties"]["includePlanningView"]["description"]
            .as_str()
            .unwrap()
            .contains("default true"));
    }

    #[tokio::test]
    async fn context_prepare_write_validates_defaults_bounds_and_polls_async_job() {
        let defaults = build_context_prepare_write_params(&json!({})).expect("empty object ok");
        assert_eq!(
            defaults,
            json!({
                "allowRetrievalNetwork": false,
                "offset": 0,
                "limit": 16_000,
            })
        );

        let full = build_context_prepare_write_params(&json!({
            "targetChapter": 12,
            "draftId": "draft_12-rev1",
            "task": "推进主线冲突",
            "includePack": true,
            "includeDraft": true,
            "includePlanningView": true,
            "dimension": "consistency",
            "allowRetrievalNetwork": true,
            "offset": 100,
            "limit": 50_000,
        }))
        .expect("full params ok");
        assert_eq!(full["targetChapter"], json!(12));
        assert_eq!(full["draftId"], json!("draft_12-rev1"));
        assert_eq!(full["task"], json!("推进主线冲突"));
        assert_eq!(full["includePack"], json!(true));
        assert_eq!(full["includeDraft"], json!(true));
        assert_eq!(full["includePlanningView"], json!(true));
        assert_eq!(full["dimension"], json!("consistency"));
        assert_eq!(full["allowRetrievalNetwork"], json!(true));
        assert_eq!(full["offset"], json!(100));
        assert_eq!(full["limit"], json!(50_000));

        // JS MAX_SAFE_INTEGER 边界放行，+1 必须拒绝。
        let safe_max = build_context_prepare_write_params(&json!({
            "targetChapter": JS_MAX_SAFE_INTEGER,
            "offset": JS_MAX_SAFE_INTEGER,
        }))
        .expect("MAX_SAFE_INTEGER ok");
        assert_eq!(safe_max["targetChapter"], json!(JS_MAX_SAFE_INTEGER));
        assert_eq!(safe_max["offset"], json!(JS_MAX_SAFE_INTEGER));

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            json!({ "extra": 1 }),
            json!({ "targetChapter": null }),
            json!({ "targetChapter": 0 }),
            json!({ "targetChapter": -1 }),
            json!({ "targetChapter": JS_MAX_SAFE_INTEGER + 1 }),
            json!({ "targetChapter": "1" }),
            json!({ "draftId": "" }),
            json!({ "draftId": "../bad" }),
            json!({ "draftId": "a".repeat(129) }),
            json!({ "draftId": 123 }),
            json!({ "task": "" }),
            json!({ "task": "   " }),
            json!({ "task": "字".repeat(4001) }),
            json!({ "task": 99 }),
            json!({ "includePack": "true" }),
            json!({ "includeDraft": 1 }),
            json!({ "includePlanningView": "yes" }),
            json!({ "allowRetrievalNetwork": "false" }),
            json!({ "dimension": "" }),
            json!({ "dimension": "   " }),
            json!({ "dimension": "d".repeat(65) }),
            json!({ "dimension": 7 }),
            json!({ "offset": -1 }),
            json!({ "offset": JS_MAX_SAFE_INTEGER + 1 }),
            json!({ "offset": "0" }),
            json!({ "limit": 0 }),
            json!({ "limit": 50_001 }),
            json!({ "limit": "16000" }),
        ] {
            let err = ContextPrepareWriteTool
                .call(&ctx, &bad)
                .await
                .expect_err("context.prepare_write 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }

        // 共享 run_async_bridge_job：context-prepare-start -> running -> context-prepare-poll -> done
        let polls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let polls_ref = polls.clone();
        let ok = run_async_bridge_job(
            "context.prepare_write",
            "context-prepare-start",
            "context-prepare-poll",
            defaults,
            std::time::Duration::from_millis(1),
            std::time::Duration::from_secs(2),
            move |q| {
                let p = polls_ref.clone();
                async move {
                    match q.op.as_str() {
                        "context-prepare-start" => {
                            Ok(json!({ "status": "running", "jobId": "prep-1" }))
                        }
                        "context-prepare-poll" => {
                            let n = p.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            if n == 0 {
                                Ok(json!({ "status": "running", "jobId": "prep-1" }))
                            } else {
                                Ok(json!({
                                    "status": "done",
                                    "jobId": "prep-1",
                                    "value": { "ready": true, "packBuilt": false }
                                }))
                            }
                        }
                        other => Err(ToolError::internal(format!("unexpected op {other}"))),
                    }
                }
            },
        )
        .await
        .expect("prepare job should complete");
        assert_eq!(ok["ready"], json!(true));
        assert_eq!(polls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn director_check_accepts_only_empty_object() {
        let q = build_director_check_query(&json!({})).expect("empty object ok");
        assert_eq!(q.op, "director-check");
        assert!(q.params.is_none());

        let ctx = ToolContext::for_test();
        let missing_app = DirectorCheckTool
            .call(&ctx, &json!({}))
            .await
            .expect_err("无 AppHandle 应报内部错");
        assert_eq!(
            missing_app.code,
            crate::mcp_server::protocol::INTERNAL_ERROR
        );

        for bad in [
            json!(null),
            json!([]),
            json!("check"),
            json!({ "phase": "outline" }),
            json!({ "extra": null }),
        ] {
            let err = DirectorCheckTool
                .call(&ctx, &bad)
                .await
                .expect_err("director.check 非空参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn outline_write_validates_filename_content_and_sync_model() {
        let q_default = build_outline_write_query(&json!({
            "filename": "第一卷-总纲.md",
            "content": "# 第一卷\n开篇"
        }))
        .expect("default syncModel ok");
        assert_eq!(q_default.op, "outline-write");
        assert_eq!(
            q_default.params,
            Some(json!({
                "filename": "第一卷-总纲.md",
                "content": "# 第一卷\n开篇",
                "syncModel": true,
            }))
        );

        let q_no_sync = build_outline_write_query(&json!({
            "filename": "MAIN-OUTLINE.MD",
            "content": "大纲正文",
            "syncModel": false,
        }))
        .expect("case-insensitive .MD and syncModel=false ok");
        assert_eq!(
            q_no_sync.params.as_ref().unwrap()["syncModel"],
            json!(false)
        );

        // 边界值：128 字符文件名与 200_000 字符正文放行。
        let max_name = format!("{}.md", "a".repeat(125));
        assert_eq!(max_name.chars().count(), 128);
        assert!(build_outline_write_query(&json!({
            "filename": max_name,
            "content": "字".repeat(200_000),
        }))
        .is_ok());

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            json!({}),
            json!({ "filename": "ok.md" }),
            json!({ "content": "ok" }),
            json!({ "filename": "ok.md", "content": "ok", "extra": 1 }),
            json!({ "filename": "ok.md", "content": "ok", "syncModel": null }),
            json!({ "filename": "ok.md", "content": "ok", "syncModel": "true" }),
            // 非法文件名
            json!({ "filename": "", "content": "ok" }),
            json!({ "filename": "   ", "content": "ok" }),
            json!({ "filename": " ok.md", "content": "ok" }),
            json!({ "filename": "ok.md ", "content": "ok" }),
            json!({ "filename": format!("{}.md", "a".repeat(126)), "content": "ok" }),
            json!({ "filename": "../escape.md", "content": "ok" }),
            json!({ "filename": "sub/outline.md", "content": "ok" }),
            json!({ "filename": r"sub\outline.md", "content": "ok" }),
            json!({ "filename": "a..b.md", "content": "ok" }),
            json!({ "filename": "out:stream.md", "content": "ok" }),
            json!({ "filename": "bad\nname.md", "content": "ok" }),
            json!({ "filename": "bad\0name.md", "content": "ok" }),
            json!({ "filename": ".md", "content": "ok" }),
            json!({ "filename": ".hidden.md", "content": "ok" }),
            json!({ "filename": "foo..md", "content": "ok" }),
            json!({ "filename": "outline.txt", "content": "ok" }),
            json!({ "filename": "outline", "content": "ok" }),
            json!({ "filename": "outline.md.txt", "content": "ok" }),
            // Windows 保留设备名（含首段与 `.md` 间夹尾随空格的变体）
            json!({ "filename": "CON.md", "content": "ok" }),
            json!({ "filename": "CON .md", "content": "ok" }),
            json!({ "filename": "prn.md", "content": "ok" }),
            json!({ "filename": "AUX.md", "content": "ok" }),
            json!({ "filename": "nul.md", "content": "ok" }),
            json!({ "filename": "NUL .md", "content": "ok" }),
            json!({ "filename": "COM1.md", "content": "ok" }),
            json!({ "filename": "com1 .sub.md", "content": "ok" }),
            json!({ "filename": "com9.md", "content": "ok" }),
            json!({ "filename": "LPT1.md", "content": "ok" }),
            json!({ "filename": "lpt9.md", "content": "ok" }),
            json!({ "filename": "CON.sub.md", "content": "ok" }),
            // 非法 content
            json!({ "filename": "ok.md", "content": "" }),
            json!({ "filename": "ok.md", "content": "   \n\t  " }),
            json!({ "filename": "ok.md", "content": "字".repeat(200_001) }),
            json!({ "filename": "ok.md", "content": 42 }),
        ] {
            let err = OutlineWriteTool
                .call(&ctx, &bad)
                .await
                .expect_err("outline.write 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }
}
