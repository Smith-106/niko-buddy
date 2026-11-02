//! P0 只读工具集（方案 `d23eb1df`）。
//!
//! 全部只读。这是只读投影锁定（`architecture-constraints-400`）在工具层的落实：
//! 本文件不得出现任何 set / write / delete / accept 语义的工具。
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

use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::protocol::SERVER_VERSION;
use super::registry::ToolError;
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
}

impl ToolContext {
    /// 仅供测试：无 AppHandle 的上下文。
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            app: None,
            bridge: StateBridgeState::new(),
            port: 0,
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
/// 不读项目、不读设置：它回答的是「我在跟谁说话、它什么版本、什么模式」。
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
            Ok(json!({
                "version": SERVER_VERSION,
                "mode": if cfg!(debug_assertions) { "dev" } else { "production" },
                "listen": format!("127.0.0.1:{}", ctx.port),
                "readOnly": true,
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
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::invalid_params("settings.get requires string argument `key`"))?;
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
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::invalid_params("settings.set requires string argument `key`"))?;
            if key.trim().is_empty() {
                return Err(ToolError::invalid_params("`key` must not be empty"));
            }
            // `value` 必须显式给出：`null` 是合法值（清除模型选择），缺字段不是。
            let value = args
                .get("value")
                .ok_or_else(|| ToolError::invalid_params("settings.set requires argument `value`"))?;

            // 审计落点先就位，避免"改了但没有痕迹"。
            let project_path = ctx.project_path().await?;
            let audit_dir = std::path::Path::new(&project_path).join(".novel").join("audit");
            std::fs::create_dir_all(&audit_dir).map_err(|e| {
                ToolError::internal(format!(
                    "无法创建审计目录 {}: {e}；为安全起见本次写入未执行",
                    audit_dir.display()
                ))
            })?;
            let audit_path = audit_dir.join("external-writes.jsonl");
            let mut audit_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&audit_path)
                .map_err(|e| {
                    ToolError::internal(format!(
                        "审计文件不可写 {}: {e}；为安全起见本次写入未执行",
                        audit_path.display()
                    ))
                })?;

            let outcome = ctx
                .bridge_query(
                    StateQuery::with_key("set", key).with_value(value.clone()),
                )
                .await?;

            let before_hash = value_hash(outcome.get("before").unwrap_or(&Value::Null));
            let after_hash = value_hash(outcome.get("after").unwrap_or(&Value::Null));
            let record = ExternalWriteAudit {
                ts: chrono::Utc::now().to_rfc3339(),
                source: "external_agent",
                tool: "settings.set",
                key,
                before_hash: before_hash.clone(),
                after_hash: after_hash.clone(),
            };
            let line = serde_json::to_string(&record)
                .map_err(|e| ToolError::internal(format!("审计记录序列化失败: {e}")))?;
            use std::io::Write;
            if let Err(e) = writeln!(audit_file, "{line}") {
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
        Box::pin(async move {
            ctx.bridge_query(StateQuery::new("chapter-list")).await
        })
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

/// 构造 P0 只读注册表。
// ── P2：项目动作（全部转发既有管线/命令，不新造写路径）─────────────────────

/// 取必填字符串参数。缺失/类型不符一律 `INVALID_PARAMS`（协议层错误）。
fn require_str<'a>(args: &'a Value, tool: &str, field: &str) -> Result<&'a str, ToolError> {
    match args.get(field).and_then(|v| v.as_str()) {
        Some(v) if !v.trim().is_empty() => Ok(v),
        Some(_) => Err(ToolError::invalid_params(format!("{tool}: `{field}` 不能为空"))),
        None => Err(ToolError::invalid_params(format!(
            "{tool}: 缺少字符串参数 `{field}`"
        ))),
    }
}

/// 取可选正整数参数。给了就必须是正整数——静默忽略非法值会让调用方以为生效了。
fn optional_positive_int(
    args: &Value,
    tool: &str,
    field: &str,
) -> Result<Option<u64>, ToolError> {
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
                "workflowMode": { "type": "string", "enum": ["fast", "standard", "strict"], "description": "Pipeline depth (optional, defaults to the app setting)" }
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
            let chapter_number = optional_positive_int(args, "pipeline.run_chapter", "chapterNumber")?;
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

/// `pipeline.status` —— 长任务快照。
pub struct PipelineStatusTool;

impl super::registry::McpTool for PipelineStatusTool {
    fn name(&self) -> &'static str {
        "pipeline.status"
    }

    fn description(&self) -> &'static str {
        "Poll a pipeline task started by pipeline.run_chapter. Returns status, current stage, timings, the overall gate verdict, and any error. Never returns chapter text — read that through chapter.read after the user accepts the draft."
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
            Ok(json!({
                "taskId": snapshot.get("taskId").cloned().unwrap_or(json!(task_id)),
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
            }))
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

            let status = snapshot.get("status").and_then(|v| v.as_str()).unwrap_or("");
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
                let stage = snapshot.get("stage").and_then(|v| v.as_str()).unwrap_or("未知");
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
        "Write a chapter draft into the project draft area (.novel/drafts). Never writes a formal chapter: the user must accept the draft in the app first. Returns the draft id and path."
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

/// `memory.write` —— 当前**明确拒绝**（应用没有记忆草稿审阅入口）。
///
/// 保留注册是为了给调用方一个说清原因的答复，而不是让它对着 "unknown tool" 猜。
/// 详见 `src/lib/mcp/draft-actions.ts` 文件头的推导。

// ───────────────────────── P3：直写 + 快照 + 回滚 ─────────────────────────

/// 一次外部直写的审计记录（append-only JSONL 的一行）。
///
/// 与 `settings.set` 那条共用同一个文件、同一套 hash 口径，靠 `kind` 区分：
/// `direct_write` / `undo`。没有 `kind` 的是 P1 的设置写入（历史条目，不回溯改）。
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
fn open_audit_log(project_path: &str) -> Result<(std::fs::File, std::path::PathBuf), ToolError> {
    let audit_dir = std::path::Path::new(project_path).join(".novel").join("audit");
    std::fs::create_dir_all(&audit_dir).map_err(|e| {
        ToolError::internal(format!(
            "无法创建审计目录 {}: {e}；为安全起见本次写入未执行",
            audit_dir.display()
        ))
    })?;
    let audit_path = audit_dir.join("external-writes.jsonl");
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

fn append_audit_line(
    file: &mut std::fs::File,
    record: &DirectWriteAudit<'_>,
) -> Result<(), String> {
    let line = serde_json::to_string(record).map_err(|e| format!("审计记录序列化失败: {e}"))?;
    use std::io::Write;
    writeln!(file, "{line}").map_err(|e| format!("审计落盘失败: {e}"))
}

/// 已存在文件的 hash；文件不存在返回 `None`（而不是空串——两者语义不同）。
fn file_hash(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(super::writes::sha256_hex(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法读取 {} 以计算 hash: {e}", path.display())),
    }
}

/// 把审计行里的 `direct_write` 条目读出来（回滚用）。
fn read_direct_writes(project_path: &str) -> Result<Vec<serde_json::Value>, ToolError> {
    let audit_path = std::path::Path::new(project_path)
        .join(".novel")
        .join("audit")
        .join("external-writes.jsonl");
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
    let mut direct = Vec::new();
    // 已经回滚过的快照 id。用它把「已被撤销的直写」从栈里摘掉——否则连调两次
    // `undo_last(1)` 会重复还原同一条：用户以为退了两步，实际只退了一步。
    let mut undone: std::collections::HashSet<String> = std::collections::HashSet::new();
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
        match value.get("kind").and_then(|v| v.as_str()) {
            Some("direct_write") => direct.push(value),
            Some("undo") => {
                if let Some(reference) = value.get("snapshot_ref").and_then(|v| v.as_str()) {
                    undone.insert(reference.to_string());
                }
            }
            _ => {}
        }
    }
    // 保持写入顺序，只留下还没被撤销的。
    Ok(direct
        .into_iter()
        .filter(|entry| {
            entry
                .get("snapshot_ref")
                .and_then(|v| v.as_str())
                .map(|reference| !undone.contains(reference))
                .unwrap_or(true)
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
/// ## 为什么写走 `do_write_file_atomic`
///
/// 那条路会做虚拟路径映射（`wiki/` → `QM/`）、临时文件 + fsync + rename 的原子替换，
/// 并给文件监听打标记。自己 `fs::write` 会漏掉映射（写到一个不存在的 `wiki/` 目录），
/// 也会让界面看不到变化。
fn direct_write(
    project_path: &str,
    tool: &'static str,
    virtual_path: &str,
    contents: &str,
) -> Result<Value, ToolError> {
    use crate::canon::write_authority::{
        classify_target, may_write, requires_snapshot, WriteDecision, WriteSource,
    };

    let physical = crate::commands::fs::resolve_project_storage_path(virtual_path)
        .map_err(|e| ToolError::internal(format!("目标路径不合法（{virtual_path}）: {e}")))?;
    let physical_path = std::path::Path::new(&physical);

    // 矩阵判定：只有 Allow 才继续。RequireGate 的落点（用户资产引用 / 任意路径桶）
    // 不给外部 Agent 开口子，Deny 更不用说——两者都要说清是矩阵拒绝，不是 bug。
    match may_write(WriteSource::ExternalAgent, physical_path) {
        WriteDecision::Allow => {}
        other => {
            return Err(ToolError::permission(format!(
                "写入被写入权威矩阵拒绝：external_agent 对 {} 的判定是 {}（只允许 allow）。目标：{physical}",
                classify_target(physical_path).as_str(),
                other.as_str()
            )))
        }
    }

    let (mut audit_file, audit_path) = open_audit_log(project_path)?;

    let before = file_hash(physical_path)
        .map_err(|e| ToolError::internal(format!("{e}；为安全起见本次写入未执行")))?;

    // 快照：矩阵说需要才做（真源面），草稿与缓存不做。
    let snapshot_ref =
        if requires_snapshot(WriteSource::ExternalAgent, classify_target(physical_path)) {
            let snap =
                super::writes::create_snapshot(std::path::Path::new(project_path), physical_path)
                    .map_err(|e| ToolError::internal(format!("{e}；为安全起见本次写入未执行")))?;
            Some(snap.id)
        } else {
            None
        };

    crate::commands::fs::do_write_file_atomic(virtual_path, contents)
        .map_err(|e| ToolError::internal(format!("写入失败（目标未改动）: {e}")))?;

    let after = file_hash(physical_path)
        .map_err(|e| ToolError::internal(format!("写入已发生但无法回读校验: {e}")))?;

    // 保留策略：裁旧快照。裁剪失败不影响本次写入的正确性，但要报出来。
    let pruned =
        super::writes::prune_snapshots(std::path::Path::new(project_path), super::writes::now_ms())
            .map_err(|e| {
                ToolError::internal(format!(
                    "写入已完成，但快照裁剪失败: {e}（不影响本次写入，仅影响旧快照清理）"
                ))
            })?;

    let record = DirectWriteAudit {
        ts: chrono::Utc::now().to_rfc3339(),
        source: "external_agent",
        tool,
        kind: "direct_write",
        path: &physical,
        before_hash: before.clone().unwrap_or_else(|| "absent".to_string()),
        after_hash: after.clone().unwrap_or_else(|| "absent".to_string()),
        snapshot_ref: snapshot_ref.clone(),
    };
    if let Err(e) = append_audit_line(&mut audit_file, &record) {
        return Err(ToolError::internal(format!(
            "写入已生效，但审计落盘失败: {e}。请检查 {} 的可写性。快照: {}",
            audit_path.display(),
            snapshot_ref.as_deref().unwrap_or("（本目标不需要快照）")
        )));
    }

    Ok(json!({
        "path": physical,
        "virtualPath": virtual_path,
        "chars": contents.chars().count(),
        "beforeHash": before,
        "afterHash": after,
        "snapshotRef": snapshot_ref,
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
            let content = require_str(args, "chapter.write_direct", "content")?;
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
            direct_write(&project_path, "chapter.write_direct", &path, content)
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
            let content = require_str(args, "memory.write", "content")?;
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
            direct_write(&project_path, "memory.write", &path, content)
        })
    }
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
        "Roll back the most recent N direct writes (newest first) using their snapshots. Requires full scope. Each rollback is verified byte-for-byte against the snapshot hash and is itself recorded in the audit log. If any rollback fails, the call reports which ones succeeded and which failed — it never claims success."
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
            let writes = read_direct_writes(&project_path)?;
            if writes.is_empty() {
                return Err(ToolError::internal(
                    "没有可回滚的外部直写记录（审计里没有 kind=direct_write 的条目）".to_string(),
                ));
            }
            let take = n.min(writes.len());
            let selected: Vec<serde_json::Value> =
                writes[writes.len() - take..].iter().cloned().collect();

            let (mut audit_file, audit_path) = open_audit_log(&project_path)?;
            let mut restored = Vec::new();
            let mut failures = Vec::new();

            // 从最新往回退：先退最后一次写入，才能保证多次写入同一文件时逐层还原。
            for entry in selected.iter().rev() {
                let target = entry
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let snapshot_ref = entry
                    .get("snapshot_ref")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string());
                let Some(snapshot_ref) = snapshot_ref else {
                    failures.push(json!({
                        "path": target,
                        "reason": "该条目没有 snapshot_ref（按矩阵不需要快照的落点），无法回滚",
                    }));
                    continue;
                };

                let before = file_hash(std::path::Path::new(&target)).ok().flatten();
                match super::writes::restore_snapshot(
                    std::path::Path::new(&project_path),
                    &snapshot_ref,
                ) {
                    Ok(result) => {
                        let record = DirectWriteAudit {
                            ts: chrono::Utc::now().to_rfc3339(),
                            source: "external_agent",
                            tool: "undo_last",
                            kind: "undo",
                            path: &target,
                            before_hash: before.unwrap_or_else(|| "absent".to_string()),
                            after_hash: result.hash.clone(),
                            snapshot_ref: Some(snapshot_ref.clone()),
                        };
                        if let Err(e) = append_audit_line(&mut audit_file, &record) {
                            failures.push(json!({
                                "path": target,
                                "reason": format!("已还原但审计落盘失败: {e}"),
                            }));
                            continue;
                        }
                        restored.push(json!({
                            "path": target,
                            "snapshotRef": snapshot_ref,
                            "restoredTo": if result.existed { "content" } else { "absent" },
                            "hash": result.hash,
                            "bytes": result.bytes,
                            "undoneTs": entry.get("ts").cloned().unwrap_or(Value::Null),
                        }));
                    }
                    Err(e) => failures.push(json!({ "path": target, "reason": e })),
                }
            }

            if !failures.is_empty() {
                // 部分成功必须逐条报出来，不能只说"失败"或只说"成功"。
                return Err(ToolError::internal(format!(
                    "回滚未全部成功：{} 项已还原，{} 项失败。失败项：{}。审计：{}",
                    restored.len(),
                    failures.len(),
                    serde_json::to_string(&failures).unwrap_or_else(|_| "[]".to_string()),
                    audit_path.display()
                )));
            }

            Ok(json!({
                "requested": n,
                "rolledBack": restored.len(),
                "items": restored,
                "audit": { "path": audit_path.display().to_string() },
            }))
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
    r.register(Arc::new(CanonQueryTool));
    r.register(Arc::new(PipelineRunChapterTool));
    r.register(Arc::new(PipelineStatusTool));
    r.register(Arc::new(GateRunTool));
    r.register(Arc::new(ChapterWriteTool));
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
                "canon.query",
                "pipeline.run_chapter",
                "pipeline.status",
                "gate.run",
                "chapter.write",
                "memory.write",
                "chapter.write_direct",
                "undo_last",
            ]
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
                tool["description"].as_str().map(|d| !d.trim().is_empty()).unwrap_or(false),
                "tool {} must have a description",
                tool["name"]
            );
        }
    }

    #[test]
    fn settings_get_requires_key_argument() {
        // 参数校验不依赖 AppHandle，因此可以在无 tauri 环境里直接断言错误码。
        let tool = SettingsGetTool;
        assert_eq!(tool.input_schema()["required"], json!(["key"]));
    }

    #[test]
    fn chapter_read_requires_chapter_argument() {
        let tool = ChapterReadTool;
        assert_eq!(tool.input_schema()["required"], json!(["chapter"]));
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
        let (mut file, _path) = open_audit_log(&project.path_str()).expect("audit");
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
        assert!(text.contains("\"snapshot_ref\":null"), "无快照要显式写 null");
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

        let writes = read_direct_writes(&project.path_str()).expect("read");
        assert_eq!(writes.len(), 2, "设置条目与坏行都不算直写");
        assert_eq!(writes[0]["path"], "/p/canon/a.md");
        assert_eq!(writes[1]["path"], "/p/canon/b.md", "顺序必须保持写入顺序");
    }

    #[test]
    fn read_direct_writes_skips_already_undone_entries() {
        // 回滚是栈：已撤销的直写不能再被 undo_last 选中，否则连调两次会重复还原
        // 同一条（用户以为退了两步，实际只退了一步）。
        let project = TempProject::new("undostack");
        append_test_write(&project, "/p/canon/a.md", Some("snap_a"));
        append_test_write(&project, "/p/canon/b.md", Some("snap_b"));

        // 模拟 b 被回滚过：追加一条 kind=undo 的审计。
        let (mut file, _path) = open_audit_log(&project.path_str()).expect("audit");
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

        let writes = read_direct_writes(&project.path_str()).expect("read");
        assert_eq!(writes.len(), 1, "已撤销的那条必须从栈里摘掉");
        assert_eq!(writes[0]["path"], "/p/canon/a.md");
        assert_eq!(writes[0]["snapshot_ref"], "snap_a");
    }

    #[test]
    fn read_direct_writes_without_audit_file_says_so() {
        let project = TempProject::new("noaudit");
        let err = read_direct_writes(&project.path_str()).unwrap_err();
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
}
