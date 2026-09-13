//! F-005 真机冒烟（**默认忽略**）：真实 HTTP 往返 + opt-in 门 + Bearer + 审计拦截。
//!
//! ```text
//! cd QMAI/src-tauri
//! node ../scripts/smoke-f005-endpoint.mjs 8791 ../smoke-f005-endpoint.jsonl &   # 先起端点
//! NB_MCP_ENDPOINT=http://127.0.0.1:8791/mcp cargo test --test f005_remote_smoke -- --ignored --nocapture
//! ```
//!
//! 与 `src/mcp_remote.rs` 内联单测的区别：那些用例只验证**计划**（同步、无网络），
//! 本文件走 `api::mcp_remote_request` 的**真实 reqwest POST**，并由本机端点记录实收请求。
//! 令牌写入真实 OS 凭据库（`mcp:<server_id>`），用例结束即删除。

use niko_buddy_lib::credential_vault as vault;
use niko_buddy_lib::mcp_remote as remote;
use niko_buddy_lib::mcp_transport as transport;

const SERVER: &str = "smoke-f005";

fn endpoint() -> String {
    std::env::var("NB_MCP_ENDPOINT").expect("需先设置 NB_MCP_ENDPOINT 指向本机端点")
}

/// 只读本机端点日志，取最后一条请求记录。
fn last_request(log_path: &str) -> Option<String> {
    let text = std::fs::read_to_string(log_path).ok()?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .next_back()
        .map(str::to_string)
}

#[test]
#[ignore = "真机冒烟：需要本机 HTTP 端点（scripts/smoke-f005-endpoint.mjs）"]
fn real_http_roundtrip_with_optin_and_bearer() {
    let log = std::env::var("NB_MCP_LOG").unwrap_or_else(|_| "../smoke-f005-endpoint.jsonl".into());
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(".smoke-f005");
    std::fs::create_dir_all(&root).expect("创建冒烟项目根");
    let ep = endpoint();
    println!("[0] endpoint={ep} root={}", root.display());

    // [1] 默认 stdio：远端连接必须被拒（opt-in 门）。
    transport::set_mode(&root, "stdio", false).expect("回到默认 stdio 应成功");
    let denied = remote::mcp_remote_connect(&root, SERVER);
    println!("[1] stdio 下 connect -> {denied:?}");
    match denied {
        Err(remote::McpError::NotConnected(msg)) => {
            assert!(msg.contains("stdio"), "拒因应点明当前是 stdio：{msg}");
        }
        other => panic!("默认 stdio 下 connect 应为 NotConnected，实际 {other:?}"),
    }

    // [2] 开 http 但不带 opt-in：仍须拒绝，且**不得**写出远端配置。
    let no_optin = transport::set_mode(&root, "http", false);
    println!("[2] set_mode(http, allow_http=false) -> {no_optin:?}");
    assert!(no_optin.is_err(), "http 未显式 opt-in 必须被拒");
    let cfg_path = transport::transport_config_path(&root);
    if cfg_path.is_file() {
        let raw = std::fs::read_to_string(&cfg_path).unwrap_or_default();
        assert!(
            !raw.contains("\"http\""),
            "被拒的 opt-in 不得留下 http 配置：{raw}"
        );
    }

    // [3] 显式 opt-in + 真实令牌入 OS 凭据库。
    transport::set_mode(&root, "http", true).expect("opt-in 后应成功");
    let token = "smoke-token-f005-7788";
    let key = remote::credential_key(SERVER);
    vault::vault_put_secret(key.clone(), token.to_string()).expect("真实写入令牌");
    println!("[3] opt-in 完成，令牌写入键 {key}");

    let session = remote::mcp_remote_connect(&root, SERVER).expect("opt-in 后应可连接");
    println!("[3] connect -> {session:?}");
    assert_eq!(session.transport, "http");
    assert!(session.credential_present, "凭据应被检出（但绝不回传明文）");

    // [4] 真实 POST：本机端点必须实收到请求，且带 Bearer 令牌。
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let payload = rt
        .block_on(remote::api::mcp_remote_request(
            root.to_string_lossy().to_string(),
            SERVER.to_string(),
            body.to_string(),
        ))
        .expect("真实 HTTP 请求应成功");
    println!(
        "[4] payload.audit_pending={} origin={}",
        payload.audit_pending, payload.origin
    );
    assert!(payload.audit_pending, "远端载荷必须标记待审计");
    assert!(
        !payload.body.contains(token),
        "响应体不得包含我们发出的令牌"
    );
    assert_eq!(payload.origin, ep, "origin 必须记录真实端点作为来源");

    let logged = last_request(&log).expect("端点日志应有请求记录");
    println!("[4] 端点实收: {logged}");
    assert!(
        logged.contains("\"method\":\"POST\""),
        "端点应收到 POST：{logged}"
    );
    assert!(
        logged.contains(&format!("Bearer {token}")),
        "端点应收到 Authorization: Bearer 令牌：{logged}"
    );
    assert!(
        logged.contains(&format!("\"bodyBytes\":{}", body.len())),
        "请求体长度应被端点记录（期望 {}）：{logged}",
        body.len()
    );

    // [5] 远端响应超 4MB 上限：必须被拒（不能把超限内容灌进来）。
    // 计划里的 endpoint 取自会话（connect 时快照），故超限场景需先切端点再重连。
    std::env::set_var("NB_MCP_ENDPOINT", "http://127.0.0.1:8791/big");
    let session_big = remote::mcp_remote_connect(&root, SERVER).expect("切到超限端点后应可重连");
    println!("[5] 超限端点会话 -> {}", session_big.endpoint);
    assert!(session_big.endpoint.ends_with("/big"));
    let over = rt.block_on(remote::api::mcp_remote_request(
        root.to_string_lossy().to_string(),
        SERVER.to_string(),
        body.to_string(),
    ));
    println!("[5] 5MB 响应 -> {over:?}");
    match over {
        Err(msg) => {
            // 命令层把 McpError 映射为 String（Tauri 边界），故断在文本上。
            println!("[5] 拒因: {msg}");
            assert!(
                msg.contains("exceeds")
                    || msg.contains("too large")
                    || msg.contains("MCP_TRANSPORT"),
                "拒因应说明超限：{msg}"
            );
        }
        Ok(payload) => panic!("超限响应必须被拒，实际拿到 {} 字节", payload.body.len()),
    }
    // 恢复常规端点会话，供后续审计用例使用。
    std::env::set_var("NB_MCP_ENDPOINT", &ep);
    let restored = remote::mcp_remote_connect(&root, SERVER).expect("恢复端点应成功");
    println!("[5] 恢复端点 -> {}", restored.endpoint);
    assert_eq!(restored.endpoint, ep);

    // [6] 审计链：非 Allow 一律拒绝；伪造来源也拒绝；Allow 后真写入只允许落在草稿区，
    //     而保护区（QM/canon）即使 Allow + External 也必须被门硬拒。
    let target = "drafts/f005.md";
    for verdict in [remote::AuditVerdict::Block, remote::AuditVerdict::Review] {
        let denied = remote::ingest_remote_payload(&root, target, &payload, verdict);
        println!("[6] ingest({verdict:?}) -> {denied:?}");
        assert!(
            matches!(denied, Err(remote::McpError::AuditBlocked(_))),
            "{verdict:?} 必须被拦"
        );
        assert!(!root.join(target).exists(), "{verdict:?} 被拦后不得落盘");
    }
    // 伪造来源（audit_pending=false）也不得入库。
    let forged = remote::RemotePayload {
        audit_pending: false,
        ..payload.clone()
    };
    let forged_result =
        remote::ingest_remote_payload(&root, target, &forged, remote::AuditVerdict::Allow);
    println!("[6] ingest(伪造 audit_pending=false) -> {forged_result:?}");
    assert!(matches!(
        forged_result,
        Err(remote::McpError::AuditBlocked(_))
    ));
    assert!(!root.join(target).exists(), "伪造来源不得落盘");

    // Allow + 草稿区：当前契约下会落盘（writeFile 不在门的破坏性操作表内）。
    // 这里把它作为**已声明的限制**连同保护路径反向用例一起固化下来。
    let written =
        remote::ingest_remote_payload(&root, target, &payload, remote::AuditVerdict::Allow);
    println!("[6] ingest(Allow, External, 草稿区) -> {written:?}");
    assert!(written.is_ok(), "Allow 后草稿区应可落盘");
    assert!(root.join(target).is_file(), "落盘文件应存在");

    // 保护路径：即使 Allow + External，门必须硬拒且零写入。
    for protected in ["QM/memory/f005.md", "canon/f005.md"] {
        let denied =
            remote::ingest_remote_payload(&root, protected, &payload, remote::AuditVerdict::Allow);
        println!("[6] ingest(Allow, External, {protected}) -> {denied:?}");
        assert!(
            matches!(denied, Err(remote::McpError::AuditBlocked(_))),
            "{protected} 必须被门拒"
        );
        assert!(!root.join(protected).exists(), "{protected} 不得落盘");
    }

    // [7] 收尾：关闭会话 + 删除真实凭据，不留残留。
    let closed = remote::mcp_remote_close(SERVER).expect("关闭应成功");
    let removed = vault::vault_delete_secret(key).expect("删除令牌应成功");
    println!(
        "[7] closed={closed} tokenRemoved={removed} 剩余会话={}",
        remote::open_session_count()
    );
    assert!(closed, "会话应被关闭");
    assert!(removed, "令牌应被删除（不留残留）");
    assert_eq!(remote::open_session_count(), 0);
    let _ = std::fs::remove_dir_all(&root);
    println!("[8] F-005 真机冒烟 PASS：opt-in 门 + 真实 POST + Bearer + 超限拒绝 + 先审后入库");
}
