// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Cryptographic utility commands exposed via Tauri IPC.
//!
//! The primary purpose of this module is to provide a stable, device-bound
//! fingerprint that the frontend can use to derive AES-256 keys for
//! encrypting sensitive data (e.g. stored API keys).

use sha2::{Digest, Sha256};

// ── Internal helpers ───────────────────────────────────────────────────────

/// Build a deterministic, device-bound fingerprint string.
///
/// The fingerprint is derived from:
/// * Host name (`COMPUTERNAME` on Windows, `HOSTNAME` on Unix)
/// * Current user name (`USERNAME` on Windows, `USER` on Unix)
/// * Operating system identifier (`std::env::consts::OS`)
///
/// The raw material is hashed with SHA-256 to produce a 32-byte (64-hex-char)
/// value suitable for use as AES-256 key material.
fn get_device_fingerprint() -> String {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown-host".to_string());

    let username = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown-user".to_string());

    let os_id = std::env::consts::OS;

    // Domain-separated format: namespace::host::user::os::version-tag
    let raw = format!("qmai::{hostname}::{username}::{os_id}::device-key-v1");

    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();

    digest.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Return the 64-character hex-encoded device fingerprint.
///
/// The frontend calls this once at startup to derive an AES-256 key that
/// encrypts locally-stored API keys, binding them to the current machine.
#[tauri::command]
pub async fn get_device_fingerprint_cmd() -> Result<String, String> {
    Ok(get_device_fingerprint())
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_consistent() {
        let fp1 = get_device_fingerprint();
        let fp2 = get_device_fingerprint();
        assert_eq!(fp1, fp2, "Device fingerprint must be stable across calls");
        assert_eq!(fp1.len(), 64, "Fingerprint must be 64 hex chars (32 bytes)");
    }

    #[test]
    fn fingerprint_is_hex() {
        let fp = get_device_fingerprint();
        assert!(
            fp.chars().all(|c| c.is_ascii_hexdigit()),
            "Fingerprint must contain only ASCII hex digits"
        );
    }
}
