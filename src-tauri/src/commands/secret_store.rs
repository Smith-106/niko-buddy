// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! 凭据落点：独立 secret store（**C-011**）。
//!
//! ## 为什么必须独立
//! Niko Buddy 此前**没有密钥位**：`.qmai/` 是明文载体，`status.json` 是运行时唯一真源
//! （外部来源不可写）。F-004（云端备份 / WebDAV 传输）没有凭据落点就无法落地——把口令
//! 写进项目文件会同时违反 C-001（真源边界）、C-002（Draft-first）与用户资产域纪律。
//! 因此凭据**不落任何文件库**，改以 OS 原生安全存储为后端：Windows Credential Manager
//! / macOS Keychain / Linux Secret Service（`keyring` crate `v1` 面）。
//!
//! ## 硬约束（任一违反即视为实现缺陷）
//! 1. **secret 值 MUST NOT** 出现在 `secret_put` / `secret_delete` / `secret_available`
//!    的返回值、任何日志、`.qmai/` 文件或 `status.json` 中。唯一的值读取路径是
//!    [`secret_get`]（传输层即时消费，**不得缓存到项目文件**）。
//! 2. 调用方只持有 **`credential_ref`**（形如 `nb:webdav:<project_id>`），
//!    而非明文口令。
//! 3. [`secret_available`] 为 `false` 时，调用方 **MUST** 降级为「不启用该传输目标」，
//!    **禁止**明文回退。
//! 4. 命名绑定设备：service = `nb:<domain>`（项目无关），account = `<设备指纹前 16 位>:<逻辑账户>`
//!    （设备标识派生自 `crypto::get_device_fingerprint`，与既有 AES 密钥绑定同源）。
//!
//! ## 本模块的日志纪律
//! 本文件**不含任何输出语句**（标准输出宏与日志宏均为零命中）——凭据模块的输出面
//! 越窄越安全；错误只经 `Result::Err` 返回，并经 [`opaque`] 压缩为不透明描述。

use crate::commands::crypto::get_device_fingerprint;

/// service 命名前缀（项目无关命名空间，避免与他应用条目碰撞）。
pub const SECRET_SERVICE_PREFIX: &str = "nb:";

/// 设备绑定前缀长度（设备指纹是 64 位十六进制；取前 16 位作账户绑定）。
pub const DEVICE_BINDING_HEX_LEN: usize = 16;

/// 存储后端抽象。真实实现走 OS keyring；测试实现走内存 / 不可用桩。
trait SecretBackend {
    /// 后端是否可用（不可用时不作任何回退，直接上报降级）。
    fn available(&self) -> bool;
    /// 写入 secret（覆盖同名条目）。
    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String>;
    /// 读取 secret；`Ok(None)` 表示条目不存在（区别于后端故障）。
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    /// 删除 secret；`Ok(false)` 表示原本不存在。
    fn delete(&self, service: &str, account: &str) -> Result<bool, String>;
}

/// OS 原生安全存储后端（Windows Credential Manager / macOS Keychain / Linux Secret Service）。
struct OsKeyringBackend;

impl SecretBackend for OsKeyringBackend {
    fn available(&self) -> bool {
        // store_status() 会在首次调用时初始化默认凭据库；Ok 即表示可用。
        keyring::Entry::store_status().is_ok()
    }

    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("[secret_store] open entry failed: {}", opaque(&e)))?;
        entry
            .set_password(secret)
            .map_err(|e| format!("[secret_store] write failed: {}", opaque(&e)))
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("[secret_store] open entry failed: {}", opaque(&e)))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("[secret_store] read failed: {}", opaque(&e))),
        }
    }

    fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("[secret_store] open entry failed: {}", opaque(&e)))?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(format!("[secret_store] delete failed: {}", opaque(&e))),
        }
    }
}

/// 把后端错误压缩为**不透明**描述：只保留错误类别，绝不透传平台细节
/// （平台错误文本可能包含条目名乃至被存值，属必须截断的输出面）。
fn opaque(error: &keyring::Error) -> String {
    match error {
        keyring::Error::NoEntry => "no-entry".to_string(),
        keyring::Error::NoStorageAccess(_) => "no-storage-access".to_string(),
        keyring::Error::PlatformFailure(_) => "platform-failure".to_string(),
        keyring::Error::BadEncoding(_) => "bad-encoding".to_string(),
        keyring::Error::BadDataFormat(_, _) => "bad-data-format".to_string(),
        keyring::Error::BadStoreFormat(_) => "bad-store-format".to_string(),
        _ => "unknown".to_string(),
    }
}

fn default_backend() -> OsKeyringBackend {
    OsKeyringBackend
}

// ── 命名与引用派生（纯函数，无 I/O）──────────────────────────────────────────

/// 设备绑定前缀：`crypto::get_device_fingerprint()` 的前 16 位。
pub fn device_binding_prefix() -> String {
    get_device_fingerprint()
        .chars()
        .take(DEVICE_BINDING_HEX_LEN)
        .collect()
}

/// 把逻辑域名规范为 service 名（`nb:<domain>`）。
///
/// 只接受 `[a-z0-9_-]`（大小写归一为小写），其余一律拒绝——service 名是**命名空间**，
/// 不允许出现分隔符或路径片段，避免条目名被构造成跨域覆盖。
pub fn normalize_service(domain: &str) -> Result<String, String> {
    let domain = domain.trim();
    if domain.is_empty() {
        return Err("[secret_store] service domain must not be empty".to_string());
    }
    let lowered = domain.to_ascii_lowercase();
    if !lowered
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(format!(
            "[secret_store] service domain must match [a-z0-9_-]: {lowered}"
        ));
    }
    Ok(format!("{SECRET_SERVICE_PREFIX}{lowered}"))
}

/// 把逻辑账户绑定到本机：`<设备指纹前 16 位>:<账户>`。
pub fn bind_account(account: &str) -> Result<String, String> {
    let account = account.trim();
    if account.is_empty() {
        return Err("[secret_store] account must not be empty".to_string());
    }
    Ok(format!("{}:{}", device_binding_prefix(), account))
}

/// 构造 `credential_ref`（调用方唯一持有的凭据句柄形态）：`nb:<domain>:<account>`。
pub fn build_credential_ref(domain: &str, account: &str) -> Result<String, String> {
    let service = normalize_service(domain)?;
    let account = account.trim();
    if account.is_empty() {
        return Err("[secret_store] account must not be empty".to_string());
    }
    Ok(format!("{service}:{account}"))
}

/// 解析 `credential_ref` → `(domain, account)`。
///
/// 消费方（同步引擎 / 技能包导入）只持有 ref，故本函数是它们的唯一入口。
pub fn resolve_credential_ref(credential_ref: &str) -> Result<(String, String), String> {
    let raw = credential_ref.trim();
    let rest = raw.strip_prefix(SECRET_SERVICE_PREFIX).ok_or_else(|| {
        format!("[secret_store] credential_ref must start with {SECRET_SERVICE_PREFIX}")
    })?;
    let (domain, account) = rest.split_once(':').ok_or_else(|| {
        "[secret_store] credential_ref must have the form nb:<domain>:<account>".to_string()
    })?;
    if account.is_empty() {
        return Err("[secret_store] credential_ref account segment is empty".to_string());
    }
    // 复用归一校验，保证解析结果可被写回路径直接消费。
    normalize_service(domain)?;
    Ok((domain.to_ascii_lowercase(), account.to_string()))
}

/// 解析后的写入目标：逻辑账户、设备绑定账户与最终 service 名三者分离。
///
/// **关键不变量**：`credential_ref` 用**逻辑账户**（跨设备可移植的句柄），
/// 而存储条目名用**设备绑定账户**（本机专有）。两者混用会让 ref 变得不可移植。
struct SecretTarget {
    /// 最终 service 名（`nb:<domain>`）。
    service: String,
    /// 调用方看到的逻辑账户（如 project_id）。
    logical_account: String,
    /// OS 凭据库里的实际账户名（已绑定本机设备指纹）。
    bound_account: String,
}

/// 把 `(service, account)` 入参解析为 [`SecretTarget`]。
///
/// 允许 `account` 直接传 `credential_ref`（`nb:<domain>:<account>`）——同步引擎持有的
/// 正是该形态，避免调用方自行拆解。
fn resolve_target(service: &str, account: &str) -> Result<SecretTarget, String> {
    let account = account.trim();
    let (service, logical_account) = if account.starts_with(SECRET_SERVICE_PREFIX) {
        let (domain, logical) = resolve_credential_ref(account)?;
        (normalize_service(&domain)?, logical)
    } else {
        (normalize_service(service)?, account.to_string())
    };
    let bound_account = bind_account(&logical_account)?;
    Ok(SecretTarget {
        service,
        logical_account,
        bound_account,
    })
}

/// 后端不可用时的统一降级错误（调用方据此**关闭传输目标**，而非明文回退）。
fn unavailable_error() -> String {
    "[secret_store] OS keyring unavailable; disable this transport target instead of falling back to plaintext".to_string()
}

// ── 同步核心（可注入后端，便于测试）────────────────────────────────────────

fn put_with(
    backend: &dyn SecretBackend,
    service: &str,
    account: &str,
    secret: &str,
) -> Result<String, String> {
    if !backend.available() {
        return Err(unavailable_error());
    }
    let target = resolve_target(service, account)?;
    backend.set(&target.service, &target.bound_account, secret)?;
    // 返回值只含引用（逻辑账户形态），secret 值与设备绑定账户均不外流。
    build_credential_ref(
        target.service.trim_start_matches(SECRET_SERVICE_PREFIX),
        &target.logical_account,
    )
}

fn get_with(backend: &dyn SecretBackend, service: &str, account: &str) -> Result<String, String> {
    if !backend.available() {
        return Err(unavailable_error());
    }
    let target = resolve_target(service, account)?;
    backend.get(&target.service, &target.bound_account)?.ok_or_else(|| {
        format!(
            "[secret_store] no credential stored for {} (account bound to this device)",
            target.service
        )
    })
}

fn delete_with(
    backend: &dyn SecretBackend,
    service: &str,
    account: &str,
) -> Result<bool, String> {
    if !backend.available() {
        return Err(unavailable_error());
    }
    let target = resolve_target(service, account)?;
    backend.delete(&target.service, &target.bound_account)
}

fn available_with(backend: &dyn SecretBackend) -> bool {
    backend.available()
}

/// 内部消费入口（同步引擎用）：与 [`secret_get`] 同语义，供 crate 内直接调用。
///
/// `service` 可传空串，此时要求 `account` 本身是完整 `credential_ref`
/// （`nb:<domain>:<account>`）——同步配置里存的正是该形态。
pub(crate) fn read_secret_sync(service: &str, account: &str) -> Result<String, String> {
    get_with(&default_backend(), service, account)
}

/// 内部可用性探测（同步引擎用）：`false` 时调用方 MUST 关闭传输目标。
pub(crate) fn is_available_sync() -> bool {
    available_with(&default_backend())
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// 写入凭据。**返回 `credential_ref`，绝不返回 secret 值。**
///
/// `service` 为逻辑域名（如 `webdav`），`account` 为逻辑账户（如 project_id）；
/// `account` 亦可直接传既有 `credential_ref`（`nb:<domain>:<account>`）。
#[tauri::command]
pub async fn secret_put(service: String, account: String, secret: String) -> Result<String, String> {
    put_with(&default_backend(), &service, &account, &secret)
}

/// 读取凭据。**唯一的 secret 值出口**（传输层即时消费，禁止落盘缓存）。
#[tauri::command]
pub async fn secret_get(service: String, account: String) -> Result<String, String> {
    get_with(&default_backend(), &service, &account)
}

/// 删除凭据；返回是否确实删除了既有条目（`false` = 原本不存在）。
#[tauri::command]
pub async fn secret_delete(service: String, account: String) -> Result<bool, String> {
    delete_with(&default_backend(), &service, &account)
}

/// OS keyring 是否可用。`false` 时调用方 MUST 关闭该传输目标（禁止明文回退）。
#[tauri::command]
pub async fn secret_available() -> bool {
    available_with(&default_backend())
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
/// 内存后端：测试专用，不触碰真实 OS 凭据库。
struct MemoryBackend {
    entries: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
}

#[cfg(test)]
impl MemoryBackend {
    fn new() -> Self {
        MemoryBackend {
            entries: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

#[cfg(test)]
impl SecretBackend for MemoryBackend {
    fn available(&self) -> bool {
        true
    }

    fn set(&self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        let mut guard = self.entries.lock().unwrap();
        guard.insert((service.to_string(), account.to_string()), secret.to_string());
        Ok(())
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let guard = self.entries.lock().unwrap();
        Ok(guard.get(&(service.to_string(), account.to_string())).cloned())
    }

    fn delete(&self, service: &str, account: &str) -> Result<bool, String> {
        let mut guard = self.entries.lock().unwrap();
        Ok(guard.remove(&(service.to_string(), account.to_string())).is_some())
    }
}

#[cfg(test)]
/// 不可用后端桩：模拟「OS 无凭据库」环境。
struct UnavailableBackend;

#[cfg(test)]
impl SecretBackend for UnavailableBackend {
    fn available(&self) -> bool {
        false
    }
    fn set(&self, _service: &str, _account: &str, _secret: &str) -> Result<(), String> {
        Err("backend must not be reached when unavailable".to_string())
    }
    fn get(&self, _service: &str, _account: &str) -> Result<Option<String>, String> {
        Err("backend must not be reached when unavailable".to_string())
    }
    fn delete(&self, _service: &str, _account: &str) -> Result<bool, String> {
        Err("backend must not be reached when unavailable".to_string())
    }
}

#[cfg(test)]
#[test]
fn roundtrip() {
    let backend = MemoryBackend::new();
    let secret = "s3cr3t-not-echoed";

    // 写入：返回值只含引用，不含 secret 值。
    let reference = put_with(&backend, "webdav", "proj-42", secret).expect("put");
    assert_eq!(reference, "nb:webdav:proj-42");
    assert!(!reference.contains(secret), "return value must not echo the secret");

    // 读回：值与写入一致，且账户已绑定本机设备。
    let read_back = get_with(&backend, "webdav", "proj-42").expect("get");
    assert_eq!(read_back, secret);
    let target = resolve_target("webdav", "proj-42").expect("resolve");
    assert_eq!(target.service, "nb:webdav");
    assert_eq!(target.logical_account, "proj-42");
    assert!(
        target.bound_account.starts_with(&device_binding_prefix()),
        "account must be device-bound: {}",
        target.bound_account
    );
    assert!(
        !reference.contains(&device_binding_prefix()),
        "credential_ref must stay portable (logical account only)"
    );

    // 直接以 credential_ref 消费（同步引擎持有的形态）。
    assert_eq!(get_with(&backend, "ignored", &reference).expect("get by ref"), secret);

    // 删除语义：存在 → true；再次删除 → false。
    assert!(delete_with(&backend, "webdav", "proj-42").expect("delete"));
    assert!(!delete_with(&backend, "webdav", "proj-42").expect("delete again"));
    assert!(get_with(&backend, "webdav", "proj-42").is_err(), "deleted secret must be gone");

    // 引用解析与命名规范。
    assert_eq!(
        resolve_credential_ref("nb:webdav:proj-42").expect("resolve ref"),
        ("webdav".to_string(), "proj-42".to_string())
    );
    assert!(resolve_credential_ref("webdav:proj-42").is_err(), "missing nb: prefix is rejected");
    assert!(resolve_credential_ref("nb:webdav").is_err(), "missing account segment is rejected");
    assert!(normalize_service("WebDAV").is_ok(), "domain is case-normalized");
    assert!(normalize_service("bad/domain").is_err(), "separators are rejected");
    assert!(normalize_service("").is_err(), "empty domain is rejected");
    assert!(build_credential_ref("webdav", "  ").is_err(), "blank account is rejected");
}

#[cfg(test)]
#[test]
fn unavailable_is_reported() {
    let backend = UnavailableBackend;

    // 可用性上报为 false。
    assert!(!available_with(&backend));

    // 三个写/读/删入口一律返回降级错误，且**不得**回退到明文路径。
    let put = put_with(&backend, "webdav", "proj-42", "secret").unwrap_err();
    assert!(put.contains("unavailable"), "put must report unavailability: {put}");
    assert!(put.contains("plaintext"), "degradation contract must be explicit: {put}");

    let get = get_with(&backend, "webdav", "proj-42").unwrap_err();
    assert!(get.contains("unavailable"), "get must report unavailability: {get}");

    let delete = delete_with(&backend, "webdav", "proj-42").unwrap_err();
    assert!(delete.contains("unavailable"), "delete must report unavailability: {delete}");

    // 降级错误本身不得携带任何 secret 值。
    let leaked = "s3cr3t-not-echoed";
    let with_value = put_with(&backend, "webdav", "proj-42", leaked).unwrap_err();
    assert!(
        !with_value.contains(leaked),
        "degradation error must stay opaque: {with_value}"
    );
}
