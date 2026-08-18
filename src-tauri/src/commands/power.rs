// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Wake-lock commands exposed via Tauri IPC.
//!
//! On Windows, prevents the system from entering sleep while a long-running
//! generation/review task is active. The frontend calls `acquire_wake_lock`
//! when a long task starts and `release_wake_lock` when it finishes.
//!
//! Implementation uses `SetThreadExecutionState` (thread-local, no kernel
//! handle to leak). On non-Windows targets these are no-ops that return
//! `false` so callers know the guard is inert (Niko Buddy is Windows-only
//! today, but keeping a graceful fallback avoids a hard failure if the app
//! is ever run elsewhere).

#[cfg(target_os = "windows")]
use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
};

/// Acquire a wake lock so the OS will not sleep while a long task runs.
///
/// Returns `true` on Windows when the state was applied, `false` on
/// non-Windows targets (no-op).
#[tauri::command]
pub async fn acquire_wake_lock() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // SAFETY: SetThreadExecutionState is a thread-local kernel32 call
        // with no memory-unsafe inputs; the flags are compile-time constants.
        unsafe {
            let prev = SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED,
            );
            Ok(prev.0 != 0)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

/// Release the wake lock, allowing the OS to sleep again.
///
/// Must be called once for every successful `acquire_wake_lock` to avoid
/// permanently keeping the machine awake.
#[tauri::command]
pub async fn release_wake_lock() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // SAFETY: ES_CONTINUOUS alone clears any previous state flags on the
        // calling thread; this is the documented reset pattern.
        unsafe {
            let prev = SetThreadExecutionState(ES_CONTINUOUS);
            Ok(prev.0 != 0)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_then_release_roundtrip() {
        let got = acquire_wake_lock().await.unwrap();
        // On Windows CI we expect true; on non-Windows we accept false.
        assert!(got || cfg!(not(target_os = "windows")));
        let released = release_wake_lock().await.unwrap();
        assert!(released || cfg!(not(target_os = "windows")));
    }

    #[tokio::test]
    async fn release_is_idempotent() {
        release_wake_lock().await.unwrap();
        release_wake_lock().await.unwrap();
    }
}
