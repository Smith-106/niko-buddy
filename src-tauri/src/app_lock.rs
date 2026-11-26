//! 应用锁（F-004）：启动门禁 + 遮挡层的数据面。
//!
//! 设计要点：
//! * 口令**不以明文入任何存储**。v2 写入随机 16 字节盐 + 设备绑定 PBKDF2-HMAC-SHA256
//!   派生值（`v2$<iters>$<32-hex-salt>$<64-hex-dk>`，生产默认 200,000 轮），
//!   同时兼容只读校验旧 v1（64-hex SHA-256）并在首次验证通过后静默升级至 v2。
//! * 派生值存进 `credential_vault`（OS 凭据库），因此**不在** `.novel` / `QM` 数据区。
//! * 本模块 MUST NOT 加密 `.novel/status.json` 或 `.novel` 可重建区——状态真源与
//!   只读投影必须保持可被外部工具读取。
//! * 未设置口令时状态为 `NotConfigured`（不是 Locked）：门禁只在用户真的设了口令后生效，
//!   否则全新项目会被自己的锁挡在门外。

use std::fmt::Write as _;
#[cfg(test)]
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::credential_vault::{vault_get_secret, vault_put_secret};

/// 应用锁口令派生值在凭据库里的逻辑键。
pub const APP_LOCK_KEY: &str = "applock:passphrase";

/// 连续校验失败触发限流的阈值。
pub const MAX_VERIFY_FAILURES: u32 = 5;

/// 触发限流后的冷却时长（秒）。
pub const VERIFY_LOCKOUT_SECS: u64 = 30;

/// v2 PBKDF2-HMAC-SHA256 生产默认迭代次数（OWASP 推荐量级）。
pub const PBKDF2_ITERATIONS: u32 = 200_000;

/// v2 验证可接受的最小迭代次数（防止降级篡改）。
const PBKDF2_MIN_VERIFY_ITERATIONS: u32 = 100_000;

/// v2 验证可接受的最大迭代次数（防止恶意大数触发 CPU DoS）。
const PBKDF2_MAX_VERIFY_ITERATIONS: u32 = 2_000_000;

/// v2 存储格式版本前缀。
const VERIFIER_V2_PREFIX: &str = "v2";

/// 随机盐长度（16 字节 = 128 bit，由 UUIDv4 OS CSPRNG 生成）。
const PBKDF2_SALT_BYTES: usize = 16;

/// PBKDF2-HMAC-SHA256 派生输出长度（32 字节 = 256 bit）。
const PBKDF2_DK_BYTES: usize = 32;

/// 仅测试可覆盖的迭代次数：常规状态机单测用 1_000 轮提速，另有专门用例实测 200_000 轮。
#[cfg(test)]
static TEST_PBKDF2_ITERATIONS: AtomicU32 = AtomicU32::new(PBKDF2_ITERATIONS);

fn active_pbkdf2_iterations() -> u32 {
    #[cfg(test)]
    {
        TEST_PBKDF2_ITERATIONS.load(Ordering::SeqCst)
    }
    #[cfg(not(test))]
    {
        PBKDF2_ITERATIONS
    }
}

fn min_verify_iterations() -> u32 {
    #[cfg(test)]
    {
        PBKDF2_MIN_VERIFY_ITERATIONS
            .min(TEST_PBKDF2_ITERATIONS.load(Ordering::SeqCst))
            .max(1)
    }
    #[cfg(not(test))]
    {
        PBKDF2_MIN_VERIFY_ITERATIONS
    }
}

/// 应用锁状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockState {
    /// 未设置口令 → 不遮挡（门禁未启用）。
    NotConfigured,
    /// 已设置口令且本进程尚未验证 → 遮挡层必须覆盖全窗口。
    Locked,
    /// 本进程已通过验证。
    Unlocked,
}

impl LockState {
    pub fn as_str(&self) -> &'static str {
        match self {
            LockState::NotConfigured => "not_configured",
            LockState::Locked => "locked",
            LockState::Unlocked => "unlocked",
        }
    }
}

/// 本进程是否已验证通过。进程级：重启后回到 Locked（口令仍在）。
static UNLOCKED: AtomicBool = AtomicBool::new(false);

struct VerifyRateLimit {
    consecutive_failures: u32,
    locked_until: Option<Instant>,
}

/// T5 叶子锁：连续失败 5 次后锁定 30 秒，防进程内暴力穷举口令。
static APP_LOCK_RATE: Mutex<VerifyRateLimit> = Mutex::new(VerifyRateLimit {
    consecutive_failures: 0,
    locked_until: None,
});

fn check_verify_rate_limit() -> Result<(), String> {
    let mut guard = APP_LOCK_RATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(until) = guard.locked_until {
        let now = Instant::now();
        if now < until {
            let remaining = until.saturating_duration_since(now).as_secs().max(1);
            return Err(format!(
                "[app_lock] too many failed attempts; retry in {remaining}s"
            ));
        }
        guard.locked_until = None;
        guard.consecutive_failures = 0;
    }
    Ok(())
}

fn record_verify_outcome(ok: bool) {
    let mut guard = APP_LOCK_RATE.lock().unwrap_or_else(|e| e.into_inner());
    if ok {
        guard.consecutive_failures = 0;
        guard.locked_until = None;
    } else {
        guard.consecutive_failures = guard.consecutive_failures.saturating_add(1);
        if guard.consecutive_failures >= MAX_VERIFY_FAILURES {
            guard.locked_until = Some(Instant::now() + Duration::from_secs(VERIFY_LOCKOUT_SECS));
        }
    }
}

fn reset_verify_rate_limit() {
    let mut guard = APP_LOCK_RATE.lock().unwrap_or_else(|e| e.into_inner());
    guard.consecutive_failures = 0;
    guard.locked_until = None;
}

/// 仅测试可用：清空口令校验失败限流状态。
#[cfg(test)]
pub fn __reset_rate_limit_for_test() {
    reset_verify_rate_limit();
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn hex_to_bytes<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 || !hex.is_ascii() {
        return None;
    }
    let mut out = [0u8; N];
    let (pairs, remainder) = hex.as_bytes().as_chunks::<2>();
    if !remainder.is_empty() || pairs.len() != N {
        return None;
    }
    for (dst, &[hi_b, lo_b]) in out.iter_mut().zip(pairs.iter()) {
        let hi = hex_nibble(hi_b)?;
        let lo = hex_nibble(lo_b)?;
        *dst = (hi << 4) | lo;
    }
    Some(out)
}

fn hmac_sha256_key_block(key: &[u8]) -> [u8; 64] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        let digest = Sha256::digest(key);
        block[..32].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    block
}

fn hmac_sha256_bases(key: &[u8]) -> (Sha256, Sha256) {
    let key_block = hmac_sha256_key_block(key);
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for ((ip, op), &k) in ipad.iter_mut().zip(opad.iter_mut()).zip(key_block.iter()) {
        *ip ^= k;
        *op ^= k;
    }
    let mut ipad_base = Sha256::new();
    ipad_base.update(ipad);
    let mut opad_base = Sha256::new();
    opad_base.update(opad);
    (ipad_base, opad_base)
}

fn hmac_sha256_with_bases(ipad_base: &Sha256, opad_base: &Sha256, data: &[u8]) -> [u8; 32] {
    let mut inner = ipad_base.clone();
    inner.update(data);
    let inner_digest = inner.finalize();

    let mut outer = opad_base.clone();
    outer.update(inner_digest);
    outer.finalize().into()
}

/// 标准 RFC 2898 PBKDF2-HMAC-SHA256（单 32 字节输出块 `INT_32_BE(1)`），
/// 在循环外预吸收 ipad/opad 键块以减少 50% SHA-256 压缩次数。
fn pbkdf2_hmac_sha256_32(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    assert!(iterations >= 1, "PBKDF2 iterations must be >= 1");
    let (ipad_base, opad_base) = hmac_sha256_bases(password);

    // U_1 = PRF(password, salt || INT_32_BE(1))
    let mut inner = ipad_base.clone();
    inner.update(salt);
    inner.update(1u32.to_be_bytes());
    let inner_digest = inner.finalize();
    let mut outer = opad_base.clone();
    outer.update(inner_digest);
    let mut u: [u8; 32] = outer.finalize().into();
    let mut dk = u;

    // U_2 .. U_c
    for _ in 1..iterations {
        u = hmac_sha256_with_bases(&ipad_base, &opad_base, &u);
        for (acc, &byte) in dk.iter_mut().zip(u.iter()) {
            *acc ^= byte;
        }
    }
    dk
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    bytes_to_hex(&digest)
}

/// 设备绑定输入。复用既有设备指纹（`commands::crypto::get_device_fingerprint`）。
fn device_bound_passphrase(passphrase: &str) -> String {
    let device = crate::commands::crypto::get_device_fingerprint();
    format!("{device}::applock::{passphrase}")
}

/// 旧 v1 派生格式（仅用于向后兼容只读校验与首次解锁升级）。
fn derive_verifier_v1(passphrase: &str) -> String {
    sha256_hex(&device_bound_passphrase(passphrase))
}

/// v2 派生格式：`v2$<iters>$<32-hex-salt>$<64-hex-dk>`。
fn derive_verifier_v2_with_salt(
    passphrase: &str,
    salt: &[u8; PBKDF2_SALT_BYTES],
    iterations: u32,
) -> String {
    let input = device_bound_passphrase(passphrase);
    let dk = pbkdf2_hmac_sha256_32(input.as_bytes(), salt, iterations);
    format!(
        "{VERIFIER_V2_PREFIX}${iterations}${}${}",
        bytes_to_hex(salt),
        bytes_to_hex(&dk)
    )
}

/// 使用 OS CSPRNG 随机 16 字节盐生成 v2 verifier。
fn derive_verifier_v2(passphrase: &str) -> String {
    let salt = *uuid::Uuid::new_v4().as_bytes();
    derive_verifier_v2_with_salt(passphrase, &salt, active_pbkdf2_iterations())
}

enum StoredVerifierKind {
    V2 {
        iterations: u32,
        salt: [u8; PBKDF2_SALT_BYTES],
        expected_dk: [u8; PBKDF2_DK_BYTES],
    },
    V1Hex,
    Invalid,
}

fn parse_stored_verifier(stored: &str) -> StoredVerifierKind {
    if let Some(rest) = stored.strip_prefix("v2$") {
        let mut parts = rest.split('$');
        let (Some(iters_str), Some(salt_hex), Some(dk_hex), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return StoredVerifierKind::Invalid;
        };
        let Ok(iterations) = iters_str.parse::<u32>() else {
            return StoredVerifierKind::Invalid;
        };
        let min_iters = min_verify_iterations();
        if !(min_iters..=PBKDF2_MAX_VERIFY_ITERATIONS).contains(&iterations) {
            return StoredVerifierKind::Invalid;
        }
        let (Some(salt), Some(expected_dk)) = (
            hex_to_bytes::<PBKDF2_SALT_BYTES>(salt_hex),
            hex_to_bytes::<PBKDF2_DK_BYTES>(dk_hex),
        ) else {
            return StoredVerifierKind::Invalid;
        };
        return StoredVerifierKind::V2 {
            iterations,
            salt,
            expected_dk,
        };
    }
    if stored.len() == 64 && stored.bytes().all(|b| b.is_ascii_hexdigit()) {
        return StoredVerifierKind::V1Hex;
    }
    StoredVerifierKind::Invalid
}

/// 定长字节比较，避免提前返回泄露前缀信息。
fn constant_time_eq_bytes(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 定长字符串比较（v1 只读校验复用）。
fn constant_time_eq(a: &str, b: &str) -> bool {
    constant_time_eq_bytes(a.as_bytes(), b.as_bytes())
}

/// 校验口令，返回 `(是否匹配, 是否命中旧 v1 需静默升级)`。
fn verify_against_stored(passphrase: &str, stored: &str) -> Result<(bool, bool), String> {
    check_verify_rate_limit()?;
    let (ok, is_v1) = match parse_stored_verifier(stored) {
        StoredVerifierKind::V2 {
            iterations,
            salt,
            expected_dk,
        } => {
            let input = device_bound_passphrase(passphrase);
            let candidate = pbkdf2_hmac_sha256_32(input.as_bytes(), &salt, iterations);
            (constant_time_eq_bytes(&candidate, &expected_dk), false)
        }
        StoredVerifierKind::V1Hex => {
            let candidate = derive_verifier_v1(passphrase);
            (constant_time_eq(&candidate, stored), true)
        }
        StoredVerifierKind::Invalid => (false, false),
    };
    record_verify_outcome(ok);
    Ok((ok, ok && is_v1))
}

/// 已有口令派生值时返回它（`None` = 未配置）。
pub fn stored_verifier() -> Result<Option<String>, String> {
    vault_get_secret(APP_LOCK_KEY.to_string())
}

/// 设置或修改应用锁口令（BLOCKING-6）：
/// * `Locked` 态必须提供 `Some(current_passphrase)` 且通过限流校验，防止未解锁态直接覆盖口令；
/// * `NotConfigured` 与 `Unlocked` 态允许 `None`（若 `Unlocked` 态传入 `Some(cur)` 则必须校验通过）。
pub fn app_lock_set_passphrase(
    passphrase: String,
    current_passphrase: Option<String>,
) -> Result<LockState, String> {
    if let Some(stored) = stored_verifier()? {
        let is_unlocked = UNLOCKED.load(Ordering::SeqCst);
        if !is_unlocked {
            let Some(current) = current_passphrase.as_deref() else {
                return Err(
                    "[app_lock] current passphrase is required while app is locked".to_string(),
                );
            };
            if !verify_against_stored(current, &stored)?.0 {
                return Err("[app_lock] current passphrase is incorrect".to_string());
            }
        } else if let Some(current) = current_passphrase.as_deref() {
            if !verify_against_stored(current, &stored)?.0 {
                return Err("[app_lock] current passphrase is incorrect".to_string());
            }
        }
    }

    if passphrase.trim().len() < MIN_PASSPHRASE_LEN {
        return Err(format!(
            "[app_lock] passphrase must be at least {} characters",
            MIN_PASSPHRASE_LEN
        ));
    }
    let verifier = derive_verifier_v2(&passphrase);
    vault_put_secret(APP_LOCK_KEY.to_string(), verifier)?;
    reset_verify_rate_limit();
    UNLOCKED.store(true, Ordering::SeqCst);
    Ok(LockState::Unlocked)
}

/// 最短口令长度（与遮挡层输入校验共用同一常量）。
pub const MIN_PASSPHRASE_LEN: usize = 6;

pub fn app_lock_verify(passphrase: String) -> Result<bool, String> {
    let Some(stored) = stored_verifier()? else {
        return Err("[app_lock] no passphrase configured".to_string());
    };
    let (ok, should_upgrade_v1) = verify_against_stored(&passphrase, &stored)?;
    if ok {
        if should_upgrade_v1 {
            let upgraded = derive_verifier_v2(&passphrase);
            if let Err(e) = vault_put_secret(APP_LOCK_KEY.to_string(), upgraded) {
                log::warn!("[app_lock] failed to silently upgrade v1 verifier to v2: {e}");
            }
        }
        UNLOCKED.store(true, Ordering::SeqCst);
    }
    Ok(ok)
}

pub fn app_lock_state() -> LockState {
    match stored_verifier() {
        Ok(None) => LockState::NotConfigured,
        Ok(Some(_)) => {
            if UNLOCKED.load(Ordering::SeqCst) {
                LockState::Unlocked
            } else {
                LockState::Locked
            }
        }
        // 凭据库不可用时保守为 Locked：宁可要求验证，也不静默放行。
        Err(_) => LockState::Locked,
    }
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────
//
// 核心保持模块根的 `pub fn`（同步、可单测）；命令在 `api` 子模块转发。
pub mod api {
    use super::LockState;
    use crate::panic_guard::run_guarded;

    #[tauri::command]
    pub async fn app_lock_set_passphrase(
        passphrase: String,
        current_passphrase: Option<String>,
    ) -> Result<LockState, String> {
        tauri::async_runtime::spawn_blocking(move || {
            run_guarded("app_lock_set_passphrase", || {
                super::app_lock_set_passphrase(passphrase, current_passphrase)
            })
        })
        .await
        .map_err(|e| format!("app_lock_set_passphrase blocking task join error: {e}"))?
    }

    #[tauri::command]
    pub async fn app_lock_verify(passphrase: String) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            run_guarded("app_lock_verify", || super::app_lock_verify(passphrase))
        })
        .await
        .map_err(|e| format!("app_lock_verify blocking task join error: {e}"))?
    }

    #[tauri::command]
    pub async fn app_lock_state() -> Result<LockState, String> {
        tauri::async_runtime::spawn_blocking(|| {
            run_guarded("app_lock_state", || Ok(super::app_lock_state()))
        })
        .await
        .map_err(|e| format!("app_lock_state blocking task join error: {e}"))?
    }
}

#[cfg(test)]
mod applock {
    use super::*;
    use crate::credential_vault::__set_test_backend;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryVault {
        entries: Mutex<Vec<(String, String)>>,
    }

    impl crate::credential_vault::VaultBackend for MemoryVault {
        fn set(&self, _service: &str, account: &str, secret: &str) -> Result<(), String> {
            let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            guard.retain(|(a, _)| a != account);
            guard.push((account.to_string(), secret.to_string()));
            Ok(())
        }

        fn get(&self, _service: &str, account: &str) -> Result<Option<String>, String> {
            let guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            Ok(guard
                .iter()
                .find(|(a, _)| a == account)
                .map(|(_, s)| s.clone()))
        }

        fn delete(&self, _service: &str, account: &str) -> Result<bool, String> {
            let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let before = guard.len();
            guard.retain(|(a, _)| a != account);
            Ok(guard.len() != before)
        }
    }

    struct Guard {
        _lock: tokio::sync::MutexGuard<'static, ()>,
    }

    impl Guard {
        fn new() -> Guard {
            Self::with_iterations(1_000)
        }

        fn new_production() -> Guard {
            Self::with_iterations(PBKDF2_ITERATIONS)
        }

        fn with_iterations(iterations: u32) -> Guard {
            let lock = crate::credential_vault::vault_test_serial();
            __set_test_backend(Some(Arc::new(MemoryVault::default())));
            TEST_PBKDF2_ITERATIONS.store(iterations, Ordering::SeqCst);
            UNLOCKED.store(false, Ordering::SeqCst);
            __reset_rate_limit_for_test();
            Guard { _lock: lock }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            TEST_PBKDF2_ITERATIONS.store(PBKDF2_ITERATIONS, Ordering::SeqCst);
            __set_test_backend(None);
            UNLOCKED.store(false, Ordering::SeqCst);
            __reset_rate_limit_for_test();
        }
    }

    #[test]
    fn not_configured_before_setting_passphrase() {
        let _guard = Guard::new();
        assert_eq!(app_lock_state(), LockState::NotConfigured);
    }

    #[test]
    fn wrong_passphrase_rejects() {
        let _guard = Guard::new();
        assert_eq!(
            app_lock_set_passphrase("correct-horse".into(), None).unwrap(),
            LockState::Unlocked
        );
        // 重新上锁：模拟重启（进程级 UNLOCKED 复位，凭据仍在）。
        UNLOCKED.store(false, Ordering::SeqCst);
        assert_eq!(app_lock_state(), LockState::Locked);

        assert!(!app_lock_verify("wrong-horse".into()).unwrap());
        assert_eq!(app_lock_state(), LockState::Locked, "错误口令不得解锁");

        assert!(app_lock_verify("correct-horse".into()).unwrap());
        assert_eq!(app_lock_state(), LockState::Unlocked);
    }

    #[test]
    fn verifier_never_contains_plaintext_and_is_device_bound() {
        let _guard = Guard::new();
        app_lock_set_passphrase("correct-horse".into(), None).unwrap();
        let stored = stored_verifier().unwrap().expect("stored");
        assert!(!stored.contains("correct-horse"), "不得存明文口令");
        assert!(
            stored.starts_with("v2$"),
            "新口令必须以 v2 PBKDF2 格式存储: {stored}"
        );
        let parts: Vec<&str> = stored.split('$').collect();
        assert_eq!(parts.len(), 4, "v2 格式应为 4 段: {stored}");
        assert_eq!(parts[0], VERIFIER_V2_PREFIX);
        assert_eq!(parts[1], "1000");
        assert_eq!(parts[2].len(), PBKDF2_SALT_BYTES * 2, "16 字节盐 = 32 hex");
        assert_eq!(parts[3].len(), PBKDF2_DK_BYTES * 2, "32 字节摘要 = 64 hex");

        // 随机盐非确定性：同口令两次派生结果必须不同。
        let second = derive_verifier_v2("correct-horse");
        assert_ne!(stored, second, "随机盐必须使两次派生值不同");
    }

    #[test]
    fn pbkdf2_hmac_sha256_matches_rfc_standard_vectors() {
        // 标准 PBKDF2-HMAC-SHA256 测试向量（RFC 6070 对应 SHA-256 组，c = 1, 2, 4096）。
        assert_eq!(
            bytes_to_hex(&pbkdf2_hmac_sha256_32(b"password", b"salt", 1)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            bytes_to_hex(&pbkdf2_hmac_sha256_32(b"password", b"salt", 2)),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        assert_eq!(
            bytes_to_hex(&pbkdf2_hmac_sha256_32(b"password", b"salt", 4096)),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
        assert_eq!(
            bytes_to_hex(&pbkdf2_hmac_sha256_32(
                b"passwordPASSWORDpassword",
                b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
                4096
            )),
            "348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1"
        );
    }

    #[test]
    fn production_200k_iterations_roundtrip_and_random_salt() {
        let _guard = Guard::new_production();
        assert_eq!(active_pbkdf2_iterations(), PBKDF2_ITERATIONS);
        assert_eq!(PBKDF2_ITERATIONS, 200_000);

        let v1 = derive_verifier_v2("prod-passphrase");
        assert!(v1.starts_with("v2$200000$"), "got: {v1}");
        vault_put_secret(APP_LOCK_KEY.to_string(), v1.clone()).unwrap();

        assert!(!app_lock_verify("wrong-passphrase".into()).unwrap());
        assert!(app_lock_verify("prod-passphrase".into()).unwrap());
        assert_eq!(app_lock_state(), LockState::Unlocked);
    }

    #[test]
    fn legacy_v1_verifier_verifies_and_silently_upgrades_to_v2() {
        let _guard = Guard::new();
        let legacy = derive_verifier_v1("legacy-horse");
        assert_eq!(legacy.len(), 64);
        vault_put_secret(APP_LOCK_KEY.to_string(), legacy.clone()).unwrap();
        assert_eq!(app_lock_state(), LockState::Locked);

        // 错误口令不得触发静默升级。
        assert!(!app_lock_verify("wrong-horse".into()).unwrap());
        assert_eq!(stored_verifier().unwrap().as_deref(), Some(legacy.as_str()));

        // 正确口令验证通过后立即静默升级至 v2 格式。
        assert!(app_lock_verify("legacy-horse".into()).unwrap());
        assert_eq!(app_lock_state(), LockState::Unlocked);
        let upgraded = stored_verifier().unwrap().expect("upgraded verifier");
        assert!(upgraded.starts_with("v2$"), "应静默升级为 v2: {upgraded}");
        assert_ne!(upgraded, legacy);

        // 再次上锁后按新 v2 格式验证应继续通过。
        UNLOCKED.store(false, Ordering::SeqCst);
        assert!(app_lock_verify("legacy-horse".into()).unwrap());
    }

    #[test]
    fn malformed_and_out_of_bounds_v2_verifiers_are_rejected() {
        let _guard = Guard::new_production();
        let valid_salt = [0x11u8; PBKDF2_SALT_BYTES];
        let low_iters = derive_verifier_v2_with_salt("correct-horse", &valid_salt, 99_999);
        let high_iters = format!(
            "v2$2000001${}${}",
            bytes_to_hex(&valid_salt),
            "aa".repeat(PBKDF2_DK_BYTES)
        );
        let zero_iters = format!(
            "v2$0${}${}",
            bytes_to_hex(&valid_salt),
            "aa".repeat(PBKDF2_DK_BYTES)
        );
        let bad_hex = format!(
            "v2$200000$zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz${}",
            "aa".repeat(PBKDF2_DK_BYTES)
        );
        let wrong_parts = "v2$200000$abcd".to_string();
        let garbage = "not-a-valid-verifier".to_string();

        for bad in [
            low_iters,
            high_iters,
            zero_iters,
            bad_hex,
            wrong_parts,
            garbage,
        ] {
            __reset_rate_limit_for_test();
            vault_put_secret(APP_LOCK_KEY.to_string(), bad.clone()).unwrap();
            assert!(
                !app_lock_verify("correct-horse".into()).unwrap(),
                "非法或越界迭代数 verifier 必须 fail-closed 拒绝: {bad}"
            );
        }
    }

    #[test]
    fn short_passphrase_is_rejected() {
        let _guard = Guard::new();
        assert!(app_lock_set_passphrase("abc".into(), None).is_err());
        assert_eq!(app_lock_state(), LockState::NotConfigured);
    }

    #[test]
    fn state_without_passphrase_never_blocks() {
        let _guard = Guard::new();
        // 未配置时 verify 明确报错，而不是静默返回 false。
        assert!(app_lock_verify("anything".into()).is_err());
        assert_eq!(app_lock_state(), LockState::NotConfigured);
    }

    #[test]
    fn locked_state_requires_valid_current_passphrase_to_rotate() {
        let _guard = Guard::new();
        app_lock_set_passphrase("initial-secret".into(), None).unwrap();
        UNLOCKED.store(false, Ordering::SeqCst);
        assert_eq!(app_lock_state(), LockState::Locked);

        // Locked 态不传 current_passphrase 必须拒绝。
        let err_none = app_lock_set_passphrase("hijack-secret".into(), None).unwrap_err();
        assert!(err_none.contains("required"), "{err_none}");
        assert_eq!(app_lock_state(), LockState::Locked);

        // Locked 态传错 current_passphrase 必须拒绝且不得覆盖旧口令。
        let err_wrong =
            app_lock_set_passphrase("hijack-secret".into(), Some("wrong-secret".into()))
                .unwrap_err();
        assert!(err_wrong.contains("incorrect"), "{err_wrong}");
        assert_eq!(app_lock_state(), LockState::Locked);

        // Locked 态传对 current_passphrase 允许改密并解锁。
        assert_eq!(
            app_lock_set_passphrase("rotated-secret".into(), Some("initial-secret".into()))
                .unwrap(),
            LockState::Unlocked
        );

        // Unlocked 态允许 None 改密，但若传 Some(cur) 则仍须校验。
        assert!(app_lock_set_passphrase("bad-rotate".into(), Some("wrong-secret".into())).is_err());
        assert_eq!(
            app_lock_set_passphrase("unlocked-rotate".into(), None).unwrap(),
            LockState::Unlocked
        );
        UNLOCKED.store(false, Ordering::SeqCst);
        assert!(app_lock_verify("unlocked-rotate".into()).unwrap());
    }

    #[test]
    fn verify_rate_limits_after_five_failures_and_test_reset_clears() {
        let _guard = Guard::new();
        app_lock_set_passphrase("correct-horse".into(), None).unwrap();
        UNLOCKED.store(false, Ordering::SeqCst);

        for _ in 0..MAX_VERIFY_FAILURES {
            assert!(!app_lock_verify("wrong-guess".into()).unwrap());
        }
        // 第 6 次尝试即使口令正确也必须触发 30 秒冷却拒绝。
        let locked_err = app_lock_verify("correct-horse".into()).unwrap_err();
        assert!(
            locked_err.contains("too many failed attempts"),
            "{locked_err}"
        );
        assert_eq!(app_lock_state(), LockState::Locked);

        __reset_rate_limit_for_test();
        assert!(app_lock_verify("correct-horse".into()).unwrap());
        assert_eq!(app_lock_state(), LockState::Unlocked);
    }
}
