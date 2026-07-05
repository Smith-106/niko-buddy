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
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::cli_resolver::find_cli_command;
use super::local_cli_config::{
    apply_local_cli_environment, read_claude_local_config, resolve_home_dir, LocalCliConfigInfo,
};

/// Shared state holding running `claude` child processes keyed by the
/// frontend-generated stream id. Registered via .manage() in lib.rs.
#[derive(Default)]
pub struct ClaudeCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
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
    find_cli_command("claude", &["claude.cmd", "claude.exe"]).await
}

/// Cap collected output text to a sane limit so a pathological child
/// (e.g. one dumping a huge traceback on early exit) cannot exhaust
/// memory or bloat the error string. Trims leading/trailing whitespace
/// so empty-output cases collapse to an empty string.
const CLAUDE_STDERR_LIMIT_BYTES: usize = 1024 * 1024;

fn cap_output_text(bytes: &[u8], limit_bytes: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut collected = String::new();
    for line in text.lines() {
        if collected.len() + line.len() > limit_bytes {
            break;
        }
        collected.push_str(line);
        collected.push('\n');
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

/// Build a diagnostic context string describing how the Claude CLI was
/// launched (path, cwd, isolate flag, local-config model, args). Appended
/// to early-exit failures so the user sees why the spawn may have failed
/// rather than a bare "pipe ended".
fn format_launch_debug_context(
    claude: &std::path::Path,
    launch_args: &[String],
    isolate_local_config: bool,
    local_config: &LocalCliConfigInfo,
) -> String {
    let configured_model = local_config.model.as_deref().unwrap_or("<none>");
    let args = if launch_args.is_empty() {
        "<none>".to_string()
    } else {
        launch_args.join(" ")
    };
    format!(
        "Claude CLI launch context:\npath: {}\nisolate_local_config: {isolate_local_config}\nlocal_config.model: {configured_model}\nargs: {args}",
        claude.display(),
    )
}

fn append_launch_debug_context(message: String, debug_context: &str) -> String {
    if debug_context.trim().is_empty() {
        message
    } else {
        format!("{message}\n\n{debug_context}")
    }
}

/// Format the "Failed to {phase}" message with the child's early-exit
/// output (exit code + whatever stderr/stdout was collected) so the user
/// can diagnose why the child exited before accepting stdin.
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

/// On a stdin write/flush failure (the child exited before accepting stdin —
/// `pipe ended`, `os error 109`), wait up to 2 seconds for the child to
/// finish and collect its stdout/stderr/exit-code so the surfaced error
/// message describes why the child quit early instead of a bare "pipe
/// ended". This is the recovery that makes a spawn-lifecycle early exit
/// diagnostic rather than a silent "Failed to flush claude stdin" crash.
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
        Ok(Err(wait_error)) => append_launch_debug_context(
            format!(
                "{fallback}\n\nAdditionally failed while collecting Claude CLI early-exit output: {wait_error}"
            ),
            debug_context,
        ),
        Err(_) => append_launch_debug_context(
            format!(
                "{fallback}\n\nClaude CLI exited before accepting stdin, but no stdout/stderr was collected within 2 seconds."
            ),
            debug_context,
        ),
    }
}

/// Empty MCP config JSON written to a temp file for `--mcp-config`. The
/// claude CLI rejects inline JSON passed to `--mcp-config` (exits with
/// code 1 before accepting stdin — causing the stdin flush "pipe ended"
/// error); passing a file path works on every version.
const EMPTY_MCP_CONFIG_JSON: &[u8] = br#"{"mcpServers":{}}"#;

/// RAII guard for a temporary file. The file is written on construction
/// and removed on drop, so the temp file is cleaned up even if the spawn
/// errors out or the child is dropped. The path is available to the
/// caller for the duration of the guard via `path()`.
struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn write_json(prefix: &str, content: &[u8]) -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("{prefix}-{}.json", Uuid::new_v4()));
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

fn suppress_windows_console(_cmd: &mut Command) {    #[cfg(windows)]
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
#[tauri::command]
pub async fn claude_cli_detect() -> Result<DetectResult, String> {
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

/// Spawn `claude -p --output-format stream-json --input-format stream-json
/// --verbose --model <model>` and pipe stdout back to the frontend as
/// `claude-cli:{stream_id}` events (one line per event). Closes stdin
/// after writing the serialized history so claude starts processing.
/// Emits a final `claude-cli:{stream_id}:done` event with `{ code }`
/// when the child exits.
#[tauri::command]
pub async fn claude_cli_spawn(
    app: AppHandle,
    state: State<'_, ClaudeCliState>,
    stream_id: String,
    model: String,
    messages: Vec<ClaudeMessage>,
    isolate_local_config: bool,
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

    let claude = find_claude_command().await?;
    let local_config = read_current_claude_local_config();
    // Write the empty MCP config to a temp file when isolating so
    // --mcp-config points at a file path, not inline JSON (the claude CLI
    // rejects inline JSON and exits with code 1 before accepting stdin).
    // The TempFileGuard is dropped after the spawn completes or errors —
    // keep it alive for the duration of this function via the `_mcp_guard`
    // binding below.
    let mcp_guard = if isolate_local_config {
        Some(TempFileGuard::write_json("qmai-claude-mcp-config", EMPTY_MCP_CONFIG_JSON)?)
    } else {
        None
    };
    let mcp_config_path = mcp_guard.as_ref().map(|g| g.path());
    let launch_args = build_claude_cli_args(&model, isolate_local_config, mcp_config_path);
    let launch_debug =
        format_launch_debug_context(&claude, &launch_args, isolate_local_config, &local_config);
    let mut cmd = Command::new(&claude);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    cmd.args(&launch_args);

    // Hold the temp file guard until the child is registered; dropping it
    // too early would remove the file while claude still needs it open.
    // We move it into the stdout-drain task below so it lives as long as
    // the spawn does.
    // (Re-bind to a non-underscore name so it can be moved into the task.)
    let mut mcp_guard_opt = mcp_guard;

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        append_launch_debug_context(format!("Failed to spawn claude: {e}"), &launch_debug)
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    // Capture stdout/stderr up front so a stdin failure can still surface
    // the child's early-exit output (we take them before any write so
    // the handles are available even if the child exits mid-write).
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

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
            drop(stdin);
            let recovered = collect_startup_io_failure(
                child,
                "write to claude stdin",
                error,
                &launch_debug,
            )
            .await;
            let _ = stderr;
            let _ = stdout;
            return Err(recovered);
        }
    }
    if let Err(error) = stdin.flush().await {
        drop(stdin);
        let recovered = collect_startup_io_failure(
            child,
            "flush claude stdin",
            error,
            &launch_debug,
        )
        .await;
        let _ = stderr;
        let _ = stdout;
        return Err(recovered);
    }
    drop(stdin);

    // Register the child so `claude_cli_kill` can reach it.
    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let topic = format!("claude-cli:{stream_id}");
    let done_topic = format!("claude-cli:{stream_id}:done");

    // Drain stdout line-by-line in a background task, emitting each
    // line as an event. Completes when stdout closes (child exited).
    // The MCP temp file guard is moved into this task so the file lives
    // as long as the child can still read it.
    let mcp_guard_for_task = mcp_guard_opt.take();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app = app_for_task;
        let _mcp_guard = mcp_guard_for_task;

        // Collect stderr in a background task so we can ship it with the
        // final :done event — otherwise a non-zero exit produces only
        // "exited with code N" with no diagnostic info on the frontend.
        // Also echo each line to the tauri dev terminal so the developer
        // can watch the CLI's stderr live while iterating.
        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[claude-cli stderr] {line}");
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        });

        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    if app.emit(&topic, line).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[claude-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        // Wait for the child to fully exit so we can report its code.
        // Don't hold the map lock across .wait() — kill could race.
        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            // Already removed by claude_cli_kill — leave code as None.
            None
        };

        let stderr_text = stderr_task.await.unwrap_or_default();

        let _ = app.emit(
            &done_topic,
            serde_json::json!({
                "code": exit_code,
                "stderr": stderr_text,
            }),
        );
    });

    Ok(())
}

fn build_claude_cli_args(
    model: &str,
    isolate_local_config: bool,
    mcp_config_path: Option<&Path>,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        // Stream partial `stream_event`/`content_block_delta` tokens as they
        // are generated. Without this flag the CLI only emits the complete
        // `AssistantMessage` after the model finishes thinking + generating,
        // so a long-form draft with heavy reasoning produces zero stream-json
        // lines for longer than the transport's first-meaningful-output
        // timeout and gets killed mid-generation. The TS parser already
        // routes `text_delta` events to `onToken`, so partial streaming both
        // feeds the UI live and keeps the inactivity watchdog alive.
        "--include-partial-messages".to_string(),
    ];

    if isolate_local_config {
        // `--mcp-config` must point to a file path, not an inline JSON blob.
        // Passing the JSON inline was rejected by the claude CLI (exit code 1
        // before accepting stdin — the child printed "invalid value" and
        // exited, so stdin flush then errored with "pipe ended, os error 109").
        // The temp file is written by the caller (claude_cli_spawn) before the
        // args are built and cleaned up after the child is dropped.
        let mcp_config = match mcp_config_path {
            Some(p) => p.to_string_lossy().to_string(),
            None => "{\"mcpServers\":{}}".to_string(),
        };
        args.extend([
            "--setting-sources".to_string(),
            "project".to_string(),
            "--strict-mcp-config".to_string(),
            "--mcp-config".to_string(),
            mcp_config,
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
    args
}

fn read_current_claude_local_config() -> LocalCliConfigInfo {
    let home = resolve_home_dir();
    read_claude_local_config(home.as_deref())
}

/// Kill a running child registered under `stream_id`. Called on
/// AbortSignal in the frontend. No-op if the id is unknown (e.g. the
/// process already exited).
#[tauri::command]
pub async fn claude_cli_kill(
    state: State<'_, ClaudeCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        let _ = child.start_kill();
        // Don't wait() here — the stdout-drain task already holds a
        // wait future elsewhere when it can. Dropping the handle is
        // enough; kill_on_drop ensures the SIGKILL is sent.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_args_include_partial_messages_so_long_generations_stream_tokens() {
        // Without --include-partial-messages the CLI only emits the complete
        // AssistantMessage after the model finishes thinking + generating, so a
        // long-form draft with heavy reasoning produces no stream-json lines
        // for longer than the transport's first-meaningful-output timeout and
        // gets killed mid-generation. Partial streaming must be on in both
        // isolated and non-isolated modes.
        let isolated = build_claude_cli_args("sonnet", true, None);
        let plain = build_claude_cli_args("sonnet", false, None);
        for (label, args) in [("isolated", &isolated), ("plain", &plain)] {
            assert!(
                args.contains(&"--include-partial-messages".to_string()),
                "{label} args must include --include-partial-messages, got {args:?}"
            );
        }
    }

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
        let args = build_claude_cli_args("sonnet", false, None);

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"sonnet".to_string()));
        assert!(!args.contains(&"--setting-sources".to_string()));
        assert!(!args.contains(&"--strict-mcp-config".to_string()));
        assert!(!args.contains(&"--disable-slash-commands".to_string()));
    }

    #[test]
    fn claude_args_can_isolate_user_config_tools_and_mcp() {
        let args = build_claude_cli_args("sonnet", true, None);

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--setting-sources" && pair[1] == "project"));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--mcp-config" && pair[1] == "{\"mcpServers\":{}}"));
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
        let args = build_claude_cli_args("", false, None);
        assert!(!args.contains(&"--model".to_string()));
    }
}
