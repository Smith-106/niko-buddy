//! 应用锁（F-004）：启动门禁 + 遮挡层的数据面。
//!
//! 设计要点：
//! * 口令**不以明文入任何存储**。写入的是「设备绑定派生值」
//!   `sha256(device_fingerprint :: applock :: passphrase)`，与既有 `commands::crypto`
//!   使用同一套原语（SHA-256）与同一设备指纹，不新增任何算法/KDF 参数。
//! * 派生值存进 `credential_vault`（OS 凭据库），因此**不在** `.novel` / `QM` 数据区。
//! * 本模块 MUST NOT 加密 `.novel/status.json` 或 `.novel` 可重建区——状态真源与
//!   只读投影必须保持可被外部工具读取。
//! * 未设置口令时状态为 `NotConfigured`（不是 Locked）：门禁只在用户真的设了口令后生效，
//!   否则全新项目会被自己的锁挡在门外。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::credential_vault::{vault_get_secret, vault_put_secret};

/// 应用锁口令派生值在凭据库里的逻辑键。
pub const APP_LOCK_KEY: &str = "applock:passphrase";

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

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 设备绑定派生值。复用既有设备指纹（`commands::crypto::get_device_fingerprint`）。
fn derive_verifier(passphrase: &str) -> String {
    let device = crate::commands::crypto::get_device_fingerprint();
    sha256_hex(&format!("{device}::applock::{passphrase}"))
}

/// 定长比较，避免提前返回泄露前缀信息。
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 已有口令派生值时返回它（`None` = 未配置）。
pub fn stored_verifier() -> Result<Option<String>, String> {
    vault_get_secret(APP_LOCK_KEY.to_string())
}

pub fn app_lock_set_passphrase(passphrase: String) -> Result<LockState, String> {
    if passphrase.trim().len() < MIN_PASSPHRASE_LEN {
        return Err(format!(
            "[app_lock] passphrase must be at least {} characters",
            MIN_PASSPHRASE_LEN
        ));
    }
    let verifier = derive_verifier(&passphrase);
    vault_put_secret(APP_LOCK_KEY.to_string(), verifier)?;
    UNLOCKED.store(true, Ordering::SeqCst);
    Ok(LockState::Unlocked)
}

/// 最短口令长度（与遮挡层输入校验共用同一常量）。
pub const MIN_PASSPHRASE_LEN: usize = 6;

pub fn app_lock_verify(passphrase: String) -> Result<bool, String> {
    let Some(stored) = stored_verifier()? else {
        return Err("[app_lock] no passphrase configured".to_string());
    };
    let candidate = derive_verifier(&passphrase);
    let ok = constant_time_eq(&candidate, &stored);
    if ok {
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

    #[tauri::command]
    pub async fn app_lock_set_passphrase(passphrase: String) -> Result<LockState, String> {
        super::app_lock_set_passphrase(passphrase)
    }

    #[tauri::command]
    pub async fn app_lock_verify(passphrase: String) -> Result<bool, String> {
        super::app_lock_verify(passphrase)
    }

    #[tauri::command]
    pub async fn app_lock_state() -> Result<LockState, String> {
        Ok(super::app_lock_state())
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
            let mut guard = self.entries.lock().expect("memory vault");
            guard.retain(|(a, _)| a != account);
            guard.push((account.to_string(), secret.to_string()));
            Ok(())
        }

        fn get(&self, _service: &str, account: &str) -> Result<Option<String>, String> {
            let guard = self.entries.lock().expect("memory vault");
            Ok(guard
                .iter()
                .find(|(a, _)| a == account)
                .map(|(_, s)| s.clone()))
        }

        fn delete(&self, _service: &str, account: &str) -> Result<bool, String> {
            let mut guard = self.entries.lock().expect("memory vault");
            let before = guard.len();
            guard.retain(|(a, _)| a != account);
            Ok(guard.len() != before)
        }
    }

    /// 进程级共享状态（凭据库槽位 + UNLOCKED 标志）→ 测试必须串行。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct Guard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Guard {
        fn new() -> Guard {
            let lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            __set_test_backend(Some(Arc::new(MemoryVault::default())));
            UNLOCKED.store(false, Ordering::SeqCst);
            Guard { _lock: lock }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            __set_test_backend(None);
            UNLOCKED.store(false, Ordering::SeqCst);
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
            app_lock_set_passphrase("correct-horse".into()).unwrap(),
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
        app_lock_set_passphrase("correct-horse".into()).unwrap();
        let stored = stored_verifier().unwrap().expect("stored");
        assert!(!stored.contains("correct-horse"), "不得存明文口令");
        assert_eq!(stored.len(), 64, "sha256 hex");
        assert_eq!(stored, derive_verifier("correct-horse"));
    }

    #[test]
    fn short_passphrase_is_rejected() {
        let _guard = Guard::new();
        assert!(app_lock_set_passphrase("abc".into()).is_err());
        assert_eq!(app_lock_state(), LockState::NotConfigured);
    }

    #[test]
    fn state_without_passphrase_never_blocks() {
        let _guard = Guard::new();
        // 未配置时 verify 明确报错，而不是静默返回 false。
        assert!(app_lock_verify("anything".into()).is_err());
        assert_eq!(app_lock_state(), LockState::NotConfigured);
    }
}
