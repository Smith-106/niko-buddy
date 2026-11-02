//! Rust ⇄ WebView 状态桥（方案 `d23eb1df` P0，只读）。
//!
//! ## 为什么需要它
//!
//! 20 个设置键只活在 WebView 的 `localStorage` 里，Rust 进程读不到；而 MCP 服务端
//! 在 Rust 侧。因此需要一次跨进程往返：Rust `emit` 请求事件，前端处理后用
//! `invoke` 把结果回传给命令 [`mcp_state_respond`]。
//!
//! ## 为什么回传走命令而不是再 emit 一个事件
//!
//! 命令有返回值，前端能立即知道 Rust 是否还在等；事件监听器则依赖注册顺序，
//! 而且失败时没有回执。用命令让「前端已卸载」这类状况立刻暴露为 invoke 失败。
//!
//! ## 超时
//!
//! 5 秒。超时返回 `Err`——**绝不**返回 `Ok(None)`：把"读不到"伪装成"没有值"
//! 会让上层（以及最终的外部 Agent）得出错误结论。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Rust → WebView 的请求事件名（与 `src/lib/mcp/state-bridge.ts` 必须一致）。
pub const REQUEST_EVENT: &str = "mcp:state-request";
/// 默认超时。前端已挂载时正常往返在毫秒级，5 秒是"明显异常"的判定线。
/// 桥请求默认超时。
///
/// 这个超时不是延迟预算，而是"前端卡死时请求不能永远挂着"的兜底。
///
/// 取 15s 而不是随手定的 5s：前端在主线程繁忙时（应用刚启动正在打开项目、
/// 大章节读写）响应会被推迟，而 MCP 调用方多等 10s 的代价远小于一次假失败。
///
/// 已知局限：如果前端在请求待决期间整页重载，这次请求会直接丢失，
/// 无论超时多长都只能等到超时。这是设计上的已知代价（重载即重建监听器），
/// 不在超时值上调优就能解决的范围内。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// 桥请求（发往前端的载荷）。
#[derive(Debug, Clone, Serialize)]
pub struct StateRequestPayload {
    pub id: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

/// 一次桥查询的参数。
///
/// 用结构体而不是一串可选参数：`project-state` / `chapter-*` 是**不同形状**的请求
/// （不是键值对），继续加位置参数会让调用点变成一串 `None, None, Some(..)`。
#[derive(Debug, Clone, Default)]
pub struct StateQuery {
    pub op: String,
    pub key: Option<String>,
    pub path: Option<String>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

impl StateQuery {
    pub fn new(op: &str) -> Self {
        Self {
            op: op.to_string(),
            ..Default::default()
        }
    }

    /// `get` 类查询：带一个键。
    pub fn with_key(op: &str, key: &str) -> Self {
        Self {
            key: Some(key.to_string()),
            ..Self::new(op)
        }
    }

    /// `chapter-read` 类查询：带章节选择器。
    pub fn with_path(op: &str, path: &str) -> Self {
        Self {
            path: Some(path.to_string()),
            ..Self::new(op)
        }
    }

    pub fn with_window(mut self, offset: Option<u64>, limit: Option<u64>) -> Self {
        self.offset = offset;
        self.limit = limit;
        self
    }
}

/// 前端回传的结果。
#[derive(Debug, Clone, Deserialize)]
pub struct BridgeOutcome {
    pub ok: bool,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

impl BridgeOutcome {
    fn into_result(self) -> Result<Value, String> {
        if self.ok {
            Ok(self.value.unwrap_or(Value::Null))
        } else {
            Err(self
                .error
                .unwrap_or_else(|| "前端返回失败但未给出原因".to_string()))
        }
    }
}

/// 待决请求表：`id → oneshot 发送端`。
///
/// 内部用 `Arc` 包裹：`ToolContext` 需要把桥句柄带进每个工具，克隆必须是
/// **共享同一张表**而不是复制一张——否则工具 resolve 的是另一份表，响应永远
/// 落不到等待者手里。
#[derive(Clone, Default)]
pub struct StateBridgeState {
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<BridgeOutcome>>>>,
    /// 超时可覆盖（测试用短超时，生产用 [`DEFAULT_TIMEOUT`]）。
    timeout: Option<Duration>,
}

impl StateBridgeState {
    /// 生产用默认超时。
    pub fn new() -> Self {
        Self::default()
    }

    /// 指定超时（仅测试使用）。
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            timeout: Some(timeout),
        }
    }

    fn timeout(&self) -> Duration {
        self.timeout.unwrap_or(DEFAULT_TIMEOUT)
    }

    /// 前端回传响应。返回 `true` 表示该 `id` 确实在等（迟到/重复响应返回 `false`）。
    pub fn resolve(&self, id: &str, outcome: BridgeOutcome) -> bool {
        let sender = {
            let mut guard = match self.pending.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.remove(id)
        };
        match sender {
            Some(tx) => tx.send(outcome).is_ok(),
            None => false,
        }
    }

    /// 发起一次请求并等待响应。
    ///
    /// `emit` 抽成闭包是为了可测：测试里直接用闭包模拟前端回传，不需要真实 AppHandle。
    pub async fn request_with<F>(&self, emit: F, query: StateQuery) -> Result<Value, String>
    where
        F: FnOnce(StateRequestPayload),
    {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut guard = match self.pending.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.insert(id.clone(), tx);
        }

        let op = query.op.clone();
        emit(StateRequestPayload {
            id: id.clone(),
            op: query.op,
            key: query.key,
            path: query.path,
            offset: query.offset,
            limit: query.limit,
        });

        let timeout = self.timeout();
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome.into_result(),
            Ok(Err(_)) => {
                // 发送端被 drop：通常是超时清理后前端才回传，或状态桥被重建。
                self.forget(&id);
                Err(format!("状态桥请求被丢弃（op={op}）"))
            }
            Err(_) => {
                self.forget(&id);
                Err(format!(
                    "状态桥超时（{}s，op={op}）：前端未响应。常见原因：应用刚启动主线程繁忙、\
                     前端未挂载，或状态桥监听器未安装（非 Tauri 环境）",
                    timeout.as_secs()
                ))
            }
        }
    }

    /// 从待决表里移除（超时/取消后的清理，避免 id 泄漏）。
    fn forget(&self, id: &str) {
        let mut guard = match self.pending.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.remove(id);
    }

    /// 当前待决请求数（测试与诊断用）。
    pub fn pending_count(&self) -> usize {
        match self.pending.lock() {
            Ok(g) => g.len(),
            Err(poisoned) => poisoned.into_inner().len(),
        }
    }
}

/// 发起一次请求（生产入口）。
pub async fn request(
    app: &AppHandle,
    bridge: &StateBridgeState,
    query: StateQuery,
) -> Result<Value, String> {
    let app = app.clone();
    bridge
        .request_with(
            move |payload| {
                if let Err(e) = app.emit(REQUEST_EVENT, payload) {
                    // emit 失败通常意味着没有 webview 在听；不在这里报错是因为
                    // request_with 会在超时后给出更完整的错误。
                    log::warn!("[mcp_server] emit {REQUEST_EVENT} failed: {e}");
                }
            },
            query,
        )
        .await
}

/// 前端回传响应的命令。
#[tauri::command]
pub async fn mcp_state_respond(
    bridge: tauri::State<'_, StateBridgeState>,
    id: String,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> Result<bool, String> {
    Ok(bridge.resolve(
        &id,
        BridgeOutcome {
            ok,
            value,
            error,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn resolves_matching_id() {
        let bridge = std::sync::Arc::new(StateBridgeState::new());
        let b2 = bridge.clone();
        let handle = tokio::spawn(async move {
            bridge
                .request_with(
                    move |payload| {
                        // 模拟前端：收到请求后立刻按 id 回传。
                        let b = b2.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            b.resolve(
                                &payload.id,
                                BridgeOutcome {
                                    ok: true,
                                    value: Some(json!({"v": 42})),
                                    error: None,
                                },
                            );
                        });
                    },
                    StateQuery::with_key("get", "k"),
                )
                .await
        });
        let out = handle.await.expect("join").expect("ok");
        assert_eq!(out["v"], 42);
    }

    #[tokio::test]
    async fn times_out_with_explicit_error() {
        // 前端从不回传：必须返回 Err，而不是 Ok(None)。
        let bridge = StateBridgeState::with_timeout(Duration::from_millis(50));
        let err = bridge
            .request_with(|_payload| {}, StateQuery::with_key("get", "k"))
            .await
            .expect_err("must time out");
        assert!(err.contains("超时"), "错误信息要能指向真实原因: {err}");
        assert_eq!(bridge.pending_count(), 0, "超时后必须清理待决表，避免 id 泄漏");
    }

    #[tokio::test]
    async fn resolve_unknown_id_is_false() {
        let bridge = StateBridgeState::new();
        assert!(!bridge.resolve(
            "never-issued",
            BridgeOutcome {
                ok: true,
                value: None,
                error: None,
            }
        ));
    }

    #[tokio::test]
    async fn error_outcome_surfaces_message() {
        let bridge = std::sync::Arc::new(StateBridgeState::new());
        let b2 = bridge.clone();
        let out = bridge
            .request_with(
                move |payload| {
                    let b = b2.clone();
                    tokio::spawn(async move {
                        b.resolve(
                            &payload.id,
                            BridgeOutcome {
                                ok: false,
                                value: None,
                                error: Some("键未登记，拒绝访问: x".into()),
                            },
                        );
                    });
                },
                StateQuery::with_key("get", "x"),
            )
            .await;
        assert_eq!(out.expect_err("must be err"), "键未登记，拒绝访问: x");
    }

    #[tokio::test]
    async fn concurrent_requests_do_not_cross_talk() {
        let bridge = std::sync::Arc::new(StateBridgeState::new());
        let mut handles = Vec::new();
        for i in 0..5 {
            let b = bridge.clone();
            handles.push(tokio::spawn(async move {
                // 先克隆一份给闭包，否则闭包 move 掉 `b` 会与 request_with 的借用冲突。
                let b_for_emit = b.clone();
                b.request_with(
                    move |payload| {
                        let b = b_for_emit.clone();
                        tokio::spawn(async move {
                            // 故意乱序回传：id 关联错了就会串号。
                            tokio::time::sleep(Duration::from_millis(5 * (5 - i))).await;
                            b.resolve(
                                &payload.id,
                                BridgeOutcome {
                                    ok: true,
                                    value: Some(json!({ "i": i })),
                                    error: None,
                                },
                            );
                        });
                    },
                    StateQuery::new("get"),
                )
                .await
            }));
        }
        for (i, h) in handles.into_iter().enumerate() {
            let out = h.await.expect("join").expect("ok");
            assert_eq!(out["i"], i, "第 {i} 个请求拿到了别人的响应");
        }
    }
}
