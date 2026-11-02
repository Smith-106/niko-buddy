//! MCP（Model Context Protocol）JSON-RPC 2.0 线格式——**最小子集**。
//!
//! 只实现本方案需要的四类消息：`initialize` / `tools/list` / `tools/call` / `ping`，
//! 外加 `notifications/*`（无 `id`，按 MCP 规范回 202 无正文）。不做 SSE 流式、
//! 不做 sampling、不做 resources/prompts——那些不在方案 d23eb1df 的 P0 范围内，
//! 多实现一分就多一分对外攻击面。
//!
//! 协议版本取 MCP `2025-06-18`（Streamable HTTP 的稳定版本）。客户端请求的版本
//! 只要在 [`SUPPORTED_VERSIONS`] 内就原样回它，否则回我们自己的默认版本——
//! 这是 MCP 规范要求的协商方式，不是宽松匹配。

use serde::Deserialize;
use serde_json::{json, Value};

/// 本服务端默认对外声明的 MCP 协议版本。
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
/// 能接受协商的版本集合（客户端要求其它版本时回落到默认版本）。
pub const SUPPORTED_VERSIONS: [&str; 2] = ["2025-06-18", "2025-03-26"];
/// 服务端标识（出现在 `initialize` 的 `serverInfo` 里）。
pub const SERVER_NAME: &str = "niko-buddy";
/// 服务端版本，跟随 crate 版本，避免手工同步漂移。
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── JSON-RPC 2.0 错误码 ─────────────────────────────────────────────────────
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// 权限 / 策略拒绝（写入权威矩阵判定不通过、scope 不足等）。
///
/// 属于 JSON-RPC 服务端错误区间（-32000..=-32099），与 `INVALID_PARAMS` 分开：
/// 参数错是调用方写错了，权限拒绝是调用方写得对但没被允许——两者对客户端该做的事
/// 完全不同（改参数 vs 找用户要授权）。
pub const PERMISSION_DENIED: i64 = -32003;

/// 入站 JSON-RPC 请求。
///
/// `id` 为 `Option`：通知（notification）没有 `id`，按规范不得回响应。
/// `jsonrpc` 字段只做存在性校验，不参与逻辑。
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    /// 是否为通知（无 `id`）。通知一律不回响应体。
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// 成功响应。
pub fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 错误响应。`id` 未知（如解析失败）时按规范填 `null`。
pub fn error_response(id: Option<Value>, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": { "code": code, "message": message }
    })
}

/// `initialize` 的 result 体。
///
/// `capabilities` 只声明 `tools`——不声明 resources/prompts/logging，
/// 因为本服务端确实没有这些能力。声明了却没有实现，客户端会真的来调。
pub fn initialize_result(requested_version: Option<&str>) -> Value {
    let version = requested_version
        .filter(|v| SUPPORTED_VERSIONS.contains(v))
        .unwrap_or(MCP_PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    })
}

/// 把工具调用的业务结果包成 MCP 的 `tools/call` result。
///
/// MCP 要求 `content` 是内容块数组；我们把 JSON 结果序列化成一段 text，
/// 这样客户端读起来是结构化文本，且不需要自定义 content type。
pub fn tool_result(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

/// 把工具调用的业务错误包成 MCP 的 `tools/call` result（`isError: true`）。
///
/// 工具**执行**失败走这里（HTTP 200 + isError），只有协议层错误才走 JSON-RPC error。
/// 这是 MCP 规范的区别，混用会让客户端把业务错误当成协议错误重试。
pub fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_echoes_supported_version() {
        let v = initialize_result(Some("2025-03-26"));
        assert_eq!(v["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn initialize_falls_back_on_unknown_version() {
        // 客户端要一个我们不支持的版本时必须回落到默认版本，而不是照抄。
        let v = initialize_result(Some("1999-01-01"));
        assert_eq!(v["protocolVersion"], MCP_PROTOCOL_VERSION);
    }

    #[test]
    fn initialize_declares_only_tools_capability() {
        let v = initialize_result(None);
        let caps = v["capabilities"].as_object().expect("capabilities object");
        assert_eq!(caps.len(), 1, "只声明 tools，不声明未实现的能力");
        assert!(caps.contains_key("tools"));
        assert_eq!(v["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(v["serverInfo"]["version"], SERVER_VERSION);
    }

    #[test]
    fn error_response_uses_null_id_when_unknown() {
        let v = error_response(None, PARSE_ERROR, "bad json");
        assert_eq!(v["id"], Value::Null);
        assert_eq!(v["error"]["code"], PARSE_ERROR);
    }

    #[test]
    fn tool_result_and_error_are_distinguishable() {
        assert_eq!(tool_result(&json!({"a": 1}))["isError"], false);
        assert_eq!(tool_error("boom")["isError"], true);
    }

    #[test]
    fn notification_is_recognised_by_missing_id() {
        let n: JsonRpcRequest =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .expect("parse");
        assert!(n.is_notification());
        let r: JsonRpcRequest =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#).expect("parse");
        assert!(!r.is_notification());
    }
}
