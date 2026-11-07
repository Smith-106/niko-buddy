//! MCP 会话注册表（方案 `d23eb1df` P0）。
//!
//! ## 为什么需要它
//!
//! 「外部控制」必须**可见且可掐断**：用户要能在设置页看到现在有几个外部 Agent
//! 连着、各自什么时候连上、最后一次调用是什么时候，然后一键断开。没有会话表，
//! 这个开关就只是「停监听」——已经握手的客户端会被一起丢掉，但用户看不到丢了谁。
//!
//! ## 会话 id 从哪来
//!
//! MCP 2025-06-18 规定服务端在 `initialize` 响应里用 `Mcp-Session-Id` 头下发会话 id，
//! 客户端后续请求带同一个头。因此这里只在 `initialize` 时**新建**，其余请求按头
//! 更新活跃时间；带了未知 id 的请求照样放行（P0 不靠会话做鉴权——鉴权是 bearer
//! token 的事，两者不混）。
//!
//! ## 会话权限域（P1）
//!
//! 会话在 `initialize` 时**继承服务端当时授予的 scope**，之后不再跟着服务端变。
//! 这是有意的：用户把服务端升到 `settings` 之后，已经在读的老会话不应该凭空获得
//! 写权限——要写就重连一次。降级则相反，服务端一停所有会话就清空（见 `stop`）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 会话权限域。
///
/// **刻意不做全序**：`Project` 不蕴含 `Settings`，`Settings` 也不蕴含 `Project`。
/// 用全序（`Read < Settings < Project`）会让「授予项目动作」顺带授予设置写入——
/// 一次授权换来两处能力，是最容易被忽略的权限泄漏。所以判定走
/// [`SessionScope::satisfies`]，按「该 scope 是否满足该项要求」逐项回答。
///
/// 同时具备两类写权限的组合 scope 有两档：`auto`（设置 + 项目动作）与 `full`
/// （再叠加直写正文/正式记忆）。两档都只能在设置页逐会话授权。
///
/// ## `auto`（一窗口全流程）为什么是独立一档
///
/// 「一个窗口跑完整写作流程」要求同一个会话既能改设置、又能起管线/跑门控。按上面的
/// 反全序原则，`settings` 与 `project` 互不蕴含，而让会话自由叠加两个 scope 会把授权
/// 变成可组合的集合——用户看到的开关与真实生效能力会逐渐对不上。折中是把它做成
/// **一档显式的组合**：`auto` = `settings` + `project`，且**不含** `full`。
///
/// 它同样只能逐会话授予：`auto` 能起生成、能改设置，与 `full` 的差别只在「不经草稿
/// 直接改正文」这一件事上；少一条护栏的能力不该在握手时随手发出。
///
/// ## `full`（P3）为什么不能像其他三档那样在连接时授予
///
/// `read` / `settings` / `project` 三档的风险是「多了一项能力」，而 `full` 的风险
/// 是「能改正文且事后才能发现」——它的安全网是审计与快照（C-008 / C-002 修订），
/// 不是事前拦截。这种能力不应该在握手时随手发出：客户端只要带着 token 重新
/// `initialize` 就能拿到，而用户根本不知道发过。
///
/// 所以 `full` 是**逐会话**的：会话先用普通 scope 连上，用户在设置页看到它、
/// 明确点「授予完整写入」，它才拿到；随时可以单独吊销。见
/// [`SessionRegistry::grant_full`] / [`SessionRegistry::revoke_full`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionScope {
    /// 只读：P0 的全部查询工具。
    Read,
    /// 额外允许 `settings.set`。
    Settings,
    /// 额外允许项目动作（`chapter.write` / `pipeline.*` / `gate.run`）。
    Project,
    /// 自动编排：同时满足 `Settings` 与 `Project` 两类要求，但**不**满足 `Full`。
    /// 「一个窗口跑完整流程」用这一档；直写正文仍需 `full`。只能逐会话授权。
    Auto,
    /// 完整写入：额外允许直写正文 / 正式记忆与 `undo_last`。
    /// 只能逐会话授权，不能在 `mcp_server_start` 时授予。
    Full,
}

impl SessionScope {
    /// 解析外部传入的 scope 名。未知值返回 `None`（调用方按参数错误处理，不猜）。
    ///
    /// 注意：能解析出 `Full` 不等于允许在连接时使用它——那是
    /// [`super::mcp_server_start`] 的判断，与本函数无关。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "read" => Some(Self::Read),
            "settings" => Some(Self::Settings),
            "project" => Some(Self::Project),
            "auto" => Some(Self::Auto),
            "full" => Some(Self::Full),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Settings => "settings",
            Self::Project => "project",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }

    /// 本 scope 是否满足 `required`。
    ///
    /// 只读要求任何 scope 都满足（只读永远可做）；写要求必须**同项**授权。
    /// `Full` 与 `Auto` 都同时满足 `Settings` 与 `Project` 两类写要求，`Full` 额外
    /// 满足自身。除此之外仍无全序——`Project` 不蕴含 `Settings`，反之亦然。
    ///
    /// 没有任何工具会要求 `Auto`：它是**被满足方**（组合档），不是被要求方。
    /// 这条说的是**工具需求侧**的约束（由 tools.rs 的
    /// `no_registered_tool_requires_auto_scope` 守住），不是 `satisfies` 的非自反性——
    /// `Auto.satisfies(Auto)` 仍为 true（偏序自反）。
    pub fn satisfies(self, required: Self) -> bool {
        match required {
            Self::Read => true,
            Self::Full => self == Self::Full,
            Self::Auto => self == Self::Auto,
            Self::Settings => matches!(self, Self::Settings | Self::Auto | Self::Full),
            Self::Project => matches!(self, Self::Project | Self::Auto | Self::Full),
        }
    }
}

/// 一条活跃会话。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    /// 该会话被授予的权限域（`initialize` 时从服务端继承）。
    pub scope: SessionScope,
    /// 建立连接的时间（unix 毫秒）。
    pub connected_at: u64,
    /// 最近一次调用的时间（unix 毫秒）。
    pub last_call_at: u64,
    /// 累计请求数。
    pub calls: u64,
    /// 是否被用户**逐会话**授予了完整写入（`full`）。
    ///
    /// 与 `scope` 分开存：`scope` 是连接时继承的上限，本字段是用户事后单独加的
    /// 一次性授权，两者叠加才是有效权限（见 [`SessionRegistry::effective_scope`]）。
    pub full_granted: bool,
    /// 是否被用户**逐会话**授予了自动编排（`auto` = settings + project）。
    ///
    /// 与 `full_granted` 分开：`auto` 不含直写正文。两者同时为真时以 `full` 为准
    /// （见 [`SessionRegistry::effective_scope`]）。
    pub auto_granted: bool,
}

/// 会话表。
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, SessionInfo>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 新建会话，返回会话 id。`scope` 是该会话被授予的权限域。
    pub fn create(&self, scope: SessionScope) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let mut guard = self.lock();
        guard.insert(
            id.clone(),
            SessionInfo {
                id: id.clone(),
                scope,
                connected_at: now,
                last_call_at: now,
                calls: 0,
                full_granted: false,
                auto_granted: false,
            },
        );
        id
    }

    /// 记录一次调用。未知 id 返回 `false`（不新建、不报错）。
    pub fn touch(&self, id: &str) -> bool {
        let now = now_ms();
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(session) => {
                session.last_call_at = now;
                session.calls += 1;
                true
            }
            None => false,
        }
    }

    /// 取某会话的权限域。未知 id 返回 `None`（调用方按**最小权限**处理，不隐式创建）。
    pub fn scope_of(&self, id: &str) -> Option<SessionScope> {
        self.lock().get(id).map(|s| s.scope)
    }

    /// 某会话**实际生效**的权限域：普通 scope 叠加逐会话 `full` / `auto` 授权。
    ///
    /// 这是唯一应该用来做权限闸门的入口。直接读 `scope_of` 会漏掉逐会话授权，
    /// 而两处各读一半是权限系统最经典的漏法。优先级：`full` > `auto` > 连接时的 scope。
    pub fn effective_scope(&self, id: &str) -> Option<SessionScope> {
        let guard = self.lock();
        let session = guard.get(id)?;
        Some(if session.full_granted {
            SessionScope::Full
        } else if session.auto_granted {
            SessionScope::Auto
        } else {
            session.scope
        })
    }

    /// 授予某会话完整写入。未知 id 返回 `false`（不隐式创建会话）。
    pub fn grant_full(&self, id: &str) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(session) => {
                session.full_granted = true;
                true
            }
            None => false,
        }
    }

    /// 吊销某会话的完整写入（不影响它原有的 scope）。未知 id 返回 `false`。
    pub fn revoke_full(&self, id: &str) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(session) => {
                session.full_granted = false;
                true
            }
            None => false,
        }
    }

    /// 某会话是否被授予了完整写入。
    pub fn has_full(&self, id: &str) -> bool {
        self.lock().get(id).map(|s| s.full_granted).unwrap_or(false)
    }

    /// 授予某会话自动编排（`auto` = settings + project，不含直写正文）。
    ///
    /// 未知 id 返回 `false`（不隐式创建会话）——与 [`Self::grant_full`] 同理。
    pub fn grant_auto(&self, id: &str) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(session) => {
                session.auto_granted = true;
                true
            }
            None => false,
        }
    }

    /// 吊销某会话的自动编排（不影响它原有的 scope 与 `full` 授权）。
    pub fn revoke_auto(&self, id: &str) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(id) {
            Some(session) => {
                session.auto_granted = false;
                true
            }
            None => false,
        }
    }

    /// 某会话是否被授予了自动编排。
    pub fn has_auto(&self, id: &str) -> bool {
        self.lock().get(id).map(|s| s.auto_granted).unwrap_or(false)
    }

    /// 当前会话快照，按连接时间升序（稳定顺序，避免界面列表跳动）。
    pub fn list(&self) -> Vec<SessionInfo> {
        let guard = self.lock();
        let mut out: Vec<SessionInfo> = guard.values().cloned().collect();
        out.sort_by_key(|s| (s.connected_at, s.id.clone()));
        out
    }

    /// 会话数。
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 清空（停止服务时调用：监听一停，握手过期的会话就不该继续显示为"连着"）。
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionInfo>> {
        match self.sessions.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_returns_distinct_ids() {
        let reg = SessionRegistry::new();
        let a = reg.create(SessionScope::Read);
        let b = reg.create(SessionScope::Read);
        assert_ne!(a, b);
        assert_eq!(reg.len(), 2);
    }

    #[test]
    fn touch_unknown_id_is_false_and_does_not_create() {
        let reg = SessionRegistry::new();
        assert!(!reg.touch("never-created"));
        assert_eq!(reg.len(), 0, "未知 id 不得被隐式创建");
    }

    #[test]
    fn touch_updates_call_count_and_last_call() {
        let reg = SessionRegistry::new();
        let id = reg.create(SessionScope::Read);
        let before = reg.list()[0].last_call_at;
        assert!(reg.touch(&id));
        assert!(reg.touch(&id));
        let after = reg.list()[0].clone();
        assert_eq!(after.calls, 2);
        assert!(after.last_call_at >= before);
        assert_eq!(after.scope, SessionScope::Read, "默认授予的是只读域");
    }

    #[test]
    fn list_is_sorted_by_connected_at() {
        let reg = SessionRegistry::new();
        for _ in 0..5 {
            reg.create(SessionScope::Read);
        }
        let list = reg.list();
        let mut sorted = list.clone();
        sorted.sort_by_key(|s| (s.connected_at, s.id.clone()));
        assert_eq!(
            list.iter().map(|s| &s.id).collect::<Vec<_>>(),
            sorted.iter().map(|s| &s.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn scope_is_inherited_at_create_and_looked_up_by_id() {
        let reg = SessionRegistry::new();
        let read_id = reg.create(SessionScope::Read);
        let settings_id = reg.create(SessionScope::Settings);
        assert_eq!(reg.scope_of(&read_id), Some(SessionScope::Read));
        assert_eq!(reg.scope_of(&settings_id), Some(SessionScope::Settings));
        // 未知 id 不得隐式创建，也不得默认给高权限。
        assert_eq!(reg.scope_of("never-created"), None);
    }

    #[test]
    fn scope_parse_rejects_unknown() {
        assert_eq!(SessionScope::parse("read"), Some(SessionScope::Read));
        assert_eq!(
            SessionScope::parse("settings"),
            Some(SessionScope::Settings)
        );
        assert_eq!(SessionScope::parse("project"), Some(SessionScope::Project));
        assert_eq!(SessionScope::parse("full"), Some(SessionScope::Full));
        assert_eq!(SessionScope::parse("admin"), None);
        assert_eq!(SessionScope::parse(""), None);
    }

    #[test]
    fn scope_satisfies_does_not_leak_across_kinds() {
        for s in [
            SessionScope::Read,
            SessionScope::Settings,
            SessionScope::Project,
            SessionScope::Full,
        ] {
            assert!(s.satisfies(SessionScope::Read), "{s:?} 应满足 Read");
        }
        assert!(SessionScope::Settings.satisfies(SessionScope::Settings));
        assert!(
            !SessionScope::Project.satisfies(SessionScope::Settings),
            "Project 不得顺带拿到设置写权限"
        );
        assert!(SessionScope::Project.satisfies(SessionScope::Project));
        assert!(
            !SessionScope::Settings.satisfies(SessionScope::Project),
            "Settings 不得顺带拿到项目动作权限"
        );
        assert!(!SessionScope::Read.satisfies(SessionScope::Settings));
        assert!(!SessionScope::Read.satisfies(SessionScope::Project));
        // Full 是唯一的超集；但它只能被显式授予，不能从连接时的 scope 得到。
        assert!(SessionScope::Full.satisfies(SessionScope::Settings));
        assert!(SessionScope::Full.satisfies(SessionScope::Project));
        assert!(SessionScope::Full.satisfies(SessionScope::Full));
        for s in [
            SessionScope::Read,
            SessionScope::Settings,
            SessionScope::Project,
        ] {
            assert!(
                !s.satisfies(SessionScope::Full),
                "{s:?} 不得顺带拿到完整写入"
            );
        }
    }

    #[test]
    fn auto_satisfies_both_write_kinds_but_never_full() {
        // auto 存在的理由：一个窗口同时要改设置 + 起项目动作。
        assert!(SessionScope::Auto.satisfies(SessionScope::Settings));
        assert!(SessionScope::Auto.satisfies(SessionScope::Project));
        assert!(SessionScope::Auto.satisfies(SessionScope::Read));
        assert!(
            !SessionScope::Auto.satisfies(SessionScope::Full),
            "auto 不得顺带拿到直写正文"
        );
        // 自反性：被要求时自己当然满足自己（required=Auto 时 Auto 通过）。
        // 「auto 不得成为被要求方」是**工具需求侧**的不变量，由 tools.rs 的
        // no_registered_tool_requires_auto_scope 守住——用 satisfies 的非自反性
        // 去表达它会破坏偏序语义，也会让 future 的 required=Auto 分支无故失效。
        assert!(
            SessionScope::Auto.satisfies(SessionScope::Auto),
            "satisfies 是自反的：required=auto 时 auto 必须通过"
        );
        // 反向不成立：单档不得冒充组合档。
        assert!(!SessionScope::Settings.satisfies(SessionScope::Auto));
        assert!(!SessionScope::Project.satisfies(SessionScope::Auto));
        // 解析与序列化名字稳定（写进文档与客户端配置的就是这两个字）。
        assert_eq!(SessionScope::parse("auto"), Some(SessionScope::Auto));
        assert_eq!(SessionScope::Auto.as_str(), "auto");
    }

    #[test]
    fn auto_is_per_session_and_revocable() {
        let reg = SessionRegistry::new();
        let a = reg.create(SessionScope::Project);
        let b = reg.create(SessionScope::Project);
        assert!(!reg.has_auto(&a), "新建会话不得自带自动编排");

        assert!(reg.grant_auto(&a));
        assert!(reg.has_auto(&a));
        assert!(!reg.has_auto(&b), "逐会话：授予 a 不得连带 b");
        assert_eq!(reg.effective_scope(&a), Some(SessionScope::Auto));
        assert_eq!(reg.effective_scope(&b), Some(SessionScope::Project));
        // 基础 scope 不被改写：吊销后回到 Project。
        assert_eq!(reg.scope_of(&a), Some(SessionScope::Project));

        assert!(reg.revoke_auto(&a));
        assert!(!reg.has_auto(&a));
        assert_eq!(reg.effective_scope(&a), Some(SessionScope::Project));

        assert!(!reg.grant_auto("never-created"));
        assert!(!reg.revoke_auto("never-created"));
        assert!(!reg.has_auto("never-created"));
    }

    #[test]
    fn full_outranks_auto() {
        // 两档同时授予时以更强的为准；吊销 full 后回落到 auto 而不是连接时的 scope。
        let reg = SessionRegistry::new();
        let id = reg.create(SessionScope::Read);
        reg.grant_auto(&id);
        reg.grant_full(&id);
        assert_eq!(reg.effective_scope(&id), Some(SessionScope::Full));
        reg.revoke_full(&id);
        assert_eq!(reg.effective_scope(&id), Some(SessionScope::Auto));
        reg.revoke_auto(&id);
        assert_eq!(reg.effective_scope(&id), Some(SessionScope::Read));
    }

    #[test]
    fn clear_drops_auto_grants_too() {
        let reg = SessionRegistry::new();
        let id = reg.create(SessionScope::Read);
        reg.grant_auto(&id);
        reg.clear();
        assert!(!reg.has_auto(&id));
        assert_eq!(reg.effective_scope(&id), None);
    }

    #[test]
    fn full_is_per_session_and_revocable() {
        let reg = SessionRegistry::new();
        let a = reg.create(SessionScope::Project);
        let b = reg.create(SessionScope::Project);
        assert!(!reg.has_full(&a), "新建会话不得自带完整写入");
        assert_eq!(reg.effective_scope(&a), Some(SessionScope::Project));

        assert!(reg.grant_full(&a));
        assert!(reg.has_full(&a));
        // 逐会话：授予 a 不得连带 b。
        assert!(!reg.has_full(&b));
        assert_eq!(reg.effective_scope(&a), Some(SessionScope::Full));
        assert_eq!(reg.effective_scope(&b), Some(SessionScope::Project));
        // 基础 scope 不被改写：吊销后回到 Project，不是回到 Read。
        assert_eq!(reg.scope_of(&a), Some(SessionScope::Project));

        assert!(reg.revoke_full(&a));
        assert!(!reg.has_full(&a));
        assert_eq!(reg.effective_scope(&a), Some(SessionScope::Project));

        // 未知会话不隐式创建、不报错。
        assert!(!reg.grant_full("never-created"));
        assert!(!reg.revoke_full("never-created"));
        assert!(!reg.has_full("never-created"));
        assert_eq!(reg.effective_scope("never-created"), None);
        assert_eq!(reg.len(), 2);
    }

    #[test]
    fn clear_drops_full_grants_too() {
        // 监听一停会话就清空，重连是新会话，不能继承上一次的完整写入授权。
        let reg = SessionRegistry::new();
        let id = reg.create(SessionScope::Read);
        reg.grant_full(&id);
        reg.clear();
        assert!(!reg.has_full(&id));
        assert_eq!(reg.effective_scope(&id), None);
    }

    #[test]
    fn clear_empties_registry() {
        let reg = SessionRegistry::new();
        reg.create(SessionScope::Read);
        reg.clear();
        assert!(reg.is_empty());
    }
}
