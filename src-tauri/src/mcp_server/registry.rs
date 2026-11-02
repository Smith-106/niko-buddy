//! MCP 工具注册表。
//!
//! 设计取向：工具是**编译期注册的静态集合**，不是运行时从外部加载的插件——
//! 这条是硬否决「不引入可执行脚本通道」的直接落实：外部 Agent 只能调用这里
//! 显式 `register` 过的类型化工具，没有任何路径能让它塞进来新代码。
//!
//! 每个工具自带 JSON Schema（`input_schema`），客户端据此生成调用参数；
//! 服务端仍要自己校验（客户端不可信），校验失败的报 `INVALID_PARAMS`。

use std::sync::Arc;

use serde_json::{json, Value};

use super::protocol::{INTERNAL_ERROR, INVALID_PARAMS};
use super::session::SessionScope;
use super::tools::{ToolContext, ToolFuture};

/// 工具执行错误。
///
/// `code` 沿用 JSON-RPC 错误码语义：参数问题用 `INVALID_PARAMS`，
/// 其余用 `INTERNAL_ERROR`。业务失败（如"章节不存在"）**不应**用这个类型，
/// 而应返回 `Ok(tool_error(..))`——那是成功的调用、失败的业务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: i64,
    pub message: String,
}

impl ToolError {
    pub fn invalid_params(message: impl Into<String>) -> Self {
        ToolError {
            code: INVALID_PARAMS,
            message: message.into(),
        }
    }

    /// 服务端内部失败（状态桥超时、IO 错误等）。
    pub fn internal(message: impl Into<String>) -> Self {
        ToolError {
            code: INTERNAL_ERROR,
            message: message.into(),
        }
    }
}

/// 一个可被外部 Agent 调用的工具。
pub trait McpTool: Send + Sync {
    /// 工具名（对客户端可见，稳定不可改名）。
    fn name(&self) -> &'static str;
    /// 一句话说明（对客户端可见）。
    fn description(&self) -> &'static str;
    /// 入参 JSON Schema。
    fn input_schema(&self) -> Value;
    /// 执行。实现方不得 panic；不得静默吞错误。
    fn call<'a>(
        &'a self,
        ctx: &'a ToolContext,
        args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>>;

    /// 调用该工具所需的会话权限域。默认只读——写工具必须显式覆盖。
    ///
    /// 放在 trait 上而不是在调度器里按名字硬编码，是为了让「新增一个写工具却忘了
    /// 声明权限」变成必须主动写一行的事，而不是默认放行。
    fn required_scope(&self) -> SessionScope {
        SessionScope::Read
    }
}

/// 工具注册表。
///
/// 注册顺序即 `tools/list` 的顺序，保持稳定输出便于客户端 diff。
#[derive(Default)]
pub struct ToolRegistry {
    tools: Vec<Arc<dyn McpTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    /// 注册一个工具。重名直接 panic——这是编程错误，不是运行时状况。
    pub fn register(&mut self, tool: Arc<dyn McpTool>) {
        let name = tool.name();
        assert!(
            !self.tools.iter().any(|t| t.name() == name),
            "duplicate MCP tool name: {name}"
        );
        self.tools.push(tool);
    }

    /// `tools/list` 的 result 体。
    pub fn list(&self) -> Value {
        let tools: Vec<Value> = self
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name(),
                    "description": t.description(),
                    "inputSchema": t.input_schema(),
                })
            })
            .collect();
        json!({ "tools": tools })
    }

    /// 按名调用。未知工具返回 `None`，由调用方决定报 `METHOD_NOT_FOUND`。
    pub async fn call(
        &self,
        ctx: &ToolContext,
        name: &str,
        args: &Value,
    ) -> Option<Result<Value, ToolError>> {
        let tool = self.tools.iter().find(|t| t.name() == name)?;
        Some(tool.call(ctx, args).await)
    }

    /// 某工具所需的权限域。未知工具返回 `None`。
    pub fn required_scope(&self, name: &str) -> Option<SessionScope> {
        self.tools
            .iter()
            .find(|t| t.name() == name)
            .map(|t| t.required_scope())
    }

    /// 需要写权限的工具名（安全断言用）。
    pub fn write_scope_tools(&self) -> Vec<&'static str> {
        self.tools
            .iter()
            .filter(|t| t.required_scope() > SessionScope::Read)
            .map(|t| t.name())
            .collect()
    }

    /// 已注册工具名（测试与内省用）。
    pub fn names(&self) -> Vec<&'static str> {
        self.tools.iter().map(|t| t.name()).collect()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

/// `app.ping` 占位工具：只证明链路通，不读不写任何状态。
pub struct PingTool;

impl McpTool for PingTool {
    fn name(&self) -> &'static str {
        "app.ping"
    }

    fn description(&self) -> &'static str {
        "Liveness probe. Returns pong plus server version. Reads and writes nothing."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    fn call<'a>(
        &'a self,
        _ctx: &'a ToolContext,
        _args: &'a Value,
    ) -> ToolFuture<'a, Result<Value, ToolError>> {
        Box::pin(async move {
            Ok(json!({
                "pong": true,
                "server": super::protocol::SERVER_NAME,
                "version": super::protocol::SERVER_VERSION,
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> ToolRegistry {
        let mut r = ToolRegistry::new();
        r.register(Arc::new(PingTool));
        r
    }

    #[test]
    fn lists_registered_tool_with_schema() {
        let list = registry().list();
        let tools = list["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "app.ping");
        assert_eq!(tools[0]["inputSchema"]["type"], "object");
    }

    #[tokio::test]
    async fn call_known_tool_succeeds() {
        let ctx = ToolContext::for_test();
        let out = registry()
            .call(&ctx, "app.ping", &json!({}))
            .await
            .expect("found")
            .expect("ok");
        assert_eq!(out["pong"], true);
    }

    #[tokio::test]
    async fn call_unknown_tool_returns_none() {
        // None 让上层报 METHOD_NOT_FOUND，而不是伪造一个成功响应。
        let ctx = ToolContext::for_test();
        assert!(registry().call(&ctx, "nope.nope", &json!({})).await.is_none());
    }

    #[test]
    #[should_panic(expected = "duplicate MCP tool name")]
    fn duplicate_registration_panics() {
        let mut r = ToolRegistry::new();
        r.register(Arc::new(PingTool));
        r.register(Arc::new(PingTool));
    }

    #[test]
    fn names_preserve_registration_order() {
        assert_eq!(registry().names(), vec!["app.ping"]);
    }
}
