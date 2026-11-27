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
use super::session::{SessionScope, ToolProfile};
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
    /// **本次请求**调用方冻结的工具曝光 Profile（`app.status` 如实回报它）。
    pub caller_profile: ToolProfile,
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
            caller_profile: ToolProfile::FullLegacy,
        }
    }

    /// 派生一个**请求局部**的上下文：共享同一批运行时资源，只替换调用方 scope（沿用当前 profile）。
    ///
    /// `AppHandle` 与 `StateBridgeState` 的克隆不复制状态（桥内部是 `Arc`，克隆
    /// 共享同一张待决表），因此这里只把「谁在调」这一条**请求事实**带进工具，
    /// 不新增任何持久状态、也不把 scope 写回共享句柄。
    pub fn for_caller(&self, caller: SessionScope) -> Self {
        self.for_caller_with_profile(caller, self.caller_profile)
    }

    /// 派生一个带指定 `SessionScope` 与 `ToolProfile` 的请求局部上下文。
    pub fn for_caller_with_profile(&self, caller: SessionScope, profile: ToolProfile) -> Self {
        Self {
            app: self.app.clone(),
            bridge: self.bridge.clone(),
            port: self.port,
            caller_scope: caller,
            caller_profile: profile,
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
                "profile": ctx.caller_profile.as_str(),
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
            let normalized = Value::Object(normalize_strict_object_args(
                args,
                tool,
                &allowed_fields,
                &["chapter"],
            )?);
            let chapter = require_str(&normalized, tool, "chapter")?;
            let mut params = json!({ "chapter": chapter });

            match normalized.get("task") {
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
            match normalized.get("dimension") {
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
            match normalized.get("inspectionId") {
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
                if let Some(value) = optional_bool(&normalized, tool, field)? {
                    params[field] = json!(value);
                }
            }
            if let Some(offset) =
                optional_int_in_range(&normalized, tool, "promptOffset", 0, u64::MAX)?
            {
                params["promptOffset"] = json!(offset);
            }
            if let Some(limit) = optional_int_in_range(
                &normalized,
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

fn parse_canon_query_filter(
    args: &Value,
) -> Result<crate::canon::types_query::CanonEdgeFilter, ToolError> {
    let filter_value = args
        .get("filter")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    serde_json::from_value(filter_value)
        .map_err(|e| ToolError::invalid_params(format!("`filter` is invalid: {e}")))
}

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

            let filter = parse_canon_query_filter(args)?;
            let app = ctx.app()?.clone();
            let project_path = ctx.project_path().await?;

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

const CANON_POV_MAX_CHARS: usize = 128;
const CANON_READ_DEFAULT_LIMIT: usize = 50;
const CANON_READ_MAX_LIMIT: u64 = 200;
const CANON_READ_MAX_OFFSET: u64 = 100_000;
const CANON_READ_MAX_CHAPTER: u64 = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedCanonFactsKnownByArgs {
    pov: String,
    at_chapter: Option<i32>,
    include_invalidated: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn parse_canon_facts_known_by_args(args: &Value) -> Result<ParsedCanonFactsKnownByArgs, ToolError> {
    let tool = "canon.facts_known_by";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["pov", "atChapter", "includeInvalidated", "offset", "limit"],
        &["pov"],
    )?);

    let raw_pov = match normalized.get("pov") {
        Some(v) => v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `pov` 必须是字符串，收到 {v}"))
        })?,
        None => {
            return Err(ToolError::invalid_params(format!(
                "{tool}: 缺少必填字符串参数 `pov`"
            )))
        }
    };
    let valid_pov = validate_single_line_str(raw_pov, tool, "pov", 1, CANON_POV_MAX_CHARS)?;
    let pov = valid_pov.trim().to_string();

    let at_chapter =
        optional_int_in_range(&normalized, tool, "atChapter", 1, CANON_READ_MAX_CHAPTER)?
            .map(|n| n as i32);
    let include_invalidated = optional_bool(&normalized, tool, "includeInvalidated")?;
    let offset = optional_int_in_range(&normalized, tool, "offset", 0, CANON_READ_MAX_OFFSET)?
        .map(|n| n as usize);
    let limit = Some(
        optional_int_in_range(&normalized, tool, "limit", 1, CANON_READ_MAX_LIMIT)?
            .map(|n| n as usize)
            .unwrap_or(CANON_READ_DEFAULT_LIMIT),
    );

    Ok(ParsedCanonFactsKnownByArgs {
        pov,
        at_chapter,
        include_invalidated,
        offset,
        limit,
    })
}

/// `canon.facts_known_by` —— 严格只读 POV 认知轴事实查询（直调 Rust `canon_facts_known_by_impl`）。
pub struct CanonFactsKnownByTool;

impl super::registry::McpTool for CanonFactsKnownByTool {
    fn name(&self) -> &'static str {
        "canon.facts_known_by"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM read-only query returning canon edges known by a specific POV character (strictly isolates facts unknown to that POV), optionally filtered at a world chapter number with pagination. Direct Rust CanonStore read; never writes to disk."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["pov"],
            "properties": {
                "pov": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": CANON_POV_MAX_CHARS,
                    "description": "Required non-empty single-line POV character identifier (1..=128 characters)"
                },
                "atChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CANON_READ_MAX_CHAPTER,
                    "description": "Optional 1-based world chapter number (validAtChapter, 1..=100000)"
                },
                "includeInvalidated": {
                    "type": "boolean",
                    "description": "Include invalidated/superseded canon edges (default false)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": CANON_READ_MAX_OFFSET,
                    "description": "Optional pagination offset (0..=100000, default 0)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CANON_READ_MAX_LIMIT,
                    "description": format!("Optional page size limit (1..={CANON_READ_MAX_LIMIT}, default {CANON_READ_DEFAULT_LIMIT})")
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
            use crate::canon::commands_core::canon_facts_known_by_impl;

            let parsed = parse_canon_facts_known_by_args(args)?;
            let app = ctx.app()?.clone();
            let project_path = ctx.project_path().await?;

            let state = app.state::<CanonCommandState>();
            let response = canon_facts_known_by_impl(
                &state,
                project_path,
                parsed.pov,
                parsed.at_chapter,
                parsed.include_invalidated,
                parsed.offset,
                parsed.limit,
            )
            .await
            .map_err(|e| ToolError {
                code: crate::mcp_server::protocol::INTERNAL_ERROR,
                message: e,
            })?;
            serde_json::to_value(response).map_err(|e| ToolError::internal(e.to_string()))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedCanonEpisodesArgs {
    chapter_number: i32,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn parse_canon_episodes_args(args: &Value) -> Result<ParsedCanonEpisodesArgs, ToolError> {
    let tool = "canon.episodes";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["chapterNumber", "offset", "limit"],
        &["chapterNumber"],
    )?);

    let chapter_number = match normalized.get("chapterNumber") {
        Some(v) => match v.as_u64() {
            Some(n) if (1..=CANON_READ_MAX_CHAPTER).contains(&n) => n as i32,
            _ => {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `chapterNumber` 必须是 1..={CANON_READ_MAX_CHAPTER} 的整数，收到 {v}"
                )))
            }
        },
        None => {
            return Err(ToolError::invalid_params(format!(
                "{tool}: 缺少必填整数参数 `chapterNumber`"
            )))
        }
    };
    let offset = optional_int_in_range(&normalized, tool, "offset", 0, CANON_READ_MAX_OFFSET)?
        .map(|n| n as usize);
    let limit = Some(
        optional_int_in_range(&normalized, tool, "limit", 1, CANON_READ_MAX_LIMIT)?
            .map(|n| n as usize)
            .unwrap_or(CANON_READ_DEFAULT_LIMIT),
    );

    Ok(ParsedCanonEpisodesArgs {
        chapter_number,
        offset,
        limit,
    })
}

/// `canon.episodes` —— 严格只读按章节查询 Canon Episodes（直调 Rust `canon_query_episodes_impl`）。
pub struct CanonEpisodesTool;

impl super::registry::McpTool for CanonEpisodesTool {
    fn name(&self) -> &'static str {
        "canon.episodes"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM read-only query returning ingested canon episode provenance rows for a specific 1-based chapter number with pagination. Direct Rust CanonStore read; never writes to disk."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["chapterNumber"],
            "properties": {
                "chapterNumber": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CANON_READ_MAX_CHAPTER,
                    "description": "Required 1-based chapter number to query ingested canon episodes (1..=100000)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": CANON_READ_MAX_OFFSET,
                    "description": "Optional pagination offset (0..=100000, default 0)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CANON_READ_MAX_LIMIT,
                    "description": format!("Optional page size limit (1..={CANON_READ_MAX_LIMIT}, default {CANON_READ_DEFAULT_LIMIT})")
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
            use crate::canon::commands_core::canon_query_episodes_impl;

            let parsed = parse_canon_episodes_args(args)?;
            let app = ctx.app()?.clone();
            let project_path = ctx.project_path().await?;

            let state = app.state::<CanonCommandState>();
            let response = canon_query_episodes_impl(
                &state,
                project_path,
                parsed.chapter_number,
                parsed.offset,
                parsed.limit,
            )
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

/// 严格校验并归一化工具入参：
/// - 必须是 JSON object；
/// - 拒绝未知键（即使值为 `null`）；
/// - 拒绝必填字段设为显式 `null`；
/// - 剥离可选字段上的显式 `null`（便于容错某些 JSON Schema 客户端为可选字段发送 `null`）。
fn normalize_strict_object_args(
    args: &Value,
    tool: &str,
    allowed_fields: &[&str],
    required_fields: &[&str],
) -> Result<serde_json::Map<String, Value>, ToolError> {
    let object = args
        .as_object()
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 参数必须是 object")))?;
    let mut normalized = serde_json::Map::with_capacity(object.len());
    for (field, value) in object {
        if !allowed_fields.contains(&field.as_str()) {
            return Err(ToolError::invalid_params(format!(
                "{tool}: 未知参数 `{field}`"
            )));
        }
        if value.is_null() {
            if required_fields.contains(&field.as_str()) {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: 必填参数 `{field}` 不接受 null"
                )));
            }
            continue;
        }
        normalized.insert(field.clone(), value.clone());
    }
    Ok(normalized)
}

/// 严格校验 ASCII 标识符（如 `draftId` / `prepareId`）：1..=128 个 ASCII `[a-zA-Z0-9_-]` 字符。
fn validate_ascii_id<'a>(raw: &'a str, tool: &str, field: &str) -> Result<&'a str, ToolError> {
    if raw.is_empty()
        || raw.len() > DRAFT_ID_MAX_LEN
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 必须是 1..={DRAFT_ID_MAX_LEN} 个 ASCII [a-zA-Z0-9_-] 字符"
        )));
    }
    Ok(raw)
}

/// 严格校验 `draftId`：1..=128 个 ASCII `[a-zA-Z0-9_-]` 字符。
fn validate_draft_id<'a>(raw: &'a str, tool: &str) -> Result<&'a str, ToolError> {
    validate_ascii_id(raw, tool, "draftId")
}

/// 严格校验 64 位 ASCII 十六进制 SHA-256 摘要，并归一化为小写。
fn validate_sha256_hex(raw: &str, tool: &str, field: &str) -> Result<String, ToolError> {
    if raw.len() != 64 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 必须是 64 位 ASCII 十六进制 SHA-256 字符串"
        )));
    }
    Ok(raw.to_ascii_lowercase())
}

/// 严格校验单行非空字符串（长度在 `min_chars..=max_chars`，trim 后非空，禁止任何控制字符）。
fn validate_single_line_str<'a>(
    raw: &'a str,
    tool: &str,
    field: &str,
    min_chars: usize,
    max_chars: usize,
) -> Result<&'a str, ToolError> {
    let char_len = raw.chars().count();
    if char_len < min_chars
        || char_len > max_chars
        || raw.trim().is_empty()
        || raw.chars().any(char::is_control)
    {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 必须是 {min_chars}..={max_chars} 字符的非空单行字符串，且不得包含控制字符"
        )));
    }
    Ok(raw)
}

/// 严格校验允许换行但禁止 `\0` NUL 字节的非空字符串。
fn validate_multiline_no_nul<'a>(
    raw: &'a str,
    tool: &str,
    field: &str,
    min_chars: usize,
    max_chars: usize,
) -> Result<&'a str, ToolError> {
    let char_len = raw.chars().count();
    if char_len < min_chars || char_len > max_chars || raw.trim().is_empty() || raw.contains('\0') {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 必须是 {min_chars}..={max_chars} 字符的非空字符串，且不得包含 NUL 字节"
        )));
    }
    Ok(raw)
}

/// 取可选枚举字符串参数。
fn optional_enum_str(
    args: &Value,
    tool: &str,
    field: &str,
    allowed: &[&'static str],
) -> Result<Option<&'static str>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let raw = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!(
                    "{tool}: `{field}` 只接受 {}，收到 {v}",
                    allowed.join(" / ")
                ))
            })?;
            let matched = allowed.iter().copied().find(|a| *a == raw).ok_or_else(|| {
                ToolError::invalid_params(format!(
                    "{tool}: `{field}` 只接受 {}，收到 {raw}",
                    allowed.join(" / ")
                ))
            })?;
            Ok(Some(matched))
        }
    }
}

/// 取可选有限浮点参数（落在 `min..=max` 闭区间）。
fn optional_finite_f64_in_range(
    args: &Value,
    tool: &str,
    field: &str,
    min: f64,
    max: f64,
) -> Result<Option<f64>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() && (min..=max).contains(&n) => Ok(Some(n)),
            _ => Err(ToolError::invalid_params(format!(
                "{tool}: `{field}` 必须是 {min}..={max} 的有限数字，收到 {v}"
            ))),
        },
    }
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
    normalize_strict_object_args(args, "draft.list", &[], &[])?;
    Ok(StateQuery::new("draft-list"))
}

fn build_draft_read_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "draft.read";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["draftId", "offset", "limit"],
        &["draftId"],
    )?);
    let draft_id = normalized
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `draftId`")))?;
    let draft_id = validate_draft_id(draft_id, tool)?;
    let offset = optional_int_in_range(&normalized, tool, "offset", 0, u64::MAX)?.unwrap_or(0);
    let limit = optional_int_in_range(&normalized, tool, "limit", 1, DRAFT_READ_MAX_LIMIT)?
        .unwrap_or(DRAFT_READ_DEFAULT_LIMIT);
    Ok(StateQuery::new("draft-read").with_params(json!({
        "draftId": draft_id,
        "offset": offset,
        "limit": limit,
    })))
}

fn build_rules_get_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "rules.get";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["sections", "compact"],
        &[],
    )?);
    let sections: Vec<&'static str> = match normalized.get("sections") {
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
    let mut params = json!({ "sections": sections });
    if let Some(compact) = optional_bool(&normalized, tool, "compact")? {
        params["compact"] = json!(compact);
    }
    Ok(StateQuery::new("rules-get").with_params(params))
}

fn build_gate_check_mechanical_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "gate.check_mechanical";
    let object = normalize_strict_object_args(
        args,
        tool,
        &["draftId", "chapter", "text", "chapterNumber", "detailLevel"],
        &[],
    )?;
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

    if let Some(v) = object.get("detailLevel") {
        let level = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!(
                "{tool}: `detailLevel` 只接受 compact / full，收到 {v}"
            ))
        })?;
        if !matches!(level, "compact" | "full") {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `detailLevel` 只接受 compact / full，收到 {level}"
            )));
        }
        params["detailLevel"] = json!(level);
    }

    let normalized = Value::Object(object);
    if let Some(chapter_number) =
        optional_int_in_range(&normalized, tool, "chapterNumber", 1, u64::MAX)?
    {
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
        "Read active writing rules and planning guidance for the current project. Optional `sections` filters any subset of [writingStyle, antiAi, bookRules, planning] (default: all four); optional `compact` returns condensed rule summaries. Read-only, zero LLM calls."
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
                },
                "compact": {
                    "type": "boolean",
                    "description": "When true, return condensed rule summaries optimized for low-token prompt injection"
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
        "Run deterministic zero-LLM mechanical gate checks covering P0 Continuity preflight + BookRules + P1 Anti-AI patterns and word/line metrics on exactly one of `draftId`, `chapter`, or raw `text`. When passing raw `text`, include `chapterNumber` to activate P0 Continuity preflight checks. Optional `detailLevel` (`compact` | `full`) controls verbosity. Read-only; never modifies chapters, drafts, or memory."
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
                    "description": "Raw chapter text to check mechanically (mutually exclusive with draftId and chapter; include chapterNumber to activate P0 Continuity preflight)"
                },
                "chapterNumber": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional 1-based chapter number; strongly recommended when passing raw `text` to activate P0 Continuity preflight"
                },
                "detailLevel": {
                    "type": "string",
                    "enum": ["compact", "full"],
                    "description": "Optional output verbosity: \"compact\" (concise summary/top findings) or \"full\" (complete diagnostic payload)"
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
const CONTEXT_PREPARE_PAGE_MAX: u64 = 10_000;
/// JS `Number.MAX_SAFE_INTEGER`（2^53 - 1），避免透传到 WebView JSON 时发生双精度截断。
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn build_context_prepare_write_params(args: &Value) -> Result<Value, ToolError> {
    let tool = "context.prepare_write";
    let object = normalize_strict_object_args(
        args,
        tool,
        &[
            "prepareId",
            "targetChapter",
            "draftId",
            "task",
            "includePack",
            "includeDraft",
            "includePlanningView",
            "dimension",
            "allowRetrievalNetwork",
            "retrievalMode",
            "offset",
            "page",
            "limit",
        ],
        &[],
    )?;
    let normalized = Value::Object(object);

    let mut params = json!({});

    if let Some(v) = normalized.get("prepareId") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `prepareId` 必须是字符串，收到 {v}"))
        })?;
        let prepare_id = validate_ascii_id(raw, tool, "prepareId")?;
        params["prepareId"] = json!(prepare_id);
    }

    if let Some(target_chapter) =
        optional_int_in_range(&normalized, tool, "targetChapter", 1, JS_MAX_SAFE_INTEGER)?
    {
        params["targetChapter"] = json!(target_chapter);
    }

    if let Some(v) = normalized.get("draftId") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `draftId` 必须是字符串，收到 {v}"))
        })?;
        let draft_id = validate_draft_id(raw, tool)?;
        params["draftId"] = json!(draft_id);
    }

    if let Some(v) = normalized.get("task") {
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
        if let Some(flag) = optional_bool(&normalized, tool, field)? {
            params[field] = json!(flag);
        }
    }

    if let Some(v) = normalized.get("dimension") {
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

    let retrieval_mode = match normalized.get("retrievalMode") {
        None => None,
        Some(v) => {
            let mode = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!(
                    "{tool}: `retrievalMode` 只接受 local_only / configured_network，收到 {v}"
                ))
            })?;
            if !matches!(mode, "local_only" | "configured_network") {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `retrievalMode` 只接受 local_only / configured_network，收到 {mode}"
                )));
            }
            Some(mode)
        }
    };
    let allow_retrieval_network = optional_bool(&normalized, tool, "allowRetrievalNetwork")?;

    if matches!(
        (retrieval_mode, allow_retrieval_network),
        (Some("local_only"), Some(true)) | (Some("configured_network"), Some(false))
    ) {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `retrievalMode={}` 与 `allowRetrievalNetwork={}` 冲突",
            retrieval_mode.unwrap_or(""),
            allow_retrieval_network.unwrap_or(false)
        )));
    }

    if let Some(flag) = allow_retrieval_network {
        params["allowRetrievalNetwork"] = json!(flag);
    }
    if let Some(mode) = retrieval_mode {
        params["retrievalMode"] = json!(mode);
    }

    let explicit_offset =
        optional_int_in_range(&normalized, tool, "offset", 0, JS_MAX_SAFE_INTEGER)?;
    let page = optional_int_in_range(&normalized, tool, "page", 1, CONTEXT_PREPARE_PAGE_MAX)?;
    let limit = optional_int_in_range(&normalized, tool, "limit", 1, CONTEXT_PREPARE_LIMIT_MAX)?
        .unwrap_or(CONTEXT_PREPARE_DEFAULT_LIMIT);

    if explicit_offset.is_some() && page.is_some() {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `offset` 与 `page` 互斥，不能同时传入"
        )));
    }

    if let Some(p) = page {
        let computed = (p - 1).checked_mul(limit);
        if computed.is_none_or(|off| off > JS_MAX_SAFE_INTEGER) {
            return Err(ToolError::invalid_params(format!(
                "{tool}: (`page` - 1) * `limit` 超出安全整数范围"
            )));
        }
        params["page"] = json!(p);
    } else {
        params["offset"] = json!(explicit_offset.unwrap_or(0));
    }
    params["limit"] = json!(limit);

    Ok(params)
}

fn build_director_check_query(args: &Value) -> Result<StateQuery, ToolError> {
    normalize_strict_object_args(args, "director.check", &[], &[])?;
    Ok(StateQuery::new("director-check"))
}

/// `context.prepare_write` —— 为下一章写作准备只读上下文包与规划视图（零 LLM 调用）。
///
/// 复用共享异步桥轮询机制（`context-prepare-start` / `context-prepare-poll`），
/// 默认不隐式出网；`dimension` 不在 Rust 侧列举枚举，
/// 统一由前端真源 `SIX_REVIEW_DIMENSION_ORDER` 校验。
pub struct ContextPrepareWriteTool;

impl super::registry::McpTool for ContextPrepareWriteTool {
    fn name(&self) -> &'static str {
        "context.prepare_write"
    }

    fn description(&self) -> &'static str {
        "Assemble read-only writing preparation context (effective config, planning view, optional draft snippet, optional ContextPack/dimension prompt for thrill, consistency, pacing, character, continuity, pull) for the target chapter or draft. Supports `prepareId` snapshot reuse across pages/dimensions without rebuilding, plus 1-based `page` pagination (mutually exclusive with `offset`). Zero LLM calls; supports retrievalMode (`local_only` | `configured_network`) and explicit allowRetrievalNetwork opt-in (refuses network retrieval by default). Never modifies chapters, drafts, memory, or settings."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prepareId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Optional opaque snapshot ID returned by a prior context.prepare_write call for zero-rebuild pagination or dimension lookup"
                },
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
                    "description": "Optional six-dimension review key (thrill, consistency, pacing, character, continuity, pull), validated in the WebView against SIX_REVIEW_DIMENSION_ORDER"
                },
                "allowRetrievalNetwork": {
                    "type": "boolean",
                    "description": "Explicit opt-in for network embedding/rerank retrieval when building a pack (default false)"
                },
                "retrievalMode": {
                    "type": "string",
                    "enum": ["local_only", "configured_network"],
                    "description": "Optional retrieval network policy: \"local_only\" (zero outbound network calls) or \"configured_network\" (allow configured remote retrieval)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": JS_MAX_SAFE_INTEGER,
                    "description": "0-based character offset for paged output (default 0; mutually exclusive with `page`)"
                },
                "page": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CONTEXT_PREPARE_PAGE_MAX,
                    "description": "Optional 1-based page number (1..=10000; mutually exclusive with `offset`)"
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

// ── Phase 2 Zero-LLM 只读工具（workflow.next / foreshadowing.list / character.read / outline.read / style.exemplars / chapter.search）──

const FORESHADOWING_STATUS_ENUM: [&str; 7] = [
    "all",
    "active",
    "planted",
    "advanced",
    "resolved",
    "abandoned",
    "overdue",
];
const FORESHADOWING_DEBT_LEVEL_ENUM: [&str; 3] = ["critical", "warning", "normal"];
const ATOMIC_READ_MAX_CHAPTER: u64 = 100_000;
const ATOMIC_READ_MAX_OFFSET: u64 = 100_000;
const OUTLINE_READ_MAX_OFFSET: u64 = 10_000_000;
const FORESHADOWING_LIST_MAX_LIMIT: u64 = 100;
const CHARACTER_READ_MAX_LIMIT: u64 = 100;
const OUTLINE_READ_MAX_WINDOW: u64 = 10;
const OUTLINE_READ_MAX_VOLUME: u64 = 1_000;
const OUTLINE_READ_FILE_MAX_LIMIT: u64 = 50_000;
const OUTLINE_READ_CHAPTER_MAX_LIMIT: u64 = 200;
const STYLE_EXEMPLARS_MARK_TYPES: [&str; 6] =
    ["style", "voice", "pacing", "thrill", "pull", "consistency"];
const STYLE_EXEMPLARS_MAX_TOP_K: u64 = 50;
const STYLE_EXEMPLARS_MIN_CHARS_PER_ITEM: u64 = 100;
const STYLE_EXEMPLARS_MAX_CHARS_PER_ITEM: u64 = 4_000;
const STYLE_EXEMPLARS_MAX_LIMIT: u64 = 50;
const CHAPTER_SEARCH_SCOPE_ENUM: [&str; 6] = [
    "chapters", "all", "entities", "outlines", "memory", "drafts",
];
const CHAPTER_SEARCH_MAX_QUERY_CHARS: usize = 256;
const CHAPTER_SEARCH_MAX_LIMIT: u64 = 50;
const CHAPTER_SEARCH_MIN_CONTEXT_CHARS: u64 = 40;
const CHAPTER_SEARCH_MAX_CONTEXT_CHARS: u64 = 400;
const DRAFT_DIFF_MAX_CONTEXT_LINES: u64 = 10;
const DRAFT_DIFF_MAX_HUNKS: u64 = 200;
const DRAFT_DIFF_MIN_MAX_CHARS: u64 = 500;
const DRAFT_DIFF_MAX_MAX_CHARS: u64 = 50_000;
const AUDIT_LONGFORM_HEALTH_SECTIONS: [&str; 5] = [
    "foreshadowing",
    "chaseDebt",
    "emotion",
    "drafts",
    "canonRisk",
];
const AUDIT_LONGFORM_HEALTH_MAX_TOP_K: u64 = 50;
const AUDIT_LONGFORM_HEALTH_MIN_BREAKER: f64 = -10.0;
const AUDIT_LONGFORM_HEALTH_MAX_BREAKER: f64 = 0.0;

fn build_workflow_next_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "workflow.next";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["targetChapter", "draftId"],
        &[],
    )?);
    let mut params = json!({});
    if let Some(target_chapter) =
        optional_int_in_range(&normalized, tool, "targetChapter", 1, JS_MAX_SAFE_INTEGER)?
    {
        params["targetChapter"] = json!(target_chapter);
    }
    if let Some(v) = normalized.get("draftId") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `draftId` 必须是字符串，收到 {v}"))
        })?;
        let draft_id = validate_draft_id(raw, tool)?;
        params["draftId"] = json!(draft_id);
    }
    Ok(StateQuery::new("workflow-next").with_params(params))
}

/// `workflow.next` —— 基于 `control-kernel.route` 的确定性下一步工作流路由（零 LLM、零磁盘写）。
pub struct WorkflowNextTool;

impl super::registry::McpTool for WorkflowNextTool {
    fn name(&self) -> &'static str {
        "workflow.next"
    }

    fn description(&self) -> &'static str {
        "Deterministic next-step workflow router powered by control-kernel.route (zero LLM, zero disk writes). Inspects .novel/status.json, director gates, and pending drafts to recommend the next canonical action and MCP tool sequence."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": JS_MAX_SAFE_INTEGER,
                    "description": "Optional 1-based target chapter number for routing context"
                },
                "draftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Optional draft ID to focus routing on"
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
            let query = build_workflow_next_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_foreshadowing_list_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "foreshadowing.list";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "status",
            "character",
            "currentChapter",
            "includeDebt",
            "debtLevel",
            "offset",
            "limit",
        ],
        &[],
    )?);
    let mut params = json!({});
    if let Some(status) =
        optional_enum_str(&normalized, tool, "status", &FORESHADOWING_STATUS_ENUM)?
    {
        params["status"] = json!(status);
    }
    if let Some(v) = normalized.get("character") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `character` 必须是字符串，收到 {v}"))
        })?;
        let character = validate_single_line_str(raw, tool, "character", 1, 128)?;
        params["character"] = json!(character);
    }
    if let Some(ch) = optional_int_in_range(
        &normalized,
        tool,
        "currentChapter",
        1,
        ATOMIC_READ_MAX_CHAPTER,
    )? {
        params["currentChapter"] = json!(ch);
    }
    if let Some(flag) = optional_bool(&normalized, tool, "includeDebt")? {
        params["includeDebt"] = json!(flag);
    }
    if let Some(level) = optional_enum_str(
        &normalized,
        tool,
        "debtLevel",
        &FORESHADOWING_DEBT_LEVEL_ENUM,
    )? {
        params["debtLevel"] = json!(level);
    }
    if let Some(offset) =
        optional_int_in_range(&normalized, tool, "offset", 0, ATOMIC_READ_MAX_OFFSET)?
    {
        params["offset"] = json!(offset);
    }
    if let Some(limit) =
        optional_int_in_range(&normalized, tool, "limit", 1, FORESHADOWING_LIST_MAX_LIMIT)?
    {
        params["limit"] = json!(limit);
    }
    Ok(StateQuery::new("foreshadowing-list").with_params(params))
}

/// `foreshadowing.list` —— 只读查询项目伏笔账本与伏笔债（零 LLM 调用）。
pub struct ForeshadowingListTool;

impl super::registry::McpTool for ForeshadowingListTool {
    fn name(&self) -> &'static str {
        "foreshadowing.list"
    }

    fn description(&self) -> &'static str {
        "Read-only query of the project's foreshadowing ledger (planted, advanced, resolved, abandoned, overdue threads and optional foreshadowing debt). Zero LLM calls; never modifies project files."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": FORESHADOWING_STATUS_ENUM,
                    "description": "Filter by thread lifecycle status"
                },
                "character": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "Optional character name filter (single-line, no control chars)"
                },
                "currentChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional reference chapter number for overdue and debt calculations (1..=100000)"
                },
                "includeDebt": {
                    "type": "boolean",
                    "description": "Whether to compute and include foreshadowing debt summary"
                },
                "debtLevel": {
                    "type": "string",
                    "enum": FORESHADOWING_DEBT_LEVEL_ENUM,
                    "description": "Optional debt severity filter (critical | warning | normal)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": ATOMIC_READ_MAX_OFFSET,
                    "description": "0-based item offset (0..=100000)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": FORESHADOWING_LIST_MAX_LIMIT,
                    "description": "Maximum items to return (1..=100)"
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
            let query = build_foreshadowing_list_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_character_read_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "character.read";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "name",
            "query",
            "aliveOnly",
            "includeAura",
            "includeState",
            "includeRelationships",
            "offset",
            "limit",
        ],
        &[],
    )?);
    let mut params = json!({});
    if let Some(v) = normalized.get("name") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `name` 必须是字符串，收到 {v}"))
        })?;
        let name = validate_single_line_str(raw, tool, "name", 1, 128)?;
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `name` 不得包含 `/`、`\\` 或 `..`"
            )));
        }
        params["name"] = json!(name);
    }
    if let Some(v) = normalized.get("query") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `query` 必须是字符串，收到 {v}"))
        })?;
        let q = validate_single_line_str(raw, tool, "query", 1, 128)?;
        params["query"] = json!(q);
    }
    for field in [
        "aliveOnly",
        "includeAura",
        "includeState",
        "includeRelationships",
    ] {
        if let Some(flag) = optional_bool(&normalized, tool, field)? {
            params[field] = json!(flag);
        }
    }
    if let Some(offset) =
        optional_int_in_range(&normalized, tool, "offset", 0, ATOMIC_READ_MAX_OFFSET)?
    {
        params["offset"] = json!(offset);
    }
    if let Some(limit) =
        optional_int_in_range(&normalized, tool, "limit", 1, CHARACTER_READ_MAX_LIMIT)?
    {
        params["limit"] = json!(limit);
    }
    Ok(StateQuery::new("character-read").with_params(params))
}

/// `character.read` —— 只读读取角色档案、状态、光环与关系（零 LLM 调用）。
pub struct CharacterReadTool;

impl super::registry::McpTool for CharacterReadTool {
    fn name(&self) -> &'static str {
        "character.read"
    }

    fn description(&self) -> &'static str {
        "Read-only query of character entity cards, optional character state, aura/traits, and relationship edges. Zero LLM calls; never modifies character files or ledgers."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "Optional exact character name (single-line, no control chars, no /, \\, or ..)"
                },
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "Optional keyword filter across character names and summaries"
                },
                "aliveOnly": {
                    "type": "boolean",
                    "description": "When true, filter to alive characters only"
                },
                "includeAura": {
                    "type": "boolean",
                    "description": "Whether to include character aura / personality traits"
                },
                "includeState": {
                    "type": "boolean",
                    "description": "Whether to include latest character state snapshot"
                },
                "includeRelationships": {
                    "type": "boolean",
                    "description": "Whether to include character relationship edges"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": ATOMIC_READ_MAX_OFFSET,
                    "description": "0-based item offset (0..=100000)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CHARACTER_READ_MAX_LIMIT,
                    "description": "Maximum characters to return (1..=100)"
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
            let query = build_character_read_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_outline_read_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "outline.read";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "chapterNumber",
            "window",
            "volume",
            "filename",
            "includeSummaryOnly",
            "offset",
            "limit",
        ],
        &[],
    )?);
    let chapter_number = optional_int_in_range(
        &normalized,
        tool,
        "chapterNumber",
        1,
        ATOMIC_READ_MAX_CHAPTER,
    )?;
    let window = optional_int_in_range(&normalized, tool, "window", 0, OUTLINE_READ_MAX_WINDOW)?;
    let volume = optional_int_in_range(&normalized, tool, "volume", 1, OUTLINE_READ_MAX_VOLUME)?;
    let filename = match normalized.get("filename") {
        None => None,
        Some(v) => {
            let raw = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `filename` 必须是字符串，收到 {v}"))
            })?;
            Some(validate_outline_filename(raw, tool)?)
        }
    };
    if filename.is_some() && (chapter_number.is_some() || volume.is_some() || window.is_some()) {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `filename` 与 `chapterNumber` / `volume` / `window` 互斥，不能同时传入"
        )));
    }
    if window.is_some() && chapter_number.is_none() {
        return Err(ToolError::invalid_params(format!(
            "{tool}: window requires chapterNumber"
        )));
    }

    let max_limit = if filename.is_some() {
        OUTLINE_READ_FILE_MAX_LIMIT
    } else {
        OUTLINE_READ_CHAPTER_MAX_LIMIT
    };

    let mut params = json!({});
    if let Some(ch) = chapter_number {
        params["chapterNumber"] = json!(ch);
    }
    if let Some(w) = window {
        params["window"] = json!(w);
    }
    if let Some(vol) = volume {
        params["volume"] = json!(vol);
    }
    if let Some(f) = filename {
        params["filename"] = json!(f);
    }
    if let Some(flag) = optional_bool(&normalized, tool, "includeSummaryOnly")? {
        params["includeSummaryOnly"] = json!(flag);
    }
    if let Some(offset) =
        optional_int_in_range(&normalized, tool, "offset", 0, OUTLINE_READ_MAX_OFFSET)?
    {
        params["offset"] = json!(offset);
    }
    if let Some(limit) = optional_int_in_range(&normalized, tool, "limit", 1, max_limit)? {
        params["limit"] = json!(limit);
    }
    Ok(StateQuery::new("outline-read").with_params(params))
}

/// `outline.read` —— 只读读取大纲文档或按章/卷切片（零 LLM 调用）。
pub struct OutlineReadTool;

impl super::registry::McpTool for OutlineReadTool {
    fn name(&self) -> &'static str {
        "outline.read"
    }

    fn description(&self) -> &'static str {
        "Read-only query of project outlines under wiki/outlines/ by chapter window, volume, or safe single-segment .md filename (mutually exclusive with chapterNumber, volume, and window). Zero LLM calls; never modifies outline files."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "chapterNumber": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional 1-based chapter number (1..=100000) to slice outline around (mutually exclusive with filename)"
                },
                "window": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": OUTLINE_READ_MAX_WINDOW,
                    "description": "Optional +/- chapter window around chapterNumber (0..=10; requires chapterNumber and conflicts with filename)"
                },
                "volume": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": OUTLINE_READ_MAX_VOLUME,
                    "description": "Optional 1-based volume number (1..=1000; mutually exclusive with filename)"
                },
                "filename": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": OUTLINE_WRITE_MAX_FILENAME_CHARS,
                    "description": "Optional safe single-segment .md filename under wiki/outlines/ (mutually exclusive with chapterNumber, volume, and window)"
                },
                "includeSummaryOnly": {
                    "type": "boolean",
                    "description": "When true, return condensed outline summary metadata only"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": OUTLINE_READ_MAX_OFFSET,
                    "description": "0-based offset (0..=10000000; character offset in filename mode, chapter entry offset in chapterNumber/volume/overview modes)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": OUTLINE_READ_FILE_MAX_LIMIT,
                    "description": "Maximum payload size: 1..=50000 characters in filename mode; 1..=200 chapter entries in chapterNumber/volume/overview modes"
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
            let query = build_outline_read_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_style_exemplars_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "style.exemplars";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "markTypes",
            "category",
            "chapterId",
            "topK",
            "maxCharsPerItem",
            "offset",
            "limit",
        ],
        &[],
    )?);
    let mut params = json!({});
    if let Some(v) = normalized.get("markTypes") {
        let arr = v.as_array().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `markTypes` 必须是非空数组"))
        })?;
        if arr.is_empty() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `markTypes` 不能为空数组"
            )));
        }
        if arr.len() > STYLE_EXEMPLARS_MARK_TYPES.len() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `markTypes` 最多包含 {} 项，收到 {}",
                STYLE_EXEMPLARS_MARK_TYPES.len(),
                arr.len()
            )));
        }
        let mut deduped = Vec::with_capacity(arr.len());
        let mut seen = HashSet::with_capacity(arr.len());
        for (idx, item) in arr.iter().enumerate() {
            let raw = item.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!(
                    "{tool}: `markTypes[{idx}]` 必须是字符串，收到 {item}"
                ))
            })?;
            let matched = STYLE_EXEMPLARS_MARK_TYPES
                .iter()
                .copied()
                .find(|allowed| *allowed == raw)
                .ok_or_else(|| {
                    ToolError::invalid_params(format!(
                        "{tool}: `markTypes[{idx}]` 只接受 {}，收到 {raw}",
                        STYLE_EXEMPLARS_MARK_TYPES.join(" / ")
                    ))
                })?;
            if seen.insert(matched) {
                deduped.push(matched);
            }
        }
        params["markTypes"] = json!(deduped);
    }
    if let Some(v) = normalized.get("category") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `category` 必须是字符串，收到 {v}"))
        })?;
        let category = validate_single_line_str(raw, tool, "category", 1, 128)?;
        params["category"] = json!(category);
    }
    if let Some(v) = normalized.get("chapterId") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `chapterId` 必须是字符串，收到 {v}"))
        })?;
        let chapter_id = validate_single_line_str(raw, tool, "chapterId", 1, 128)?;
        params["chapterId"] = json!(chapter_id);
    }
    if let Some(top_k) =
        optional_int_in_range(&normalized, tool, "topK", 1, STYLE_EXEMPLARS_MAX_TOP_K)?
    {
        params["topK"] = json!(top_k);
    }
    if let Some(max_chars) = optional_int_in_range(
        &normalized,
        tool,
        "maxCharsPerItem",
        STYLE_EXEMPLARS_MIN_CHARS_PER_ITEM,
        STYLE_EXEMPLARS_MAX_CHARS_PER_ITEM,
    )? {
        params["maxCharsPerItem"] = json!(max_chars);
    }
    if let Some(offset) =
        optional_int_in_range(&normalized, tool, "offset", 0, ATOMIC_READ_MAX_OFFSET)?
    {
        params["offset"] = json!(offset);
    }
    if let Some(limit) =
        optional_int_in_range(&normalized, tool, "limit", 1, STYLE_EXEMPLARS_MAX_LIMIT)?
    {
        params["limit"] = json!(limit);
    }
    Ok(StateQuery::new("style-exemplars").with_params(params))
}

/// `style.exemplars` —— 只读检索作者风格范例与标定片段（零 LLM 调用）。
pub struct StyleExemplarsTool;

impl super::registry::McpTool for StyleExemplarsTool {
    fn name(&self) -> &'static str {
        "style.exemplars"
    }

    fn description(&self) -> &'static str {
        "Read-only retrieval of curated author style exemplars and prose marks filtered by markTypes, category, or chapterId. Zero LLM calls; never modifies style stores or chapters."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "markTypes": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": STYLE_EXEMPLARS_MARK_TYPES.len(),
                    "uniqueItems": true,
                    "items": {
                        "type": "string",
                        "enum": STYLE_EXEMPLARS_MARK_TYPES
                    },
                    "description": "Optional subset of mark types: style, voice, pacing, thrill, pull, consistency"
                },
                "category": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "Optional exemplar category filter (single-line, no control chars)"
                },
                "chapterId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "Optional source chapter identifier filter (single-line, no control chars)"
                },
                "topK": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": STYLE_EXEMPLARS_MAX_TOP_K,
                    "description": "Optional top-K exemplar count (1..=50)"
                },
                "maxCharsPerItem": {
                    "type": "integer",
                    "minimum": STYLE_EXEMPLARS_MIN_CHARS_PER_ITEM,
                    "maximum": STYLE_EXEMPLARS_MAX_CHARS_PER_ITEM,
                    "description": "Optional max excerpt length per exemplar (100..=4000)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": ATOMIC_READ_MAX_OFFSET,
                    "description": "0-based item offset (0..=100000)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": STYLE_EXEMPLARS_MAX_LIMIT,
                    "description": "Maximum items to return (1..=50)"
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
            let query = build_style_exemplars_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_chapter_search_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "chapter.search";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "query",
            "scope",
            "chapterStart",
            "chapterEnd",
            "limit",
            "contextChars",
        ],
        &["query"],
    )?);
    let query_raw = normalized
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `query`")))?;
    let query_str =
        validate_single_line_str(query_raw, tool, "query", 1, CHAPTER_SEARCH_MAX_QUERY_CHARS)?;

    let chapter_start = optional_int_in_range(
        &normalized,
        tool,
        "chapterStart",
        1,
        ATOMIC_READ_MAX_CHAPTER,
    )?;
    let chapter_end =
        optional_int_in_range(&normalized, tool, "chapterEnd", 1, ATOMIC_READ_MAX_CHAPTER)?;
    if let (Some(start), Some(end)) = (chapter_start, chapter_end) {
        if start > end {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `chapterStart` ({start}) 不能大于 `chapterEnd` ({end})"
            )));
        }
    }

    let mut params = json!({ "query": query_str });
    if let Some(scope) = optional_enum_str(&normalized, tool, "scope", &CHAPTER_SEARCH_SCOPE_ENUM)?
    {
        params["scope"] = json!(scope);
    }
    if let Some(start) = chapter_start {
        params["chapterStart"] = json!(start);
    }
    if let Some(end) = chapter_end {
        params["chapterEnd"] = json!(end);
    }
    if let Some(limit) =
        optional_int_in_range(&normalized, tool, "limit", 1, CHAPTER_SEARCH_MAX_LIMIT)?
    {
        params["limit"] = json!(limit);
    }
    if let Some(ctx_chars) = optional_int_in_range(
        &normalized,
        tool,
        "contextChars",
        CHAPTER_SEARCH_MIN_CONTEXT_CHARS,
        CHAPTER_SEARCH_MAX_CONTEXT_CHARS,
    )? {
        params["contextChars"] = json!(ctx_chars);
    }
    Ok(StateQuery::new("chapter-search").with_params(params))
}

/// `chapter.search` —— 跨章节/实体/大纲/记忆/草稿的只读全文检索（零 LLM 调用）。
pub struct ChapterSearchTool;

impl super::registry::McpTool for ChapterSearchTool {
    fn name(&self) -> &'static str {
        "chapter.search"
    }

    fn description(&self) -> &'static str {
        "Read-only full-text search across project chapters (or entities, outlines, memory, drafts, or all scopes) with optional chapter range and context snippets. Zero LLM calls; never modifies project files."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": CHAPTER_SEARCH_MAX_QUERY_CHARS,
                    "description": "Required search query (1..=256 chars, non-empty single-line, no control chars)"
                },
                "scope": {
                    "type": "string",
                    "enum": CHAPTER_SEARCH_SCOPE_ENUM,
                    "description": "Search scope: chapters | all | entities | outlines | memory | drafts"
                },
                "chapterStart": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional inclusive 1-based start chapter number (1..=100000)"
                },
                "chapterEnd": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional inclusive 1-based end chapter number (1..=100000; >= chapterStart when both given)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": CHAPTER_SEARCH_MAX_LIMIT,
                    "description": "Maximum matches to return (1..=50)"
                },
                "contextChars": {
                    "type": "integer",
                    "minimum": CHAPTER_SEARCH_MIN_CONTEXT_CHARS,
                    "maximum": CHAPTER_SEARCH_MAX_CONTEXT_CHARS,
                    "description": "Context snippet window around each hit in characters (40..=400)"
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            let query = build_chapter_search_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_draft_diff_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "draft.diff";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "baseDraftId",
            "targetDraftId",
            "draftId",
            "chapterNumber",
            "compareToFormal",
            "contextLines",
            "maxHunks",
            "maxChars",
        ],
        &[],
    )?);

    let base_draft_id = match normalized.get("baseDraftId") {
        None => None,
        Some(v) => {
            let raw = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `baseDraftId` 必须是字符串，收到 {v}"))
            })?;
            Some(validate_ascii_id(raw, tool, "baseDraftId")?)
        }
    };
    let target_draft_id = match normalized.get("targetDraftId") {
        None => None,
        Some(v) => {
            let raw = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `targetDraftId` 必须是字符串，收到 {v}"))
            })?;
            Some(validate_ascii_id(raw, tool, "targetDraftId")?)
        }
    };
    let draft_id = match normalized.get("draftId") {
        None => None,
        Some(v) => {
            let raw = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `draftId` 必须是字符串，收到 {v}"))
            })?;
            Some(validate_ascii_id(raw, tool, "draftId")?)
        }
    };
    let chapter_number = optional_int_in_range(
        &normalized,
        tool,
        "chapterNumber",
        1,
        ATOMIC_READ_MAX_CHAPTER,
    )?;
    let compare_to_formal = optional_bool(&normalized, tool, "compareToFormal")?;
    let context_lines = optional_int_in_range(
        &normalized,
        tool,
        "contextLines",
        0,
        DRAFT_DIFF_MAX_CONTEXT_LINES,
    )?;
    let max_hunks = optional_int_in_range(&normalized, tool, "maxHunks", 1, DRAFT_DIFF_MAX_HUNKS)?;
    let max_chars = optional_int_in_range(
        &normalized,
        tool,
        "maxChars",
        DRAFT_DIFF_MIN_MAX_CHARS,
        DRAFT_DIFF_MAX_MAX_CHARS,
    )?;

    let mut params = json!({});
    if base_draft_id.is_some() || target_draft_id.is_some() {
        let (Some(base), Some(target)) = (base_draft_id, target_draft_id) else {
            return Err(ToolError::invalid_params(format!(
                "{tool}: 草稿对比模式必须同时提供 `baseDraftId` 与 `targetDraftId`"
            )));
        };
        if draft_id.is_some() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `baseDraftId`/`targetDraftId` 与 `draftId` 互斥"
            )));
        }
        if chapter_number.is_some() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `baseDraftId`/`targetDraftId` 模式下不得传入 `chapterNumber`"
            )));
        }
        if compare_to_formal == Some(true) {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `baseDraftId`/`targetDraftId` 模式下不得设置 `compareToFormal: true`"
            )));
        }
        params["baseDraftId"] = json!(base);
        params["targetDraftId"] = json!(target);
        if compare_to_formal == Some(false) {
            params["compareToFormal"] = json!(false);
        }
    } else if let Some(draft) = draft_id {
        if compare_to_formal == Some(false) {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `draftId` 与正式章对比模式下不得设置 `compareToFormal: false`"
            )));
        }
        params["draftId"] = json!(draft);
        params["compareToFormal"] = json!(true);
        if let Some(ch) = chapter_number {
            params["chapterNumber"] = json!(ch);
        }
    } else {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 必须提供 `baseDraftId`+`targetDraftId`（双草稿对比）或 `draftId`（草稿与正式章对比）"
        )));
    }

    if let Some(lines) = context_lines {
        params["contextLines"] = json!(lines);
    }
    if let Some(hunks) = max_hunks {
        params["maxHunks"] = json!(hunks);
    }
    if let Some(chars) = max_chars {
        params["maxChars"] = json!(chars);
    }

    Ok(StateQuery::new("draft-diff").with_params(params))
}

/// `draft.diff` —— 零 LLM、只读行级草稿差异比对（草稿 vs 草稿，或草稿 vs 正式章）。
pub struct DraftDiffTool;

impl super::registry::McpTool for DraftDiffTool {
    fn name(&self) -> &'static str {
        "draft.diff"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM read-only Myers line-level diff between two drafts (baseDraftId + targetDraftId) or between a draft and its formal chapter (draftId with optional chapterNumber). Returns bounded unified hunks, line stats, and SHA-256 digests without modifying files."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "baseDraftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Base draft ID for draft-vs-draft comparison (must be paired with targetDraftId; mutually exclusive with draftId/chapterNumber/compareToFormal=true)"
                },
                "targetDraftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Target draft ID for draft-vs-draft comparison (must be paired with baseDraftId)"
                },
                "draftId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "pattern": "^[a-zA-Z0-9_-]{1,128}$",
                    "description": "Draft ID to compare against the corresponding formal chapter (mutually exclusive with baseDraftId/targetDraftId/compareToFormal=false)"
                },
                "chapterNumber": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional 1-based formal chapter number override when using draftId mode (1..=100000)"
                },
                "compareToFormal": {
                    "type": "boolean",
                    "description": "Explicitly select draft-vs-formal (true, with draftId) or draft-vs-draft (false, with baseDraftId+targetDraftId)"
                },
                "contextLines": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": DRAFT_DIFF_MAX_CONTEXT_LINES,
                    "description": "Context lines around each diff hunk (0..=10, default 2)"
                },
                "maxHunks": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": DRAFT_DIFF_MAX_HUNKS,
                    "description": "Maximum unified diff hunks to return (1..=200, default 50)"
                },
                "maxChars": {
                    "type": "integer",
                    "minimum": DRAFT_DIFF_MIN_MAX_CHARS,
                    "maximum": DRAFT_DIFF_MAX_MAX_CHARS,
                    "description": "Maximum serialized diff character budget (500..=50000, default 16000)"
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
            let query = build_draft_diff_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_audit_longform_health_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "audit.longform_health";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "currentChapter",
            "chapterStart",
            "chapterEnd",
            "volume",
            "sections",
            "topK",
            "includeDetails",
            "emotionBreakerThreshold",
        ],
        &[],
    )?);

    let current_chapter = optional_int_in_range(
        &normalized,
        tool,
        "currentChapter",
        1,
        ATOMIC_READ_MAX_CHAPTER,
    )?;
    let chapter_start = optional_int_in_range(
        &normalized,
        tool,
        "chapterStart",
        1,
        ATOMIC_READ_MAX_CHAPTER,
    )?;
    let chapter_end =
        optional_int_in_range(&normalized, tool, "chapterEnd", 1, ATOMIC_READ_MAX_CHAPTER)?;
    let volume = optional_int_in_range(&normalized, tool, "volume", 1, OUTLINE_READ_MAX_VOLUME)?;

    if volume.is_some() && (chapter_start.is_some() || chapter_end.is_some()) {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `volume` 与 `chapterStart`/`chapterEnd` 互斥"
        )));
    }
    if let (Some(start), Some(end)) = (chapter_start, chapter_end) {
        if start > end {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `chapterStart` ({start}) 不能大于 `chapterEnd` ({end})"
            )));
        }
    }

    let mut params = json!({});
    if let Some(ch) = current_chapter {
        params["currentChapter"] = json!(ch);
    }
    if let Some(start) = chapter_start {
        params["chapterStart"] = json!(start);
    }
    if let Some(end) = chapter_end {
        params["chapterEnd"] = json!(end);
    }
    if let Some(vol) = volume {
        params["volume"] = json!(vol);
    }
    if let Some(v) = normalized.get("sections") {
        let arr = v.as_array().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `sections` 必须是非空数组"))
        })?;
        if arr.is_empty() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `sections` 不能为空数组"
            )));
        }
        if arr.len() > AUDIT_LONGFORM_HEALTH_SECTIONS.len() {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `sections` 最多包含 {} 项，收到 {}",
                AUDIT_LONGFORM_HEALTH_SECTIONS.len(),
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
            let matched = AUDIT_LONGFORM_HEALTH_SECTIONS
                .iter()
                .copied()
                .find(|allowed| *allowed == raw)
                .ok_or_else(|| {
                    ToolError::invalid_params(format!(
                        "{tool}: `sections[{idx}]` 只接受 {}，收到 {raw}",
                        AUDIT_LONGFORM_HEALTH_SECTIONS.join(" / ")
                    ))
                })?;
            if seen.insert(matched) {
                deduped.push(matched);
            }
        }
        params["sections"] = json!(deduped);
    }
    if let Some(top_k) = optional_int_in_range(
        &normalized,
        tool,
        "topK",
        1,
        AUDIT_LONGFORM_HEALTH_MAX_TOP_K,
    )? {
        params["topK"] = json!(top_k);
    }
    if let Some(details) = optional_bool(&normalized, tool, "includeDetails")? {
        params["includeDetails"] = json!(details);
    }
    if let Some(threshold) = optional_finite_f64_in_range(
        &normalized,
        tool,
        "emotionBreakerThreshold",
        AUDIT_LONGFORM_HEALTH_MIN_BREAKER,
        AUDIT_LONGFORM_HEALTH_MAX_BREAKER,
    )? {
        let normalized_threshold = if threshold == 0.0 { 0.0 } else { threshold };
        params["emotionBreakerThreshold"] = json!(normalized_threshold);
    }

    Ok(StateQuery::new("audit-longform-health").with_params(params))
}

/// `audit.longform_health` —— 零 LLM、只读长篇健康诊断（伏笔债 / 追读债 / 情绪熔断 / 草稿队列 / 正典风险）。
pub struct AuditLongformHealthTool;

impl super::registry::McpTool for AuditLongformHealthTool {
    fn name(&self) -> &'static str {
        "audit.longform_health"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM read-only long-form novel health audit aggregating foreshadowing debt, chase/subplot debt, emotion circuit-breaker trends, pending draft queue status, and deterministic P0 canon risks across a book, volume, or chapter window. Never writes to disk."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "currentChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional 1-based reference chapter number for overdue debt calculation (1..=100000)"
                },
                "chapterStart": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional inclusive 1-based window start chapter (1..=100000; mutually exclusive with volume; <= chapterEnd)"
                },
                "chapterEnd": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": ATOMIC_READ_MAX_CHAPTER,
                    "description": "Optional inclusive 1-based window end chapter (1..=100000; mutually exclusive with volume)"
                },
                "volume": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": OUTLINE_READ_MAX_VOLUME,
                    "description": "Optional 1-based volume number filter (1..=1000; mutually exclusive with chapterStart/chapterEnd)"
                },
                "sections": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": AUDIT_LONGFORM_HEALTH_SECTIONS.len(),
                    "uniqueItems": true,
                    "items": {
                        "type": "string",
                        "enum": AUDIT_LONGFORM_HEALTH_SECTIONS
                    },
                    "description": "Optional subset of diagnostic sections: foreshadowing, chaseDebt, emotion, drafts, canonRisk (default all 5)"
                },
                "topK": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": AUDIT_LONGFORM_HEALTH_MAX_TOP_K,
                    "description": "Maximum top findings per section (1..=50, default 10)"
                },
                "includeDetails": {
                    "type": "boolean",
                    "description": "Include per-item diagnostic details alongside aggregate counters (default false)"
                },
                "emotionBreakerThreshold": {
                    "type": "number",
                    "minimum": AUDIT_LONGFORM_HEALTH_MIN_BREAKER,
                    "maximum": AUDIT_LONGFORM_HEALTH_MAX_BREAKER,
                    "description": "Finite emotion circuit-breaker threshold in [-10.0, 0.0] (default -0.6)"
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
            let query = build_audit_longform_health_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

// ── Zero-LLM 只读技能目录与按需水合工具（skills.list / skills.get）───────────

const SKILLS_STAGE_VALUES: [&str; 9] = [
    "planning", "drafting", "review", "rewrite", "output", "outline", "writing", "summary",
    "extract",
];
const SKILLS_KIND_VALUES: [&str; 3] = ["writing", "de_ai", "all"];
const SKILLS_MAX_QUERY_CHARS: usize = 200;
const SKILLS_MAX_SELECTOR_ITEMS: usize = 20;
const SKILLS_DEFAULT_PAGE_LIMIT: u64 = 50;
const SKILLS_MAX_PAGE_LIMIT: u64 = 200;
const SKILLS_MAX_OFFSET: u64 = 100_000;
const SKILLS_MIN_MAX_CHARS_PER_SKILL: u64 = 200;
const SKILLS_DEFAULT_MAX_CHARS_PER_SKILL: u64 = 6_000;
const SKILLS_MAX_MAX_CHARS_PER_SKILL: u64 = 20_000;
const SKILLS_MIN_MAX_TOTAL_CHARS: u64 = 500;
const SKILLS_DEFAULT_MAX_TOTAL_CHARS: u64 = 18_000;
const SKILLS_MAX_MAX_TOTAL_CHARS: u64 = 30_000;

fn parse_optional_skill_selector_array(
    args: &Value,
    tool: &str,
    field: &str,
) -> Result<Option<Vec<String>>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let arr = v.as_array().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `{field}` 必须是非空字符串数组"))
            })?;
            if arr.is_empty() {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `{field}` 不能为空数组"
                )));
            }
            if arr.len() > SKILLS_MAX_SELECTOR_ITEMS {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `{field}` 最多允许 {SKILLS_MAX_SELECTOR_ITEMS} 项，收到 {}",
                    arr.len()
                )));
            }
            let mut deduped = Vec::with_capacity(arr.len());
            let mut seen = HashSet::with_capacity(arr.len());
            for (idx, item) in arr.iter().enumerate() {
                let raw = item.as_str().ok_or_else(|| {
                    ToolError::invalid_params(format!(
                        "{tool}: `{field}[{idx}]` 必须是字符串，收到 {item}"
                    ))
                })?;
                let valid = validate_single_line_str(raw, tool, field, 1, SKILLS_MAX_QUERY_CHARS)?;
                let trimmed = valid.trim().to_string();
                if seen.insert(trimmed.clone()) {
                    deduped.push(trimmed);
                }
            }
            Ok(Some(deduped))
        }
    }
}

fn build_skills_list_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "skills.list";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "stage",
            "kind",
            "includeDeAi",
            "includeBuiltin",
            "enabledOnly",
            "query",
            "offset",
            "limit",
        ],
        &[],
    )?);

    let mut params = json!({});
    if let Some(stage) = optional_enum_str(&normalized, tool, "stage", &SKILLS_STAGE_VALUES)? {
        params["stage"] = json!(stage);
    }
    if let Some(kind) = optional_enum_str(&normalized, tool, "kind", &SKILLS_KIND_VALUES)? {
        params["kind"] = json!(kind);
    }
    if let Some(include_de_ai) = optional_bool(&normalized, tool, "includeDeAi")? {
        params["includeDeAi"] = json!(include_de_ai);
    }
    if let Some(include_builtin) = optional_bool(&normalized, tool, "includeBuiltin")? {
        params["includeBuiltin"] = json!(include_builtin);
    }
    if let Some(enabled_only) = optional_bool(&normalized, tool, "enabledOnly")? {
        params["enabledOnly"] = json!(enabled_only);
    }
    if let Some(v) = normalized.get("query") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `query` 必须是字符串，收到 {v}"))
        })?;
        let valid = validate_single_line_str(raw, tool, "query", 1, SKILLS_MAX_QUERY_CHARS)?;
        params["query"] = json!(valid.trim());
    }
    if let Some(offset) = optional_int_in_range(&normalized, tool, "offset", 0, SKILLS_MAX_OFFSET)?
    {
        params["offset"] = json!(offset);
    }
    if let Some(limit) =
        optional_int_in_range(&normalized, tool, "limit", 1, SKILLS_MAX_PAGE_LIMIT)?
    {
        params["limit"] = json!(limit);
    }

    Ok(StateQuery::new("skills-list").with_params(params))
}

/// `skills.list` —— 严格只读、零 LLM 技能目录浏览（仅返回元数据与字符数，不返回正文）。
pub struct SkillsListTool;

impl super::registry::McpTool for SkillsListTool {
    fn name(&self) -> &'static str {
        "skills.list"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM read-only catalog listing for built-in + project writing and De-AI skills (returns lightweight metadata, stage mappings, and contentChars without skill bodies). Never writes to disk."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "stage": {
                    "type": "string",
                    "enum": SKILLS_STAGE_VALUES,
                    "description": "Optional stage or task-key filter: planning, drafting, review, rewrite, output, outline, writing, summary, extract"
                },
                "kind": {
                    "type": "string",
                    "enum": SKILLS_KIND_VALUES,
                    "description": "Optional skill library filter: writing, de_ai, or all (default all)"
                },
                "includeDeAi": {
                    "type": "boolean",
                    "description": "Include De-AI skills in the catalog (default true)"
                },
                "includeBuiltin": {
                    "type": "boolean",
                    "description": "Include built-in skills alongside project-custom skills (default true)"
                },
                "enabledOnly": {
                    "type": "boolean",
                    "description": "Return only currently enabled skills (default false)"
                },
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": SKILLS_MAX_QUERY_CHARS,
                    "description": "Optional single-line keyword filter matching id, name, description, or tags (1..=200 chars)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": SKILLS_MAX_OFFSET,
                    "description": "Optional pagination offset (0..=100000, default 0)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": SKILLS_MAX_PAGE_LIMIT,
                    "description": format!("Optional page size limit (1..={SKILLS_MAX_PAGE_LIMIT}, default {SKILLS_DEFAULT_PAGE_LIMIT})")
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
            let query = build_skills_list_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_skills_get_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "skills.get";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "ids",
            "names",
            "stage",
            "includeDeAi",
            "includeDisabled",
            "stripFrontmatter",
            "maxCharsPerSkill",
            "maxTotalChars",
        ],
        &[],
    )?);

    let ids = parse_optional_skill_selector_array(&normalized, tool, "ids")?;
    let names = parse_optional_skill_selector_array(&normalized, tool, "names")?;
    let stage = optional_enum_str(&normalized, tool, "stage", &SKILLS_STAGE_VALUES)?;

    if ids.is_none() && names.is_none() && stage.is_none() {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 至少需要提供 `ids`、`names` 或 `stage` 之一"
        )));
    }

    let mut params = json!({});
    if let Some(ids) = ids {
        params["ids"] = json!(ids);
    }
    if let Some(names) = names {
        params["names"] = json!(names);
    }
    if let Some(stage) = stage {
        params["stage"] = json!(stage);
    }
    if let Some(include_de_ai) = optional_bool(&normalized, tool, "includeDeAi")? {
        params["includeDeAi"] = json!(include_de_ai);
    }
    if let Some(include_disabled) = optional_bool(&normalized, tool, "includeDisabled")? {
        params["includeDisabled"] = json!(include_disabled);
    }
    if let Some(strip_frontmatter) = optional_bool(&normalized, tool, "stripFrontmatter")? {
        params["stripFrontmatter"] = json!(strip_frontmatter);
    }
    if let Some(max_chars_per_skill) = optional_int_in_range(
        &normalized,
        tool,
        "maxCharsPerSkill",
        SKILLS_MIN_MAX_CHARS_PER_SKILL,
        SKILLS_MAX_MAX_CHARS_PER_SKILL,
    )? {
        params["maxCharsPerSkill"] = json!(max_chars_per_skill);
    }
    if let Some(max_total_chars) = optional_int_in_range(
        &normalized,
        tool,
        "maxTotalChars",
        SKILLS_MIN_MAX_TOTAL_CHARS,
        SKILLS_MAX_MAX_TOTAL_CHARS,
    )? {
        params["maxTotalChars"] = json!(max_total_chars);
    }

    Ok(StateQuery::new("skills-get").with_params(params))
}

/// `skills.get` —— 严格只读、零 LLM 按需水合技能正文（强制至少传 `ids`/`names`/`stage` 之一）。
pub struct SkillsGetTool;

impl super::registry::McpTool for SkillsGetTool {
    fn name(&self) -> &'static str {
        "skills.get"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM read-only on-demand hydration of writing/De-AI skill bodies by ids, names, or stage (at least one selector required), with YAML frontmatter stripping and strict per-skill / total character budgets. Never writes to disk."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ids": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": SKILLS_MAX_SELECTOR_ITEMS,
                    "uniqueItems": true,
                    "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": SKILLS_MAX_QUERY_CHARS
                    },
                    "description": "Optional list of 1..=20 skill IDs to hydrate (at least one of ids, names, or stage is required)"
                },
                "names": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": SKILLS_MAX_SELECTOR_ITEMS,
                    "uniqueItems": true,
                    "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": SKILLS_MAX_QUERY_CHARS
                    },
                    "description": "Optional list of 1..=20 skill names to hydrate (at least one of ids, names, or stage is required)"
                },
                "stage": {
                    "type": "string",
                    "enum": SKILLS_STAGE_VALUES,
                    "description": "Optional stage or task-key selector to hydrate enabled skills (at least one of ids, names, or stage is required)"
                },
                "includeDeAi": {
                    "type": "boolean",
                    "description": "Include De-AI skills when resolving selectors (default true)"
                },
                "includeDisabled": {
                    "type": "boolean",
                    "description": "Include disabled skills instead of skipping them into disabledSkipped (default false)"
                },
                "stripFrontmatter": {
                    "type": "boolean",
                    "description": "Strip YAML frontmatter from returned skill bodies (default true)"
                },
                "maxCharsPerSkill": {
                    "type": "integer",
                    "minimum": SKILLS_MIN_MAX_CHARS_PER_SKILL,
                    "maximum": SKILLS_MAX_MAX_CHARS_PER_SKILL,
                    "description": format!("Per-skill body character budget ({SKILLS_MIN_MAX_CHARS_PER_SKILL}..={SKILLS_MAX_MAX_CHARS_PER_SKILL}, default {SKILLS_DEFAULT_MAX_CHARS_PER_SKILL})")
                },
                "maxTotalChars": {
                    "type": "integer",
                    "minimum": SKILLS_MIN_MAX_TOTAL_CHARS,
                    "maximum": SKILLS_MAX_MAX_TOTAL_CHARS,
                    "description": format!("Cumulative body character budget across returned skills ({SKILLS_MIN_MAX_TOTAL_CHARS}..={SKILLS_MAX_MAX_TOTAL_CHARS}, default {SKILLS_DEFAULT_MAX_TOTAL_CHARS})")
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
            let query = build_skills_get_query(args)?;
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

const DRAFT_PATCH_MAX_EDITS: usize = 25;
const DRAFT_PATCH_MAX_TOTAL_CHARS: usize = 100_000;
const DRAFT_PATCH_MAX_OCCURRENCE: u64 = 1_000;
const DRAFT_PATCH_MAX_LINE: u64 = 1_000_000;
const DRAFT_PATCH_MAX_NOTE_CHARS: usize = 1_000;

fn build_draft_patch_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "draft.patch";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["draftId", "expectedSha256", "edits", "note"],
        &["draftId", "expectedSha256", "edits"],
    )?);

    let draft_id_raw = normalized
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `draftId`")))?;
    let draft_id = validate_draft_id(draft_id_raw, tool)?;

    let sha_raw = normalized
        .get("expectedSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `expectedSha256`"))
        })?;
    let expected_sha256 = validate_sha256_hex(sha_raw, tool, "expectedSha256")?;

    let edits_arr = normalized
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `edits` 必须是非空数组")))?;
    if edits_arr.is_empty() || edits_arr.len() > DRAFT_PATCH_MAX_EDITS {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `edits` 长度必须在 1..={DRAFT_PATCH_MAX_EDITS} 之间，收到 {}",
            edits_arr.len()
        )));
    }

    let mut normalized_edits = Vec::with_capacity(edits_arr.len());
    let mut total_chars: usize = 0;

    for (idx, item) in edits_arr.iter().enumerate() {
        let obj = item.as_object().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `edits[{idx}]` 必须是 object"))
        })?;
        for key in obj.keys() {
            if !matches!(
                key.as_str(),
                "find" | "replace" | "occurrence" | "startLine" | "endLine" | "replacement"
            ) {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `edits[{idx}]` 包含未知字段 `{key}`"
                )));
            }
        }

        let has_find_family = obj.contains_key("find")
            || obj.contains_key("replace")
            || obj.contains_key("occurrence");
        let has_line_family = obj.contains_key("startLine")
            || obj.contains_key("endLine")
            || obj.contains_key("replacement");

        if has_find_family && has_line_family {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `edits[{idx}]` 不能混用 find/replace 与 startLine/endLine/replacement"
            )));
        }
        if !has_find_family && !has_line_family {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `edits[{idx}]` 必须提供 find/replace 或 startLine/endLine/replacement"
            )));
        }

        let item_label = format!("{tool}.edits[{idx}]");
        if has_find_family {
            let clean = Value::Object(normalize_strict_object_args(
                item,
                &item_label,
                &["find", "replace", "occurrence"],
                &["find", "replace"],
            )?);
            let find = clean.get("find").and_then(Value::as_str).ok_or_else(|| {
                ToolError::invalid_params(format!("{item_label}: 缺少字符串参数 `find`"))
            })?;
            if find.is_empty() {
                return Err(ToolError::invalid_params(format!(
                    "{item_label}: `find` 不能为空字符串"
                )));
            }
            if find.contains('\0') {
                return Err(ToolError::invalid_params(format!(
                    "{item_label}: `find` 不得包含 NUL 字节"
                )));
            }
            let replace = clean
                .get("replace")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::invalid_params(format!("{item_label}: 缺少字符串参数 `replace`"))
                })?;
            if replace.contains('\0') {
                return Err(ToolError::invalid_params(format!(
                    "{item_label}: `replace` 不得包含 NUL 字节"
                )));
            }
            let occurrence = optional_int_in_range(
                &clean,
                &item_label,
                "occurrence",
                1,
                DRAFT_PATCH_MAX_OCCURRENCE,
            )?;

            total_chars = total_chars
                .saturating_add(find.chars().count())
                .saturating_add(replace.chars().count());
            if total_chars > DRAFT_PATCH_MAX_TOTAL_CHARS {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: 所有 edits 的 find/replace/replacement 总字符数不能超过 {DRAFT_PATCH_MAX_TOTAL_CHARS}"
                )));
            }

            let mut edit_val = json!({
                "find": find,
                "replace": replace,
            });
            if let Some(occ) = occurrence {
                edit_val["occurrence"] = json!(occ);
            }
            normalized_edits.push(edit_val);
        } else {
            let clean = Value::Object(normalize_strict_object_args(
                item,
                &item_label,
                &["startLine", "endLine", "replacement"],
                &["startLine", "endLine", "replacement"],
            )?);
            let start_line =
                optional_int_in_range(&clean, &item_label, "startLine", 1, DRAFT_PATCH_MAX_LINE)?
                    .ok_or_else(|| {
                    ToolError::invalid_params(format!("{item_label}: 缺少整数参数 `startLine`"))
                })?;
            let end_line =
                optional_int_in_range(&clean, &item_label, "endLine", 1, DRAFT_PATCH_MAX_LINE)?
                    .ok_or_else(|| {
                        ToolError::invalid_params(format!("{item_label}: 缺少整数参数 `endLine`"))
                    })?;
            if end_line < start_line {
                return Err(ToolError::invalid_params(format!(
                    "{item_label}: `endLine` ({end_line}) 不能小于 `startLine` ({start_line})"
                )));
            }
            let replacement = clean
                .get("replacement")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::invalid_params(format!("{item_label}: 缺少字符串参数 `replacement`"))
                })?;
            if replacement.contains('\0') {
                return Err(ToolError::invalid_params(format!(
                    "{item_label}: `replacement` 不得包含 NUL 字节"
                )));
            }

            total_chars = total_chars.saturating_add(replacement.chars().count());
            if total_chars > DRAFT_PATCH_MAX_TOTAL_CHARS {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: 所有 edits 的 find/replace/replacement 总字符数不能超过 {DRAFT_PATCH_MAX_TOTAL_CHARS}"
                )));
            }

            normalized_edits.push(json!({
                "startLine": start_line,
                "endLine": end_line,
                "replacement": replacement,
            }));
        }
    }

    let mut params = json!({
        "draftId": draft_id,
        "expectedSha256": expected_sha256,
        "edits": normalized_edits,
    });

    if let Some(v) = normalized.get("note") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `note` 必须是字符串，收到 {v}"))
        })?;
        let note = validate_multiline_no_nul(raw, tool, "note", 1, DRAFT_PATCH_MAX_NOTE_CHARS)?;
        params["note"] = json!(note);
    }

    Ok(StateQuery::new("draft-patch").with_params(params))
}

/// `draft.patch` —— 基于乐观锁与硬熔断的手术式草稿修订（Draft-first，绝不写正式章节）。
pub struct DraftPatchTool;

impl super::registry::McpTool for DraftPatchTool {
    fn name(&self) -> &'static str {
        "draft.patch"
    }

    fn description(&self) -> &'static str {
        "Apply 1..=25 surgical edits to an existing chapter draft in .qm-drafts/ using optimistic concurrency (`expectedSha256` must match `draft.read` `bodySha256`). Each edit is either substring `{find, replace, occurrence?}` or 1-based inclusive line range `{startLine, endLine, replacement}`. Enforces HARD_FUSE_LIMIT = 5 (`revisionRound`) and preserves `parentDraftId`. Draft-first and zero LLM calls: writes ONLY to .qm-drafts/, NEVER writes formal chapters or accepts drafts."
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
                    "description": "Target draft ID in .qm-drafts/"
                },
                "expectedSha256": {
                    "type": "string",
                    "minLength": 64,
                    "maxLength": 64,
                    "pattern": "^[0-9a-fA-F]{64}$",
                    "description": "64-char hex SHA-256 matching `draft.read` `bodySha256` (optimistic concurrency lock)"
                },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": DRAFT_PATCH_MAX_EDITS,
                    "description": "1..=25 ordered surgical edits (total chars across find/replace/replacement <= 100000); each item is either {find, replace, occurrence?} or 1-based inclusive {startLine, endLine, replacement}",
                    "items": {
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "find": { "type": "string", "minLength": 1 },
                                    "replace": { "type": "string" },
                                    "occurrence": { "type": "integer", "minimum": 1, "maximum": DRAFT_PATCH_MAX_OCCURRENCE }
                                },
                                "required": ["find", "replace"],
                                "additionalProperties": false
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "startLine": { "type": "integer", "minimum": 1, "maximum": DRAFT_PATCH_MAX_LINE },
                                    "endLine": { "type": "integer", "minimum": 1, "maximum": DRAFT_PATCH_MAX_LINE },
                                    "replacement": { "type": "string" }
                                },
                                "required": ["startLine", "endLine", "replacement"],
                                "additionalProperties": false
                            }
                        ]
                    }
                },
                "note": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_PATCH_MAX_NOTE_CHARS,
                    "description": "Optional non-empty revision note (max 1000 chars, no NUL bytes)"
                }
            },
            "required": ["draftId", "expectedSha256", "edits"],
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
            let query = build_draft_patch_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

const DRAFT_REVIEW_HARD_GATE_ENUM: [&str; 3] = ["pass", "fail", "not_evaluated"];
const DRAFT_REVIEW_QUALITY_GATE_ENUM: [&str; 4] = ["pass", "fail", "warning", "not_evaluated"];
const DRAFT_REVIEW_MAX_DIMENSIONS: usize = 12;
const DRAFT_REVIEW_MAX_DIMENSION_KEY_CHARS: usize = 64;
const DRAFT_REVIEW_MAX_SUMMARY_CHARS: usize = 4_000;
const DRAFT_REVIEW_MAX_BLOCKING_ISSUES: usize = 50;
const DRAFT_REVIEW_MAX_ISSUE_CHARS: usize = 1_000;
const DRAFT_REVIEW_MAX_ROLE_CHARS: usize = 64;

fn build_draft_record_review_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "draft.record_review";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "draftId",
            "expectedSha256",
            "gates",
            "overallScore",
            "dimensionScores",
            "summary",
            "blockingIssues",
            "reviewerRole",
            "autoArmEnabled",
        ],
        &["draftId", "expectedSha256", "gates"],
    )?);

    let draft_id_raw = normalized
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `draftId`")))?;
    let draft_id = validate_draft_id(draft_id_raw, tool)?;

    let sha_raw = normalized
        .get("expectedSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `expectedSha256`"))
        })?;
    let expected_sha256 = validate_sha256_hex(sha_raw, tool, "expectedSha256")?;

    let gates_raw = normalized
        .get("gates")
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少 object 参数 `gates`")))?;
    let gates_obj = Value::Object(normalize_strict_object_args(
        gates_raw,
        "draft.record_review.gates",
        &["consistency", "anti_ai", "quality"],
        &["consistency", "anti_ai"],
    )?);

    let consistency = optional_enum_str(
        &gates_obj,
        "draft.record_review.gates",
        "consistency",
        &DRAFT_REVIEW_HARD_GATE_ENUM,
    )?
    .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `gates.consistency` 为必填枚举")))?;
    let anti_ai = optional_enum_str(
        &gates_obj,
        "draft.record_review.gates",
        "anti_ai",
        &DRAFT_REVIEW_HARD_GATE_ENUM,
    )?
    .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `gates.anti_ai` 为必填枚举")))?;
    let quality = optional_enum_str(
        &gates_obj,
        "draft.record_review.gates",
        "quality",
        &DRAFT_REVIEW_QUALITY_GATE_ENUM,
    )?;

    let mut gates_out = json!({
        "consistency": consistency,
        "anti_ai": anti_ai,
    });
    if let Some(q) = quality {
        gates_out["quality"] = json!(q);
    }

    let mut params = json!({
        "draftId": draft_id,
        "expectedSha256": expected_sha256,
        "gates": gates_out,
    });

    if let Some(score) = optional_finite_f64_in_range(&normalized, tool, "overallScore", 0.0, 10.0)?
    {
        params["overallScore"] = json!(score);
    }

    if let Some(v) = normalized.get("dimensionScores") {
        let map = v.as_object().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `dimensionScores` 必须是 object"))
        })?;
        if map.len() > DRAFT_REVIEW_MAX_DIMENSIONS {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `dimensionScores` 最多 {DRAFT_REVIEW_MAX_DIMENSIONS} 项，收到 {}",
                map.len()
            )));
        }
        let mut clean_scores = serde_json::Map::with_capacity(map.len());
        for (k, score_val) in map {
            let key = validate_single_line_str(
                k,
                tool,
                "dimensionScores key",
                1,
                DRAFT_REVIEW_MAX_DIMENSION_KEY_CHARS,
            )?;
            let n = score_val.as_f64().ok_or_else(|| {
                ToolError::invalid_params(format!(
                    "{tool}: `dimensionScores[{key}]` 必须是 0.0..=10.0 的有限数字，收到 {score_val}"
                ))
            })?;
            if !n.is_finite() || !(0.0..=10.0).contains(&n) {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `dimensionScores[{key}]` 必须是 0.0..=10.0 的有限数字，收到 {score_val}"
                )));
            }
            clean_scores.insert(key.to_string(), json!(n));
        }
        params["dimensionScores"] = Value::Object(clean_scores);
    }

    if let Some(v) = normalized.get("summary") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `summary` 必须是字符串，收到 {v}"))
        })?;
        let summary =
            validate_multiline_no_nul(raw, tool, "summary", 1, DRAFT_REVIEW_MAX_SUMMARY_CHARS)?;
        params["summary"] = json!(summary);
    }

    if let Some(v) = normalized.get("blockingIssues") {
        let arr = v.as_array().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `blockingIssues` 必须是字符串数组"))
        })?;
        if arr.len() > DRAFT_REVIEW_MAX_BLOCKING_ISSUES {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `blockingIssues` 最多 {DRAFT_REVIEW_MAX_BLOCKING_ISSUES} 项，收到 {}",
                arr.len()
            )));
        }
        let mut clean_issues = Vec::with_capacity(arr.len());
        for (idx, item) in arr.iter().enumerate() {
            let raw = item.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!(
                    "{tool}: `blockingIssues[{idx}]` 必须是字符串，收到 {item}"
                ))
            })?;
            let issue = validate_multiline_no_nul(
                raw,
                tool,
                &format!("blockingIssues[{idx}]"),
                1,
                DRAFT_REVIEW_MAX_ISSUE_CHARS,
            )?;
            clean_issues.push(json!(issue));
        }
        params["blockingIssues"] = Value::Array(clean_issues);
    }

    if let Some(v) = normalized.get("reviewerRole") {
        let raw = v.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `reviewerRole` 必须是字符串，收到 {v}"))
        })?;
        let role =
            validate_single_line_str(raw, tool, "reviewerRole", 1, DRAFT_REVIEW_MAX_ROLE_CHARS)?;
        params["reviewerRole"] = json!(role);
    }

    if let Some(flag) = optional_bool(&normalized, tool, "autoArmEnabled")? {
        params["autoArmEnabled"] = json!(flag);
    }

    Ok(StateQuery::new("draft-record-review").with_params(params))
}

/// `draft.record_review` —— 记录草稿审校结论并在门控通过时最多提升 `pending -> ready`（绝不接受/入库）。
pub struct DraftRecordReviewTool;

impl super::registry::McpTool for DraftRecordReviewTool {
    fn name(&self) -> &'static str {
        "draft.record_review"
    }

    fn description(&self) -> &'static str {
        "Record structured review verdicts and optional six-dimension scores against a draft (`expectedSha256` must match `draft.read` `bodySha256`). Strictly enforces `Consistency(P0) > Anti-AI(P1) > Quality(P2)` (P2 NEVER overrides a P0 failure) and promotes `.novel/status.json` `draft_status` at most `pending -> ready`. Zero LLM calls; NEVER accepts drafts or writes formal chapters/memory."
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
                    "description": "Target draft ID in .qm-drafts/"
                },
                "expectedSha256": {
                    "type": "string",
                    "minLength": 64,
                    "maxLength": 64,
                    "pattern": "^[0-9a-fA-F]{64}$",
                    "description": "64-char hex SHA-256 matching `draft.read` `bodySha256`"
                },
                "gates": {
                    "type": "object",
                    "properties": {
                        "consistency": { "type": "string", "enum": DRAFT_REVIEW_HARD_GATE_ENUM },
                        "anti_ai": { "type": "string", "enum": DRAFT_REVIEW_HARD_GATE_ENUM },
                        "quality": { "type": "string", "enum": DRAFT_REVIEW_QUALITY_GATE_ENUM }
                    },
                    "required": ["consistency", "anti_ai"],
                    "additionalProperties": false,
                    "description": "Gate verdicts enforcing Consistency(P0) > Anti-AI(P1) > Quality(P2)"
                },
                "overallScore": {
                    "type": "number",
                    "minimum": 0.0,
                    "maximum": 10.0,
                    "description": "Optional overall literary quality score (0.0..=10.0)"
                },
                "dimensionScores": {
                    "type": "object",
                    "maxProperties": DRAFT_REVIEW_MAX_DIMENSIONS,
                    "additionalProperties": { "type": "number", "minimum": 0.0, "maximum": 10.0 },
                    "description": "Optional per-dimension score map (<= 12 entries, each 0.0..=10.0; canonical six keys: thrill, consistency, pacing, character, continuity, pull)"
                },
                "summary": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_REVIEW_MAX_SUMMARY_CHARS,
                    "description": "Optional concise review summary (1..=4000 chars, no NUL bytes)"
                },
                "blockingIssues": {
                    "type": "array",
                    "maxItems": DRAFT_REVIEW_MAX_BLOCKING_ISSUES,
                    "items": { "type": "string", "minLength": 1, "maxLength": DRAFT_REVIEW_MAX_ISSUE_CHARS },
                    "description": "Optional list of blocking findings (<= 50 items, each 1..=1000 chars, no NUL bytes)"
                },
                "reviewerRole": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_REVIEW_MAX_ROLE_CHARS,
                    "description": "Optional single-line reviewer persona label (e.g. canon-auditor, literary-critic)"
                },
                "autoArmEnabled": {
                    "type": "boolean",
                    "description": "Optional flag controlling whether passing P0+P1 arms pending -> ready promotion"
                }
            },
            "required": ["draftId", "expectedSha256", "gates"],
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
            let query = build_draft_record_review_query(args)?;
            ctx.bridge_query(query).await
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
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["filename", "content", "syncModel"],
        &["filename", "content"],
    )?);

    let filename_raw = normalized
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: 缺少字符串参数 `filename`")))?;
    let filename = validate_outline_filename(filename_raw, tool)?;

    let content = normalized
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

    let sync_model = optional_bool(&normalized, tool, "syncModel")?.unwrap_or(true);
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

// ── TASK-002：6 个零 LLM 规划/治理写工具（SessionScope::Project）──────────────

const PLANNING_WORLD_LAYERS: [&str; 13] = [
    "axioms",
    "background",
    "geography",
    "cultures",
    "races",
    "magicSystem",
    "politics",
    "technology",
    "economy",
    "religions",
    "history",
    "conflicts",
    "factions",
];
const PLANNING_DIRECTOR_PHASES: [&str; 5] = ["idea", "world", "character", "outline", "chapters"];
const PLANNING_FANFIC_MODES: [&str; 4] = ["canon", "au", "ooc", "cp"];
const PLANNING_FORESHADOWING_STATUSES: [&str; 4] = ["planted", "advanced", "resolved", "abandoned"];
const PLANNING_SUBPLOT_STATUSES: [&str; 4] = ["proposed", "active", "paused", "resolved"];
const PLANNING_MAX_CHAPTER_NUM: u64 = 100_000;
const PLANNING_MAX_VOLUME_NUM: u64 = 1_000;

fn validate_planning_string_array(
    value: &Value,
    tool: &str,
    field: &str,
    max_items: usize,
    max_item_chars: usize,
    single_line: bool,
) -> Result<Vec<String>, ToolError> {
    let arr = value
        .as_array()
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `{field}` 必须是字符串数组")))?;
    if arr.len() > max_items {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 最多 {max_items} 项（收到 {}）",
            arr.len()
        )));
    }
    let mut seen = std::collections::HashSet::with_capacity(arr.len());
    let mut out = Vec::with_capacity(arr.len());
    for (idx, item) in arr.iter().enumerate() {
        let raw = item.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `{field}[{idx}]` 必须是字符串"))
        })?;
        let item_field = format!("{field}[{idx}]");
        if single_line {
            validate_single_line_str(raw, tool, &item_field, 1, max_item_chars)?;
        } else {
            validate_multiline_no_nul(raw, tool, &item_field, 1, max_item_chars)?;
        }
        let trimmed = raw.trim().to_string();
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    }
    Ok(out)
}

fn validate_optional_text_allow_empty(
    args: &Value,
    tool: &str,
    field: &str,
    max_chars: usize,
    single_line: bool,
) -> Result<Option<String>, ToolError> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let raw = v.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `{field}` 必须是字符串"))
            })?;
            let char_len = raw.chars().count();
            if char_len > max_chars || raw.contains('\0') {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `{field}` 长度不能超过 {max_chars} 且不得包含 NUL 字节"
                )));
            }
            if single_line && raw.chars().any(char::is_control) {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `{field}` 不得包含控制字符"
                )));
            }
            Ok(Some(raw.trim().to_string()))
        }
    }
}

fn validate_positive_u64_array(
    value: &Value,
    tool: &str,
    field: &str,
    max_items: usize,
    max_val: u64,
) -> Result<Vec<u64>, ToolError> {
    let arr = value
        .as_array()
        .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `{field}` 必须是整数数组")))?;
    if arr.len() > max_items {
        return Err(ToolError::invalid_params(format!(
            "{tool}: `{field}` 最多 {max_items} 项（收到 {}）",
            arr.len()
        )));
    }
    let mut set = std::collections::BTreeSet::new();
    for (idx, item) in arr.iter().enumerate() {
        match item.as_u64() {
            Some(n) if (1..=max_val).contains(&n) => {
                set.insert(n);
            }
            _ => {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `{field}[{idx}]` 必须是 1..={max_val} 的整数，收到 {item}"
                )));
            }
        }
    }
    Ok(set.into_iter().collect())
}

fn build_director_upsert_world_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "director.upsert_world";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "worldType",
            "mode",
            "layers",
            "crossRefs",
            "deriveFromEntities",
            "fillMissingRequired",
        ],
        &[],
    )?);

    let mut params = serde_json::Map::new();
    let mut has_action = false;

    if let Some(raw_wt) = normalized.get("worldType") {
        let wt = raw_wt
            .as_str()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `worldType` 必须是字符串")))?;
        validate_single_line_str(wt, tool, "worldType", 1, 128)?;
        params.insert("worldType".to_string(), json!(wt.trim()));
        has_action = true;
    }

    if let Some(mode) = optional_enum_str(&normalized, tool, "mode", &["merge", "replace"])? {
        params.insert("mode".to_string(), json!(mode));
    }

    if let Some(raw_layers) = normalized.get("layers") {
        let layer_obj = raw_layers
            .as_object()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `layers` 必须是对象")))?;
        let mut clean_layers = serde_json::Map::new();
        for (layer_name, layer_val) in layer_obj {
            if !PLANNING_WORLD_LAYERS.contains(&layer_name.as_str()) {
                return Err(ToolError::invalid_params(format!(
                    "{tool}: `layers` 包含未知世界层 `{layer_name}`"
                )));
            }
            if layer_val.is_null() {
                continue;
            }
            let entries = validate_planning_string_array(
                layer_val,
                tool,
                &format!("layers.{layer_name}"),
                100,
                2_000,
                false,
            )?;
            clean_layers.insert(layer_name.clone(), json!(entries));
        }
        if !clean_layers.is_empty() {
            params.insert("layers".to_string(), Value::Object(clean_layers));
            has_action = true;
        }
    }

    if let Some(raw_refs) = normalized.get("crossRefs") {
        let refs_arr = raw_refs
            .as_array()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `crossRefs` 必须是数组")))?;
        if refs_arr.len() > 200 {
            return Err(ToolError::invalid_params(format!(
                "{tool}: `crossRefs` 最多 200 项（收到 {}）",
                refs_arr.len()
            )));
        }
        let mut clean_refs = Vec::with_capacity(refs_arr.len());
        for (idx, item) in refs_arr.iter().enumerate() {
            let sub = Value::Object(normalize_strict_object_args(
                item,
                tool,
                &["from", "to", "term"],
                &["from", "to", "term"],
            )?);
            let from = optional_enum_str(&sub, tool, "from", &PLANNING_WORLD_LAYERS)?
                .ok_or_else(|| {
                    ToolError::invalid_params(format!("{tool}: `crossRefs[{idx}].from` 缺失"))
                })?;
            let to = optional_enum_str(&sub, tool, "to", &PLANNING_WORLD_LAYERS)?.ok_or_else(
                || ToolError::invalid_params(format!("{tool}: `crossRefs[{idx}].to` 缺失")),
            )?;
            let term = sub
                .get("term")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::invalid_params(format!(
                        "{tool}: `crossRefs[{idx}].term` 必须是字符串"
                    ))
                })?;
            validate_single_line_str(term, tool, &format!("crossRefs[{idx}].term"), 1, 256)?;
            clean_refs.push(json!({ "from": from, "to": to, "term": term.trim() }));
        }
        params.insert("crossRefs".to_string(), Value::Array(clean_refs));
        has_action = true;
    }

    if let Some(derive) = optional_bool(&normalized, tool, "deriveFromEntities")? {
        params.insert("deriveFromEntities".to_string(), json!(derive));
        if derive {
            has_action = true;
        }
    }
    if let Some(fill) = optional_bool(&normalized, tool, "fillMissingRequired")? {
        params.insert("fillMissingRequired".to_string(), json!(fill));
        if fill {
            has_action = true;
        }
    }

    if !has_action {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 至少需提供 worldType / layers / crossRefs / deriveFromEntities / fillMissingRequired 之一"
        )));
    }

    Ok(StateQuery::new("director-upsert-world").with_params(Value::Object(params)))
}

/// `director.upsert_world` —— 零 LLM 创建/合并/推导世界观骨架（`.novel/world-blueprint.json`）。
pub struct DirectorUpsertWorldTool;

impl super::registry::McpTool for DirectorUpsertWorldTool {
    fn name(&self) -> &'static str {
        "director.upsert_world"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM upsert/merge/replace of .novel/world-blueprint.json (13 world layers + crossRefs). Optionally derives layers from wiki/entities/* and/or deterministically fills missing required layers (axioms, background, geography, cultures, conflicts). Requires Project scope; never mutates formal chapters."
    }

    fn input_schema(&self) -> Value {
        let mut layer_props = serde_json::Map::new();
        for layer in PLANNING_WORLD_LAYERS {
            layer_props.insert(
                layer.to_string(),
                json!({
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 2000 }
                }),
            );
        }
        json!({
            "type": "object",
            "properties": {
                "worldType": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "World genre/type label (e.g. fantasy, 东方玄幻)"
                },
                "mode": {
                    "type": "string",
                    "enum": ["merge", "replace"],
                    "description": "merge (default, dedupe-append) or replace (overwrite supplied layers)"
                },
                "layers": {
                    "type": "object",
                    "properties": Value::Object(layer_props),
                    "additionalProperties": false,
                    "description": "World blueprint layers map (required layers: axioms, background, geography, cultures, conflicts)"
                },
                "crossRefs": {
                    "type": "array",
                    "maxItems": 200,
                    "items": {
                        "type": "object",
                        "properties": {
                            "from": { "type": "string", "enum": PLANNING_WORLD_LAYERS },
                            "to": { "type": "string", "enum": PLANNING_WORLD_LAYERS },
                            "term": { "type": "string", "minLength": 1, "maxLength": 256 }
                        },
                        "required": ["from", "to", "term"],
                        "additionalProperties": false
                    },
                    "description": "Cross-layer term references"
                },
                "deriveFromEntities": {
                    "type": "boolean",
                    "description": "Whether to derive layer seeds from wiki/entities/* before applying layers patch (default false)"
                },
                "fillMissingRequired": {
                    "type": "boolean",
                    "description": "Whether to deterministically seed any still-empty required layers so validation reaches complete (default false)"
                }
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
            let query = build_director_upsert_world_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_director_commit_phase_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "director.commit_phase";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &["idea", "expectedPhase", "retryIfFailed", "persistOnBlocked"],
        &[],
    )?);

    let mut params = serde_json::Map::new();

    if let Some(raw_idea) = normalized.get("idea") {
        let clean_idea_map = normalize_strict_object_args(
            raw_idea,
            tool,
            &["title", "genre", "coreConflict"],
            &[],
        )?;
        let clean_idea_val = Value::Object(clean_idea_map);
        let mut idea_out = serde_json::Map::new();
        if let Some(raw_title) = clean_idea_val.get("title") {
            let title = raw_title.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `idea.title` 必须是字符串"))
            })?;
            validate_single_line_str(title, tool, "idea.title", 1, 200)?;
            idea_out.insert("title".to_string(), json!(title.trim()));
        }
        if let Some(raw_genre) = clean_idea_val.get("genre") {
            let genre = raw_genre.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `idea.genre` 必须是字符串"))
            })?;
            validate_single_line_str(genre, tool, "idea.genre", 1, 128)?;
            idea_out.insert("genre".to_string(), json!(genre.trim()));
        }
        if let Some(raw_conflict) = clean_idea_val.get("coreConflict") {
            let conflict = raw_conflict.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `idea.coreConflict` 必须是字符串"))
            })?;
            validate_multiline_no_nul(conflict, tool, "idea.coreConflict", 1, 2_000)?;
            idea_out.insert("coreConflict".to_string(), json!(conflict.trim()));
        }
        if !idea_out.is_empty() {
            params.insert("idea".to_string(), Value::Object(idea_out));
        }
    }

    if let Some(expected_phase) =
        optional_enum_str(&normalized, tool, "expectedPhase", &PLANNING_DIRECTOR_PHASES)?
    {
        params.insert("expectedPhase".to_string(), json!(expected_phase));
    }

    if let Some(retry) = optional_bool(&normalized, tool, "retryIfFailed")? {
        params.insert("retryIfFailed".to_string(), json!(retry));
    }

    if let Some(persist_blocked) = optional_bool(&normalized, tool, "persistOnBlocked")? {
        params.insert("persistOnBlocked".to_string(), json!(persist_blocked));
    }

    Ok(StateQuery::new("director-commit-phase").with_params(Value::Object(params)))
}

/// `director.commit_phase` —— 零 LLM 导演阶段门核验与提交（绝不绕过阶段门）。
pub struct DirectorCommitPhaseTool;

impl super::registry::McpTool for DirectorCommitPhaseTool {
    fn name(&self) -> &'static str {
        "director.commit_phase"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM deterministic verification and commit of the current director phase (.novel/director-pipeline.json). Evaluates real project artifacts via collectProjectSnapshot + tryAdvanceDirector + assertIrreversible; never bypasses phase gates or mutates formal chapters. Requires Project scope."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "idea": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                        "genre": { "type": "string", "minLength": 1, "maxLength": 128 },
                        "coreConflict": { "type": "string", "minLength": 1, "maxLength": 2000 }
                    },
                    "additionalProperties": false,
                    "description": "Optional idea fields to merge into persisted ideaInput before evaluating phase gates"
                },
                "expectedPhase": {
                    "type": "string",
                    "enum": PLANNING_DIRECTOR_PHASES,
                    "description": "Optional optimistic phase guard (fails if persisted currentPhase differs)"
                },
                "retryIfFailed": {
                    "type": "boolean",
                    "description": "Whether to transition failed->running before evaluating gates (default true)"
                },
                "persistOnBlocked": {
                    "type": "boolean",
                    "description": "Whether to persist failed state/retryCount when blocked by gate (default false)"
                }
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
            let query = build_director_commit_phase_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_rules_upsert_book_rules_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "rules.upsert_book_rules";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "mode",
            "version",
            "prohibitions",
            "allowedDeviations",
            "protagonist",
            "genreLock",
            "eraConstraints",
            "fanficMode",
        ],
        &[],
    )?);

    let mut params = serde_json::Map::new();
    let mode = optional_enum_str(&normalized, tool, "mode", &["merge", "replace"])?
        .unwrap_or("merge");
    if normalized.get("mode").is_some() {
        params.insert("mode".to_string(), json!(mode));
    }

    let mut has_rule_field = false;

    if let Some(raw_ver) = normalized.get("version") {
        let ver = raw_ver
            .as_str()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `version` 必须是字符串")))?;
        validate_single_line_str(ver, tool, "version", 1, 32)?;
        params.insert("version".to_string(), json!(ver.trim()));
        has_rule_field = true;
    }

    if let Some(raw_prohib) = normalized.get("prohibitions") {
        let items =
            validate_planning_string_array(raw_prohib, tool, "prohibitions", 200, 200, true)?;
        params.insert("prohibitions".to_string(), json!(items));
        has_rule_field = true;
    }

    if let Some(raw_dev) = normalized.get("allowedDeviations") {
        let items =
            validate_planning_string_array(raw_dev, tool, "allowedDeviations", 200, 200, true)?;
        params.insert("allowedDeviations".to_string(), json!(items));
        has_rule_field = true;
    }

    if let Some(raw_protag) = normalized.get("protagonist") {
        let sub = Value::Object(normalize_strict_object_args(
            raw_protag,
            tool,
            &["name", "personalityLock", "behavioralConstraints"],
            &["name"],
        )?);
        let name = sub
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `protagonist.name` 必须是字符串"))
            })?;
        validate_single_line_str(name, tool, "protagonist.name", 1, 128)?;
        let mut p_out = serde_json::Map::new();
        p_out.insert("name".to_string(), json!(name.trim()));
        if let Some(pl) = sub.get("personalityLock") {
            let items = validate_planning_string_array(
                pl,
                tool,
                "protagonist.personalityLock",
                100,
                200,
                true,
            )?;
            p_out.insert("personalityLock".to_string(), json!(items));
        }
        if let Some(bc) = sub.get("behavioralConstraints") {
            let items = validate_planning_string_array(
                bc,
                tool,
                "protagonist.behavioralConstraints",
                100,
                200,
                true,
            )?;
            p_out.insert("behavioralConstraints".to_string(), json!(items));
        }
        params.insert("protagonist".to_string(), Value::Object(p_out));
        has_rule_field = true;
    }

    if let Some(raw_gl) = normalized.get("genreLock") {
        let sub = Value::Object(normalize_strict_object_args(
            raw_gl,
            tool,
            &["primary", "forbidden"],
            &["primary"],
        )?);
        let primary = sub
            .get("primary")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `genreLock.primary` 必须是字符串"))
            })?;
        validate_single_line_str(primary, tool, "genreLock.primary", 1, 128)?;
        let mut g_out = serde_json::Map::new();
        g_out.insert("primary".to_string(), json!(primary.trim()));
        if let Some(forb) = sub.get("forbidden") {
            let items = validate_planning_string_array(
                forb,
                tool,
                "genreLock.forbidden",
                100,
                200,
                true,
            )?;
            g_out.insert("forbidden".to_string(), json!(items));
        }
        params.insert("genreLock".to_string(), Value::Object(g_out));
        has_rule_field = true;
    }

    if let Some(raw_era) = normalized.get("eraConstraints") {
        let sub = Value::Object(normalize_strict_object_args(
            raw_era,
            tool,
            &["enabled", "anachronismTerms", "period", "region"],
            &["enabled"],
        )?);
        let enabled = optional_bool(&sub, tool, "enabled")?.ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `eraConstraints.enabled` 必须是 boolean"))
        })?;
        let mut e_out = serde_json::Map::new();
        e_out.insert("enabled".to_string(), json!(enabled));
        if let Some(terms) = sub.get("anachronismTerms") {
            let items = validate_planning_string_array(
                terms,
                tool,
                "eraConstraints.anachronismTerms",
                200,
                200,
                true,
            )?;
            e_out.insert("anachronismTerms".to_string(), json!(items));
        }
        if let Some(raw_period) = sub.get("period") {
            let period = raw_period.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `eraConstraints.period` 必须是字符串"))
            })?;
            validate_single_line_str(period, tool, "eraConstraints.period", 1, 128)?;
            e_out.insert("period".to_string(), json!(period.trim()));
        }
        if let Some(raw_region) = sub.get("region") {
            let region = raw_region.as_str().ok_or_else(|| {
                ToolError::invalid_params(format!("{tool}: `eraConstraints.region` 必须是字符串"))
            })?;
            validate_single_line_str(region, tool, "eraConstraints.region", 1, 128)?;
            e_out.insert("region".to_string(), json!(region.trim()));
        }
        params.insert("eraConstraints".to_string(), Value::Object(e_out));
        has_rule_field = true;
    }

    if let Some(fm) = optional_enum_str(&normalized, tool, "fanficMode", &PLANNING_FANFIC_MODES)? {
        params.insert("fanficMode".to_string(), json!(fm));
        has_rule_field = true;
    }

    if mode == "merge" && !has_rule_field {
        return Err(ToolError::invalid_params(format!(
            "{tool}: merge 模式下至少需提供一个规则字段"
        )));
    }

    Ok(StateQuery::new("rules-upsert-book-rules").with_params(Value::Object(params)))
}

/// `rules.upsert_book_rules` —— 零 LLM 原子写入 `.novel/book-rules.json`。
pub struct RulesUpsertBookRulesTool;

impl super::registry::McpTool for RulesUpsertBookRulesTool {
    fn name(&self) -> &'static str {
        "rules.upsert_book_rules"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM atomic upsert of .novel/book-rules.json (prohibitions, allowedDeviations, protagonist locks, genreLock, eraConstraints, fanficMode). Immediately consumed by mechanical gates and writing context. Requires Project scope; never mutates formal chapters."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["merge", "replace"],
                    "description": "merge (default) or replace full book-rules document"
                },
                "version": { "type": "string", "minLength": 1, "maxLength": 32 },
                "prohibitions": {
                    "type": "array",
                    "maxItems": 200,
                    "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                },
                "allowedDeviations": {
                    "type": "array",
                    "maxItems": 200,
                    "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                },
                "protagonist": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
                        "personalityLock": {
                            "type": "array",
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                        },
                        "behavioralConstraints": {
                            "type": "array",
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                        }
                    },
                    "required": ["name"],
                    "additionalProperties": false
                },
                "genreLock": {
                    "type": "object",
                    "properties": {
                        "primary": { "type": "string", "minLength": 1, "maxLength": 128 },
                        "forbidden": {
                            "type": "array",
                            "maxItems": 100,
                            "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                        }
                    },
                    "required": ["primary"],
                    "additionalProperties": false
                },
                "eraConstraints": {
                    "type": "object",
                    "properties": {
                        "enabled": { "type": "boolean" },
                        "anachronismTerms": {
                            "type": "array",
                            "maxItems": 200,
                            "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                        },
                        "period": { "type": "string", "minLength": 1, "maxLength": 128 },
                        "region": { "type": "string", "minLength": 1, "maxLength": 128 }
                    },
                    "required": ["enabled"],
                    "additionalProperties": false
                },
                "fanficMode": {
                    "type": "string",
                    "enum": PLANNING_FANFIC_MODES
                }
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
            let query = build_rules_upsert_book_rules_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_compass_update_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "compass.update";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "endingDirection",
            "newThreads",
            "resolvedThreads",
            "estimatedScale",
            "declareFinalVolume",
        ],
        &[],
    )?);

    let mut params = serde_json::Map::new();

    if let Some(ending) =
        validate_optional_text_allow_empty(&normalized, tool, "endingDirection", 2_000, false)?
    {
        params.insert("endingDirection".to_string(), json!(ending));
    }
    if let Some(raw_new) = normalized.get("newThreads") {
        let items = validate_planning_string_array(raw_new, tool, "newThreads", 100, 300, true)?;
        params.insert("newThreads".to_string(), json!(items));
    }
    if let Some(raw_res) = normalized.get("resolvedThreads") {
        let items =
            validate_planning_string_array(raw_res, tool, "resolvedThreads", 100, 300, true)?;
        params.insert("resolvedThreads".to_string(), json!(items));
    }
    if let Some(scale) =
        validate_optional_text_allow_empty(&normalized, tool, "estimatedScale", 200, true)?
    {
        params.insert("estimatedScale".to_string(), json!(scale));
    }
    if let Some(vol) = optional_int_in_range(
        &normalized,
        tool,
        "declareFinalVolume",
        1,
        PLANNING_MAX_VOLUME_NUM,
    )? {
        params.insert("declareFinalVolume".to_string(), json!(vol));
    }

    if params.is_empty() {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 至少需提供 endingDirection / newThreads / resolvedThreads / estimatedScale / declareFinalVolume 之一"
        )));
    }

    Ok(StateQuery::new("compass-update").with_params(Value::Object(params)))
}

/// `compass.update` —— 零 LLM 更新长篇滚动规划指南针（`.novel/story-compass.json`）。
pub struct CompassUpdateTool;

impl super::registry::McpTool for CompassUpdateTool {
    fn name(&self) -> &'static str {
        "compass.update"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM update of .novel/story-compass.json (endingDirection, newThreads, resolvedThreads, estimatedScale, declareFinalVolume). Requires Project scope; never mutates formal chapters."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "endingDirection": {
                    "type": "string",
                    "maxLength": 2000,
                    "description": "Thematic ending direction"
                },
                "newThreads": {
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "description": "New open plot threads to append (deduplicated)"
                },
                "resolvedThreads": {
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "description": "Resolved or explicitly waived threads to remove from openThreads"
                },
                "estimatedScale": {
                    "type": "string",
                    "maxLength": 200,
                    "description": "Scale interval expression (e.g. '预计 4-6 卷')"
                },
                "declareFinalVolume": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_VOLUME_NUM,
                    "description": "Declare final volume number (sets finalVolumeDeclared=true)"
                }
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
            let query = build_compass_update_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_foreshadowing_upsert_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "foreshadowing.upsert";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "id",
            "name",
            "description",
            "status",
            "plantedChapter",
            "advancedChapters",
            "resolvedChapter",
            "relatedCharacters",
            "relatedEvents",
            "notes",
        ],
        &[],
    )?);

    let mut params = serde_json::Map::new();
    let mut has_identity = false;

    if let Some(raw_id) = normalized.get("id") {
        let id = raw_id
            .as_str()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `id` 必须是字符串")))?;
        validate_ascii_id(id, tool, "id")?;
        params.insert("id".to_string(), json!(id));
        has_identity = true;
    }

    if let Some(raw_name) = normalized.get("name") {
        let name = raw_name
            .as_str()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `name` 必须是字符串")))?;
        validate_single_line_str(name, tool, "name", 1, 200)?;
        params.insert("name".to_string(), json!(name.trim()));
        has_identity = true;
    }

    if !has_identity {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 至少需提供 `id` 或 `name`"
        )));
    }

    if let Some(desc) =
        validate_optional_text_allow_empty(&normalized, tool, "description", 2_000, false)?
    {
        params.insert("description".to_string(), json!(desc));
    }
    if let Some(status) = optional_enum_str(
        &normalized,
        tool,
        "status",
        &PLANNING_FORESHADOWING_STATUSES,
    )? {
        params.insert("status".to_string(), json!(status));
    }
    if let Some(ch) = optional_int_in_range(
        &normalized,
        tool,
        "plantedChapter",
        1,
        PLANNING_MAX_CHAPTER_NUM,
    )? {
        params.insert("plantedChapter".to_string(), json!(ch));
    }
    if let Some(raw_adv) = normalized.get("advancedChapters") {
        let chs = validate_positive_u64_array(
            raw_adv,
            tool,
            "advancedChapters",
            200,
            PLANNING_MAX_CHAPTER_NUM,
        )?;
        params.insert("advancedChapters".to_string(), json!(chs));
    }
    if let Some(ch) = optional_int_in_range(
        &normalized,
        tool,
        "resolvedChapter",
        1,
        PLANNING_MAX_CHAPTER_NUM,
    )? {
        params.insert("resolvedChapter".to_string(), json!(ch));
    }
    if let Some(raw_chars) = normalized.get("relatedCharacters") {
        let items = validate_planning_string_array(
            raw_chars,
            tool,
            "relatedCharacters",
            100,
            128,
            true,
        )?;
        params.insert("relatedCharacters".to_string(), json!(items));
    }
    if let Some(raw_events) = normalized.get("relatedEvents") {
        let items =
            validate_planning_string_array(raw_events, tool, "relatedEvents", 100, 200, true)?;
        params.insert("relatedEvents".to_string(), json!(items));
    }
    if let Some(notes) =
        validate_optional_text_allow_empty(&normalized, tool, "notes", 2_000, false)?
    {
        params.insert("notes".to_string(), json!(notes));
    }

    Ok(StateQuery::new("foreshadowing-upsert").with_params(Value::Object(params)))
}

/// `foreshadowing.upsert` —— 零 LLM 创建/更新伏笔账本条目（`.novel/foreshadowing-tracker.json`）。
pub struct ForeshadowingUpsertTool;

impl super::registry::McpTool for ForeshadowingUpsertTool {
    fn name(&self) -> &'static str {
        "foreshadowing.upsert"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM create or update one foreshadowing entry in .novel/foreshadowing-tracker.json (matches by id or name; enforces markAbandoned transition guard). Requires Project scope; never mutates formal chapters."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "description": "Optional ASCII identifier [a-zA-Z0-9_-]; auto-generated deterministically on create if omitted"
                },
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200,
                    "description": "Foreshadowing title/name (required when creating a new entry)"
                },
                "description": { "type": "string", "maxLength": 2000 },
                "status": {
                    "type": "string",
                    "enum": PLANNING_FORESHADOWING_STATUSES
                },
                "plantedChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_CHAPTER_NUM
                },
                "advancedChapters": {
                    "type": "array",
                    "maxItems": 200,
                    "items": { "type": "integer", "minimum": 1, "maximum": PLANNING_MAX_CHAPTER_NUM }
                },
                "resolvedChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_CHAPTER_NUM
                },
                "relatedCharacters": {
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 128 }
                },
                "relatedEvents": {
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                },
                "notes": { "type": "string", "maxLength": 2000 }
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
            let query = build_foreshadowing_upsert_query(args)?;
            ctx.bridge_query(query).await
        })
    }
}

fn build_subplot_upsert_query(args: &Value) -> Result<StateQuery, ToolError> {
    let tool = "subplot.upsert";
    let normalized = Value::Object(normalize_strict_object_args(
        args,
        tool,
        &[
            "id",
            "title",
            "status",
            "startChapter",
            "resolvedChapter",
            "lastSeenChapter",
            "targetResolutionChapter",
            "abandoned",
            "relatedCharacters",
            "summary",
            "progressEntry",
            "progress",
            "notes",
        ],
        &[],
    )?);

    let mut params = serde_json::Map::new();
    let mut has_identity = false;

    if let Some(raw_id) = normalized.get("id") {
        let id = raw_id
            .as_str()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `id` 必须是字符串")))?;
        validate_ascii_id(id, tool, "id")?;
        params.insert("id".to_string(), json!(id));
        has_identity = true;
    }

    if let Some(raw_title) = normalized.get("title") {
        let title = raw_title
            .as_str()
            .ok_or_else(|| ToolError::invalid_params(format!("{tool}: `title` 必须是字符串")))?;
        validate_single_line_str(title, tool, "title", 1, 200)?;
        params.insert("title".to_string(), json!(title.trim()));
        has_identity = true;
    }

    if !has_identity {
        return Err(ToolError::invalid_params(format!(
            "{tool}: 至少需提供 `id` 或 `title`"
        )));
    }

    if let Some(status) =
        optional_enum_str(&normalized, tool, "status", &PLANNING_SUBPLOT_STATUSES)?
    {
        params.insert("status".to_string(), json!(status));
    }
    for ch_field in [
        "startChapter",
        "resolvedChapter",
        "lastSeenChapter",
        "targetResolutionChapter",
    ] {
        if let Some(ch) =
            optional_int_in_range(&normalized, tool, ch_field, 1, PLANNING_MAX_CHAPTER_NUM)?
        {
            params.insert(ch_field.to_string(), json!(ch));
        }
    }
    if let Some(abandoned) = optional_bool(&normalized, tool, "abandoned")? {
        params.insert("abandoned".to_string(), json!(abandoned));
    }
    if let Some(raw_chars) = normalized.get("relatedCharacters") {
        let items = validate_planning_string_array(
            raw_chars,
            tool,
            "relatedCharacters",
            100,
            128,
            true,
        )?;
        params.insert("relatedCharacters".to_string(), json!(items));
    }
    if let Some(summary) =
        validate_optional_text_allow_empty(&normalized, tool, "summary", 2_000, false)?
    {
        params.insert("summary".to_string(), json!(summary));
    }
    if let Some(raw_entry) = normalized.get("progressEntry") {
        let entry = raw_entry.as_str().ok_or_else(|| {
            ToolError::invalid_params(format!("{tool}: `progressEntry` 必须是字符串"))
        })?;
        validate_multiline_no_nul(entry, tool, "progressEntry", 1, 1_000)?;
        params.insert("progressEntry".to_string(), json!(entry.trim()));
    }
    if let Some(raw_progress) = normalized.get("progress") {
        let items =
            validate_planning_string_array(raw_progress, tool, "progress", 200, 1_000, false)?;
        params.insert("progress".to_string(), json!(items));
    }
    if let Some(notes) =
        validate_optional_text_allow_empty(&normalized, tool, "notes", 2_000, false)?
    {
        params.insert("notes".to_string(), json!(notes));
    }

    Ok(StateQuery::new("subplot-upsert").with_params(Value::Object(params)))
}

/// `subplot.upsert` —— 零 LLM 创建/更新支线剧情进度板条目（`.novel/subplot-board.json`）。
pub struct SubplotUpsertTool;

impl super::registry::McpTool for SubplotUpsertTool {
    fn name(&self) -> &'static str {
        "subplot.upsert"
    }

    fn description(&self) -> &'static str {
        "Zero-LLM create or update one subplot entry in .novel/subplot-board.json (matches by id or title; supports appending progressEntry or setting progress log). Requires Project scope; never mutates formal chapters."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": DRAFT_ID_MAX_LEN,
                    "description": "Optional ASCII identifier [a-zA-Z0-9_-]; auto-generated deterministically on create if omitted"
                },
                "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200,
                    "description": "Subplot title (required when creating a new entry)"
                },
                "status": {
                    "type": "string",
                    "enum": PLANNING_SUBPLOT_STATUSES
                },
                "startChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_CHAPTER_NUM
                },
                "resolvedChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_CHAPTER_NUM
                },
                "lastSeenChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_CHAPTER_NUM
                },
                "targetResolutionChapter": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": PLANNING_MAX_CHAPTER_NUM
                },
                "abandoned": { "type": "boolean" },
                "relatedCharacters": {
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 128 }
                },
                "summary": { "type": "string", "maxLength": 2000 },
                "progressEntry": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Single progress note appended to progress log"
                },
                "progress": {
                    "type": "array",
                    "maxItems": 200,
                    "items": { "type": "string", "minLength": 1, "maxLength": 1000 }
                },
                "notes": { "type": "string", "maxLength": 2000 }
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
            let query = build_subplot_upsert_query(args)?;
            ctx.bridge_query(query).await
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
    r.register(Arc::new(CanonFactsKnownByTool));
    r.register(Arc::new(CanonEpisodesTool));
    r.register(Arc::new(DraftListTool));
    r.register(Arc::new(DraftReadTool));
    r.register(Arc::new(RulesGetTool));
    r.register(Arc::new(GateCheckMechanicalTool));
    r.register(Arc::new(ContextPrepareWriteTool));
    r.register(Arc::new(DirectorCheckTool));
    r.register(Arc::new(WorkflowNextTool));
    r.register(Arc::new(ForeshadowingListTool));
    r.register(Arc::new(CharacterReadTool));
    r.register(Arc::new(OutlineReadTool));
    r.register(Arc::new(StyleExemplarsTool));
    r.register(Arc::new(ChapterSearchTool));
    r.register(Arc::new(DraftDiffTool));
    r.register(Arc::new(AuditLongformHealthTool));
    r.register(Arc::new(SkillsListTool));
    r.register(Arc::new(SkillsGetTool));
    r.register(Arc::new(PipelineRunChapterTool));
    r.register(Arc::new(PipelineStatusTool));
    r.register(Arc::new(GateRunTool));
    r.register(Arc::new(ChapterWriteTool));
    r.register(Arc::new(DraftPatchTool));
    r.register(Arc::new(DraftRecordReviewTool));
    r.register(Arc::new(DirectorAdvanceTool));
    r.register(Arc::new(OutlineGenerateTool));
    r.register(Arc::new(OutlineWriteTool));
    r.register(Arc::new(CharacterUpsertTool));
    r.register(Arc::new(DirectorUpsertWorldTool));
    r.register(Arc::new(DirectorCommitPhaseTool));
    r.register(Arc::new(RulesUpsertBookRulesTool));
    r.register(Arc::new(CompassUpdateTool));
    r.register(Arc::new(ForeshadowingUpsertTool));
    r.register(Arc::new(SubplotUpsertTool));
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
            "draft.patch",
            "draft.record_review",
            "director.advance",
            "outline.generate",
            "outline.write",
            "character.upsert",
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
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
                "canon.facts_known_by",
                "canon.episodes",
                "draft.list",
                "draft.read",
                "rules.get",
                "gate.check_mechanical",
                "context.prepare_write",
                "director.check",
                "workflow.next",
                "foreshadowing.list",
                "character.read",
                "outline.read",
                "style.exemplars",
                "chapter.search",
                "draft.diff",
                "audit.longform_health",
                "skills.list",
                "skills.get",
                "pipeline.run_chapter",
                "pipeline.status",
                "gate.run",
                "chapter.write",
                "draft.patch",
                "draft.record_review",
                "director.advance",
                "outline.generate",
                "outline.write",
                "character.upsert",
                "director.upsert_world",
                "director.commit_phase",
                "rules.upsert_book_rules",
                "compass.update",
                "foreshadowing.upsert",
                "subplot.upsert",
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
        // 默认上下文（无调用方）就是最小权限：readOnly=true、scope=read、profile=full-legacy，
        // 且 version / mode / listen 三个既有字段的名称与结构都不变。
        let ctx = ToolContext::for_test();
        let out = AppStatusTool
            .call(&ctx, &json!({}))
            .await
            .expect("app.status 不依赖 AppHandle，必须成功");
        assert_eq!(out["readOnly"], json!(true), "{out}");
        assert_eq!(out["scope"], json!("read"), "{out}");
        assert_eq!(out["profile"], json!("full-legacy"), "{out}");
        assert_eq!(out["version"], json!(SERVER_VERSION), "{out}");
        assert_eq!(out["listen"], json!("127.0.0.1:0"), "{out}");
        assert!(out["mode"].is_string(), "mode 必须保留: {out}");

        let sub_ctx = ctx.for_caller_with_profile(SessionScope::Project, ToolProfile::WriterSub);
        let sub_out = AppStatusTool.call(&sub_ctx, &json!({})).await.expect("ok");
        assert_eq!(sub_out["scope"], json!("project"));
        assert_eq!(sub_out["profile"], json!("writer-sub"));
        assert_eq!(ctx.caller_profile, ToolProfile::FullLegacy);
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
        let cases = vec![
            json!({ "chapter": "1", "includePacks": true }),
            json!({ "chapter": "1", "extra": null }),
            json!({ "chapter": "1", "dimenion": "thrill" }),
            json!({ "chapter": "1", "extra": 1 }),
            json!({ "chapter": "1", "inspectionId": 42 }),
            json!({ "chapter": "1", "inspectionId": " " }),
            json!({ "chapter": null }),
            json!([]),
            Value::Null,
        ];
        for args in cases {
            let err = ContextInspectTool
                .call(&ctx, &args)
                .await
                .expect_err("未知键与必填项显式 null 必须在 bridge 前拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "args={args}: {err:?}"
            );
        }
        // 可选字段显式 null 会被 normalize_strict_object_args 剥离并放行至状态桥（无 AppHandle -> INTERNAL_ERROR）。
        for field in [
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
            let err = ContextInspectTool
                .call(&ctx, &args)
                .await
                .expect_err("可选 null 归一化后应直达状态桥并因缺 AppHandle 报内部错");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INTERNAL_ERROR,
                "field={field} args={args}: {err:?}"
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
                "draft.patch",
                "draft.record_review",
                "director.advance",
                "outline.generate",
                "outline.write",
                "character.upsert",
                "director.upsert_world",
                "director.commit_phase",
                "rules.upsert_book_rules",
                "compass.update",
                "foreshadowing.upsert",
                "subplot.upsert",
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

        // 可选字段传 null 会归一化为默认值，必填 draftId 传 null 仍严格拒绝。
        let q_opt_null = build_draft_read_query(&json!({
            "draftId": "ok_1",
            "offset": null,
            "limit": null,
        }))
        .expect("optional nulls normalized");
        assert_eq!(
            q_opt_null.params,
            Some(json!({ "draftId": "ok_1", "offset": 0, "limit": 200 }))
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
            json!({ "draftId": "ok_1", "offset": -1 }),
            json!({ "draftId": "ok_1", "offset": "0" }),
            json!({ "draftId": "ok_1", "offset": 1.5 }),
            json!({ "draftId": "ok_1", "limit": 0 }),
            json!({ "draftId": "ok_1", "limit": 2001 }),
            json!({ "draftId": "ok_1", "limit": "200" }),
            json!({ "draftId": "ok_1", "unknown": true }),
            json!({ "draftId": "ok_1", "unknown": null }),
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

        // 可选字段 sections / compact 传 null 会归一化为缺省，不转发 compact 键。
        let q_opt_null =
            build_rules_get_query(&json!({ "sections": null, "compact": null })).expect("ok");
        assert_eq!(
            q_opt_null.params,
            Some(json!({ "sections": ["writingStyle", "antiAi", "bookRules", "planning"] }))
        );

        // 显式传入 compact 才转发给 StateQuery。
        let q_compact = build_rules_get_query(&json!({
            "sections": ["antiAi"],
            "compact": true,
        }))
        .expect("compact true ok");
        assert_eq!(
            q_compact.params,
            Some(json!({ "sections": ["antiAi"], "compact": true }))
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
            json!({ "sections": "antiAi" }),
            json!({ "sections": [] }),
            json!({ "sections": ["unknownSection"] }),
            json!({ "sections": ["antiAi", 42] }),
            json!({ "sections": ["antiAi", null] }),
            json!({ "sections": too_many }),
            json!({ "compact": "true" }),
            json!({ "compact": 1 }),
            json!({ "extra": 1 }),
            json!({ "extra": null }),
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

        // 显式 detailLevel 才转发给 StateQuery；可选字段 null 会被剥离。
        let q_compact = build_gate_check_mechanical_query(&json!({
            "draftId": null,
            "text": "hello",
            "chapterNumber": null,
            "detailLevel": "compact"
        }))
        .expect("optional nulls normalized and detailLevel forwarded");
        assert_eq!(
            q_compact.params,
            Some(json!({ "text": "hello", "detailLevel": "compact" }))
        );

        let q_full = build_gate_check_mechanical_query(&json!({
            "text": "hello",
            "detailLevel": "full"
        }))
        .expect("detailLevel full ok");
        assert_eq!(
            q_full.params,
            Some(json!({ "text": "hello", "detailLevel": "full" }))
        );

        let q_detail_null = build_gate_check_mechanical_query(&json!({
            "text": "hello",
            "detailLevel": null
        }))
        .expect("detailLevel null normalized");
        assert_eq!(q_detail_null.params, Some(json!({ "text": "hello" })));

        let desc = GateCheckMechanicalTool.description();
        assert!(desc.contains("P0 Continuity") && desc.contains("chapterNumber"));

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            // 0-of-3（含全部显式 null 归一化后归零）
            json!({}),
            json!({ "chapterNumber": 1 }),
            json!({ "draftId": null, "chapter": null, "text": null }),
            // >1-of-3
            json!({ "draftId": "d1", "chapter": "1" }),
            json!({ "draftId": "d1", "text": "hello" }),
            json!({ "chapter": "1", "text": "hello" }),
            json!({ "draftId": "d1", "chapter": "1", "text": "hello" }),
            // unknown keys (even if null)
            json!({ "text": "hello", "extra": 1 }),
            json!({ "text": "hello", "extra": null }),
            // invalid detailLevel
            json!({ "text": "hello", "detailLevel": "verbose" }),
            json!({ "text": "hello", "detailLevel": "" }),
            json!({ "text": "hello", "detailLevel": true }),
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

        // context.prepare_write 的 dimension 不得在 Rust 侧锁死 enum（TS 侧按 SIX_REVIEW_DIMENSION_ORDER 校验），
        // 但 description 与 dimension.description 必须明确列出全部六个键。
        let schema = ContextPrepareWriteTool.input_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["dimension"]["type"], json!("string"));
        assert!(schema["properties"]["dimension"].get("enum").is_none());
        let prep_desc = ContextPrepareWriteTool.description();
        let dim_desc = schema["properties"]["dimension"]["description"]
            .as_str()
            .expect("dimension description");
        for key in [
            "thrill",
            "consistency",
            "pacing",
            "character",
            "continuity",
            "pull",
        ] {
            assert!(
                prep_desc.contains(key),
                "description 应含 {key}: {prep_desc}"
            );
            assert!(
                dim_desc.contains(key),
                "dimension.description 应含 {key}: {dim_desc}"
            );
        }
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
        // 默认不注入 allowRetrievalNetwork / retrievalMode（仅显式提供时转发）。
        let defaults = build_context_prepare_write_params(&json!({})).expect("empty object ok");
        assert_eq!(
            defaults,
            json!({
                "offset": 0,
                "limit": 16_000,
            })
        );
        assert!(defaults.get("allowRetrievalNetwork").is_none());
        assert!(defaults.get("retrievalMode").is_none());

        // 可选字段显式 null 会被归一化剥离。
        let null_opts = build_context_prepare_write_params(&json!({
            "targetChapter": null,
            "allowRetrievalNetwork": null,
            "retrievalMode": null,
            "dimension": null,
        }))
        .expect("optional nulls normalized");
        assert_eq!(null_opts, json!({ "offset": 0, "limit": 16_000 }));

        // retrievalMode 单独传入不注入 allowRetrievalNetwork；兼容组合放行。
        let local_only = build_context_prepare_write_params(&json!({
            "retrievalMode": "local_only",
        }))
        .expect("local_only ok");
        assert_eq!(local_only["retrievalMode"], json!("local_only"));
        assert!(local_only.get("allowRetrievalNetwork").is_none());

        let local_compat = build_context_prepare_write_params(&json!({
            "retrievalMode": "local_only",
            "allowRetrievalNetwork": false,
        }))
        .expect("local_only + false ok");
        assert_eq!(local_compat["retrievalMode"], json!("local_only"));
        assert_eq!(local_compat["allowRetrievalNetwork"], json!(false));

        let net_compat = build_context_prepare_write_params(&json!({
            "retrievalMode": "configured_network",
            "allowRetrievalNetwork": true,
        }))
        .expect("configured_network + true ok");
        assert_eq!(net_compat["retrievalMode"], json!("configured_network"));
        assert_eq!(net_compat["allowRetrievalNetwork"], json!(true));

        let full = build_context_prepare_write_params(&json!({
            "targetChapter": 12,
            "draftId": "draft_12-rev1",
            "task": "推进主线冲突",
            "includePack": true,
            "includeDraft": true,
            "includePlanningView": true,
            "dimension": "consistency",
            "allowRetrievalNetwork": true,
            "retrievalMode": "configured_network",
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
        assert_eq!(full["retrievalMode"], json!("configured_network"));
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
            json!({ "extra": null }),
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
            json!({ "retrievalMode": "auto" }),
            json!({ "retrievalMode": "" }),
            json!({ "retrievalMode": 1 }),
            // retrievalMode 与 allowRetrievalNetwork 语义冲突必须 fail-closed 拒收
            json!({ "retrievalMode": "local_only", "allowRetrievalNetwork": true }),
            json!({ "retrievalMode": "configured_network", "allowRetrievalNetwork": false }),
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

        // 可选 syncModel=null 归一化为默认 true；必填 filename/content 为 null 与未知键仍严格拒绝。
        let q_null_sync = build_outline_write_query(&json!({
            "filename": "ok.md",
            "content": "ok",
            "syncModel": null,
        }))
        .expect("optional syncModel=null normalized");
        assert_eq!(
            q_null_sync.params,
            Some(json!({ "filename": "ok.md", "content": "ok", "syncModel": true }))
        );

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            json!({}),
            json!({ "filename": "ok.md" }),
            json!({ "content": "ok" }),
            json!({ "filename": null, "content": "ok" }),
            json!({ "filename": "ok.md", "content": null }),
            json!({ "filename": "ok.md", "content": "ok", "extra": 1 }),
            json!({ "filename": "ok.md", "content": "ok", "extra": null }),
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

    #[tokio::test]
    async fn canon_query_normalizes_null_filter_and_rejects_invalid_filter() {
        let default_filter = parse_canon_query_filter(&json!({})).expect("omitted filter ok");
        let null_filter =
            parse_canon_query_filter(&json!({ "filter": null })).expect("explicit null filter ok");
        assert_eq!(
            serde_json::to_value(&null_filter).expect("ser"),
            serde_json::to_value(&default_filter).expect("ser")
        );

        let scoped = parse_canon_query_filter(&json!({
            "filter": { "known_by": "林清", "limit": 20 }
        }))
        .expect("valid filter ok");
        assert_eq!(scoped.known_by.as_deref(), Some("林清"));
        assert_eq!(scoped.limit, Some(20));

        let ctx = ToolContext::for_test();
        // 显式 `filter: null` 归一化后直达状态桥（无 AppHandle -> INTERNAL_ERROR，而非 INVALID_PARAMS）。
        let err_null = CanonQueryTool
            .call(&ctx, &json!({ "filter": null }))
            .await
            .expect_err("无 AppHandle 应报内部错");
        assert_eq!(err_null.code, crate::mcp_server::protocol::INTERNAL_ERROR);

        // 非对象 `filter` 仍严格在状态桥前报 INVALID_PARAMS。
        let err_bad = CanonQueryTool
            .call(&ctx, &json!({ "filter": "invalid" }))
            .await
            .expect_err("非法 filter 必须拒绝");
        assert_eq!(err_bad.code, crate::mcp_server::protocol::INVALID_PARAMS);
    }

    // ── Phase 2：context.prepare_write (prepareId/page) + 8 个新零 LLM 工具 ──

    #[tokio::test]
    async fn context_prepare_write_supports_prepare_id_page_and_offset_mutual_exclusion() {
        // 1) 传入 page 时转发 page 并省略 offset（绝不注入默认 offset=0）。
        let paged = build_context_prepare_write_params(&json!({
            "prepareId": "prep_snap-01",
            "page": 2,
            "limit": 8_000,
        }))
        .expect("prepareId + page ok");
        assert_eq!(
            paged,
            json!({
                "prepareId": "prep_snap-01",
                "page": 2,
                "limit": 8_000,
            })
        );
        assert!(paged.get("offset").is_none(), "传 page 时不得注入 offset");

        // 2) offset 显式 null + page 合法 -> 归一化后只走 page，省略 offset。
        let null_offset_page = build_context_prepare_write_params(&json!({
            "prepareId": null,
            "offset": null,
            "page": 1,
        }))
        .expect("offset=null + page=1 ok");
        assert_eq!(null_offset_page, json!({ "page": 1, "limit": 16_000 }));
        assert!(null_offset_page.get("offset").is_none());

        // 3) page=null + 未传 offset -> 保留既有默认 offset=0。
        let null_page = build_context_prepare_write_params(&json!({
            "page": null,
            "prepareId": null,
        }))
        .expect("page=null defaults to offset=0");
        assert_eq!(null_page, json!({ "offset": 0, "limit": 16_000 }));
        assert!(null_page.get("page").is_none());

        // 4) page 边界最大值 10_000 + limit 50_000 放行。
        let max_page = build_context_prepare_write_params(&json!({
            "page": 10_000,
            "limit": 50_000,
        }))
        .expect("page max ok");
        assert_eq!(max_page, json!({ "page": 10_000, "limit": 50_000 }));

        // 5) description / schema 必须反映 prepareId 与 page。
        let desc = ContextPrepareWriteTool.description();
        assert!(desc.contains("prepareId") && desc.contains("page"));
        let schema = ContextPrepareWriteTool.input_schema();
        assert_eq!(schema["properties"]["prepareId"]["type"], json!("string"));
        assert_eq!(schema["properties"]["page"]["minimum"], json!(1));
        assert_eq!(schema["properties"]["page"]["maximum"], json!(10_000));

        // 6) 互斥与非法边界必须在桥前拒绝（INVALID_PARAMS）。
        let ctx = ToolContext::for_test();
        for bad in [
            json!({ "offset": 0, "page": 1 }),
            json!({ "offset": 100, "page": 2 }),
            json!({ "page": 0 }),
            json!({ "page": -1 }),
            json!({ "page": 10_001 }),
            json!({ "page": "1" }),
            json!({ "page": 1.5 }),
            json!({ "prepareId": "" }),
            json!({ "prepareId": "bad/id" }),
            json!({ "prepareId": "bad id" }),
            json!({ "prepareId": "a".repeat(129) }),
            json!({ "prepareId": 42 }),
        ] {
            let err = ContextPrepareWriteTool
                .call(&ctx, &bad)
                .await
                .expect_err("prepareId/page 非法参数或互斥组合必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[test]
    fn phase2_eight_tools_have_expected_scopes_descriptions_and_no_draft_accept() {
        let r = build_registry();
        assert_eq!(r.len(), 50);
        assert_eq!(r.privileged_tools().len(), 22);
        assert!(!r.names().contains(&"draft.accept"));

        for read_name in [
            "workflow.next",
            "foreshadowing.list",
            "character.read",
            "outline.read",
            "style.exemplars",
            "chapter.search",
            "draft.diff",
            "audit.longform_health",
        ] {
            assert_eq!(
                r.required_scope(read_name),
                Some(crate::mcp_server::session::SessionScope::Read),
                "{read_name} 必须为 Read scope"
            );
        }
        for project_name in ["draft.patch", "draft.record_review"] {
            assert_eq!(
                r.required_scope(project_name),
                Some(crate::mcp_server::session::SessionScope::Project),
                "{project_name} 必须为 Project scope"
            );
        }

        let patch_desc = DraftPatchTool.description();
        assert!(patch_desc.contains("expectedSha256"));
        assert!(patch_desc.contains("bodySha256"));
        assert!(patch_desc.contains("1-based inclusive"));
        assert!(patch_desc.contains("HARD_FUSE_LIMIT = 5"));
        assert!(patch_desc.contains("parentDraftId"));
        assert!(patch_desc.contains(".qm-drafts/"));

        let review_desc = DraftRecordReviewTool.description();
        assert!(review_desc.contains("Consistency(P0) > Anti-AI(P1) > Quality(P2)"));
        assert!(review_desc.contains("pending -> ready"));
        assert!(review_desc.contains("NEVER accepts"));
    }

    #[tokio::test]
    async fn workflow_next_validates_strictly_before_bridge() {
        let q_empty = build_workflow_next_query(&json!({})).expect("empty ok");
        assert_eq!(q_empty.op, "workflow-next");
        assert_eq!(q_empty.params, Some(json!({})));

        let q_full = build_workflow_next_query(&json!({
            "targetChapter": 12,
            "draftId": "draft_12-a"
        }))
        .expect("full ok");
        assert_eq!(
            q_full.params,
            Some(json!({ "targetChapter": 12, "draftId": "draft_12-a" }))
        );

        let q_nulls = build_workflow_next_query(&json!({
            "targetChapter": null,
            "draftId": null
        }))
        .expect("optional nulls ok");
        assert_eq!(q_nulls.params, Some(json!({})));

        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!([]),
            json!({ "targetChapter": 0 }),
            json!({ "targetChapter": JS_MAX_SAFE_INTEGER + 1 }),
            json!({ "targetChapter": "1" }),
            json!({ "draftId": "" }),
            json!({ "draftId": "../x" }),
            json!({ "draftId": "a".repeat(129) }),
            json!({ "extra": 1 }),
            json!({ "extra": null }),
        ] {
            let err = WorkflowNextTool
                .call(&ctx, &bad)
                .await
                .expect_err("workflow.next 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn draft_patch_enforces_sha_union_bounds_and_nul_safety() {
        let upper_sha = "A".repeat(64);
        let lower_sha = "a".repeat(64);
        let q_valid = build_draft_patch_query(&json!({
            "draftId": "draft_09",
            "expectedSha256": upper_sha,
            "edits": [
                { "find": "旧句子", "replace": "新句子", "occurrence": 2 },
                { "find": "删除我", "replace": "", "occurrence": null },
                { "startLine": 10, "endLine": 12, "replacement": "替换段落\n第二行" }
            ],
            "note": "修复 P0 细节"
        }))
        .expect("valid patch ok");
        assert_eq!(q_valid.op, "draft-patch");
        assert_eq!(
            q_valid.params,
            Some(json!({
                "draftId": "draft_09",
                "expectedSha256": lower_sha,
                "edits": [
                    { "find": "旧句子", "replace": "新句子", "occurrence": 2 },
                    { "find": "删除我", "replace": "" },
                    { "startLine": 10, "endLine": 12, "replacement": "替换段落\n第二行" }
                ],
                "note": "修复 P0 细节"
            }))
        );

        // note=null 归一化剥离；总字符数恰好 100_000 放行。
        let exact_100k = build_draft_patch_query(&json!({
            "draftId": "d1",
            "expectedSha256": lower_sha,
            "edits": [{ "startLine": 1, "endLine": 1, "replacement": "字".repeat(100_000) }],
            "note": null
        }))
        .expect("100_000 chars ok");
        assert!(exact_100k.params.unwrap().get("note").is_none());

        let too_many_edits: Vec<Value> = (0..26)
            .map(|i| json!({ "find": format!("k{i}"), "replace": "v" }))
            .collect();
        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!({}),
            // bad SHA-256
            json!({ "draftId": "d1", "expectedSha256": "a".repeat(63), "edits": [{ "find": "a", "replace": "b" }] }),
            json!({ "draftId": "d1", "expectedSha256": "a".repeat(65), "edits": [{ "find": "a", "replace": "b" }] }),
            json!({ "draftId": "d1", "expectedSha256": format!("g{}", "a".repeat(63)), "edits": [{ "find": "a", "replace": "b" }] }),
            json!({ "draftId": "d1", "expectedSha256": null, "edits": [{ "find": "a", "replace": "b" }] }),
            // empty or > 25 edits
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": too_many_edits }),
            // mixed union / unknown keys / empty edit
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{}] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b", "startLine": 1 }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b", "startLine": null }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b", "extra": 1 }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "startLine": 1, "endLine": 1, "replacement": "x", "occurrence": 1 }] }),
            // find/replace bounds & NUL
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "", "replace": "b" }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a\0b", "replace": "c" }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b\0c" }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b", "occurrence": 0 }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b", "occurrence": 1001 }] }),
            // line bounds & NUL
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "startLine": 0, "endLine": 1, "replacement": "x" }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "startLine": 5, "endLine": 4, "replacement": "x" }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "startLine": 1, "endLine": 1_000_001, "replacement": "x" }] }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "startLine": 1, "endLine": 1, "replacement": "x\0y" }] }),
            // total char cap > 100_000
            json!({
                "draftId": "d1",
                "expectedSha256": lower_sha,
                "edits": [
                    { "find": "a".repeat(50_000), "replace": "b".repeat(50_001) }
                ]
            }),
            // bad note
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b" }], "note": "   " }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b" }], "note": "a\0b" }),
            json!({ "draftId": "d1", "expectedSha256": lower_sha, "edits": [{ "find": "a", "replace": "b" }], "note": "x".repeat(1001) }),
        ] {
            let err = DraftPatchTool
                .call(&ctx, &bad)
                .await
                .expect_err("draft.patch 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn draft_record_review_validates_gates_scores_and_bounds() {
        let sha = "0123456789abcdef".repeat(4);
        let q_valid = build_draft_record_review_query(&json!({
            "draftId": "draft_10",
            "expectedSha256": sha.to_uppercase(),
            "gates": {
                "consistency": "pass",
                "anti_ai": "pass",
                "quality": "warning"
            },
            "overallScore": 8.75,
            "dimensionScores": {
                "thrill": 9,
                "consistency": 9.5,
                "pacing": 8.0
            },
            "summary": "整体连贯\n节奏良好",
            "blockingIssues": ["第3段情绪略急"],
            "reviewerRole": "literary-critic",
            "autoArmEnabled": true
        }))
        .expect("valid record_review ok");
        assert_eq!(q_valid.op, "draft-record-review");
        let p = q_valid.params.unwrap();
        assert_eq!(p["expectedSha256"], json!(sha));
        assert_eq!(p["gates"]["quality"], json!("warning"));
        assert_eq!(p["overallScore"], json!(8.75));
        assert_eq!(p["autoArmEnabled"], json!(true));

        // 可选字段传 null 归一化剥离（含 gates.quality = null）。
        let q_opt_null = build_draft_record_review_query(&json!({
            "draftId": "draft_10",
            "expectedSha256": sha,
            "gates": { "consistency": "not_evaluated", "anti_ai": "fail", "quality": null },
            "overallScore": null,
            "dimensionScores": null,
            "summary": null,
            "blockingIssues": null,
            "reviewerRole": null,
            "autoArmEnabled": null
        }))
        .expect("optional nulls ok");
        assert_eq!(
            q_opt_null.params,
            Some(json!({
                "draftId": "draft_10",
                "expectedSha256": sha,
                "gates": { "consistency": "not_evaluated", "anti_ai": "fail" }
            }))
        );

        let mut too_many_dims = serde_json::Map::new();
        for i in 0..13 {
            too_many_dims.insert(format!("dim{i}"), json!(8.0));
        }
        let too_many_issues: Vec<Value> = (0..51).map(|i| json!(format!("issue {i}"))).collect();
        let ctx = ToolContext::for_test();
        for bad in [
            json!(null),
            json!({}),
            json!({ "draftId": "d1", "expectedSha256": "short", "gates": { "consistency": "pass", "anti_ai": "pass" } }),
            // invalid gate enums / unknown gate keys / missing required gate
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "warning", "anti_ai": "pass" } }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "warning" } }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass", "quality": "bad" } }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass" } }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass", "extra": "pass" } }),
            // score bounds
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "overallScore": -0.1 }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "overallScore": 10.1 }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "overallScore": "9.0" }),
            // dimensionScores bounds
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "dimensionScores": Value::Object(too_many_dims) }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "dimensionScores": { "": 8.0 } }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "dimensionScores": { "bad\nkey": 8.0 } }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "dimensionScores": { "thrill": 10.5 } }),
            // summary / blockingIssues / reviewerRole / autoArmEnabled
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "summary": "a\0b" }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "summary": "字".repeat(4001) }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "blockingIssues": too_many_issues }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "blockingIssues": ["  "] }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "blockingIssues": ["x\0y"] }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "reviewerRole": "bad\nrole" }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "reviewerRole": "r".repeat(65) }),
            json!({ "draftId": "d1", "expectedSha256": sha, "gates": { "consistency": "pass", "anti_ai": "pass" }, "autoArmEnabled": "true" }),
        ] {
            let err = DraftRecordReviewTool
                .call(&ctx, &bad)
                .await
                .expect_err("draft.record_review 非法参数必须拒绝");
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "bad={bad}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn foreshadowing_list_and_character_read_validate_strictly() {
        let q_fs = build_foreshadowing_list_query(&json!({
            "status": "overdue",
            "character": "林清",
            "currentChapter": 25,
            "includeDebt": true,
            "debtLevel": "critical",
            "offset": 0,
            "limit": 50
        }))
        .expect("foreshadowing valid ok");
        assert_eq!(q_fs.op, "foreshadowing-list");
        assert_eq!(q_fs.params.unwrap()["debtLevel"], json!("critical"));

        assert_eq!(
            build_foreshadowing_list_query(&json!({ "status": null, "debtLevel": null }))
                .expect("nulls ok")
                .params,
            Some(json!({}))
        );

        let ctx = ToolContext::for_test();
        let q_fs_max = build_foreshadowing_list_query(&json!({
            "currentChapter": ATOMIC_READ_MAX_CHAPTER,
            "offset": ATOMIC_READ_MAX_OFFSET
        }))
        .expect("foreshadowing max bounds ok");
        assert_eq!(
            q_fs_max.params.unwrap()["currentChapter"],
            json!(ATOMIC_READ_MAX_CHAPTER)
        );
        let fs_schema = ForeshadowingListTool.input_schema();
        assert_eq!(
            fs_schema["properties"]["currentChapter"]["maximum"],
            json!(ATOMIC_READ_MAX_CHAPTER)
        );
        assert_eq!(
            fs_schema["properties"]["offset"]["maximum"],
            json!(ATOMIC_READ_MAX_OFFSET)
        );

        for bad in [
            json!({ "status": "closed" }),
            json!({ "character": "a\nb" }),
            json!({ "character": "x".repeat(129) }),
            json!({ "currentChapter": 0 }),
            json!({ "currentChapter": 100_001 }),
            json!({ "offset": 100_001 }),
            json!({ "includeDebt": "yes" }),
            json!({ "debtLevel": "high" }),
            json!({ "limit": 0 }),
            json!({ "limit": 101 }),
            json!({ "extra": 1 }),
        ] {
            let err = ForeshadowingListTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{bad}"
            );
        }

        let q_ch = build_character_read_query(&json!({
            "name": "林清",
            "query": "剑修",
            "aliveOnly": true,
            "includeAura": true,
            "includeState": true,
            "includeRelationships": false,
            "offset": ATOMIC_READ_MAX_OFFSET,
            "limit": 100
        }))
        .expect("character.read valid ok");
        assert_eq!(q_ch.op, "character-read");
        assert_eq!(q_ch.params.unwrap()["name"], json!("林清"));
        assert_eq!(
            CharacterReadTool.input_schema()["properties"]["offset"]["maximum"],
            json!(ATOMIC_READ_MAX_OFFSET)
        );

        for bad in [
            json!({ "name": "../secret" }),
            json!({ "name": "a/b" }),
            json!({ "name": r"a\b" }),
            json!({ "name": "a\0b" }),
            json!({ "name": "  " }),
            json!({ "query": "a\nb" }),
            json!({ "aliveOnly": 1 }),
            json!({ "offset": 100_001 }),
            json!({ "limit": 101 }),
            json!({ "extra": null }),
        ] {
            let err = CharacterReadTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn outline_read_style_exemplars_and_chapter_search_validate_strictly() {
        // outline.read valid cases: chapterNumber + window mode caps limit at 200
        let q_out_win = build_outline_read_query(&json!({
            "chapterNumber": 15,
            "window": 3,
            "volume": 2,
            "includeSummaryOnly": true,
            "offset": 0,
            "limit": 200
        }))
        .expect("outline window valid");
        assert_eq!(q_out_win.op, "outline-read");
        let win_params = q_out_win.params.unwrap();
        assert_eq!(win_params["window"], json!(3));
        assert_eq!(win_params["limit"], json!(200));

        // outline.read filename mode allows limit up to 50_000 and offset up to 10_000_000
        let q_out_file = build_outline_read_query(&json!({
            "filename": "vol1.md",
            "chapterNumber": null,
            "volume": null,
            "window": null
        }))
        .expect("outline filename valid");
        assert_eq!(q_out_file.params, Some(json!({ "filename": "vol1.md" })));

        let q_out_file_max = build_outline_read_query(&json!({
            "filename": "vol1.md",
            "offset": OUTLINE_READ_MAX_OFFSET,
            "limit": OUTLINE_READ_FILE_MAX_LIMIT
        }))
        .expect("outline filename max limit/offset valid");
        let file_max_params = q_out_file_max.params.unwrap();
        assert_eq!(file_max_params["offset"], json!(OUTLINE_READ_MAX_OFFSET));
        assert_eq!(file_max_params["limit"], json!(OUTLINE_READ_FILE_MAX_LIMIT));

        let out_schema = OutlineReadTool.input_schema();
        assert_eq!(
            out_schema["properties"]["chapterNumber"]["maximum"],
            json!(ATOMIC_READ_MAX_CHAPTER)
        );
        assert_eq!(
            out_schema["properties"]["offset"]["maximum"],
            json!(OUTLINE_READ_MAX_OFFSET)
        );
        assert_eq!(
            out_schema["properties"]["limit"]["maximum"],
            json!(OUTLINE_READ_FILE_MAX_LIMIT)
        );

        let ctx = ToolContext::for_test();
        let orphan_window_err = OutlineReadTool
            .call(&ctx, &json!({ "window": 2 }))
            .await
            .unwrap_err();
        assert_eq!(
            orphan_window_err.code,
            crate::mcp_server::protocol::INVALID_PARAMS
        );
        assert!(
            orphan_window_err
                .message
                .contains("outline.read: window requires chapterNumber"),
            "unexpected error: {}",
            orphan_window_err.message
        );

        for bad in [
            json!({ "filename": "vol1.md", "chapterNumber": 1 }),
            json!({ "filename": "vol1.md", "volume": 1 }),
            json!({ "filename": "vol1.md", "window": 0 }),
            json!({ "filename": "vol1.md", "window": 2 }),
            json!({ "window": 0 }),
            json!({ "window": 2 }),
            json!({ "volume": 1, "window": 2 }),
            json!({ "chapterNumber": 1, "limit": 201 }),
            json!({ "volume": 1, "limit": 201 }),
            json!({ "limit": 201 }),
            json!({ "chapterNumber": 100_001 }),
            json!({ "offset": 10_000_001 }),
            json!({ "filename": "vol1.md", "offset": 10_000_001 }),
            json!({ "filename": "vol1.md", "limit": 50_001 }),
            json!({ "filename": "../vol1.md" }),
            json!({ "filename": "sub/vol1.md" }),
            json!({ "filename": "vol1.txt" }),
            json!({ "filename": "CON.md" }),
            json!({ "chapterNumber": 1, "window": 11 }),
            json!({ "volume": 0 }),
            json!({ "volume": 1001 }),
        ] {
            let err = OutlineReadTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{bad}"
            );
        }

        // style.exemplars valid & dedup
        let q_style = build_style_exemplars_query(&json!({
            "markTypes": ["style", "voice", "style", "pacing"],
            "category": "打斗描写",
            "chapterId": "chapter-005",
            "topK": 10,
            "maxCharsPerItem": 1200,
            "offset": ATOMIC_READ_MAX_OFFSET,
            "limit": 20
        }))
        .expect("style.exemplars valid");
        assert_eq!(q_style.op, "style-exemplars");
        assert_eq!(
            q_style.params.unwrap()["markTypes"],
            json!(["style", "voice", "pacing"])
        );
        assert_eq!(
            StyleExemplarsTool.input_schema()["properties"]["offset"]["maximum"],
            json!(ATOMIC_READ_MAX_OFFSET)
        );

        for bad in [
            json!({ "markTypes": [] }),
            json!({ "markTypes": ["unknown"] }),
            json!({ "markTypes": ["style", "voice", "pacing", "thrill", "pull", "consistency", "style"] }),
            json!({ "category": "a\nb" }),
            json!({ "chapterId": "   " }),
            json!({ "topK": 0 }),
            json!({ "topK": 51 }),
            json!({ "maxCharsPerItem": 99 }),
            json!({ "maxCharsPerItem": 4001 }),
            json!({ "offset": 100_001 }),
            json!({ "limit": 51 }),
        ] {
            let err = StyleExemplarsTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{bad}"
            );
        }

        // chapter.search valid & inverted range
        let q_search = build_chapter_search_query(&json!({
            "query": "黑铁剑",
            "scope": "all",
            "chapterStart": 5,
            "chapterEnd": ATOMIC_READ_MAX_CHAPTER,
            "limit": 25,
            "contextChars": 120
        }))
        .expect("chapter.search valid");
        assert_eq!(q_search.op, "chapter-search");
        assert_eq!(q_search.params.unwrap()["scope"], json!("all"));
        let search_schema = ChapterSearchTool.input_schema();
        assert_eq!(
            search_schema["properties"]["chapterStart"]["maximum"],
            json!(ATOMIC_READ_MAX_CHAPTER)
        );
        assert_eq!(
            search_schema["properties"]["chapterEnd"]["maximum"],
            json!(ATOMIC_READ_MAX_CHAPTER)
        );

        let q_eq_range = build_chapter_search_query(&json!({
            "query": "黑铁剑",
            "chapterStart": 5,
            "chapterEnd": 5,
            "scope": null
        }))
        .expect("equal start/end ok");
        assert_eq!(q_eq_range.params.unwrap()["chapterStart"], json!(5));

        for bad in [
            json!({}),
            json!({ "query": null }),
            json!({ "query": "   " }),
            json!({ "query": "a\nb" }),
            json!({ "query": "字".repeat(257) }),
            json!({ "query": "ok", "scope": "invalid" }),
            json!({ "query": "ok", "chapterStart": 10, "chapterEnd": 9 }),
            json!({ "query": "ok", "chapterStart": 0 }),
            json!({ "query": "ok", "chapterStart": 100_001 }),
            json!({ "query": "ok", "chapterEnd": 100_001 }),
            json!({ "query": "ok", "limit": 51 }),
            json!({ "query": "ok", "contextChars": 39 }),
            json!({ "query": "ok", "contextChars": 401 }),
        ] {
            let err = ChapterSearchTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{bad}"
            );
        }

        // Advisory #2: draft.record_review dimensionScores schema documents the 6 canonical keys
        let review_schema = DraftRecordReviewTool.input_schema();
        let dim_desc = review_schema["properties"]["dimensionScores"]["description"]
            .as_str()
            .expect("dimensionScores description");
        assert!(
            dim_desc.contains("thrill, consistency, pacing, character, continuity, pull"),
            "dimensionScores description missing canonical six keys: {dim_desc}"
        );
    }

    #[tokio::test]
    async fn draft_diff_validates_modes_bounds_and_null_tolerance_strictly() {
        // Mode 1: draft vs draft (baseDraftId + targetDraftId), optional compareToFormal=false & null-stripped fields.
        let q_mode1 = build_draft_diff_query(&json!({
            "baseDraftId": "draft_base-1",
            "targetDraftId": "draft_target-2",
            "draftId": null,
            "chapterNumber": null,
            "compareToFormal": false,
            "contextLines": 0,
            "maxHunks": 200,
            "maxChars": 50_000
        }))
        .expect("mode 1 valid");
        assert_eq!(q_mode1.op, "draft-diff");
        let p1 = q_mode1.params.expect("params");
        assert_eq!(p1["baseDraftId"], json!("draft_base-1"));
        assert_eq!(p1["targetDraftId"], json!("draft_target-2"));
        assert_eq!(p1["compareToFormal"], json!(false));
        assert_eq!(p1["contextLines"], json!(0));
        assert_eq!(p1["maxHunks"], json!(200));
        assert_eq!(p1["maxChars"], json!(50_000));
        assert!(p1.get("draftId").is_none());

        // Mode 1 without compareToFormal
        let q_mode1_min = build_draft_diff_query(&json!({
            "baseDraftId": "d1",
            "targetDraftId": "d2",
            "contextLines": 10,
            "maxHunks": 1,
            "maxChars": 500
        }))
        .expect("mode 1 min valid");
        let p1_min = q_mode1_min.params.expect("params");
        assert!(p1_min.get("compareToFormal").is_none());

        // Mode 2: draft vs formal (draftId + optional chapterNumber), normalizes compareToFormal=true.
        let q_mode2 = build_draft_diff_query(&json!({
            "draftId": "draft_003",
            "chapterNumber": 3,
            "baseDraftId": null,
            "targetDraftId": null,
            "compareToFormal": null
        }))
        .expect("mode 2 valid");
        assert_eq!(q_mode2.op, "draft-diff");
        let p2 = q_mode2.params.expect("params");
        assert_eq!(p2["draftId"], json!("draft_003"));
        assert_eq!(p2["chapterNumber"], json!(3));
        assert_eq!(p2["compareToFormal"], json!(true));

        let q_mode2_explicit = build_draft_diff_query(&json!({
            "draftId": "draft_003",
            "compareToFormal": true
        }))
        .expect("mode 2 explicit compareToFormal=true valid");
        assert_eq!(
            q_mode2_explicit.params.expect("params")["compareToFormal"],
            json!(true)
        );

        let schema = DraftDiffTool.input_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["contextLines"]["maximum"], json!(10));
        assert_eq!(schema["properties"]["maxHunks"]["maximum"], json!(200));
        assert_eq!(schema["properties"]["maxChars"]["minimum"], json!(500));
        assert_eq!(schema["properties"]["maxChars"]["maximum"], json!(50_000));

        let ctx = ToolContext::for_test();
        for bad in [
            // Neither mode present / orphan fields / all null
            json!({}),
            json!({ "chapterNumber": 5 }),
            json!({ "compareToFormal": true }),
            json!({ "compareToFormal": false }),
            json!({ "baseDraftId": null, "targetDraftId": null, "draftId": null }),
            // Partial mode 1
            json!({ "baseDraftId": "d1" }),
            json!({ "targetDraftId": "d2" }),
            // Forbidden cross-field combinations in mode 1
            json!({ "baseDraftId": "d1", "targetDraftId": "d2", "draftId": "d3" }),
            json!({ "baseDraftId": "d1", "targetDraftId": "d2", "chapterNumber": 1 }),
            json!({ "baseDraftId": "d1", "targetDraftId": "d2", "compareToFormal": true }),
            // Forbidden cross-field combination in mode 2
            json!({ "draftId": "d1", "compareToFormal": false }),
            // Bad ASCII IDs & bounds
            json!({ "draftId": "" }),
            json!({ "draftId": "bad/id" }),
            json!({ "draftId": "a".repeat(129) }),
            json!({ "baseDraftId": "bad id", "targetDraftId": "d2" }),
            json!({ "baseDraftId": "d1", "targetDraftId": "../x" }),
            json!({ "draftId": "d1", "chapterNumber": 0 }),
            json!({ "draftId": "d1", "chapterNumber": 100_001 }),
            json!({ "draftId": "d1", "compareToFormal": "true" }),
            json!({ "draftId": "d1", "contextLines": -1 }),
            json!({ "draftId": "d1", "contextLines": 11 }),
            json!({ "draftId": "d1", "maxHunks": 0 }),
            json!({ "draftId": "d1", "maxHunks": 201 }),
            json!({ "draftId": "d1", "maxChars": 499 }),
            json!({ "draftId": "d1", "maxChars": 50_001 }),
            // Unknown keys even when null
            json!({ "draftId": "d1", "unknown": null }),
            json!({ "draftId": "d1", "extra": 1 }),
        ] {
            let err = DraftDiffTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "draft.diff must reject bad args: {bad}"
            );
        }
    }

    #[tokio::test]
    async fn audit_longform_health_validates_bounds_sections_and_exclusivity_strictly() {
        // Empty {} is valid!
        let q_empty = build_audit_longform_health_query(&json!({})).expect("empty ok");
        assert_eq!(q_empty.op, "audit-longform-health");
        assert_eq!(q_empty.params, Some(json!({})));

        // Full valid query with section dedup, chapter window, null-stripped volume, and boundary threshold.
        let q_win = build_audit_longform_health_query(&json!({
            "currentChapter": 50,
            "chapterStart": 10,
            "chapterEnd": 50,
            "volume": null,
            "sections": ["foreshadowing", "emotion", "foreshadowing", "canonRisk"],
            "topK": 50,
            "includeDetails": true,
            "emotionBreakerThreshold": -0.6
        }))
        .expect("window query valid");
        let p_win = q_win.params.expect("params");
        assert_eq!(p_win["currentChapter"], json!(50));
        assert_eq!(p_win["chapterStart"], json!(10));
        assert_eq!(p_win["chapterEnd"], json!(50));
        assert!(p_win.get("volume").is_none());
        assert_eq!(
            p_win["sections"],
            json!(["foreshadowing", "emotion", "canonRisk"])
        );
        assert_eq!(p_win["topK"], json!(50));
        assert_eq!(p_win["includeDetails"], json!(true));
        assert_eq!(p_win["emotionBreakerThreshold"], json!(-0.6));

        // Volume mode + threshold boundary extremes (-10.0 and 0.0)
        let q_vol = build_audit_longform_health_query(&json!({
            "volume": 1000,
            "sections": ["chaseDebt", "drafts"],
            "topK": 1,
            "includeDetails": false,
            "emotionBreakerThreshold": -10.0
        }))
        .expect("volume query valid");
        assert_eq!(q_vol.params.as_ref().unwrap()["volume"], json!(1000));
        assert_eq!(
            q_vol.params.as_ref().unwrap()["emotionBreakerThreshold"],
            json!(-10.0)
        );

        let q_zero = build_audit_longform_health_query(&json!({
            "chapterStart": 5,
            "chapterEnd": 5,
            "emotionBreakerThreshold": 0
        }))
        .expect("zero threshold & equal range valid");
        assert_eq!(
            q_zero.params.as_ref().unwrap()["emotionBreakerThreshold"],
            json!(0.0)
        );

        let schema = AuditLongformHealthTool.input_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["volume"]["maximum"], json!(1000));
        assert_eq!(schema["properties"]["topK"]["maximum"], json!(50));
        assert_eq!(
            schema["properties"]["emotionBreakerThreshold"]["minimum"],
            json!(-10.0)
        );
        assert_eq!(
            schema["properties"]["emotionBreakerThreshold"]["maximum"],
            json!(0.0)
        );

        let ctx = ToolContext::for_test();
        for bad in [
            json!({ "currentChapter": 0 }),
            json!({ "currentChapter": 100_001 }),
            json!({ "chapterStart": 0 }),
            json!({ "chapterStart": 100_001 }),
            json!({ "chapterEnd": 0 }),
            json!({ "chapterEnd": 100_001 }),
            json!({ "chapterStart": 12, "chapterEnd": 11 }),
            json!({ "volume": 0 }),
            json!({ "volume": 1001 }),
            json!({ "volume": 1, "chapterStart": 1 }),
            json!({ "volume": 1, "chapterEnd": 10 }),
            json!({ "volume": 1, "chapterStart": 1, "chapterEnd": 10 }),
            json!({ "sections": [] }),
            json!({ "sections": "emotion" }),
            json!({ "sections": [123] }),
            json!({ "sections": ["unknown"] }),
            json!({ "sections": ["foreshadowing", "chaseDebt", "emotion", "drafts", "canonRisk", "emotion"] }),
            json!({ "topK": 0 }),
            json!({ "topK": 51 }),
            json!({ "includeDetails": "true" }),
            json!({ "emotionBreakerThreshold": 0.01 }),
            json!({ "emotionBreakerThreshold": -10.01 }),
            json!({ "emotionBreakerThreshold": "-0.6" }),
            json!({ "unknown": null }),
        ] {
            let err = AuditLongformHealthTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "audit.longform_health must reject bad args: {bad}"
            );
        }
    }

    #[tokio::test]
    async fn six_planning_write_tools_enforce_strict_schemas_null_tolerance_and_project_scope() {
        let reg = build_registry();
        assert_eq!(reg.len(), 50, "全量工具注册表应为 50 个");
        assert!(!reg.names().contains(&"draft.accept"), "绝不允许注册 draft.accept");

        let new_tools = [
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ];
        for name in new_tools {
            assert_eq!(
                reg.required_scope(name),
                Some(crate::mcp_server::session::SessionScope::Project),
                "{name} 必须声明 Project scope"
            );
            assert!(reg.privileged_tools().contains(&name));
        }

        // Schema strictness
        for schema in [
            DirectorUpsertWorldTool.input_schema(),
            DirectorCommitPhaseTool.input_schema(),
            RulesUpsertBookRulesTool.input_schema(),
            CompassUpdateTool.input_schema(),
            ForeshadowingUpsertTool.input_schema(),
            SubplotUpsertTool.input_schema(),
        ] {
            assert_eq!(schema["type"], json!("object"));
            assert_eq!(schema["additionalProperties"], json!(false));
        }

        // 1. director.upsert_world valid + optional null tolerance
        let q_world = build_director_upsert_world_query(&json!({
            "worldType": "东方玄幻",
            "mode": null,
            "layers": {
                "axioms": ["灵气守恒", "灵气守恒"],
                "background": ["三千年前天倾"],
                "magicSystem": null
            },
            "crossRefs": [{ "from": "axioms", "to": "background", "term": "天倾" }],
            "fillMissingRequired": true
        }))
        .expect("director.upsert_world valid");
        assert_eq!(q_world.op, "director-upsert-world");
        let p_world = q_world.params.expect("params");
        assert_eq!(p_world["layers"]["axioms"], json!(["灵气守恒"]));
        assert!(p_world["layers"].get("magicSystem").is_none());
        assert_eq!(p_world["fillMissingRequired"], json!(true));

        // 2. director.commit_phase valid (empty & with idea + optional nulls)
        let q_commit_empty = build_director_commit_phase_query(&json!({})).expect("empty valid");
        assert_eq!(q_commit_empty.op, "director-commit-phase");
        let q_commit = build_director_commit_phase_query(&json!({
            "idea": { "title": "租借之躯", "genre": "都市异能", "coreConflict": null },
            "expectedPhase": "idea",
            "retryIfFailed": true,
            "persistOnBlocked": null
        }))
        .expect("commit with idea valid");
        assert_eq!(q_commit.params.as_ref().unwrap()["expectedPhase"], json!("idea"));
        assert_eq!(q_commit.params.as_ref().unwrap()["idea"]["title"], json!("租借之躯"));

        // 3. rules.upsert_book_rules valid
        let q_rules = build_rules_upsert_book_rules_query(&json!({
            "mode": "merge",
            "prohibitions": ["主角死亡", "主角死亡"],
            "allowedDeviations": null,
            "protagonist": { "name": "林澈", "personalityLock": ["冷静"], "behavioralConstraints": null },
            "genreLock": { "primary": "刑侦", "forbidden": ["修仙"] },
            "eraConstraints": { "enabled": true, "anachronismTerms": ["智能手机"], "period": "1990s", "region": null },
            "fanficMode": "canon"
        }))
        .expect("rules.upsert_book_rules valid");
        assert_eq!(q_rules.op, "rules-upsert-book-rules");
        assert_eq!(q_rules.params.as_ref().unwrap()["prohibitions"], json!(["主角死亡"]));

        // replace mode with no rule fields allowed (resets to empty)
        let q_rules_reset = build_rules_upsert_book_rules_query(&json!({ "mode": "replace" }))
            .expect("replace reset valid");
        assert_eq!(q_rules_reset.params.as_ref().unwrap()["mode"], json!("replace"));

        // 4. compass.update valid
        let q_compass = build_compass_update_query(&json!({
            "endingDirection": "终局抉择",
            "newThreads": ["古玉秘密"],
            "resolvedThreads": null,
            "estimatedScale": "预计 4-6 卷",
            "declareFinalVolume": 5
        }))
        .expect("compass.update valid");
        assert_eq!(q_compass.op, "compass-update");
        assert_eq!(q_compass.params.as_ref().unwrap()["declareFinalVolume"], json!(5));

        // 5. foreshadowing.upsert valid
        let q_fs = build_foreshadowing_upsert_query(&json!({
            "id": "fs_01",
            "name": "青铜古镜",
            "status": "advanced",
            "plantedChapter": 1,
            "advancedChapters": [5, 3, 5],
            "resolvedChapter": null,
            "relatedCharacters": ["林澈"]
        }))
        .expect("foreshadowing.upsert valid");
        assert_eq!(q_fs.op, "foreshadowing-upsert");
        assert_eq!(q_fs.params.as_ref().unwrap()["advancedChapters"], json!([3, 5]));

        // 6. subplot.upsert valid
        let q_sp = build_subplot_upsert_query(&json!({
            "title": "失踪案支线",
            "status": "active",
            "startChapter": 2,
            "lastSeenChapter": 10,
            "targetResolutionChapter": 30,
            "abandoned": false,
            "progressEntry": "第10章发现旧钥匙",
            "notes": null
        }))
        .expect("subplot.upsert valid");
        assert_eq!(q_sp.op, "subplot-upsert");
        assert_eq!(q_sp.params.as_ref().unwrap()["progressEntry"], json!("第10章发现旧钥匙"));

        // Reject invalid payloads across all 6 tools
        let ctx = ToolContext::for_test();
        let bad_cases: [(&dyn McpTool, Value); 14] = [
            (&DirectorUpsertWorldTool, json!({})),
            (&DirectorUpsertWorldTool, json!({ "layers": { "badLayer": ["x"] } })),
            (&DirectorUpsertWorldTool, json!({ "unknown": null })),
            (&DirectorCommitPhaseTool, json!({ "expectedPhase": "bogus" })),
            (&DirectorCommitPhaseTool, json!({ "idea": { "title": "   " } })),
            (&RulesUpsertBookRulesTool, json!({})),
            (&RulesUpsertBookRulesTool, json!({ "fanficMode": "invalid" })),
            (&RulesUpsertBookRulesTool, json!({ "protagonist": { "name": null } })),
            (&CompassUpdateTool, json!({})),
            (&CompassUpdateTool, json!({ "declareFinalVolume": 0 })),
            (&ForeshadowingUpsertTool, json!({})),
            (&ForeshadowingUpsertTool, json!({ "id": "../escape", "name": "x" })),
            (&SubplotUpsertTool, json!({})),
            (&SubplotUpsertTool, json!({ "title": "x", "status": "bogus" })),
        ];
        for (tool, bad) in bad_cases {
            let err = tool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{} must reject bad args: {bad}",
                tool.name()
            );
        }
    }

    #[tokio::test]
    async fn wave2_four_readonly_tools_enforce_strict_schemas_null_tolerance_and_read_scope() {
        let reg = build_registry();
        assert_eq!(reg.len(), 50, "全量注册表应为 50 个工具");
        assert_eq!(reg.privileged_tools().len(), 22, "privileged 工具数必须严格锁定 22");
        assert!(!reg.names().contains(&"draft.accept"), "绝不允许注册 draft.accept");

        let write_like = crate::mcp_server::contains_write_like_tool(&reg);
        let new_tools = [
            "skills.list",
            "skills.get",
            "canon.facts_known_by",
            "canon.episodes",
        ];
        for name in new_tools {
            assert_eq!(
                reg.required_scope(name),
                Some(SessionScope::Read),
                "{name} 必须严格为 SessionScope::Read"
            );
            assert!(
                !reg.privileged_tools().contains(&name),
                "{name} 不得进入 privileged 列表"
            );
            assert!(
                !write_like.contains(&name),
                "WRITE_HINTS 不得误报 {name}"
            );
        }

        for schema in [
            SkillsListTool.input_schema(),
            SkillsGetTool.input_schema(),
            CanonFactsKnownByTool.input_schema(),
            CanonEpisodesTool.input_schema(),
        ] {
            assert_eq!(schema["type"], json!("object"));
            assert_eq!(schema["additionalProperties"], json!(false));
        }

        // 1. skills.list: empty, full, and explicit optional nulls
        let q_list_empty = build_skills_list_query(&json!({})).expect("skills.list empty ok");
        assert_eq!(q_list_empty.op, "skills-list");
        assert_eq!(q_list_empty.params, Some(json!({})));

        let q_list_nulls = build_skills_list_query(&json!({
            "stage": null,
            "kind": null,
            "includeDeAi": null,
            "includeBuiltin": null,
            "enabledOnly": null,
            "query": null,
            "offset": null,
            "limit": null
        }))
        .expect("skills.list optional nulls ok");
        assert_eq!(q_list_nulls.params, Some(json!({})));

        let q_list_full = build_skills_list_query(&json!({
            "stage": "outline",
            "kind": "writing",
            "includeDeAi": false,
            "includeBuiltin": true,
            "enabledOnly": true,
            "query": "  节奏  ",
            "offset": 0,
            "limit": 50
        }))
        .expect("skills.list full ok");
        assert_eq!(
            q_list_full.params,
            Some(json!({
                "stage": "outline",
                "kind": "writing",
                "includeDeAi": false,
                "includeBuiltin": true,
                "enabledOnly": true,
                "query": "节奏",
                "offset": 0,
                "limit": 50
            }))
        );

        // 2. skills.get: ids/names/stage selectors, dedup/trim, optional nulls
        let q_get_ids = build_skills_get_query(&json!({
            "ids": [" skill-a ", "skill-a", "skill-b"],
            "names": null,
            "stage": null,
            "includeDeAi": null,
            "includeDisabled": true,
            "stripFrontmatter": false,
            "maxCharsPerSkill": 6000,
            "maxTotalChars": 18000
        }))
        .expect("skills.get ids ok");
        assert_eq!(q_get_ids.op, "skills-get");
        assert_eq!(
            q_get_ids.params,
            Some(json!({
                "ids": ["skill-a", "skill-b"],
                "includeDisabled": true,
                "stripFrontmatter": false,
                "maxCharsPerSkill": 6000,
                "maxTotalChars": 18000
            }))
        );

        let q_get_stage = build_skills_get_query(&json!({
            "stage": "review",
            "ids": null,
            "names": null,
            "maxCharsPerSkill": null,
            "maxTotalChars": null
        }))
        .expect("skills.get stage ok");
        assert_eq!(q_get_stage.params, Some(json!({ "stage": "review" })));

        // 3. canon.facts_known_by: required pov + default limit=50 + optional nulls
        let parsed_pov_default = parse_canon_facts_known_by_args(&json!({
            "pov": "  林澈  ",
            "atChapter": null,
            "includeInvalidated": null,
            "offset": null,
            "limit": null
        }))
        .expect("canon.facts_known_by defaults ok");
        assert_eq!(
            parsed_pov_default,
            ParsedCanonFactsKnownByArgs {
                pov: "林澈".to_string(),
                at_chapter: None,
                include_invalidated: None,
                offset: None,
                limit: Some(50),
            }
        );

        let parsed_pov_full = parse_canon_facts_known_by_args(&json!({
            "pov": "alice",
            "atChapter": 12,
            "includeInvalidated": true,
            "offset": 5,
            "limit": 200
        }))
        .expect("canon.facts_known_by full ok");
        assert_eq!(
            parsed_pov_full,
            ParsedCanonFactsKnownByArgs {
                pov: "alice".to_string(),
                at_chapter: Some(12),
                include_invalidated: Some(true),
                offset: Some(5),
                limit: Some(200),
            }
        );

        // 4. canon.episodes: required chapterNumber + default limit=50 + optional nulls
        let parsed_ep_default = parse_canon_episodes_args(&json!({
            "chapterNumber": 7,
            "offset": null,
            "limit": null
        }))
        .expect("canon.episodes defaults ok");
        assert_eq!(
            parsed_ep_default,
            ParsedCanonEpisodesArgs {
                chapter_number: 7,
                offset: None,
                limit: Some(50),
            }
        );

        let parsed_ep_full = parse_canon_episodes_args(&json!({
            "chapterNumber": 100_000,
            "offset": 10,
            "limit": 1
        }))
        .expect("canon.episodes full ok");
        assert_eq!(
            parsed_ep_full,
            ParsedCanonEpisodesArgs {
                chapter_number: 100_000,
                offset: Some(10),
                limit: Some(1),
            }
        );

        // Fail-closed validation across all 4 tools before touching bridge or AppHandle
        let ctx = ToolContext::for_test();
        let over_pov = "a".repeat(CANON_POV_MAX_CHARS + 1);
        let over_query = "q".repeat(SKILLS_MAX_QUERY_CHARS + 1);
        let too_many_ids: Vec<String> = (0..=SKILLS_MAX_SELECTOR_ITEMS)
            .map(|i| format!("id-{i}"))
            .collect();
        let bad_cases: [(&dyn McpTool, Value); 31] = [
            // skills.list
            (&SkillsListTool, json!({ "unknown": null })),
            (&SkillsListTool, json!({ "stage": "bogus" })),
            (&SkillsListTool, json!({ "kind": "invalid" })),
            (&SkillsListTool, json!({ "enabledOnly": "true" })),
            (&SkillsListTool, json!({ "query": "   " })),
            (&SkillsListTool, json!({ "query": "line1\nline2" })),
            (&SkillsListTool, json!({ "query": over_query })),
            (&SkillsListTool, json!({ "limit": 0 })),
            (&SkillsListTool, json!({ "limit": 201 })),
            (&SkillsListTool, json!({ "offset": 100_001 })),
            // skills.get
            (&SkillsGetTool, json!({})),
            (&SkillsGetTool, json!({ "ids": null, "names": null, "stage": null })),
            (&SkillsGetTool, json!({ "stage": "review", "extra": null })),
            (&SkillsGetTool, json!({ "ids": [] })),
            (&SkillsGetTool, json!({ "ids": ["   "] })),
            (&SkillsGetTool, json!({ "ids": ["a\nb"] })),
            (&SkillsGetTool, json!({ "ids": too_many_ids })),
            (&SkillsGetTool, json!({ "stage": "review", "maxCharsPerSkill": 199 })),
            (&SkillsGetTool, json!({ "stage": "review", "maxCharsPerSkill": 20_001 })),
            (&SkillsGetTool, json!({ "stage": "review", "maxTotalChars": 499 })),
            (&SkillsGetTool, json!({ "stage": "review", "maxTotalChars": 30_001 })),
            // canon.facts_known_by
            (&CanonFactsKnownByTool, json!({})),
            (&CanonFactsKnownByTool, json!({ "pov": null })),
            (&CanonFactsKnownByTool, json!({ "pov": "   " })),
            (&CanonFactsKnownByTool, json!({ "pov": "alice\nbob" })),
            (&CanonFactsKnownByTool, json!({ "pov": over_pov })),
            (&CanonFactsKnownByTool, json!({ "pov": "alice", "atChapter": 0 })),
            (&CanonFactsKnownByTool, json!({ "pov": "alice", "limit": 201 })),
            (&CanonFactsKnownByTool, json!({ "pov": "alice", "unknown": null })),
            // canon.episodes
            (&CanonEpisodesTool, json!({ "chapterNumber": 0 })),
            (&CanonEpisodesTool, json!({ "chapterNumber": 1, "unknown": null })),
        ];
        for (tool, bad) in bad_cases {
            let err = tool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "{} must reject bad args: {bad}",
                tool.name()
            );
        }
        // Additional canon.episodes missing / negative / out-of-range checks
        for bad in [
            json!({}),
            json!({ "chapterNumber": null }),
            json!({ "chapterNumber": -1 }),
            json!({ "chapterNumber": 100_001 }),
            json!({ "chapterNumber": 1, "limit": 0 }),
            json!({ "chapterNumber": 1, "limit": 201 }),
            json!({ "chapterNumber": 1, "offset": 100_001 }),
        ] {
            let err = CanonEpisodesTool.call(&ctx, &bad).await.unwrap_err();
            assert_eq!(
                err.code,
                crate::mcp_server::protocol::INVALID_PARAMS,
                "canon.episodes must reject bad args: {bad}"
            );
        }
    }

    #[tokio::test]
    async fn canon_facts_known_by_and_episodes_verify_real_temp_canon_store() {
        use crate::canon::commands::CanonCommandState;
        use crate::canon::commands_core::{
            canon_facts_known_by_impl, canon_ingest_episode_impl, canon_query_episodes_impl,
        };
        use crate::canon::store::CanonStore;
        use crate::canon::types::{CanonEdge, CanonEpisode, EdgeKind};

        struct TempCanonDir(PathBuf);
        impl Drop for TempCanonDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        let dir = TempCanonDir(std::env::temp_dir().join(format!(
            "nb-mcp-canon-read-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        )));
        std::fs::create_dir_all(&dir.0).expect("create temp canon dir");
        let project_id = dir.0.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // Seed real CanonStore with POV-isolated edges + chapter episodes
        let store = CanonStore::open(&project_id).await.expect("open store");
        let make_edge = |id: &str, v: Option<i32>, inv: Option<i32>, povs: &[&str]| {
            let mut e = CanonEdge::new(id, "hero", "artifact", "knows_location", EdgeKind::WorldFact);
            e.valid_at = v;
            e.invalid_at = inv;
            e.source_chapter = v;
            e.known_by = povs.iter().map(|s| s.to_string()).collect();
            e
        };
        store
            .upsert_edge(make_edge("e_alice_only", Some(1), None, &["alice"]))
            .await
            .expect("upsert alice edge");
        store
            .upsert_edge(make_edge("e_bob_only", Some(1), None, &["bob"]))
            .await
            .expect("upsert bob edge");
        store
            .upsert_edge(make_edge(
                "e_shared_capped",
                Some(1),
                Some(5),
                &["alice", "bob"],
            ))
            .await
            .expect("upsert shared capped edge");
        drop(store);

        for (ep_id, chapter, digest) in [
            ("ep_ch3_1", 3, "digest-3-1"),
            ("ep_ch3_2", 3, "digest-3-2"),
            ("ep_ch3_3", 3, "digest-3-3"),
            ("ep_ch4_1", 4, "digest-4-1"),
        ] {
            canon_ingest_episode_impl(
                &state,
                project_id.clone(),
                CanonEpisode::new(ep_id, chapter, "alice", digest),
            )
            .await
            .expect("ingest episode");
        }
        let rev_after_ingest = state.current_revision(&project_id);
        assert_eq!(rev_after_ingest, 4);

        // 1) POV alice @ chapter 4: sees e_alice_only + e_shared_capped, strictly excludes e_bob_only
        let p1 = parse_canon_facts_known_by_args(&json!({
            "pov": "alice",
            "atChapter": 4
        }))
        .expect("parse pov ch4");
        let r1 = canon_facts_known_by_impl(
            &state,
            project_id.clone(),
            p1.pov,
            p1.at_chapter,
            p1.include_invalidated,
            p1.offset,
            p1.limit,
        )
        .await
        .expect("facts known by alice ch4");
        let r1_ids: Vec<&str> = r1.edges.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(r1.total, 2);
        assert!(r1_ids.contains(&"e_alice_only"));
        assert!(r1_ids.contains(&"e_shared_capped"));
        assert!(!r1_ids.contains(&"e_bob_only"), "严禁泄露非 alice 已知事实");
        assert_eq!(r1.max_revision, rev_after_ingest, "纯读不得自增 revision");

        // 2) POV alice @ chapter 6 without invalidated: only e_alice_only survives
        let p2 = parse_canon_facts_known_by_args(&json!({
            "pov": "alice",
            "atChapter": 6,
            "includeInvalidated": false
        }))
        .expect("parse pov ch6 active");
        let r2 = canon_facts_known_by_impl(
            &state,
            project_id.clone(),
            p2.pov,
            p2.at_chapter,
            p2.include_invalidated,
            p2.offset,
            p2.limit,
        )
        .await
        .expect("facts known by alice ch6");
        assert_eq!(r2.total, 1);
        assert_eq!(r2.edges.len(), 1);
        assert_eq!(r2.edges[0].id, "e_alice_only");

        // 3) POV alice pagination + includeInvalidated=true still isolates bob's exclusive fact
        let p3 = parse_canon_facts_known_by_args(&json!({
            "pov": "alice",
            "includeInvalidated": true,
            "offset": 0,
            "limit": 1
        }))
        .expect("parse pov paged");
        let r3 = canon_facts_known_by_impl(
            &state,
            project_id.clone(),
            p3.pov,
            p3.at_chapter,
            p3.include_invalidated,
            p3.offset,
            p3.limit,
        )
        .await
        .expect("facts known by alice paged");
        assert_eq!(r3.total, 2);
        assert_eq!(r3.edges.len(), 1);
        assert_ne!(r3.edges[0].id, "e_bob_only");

        // 4) Unrelated POV carol sees zero facts
        let r_carol = canon_facts_known_by_impl(
            &state,
            project_id.clone(),
            "carol".to_string(),
            None,
            Some(true),
            None,
            Some(50),
        )
        .await
        .expect("carol empty");
        assert_eq!(r_carol.total, 0);
        assert!(r_carol.edges.is_empty());

        // 5) canon.episodes pagination for chapter 3 (total=3, page1=2, page2=1) and chapter 4 (total=1)
        let ep_p1 = parse_canon_episodes_args(&json!({
            "chapterNumber": 3,
            "offset": 0,
            "limit": 2
        }))
        .expect("parse episodes ch3 p1");
        let ep_r1 = canon_query_episodes_impl(
            &state,
            project_id.clone(),
            ep_p1.chapter_number,
            ep_p1.offset,
            ep_p1.limit,
        )
        .await
        .expect("query episodes ch3 p1");
        assert_eq!(ep_r1.total, 3);
        assert_eq!(ep_r1.episodes.len(), 2);
        assert!(ep_r1.episodes.iter().all(|ep| ep.chapter_number == 3));
        assert_eq!(ep_r1.max_revision, rev_after_ingest);

        let ep_p2 = parse_canon_episodes_args(&json!({
            "chapterNumber": 3,
            "offset": 2,
            "limit": 2
        }))
        .expect("parse episodes ch3 p2");
        let ep_r2 = canon_query_episodes_impl(
            &state,
            project_id.clone(),
            ep_p2.chapter_number,
            ep_p2.offset,
            ep_p2.limit,
        )
        .await
        .expect("query episodes ch3 p2");
        assert_eq!(ep_r2.total, 3);
        assert_eq!(ep_r2.episodes.len(), 1);
        assert_eq!(ep_r2.episodes[0].chapter_number, 3);

        let ep_ch4 = parse_canon_episodes_args(&json!({ "chapterNumber": 4 }))
            .expect("parse episodes ch4");
        let ep_r4 = canon_query_episodes_impl(
            &state,
            project_id.clone(),
            ep_ch4.chapter_number,
            ep_ch4.offset,
            ep_ch4.limit,
        )
        .await
        .expect("query episodes ch4");
        assert_eq!(ep_r4.total, 1);
        assert_eq!(ep_r4.episodes.len(), 1);
        assert_eq!(ep_r4.episodes[0].id, "ep_ch4_1");

        // Verify JSON serialization succeeds cleanly for both responses
        let facts_json = serde_json::to_value(&r1).expect("serialize facts response");
        assert_eq!(facts_json["total"], json!(2));
        let ep_json = serde_json::to_value(&ep_r1).expect("serialize episodes response");
        assert_eq!(ep_json["total"], json!(3));
    }
}
