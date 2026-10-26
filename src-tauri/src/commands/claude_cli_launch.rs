// Copyright (c) 2024 Niko-hub contributors. MIT License.
// SPDX-License-Identifier: MIT

//! Claude CLI launch-preparation pure layer — M7-2 sliced from `claude_cli.rs`
//! (S4 single-round convergence, file_sync_watch pattern).
//!
//! Holds: prompt-content mapping ([`ClaudeContent`] text/image helpers),
//! input-mode decision ([`select_claude_cli_input_mode`]), CLI arg assembly
//! ([`build_claude_cli_args`]) + isolated-launch prep
//! ([`prepare_claude_cli_launch`], [`TempFileGuard`]), output-capping
//! ([`cap_output_text`]) and launch/startup diagnostics
//! ([`format_launch_debug_context`] / [`format_startup_io_failure_message`]) —
//! all deterministic, zero Tauri, zero process spawn.
//! `claude_cli.rs` re-exports via `pub(crate) use`; external import surface unchanged
//! (externals stay in place: 4 Tauri commands, `do_*`, `ClaudeCliState`).

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tokio::process::Command;

use super::local_cli_config::{
    read_claude_local_config, resolve_home_dir, LocalCliConfigInfo,
};

/// C-101 (GRL-008): Rust-side startup watchdog. Fires if the CLI produces
/// zero output (not even a heartbeat) within this many seconds — i.e. the
/// process is stuck before its first byte. Overridable via the
/// `QMAI_CLAUDE_STARTUP_TIMEOUT_SECS` env var for slow/portable/cold-start
/// environments. The TS transport separately enforces a (longer, also
/// configurable) "first meaningful output" timeout; the two are intentionally
/// layered (Rust = process-liveness, TS = provider-progress).
pub(crate) fn resolve_startup_output_timeout_secs() -> u64 {
    const DEFAULT: u64 = 30;
    const MIN: u64 = 5;
    match std::env::var("QMAI_CLAUDE_STARTUP_TIMEOUT_SECS") {
        Ok(v) => v
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|n| *n >= MIN)
            .unwrap_or(DEFAULT),
        Err(_) => DEFAULT,
    }
}
pub(crate) const CLAUDE_STDERR_LIMIT_BYTES: usize = 1024 * 1024;
/// F-001 (ANL-010 C1): bounded stdout JSON buffer cap. The stdout BufReader
/// drain loop previously had NO cap (only stderr was capped at
/// CLAUDE_STDERR_LIMIT_BYTES), so a pipe-buffer-deadlock — the CLI blocks on
/// writing to a full stdout pipe while Niko Buddy stops draining — could grow
/// stdout unbounded and stall indefinitely (the S2 Chapter-12 root cause).
/// Symmetric with codex_cli.rs STDOUT_LIMIT_BYTES (raised to match). On
/// overflow the drain emits a final `stdout-buffer-overflow` marker line and
/// breaks, surfacing the failure instead of deadlocking. 64MB is generous
/// (a full novel chapter stream-json is well under this) but finite.
pub(crate) const CLAUDE_STDOUT_LIMIT_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const EMPTY_MCP_CONFIG_JSON: &[u8] = br#"{"mcpServers":{}}"#;
pub(crate) const CLAUDE_CLI_TEXT_STDIN_MAX_BYTES: usize = 8 * 1024;

pub(crate) fn append_capped_line(collected: &mut String, line: &str, limit_bytes: usize) {
    if collected.len() >= limit_bytes {
        return;
    }
    for ch in line.chars() {
        if collected.len() + ch.len_utf8() > limit_bytes {
            break;
        }
        collected.push(ch);
    }
    if collected.len() < limit_bytes {
        collected.push('\n');
    }
}

pub(crate) fn cap_output_text(bytes: &[u8], limit_bytes: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut collected = String::new();
    for line in text.lines() {
        append_capped_line(&mut collected, line, limit_bytes);
        if collected.len() >= limit_bytes {
            break;
        }
    }
    if collected.trim().is_empty() {
        for ch in text.chars() {
            if collected.len() + ch.len_utf8() > limit_bytes {
                break;
            }
            collected.push(ch);
        }
    }
    collected.trim().to_string()
}

pub(crate) fn input_mode_label(input_mode: &ClaudeCliInputMode) -> &'static str {
    match input_mode {
        ClaudeCliInputMode::StreamJson => "stream-json",
        ClaudeCliInputMode::TextStdin(_) => "text",
    }
}

pub(crate) fn resolve_claude_cli_working_dir() -> Option<PathBuf> {
    resolve_home_dir().or_else(|| std::env::current_dir().ok())
}

pub(crate) fn format_launch_debug_context(
    claude: &Path,
    launch_args: &[String],
    input_mode: &ClaudeCliInputMode,
    isolate_local_config: bool,
    working_dir: Option<&Path>,
    local_config: &LocalCliConfigInfo,
) -> String {
    let cwd = working_dir
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "<inherit>".to_string());
    let configured_model = local_config.model.as_deref().unwrap_or("<none>");
    let args = if launch_args.is_empty() {
        "<none>".to_string()
    } else {
        launch_args.join(" ")
    };
    format!(
        "Claude CLI launch context:\npath: {}\ncwd: {cwd}\ninput_mode: {}\nisolate_local_config: {isolate_local_config}\nlocal_config.model: {configured_model}\nargs: {args}",
        claude.display(),
        input_mode_label(input_mode),
    )
}

pub(crate) fn append_launch_debug_context(message: String, debug_context: &str) -> String {
    if debug_context.trim().is_empty() {
        message
    } else {
        format!("{message}\n\n{debug_context}")
    }
}

pub(crate) fn format_startup_io_failure_message(
    phase: &str,
    error: &std::io::Error,
    exit_code: Option<i32>,
    stderr: &str,
    stdout: &str,
) -> String {
    let mut parts = vec![format!("Failed to {phase}: {error}")];
    if let Some(code) = exit_code {
        parts.push(format!("claude CLI exited early with code {code}."));
    }
    if !stderr.trim().is_empty() {
        parts.push(format!("Claude CLI stderr:\n{}", stderr.trim()));
    } else if !stdout.trim().is_empty() {
        parts.push(format!("Claude CLI stdout:\n{}", stdout.trim()));
    }
    parts.join("\n\n")
}

#[derive(Debug)]
pub(crate) struct TempFileGuard {
    pub(crate) path: PathBuf,
}

impl TempFileGuard {
    pub(crate) fn write_json(prefix: &str, content: &[u8]) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("{prefix}-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write temporary file `{}`: {e}", path.display()))?;
        Ok(Self { path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Debug)]
pub(crate) struct ClaudeCliLaunchConfig {
    pub(crate) args: Vec<String>,
    pub(crate) temp_files: Vec<TempFileGuard>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaudeCliInputMode {
    StreamJson,
    TextStdin(String),
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum ClaudeContent {
    Text(String),
    Blocks(Vec<ClaudeContentBlock>),
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum ClaudeContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mediaType")]
        media_type: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
}

pub(crate) fn claude_content_text_only(content: &ClaudeContent) -> String {
    match content {
        ClaudeContent::Text(text) => text.clone(),
        ClaudeContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                ClaudeContentBlock::Text { text } => Some(text.as_str()),
                ClaudeContentBlock::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

pub(crate) fn claude_content_blocks(content: &ClaudeContent) -> Vec<serde_json::Value> {
    match content {
        ClaudeContent::Text(text) => vec![serde_json::json!({ "type": "text", "text": text })],
        ClaudeContent::Blocks(blocks) => blocks
            .iter()
            .map(|block| match block {
                ClaudeContentBlock::Text { text } => {
                    serde_json::json!({ "type": "text", "text": text })
                }
                ClaudeContentBlock::Image {
                    media_type,
                    data_base64,
                } => serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": data_base64,
                    },
                }),
            })
            .collect(),
    }
}

#[cfg(windows)]
pub(crate) fn prefer_direct_claude_exe(path: std::path::PathBuf) -> std::path::PathBuf {
    let is_wrapper = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "ps1"));
    if !is_wrapper {
        return path;
    }

    let Some(parent) = path.parent() else {
        return path;
    };
    let candidate = parent
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("bin")
        .join("claude.exe");
    if candidate.exists() {
        candidate
    } else {
        path
    }
}

pub(crate) fn select_claude_cli_input_mode(turns: &[(String, Vec<serde_json::Value>)]) -> ClaudeCliInputMode {
    if cfg!(windows) {
        return ClaudeCliInputMode::StreamJson;
    }

    if turns.len() != 1 {
        return ClaudeCliInputMode::StreamJson;
    }

    let Some((role, content)) = turns.first() else {
        return ClaudeCliInputMode::StreamJson;
    };
    if role != "user" {
        return ClaudeCliInputMode::StreamJson;
    }

    let mut prompt = String::new();
    for block in content {
        let Some(block_type) = block.get("type").and_then(serde_json::Value::as_str) else {
            return ClaudeCliInputMode::StreamJson;
        };
        if block_type != "text" {
            return ClaudeCliInputMode::StreamJson;
        }
        let Some(text) = block.get("text").and_then(serde_json::Value::as_str) else {
            return ClaudeCliInputMode::StreamJson;
        };
        prompt.push_str(text);
    }

    // `text` input is a latency optimization for short one-shot prompts.
    // Long-form writing prompts are more stable through the regular
    // stream-json event path and avoid early stdin pipe-closed exits on
    // real desktop resume flows.
    if prompt.len() > CLAUDE_CLI_TEXT_STDIN_MAX_BYTES {
        return ClaudeCliInputMode::StreamJson;
    }

    ClaudeCliInputMode::TextStdin(prompt)
}

#[cfg(not(windows))]
pub(crate) fn prefer_direct_claude_exe(path: std::path::PathBuf) -> std::path::PathBuf {
    path
}

pub(crate) fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) fn build_claude_cli_args(
    model: &str,
    isolate_local_config: bool,
    json_schema: Option<&serde_json::Value>,
    mcp_config_path: Option<&Path>,
    input_mode: &ClaudeCliInputMode,
) -> Vec<String> {
    let mut args = vec!["-p".to_string()];
    args.extend(["--output-format".to_string(), "stream-json".to_string()]);
    match input_mode {
        ClaudeCliInputMode::StreamJson => {
            args.extend(["--input-format".to_string(), "stream-json".to_string()]);
        }
        ClaudeCliInputMode::TextStdin(_) => {
            args.extend(["--input-format".to_string(), "text".to_string()]);
        }
    }
    args.push("--verbose".to_string());
    // Stream partial `stream_event`/`content_block_delta` tokens as they are
    // generated. Without this flag the CLI only emits the complete
    // `AssistantMessage` after the model finishes thinking + generating, so a
    // long-form draft with heavy reasoning produces zero stream-json lines for
    // longer than the transport's first-meaningful-output timeout and gets
    // killed mid-generation. The TS parser already routes `text_delta` events
    // to `onToken`, so partial streaming both feeds the UI live and keeps the
    // inactivity watchdog alive.
    args.push("--include-partial-messages".to_string());

    if isolate_local_config {
        let mcp_config_path = mcp_config_path
            .expect("isolated Claude CLI launch requires a temporary MCP config file");
        args.extend([
            "--strict-mcp-config".to_string(),
            "--mcp-config".to_string(),
            mcp_config_path.to_string_lossy().to_string(),
            "--disable-slash-commands".to_string(),
            "--tools".to_string(),
            "".to_string(),
            "--no-session-persistence".to_string(),
            "--prompt-suggestions".to_string(),
            "false".to_string(),
        ]);
    }

    if !model.trim().is_empty() {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(schema) = json_schema {
        if let Ok(text) = serde_json::to_string(schema) {
            args.extend(["--json-schema".to_string(), text]);
        }
    }
    args
}

pub(crate) fn prepare_claude_cli_launch(
    model: &str,
    isolate_local_config: bool,
    json_schema: Option<&serde_json::Value>,
    input_mode: &ClaudeCliInputMode,
) -> Result<ClaudeCliLaunchConfig, String> {
    let mut temp_files = Vec::new();
    let mcp_config_path = if isolate_local_config {
        let file =
            TempFileGuard::write_json("niko-buddy-claude-mcp-config", EMPTY_MCP_CONFIG_JSON)?;
        let path = file.path().to_path_buf();
        temp_files.push(file);
        Some(path)
    } else {
        None
    };

    Ok(ClaudeCliLaunchConfig {
        args: build_claude_cli_args(
            model,
            isolate_local_config,
            json_schema,
            mcp_config_path.as_deref(),
            input_mode,
        ),
        temp_files,
    })
}

pub(crate) fn read_current_claude_local_config() -> LocalCliConfigInfo {
    let home = resolve_home_dir();
    read_claude_local_config(home.as_deref())
}
