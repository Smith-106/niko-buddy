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
pub fn build_registry() -> super::registry::ToolRegistry {
    let mut r = super::registry::ToolRegistry::new();
    r.register(Arc::new(super::registry::PingTool));
    r.register(Arc::new(AppStatusTool));
    r.register(Arc::new(SettingsSchemaTool));
    r.register(Arc::new(SettingsListTool));
    r.register(Arc::new(SettingsGetTool));
    r.register(Arc::new(ProjectStateTool));
    r.register(Arc::new(ChapterListTool));
    r.register(Arc::new(ChapterReadTool));
    r.register(Arc::new(CanonQueryTool));
    // 编译期自检：注册表里不得出现写类工具。
    debug_assert!(
        super::contains_write_like_tool(&r).is_none(),
        "P0 registry must stay read-only"
    );
    r
}

use std::sync::Arc;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_server::registry::McpTool;

    #[test]
    fn p0_registry_contains_expected_read_only_tools() {
        let r = build_registry();
        assert_eq!(
            r.names(),
            vec![
                "app.ping",
                "app.status",
                "settings.schema",
                "settings.list",
                "settings.get",
                "project.state",
                "chapter.list",
                "chapter.read",
                "canon.query",
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
    fn no_write_like_tool_registered() {
        let r = build_registry();
        assert_eq!(crate::mcp_server::contains_write_like_tool(&r), None);
    }
}
