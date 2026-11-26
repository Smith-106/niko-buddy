// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

//! Official Antigravity CLI (`agy`) read-only binary detection.
//!
//! Compliance boundary (Google Antigravity Additional Terms of Service & FAQ):
//! - Wrapping `agy -p` (headless) or consumer Antigravity OAuth as a hidden LLM
//!   backend inside a third-party application violates Google's consumer terms
//!   and risks account suspension. Accordingly, the legacy `antigravity_cli_spawn`
//!   and `antigravity_cli_kill` text-completion wrapper commands have been retired.
//! - Supported, compliant integrations live in:
//!   1. `commands/antigravity_acp.rs` — official interactive ACP v1 panel (`agy acp`),
//!   2. `mcp_server/` — loopback Streamable HTTP MCP server connected from official
//!      Antigravity App / CLI / IDE, and
//!   3. Official Google Gemini API key / Vertex AI for automated writing pipelines.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use super::cli_resolver::{child_path_env, find_cli_command};
use super::local_cli_config::apply_local_cli_environment;

const VERSION_TIMEOUT_SECS: u64 = 5;
const ACP_HELP_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Serialize)]
pub struct DetectResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Retained as `None` for wire compatibility with existing settings status pills.
    pub fallback_path: Option<String>,
    pub model: Option<String>,
    pub error: Option<String>,
    /// True when the official `agy` binary is detected and ready for `agy acp`.
    pub acp_supported: bool,
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Resolve the official `agy` binary inside a user home directory
/// (`~/.gemini/antigravity/bin/agy[.exe]`), matching Google Antigravity's
/// default installer layout when GUI apps don't inherit shell PATH.
pub(crate) fn find_agy_in_home(home: &Path) -> Option<PathBuf> {
    let bin_dir = home.join(".gemini").join("antigravity").join("bin");
    #[cfg(windows)]
    let candidates = ["agy.exe", "agy.cmd", "agy"];
    #[cfg(not(windows))]
    let candidates = ["agy"];

    for name in candidates {
        let candidate = bin_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Locate the official Google Antigravity CLI binary (`agy`).
/// Never falls back to legacy `antigravity` wrappers or `gemini` CLI.
pub(crate) async fn find_agy_command() -> Result<PathBuf, String> {
    if let Ok(path) = find_cli_command("agy", &["agy.exe", "agy.cmd"]).await {
        return Ok(path);
    }
    if let Some(home) = user_home_dir() {
        if let Some(path) = find_agy_in_home(&home) {
            return Ok(path);
        }
    }
    Err(
        "Official Antigravity CLI (`agy`) not found on PATH or in ~/.gemini/antigravity/bin"
            .to_string(),
    )
}

async fn probe_agy_version(path: &Path) -> Result<Option<String>, String> {
    let mut cmd = Command::new(path);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output =
        tokio::time::timeout(Duration::from_secs(VERSION_TIMEOUT_SECS), cmd.output()).await;
    match output {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let first_line = if !stdout.is_empty() {
                stdout.lines().next().unwrap_or("agy").trim().to_string()
            } else if !stderr.is_empty() {
                stderr.lines().next().unwrap_or("agy").trim().to_string()
            } else {
                "agy".to_string()
            };
            Ok(Some(first_line))
        }
        Ok(Ok(out)) => Err(format!("`agy --version` exited with {}", out.status)),
        Ok(Err(e)) => Err(format!("Failed to spawn `agy`: {e}")),
        Err(_) => Err(format!(
            "`agy --version` timed out after {VERSION_TIMEOUT_SECS}s"
        )),
    }
}

fn contains_ascii_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let wlen = word.len();
    let mut start = 0;
    while let Some(rel) = haystack[start..].find(word) {
        let pos = start + rel;
        let before_ok = pos == 0 || !bytes[pos - 1].is_ascii_alphanumeric();
        let after_pos = pos + wlen;
        let after_ok = after_pos >= bytes.len() || !bytes[after_pos].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = pos + 1;
    }
    false
}

/// Evaluate the read-only `agy acp --help` probe output to determine whether the
/// installed `agy` binary actually exposes the official `acp` subcommand.
pub(crate) fn parse_acp_help_supported(success: bool, stdout: &str, stderr: &str) -> bool {
    if !success {
        return false;
    }
    let combined = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if combined.trim().is_empty() {
        return false;
    }
    for unsupported_marker in [
        "unknown command",
        "unknown subcommand",
        "unrecognized command",
        "unrecognized subcommand",
        "invalid command",
        "invalid subcommand",
        "not a valid command",
    ] {
        if combined.contains(unsupported_marker) {
            return false;
        }
    }
    contains_ascii_word(&combined, "acp")
        || combined.contains("agent client protocol")
        || combined.contains("process-per-session")
}

async fn probe_agy_acp_supported(path: &Path) -> bool {
    let mut cmd = Command::new(path);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.kill_on_drop(true);
    let output = tokio::time::timeout(
        Duration::from_secs(ACP_HELP_TIMEOUT_SECS),
        cmd.args(["acp", "--help"]).output(),
    )
    .await;
    match output {
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            parse_acp_help_supported(out.status.success(), &stdout, &stderr)
        }
        Ok(Err(_)) | Err(_) => false,
    }
}

pub async fn do_antigravity_cli_detect() -> Result<DetectResult, String> {
    let path = match find_agy_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                fallback_path: None,
                model: None,
                error: Some(error),
                acp_supported: false,
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();
    match probe_agy_version(&path).await {
        Ok(version) => {
            let acp_supported = probe_agy_acp_supported(&path).await;
            Ok(DetectResult {
                installed: true,
                version,
                path: Some(path_str),
                fallback_path: None,
                model: None,
                error: None,
                acp_supported,
            })
        }
        Err(err) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            fallback_path: None,
            model: None,
            error: Some(err),
            acp_supported: false,
        }),
    }
}

#[tauri::command]
pub async fn antigravity_cli_detect() -> Result<DetectResult, String> {
    do_antigravity_cli_detect().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_agy_in_home_resolves_default_installer_location() {
        let dir =
            std::env::temp_dir().join(format!("niko-agy-detect-test-{}", uuid::Uuid::new_v4()));
        let bin_dir = dir.join(".gemini").join("antigravity").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        #[cfg(windows)]
        let expected = bin_dir.join("agy.exe");
        #[cfg(not(windows))]
        let expected = bin_dir.join("agy");
        std::fs::write(&expected, b"stub").unwrap();

        let found = find_agy_in_home(&dir);
        assert_eq!(found.as_deref(), Some(expected.as_path()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_agy_in_home_returns_none_when_missing() {
        let dir =
            std::env::temp_dir().join(format!("niko-agy-missing-test-{}", uuid::Uuid::new_v4()));
        assert!(find_agy_in_home(&dir).is_none());
    }

    #[test]
    fn parse_acp_help_supported_distinguishes_supported_and_unsupported_outputs() {
        assert!(parse_acp_help_supported(
            true,
            "Usage: agy acp [options]\n  --process-per-session  Run per session",
            ""
        ));
        assert!(parse_acp_help_supported(
            true,
            "",
            "Starts the Agent Client Protocol server over stdio"
        ));
        assert!(parse_acp_help_supported(
            true,
            "Options:\n  --process-per-session",
            ""
        ));

        assert!(!parse_acp_help_supported(false, "Usage: agy acp", ""));
        assert!(!parse_acp_help_supported(true, "", ""));
        assert!(!parse_acp_help_supported(true, "   \n\t ", ""));
        assert!(!parse_acp_help_supported(
            true,
            "Error: unknown command 'acp'",
            ""
        ));
        assert!(!parse_acp_help_supported(
            true,
            "",
            "unrecognized subcommand: acp"
        ));
        assert!(!parse_acp_help_supported(
            true,
            "Usage: agy [command]\nCommands:\n  login\n  status\n  pacp-helper",
            ""
        ));
    }
}
