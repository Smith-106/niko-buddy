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
//! ## 为什么 scope 是常量
//!
//! P0 全部只读，scope 恒为 `"read"`。写成字段而不是常量，是为了 P1 加写工具时
//! 能按会话记录授权范围，不必改表结构。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一条活跃会话。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    /// 权限域。P0 恒为 `"read"`。
    pub scope: &'static str,
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

    /// 新建会话，返回会话 id。
    pub fn create(&self) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let mut guard = self.lock();
        guard.insert(
            id.clone(),
            SessionInfo {
                id: id.clone(),
                scope: "read",
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
        let a = reg.create();
        let b = reg.create();
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
        let id = reg.create();
        let before = reg.list()[0].last_call_at;
        assert!(reg.touch(&id));
        assert!(reg.touch(&id));
        let after = reg.list()[0].clone();
        assert_eq!(after.calls, 2);
        assert!(after.last_call_at >= before);
        assert_eq!(after.scope, "read", "P0 会话恒为只读域");
    }

    #[test]
    fn list_is_sorted_by_connected_at() {
        let reg = SessionRegistry::new();
        for _ in 0..5 {
            reg.create();
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
    fn clear_empties_registry() {
        let reg = SessionRegistry::new();
        reg.create();
        reg.clear();
        assert!(reg.is_empty());
    }
}
