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
/// 同时具备两类写权限的组合 scope 留给 P3 的 `full`（需要在设置页显式授权）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionScope {
    /// 只读：P0 的全部查询工具。
    Read,
    /// 额外允许 `settings.set`。
    Settings,
    /// 额外允许项目动作（`chapter.write` / `pipeline.*` / `gate.run` / `memory.write`）。
    Project,
}

impl SessionScope {
    /// 解析外部传入的 scope 名。未知值返回 `None`（调用方按参数错误处理，不猜）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "read" => Some(Self::Read),
            "settings" => Some(Self::Settings),
            "project" => Some(Self::Project),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Settings => "settings",
            Self::Project => "project",
        }
    }

    /// 本 scope 是否满足 `required`。
    ///
    /// 只读要求任何 scope 都满足（只读永远可做）；写要求必须**同项**授权。
    pub fn satisfies(self, required: Self) -> bool {
        match required {
            Self::Read => true,
            other => self == other,
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
        assert_eq!(SessionScope::parse("settings"), Some(SessionScope::Settings));
        assert_eq!(SessionScope::parse("project"), Some(SessionScope::Project));
        assert_eq!(SessionScope::parse("admin"), None);
        assert_eq!(SessionScope::parse("full"), None, "full 留给 P3，此处必须拒绝");
        assert_eq!(SessionScope::parse(""), None);
    }

    #[test]
    fn scope_satisfies_does_not_leak_across_kinds() {
        for s in [SessionScope::Read, SessionScope::Settings, SessionScope::Project] {
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
    }

    #[test]
    fn clear_empties_registry() {
        let reg = SessionRegistry::new();
        reg.create(SessionScope::Read);
        reg.clear();
        assert!(reg.is_empty());
    }
}
