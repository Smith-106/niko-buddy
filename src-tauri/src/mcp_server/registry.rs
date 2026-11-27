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
use super::session::{SessionScope, ToolProfile};
use super::tools::{ToolContext, ToolFuture};

impl ToolProfile {
    /// 判断某个工具名是否在当前 Profile 下可见、可调。
    ///
    /// 与 `SessionScope` 取交集：
    /// - `FullLegacy`：全部 38 个已注册工具；
    /// - `WriterSub`（24 个）：零 LLM 读写原语 + Draft-first 写工具，隐藏全部内部 API LLM 管线与全量直写工具；
    /// - `Reviewer`（19 个）：严格全只读工具，零写工具；
    /// - `Architect`（17 个）：聚焦开书/世界观/大纲/角色规划，不含正文写入、草稿修审与风格范例工具。
    pub fn allows(self, tool_name: &str) -> bool {
        match self {
            Self::FullLegacy => true,
            Self::WriterSub => matches!(
                tool_name,
                "app.ping"
                    | "app.status"
                    | "project.state"
                    | "chapter.list"
                    | "chapter.read"
                    | "context.inspect"
                    | "canon.query"
                    | "draft.list"
                    | "draft.read"
                    | "rules.get"
                    | "gate.check_mechanical"
                    | "context.prepare_write"
                    | "director.check"
                    | "workflow.next"
                    | "foreshadowing.list"
                    | "character.read"
                    | "outline.read"
                    | "style.exemplars"
                    | "chapter.search"
                    | "chapter.write"
                    | "draft.patch"
                    | "draft.record_review"
                    | "outline.write"
                    | "character.upsert"
            ),
            Self::Reviewer => matches!(
                tool_name,
                "app.ping"
                    | "app.status"
                    | "project.state"
                    | "chapter.list"
                    | "chapter.read"
                    | "context.inspect"
                    | "canon.query"
                    | "draft.list"
                    | "draft.read"
                    | "rules.get"
                    | "gate.check_mechanical"
                    | "context.prepare_write"
                    | "director.check"
                    | "workflow.next"
                    | "foreshadowing.list"
                    | "character.read"
                    | "outline.read"
                    | "style.exemplars"
                    | "chapter.search"
            ),
            Self::Architect => matches!(
                tool_name,
                "app.ping"
                    | "app.status"
                    | "project.state"
                    | "chapter.list"
                    | "chapter.read"
                    | "canon.query"
                    | "draft.list"
                    | "rules.get"
                    | "context.prepare_write"
                    | "director.check"
                    | "workflow.next"
                    | "foreshadowing.list"
                    | "character.read"
                    | "outline.read"
                    | "chapter.search"
                    | "outline.write"
                    | "character.upsert"
            ),
        }
    }

    /// 当工具被当前 Profile 隐藏时，返回零 LLM 替代工具集合与清晰引导文案。
    ///
    /// 不变量：返回切片中的每一个替代工具都必须本身被 `self.allows(...)` 放行，
    /// 避免向只读 `reviewer` 或 `architect` 会话推荐其不可见的写工具。
    pub fn blocked_guidance(self, tool_name: &str) -> (&'static [&'static str], &'static str) {
        match tool_name {
            "pipeline.run_chapter" | "chapter.batch" => match self {
                Self::Reviewer => (
                    &[
                        "context.prepare_write",
                        "rules.get",
                        "gate.check_mechanical",
                        "draft.read",
                    ],
                    "Internal LLM pipeline tools are hidden in the read-only reviewer profile. Inspect context with context.prepare_write/rules.get, read drafts via draft.read, and audit via gate.check_mechanical.",
                ),
                Self::Architect => (
                    &[
                        "context.prepare_write",
                        "rules.get",
                        "outline.write",
                        "character.upsert",
                    ],
                    "Internal LLM chapter pipelines are hidden in the architect profile. Plan structure with context.prepare_write, rules.get, outline.write, and character.upsert, or switch to writer-sub to draft chapters.",
                ),
                _ => (
                    &[
                        "context.prepare_write",
                        "rules.get",
                        "gate.check_mechanical",
                        "chapter.write",
                    ],
                    "Internal LLM pipeline tools are hidden in this profile. Prepare context with context.prepare_write and rules.get, author directly with the host model, save drafts via chapter.write, and verify with gate.check_mechanical.",
                ),
            },
            "pipeline.status" => (
                &["draft.list", "project.state"],
                "Internal pipeline polling is hidden in this profile. Inspect project progress via project.state and pending drafts via draft.list.",
            ),
            "gate.run" => match self {
                Self::Architect => (
                    &["context.prepare_write", "rules.get", "director.check"],
                    "Internal LLM gate runner is hidden in the architect profile. Inspect planning readiness with context.prepare_write, rules.get, and director.check, or switch to reviewer/writer-sub for mechanical chapter checks.",
                ),
                _ => (
                    &[
                        "gate.check_mechanical",
                        "context.inspect",
                        "context.prepare_write",
                    ],
                    "Internal LLM gate runner is hidden in this profile. Run deterministic P0/P1 checks via gate.check_mechanical and inspect context/six-dim prompts via context.inspect or context.prepare_write.",
                ),
            },
            "outline.generate" => match self {
                Self::Reviewer => (
                    &["director.check", "rules.get", "project.state"],
                    "Internal LLM outline generation is hidden in the read-only reviewer profile. Inspect setup status via director.check, rules.get, and project.state, or switch to architect/writer-sub to edit outlines.",
                ),
                _ => (
                    &["director.check", "rules.get", "outline.write"],
                    "Internal LLM outline generation is hidden in this profile. Inspect setup status via director.check and rules.get, draft the outline with the host model, and save it via outline.write.",
                ),
            },
            "director.advance" => match self {
                Self::Reviewer => (
                    &["director.check", "project.state", "canon.query"],
                    "Internal LLM director advancement is hidden in the read-only reviewer profile. Diagnose setup gates via director.check, project.state, and canon.query, or switch to architect/writer-sub to update planning docs.",
                ),
                _ => (
                    &["director.check", "character.upsert", "outline.write"],
                    "Internal LLM director advancement is hidden in this profile. Diagnose gates via director.check, then write character entities and outlines directly via character.upsert and outline.write.",
                ),
            },
            "chapter.write_direct" => match self {
                Self::Reviewer => (
                    &["draft.list", "draft.read", "gate.check_mechanical"],
                    "Direct formal-chapter writes are hidden in the read-only reviewer profile. Inspect drafts via draft.list/draft.read and audit via gate.check_mechanical.",
                ),
                Self::Architect => (
                    &["draft.list", "outline.write", "context.prepare_write"],
                    "Direct formal-chapter writes are hidden in the architect profile. Use outline.write for planning, or switch to writer-sub to save Draft-first chapters.",
                ),
                _ => (
                    &["chapter.write"],
                    "Direct formal-chapter writes are hidden in this profile to preserve Draft-first safety. Save drafts via chapter.write and accept them in Niko Buddy.",
                ),
            },
            "memory.write" => match self {
                Self::Reviewer => (
                    &["canon.query", "draft.read", "project.state"],
                    "Direct formal-memory writes are hidden in the read-only reviewer profile. Query canon via canon.query and inspect drafts/project state without mutating formal memory.",
                ),
                Self::Architect => (
                    &["canon.query", "character.upsert", "outline.write"],
                    "Direct formal-memory writes are hidden in the architect profile to preserve Draft-first safety. Query canon via canon.query and maintain planning docs via character.upsert/outline.write.",
                ),
                _ => (
                    &["canon.query", "character.upsert", "chapter.write"],
                    "Direct formal-memory writes are hidden in this profile to preserve Draft-first safety. Query canon via canon.query, update planning characters via character.upsert, or keep draft changes via chapter.write.",
                ),
            },
            "undo_last" => (
                &["draft.list", "project.state"],
                "Direct-write rollback is hidden in this profile because direct formal writes are disabled. Inspect drafts via draft.list and state via project.state.",
            ),
            "chapter.write" => match self {
                Self::Reviewer => (
                    &["draft.list", "draft.read", "gate.check_mechanical"],
                    "Write tools are hidden in the read-only reviewer profile. Inspect drafts with draft.list/draft.read and audit via gate.check_mechanical, or switch session to writer-sub.",
                ),
                Self::Architect => (
                    &["outline.write", "character.upsert", "draft.list"],
                    "Chapter drafting is hidden in the architect profile. Use outline.write and character.upsert for planning, or switch session to writer-sub to draft chapters.",
                ),
                _ => (
                    &["draft.list"],
                    "chapter.write is hidden by the active tool profile.",
                ),
            },
            "draft.patch" => match self {
                Self::Reviewer => (
                    &["draft.list", "draft.read", "gate.check_mechanical"],
                    "Draft patching is hidden in the read-only reviewer profile to enforce strict read-only isolation. Inspect drafts via draft.list/draft.read and audit via gate.check_mechanical, then hand structured patch instructions back to writer-sub.",
                ),
                Self::Architect => (
                    &["outline.write", "character.upsert", "draft.list"],
                    "Draft patching is hidden in the architect profile. Use outline.write and character.upsert for planning, or switch to writer-sub to patch chapter drafts.",
                ),
                _ => (
                    &["draft.list"],
                    "draft.patch is hidden by the active tool profile.",
                ),
            },
            "draft.record_review" => match self {
                Self::Reviewer => (
                    &[
                        "draft.read",
                        "gate.check_mechanical",
                        "context.inspect",
                        "workflow.next",
                    ],
                    "Recording draft review status is hidden in the read-only reviewer profile to enforce strict read-only isolation. Audit drafts via draft.read, gate.check_mechanical, and context.inspect, then hand structured review findings back to writer-sub to record via draft.record_review.",
                ),
                Self::Architect => (
                    &["workflow.next", "director.check", "draft.list"],
                    "Recording draft review status is hidden in the architect profile. Inspect workflow state via workflow.next, director.check, and draft.list, or switch to writer-sub.",
                ),
                _ => (
                    &["draft.list"],
                    "draft.record_review is hidden by the active tool profile.",
                ),
            },
            "style.exemplars" => match self {
                Self::Architect => (
                    &[
                        "rules.get",
                        "context.prepare_write",
                        "outline.read",
                        "character.read",
                    ],
                    "Prose style exemplars are hidden in the architect profile to keep planning context focused. Use rules.get, context.prepare_write, outline.read, and character.read for planning, or switch to writer-sub/reviewer.",
                ),
                _ => (
                    &["rules.get"],
                    "style.exemplars is hidden by the active tool profile.",
                ),
            },
            "outline.write" | "character.upsert" => (
                &["director.check", "project.state", "canon.query"],
                "Planning write tools are hidden in the read-only reviewer profile. Inspect project state via director.check, project.state, and canon.query, or switch session to architect/writer-sub.",
            ),
            "context.inspect" | "draft.read" | "gate.check_mechanical" => (
                &[
                    "context.prepare_write",
                    "draft.list",
                    "rules.get",
                    "director.check",
                ],
                "Detailed chapter review tools are hidden in the architect profile. Use context.prepare_write, rules.get, and director.check for planning, or switch to writer-sub/reviewer.",
            ),
            "settings.schema" | "settings.list" | "settings.get" | "settings.set" => (
                &["app.status", "rules.get", "project.state"],
                "App settings tools are hidden in writing profiles to keep context focused. Read writing rules via rules.get or switch to full-legacy for settings administration.",
            ),
            "export.run" => (
                &["project.state", "draft.list"],
                "Backup export is hidden in writing profiles. Inspect project status via project.state or switch to full-legacy to run project backup exports.",
            ),
            _ => (
                &["app.status", "project.state"],
                "This tool is hidden by the active MCP tool profile. Switch to full-legacy if you explicitly need legacy tools.",
            ),
        }
    }
}

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

    /// 策略 / 权限拒绝（写入权威矩阵不通过、scope 不足）。
    ///
    /// 与 [`ToolError::internal`] 分开：内部错误意味着「该重试或报 bug」，权限拒绝
    /// 意味着「去做授权或换一个目标」，客户端该做的事完全不同。
    pub fn permission(message: impl Into<String>) -> Self {
        ToolError {
            code: super::protocol::PERMISSION_DENIED,
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

    /// `tools/list` 的全量 result 体（保持既有内省与兼容性测试语义不变）。
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

    /// 按 `(scope, profile)` 单调交集过滤后的 `tools/list` result 体。
    pub fn list_for(&self, scope: SessionScope, profile: ToolProfile) -> Value {
        let tools: Vec<Value> = self
            .tools
            .iter()
            .filter(|t| scope.satisfies(t.required_scope()) && profile.allows(t.name()))
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

    /// 需要**高于只读**权限的工具名（安全断言用）。
    ///
    /// 名字叫 privileged 而不是 write：`pipeline.status` / `gate.run` 不改任何东西，
    /// 但它们暴露生成中/已生成的正文与门控结论，仍按项目级授权收口。
    pub fn privileged_tools(&self) -> Vec<&'static str> {
        self.tools
            .iter()
            .filter(|t| t.required_scope() != SessionScope::Read)
            .map(|t| t.name())
            .collect()
    }

    /// 某权限域下可调用的工具名（设置页展示用：用户能看清授权换来了什么）。
    pub fn names_visible_to(&self, scope: SessionScope) -> Vec<&'static str> {
        self.tools
            .iter()
            .filter(|t| scope.satisfies(t.required_scope()))
            .map(|t| t.name())
            .collect()
    }

    /// 按 `(scope, profile)` 单调交集可见的工具名（`scope.satisfies(required) && profile.allows(name)`）。
    pub fn names_visible_to_profile(
        &self,
        scope: SessionScope,
        profile: ToolProfile,
    ) -> Vec<&'static str> {
        self.tools
            .iter()
            .filter(|t| scope.satisfies(t.required_scope()) && profile.allows(t.name()))
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
        assert!(registry()
            .call(&ctx, "nope.nope", &json!({}))
            .await
            .is_none());
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

    #[test]
    fn profile_visibility_matrix_is_monotonic_and_matches_exact_counts() {
        let reg = crate::mcp_server::tools::build_registry();
        assert_eq!(reg.len(), 38, "全量注册表应保持 38 个工具");

        let full_all = reg.names_visible_to_profile(SessionScope::Full, ToolProfile::FullLegacy);
        assert_eq!(full_all.len(), 38);

        let writer_full = reg.names_visible_to_profile(SessionScope::Full, ToolProfile::WriterSub);
        let writer_proj =
            reg.names_visible_to_profile(SessionScope::Project, ToolProfile::WriterSub);
        assert_eq!(writer_full.len(), 24);
        assert_eq!(
            writer_full, writer_proj,
            "WriterSub 即使在 Full scope 下也不得暴露任何 Full 专属工具或 Settings 工具"
        );

        let reviewer_full = reg.names_visible_to_profile(SessionScope::Full, ToolProfile::Reviewer);
        let reviewer_read = reg.names_visible_to_profile(SessionScope::Read, ToolProfile::Reviewer);
        assert_eq!(reviewer_full.len(), 19);
        assert_eq!(
            reviewer_full, reviewer_read,
            "Reviewer 必须严格全只读：Full 与 Read 下工具集合完全一致"
        );
        for name in &reviewer_full {
            assert_eq!(
                reg.required_scope(name),
                Some(SessionScope::Read),
                "Reviewer 严禁包含非 Read 工具: {name}"
            );
        }

        let architect_full =
            reg.names_visible_to_profile(SessionScope::Full, ToolProfile::Architect);
        let architect_proj =
            reg.names_visible_to_profile(SessionScope::Project, ToolProfile::Architect);
        assert_eq!(architect_full.len(), 17);
        assert_eq!(architect_full, architect_proj);

        // 单调子集不变量：任意 (scope, profile) 必为 names_visible_to(scope) 子集，且 list_for 与 names_visible_to_profile 1:1 对齐。
        for scope in [
            SessionScope::Read,
            SessionScope::Settings,
            SessionScope::Project,
            SessionScope::Auto,
            SessionScope::Full,
        ] {
            let scope_visible = reg.names_visible_to(scope);
            for profile in ToolProfile::ALL {
                let visible = reg.names_visible_to_profile(scope, profile);
                let list_payload = reg.list_for(scope, profile);
                let listed: Vec<&str> = list_payload
                    .get("tools")
                    .and_then(Value::as_array)
                    .expect("tools array")
                    .iter()
                    .filter_map(|t| t["name"].as_str())
                    .collect();
                assert_eq!(listed, visible, "list_for 与 names_visible_to_profile 漂移");
                for name in &visible {
                    assert!(scope_visible.contains(name));
                    assert!(profile.allows(name));
                }
            }
        }

        // 所有被 WriterSub / Reviewer / Architect 隐藏的工具必须有非空零 LLM 引导与替代工具，
        // 且每个替代工具本身必须被当前 profile 放行（绝不向只读 reviewer 推荐隐藏写工具）。
        for profile in [
            ToolProfile::WriterSub,
            ToolProfile::Reviewer,
            ToolProfile::Architect,
        ] {
            for name in reg.names() {
                if !profile.allows(name) {
                    let (replacements, msg) = profile.blocked_guidance(name);
                    assert!(
                        !replacements.is_empty(),
                        "{profile:?} 隐藏工具 {name} 必须提供替代工具"
                    );
                    assert!(!msg.trim().is_empty());
                    for replacement in replacements {
                        assert!(
                            profile.allows(replacement),
                            "{profile:?} 隐藏工具 {name} 推荐的替代工具 `{replacement}` 必须本身在 {profile:?} 下可见可用"
                        );
                    }
                }
            }
        }

        // 核对关键替代工具清单。
        assert_eq!(
            ToolProfile::WriterSub
                .blocked_guidance("pipeline.run_chapter")
                .0,
            &[
                "context.prepare_write",
                "rules.get",
                "gate.check_mechanical",
                "chapter.write"
            ]
        );
        assert_eq!(
            ToolProfile::WriterSub.blocked_guidance("chapter.batch").0,
            &[
                "context.prepare_write",
                "rules.get",
                "gate.check_mechanical",
                "chapter.write"
            ]
        );
        assert_eq!(
            ToolProfile::WriterSub.blocked_guidance("gate.run").0,
            &[
                "gate.check_mechanical",
                "context.inspect",
                "context.prepare_write"
            ]
        );
        assert_eq!(
            ToolProfile::WriterSub
                .blocked_guidance("outline.generate")
                .0,
            &["director.check", "rules.get", "outline.write"]
        );
        assert_eq!(
            ToolProfile::WriterSub
                .blocked_guidance("director.advance")
                .0,
            &["director.check", "character.upsert", "outline.write"]
        );
        assert_eq!(
            ToolProfile::WriterSub
                .blocked_guidance("chapter.write_direct")
                .0,
            &["chapter.write"]
        );

        // 核对 Phase 2 新增 3 个按 Profile 隐藏的工具引导（只读 Reviewer 必须引导回交 writer-sub）。
        let (rev_patch_repl, rev_patch_msg) = ToolProfile::Reviewer.blocked_guidance("draft.patch");
        assert_eq!(
            rev_patch_repl,
            &["draft.list", "draft.read", "gate.check_mechanical"]
        );
        assert!(rev_patch_msg.contains("read-only") && rev_patch_msg.contains("writer-sub"));

        let (rev_rec_repl, rev_rec_msg) =
            ToolProfile::Reviewer.blocked_guidance("draft.record_review");
        assert_eq!(
            rev_rec_repl,
            &[
                "draft.read",
                "gate.check_mechanical",
                "context.inspect",
                "workflow.next",
            ]
        );
        assert!(rev_rec_msg.contains("read-only") && rev_rec_msg.contains("writer-sub"));

        assert_eq!(
            ToolProfile::Architect.blocked_guidance("draft.patch").0,
            &["outline.write", "character.upsert", "draft.list"]
        );
        assert_eq!(
            ToolProfile::Architect
                .blocked_guidance("draft.record_review")
                .0,
            &["workflow.next", "director.check", "draft.list"]
        );
        assert_eq!(
            ToolProfile::Architect.blocked_guidance("style.exemplars").0,
            &[
                "rules.get",
                "context.prepare_write",
                "outline.read",
                "character.read",
            ]
        );
        assert!(!ToolProfile::Architect.allows("draft.patch"));
        assert!(!ToolProfile::Architect.allows("draft.record_review"));
        assert!(!ToolProfile::Architect.allows("style.exemplars"));
        assert!(ToolProfile::Reviewer.allows("style.exemplars"));
    }
}
