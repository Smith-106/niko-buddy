// Copyright (c) 2024 Niko-hub contributors. MIT License.
// SPDX-License-Identifier: MIT

//! Claude Code CLI subprocess transport.
//!
//! Users with a Claude Code subscription already have OAuth credentials
//! in ~/.claude/ and the `claude` binary on PATH. This module lets LLM
//! Wiki reuse that subscription instead of requiring a separate API key.
//! We treat `claude` purely as a text-completion engine — its agent
//! tools, MCPs, file-edit abilities, and --resume session state are all
//! out of scope. Multi-turn history is reconstructed from `messages`
//! on every call, symmetric with every other provider.
//!
//! Why tokio::process directly (not tauri-plugin-shell): the plugin's
//! scope model is designed for sidecars or fixed absolute paths; scoping
//! a user-installed PATH binary cleanly is awkward. A hardcoded Rust
//! command that always and only spawns `claude` provides the same
//! security property (the webview can't call this command to execute
//! anything else) without pulling in another plugin or editing
//! capabilities JSON.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::cli_resolver::find_cli_command;
use super::local_cli_config::{
    apply_local_cli_environment, read_claude_local_config, resolve_home_dir, LocalCliConfigInfo,
};

/// C-101 (GRL-008): Rust-side startup watchdog. Fires if the CLI produces
/// zero output (not even a heartbeat) within this many seconds — i.e. the
/// process is stuck before its first byte. Overridable via the
/// `QMAI_CLAUDE_STARTUP_TIMEOUT_SECS` env var for slow/portable/cold-start
/// environments. The TS transport separately enforces a (longer, also
/// configurable) "first meaningful output" timeout; the two are intentionally
/// layered (Rust = process-liveness, TS = provider-progress).
fn resolve_startup_output_timeout_secs() -> u64 {
    const DEFAULT: u64 = 30;
    const MIN: u64 = 5;
    match std::env::var("QMAI_CLAUDE_STARTUP_TIMEOUT_SECS") {
        Ok(v) => v.trim().parse::<u64>().ok().filter(|n| *n >= MIN).unwrap_or(DEFAULT),
        Err(_) => DEFAULT,
    }
}
const CLAUDE_STDERR_LIMIT_BYTES: usize = 1024 * 1024;
/// F-001 (ANL-010 C1): bounded stdout JSON buffer cap. The stdout BufReader
/// drain loop previously had NO cap (only stderr was capped at
/// CLAUDE_STDERR_LIMIT_BYTES), so a pipe-buffer-deadlock — the CLI blocks on
/// writing to a full stdout pipe while QMAI stops draining — could grow
/// stdout unbounded and stall indefinitely (the S2 Chapter-12 root cause).
/// Symmetric with codex_cli.rs STDOUT_LIMIT_BYTES (raised to match). On
/// overflow the drain emits a final `stdout-buffer-overflow` marker line and
/// breaks, surfacing the failure instead of deadlocking. 64MB is generous
/// (a full novel chapter stream-json is well under this) but finite.
const CLAUDE_STDOUT_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const EMPTY_MCP_CONFIG_JSON: &[u8] = br#"{"mcpServers":{}}"#;
const CLAUDE_CLI_TEXT_STDIN_MAX_BYTES: usize = 8 * 1024;

fn append_capped_line(collected: &mut String, line: &str, limit_bytes: usize) {
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

fn cap_output_text(bytes: &[u8], limit_bytes: usize) -> String {
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

fn input_mode_label(input_mode: &ClaudeCliInputMode) -> &'static str {
    match input_mode {
        ClaudeCliInputMode::StreamJson => "stream-json",
        ClaudeCliInputMode::TextStdin(_) => "text",
    }
}

fn resolve_claude_cli_working_dir() -> Option<PathBuf> {
    resolve_home_dir().or_else(|| std::env::current_dir().ok())
}

fn format_launch_debug_context(
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

fn append_launch_debug_context(message: String, debug_context: &str) -> String {
    if debug_context.trim().is_empty() {
        message
    } else {
        format!("{message}\n\n{debug_context}")
    }
}

fn format_startup_io_failure_message(
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

async fn collect_startup_io_failure(
    child: Child,
    phase: &str,
    error: std::io::Error,
    debug_context: &str,
) -> String {
    let fallback = format!("Failed to {phase}: {error}");
    match tokio::time::timeout(Duration::from_secs(2), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let stderr = cap_output_text(&output.stderr, CLAUDE_STDERR_LIMIT_BYTES);
            let stdout = cap_output_text(&output.stdout, CLAUDE_STDERR_LIMIT_BYTES);
            append_launch_debug_context(
                format_startup_io_failure_message(
                    phase,
                    &error,
                    output.status.code(),
                    &stderr,
                    &stdout,
                ),
                debug_context,
            )
        }
        Ok(Err(wait_error)) => {
            append_launch_debug_context(
                format!(
                    "{fallback}\n\nAdditionally failed while collecting Claude CLI early-exit output: {wait_error}"
                ),
                debug_context,
            )
        }
        Err(_) => {
            append_launch_debug_context(
                format!(
                    "{fallback}\n\nClaude CLI exited before accepting stdin, but no stdout/stderr was collected within 2 seconds."
                ),
                debug_context,
            )
        }
    }
}

// ── Event emitter abstraction ─────────────────────────────────────
// Allows both Tauri (app.emit) and the standalone server (broadcast
// channel) to share the same spawn logic.

/// Abstraction over "emit a data line" and "emit a done signal".
pub trait CliEmitter: Clone + Send + Sync + 'static {
    fn emit_data(&self, stream_id: &str, data: String);
    fn emit_done(&self, stream_id: &str, code: Option<i32>, stderr: String);
}

#[derive(Debug)]
struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn write_json(prefix: &str, content: &[u8]) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("{prefix}-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write temporary file `{}`: {e}", path.display()))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Debug)]
struct ClaudeCliLaunchConfig {
    args: Vec<String>,
    temp_files: Vec<TempFileGuard>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClaudeCliInputMode {
    StreamJson,
    TextStdin(String),
}

#[derive(Debug)]
struct RunningClaudeCli {
    child: Child,
    _temp_files: Vec<TempFileGuard>,
}

/// Tauri-based emitter that forwards to `app.emit()`.
#[derive(Clone)]
pub struct TauriCliEmitter {
    app: AppHandle,
}

impl TauriCliEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl CliEmitter for TauriCliEmitter {
    fn emit_data(&self, stream_id: &str, data: String) {
        let topic = format!("claude-cli:{stream_id}");
        let _ = self.app.emit(&topic, data);
    }

    fn emit_done(&self, stream_id: &str, code: Option<i32>, stderr: String) {
        let done_topic = format!("claude-cli:{stream_id}:done");
        let _ = self.app.emit(
            &done_topic,
            serde_json::json!({
                "code": code,
                "stderr": stderr,
            }),
        );
    }
}

/// Shared state holding running `claude` child processes keyed by the
/// frontend-generated stream id. Registered via .manage() in lib.rs.
#[derive(Default)]
pub struct ClaudeCliState {
    children: Arc<Mutex<HashMap<String, RunningClaudeCli>>>,
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    model: Option<String>,
    /// When !installed, a short human-readable reason (missing from PATH,
    /// quarantined on macOS, spawn failed, etc). The frontend shows this
    /// verbatim in the status pill.
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct ClaudeMessage {
    /// "system" | "user" | "assistant"
    role: String,
    content: ClaudeContent,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum ClaudeContent {
    Text(String),
    Blocks(Vec<ClaudeContentBlock>),
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type")]
enum ClaudeContentBlock {
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

fn claude_content_text_only(content: &ClaudeContent) -> String {
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

fn claude_content_blocks(content: &ClaudeContent) -> Vec<serde_json::Value> {
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

async fn find_claude_command() -> Result<std::path::PathBuf, String> {
    let path = find_cli_command("claude", &["claude.exe", "claude.cmd", "claude.ps1"]).await?;
    Ok(prefer_direct_claude_exe(path))
}

#[cfg(windows)]
fn prefer_direct_claude_exe(path: std::path::PathBuf) -> std::path::PathBuf {
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

fn select_claude_cli_input_mode(turns: &[(String, Vec<serde_json::Value>)]) -> ClaudeCliInputMode {
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
fn prefer_direct_claude_exe(path: std::path::PathBuf) -> std::path::PathBuf {
    path
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

/// Locate `claude` on PATH and confirm it's runnable by calling
/// `claude --version` with a short timeout. Cheap — safe to call on
/// mount of the settings panel.
///
/// Shared implementation used by both the Tauri command and the server handler.
pub async fn do_claude_cli_detect() -> Result<DetectResult, String> {
    let local_config = read_current_claude_local_config();
    let path = match find_claude_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                model: local_config.model,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();

    let mut cmd = Command::new(&path);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(DetectResult {
                installed: true,
                version: Some(version),
                path: Some(path_str),
                model: local_config.model,
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // macOS Gatekeeper quarantines produce a predictable error. If
            // we detect it, surface the remediation hint directly; the UI
            // renders this string into an actionable message.
            let error = if stderr.contains("quarantine") || stderr.contains("damaged") {
                Some(format!(
                    "Binary quarantined — try: xattr -d com.apple.quarantine {path_str}"
                ))
            } else if stderr.is_empty() {
                Some(format!("`claude --version` exited with {}", out.status))
            } else {
                Some(stderr)
            };
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                model: local_config.model,
                error,
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            model: local_config.model,
            error: Some(format!("Failed to spawn `claude`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            model: local_config.model,
            error: Some("`claude --version` timed out after 3s".to_string()),
        }),
    }
}

#[tauri::command]
pub async fn claude_cli_detect() -> Result<DetectResult, String> {
    do_claude_cli_detect().await
}

/// Spawn `claude -p --output-format stream-json --verbose --model <model>`
/// and pipe either `text` or `stream-json` input via stdin, depending on the
/// conversation shape. Emits a final done event with `{ code }` when the
/// child exits.
///
/// Shared implementation used by both the Tauri command and the server handler.
pub async fn do_claude_cli_spawn<E: CliEmitter>(
    state: &ClaudeCliState,
    emitter: E,
    stream_id: String,
    model: String,
    messages: Vec<ClaudeMessage>,
    isolate_local_config: bool,
    json_schema: Option<serde_json::Value>,
) -> Result<(), String> {
    // Build the turn list: fold any system messages into a preamble on
    // the first user turn rather than using a CLI flag, because
    // --system-prompt / --append-system-prompt availability varies
    // across claude CLI versions. Inlining works on every version.
    let system_preamble: String = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| claude_content_text_only(&m.content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let conversation: Vec<&ClaudeMessage> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .collect();

    if conversation.is_empty() {
        return Err("No user/assistant messages to send to claude CLI".to_string());
    }

    // Synthesize turns with the preamble merged into the first user turn.
    let mut first_user_seen = false;
    let turns: Vec<(String, Vec<serde_json::Value>)> = conversation
        .iter()
        .map(|m| {
            let role = m.role.clone();
            let mut content = claude_content_blocks(&m.content);
            if !first_user_seen && role == "user" && !system_preamble.is_empty() {
                content.insert(
                    0,
                    serde_json::json!({ "type": "text", "text": format!("{system_preamble}\n\n") }),
                );
                first_user_seen = true;
            }
            (role, content)
        })
        .collect();
    let input_mode = select_claude_cli_input_mode(&turns);

    let claude = find_claude_command().await?;
    let launch_config = prepare_claude_cli_launch(
        &model,
        isolate_local_config,
        json_schema.as_ref(),
        &input_mode,
    )?;
    let local_config = read_current_claude_local_config();
    let working_dir = resolve_claude_cli_working_dir();
    let launch_debug = format_launch_debug_context(
        &claude,
        &launch_config.args,
        &input_mode,
        isolate_local_config,
        working_dir.as_deref(),
        &local_config,
    );
    let mut cmd = Command::new(&claude);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    if let Some(dir) = working_dir.as_deref() {
        cmd.current_dir(dir);
    }
    cmd.args(&launch_config.args);

    cmd.stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| append_launch_debug_context(format!("Failed to spawn claude: {e}"), &launch_debug))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    match &input_mode {
        ClaudeCliInputMode::StreamJson => {
            // Serialize turns to stdin then close. stream-json input format
            // expects one JSON event per line. Conversation history is laid out
            // in order; the final user turn triggers claude's response.
            //
            // `content` MUST be an array of blocks, not a plain string. The CLI
            // iterates content blocks looking for `tool_use_id` and crashes with
            // `W is not an Object. (evaluating '"tool_use_id"in W')` if it
            // encounters a raw string. User turns silently tolerated a string
            // in light testing, but assistant turns reject it immediately, so
            // we normalize both roles to the block-array form.
            for (role, content) in &turns {
                let event = serde_json::json!({
                    "type": role,
                    "message": {
                        "role": role,
                        "content": content,
                    }
                });
                let line = format!("{}\n", event);
                if let Err(error) = stdin.write_all(line.as_bytes()).await {
                    return Err(
                        collect_startup_io_failure(child, "write to claude stdin", error, &launch_debug)
                            .await,
                    );
                }
            }
        }
        ClaudeCliInputMode::TextStdin(prompt) => {
            if let Err(error) = stdin.write_all(prompt.as_bytes()).await {
                return Err(
                    collect_startup_io_failure(child, "write to claude stdin", error, &launch_debug)
                        .await,
                );
            }
        }
    }
    if let Err(error) = stdin.flush().await {
        return Err(
            collect_startup_io_failure(child, "flush claude stdin", error, &launch_debug).await,
        );
    }
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    // Register the child so `claude_cli_kill` can reach it.
    state.children.lock().await.insert(
        stream_id.clone(),
        RunningClaudeCli {
            child,
            _temp_files: launch_config.temp_files,
        },
    );

    let children = Arc::clone(&state.children);
    let timeout_children = Arc::clone(&state.children);
    let stream_id_task = stream_id.clone();
    let timeout_stream_id = stream_id.clone();
    let emitter_task = emitter.clone();
    let saw_startup_output = Arc::new(AtomicBool::new(false));
    let saw_output_for_timeout = Arc::clone(&saw_startup_output);
    let startup_timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&startup_timed_out);
    let startup_timeout_secs = resolve_startup_output_timeout_secs();

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(startup_timeout_secs)).await;
        if saw_output_for_timeout.load(Ordering::SeqCst) {
            return;
        }
        if let Some(mut running) = timeout_children.lock().await.remove(&timeout_stream_id) {
            timeout_flag.store(true, Ordering::SeqCst);
            let _ = running.child.start_kill();
        }
    });

    // Drain stdout line-by-line in a background task, emitting each
    // line as an event. Completes when stdout closes (child exited).
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let saw_output_for_stderr = Arc::clone(&saw_startup_output);
        let timeout_hit = Arc::clone(&startup_timed_out);
        let stderr_stream_id = stream_id_task.clone();
        let stderr_emitter = emitter_task.clone();

        // Collect stderr in a background task so we can ship it with the
        // final :done event — otherwise a non-zero exit produces only
        // "exited with code N" with no diagnostic info on the frontend.
        // Also echo each line to the tauri dev terminal so the developer
        // can watch the CLI's stderr live while iterating.
        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                log::debug!("[claude-cli stderr] {line}");
                saw_output_for_stderr.store(true, Ordering::SeqCst);
                stderr_emitter.emit_data(
                    &stderr_stream_id,
                    serde_json::json!({
                        "type": "stderr",
                        "text": line,
                    })
                    .to_string(),
                );
                append_capped_line(&mut collected, &line, CLAUDE_STDERR_LIMIT_BYTES);
            }
            collected
        });

        // F-001 (ANL-010 C1): bounded stdout buffer. Track accumulated stdout
        // bytes; on overflow (pipe-buffer-deadlock would otherwise grow this
        // unbounded and stall) emit a final `stdout-buffer-overflow` marker
        // line to the stream and break the drain. The marker lets the TS
        // transport surface the failure (and trigger SessionTransportFallback)
        // instead of hanging forever on a full pipe.
        let mut stdout_bytes: usize = 0;
        let mut stdout_overflowed = false;

        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    saw_startup_output.store(true, Ordering::SeqCst);
                    if !stdout_overflowed {
                        stdout_bytes = stdout_bytes.saturating_add(line.len() + 1);
                        if stdout_bytes >= CLAUDE_STDOUT_LIMIT_BYTES {
                            stdout_overflowed = true;
                            // Emit the overflow marker as a final stdout line
                            // so the TS parser can detect it and fall back.
                            emitter_task.emit_data(
                                &stream_id_task,
                                "{\"type\":\"stdout-buffer-overflow\"}".to_string(),
                            );
                            // Continue draining (don't hard-break) so the child
                            // can still exit cleanly, but stop accumulating —
                            // further lines are discarded to bound memory.
                        }
                    }
                    emitter_task.emit_data(&stream_id_task, line);
                }
                Ok(None) => break,
                Err(e) => {
                    log::error!("[claude-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        // Wait for the child to fully exit so we can report its code.
        // Don't hold the map lock across .wait() — kill could race.
        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut running) = child_opt {
            match running.child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            // Already removed by claude_cli_kill — leave code as None.
            None
        };

        let mut stderr_text = stderr_task.await.unwrap_or_default();
        if timeout_hit.load(Ordering::SeqCst) {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(
                "Claude Code CLI produced no output within 30 seconds (process stuck before first byte; MCP is disabled by QMAI so this is not an MCP-bootstrap hang). The transport will retry with backoff; if this persists, switch provider in Settings (e.g. to Codex), or set QMAI_CLAUDE_STARTUP_TIMEOUT_SECS for slow/portable/cold-start environments, or run `claude -p ... --verbose` in a terminal to inspect the environment.",
            );
        } else if stderr_text.len() >= CLAUDE_STDERR_LIMIT_BYTES {
            stderr_text.push_str("\n[stderr truncated]");
        }

        // F-001 (ANL-010 C1): surface the stdout-buffer-overflow in the final
        // done event so the TS transport can detect it (the stream was
        // truncated because stdout exceeded CLAUDE_STDOUT_LIMIT_BYTES — a
        // pipe-buffer-deadlock symptom) and trigger SessionTransportFallback.
        if stdout_overflowed {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str("stdout-buffer-overflow: stdout exceeded CLAUDE_STDOUT_LIMIT_BYTES, stream truncated. The CLI transport will retry with backoff; if this persists, switch provider in Settings.");
        }

        let code = if timeout_hit.load(Ordering::SeqCst) {
            Some(-1)
        } else {
            exit_code
        };

        emitter_task.emit_done(&stream_id_task, code, stderr_text);
    });

    Ok(())
}

#[tauri::command]
pub async fn claude_cli_spawn(
    app: AppHandle,
    state: State<'_, ClaudeCliState>,
    stream_id: String,
    model: String,
    messages: Vec<ClaudeMessage>,
    isolate_local_config: bool,
    json_schema: Option<serde_json::Value>,
) -> Result<(), String> {
    let emitter = TauriCliEmitter::new(app);
    do_claude_cli_spawn(
        &state,
        emitter,
        stream_id,
        model,
        messages,
        isolate_local_config,
        json_schema,
    )
    .await
}

fn build_claude_cli_args(
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

fn prepare_claude_cli_launch(
    model: &str,
    isolate_local_config: bool,
    json_schema: Option<&serde_json::Value>,
    input_mode: &ClaudeCliInputMode,
) -> Result<ClaudeCliLaunchConfig, String> {
    let mut temp_files = Vec::new();
    let mcp_config_path = if isolate_local_config {
        let file = TempFileGuard::write_json("qmai-claude-mcp-config", EMPTY_MCP_CONFIG_JSON)?;
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

fn read_current_claude_local_config() -> LocalCliConfigInfo {
    let home = resolve_home_dir();
    read_claude_local_config(home.as_deref())
}

/// Kill a running child registered under `stream_id`. Called on
/// AbortSignal in the frontend. No-op if the id is unknown (e.g. the
/// process already exited).
///
/// Shared implementation used by both the Tauri command and the server handler.
pub async fn do_claude_cli_kill(state: &ClaudeCliState, stream_id: &str) -> Result<(), String> {
    if let Some(mut running) = state.children.lock().await.remove(stream_id) {
        let _ = running.child.start_kill();
        // Don't wait() here — the stdout-drain task already holds a
        // wait future elsewhere when it can. Dropping the handle is
        // enough; kill_on_drop ensures the SIGKILL is sent.
    }
    Ok(())
}

#[tauri::command]
pub async fn claude_cli_kill(
    state: State<'_, ClaudeCliState>,
    stream_id: String,
) -> Result<(), String> {
    do_claude_cli_kill(&state, &stream_id).await
}

/// F-001 (ANL-010): graceful terminate of a running child. This is the
/// Rust-side counterpart to the TS `gracefulAbortStream` helper: the TS
/// transport calls `claude_cli_terminate` first, waits the configured
/// `sigtermGraceMs` window for the child to self-exit, then escalates to
/// `claude_cli_kill` (SIGKILL) if it's still alive. The grace period is
/// enforced in TS (per the S3 boundary: NO Rust spawn-lifecycle rewrite),
/// so this command only emits the best-effort soft signal and leaves the
/// child registered so the subsequent kill (or natural exit) still works.
///
/// On Unix we send SIGTERM via libc::kill (no new direct dependency — the
/// symbol is resolved by the platform libc). On Windows there is no
/// portable SIGTERM equivalent for a child console process, so we fall
/// back to start_kill (TerminateProcess); the TS grace window still gives
/// the stdout-drain task time to flush buffered output before the hard
/// kill path runs.
pub async fn do_claude_cli_terminate(state: &ClaudeCliState, stream_id: &str) -> Result<(), String> {
    // BP-001 (from quality-review): named constant, not a magic number.
    // SIGTERM = 15 on every Unix target we ship (Linux, macOS).
    #[cfg(unix)]
    const SIGTERM: i32 = 15;
    let mut guard = state.children.lock().await;
    if let Some(running) = guard.get_mut(stream_id) {
        #[cfg(unix)]
        {
            // extern C shim — avoids adding libc as a direct dependency.
            extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            // SEC-001 (from quality-review): TOCTOU / pid-recycling guard.
            // If the child has already exited, the OS may have recycled its
            // pid to an unrelated process, and a bare kill(pid, SIGTERM) would
            // signal that process. try_wait() returns Ok(Some(status)) only
            // for a child that has definitively exited; Ok(None) means still
            // running. We skip the signal when the child is already dead (the
            // drain task will remove it on done). A residual race remains
            // between try_wait and kill (the child can exit in that window),
            // but this narrows the window from "anytime since spawn" to
            // "microseconds between try_wait and kill" — acceptable under the
            // S3 boundary (NO spawn-lifecycle rewrite; a race-free path needs
            // pidfd_send_signal which is Linux-only and a new dependency).
            // We hold the registry mutex, so no concurrent Rust code can drop
            // this ChildHandle while we inspect it.
            let already_exited = running.child.try_wait().map(|s| s.is_some()).unwrap_or(false);
            if !already_exited {
                if let Some(pid) = running.child.id() {
                    // Child::id() 返回 u32；libc::kill 形参为 pid_t(i32)。
                    // PID 空间远小于 i32::MAX，转换无损。
                    let _ = unsafe { kill(pid as i32, SIGTERM) };
                }
            }
        }
        #[cfg(not(unix))]
        {
            // Windows: no portable graceful signal; best-effort hard kill
            // is deferred to the TS-driven kill escalation after grace.
            // We intentionally do NOT start_kill here so the TS grace
            // window can elapse first (the done-listener fires if the
            // child exits naturally during the window).
            let _ = running;
        }
    }
    // NOTE: do NOT remove the child from the registry here — the TS layer
    // escalates to claude_cli_kill (which removes it) or the child exits
    // naturally (the drain task removes it on done). Removing here would
    // race the kill path.
    Ok(())
}

#[tauri::command]
pub async fn claude_cli_terminate(
    state: State<'_, ClaudeCliState>,
    stream_id: String,
) -> Result<(), String> {
    do_claude_cli_terminate(&state, &stream_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_content_blocks_maps_frontend_image_blocks_to_anthropic_shape() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "describe this" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");

        let blocks = claude_content_blocks(&content);

        assert_eq!(
            blocks,
            vec![
                serde_json::json!({ "type": "text", "text": "describe this" }),
                serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc123",
                    },
                }),
            ]
        );
    }

    #[test]
    fn system_text_drops_images_before_inlining_preamble() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "system rule" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");

        assert_eq!(claude_content_text_only(&content), "system rule");
    }

    #[test]
    fn claude_args_do_not_isolate_local_config_by_default() {
        let args =
            build_claude_cli_args("sonnet", false, None, None, &ClaudeCliInputMode::StreamJson);

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"sonnet".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--input-format" && pair[1] == "stream-json"));
        assert!(!args.contains(&"--setting-sources".to_string()));
        assert!(!args.contains(&"--strict-mcp-config".to_string()));
        assert!(!args.contains(&"--disable-slash-commands".to_string()));
    }

    #[test]
    fn claude_args_include_partial_messages_so_long_generations_stream_tokens() {
        // Without --include-partial-messages the CLI only emits the complete
        // AssistantMessage after the model finishes thinking + generating, so a
        // long-form draft with heavy reasoning produces no stream-json lines
        // for longer than the transport's first-meaningful-output timeout and
        // gets killed mid-generation. Partial streaming must be on in both
        // isolated and non-isolated modes.
        let isolated = build_claude_cli_args(
            "sonnet",
            true,
            None,
            Some(std::path::Path::new("ignored")),
            &ClaudeCliInputMode::StreamJson,
        );
        let plain = build_claude_cli_args("sonnet", false, None, None, &ClaudeCliInputMode::StreamJson);
        let text_stdin = build_claude_cli_args(
            "sonnet",
            false,
            None,
            None,
            &ClaudeCliInputMode::TextStdin("hi".to_string()),
        );
        for (label, args) in [("isolated", &isolated), ("plain", &plain), ("text-stdin", &text_stdin)] {
            assert!(
                args.contains(&"--include-partial-messages".to_string()),
                "{label} args must include --include-partial-messages, got {args:?}"
            );
        }
    }

    #[test]
    fn claude_args_can_isolate_user_config_tools_and_mcp() {
        let temp = TempFileGuard::write_json("qmai-claude-cli-test", EMPTY_MCP_CONFIG_JSON)
            .expect("temporary mcp config");
        let expected_path = temp.path().to_string_lossy().to_string();
        let args = build_claude_cli_args(
            "sonnet",
            true,
            None,
            Some(temp.path()),
            &ClaudeCliInputMode::StreamJson,
        );

        assert!(!args.contains(&"--setting-sources".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--mcp-config" && pair[1] == expected_path));
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--tools" && pair[1].is_empty()));
        assert!(args.contains(&"--no-session-persistence".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--prompt-suggestions" && pair[1] == "false"));
    }

    #[test]
    fn claude_args_skip_model_flag_when_model_is_empty() {
        let args = build_claude_cli_args("", false, None, None, &ClaudeCliInputMode::StreamJson);
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn claude_args_include_json_schema_when_provided() {
        let schema =
            serde_json::json!({ "type": "object", "properties": { "ok": { "type": "boolean" } } });
        let args = build_claude_cli_args(
            "sonnet",
            false,
            Some(&schema),
            None,
            &ClaudeCliInputMode::StreamJson,
        );

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--json-schema" && pair[1].contains("\"type\":\"object\"")));
    }

    #[test]
    fn claude_args_text_stdin_uses_text_input_format() {
        let args = build_claude_cli_args(
            "sonnet",
            false,
            None,
            None,
            &ClaudeCliInputMode::TextStdin("Reply with OK only.".to_string()),
        );

        assert!(args.len() >= 5);
        assert_eq!(args[0], "-p");
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--input-format" && pair[1] == "text"));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
    }

    #[test]
    fn prepare_claude_cli_launch_writes_temp_mcp_config_for_isolation() {
        let launch =
            prepare_claude_cli_launch("sonnet", true, None, &ClaudeCliInputMode::StreamJson)
                .expect("isolated launch config");

        assert_eq!(launch.temp_files.len(), 1);
        let path = launch.temp_files[0].path();
        assert!(path.exists());
        assert_eq!(
            std::fs::read(path).expect("temp mcp config readable"),
            EMPTY_MCP_CONFIG_JSON
        );
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair[0] == "--mcp-config" && pair[1] == path.to_string_lossy()));
    }

    #[test]
    fn select_claude_cli_input_mode_prefers_single_text_only_user_turn() {
        let mode = select_claude_cli_input_mode(&[(
            "user".to_string(),
            vec![
                serde_json::json!({ "type": "text", "text": "prefix " }),
                serde_json::json!({ "type": "text", "text": "suffix" }),
            ],
        )]);

        if cfg!(windows) {
            assert_eq!(mode, ClaudeCliInputMode::StreamJson);
        } else {
            assert_eq!(
                mode,
                ClaudeCliInputMode::TextStdin("prefix suffix".to_string())
            );
        }
    }

    #[test]
    fn select_claude_cli_input_mode_keeps_stream_json_for_multi_turn_or_non_text_content() {
        let multi_turn = select_claude_cli_input_mode(&[
            (
                "user".to_string(),
                vec![serde_json::json!({ "type": "text", "text": "hi" })],
            ),
            (
                "assistant".to_string(),
                vec![serde_json::json!({ "type": "text", "text": "hello" })],
            ),
        ]);
        let image_turn = select_claude_cli_input_mode(&[(
            "user".to_string(),
            vec![serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": "abc123" }
            })],
        )]);

        assert_eq!(multi_turn, ClaudeCliInputMode::StreamJson);
        assert_eq!(image_turn, ClaudeCliInputMode::StreamJson);
    }

    #[test]
    fn select_claude_cli_input_mode_keeps_stream_json_for_long_single_turn_prompts() {
        let long_prompt = "写".repeat(CLAUDE_CLI_TEXT_STDIN_MAX_BYTES + 1);
        let mode = select_claude_cli_input_mode(&[(
            "user".to_string(),
            vec![serde_json::json!({ "type": "text", "text": long_prompt })],
        )]);

        assert_eq!(mode, ClaudeCliInputMode::StreamJson);
    }

    #[cfg(windows)]
    #[test]
    fn select_claude_cli_input_mode_forces_stream_json_on_windows_even_for_short_text() {
        let mode = select_claude_cli_input_mode(&[(
            "user".to_string(),
            vec![serde_json::json!({ "type": "text", "text": "short prompt" })],
        )]);

        assert_eq!(mode, ClaudeCliInputMode::StreamJson);
    }

    #[test]
    fn temp_file_guard_removes_file_on_drop() {
        let path = {
            let guard =
                TempFileGuard::write_json("qmai-temp-guard-test", b"{}").expect("temporary file");
            let path = guard.path().to_path_buf();
            assert!(path.exists());
            path
        };

        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn prefers_direct_claude_exe_over_npm_cmd_shim() {
        let dir = tempdir_for_test();
        let shim_dir = dir.join("npm");
        let target_dir = shim_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin");
        std::fs::create_dir_all(&target_dir).unwrap();
        let shim = shim_dir.join("claude.cmd");
        let target = target_dir.join("claude.exe");
        std::fs::write(&shim, "@echo off").unwrap();
        std::fs::write(&target, "").unwrap();

        assert_eq!(prefer_direct_claude_exe(shim), target);
    }

    #[cfg(windows)]
    #[test]
    fn keeps_original_claude_path_when_no_direct_exe_exists() {
        let dir = tempdir_for_test();
        let shim_dir = dir.join("npm");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let shim = shim_dir.join("claude.cmd");
        std::fs::write(&shim, "@echo off").unwrap();

        assert_eq!(prefer_direct_claude_exe(shim.clone()), shim);
    }

    #[test]
    fn cap_output_text_preserves_utf8_and_respects_limit() {
        let capped = cap_output_text("第一行\n第二行\n第三行".as_bytes(), 9);

        assert_eq!(capped, "第一行");
    }

    #[test]
    fn format_startup_io_failure_message_prefers_stderr() {
        let error = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe closed");
        let message = format_startup_io_failure_message(
            "flush claude stdin",
            &error,
            Some(1),
            "Unknown model 'claude-opus-4-8'",
            "{\"type\":\"error\"}",
        );

        assert!(message.contains("Failed to flush claude stdin: pipe closed"));
        assert!(message.contains("claude CLI exited early with code 1."));
        assert!(message.contains("Claude CLI stderr:\nUnknown model 'claude-opus-4-8'"));
        assert!(!message.contains("Claude CLI stdout"));
    }

    #[test]
    fn format_launch_debug_context_records_cwd_mode_and_model() {
        let claude = PathBuf::from("C:/Tools/claude.exe");
        let working_dir = PathBuf::from("C:/Users/niko");
        let context = format_launch_debug_context(
            &claude,
            &[
                "-p".to_string(),
                "--input-format".to_string(),
                "text".to_string(),
            ],
            &ClaudeCliInputMode::TextStdin("hi".to_string()),
            true,
            Some(&working_dir),
            &LocalCliConfigInfo {
                model: Some("claude-opus-4-8".to_string()),
            },
        );

        assert!(context.contains("path: C:/Tools/claude.exe"));
        assert!(context.contains("cwd: C:/Users/niko"));
        assert!(context.contains("input_mode: text"));
        assert!(context.contains("isolate_local_config: true"));
        assert!(context.contains("local_config.model: claude-opus-4-8"));
        assert!(context.contains("args: -p --input-format text"));
    }

    #[test]
    fn append_launch_debug_context_adds_context_block() {
        let message = append_launch_debug_context(
            "Failed to flush claude stdin: pipe closed".to_string(),
            "Claude CLI launch context:\npath: C:/Tools/claude.exe",
        );

        assert!(message.contains("Failed to flush claude stdin: pipe closed"));
        assert!(message.contains("Claude CLI launch context:"));
        assert!(message.contains("path: C:/Tools/claude.exe"));
    }

    fn tempdir_for_test() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qmai-claude-cli-test-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
