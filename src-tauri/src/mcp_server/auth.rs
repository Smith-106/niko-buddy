//! Bearer token 鉴权。
//!
//! 三条设计约束：
//!
//! 1. **token 不进明文配置文件**。它落在既有 `credential_vault`（OS 凭据库）里，
//!    与 API key 同一套存储。app-state.json 是明文 JSON，把控制面凭据写进去等于
//!    把它摊开给任何能读该文件的东西——这与方案 C-009「凭据不出应用边界」相悖。
//! 2. **比对用定长比较**。token 是本机回环上唯一的一道门，逐字节提前返回会给出
//!    计时侧信道；虽然攻击面很小，但没有理由留这个洞。
//! 3. **轮换即吊销**。`rotate_token` 换新值后旧 token 立即失效，不需要额外的
//!    黑名单——因为服务端每次请求都拿「当前 token」比对，而不是缓存历史。

use crate::credential_vault::{vault_get_secret, vault_put_secret};

/// token 在凭据库里的逻辑键。
pub const TOKEN_VAULT_KEY: &str = "mcp-server:bearer-token";

/// 生成一个新的 bearer token（64 个十六进制字符）。
///
/// 熵来源：两次 `Uuid::new_v4()`，各 122 bit 随机，合计 244 bit。uuid v4 底层走
/// `getrandom`（CSPRNG），因此不需要为此单独引入 `rand`。
pub fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 从 `Authorization` 头里取出 bearer token 值。
///
/// 只接受 `Bearer <token>`（大小写不敏感的前缀），其它形式一律 `None`。
pub fn parse_bearer(header: Option<&str>) -> Option<&str> {
    let raw = header?;
    let (scheme, value) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// 定长比较：不因首个不同字节提前返回。
pub fn tokens_match(provided: &str, expected: &str) -> bool {
    let a = provided.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 校验 `Authorization` 头是否通过。空白 `expected` 一律拒绝（fail-closed）。
pub fn verify_authorization(header: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    match parse_bearer(header) {
        Some(provided) => tokens_match(provided, expected),
        None => false,
    }
}

/// 读取现有 token；不存在则生成并写入凭据库。
///
/// 凭据库不可用时返回 `Err`——上层据此把「外部控制」降级为不可用，
/// **不得**退化成"没有 token 也放行"。
pub fn ensure_token() -> Result<String, String> {
    match vault_get_secret(TOKEN_VAULT_KEY.to_string())? {
        Some(existing) if !existing.is_empty() => Ok(existing),
        _ => {
            let token = generate_token();
            vault_put_secret(TOKEN_VAULT_KEY.to_string(), token.clone())?;
            Ok(token)
        }
    }
}

/// 轮换 token：生成新值写入凭据库，返回新值。旧值立即失效。
pub fn rotate_token() -> Result<String, String> {
    let token = generate_token();
    vault_put_secret(TOKEN_VAULT_KEY.to_string(), token.clone())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_64_hex_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 64, "两次 uuid v4 simple 拼起来应为 64 字符");
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generated_tokens_differ() {
        assert_ne!(generate_token(), generate_token());
    }

    #[test]
    fn parse_bearer_accepts_canonical_form() {
        assert_eq!(parse_bearer(Some("Bearer abc123")), Some("abc123"));
        assert_eq!(parse_bearer(Some("bearer abc123")), Some("abc123"));
        assert_eq!(parse_bearer(Some("BEARER  abc123 ")), Some("abc123"));
    }

    #[test]
    fn parse_bearer_rejects_other_schemes_and_junk() {
        assert_eq!(parse_bearer(Some("Basic abc")), None);
        assert_eq!(parse_bearer(Some("Bearer")), None);
        assert_eq!(parse_bearer(Some("Bearer ")), None);
        assert_eq!(parse_bearer(Some("abc123")), None);
        assert_eq!(parse_bearer(None), None);
    }

    #[test]
    fn tokens_match_is_exact() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abd"));
        assert!(!tokens_match("abc", "abcd"));
        assert!(!tokens_match("", "abc"));
    }

    #[test]
    fn verify_rejects_empty_expected_token() {
        // fail-closed：没有配置 token 时不能变成"人人可进"。
        assert!(!verify_authorization(Some("Bearer anything"), ""));
    }

    #[test]
    fn verify_end_to_end() {
        let expected = generate_token();
        let header = format!("Bearer {expected}");
        assert!(verify_authorization(Some(&header), &expected));
        assert!(!verify_authorization(Some("Bearer deadbeef"), &expected));
        assert!(!verify_authorization(None, &expected));
    }
}
