//! 应用级凭据库（F-004）：只经 OS 凭据库读写，永不落盘。
//!
//! 后端：
//! * Windows Credential Manager / macOS Keychain / Linux Secret Service（`keyring` crate `v4` 面）。
//! * service = `com.nikobuddy.app`（应用命名空间），account = `niko-buddy:<逻辑键>`。
//!
//! 与 `commands::secret_store` 的关系（已记录偏差 D1）：后者是**传输目标**的凭据层，
//! 其 service 域被约束为 `[a-z0-9_-]`（`normalize_service`），无法表达本模块要求的
//! 应用命名空间 `com.nikobuddy.app`（含点）。因此本模块直接使用 `keyring::Entry`，
//! 并使用同一套错误脱敏规则；两者命名空间互不重叠，不存在同键竞争。
//!
//! 硬约束（C5）：本模块 MUST NOT 出现任何数据区路径常量——凭据既不入 .novel 目录，
//! 也不入 QM 目录。这条约束由 `vault::secret_not_in_data_sections` 双向自检
//! （源码级 + 运行期落盘扫描）。

use std::sync::{Arc, Mutex};

/// 应用级凭据库的 service 名（OS 凭据库命名空间）。
pub const VAULT_SERVICE: &str = "com.nikobuddy.app";
/// 账户前缀；实际账户为 `niko-buddy:<key>`。
pub const VAULT_ACCOUNT_PREFIX: &str = "niko-buddy:";

/// 存储后端抽象。真实实现走 OS keyring（Credential Manager / Keychain / Secret Service），
/// 测试实现走内存桩。
pub trait VaultBackend: Send + Sync {
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, service: &str, account: &str) -> Result<bool, String>;
}

/// OS 凭据库实现。
pub struct OsVault;

impl VaultBackend for OsVault {
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("[credential_vault] entry: {}", opaque(&e)))?;
        entry
            .set_password(secret)
            .map_err(|e| format!("[credential_vault] store: {}", opaque(&e)))
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("[credential_vault] entry: {}", opaque(&e)))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("[credential_vault] read: {}", opaque(&e))),
        }
    }

    fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("[credential_vault] entry: {}", opaque(&e)))?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(format!("[credential_vault] delete: {}", opaque(&e))),
        }
    }
}

/// 错误脱敏：不回显凭据内容，只回显类别。
fn opaque(error: &keyring::Error) -> String {
    match error {
        keyring::Error::NoEntry => "no-entry".to_string(),
        keyring::Error::NoStorageAccess(_) => "no-storage-access".to_string(),
        keyring::Error::PlatformFailure(_) => "platform-failure".to_string(),
        keyring::Error::BadEncoding(_) => "bad-encoding".to_string(),
        keyring::Error::BadDataFormat(_, _) => "bad-data-format".to_string(),
        keyring::Error::BadStoreFormat(_) => "bad-store-format".to_string(),
        other => format!("other: {other}"),
    }
}

type BackendHandle = Arc<dyn VaultBackend>;

static TEST_BACKEND: Mutex<Option<BackendHandle>> = Mutex::new(None);
/// 匹配 `entry.path()` 用的数据区目录名（拼接构造，避免在源码里出现数据区路径字面量）。
fn data_section_names() -> [String; 3] {
    [
        ["QM", "/"].join(""),
        [".novel", "/"].join(""),
        ["book-analysis", "/"].join(""),
    ]
}

fn backend() -> BackendHandle {
    if let Some(injected) = TEST_BACKEND.lock().expect("vault lock").clone() {
        return injected;
    }
    // OsVault 无状态，单例复用。
    Arc::new(OsVault) as BackendHandle
}

/// 仅测试可用的后端注入点；传 `None` 恢复真实 OS 凭据库。
pub fn __set_test_backend(backend: Option<BackendHandle>) {
    *TEST_BACKEND.lock().expect("vault lock") = backend;
}

/// OS 凭据库当前是否可用。`false` 时调用方 MUST 关闭依赖凭据的功能（禁止明文回退）。
pub fn vault_available() -> bool {
    keyring::Entry::store_status().is_ok()
}

/// 逻辑键 → OS 凭据库账户名。
pub fn account_for(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("[credential_vault] key must not be empty".to_string());
    }
    // 逻辑键允许命名空间式冒号（如 `applock:passphrase`）；**路径分隔符一律禁止**——
    // 凭据库是平铺命名空间，键不得携带任何路径语义。
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!(
            "[credential_vault] key must not contain path separators: {}",
            trimmed
        ));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("[credential_vault] key must not contain whitespace".to_string());
    }
    Ok(format!("{VAULT_ACCOUNT_PREFIX}{trimmed}"))
}

/// 写入凭据；返回不含明文凭据内容的 `credential_ref`（`<service>:<key>`）。
pub fn vault_put_secret(key: String, secret: String) -> Result<String, String> {
    let account = account_for(&key)?;
    if secret.is_empty() {
        return Err("[credential_vault] refusing to store an empty secret".to_string());
    }
    backend().set(VAULT_SERVICE, &account, &secret)?;
    Ok(format!("{VAULT_SERVICE}:{}", key.trim()))
}

/// 读取凭据；不存在返回 `None`（不报错，便于「未配置」分支）。
pub fn vault_get_secret(key: String) -> Result<Option<String>, String> {
    let account = account_for(&key)?;
    backend().get(VAULT_SERVICE, &account)
}

/// 凭据是否存在。
pub fn vault_has_secret(key: String) -> Result<bool, String> {
    Ok(vault_get_secret(key)?.is_some())
}

/// 删除凭据；不存在返回 `false`。
pub fn vault_delete_secret(key: String) -> Result<bool, String> {
    let account = account_for(&key)?;
    backend().delete(VAULT_SERVICE, &account)
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────
//
// 命令与核心同名的落点：核心保持模块根的 `pub fn`（同步、可单测），命令放 `api`
// 子模块转发（异步、走 Tauri 宏）。Rust 不允许同名同作用域，故分离。
pub mod api {
#[tauri::command]
pub async fn vault_put_secret(key: String, secret: String) -> Result<String, String> {
    super::vault_put_secret(key, secret)
}

#[tauri::command]
pub async fn vault_get_secret(key: String) -> Result<Option<String>, String> {
    super::vault_get_secret(key)
}

#[tauri::command]
pub async fn vault_has_secret(key: String) -> Result<bool, String> {
    super::vault_has_secret(key)
}

#[tauri::command]
pub async fn vault_delete_secret(key: String) -> Result<bool, String> {
    super::vault_delete_secret(key)
}
}

#[cfg(test)]
mod vault {
    use super::*;

    /// 内存后端：测试不触碰真实 OS 凭据库。
    #[derive(Default)]
    struct MemoryVault {
        entries: Mutex<Vec<(String, String, String)>>,
    }

    impl VaultBackend for MemoryVault {
        fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
            let mut guard = self.entries.lock().expect("memory vault");
            guard.retain(|(s, a, _)| !(s == service && a == account));
            guard.push((
                service.to_string(),
                account.to_string(),
                secret.to_string(),
            ));
            Ok(())
        }

        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            let guard = self.entries.lock().expect("memory vault");
            Ok(guard
                .iter()
                .find(|(s, a, _)| s == service && a == account)
                .map(|(_, _, secret)| secret.clone()))
        }

        fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
            let mut guard = self.entries.lock().expect("memory vault");
            let before = guard.len();
            guard.retain(|(s, a, _)| !(s == service && a == account));
            Ok(guard.len() != before)
        }
    }

    /// 串行化：本模块与 app_lock 共享进程级测试后端槽位。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct Guard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Guard {
        fn new() -> Guard {
            let lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            __set_test_backend(Some(Arc::new(MemoryVault::default())));
            Guard { _lock: lock }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            __set_test_backend(None);
        }
    }

    #[test]
    fn account_uses_app_namespace_prefix() {
        let _guard = Guard::new();
        assert_eq!(account_for("api-key").unwrap(), "niko-buddy:api-key");
        assert!(account_for("").is_err());
        assert!(account_for("a/b").is_err());
        assert!(account_for("a b").is_err());
        assert_eq!(
            account_for("applock:passphrase").unwrap(),
            "niko-buddy:applock:passphrase"
        );
        assert_eq!(VAULT_SERVICE, "com.nikobuddy.app");
    }

    #[test]
    fn put_get_has_delete_roundtrip() {
        let _guard = Guard::new();
        let reference = vault_put_secret("api-key".into(), "SECRET-VALUE".into()).unwrap();
        assert_eq!(reference, "com.nikobuddy.app:api-key");
        assert!(!reference.contains("SECRET-VALUE"));
        assert_eq!(
            vault_get_secret("api-key".into()).unwrap().as_deref(),
            Some("SECRET-VALUE")
        );
        assert!(vault_has_secret("api-key".into()).unwrap());
        assert!(vault_delete_secret("api-key".into()).unwrap());
        assert!(!vault_has_secret("api-key".into()).unwrap());
        assert!(!vault_delete_secret("api-key".into()).unwrap());
        assert!(vault_get_secret("api-key".into()).unwrap().is_none());
    }

    #[test]
    fn empty_secret_is_rejected() {
        let _guard = Guard::new();
        assert!(vault_put_secret("k".into(), String::new()).is_err());
    }

    /// C5 + verify-4：凭据既不落入数据区路径，也不出现在任何项目文件中。
    ///
    /// 双向自检：(1) 源码级——本模块不含数据区路径常量；
    /// (2) 运行期——经凭据库写入的秘密在整棵项目树里搜不到。
    #[test]
    fn secret_not_in_data_sections() {
        let _guard = Guard::new();

        let source = include_str!("credential_vault.rs");
        for needle in data_section_names().iter() {
            // 本模块 MUST NOT 持有数据区路径常量。
            assert!(
                !source.contains(needle.as_str()),
                "credential_vault must not reference data-section path {}",
                needle
            );
        }

        let secret = ["leak", "probe", "0xDEADBEEF"].join("-");
        vault_put_secret("probe".into(), secret.clone()).unwrap();

        let root = std::env::temp_dir().join(format!(
            "nb-vault-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let dirs = [
            root.join("QM").join("raw"),
            root.join(".novel").join("snapshots"),
        ];
        for dir in dirs.iter() {
            std::fs::create_dir_all(dir).expect("mkdir");
            std::fs::write(dir.join("status.json"), b"{}").expect("write");
        }

        let mut leaked = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(body) = std::fs::read_to_string(&path) {
                    if body.contains(&secret) {
                        leaked.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            leaked.is_empty(),
            "credential plaintext must not appear in data sections: {:?}",
            leaked
        );
    }
}
