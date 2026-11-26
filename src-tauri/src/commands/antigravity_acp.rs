// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

//! Official Google Antigravity Agent Client Protocol (ACP v1) stdio client.
//!
//! Architecture & Google Terms of Service compliance invariants:
//! 1. Launches ONLY the unmodified official `agy` binary with `["acp"]`
//!    (and `--process-per-session` only when attaching a local HTTP MCP server),
//!    as documented at https://antigravity.google/docs/ide/extensions/acp.
//! 2. NEVER passes `--dangerously-skip-permissions` or `--override_user_agent_name`.
//! 3. ALWAYS advertises honest `clientInfo` (`name: "niko-buddy"`,
//!    `version: env!("CARGO_PKG_VERSION")`) — never spoofs Zed, JetBrains, Xcode,
//!    or Android Studio.
//! 4. NEVER reads, extracts, stores, or proxies Google OAuth tokens; authentication
//!    is handled natively by `agy acp` (`authenticate` RPC or existing `agy` keyring).
//! 5. NEVER auto-approves `session/request_permission` — every permission prompt is
//!    forwarded to the user UI and waits for explicit Allow / Deny or Cancel.
//! 6. Owns a Windows JobObject (`ProcessTree`) and shuts down cleanly on
//!    `RunEvent::Exit`, leaving zero orphan child processes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use super::antigravity_cli::find_agy_command;
use super::cli_resolver::child_path_env;
use super::local_cli_config::{apply_local_cli_environment, ensure_cli_workspace_dir};
use super::process_tree::{self, ProcessTree};
use crate::mcp_server::{LocalMcpBinding, McpServerHandle};

const INITIALIZE_TIMEOUT_SECS: u64 = 20;
const AUTHENTICATE_TIMEOUT_SECS: u64 = 180;
const SESSION_OP_TIMEOUT_SECS: u64 = 30;
const PROMPT_TIMEOUT_SECS: u64 = 600;
const MAX_ACP_STDOUT_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_OVERSIZED_LINE_PREVIEW_BYTES: usize = 512;
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;
const STDERR_RING_CAPACITY: usize = 30;
const MAX_PROMPT_TEXT_BYTES: usize = 200_000;
const MAX_CONTEXT_TEXT_BYTES: usize = 200_000;
const MAX_CONTEXT_TITLE_CHARS: usize = 256;
const MAX_PERMISSION_LOCATIONS: usize = 32;
const MAX_RAW_INPUT_SUMMARY_CHARS: usize = 600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethod {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPendingPermission {
    pub request_id: String,
    pub session_id: String,
    pub title: String,
    pub options: Vec<AcpPermissionOption>,
    #[serde(default)]
    pub tool_kind: Option<String>,
    #[serde(default)]
    pub locations: Vec<String>,
    #[serde(default)]
    pub raw_input_summary: Option<String>,
    #[serde(default)]
    pub raw_params: Value,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AcpStatusSnapshot {
    pub connected: bool,
    pub binary_path: Option<String>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub protocol_version: Option<u64>,
    pub auth_methods: Vec<AcpAuthMethod>,
    pub active_session_id: Option<String>,
    pub cwd: Option<String>,
    pub config_options: Vec<Value>,
    pub pending_permissions: Vec<AcpPendingPermission>,
    pub http_mcp_enabled: bool,
    pub attached_local_mcp: bool,
    pub local_mcp_scope: Option<String>,
    pub in_flight_prompt: bool,
    #[serde(rename = "supportsHttpMcp", skip_serializing_if = "Option::is_none")]
    pub supports_http_mcp: Option<bool>,
    #[serde(
        rename = "supportsLoadSession",
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_load_session: Option<bool>,
    #[serde(rename = "localMcpStale")]
    pub local_mcp_stale: bool,
    #[serde(rename = "localMcpStaleReason")]
    pub local_mcp_stale_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionResult {
    pub session_id: String,
    pub cwd: String,
    pub config_options: Vec<Value>,
    pub attached_local_mcp: bool,
    pub local_mcp_scope: Option<String>,
    pub local_mcp_skip_reason: Option<String>,
    pub raw_result: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResult {
    pub stop_reason: Option<String>,
    pub usage: Option<Value>,
    pub raw_result: Value,
}

struct PendingPermissionEntry {
    rpc_id: Value,
    info: AcpPendingPermission,
}

type PendingRpcMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, AcpRpcError>>>>>;
type PendingPermissionMap = Arc<Mutex<HashMap<String, PendingPermissionEntry>>>;
type StderrRing = Arc<Mutex<VecDeque<String>>>;

struct InFlightPromptGuard {
    flag: Arc<AtomicBool>,
}

impl InFlightPromptGuard {
    fn try_acquire(flag: Arc<AtomicBool>) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self { flag })
            .map_err(|_| {
                "An ACP prompt is already in flight; wait for completion or cancel it first"
                    .to_string()
            })
    }
}

impl Drop for InFlightPromptGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

struct ActiveAcpConnection {
    epoch: u64,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    pending_rpc: PendingRpcMap,
    pending_permissions: PendingPermissionMap,
    binary_path: String,
    agent_name: Option<String>,
    agent_version: Option<String>,
    protocol_version: Option<u64>,
    auth_methods: Vec<AcpAuthMethod>,
    active_session_id: Option<String>,
    cwd: Option<String>,
    config_options: Vec<Value>,
    http_mcp_enabled: bool,
    supports_http_mcp: Option<bool>,
    supports_load_session: Option<bool>,
    attached_local_mcp: bool,
    local_mcp_scope: Option<String>,
    attached_mcp_binding: Option<LocalMcpBinding>,
    in_flight_prompt: Arc<AtomicBool>,
    stderr_ring: StderrRing,
}

#[derive(Debug, Clone)]
pub struct AcpRpcError {
    pub code: i64,
    pub message: String,
}

impl AcpRpcError {
    fn into_string(self) -> String {
        format!("[ACP {}] {}", self.code, self.message)
    }
}

/// Shared managed state holding at most one active interactive `agy acp` session.
#[derive(Default)]
pub struct AntigravityAcpState {
    conn: Arc<Mutex<Option<ActiveAcpConnection>>>,
    /// Monotonically increasing connection generation to fence concurrent connect/disconnect races.
    conn_epoch: Arc<AtomicU64>,
    /// Synchronous mirror of the active `(epoch, ProcessTree)` handle so `RunEvent::Exit`
    /// can terminate the process tree deterministically without blocking on Tokio.
    exit_guard: Arc<std::sync::Mutex<Option<(u64, ProcessTree)>>>,
}

impl AntigravityAcpState {
    /// Synchronously terminate any running `agy acp` process tree on app exit.
    pub fn stop_sync(&self) {
        self.conn_epoch.fetch_add(1, Ordering::AcqRel);
        clear_exit_guard(&self.exit_guard);
        if let Ok(mut guard) = self.conn.try_lock() {
            if let Some(mut active) = guard.take() {
                let _ = active.child.start_kill();
            }
        }
    }
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

/// Build arguments for official `agy acp`.
/// Strictly omits `--dangerously-skip-permissions` and `--override_user_agent_name`.
pub(crate) fn build_acp_args(enable_http_mcp: bool) -> Vec<String> {
    let mut args = vec!["acp".to_string()];
    if enable_http_mcp {
        // Per https://antigravity.google/docs/ide/extensions/acp#flags:
        // `--process-per-session` is required when the editor configures HTTP MCP servers.
        args.push("--process-per-session".to_string());
    }
    args
}

/// Build the official ACP v1 `initialize` request payload with honest `clientInfo`.
pub(crate) fn build_initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientInfo": {
            "name": "niko-buddy",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "clientCapabilities": {}
    })
}

/// Build the ACP v1 `session/request_permission` client response payload.
pub(crate) fn build_permission_response_result(option_id: Option<&str>) -> Value {
    match option_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => json!({
            "outcome": {
                "outcome": "selected",
                "optionId": id,
            }
        }),
        None => json!({
            "outcome": {
                "outcome": "cancelled",
            }
        }),
    }
}

/// Ensure `127.0.0.1`, `localhost`, and `::1` are all present in `NO_PROXY` / `no_proxy`
/// without duplicates so loopback MCP requests never get hijacked by a system HTTP proxy.
pub(crate) fn merge_loopback_no_proxy(existing: Option<&str>) -> String {
    let mut entries: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(raw) = existing {
        for part in raw.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let key = trimmed.to_ascii_lowercase();
            if seen.insert(key) {
                entries.push(trimmed.to_string());
            }
        }
    }

    for required in ["127.0.0.1", "localhost", "::1"] {
        if seen.insert(required.to_string()) {
            entries.push(required.to_string());
        }
    }

    entries.join(",")
}

/// Fail-closed spawn CWD resolver: only accepts an existing absolute directory,
/// otherwise falls back to the dedicated app-owned CLI workspace directory.
fn resolve_spawn_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    if let Some(trimmed) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let path = Path::new(trimmed);
        if path.is_absolute() && path.is_dir() {
            return Ok(path.to_path_buf());
        }
    }
    ensure_cli_workspace_dir()
}

/// Redact case-insensitive `Bearer <token>` values to `Bearer [REDACTED]` while preserving
/// surrounding punctuation and JSON delimiters. Idempotent on already-redacted text.
pub(crate) fn redact_bearer_tokens(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        if i + 6 <= len && bytes[i..i + 6].eq_ignore_ascii_case(b"bearer") {
            let prev_ok = i == 0 || {
                let prev = bytes[i - 1];
                !(prev.is_ascii_alphanumeric() || prev == b'_')
            };
            if prev_ok {
                let mut ws_end = i + 6;
                while ws_end < len && matches!(bytes[ws_end], b' ' | b'\t') {
                    ws_end += 1;
                }
                if ws_end > i + 6 && ws_end < len {
                    if input[ws_end..].starts_with("[REDACTED]") {
                        out.push_str("Bearer [REDACTED]");
                        i = ws_end + "[REDACTED]".len();
                        continue;
                    }
                    let rest = &input[ws_end..];
                    let mut tok_len = 0;
                    for ch in rest.chars() {
                        if ch.is_whitespace()
                            || ch.is_control()
                            || matches!(
                                ch,
                                '"' | '\'' | '`' | ',' | ';' | '}' | ']' | ')' | '>' | '<' | '\\'
                            )
                        {
                            break;
                        }
                        tok_len += ch.len_utf8();
                    }
                    if tok_len > 0 {
                        out.push_str("Bearer [REDACTED]");
                        i = ws_end + tok_len;
                        continue;
                    }
                }
            }
        }

        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

/// Redact `Authorization: Basic <token>` / `authorization=Basic <token>` patterns (case-insensitive, idempotent).
fn redact_basic_auth_tokens(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        if i + 13 <= len && bytes[i..i + 13].eq_ignore_ascii_case(b"authorization") {
            let prev_ok = i == 0 || {
                let prev = bytes[i - 1];
                !(prev.is_ascii_alphanumeric() || prev == b'_')
            };
            if prev_ok {
                let mut p = i + 13;
                while p < len && matches!(bytes[p], b' ' | b'\t') {
                    p += 1;
                }
                if p < len && matches!(bytes[p], b':' | b'=') {
                    p += 1;
                    while p < len && matches!(bytes[p], b' ' | b'\t' | b'"' | b'\'') {
                        p += 1;
                    }
                    if p + 5 <= len && bytes[p..p + 5].eq_ignore_ascii_case(b"basic") {
                        let mut ws_end = p + 5;
                        while ws_end < len && matches!(bytes[ws_end], b' ' | b'\t') {
                            ws_end += 1;
                        }
                        if ws_end > p + 5 && ws_end < len {
                            if input[ws_end..].starts_with("[REDACTED]") {
                                out.push_str(&input[i..p]);
                                out.push_str("Basic [REDACTED]");
                                i = ws_end + "[REDACTED]".len();
                                continue;
                            }
                            let rest = &input[ws_end..];
                            let mut tok_len = 0;
                            for ch in rest.chars() {
                                if ch.is_whitespace()
                                    || ch.is_control()
                                    || matches!(
                                        ch,
                                        '"' | '\''
                                            | '`'
                                            | ','
                                            | ';'
                                            | '}'
                                            | ']'
                                            | ')'
                                            | '>'
                                            | '<'
                                            | '\\'
                                    )
                                {
                                    break;
                                }
                                tok_len += ch.len_utf8();
                            }
                            if tok_len > 0 {
                                out.push_str(&input[i..p]);
                                out.push_str("Basic [REDACTED]");
                                i = ws_end + tok_len;
                                continue;
                            }
                        }
                    }
                }
            }
        }

        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

/// Redact sensitive credential patterns (`Bearer <token>` and `Authorization: Basic <token>`).
pub(crate) fn redact_sensitive_text(input: &str) -> String {
    let bearer_redacted = redact_bearer_tokens(input);
    redact_basic_auth_tokens(&bearer_redacted)
}

/// UTF-8 char-safe truncation guaranteed to return `<= max_chars` Unicode scalar values.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    if max_chars <= 3 {
        return s.chars().take(max_chars).collect();
    }
    let mut out: String = s.chars().take(max_chars - 3).collect();
    out.push_str("...");
    out
}

#[derive(Debug, PartialEq, Eq)]
enum BoundedLineOutcome {
    Line(String),
    Oversized { bytes: usize, preview: String },
    Eof,
}

fn append_preview_bytes(preview: &mut Vec<u8>, src: &[u8]) {
    if preview.len() >= MAX_OVERSIZED_LINE_PREVIEW_BYTES {
        return;
    }
    let remaining = MAX_OVERSIZED_LINE_PREVIEW_BYTES - preview.len();
    preview.extend_from_slice(&src[..src.len().min(remaining)]);
}

/// Read one `\n`-delimited ACP stdout frame with a hard memory ceiling (`max_bytes`).
///
/// - Never uses unbounded `read_line` / `.lines()`.
/// - Decodes with `String::from_utf8_lossy` so malformed UTF-8 never crashes the demux loop.
/// - On lines exceeding `max_bytes`, drops the full buffer immediately and keeps draining until
///   `\n` or EOF so the next JSON-RPC line remains cleanly framed.
async fn read_bounded_stdout_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> std::io::Result<BoundedLineOutcome> {
    let mut buf: Vec<u8> = Vec::new();
    let mut preview_buf: Vec<u8> = Vec::new();
    let mut total_bytes: usize = 0;
    let mut oversized = false;
    let mut saw_any_byte = false;

    loop {
        let available = match reader.fill_buf().await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            if !saw_any_byte {
                return Ok(BoundedLineOutcome::Eof);
            }
            break;
        }
        saw_any_byte = true;

        if let Some(newline_pos) = available.iter().position(|&b| b == b'\n') {
            let mut line_chunk = &available[..newline_pos];
            if line_chunk.ends_with(b"\r") {
                line_chunk = &line_chunk[..line_chunk.len() - 1];
            } else if newline_pos == 0 && !oversized && buf.last() == Some(&b'\r') {
                buf.pop();
                total_bytes = total_bytes.saturating_sub(1);
            }

            if !oversized {
                if buf.len().saturating_add(line_chunk.len()) <= max_bytes {
                    buf.extend_from_slice(line_chunk);
                    total_bytes = total_bytes.saturating_add(line_chunk.len());
                } else {
                    append_preview_bytes(&mut preview_buf, &buf);
                    append_preview_bytes(&mut preview_buf, line_chunk);
                    buf = Vec::new();
                    oversized = true;
                    total_bytes = total_bytes.saturating_add(line_chunk.len());
                }
            } else {
                append_preview_bytes(&mut preview_buf, line_chunk);
                total_bytes = total_bytes.saturating_add(line_chunk.len());
            }

            reader.consume(newline_pos + 1);
            break;
        }

        let chunk_len = available.len();
        if !oversized {
            if buf.len().saturating_add(chunk_len) <= max_bytes {
                buf.extend_from_slice(available);
                total_bytes = total_bytes.saturating_add(chunk_len);
            } else {
                append_preview_bytes(&mut preview_buf, &buf);
                append_preview_bytes(&mut preview_buf, available);
                buf = Vec::new();
                oversized = true;
                total_bytes = total_bytes.saturating_add(chunk_len);
            }
        } else {
            append_preview_bytes(&mut preview_buf, available);
            total_bytes = total_bytes.saturating_add(chunk_len);
        }
        reader.consume(chunk_len);
    }

    if oversized {
        let preview = truncate_chars(&String::from_utf8_lossy(&preview_buf), 256);
        Ok(BoundedLineOutcome::Oversized {
            bytes: total_bytes,
            preview,
        })
    } else {
        Ok(BoundedLineOutcome::Line(
            String::from_utf8_lossy(&buf).into_owned(),
        ))
    }
}

/// Read a single `\n`-delimited line keeping at most `max_bytes` in memory.
/// Overflow bytes are drained until `\n` or EOF and `" ...[truncated]"` is appended.
async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> std::io::Result<Option<String>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut saw_any_byte = false;

    loop {
        let available = match reader.fill_buf().await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            if !saw_any_byte {
                return Ok(None);
            }
            break;
        }
        saw_any_byte = true;

        if let Some(newline_pos) = available.iter().position(|&b| b == b'\n') {
            let mut line_chunk = &available[..newline_pos];
            if line_chunk.ends_with(b"\r") {
                line_chunk = &line_chunk[..line_chunk.len() - 1];
            } else if newline_pos == 0 && !truncated && buf.last() == Some(&b'\r') {
                buf.pop();
            }
            if !truncated {
                let remaining = max_bytes.saturating_sub(buf.len());
                if line_chunk.len() <= remaining {
                    buf.extend_from_slice(line_chunk);
                } else {
                    buf.extend_from_slice(&line_chunk[..remaining]);
                    truncated = true;
                }
            }
            reader.consume(newline_pos + 1);
            break;
        }

        let chunk_len = available.len();
        if !truncated {
            let remaining = max_bytes.saturating_sub(buf.len());
            if chunk_len <= remaining {
                buf.extend_from_slice(available);
            } else {
                buf.extend_from_slice(&available[..remaining]);
                truncated = true;
            }
        }
        reader.consume(chunk_len);
    }

    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        text.push_str(" ...[truncated]");
    }
    Ok(Some(text))
}

async fn append_stderr_tail(base_err: String, stderr_ring: &StderrRing) -> String {
    let tail_lines: Vec<String> = {
        let ring = stderr_ring.lock().await;
        if ring.is_empty() {
            return base_err;
        }
        let skip = ring.len().saturating_sub(8);
        ring.iter().skip(skip).cloned().collect()
    };
    format!("{base_err}\n[agy stderr]:\n{}", tail_lines.join("\n"))
}

/// Sanitize `context_title`: replace `\r`, `\n`, and other control chars, collapse whitespace,
/// and cap at [`MAX_CONTEXT_TITLE_CHARS`] chars.
pub(crate) fn sanitize_context_title(raw: Option<&str>) -> String {
    let Some(title) = raw else {
        return "Current editor document".to_string();
    };
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c == '\r' || c == '\n' || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(MAX_CONTEXT_TITLE_CHARS).collect();
    let trimmed = capped.trim();
    if trimmed.is_empty() {
        "Current editor document".to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_sensitive_header_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "authorization" | "proxy-authorization" | "x-api-key"
    )
}

fn is_sensitive_json_key(key: &str) -> bool {
    let lower = key.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "authorization"
            | "proxy-authorization"
            | "token"
            | "access_token"
            | "accesstoken"
            | "refresh_token"
            | "refreshtoken"
            | "id_token"
            | "idtoken"
            | "client_secret"
            | "clientsecret"
            | "api_key"
            | "apikey"
            | "x-api-key"
            | "secret"
    )
}

fn redact_secret_field_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return raw.to_string();
    }
    if trimmed
        .as_bytes()
        .get(..7)
        .is_some_and(|b| b.eq_ignore_ascii_case(b"bearer "))
    {
        return "Bearer [REDACTED]".to_string();
    }
    if trimmed
        .as_bytes()
        .get(..6)
        .is_some_and(|b| b.eq_ignore_ascii_case(b"basic "))
    {
        return "Basic [REDACTED]".to_string();
    }
    "[REDACTED]".to_string()
}

/// Recursively strip `mcpServers` / `mcp_servers` and redact Bearer/Authorization/secret fields
/// before surfacing RPC payloads or tool updates to the WebView.
pub(crate) fn sanitize_rpc_payload(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let header_entry_sensitive = map
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(is_sensitive_header_name);
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                if k == "mcpServers" || k == "mcp_servers" {
                    continue;
                }
                if header_entry_sensitive && k == "value" {
                    match v {
                        Value::String(s) => {
                            out.insert(k, Value::String(redact_secret_field_value(&s)));
                        }
                        other => {
                            out.insert(k, sanitize_rpc_payload(other));
                        }
                    }
                    continue;
                }
                if is_sensitive_json_key(&k) {
                    match v {
                        Value::String(s) => {
                            out.insert(k, Value::String(redact_secret_field_value(&s)));
                        }
                        other => {
                            out.insert(k, sanitize_rpc_payload(other));
                        }
                    }
                    continue;
                }
                out.insert(k, sanitize_rpc_payload(v));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(sanitize_rpc_payload).collect()),
        Value::String(s) => Value::String(redact_sensitive_text(&s)),
        other => other,
    }
}

/// Recursively strip `mcpServers` / `mcp_servers` and redact Bearer tokens before
/// surfacing `session/new` raw results to the WebView.
pub(crate) fn sanitize_session_raw_result(value: Value) -> Value {
    sanitize_rpc_payload(value)
}

/// Targeted redaction for `session/update` notifications:
/// - Redacts Bearer / Authorization / secret payloads inside `tool_call`, `tool_call_update`,
///   and `config_option_update` (or any update carrying `configOptions`).
/// - Leaves `agent_message_chunk` and `agent_thought_chunk` literary prose completely unmodified.
pub(crate) fn sanitize_session_update_params(mut params: Value) -> Value {
    let should_sanitize = params.get("update").is_some_and(|u| {
        let kind = u
            .get("sessionUpdate")
            .or_else(|| u.get("session_update"))
            .or_else(|| u.get("type"))
            .and_then(Value::as_str);
        matches!(
            kind,
            Some("tool_call" | "tool_call_update" | "config_option_update")
        ) || u.get("configOptions").is_some()
    });

    if !should_sanitize {
        return params;
    }

    if let Some(update) = params.get_mut("update") {
        let taken = std::mem::take(update);
        *update = sanitize_rpc_payload(taken);
    }
    params
}

/// Check whether an incoming `config_option_update` session id matches the active session.
/// An update carrying an explicit `sessionId` MUST NOT match when active session is `None`.
pub(crate) fn config_update_session_matches(
    event_session_id: Option<&str>,
    active_session_id: Option<&str>,
) -> bool {
    match (event_session_id, active_session_id) {
        (Some(es), Some(asid)) => es == asid,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ParsedAgentCapabilities {
    pub supports_http_mcp: Option<bool>,
    pub supports_load_session: Option<bool>,
}

/// Parse `agentCapabilities` / `agent_capabilities` from ACP `initialize` result.
///
/// Guardrail G-A3:
/// - When `agentCapabilities` / `agent_capabilities` object is present, return
///   `Some(http == Some(true))` and `Some(load_session == Some(true))`.
/// - When `agentCapabilities` is completely absent (minimal legacy/mock fixture), leave both `None`.
pub(crate) fn parse_agent_capabilities(init_res: &Value) -> ParsedAgentCapabilities {
    let Some(caps) = init_res
        .get("agentCapabilities")
        .or_else(|| init_res.get("agent_capabilities"))
        .and_then(Value::as_object)
    else {
        return ParsedAgentCapabilities {
            supports_http_mcp: None,
            supports_load_session: None,
        };
    };

    let http = caps
        .get("mcpCapabilities")
        .or_else(|| caps.get("mcp_capabilities"))
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("http"))
        .and_then(Value::as_bool);
    let load_session = caps
        .get("loadSession")
        .or_else(|| caps.get("load_session"))
        .and_then(Value::as_bool);

    ParsedAgentCapabilities {
        supports_http_mcp: Some(http == Some(true)),
        supports_load_session: Some(load_session == Some(true)),
    }
}

/// Pure staleness detector comparing the MCP server binding attached at `session/new` time
/// against the currently running MCP server binding.
///
/// Guardrail G-A3 exact priority order:
/// 1. `attached == None` -> `(false, None)`
/// 2. `current == None` -> `(true, Some("mcp_server_stopped"))`
/// 3. `c.port != a.port` -> `(true, Some("port_changed"))`
/// 4. `c.token_fingerprint != a.token_fingerprint` -> `(true, Some("token_rotated"))`
/// 5. `c.scope != a.scope` -> `(true, Some("scope_changed"))`
/// 6. `c.generation != a.generation` -> `(true, Some("server_restarted"))`
/// 7. otherwise -> `(false, None)`
pub(crate) fn compute_local_mcp_staleness(
    attached: Option<&LocalMcpBinding>,
    current: Option<&LocalMcpBinding>,
) -> (bool, Option<&'static str>) {
    let Some(a) = attached else {
        return (false, None);
    };
    let Some(c) = current else {
        return (true, Some("mcp_server_stopped"));
    };
    if c.port != a.port {
        return (true, Some("port_changed"));
    }
    if c.token_fingerprint != a.token_fingerprint {
        return (true, Some("token_rotated"));
    }
    if c.scope != a.scope {
        return (true, Some("scope_changed"));
    }
    if c.generation != a.generation {
        return (true, Some("server_restarted"));
    }
    (false, None)
}

pub(crate) fn parse_prompt_result(raw_result: Value) -> AcpPromptResult {
    let sanitized = sanitize_session_raw_result(raw_result);
    let stop_reason = sanitized
        .get("stopReason")
        .or_else(|| sanitized.get("stop_reason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let usage = sanitized.get("usage").filter(|v| !v.is_null()).cloned();
    AcpPromptResult {
        stop_reason,
        usage,
        raw_result: sanitized,
    }
}

pub(crate) struct LocalMcpAttachmentPlan {
    pub mcp_servers: Vec<Value>,
    pub attached_local_mcp: bool,
    pub local_mcp_scope: Option<String>,
    pub local_mcp_skip_reason: Option<String>,
    pub attached_mcp_binding: Option<LocalMcpBinding>,
}

pub(crate) fn plan_local_mcp_attachment(
    attach_local_mcp: Option<bool>,
    http_mcp_enabled: bool,
    supports_http_mcp: Option<bool>,
    running_info: Option<(u16, String, LocalMcpBinding)>,
) -> LocalMcpAttachmentPlan {
    if attach_local_mcp != Some(true) {
        return LocalMcpAttachmentPlan {
            mcp_servers: Vec::new(),
            attached_local_mcp: false,
            local_mcp_scope: None,
            local_mcp_skip_reason: None,
            attached_mcp_binding: None,
        };
    }
    if !http_mcp_enabled {
        return LocalMcpAttachmentPlan {
            mcp_servers: Vec::new(),
            attached_local_mcp: false,
            local_mcp_scope: None,
            local_mcp_skip_reason: Some("http_mcp_disabled".to_string()),
            attached_mcp_binding: None,
        };
    }
    if supports_http_mcp == Some(false) {
        return LocalMcpAttachmentPlan {
            mcp_servers: Vec::new(),
            attached_local_mcp: false,
            local_mcp_scope: None,
            local_mcp_skip_reason: Some("agent_unsupported".to_string()),
            attached_mcp_binding: None,
        };
    }
    match running_info {
        Some((port, token, binding)) => {
            let scope = binding.scope;
            LocalMcpAttachmentPlan {
                mcp_servers: vec![json!({
                    "type": "http",
                    "name": "niko-buddy",
                    "url": format!("http://127.0.0.1:{port}/mcp"),
                    "headers": [
                        { "name": "Authorization", "value": format!("Bearer {token}") }
                    ]
                })],
                attached_local_mcp: true,
                local_mcp_scope: Some(scope.as_str().to_string()),
                local_mcp_skip_reason: None,
                attached_mcp_binding: Some(binding),
            }
        }
        None => LocalMcpAttachmentPlan {
            mcp_servers: Vec::new(),
            attached_local_mcp: false,
            local_mcp_scope: None,
            local_mcp_skip_reason: Some("mcp_server_not_running".to_string()),
            attached_mcp_binding: None,
        },
    }
}

fn validate_prompt_inputs(
    session_id: &str,
    text: &str,
    context_text: Option<&str>,
) -> Result<(String, String), String> {
    if text.len() > MAX_PROMPT_TEXT_BYTES {
        return Err(format!(
            "Prompt text exceeds maximum size of {MAX_PROMPT_TEXT_BYTES} bytes"
        ));
    }
    let prompt_text = text.trim().to_string();
    if prompt_text.is_empty() {
        return Err("Prompt text cannot be empty".to_string());
    }
    if let Some(ctx) = context_text {
        if ctx.len() > MAX_CONTEXT_TEXT_BYTES {
            return Err(format!(
                "Attached context exceeds maximum size of {MAX_CONTEXT_TEXT_BYTES} bytes"
            ));
        }
    }
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("ACP sessionId cannot be empty".to_string());
    }
    Ok((sid, prompt_text))
}

async fn rollback_permission_if_epoch(
    conn_epoch: &AtomicU64,
    pending_perms: &PendingPermissionMap,
    my_epoch: u64,
    req_key: String,
    entry: PendingPermissionEntry,
) {
    if conn_epoch.load(Ordering::Acquire) == my_epoch {
        pending_perms.lock().await.insert(req_key, entry);
    }
}

/// Parse incoming `session/request_permission` params into a normalized UI struct.
pub(crate) fn parse_permission_request(request_id: String, params: &Value) -> AcpPendingPermission {
    // Sanitize FIRST so title, raw_input_summary, and raw_params all derive from the redacted view
    // and secrets (Basic auth, accessToken, x-api-key, secret, mcpServers) can never leak.
    let sanitized = sanitize_session_raw_result(params.clone());
    let session_id = sanitized
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_call = sanitized.get("toolCall");
    let title = redact_sensitive_text(
        sanitized
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| {
                tool_call
                    .and_then(|tc| tc.get("title"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("Antigravity requests permission"),
    );

    let tool_kind = tool_call
        .and_then(|tc| tc.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    let mut locations = Vec::new();
    let raw_locations = tool_call
        .and_then(|tc| tc.get("locations"))
        .and_then(Value::as_array)
        .filter(|arr| !arr.is_empty())
        .or_else(|| sanitized.get("locations").and_then(Value::as_array));
    if let Some(arr) = raw_locations {
        for loc in arr {
            if locations.len() >= MAX_PERMISSION_LOCATIONS {
                break;
            }
            match loc {
                Value::String(s) => {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        locations.push(trimmed.to_string());
                    }
                }
                Value::Object(obj) => {
                    if let Some(path) = obj
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        let line = obj.get("line").and_then(|v| {
                            v.as_u64()
                                .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
                        });
                        match line {
                            Some(line_no) => locations.push(format!("{path}:{line_no}")),
                            None => locations.push(path.to_string()),
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let raw_input_summary = tool_call
        .and_then(|tc| tc.get("rawInput"))
        .filter(|v| !v.is_null())
        .and_then(|v| {
            let serialized = match v {
                Value::String(s) => s.clone(),
                other => serde_json::to_string(other).ok()?,
            };
            if serialized.trim().is_empty() {
                return None;
            }
            let redacted = redact_sensitive_text(&serialized);
            Some(truncate_chars(&redacted, MAX_RAW_INPUT_SUMMARY_CHARS))
        });

    let mut options = Vec::new();
    if let Some(arr) = sanitized.get("options").and_then(Value::as_array) {
        for opt in arr {
            let opt_id = opt
                .get("optionId")
                .or_else(|| opt.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(option_id) = opt_id {
                let name = opt
                    .get("name")
                    .or_else(|| opt.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or(option_id)
                    .to_string();
                let kind = opt.get("kind").and_then(Value::as_str).map(String::from);
                options.push(AcpPermissionOption {
                    option_id: option_id.to_string(),
                    name,
                    kind,
                });
            }
        }
    }

    AcpPendingPermission {
        request_id,
        session_id,
        title,
        options,
        tool_kind,
        locations,
        raw_input_summary,
        raw_params: sanitized,
    }
}

fn rpc_id_key(id: &Value) -> String {
    match id {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

async fn write_jsonrpc_line_to<W: AsyncWrite + Unpin>(
    writer: &Arc<Mutex<W>>,
    payload: &Value,
) -> Result<(), String> {
    let mut line = serde_json::to_string(payload)
        .map_err(|e| format!("Failed to serialize ACP JSON-RPC payload: {e}"))?;
    line.push('\n');
    let mut guard = writer.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to agy acp stdin: {e}"))?;
    guard
        .flush()
        .await
        .map_err(|e| format!("Failed to flush agy acp stdin: {e}"))?;
    Ok(())
}

async fn write_jsonrpc_line(stdin: &Arc<Mutex<ChildStdin>>, payload: &Value) -> Result<(), String> {
    write_jsonrpc_line_to(stdin, payload).await
}

/// Drain all pending permission requests and send JSON-RPC cancelled responses to `writer`.
/// Returns drained request IDs so callers can emit `permission_resolved` to the WebView.
async fn drain_pending_permissions<W: AsyncWrite + Unpin>(
    pending_permissions: &PendingPermissionMap,
    writer: &Arc<Mutex<W>>,
) -> Vec<String> {
    let drained: Vec<(String, PendingPermissionEntry)> =
        pending_permissions.lock().await.drain().collect();
    let mut drained_ids = Vec::with_capacity(drained.len());
    for (req_key, entry) in drained {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": entry.rpc_id,
            "result": build_permission_response_result(None),
        });
        let _ = write_jsonrpc_line_to(writer, &reply).await;
        drained_ids.push(req_key);
    }
    drained_ids
}

/// Drain any stale pending permission requests whose `session_id` does not match `keep_session_id`.
async fn drain_stale_session_permissions<W: AsyncWrite + Unpin>(
    pending_permissions: &PendingPermissionMap,
    writer: &Arc<Mutex<W>>,
    keep_session_id: &str,
) -> Vec<String> {
    let drained: Vec<(String, PendingPermissionEntry)> = {
        let mut map = pending_permissions.lock().await;
        let stale_keys: Vec<String> = map
            .iter()
            .filter(|(_, entry)| entry.info.session_id != keep_session_id)
            .map(|(k, _)| k.clone())
            .collect();
        stale_keys
            .into_iter()
            .filter_map(|k| map.remove(&k).map(|e| (k, e)))
            .collect()
    };
    let mut drained_ids = Vec::with_capacity(drained.len());
    for (req_key, entry) in drained {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": entry.rpc_id,
            "result": build_permission_response_result(None),
        });
        let _ = write_jsonrpc_line_to(writer, &reply).await;
        drained_ids.push(req_key);
    }
    drained_ids
}

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Sink abstraction for the stdout JSON-RPC demultiplexer, enabling deterministic
/// `tokio::io::duplex` async E2E testing without a live Tauri `AppHandle`.
trait DemuxSessionSink: Send + Sync {
    fn is_epoch_active(&self) -> bool;
    fn resolve_rpc_response<'a>(
        &'a self,
        key: String,
        result: Result<Value, AcpRpcError>,
    ) -> BoxFuture<'a, ()>;
    fn write_client_reply<'a>(&'a self, payload: Value) -> BoxFuture<'a, ()>;
    fn insert_pending_permission<'a>(
        &'a self,
        req_key: String,
        entry: PendingPermissionEntry,
    ) -> BoxFuture<'a, ()>;
    fn update_config_options<'a>(
        &'a self,
        evt_sid: Option<String>,
        opts: Vec<Value>,
    ) -> BoxFuture<'a, ()>;
    fn emit_event(&self, payload: Value);
    fn on_loop_exit<'a>(&'a self) -> BoxFuture<'a, ()>;
}

/// Core ACP stdout JSON-RPC demultiplexer loop.
///
/// Safety properties:
/// - Enforces a top-of-loop (and post-read / pre-emit) epoch fence so stale connections exit immediately.
/// - Reads lines with a bounded `fill_buf()`/`consume()` reader capped at `max_line_bytes` (16 MiB in prod).
/// - Emits a redacted `protocol_warning` on oversized lines and stays cleanly framed for subsequent lines.
/// - Applies targeted redaction to `tool_call`/`tool_call_update` payloads while leaving prose untouched.
async fn run_stdout_demux_loop<R, S>(mut reader: R, sink: S, max_line_bytes: usize)
where
    R: AsyncBufRead + Unpin,
    S: DemuxSessionSink,
{
    loop {
        if !sink.is_epoch_active() {
            break;
        }
        let outcome = match read_bounded_stdout_line(&mut reader, max_line_bytes).await {
            Ok(o) => o,
            Err(e) => {
                log::debug!("[antigravity-acp stdout read error] {e}");
                break;
            }
        };
        if !sink.is_epoch_active() {
            break;
        }

        let line = match outcome {
            BoundedLineOutcome::Eof => break,
            BoundedLineOutcome::Oversized { bytes, preview } => {
                let redacted_preview = redact_sensitive_text(&preview);
                log::warn!(
                    "[antigravity-acp] dropped oversized stdout line ({bytes} bytes > {max_line_bytes} bytes)"
                );
                sink.emit_event(json!({
                    "kind": "protocol_warning",
                    "code": "oversized_stdout_line",
                    "bytes": bytes,
                    "limitBytes": max_line_bytes,
                    "preview": redacted_preview,
                    "message": format!(
                        "Dropped oversized ACP stdout line ({bytes} bytes exceeds {max_line_bytes}-byte limit)"
                    ),
                }));
                continue;
            }
            BoundedLineOutcome::Line(l) => l,
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            let redacted_preview = truncate_chars(&redact_sensitive_text(trimmed), 512);
            log::debug!("[antigravity-acp non-json stdout] {redacted_preview}");
            continue;
        };

        let has_method = msg.get("method").and_then(Value::as_str).is_some();
        let id_opt = msg.get("id").filter(|v| !v.is_null()).cloned();

        if !has_method {
            // Incoming JSON-RPC response to a client request.
            if let Some(id_val) = id_opt {
                let key = rpc_id_key(&id_val);
                if let Some(rpc_err) = extract_rpc_error(&msg) {
                    sink.resolve_rpc_response(key, Err(rpc_err)).await;
                } else {
                    let res = msg.get("result").cloned().unwrap_or(Value::Null);
                    sink.resolve_rpc_response(key, Ok(res)).await;
                }
            }
            continue;
        }

        let method = msg
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        if let Some(id_val) = id_opt {
            // Incoming JSON-RPC request from Agent -> Client.
            if method == "session/request_permission" {
                if !sink.is_epoch_active() {
                    let reply = json!({
                        "jsonrpc": "2.0",
                        "id": id_val,
                        "result": build_permission_response_result(None),
                    });
                    sink.write_client_reply(reply).await;
                    break;
                }
                let req_key = rpc_id_key(&id_val);
                let info = parse_permission_request(req_key.clone(), &params);
                sink.insert_pending_permission(
                    req_key,
                    PendingPermissionEntry {
                        rpc_id: id_val,
                        info: info.clone(),
                    },
                )
                .await;
                if sink.is_epoch_active() {
                    sink.emit_event(json!({
                        "kind": "permission_request",
                        "permission": info,
                    }));
                }
            } else {
                // Unsupported client-side method: respond cleanly with JSON-RPC MethodNotFound.
                let err_reply = json!({
                    "jsonrpc": "2.0",
                    "id": id_val,
                    "error": {
                        "code": -32601,
                        "message": format!("Client does not implement `{method}`"),
                    }
                });
                sink.write_client_reply(err_reply).await;
            }
        } else if method == "session/update" {
            if !sink.is_epoch_active() {
                break;
            }
            let sanitized_params = sanitize_session_update_params(params);
            // Sync cached configOptions if the server pushes a `config_option_update`
            // using the already-sanitized payload so secrets never enter cached state.
            if let Some(opts) = sanitized_params
                .get("update")
                .and_then(|u| u.get("configOptions"))
                .and_then(Value::as_array)
            {
                let evt_sid = sanitized_params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from);
                sink.update_config_options(evt_sid, opts.clone()).await;
            }
            if sink.is_epoch_active() {
                sink.emit_event(json!({
                    "kind": "session_update",
                    "params": sanitized_params,
                }));
            }
        }
    }

    sink.on_loop_exit().await;
}

struct ProductionDemuxSink {
    my_epoch: u64,
    conn_epoch: Arc<AtomicU64>,
    pending_rpc: PendingRpcMap,
    pending_permissions: PendingPermissionMap,
    stdin: Arc<Mutex<ChildStdin>>,
    conn: Arc<Mutex<Option<ActiveAcpConnection>>>,
    exit_guard: Arc<std::sync::Mutex<Option<(u64, ProcessTree)>>>,
    app: AppHandle,
}

impl DemuxSessionSink for ProductionDemuxSink {
    fn is_epoch_active(&self) -> bool {
        self.conn_epoch.load(Ordering::Acquire) == self.my_epoch
    }

    fn resolve_rpc_response<'a>(
        &'a self,
        key: String,
        result: Result<Value, AcpRpcError>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Some(tx) = self.pending_rpc.lock().await.remove(&key) {
                let _ = tx.send(result);
            }
        })
    }

    fn write_client_reply<'a>(&'a self, payload: Value) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = write_jsonrpc_line(&self.stdin, &payload).await;
        })
    }

    fn insert_pending_permission<'a>(
        &'a self,
        req_key: String,
        entry: PendingPermissionEntry,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.pending_permissions.lock().await.insert(req_key, entry);
        })
    }

    fn update_config_options<'a>(
        &'a self,
        evt_sid: Option<String>,
        opts: Vec<Value>,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Some(active) = self.conn.lock().await.as_mut() {
                if active.epoch == self.my_epoch
                    && config_update_session_matches(
                        evt_sid.as_deref(),
                        active.active_session_id.as_deref(),
                    )
                {
                    active.config_options = opts;
                }
            }
        })
    }

    fn emit_event(&self, payload: Value) {
        emit_acp_event(&self.app, payload);
    }

    fn on_loop_exit<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // EOF or epoch fence exit: fail any remaining waiters and notify frontend only if still active.
            let waiters: Vec<_> = self.pending_rpc.lock().await.drain().collect();
            for (_, tx) in waiters {
                let _ = tx.send(Err(AcpRpcError {
                    code: -32098,
                    message: "agy acp exited unexpectedly".to_string(),
                }));
            }
            self.pending_permissions.lock().await.clear();
            let mut conn_guard = self.conn.lock().await;
            if self.is_epoch_active()
                && conn_guard
                    .as_ref()
                    .is_some_and(|c| c.epoch == self.my_epoch)
            {
                let _ = conn_guard.take();
                clear_exit_guard_if_epoch(&self.exit_guard, self.my_epoch);
                emit_acp_event(
                    &self.app,
                    json!({ "kind": "disconnected", "reason": "eof" }),
                );
            } else {
                clear_exit_guard_if_epoch(&self.exit_guard, self.my_epoch);
            }
        })
    }
}

async fn send_rpc_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    pending_rpc: &PendingRpcMap,
    id: u64,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, AcpRpcError> {
    let key = id.to_string();
    let (tx, rx) = oneshot::channel();
    pending_rpc.lock().await.insert(key.clone(), tx);

    let req = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    if let Err(err) = write_jsonrpc_line(stdin, &req).await {
        pending_rpc.lock().await.remove(&key);
        return Err(AcpRpcError {
            code: -32099,
            message: err,
        });
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(AcpRpcError {
            code: -32098,
            message: format!("ACP connection closed while awaiting `{method}` response"),
        }),
        Err(_) => {
            pending_rpc.lock().await.remove(&key);
            Err(AcpRpcError {
                code: -32097,
                message: format!("ACP `{method}` timed out after {}s", timeout.as_secs()),
            })
        }
    }
}

fn emit_acp_event(app: &AppHandle, payload: Value) {
    let _ = app.emit("antigravity-acp:event", payload);
}

async fn snapshot_from_conn(
    conn: &Option<ActiveAcpConnection>,
    current_mcp_binding: Option<&LocalMcpBinding>,
) -> AcpStatusSnapshot {
    let Some(c) = conn.as_ref() else {
        return AcpStatusSnapshot::default();
    };
    let pending = c
        .pending_permissions
        .lock()
        .await
        .values()
        .map(|entry| entry.info.clone())
        .collect();
    let (local_mcp_stale, local_mcp_stale_reason) =
        compute_local_mcp_staleness(c.attached_mcp_binding.as_ref(), current_mcp_binding);
    AcpStatusSnapshot {
        connected: true,
        binary_path: Some(c.binary_path.clone()),
        agent_name: c.agent_name.clone(),
        agent_version: c.agent_version.clone(),
        protocol_version: c.protocol_version,
        auth_methods: c.auth_methods.clone(),
        active_session_id: c.active_session_id.clone(),
        cwd: c.cwd.clone(),
        config_options: c.config_options.clone(),
        pending_permissions: pending,
        http_mcp_enabled: c.http_mcp_enabled,
        attached_local_mcp: c.attached_local_mcp,
        local_mcp_scope: c.local_mcp_scope.clone(),
        in_flight_prompt: c.in_flight_prompt.load(Ordering::Acquire),
        supports_http_mcp: c.supports_http_mcp,
        supports_load_session: c.supports_load_session,
        local_mcp_stale,
        local_mcp_stale_reason: local_mcp_stale_reason.map(String::from),
    }
}

fn clear_exit_guard(exit_guard: &std::sync::Mutex<Option<(u64, ProcessTree)>>) {
    match exit_guard.lock() {
        Ok(mut guard) => {
            let _ = guard.take();
        }
        Err(poisoned) => {
            let _ = poisoned.into_inner().take();
        }
    }
}

fn clear_exit_guard_if_epoch(
    exit_guard: &std::sync::Mutex<Option<(u64, ProcessTree)>>,
    expected_epoch: u64,
) {
    match exit_guard.lock() {
        Ok(mut guard) => {
            if guard.as_ref().is_some_and(|(ep, _)| *ep == expected_epoch) {
                let _ = guard.take();
            }
        }
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            if guard.as_ref().is_some_and(|(ep, _)| *ep == expected_epoch) {
                let _ = guard.take();
            }
        }
    }
}

fn extract_rpc_error(msg: &Value) -> Option<AcpRpcError> {
    let err = msg.get("error").filter(|v| !v.is_null())?;
    let code = err.get("code").and_then(Value::as_i64).unwrap_or(-32096);
    let message = redact_sensitive_text(
        err.get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown ACP error"),
    );
    Some(AcpRpcError { code, message })
}

async fn disconnect_inner(state: &AntigravityAcpState, app: Option<&AppHandle>) {
    // Advance epoch first so any concurrent in-flight connect aborts without touching state.
    state.conn_epoch.fetch_add(1, Ordering::AcqRel);
    let active_opt = state.conn.lock().await.take();

    if let Some(mut active) = active_opt {
        // Cancel any pending permission requests gracefully before terminating the tree.
        let _ = drain_pending_permissions(&active.pending_permissions, &active.stdin).await;
        // Fail any in-flight RPC waiters immediately.
        let waiters: Vec<_> = active.pending_rpc.lock().await.drain().collect();
        for (_, tx) in waiters {
            let _ = tx.send(Err(AcpRpcError {
                code: -32098,
                message: "ACP session disconnected".to_string(),
            }));
        }
        clear_exit_guard_if_epoch(&state.exit_guard, active.epoch);
        let _ = active.child.start_kill();
        if let Some(app_handle) = app {
            emit_acp_event(
                app_handle,
                json!({ "kind": "disconnected", "reason": "closed" }),
            );
        }
    } else {
        clear_exit_guard(&state.exit_guard);
    }
}

#[tauri::command]
pub async fn antigravity_acp_status(
    state: State<'_, AntigravityAcpState>,
    mcp_handle: State<'_, McpServerHandle>,
) -> Result<AcpStatusSnapshot, String> {
    let current_binding = mcp_handle.running_binding_fingerprint().await;
    let guard = state.conn.lock().await;
    Ok(snapshot_from_conn(&guard, current_binding.as_ref()).await)
}

#[tauri::command]
pub async fn antigravity_acp_connect(
    app: AppHandle,
    state: State<'_, AntigravityAcpState>,
    cwd: Option<String>,
    enable_http_mcp: Option<bool>,
) -> Result<AcpStatusSnapshot, String> {
    disconnect_inner(&state, None).await;
    let my_epoch = state.conn_epoch.fetch_add(1, Ordering::AcqRel) + 1;

    let bin = find_agy_command().await?;
    let bin_str = bin.to_string_lossy().to_string();
    let http_mcp = enable_http_mcp.unwrap_or(false);
    let args = build_acp_args(http_mcp);
    let effective_cwd = resolve_spawn_cwd(cwd.as_deref())?;
    let effective_cwd_str = effective_cwd.to_string_lossy().to_string();

    let mut cmd = Command::new(&bin);
    suppress_windows_console(&mut cmd);
    let env_info = apply_local_cli_environment(&mut cmd);
    // MUST run AFTER `apply_local_cli_environment` (which otherwise overwrites or clears NO_PROXY).
    if http_mcp {
        let merged_no_proxy = merge_loopback_no_proxy(env_info.no_proxy.as_deref());
        cmd.env("NO_PROXY", &merged_no_proxy);
        cmd.env("no_proxy", &merged_no_proxy);
    }
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.current_dir(&effective_cwd);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start official `agy acp`: {e}"))?;

    let exit_tree = child.id().and_then(process_tree::attach_pid);
    {
        let mut guard = match state.exit_guard.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if state.conn_epoch.load(Ordering::Acquire) != my_epoch {
            drop(exit_tree);
            let _ = child.start_kill();
            return Err("ACP connection superseded or cancelled".to_string());
        }
        *guard = exit_tree.map(|tree| (my_epoch, tree));
    }

    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "Missing stdin handle on agy acp".to_string())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle on agy acp".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle on agy acp".to_string())?;

    let pending_rpc: PendingRpcMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_permissions: PendingPermissionMap = Arc::new(Mutex::new(HashMap::new()));
    let stderr_ring: StderrRing =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_RING_CAPACITY)));

    // Spawn bounded, epoch-fenced, Bearer-redacting stderr reader (diagnostics only).
    let stderr_app = app.clone();
    let stderr_ring_task = Arc::clone(&stderr_ring);
    let stderr_conn_epoch = Arc::clone(&state.conn_epoch);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        while let Ok(Some(line)) = read_bounded_line(&mut reader, MAX_STDERR_LINE_BYTES).await {
            if stderr_conn_epoch.load(Ordering::Acquire) != my_epoch {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let redacted = redact_sensitive_text(trimmed);
                {
                    let mut ring = stderr_ring_task.lock().await;
                    if ring.len() >= STDERR_RING_CAPACITY {
                        ring.pop_front();
                    }
                    ring.push_back(redacted.clone());
                }
                log::debug!("[antigravity-acp stderr] {redacted}");
                emit_acp_event(
                    &stderr_app,
                    json!({ "kind": "stderr", "message": redacted }),
                );
            }
        }
    });

    // Spawn bounded, epoch-fenced stdout JSON-RPC demultiplexer.
    let demux_sink = ProductionDemuxSink {
        my_epoch,
        conn_epoch: Arc::clone(&state.conn_epoch),
        pending_rpc: Arc::clone(&pending_rpc),
        pending_permissions: Arc::clone(&pending_permissions),
        stdin: Arc::clone(&stdin),
        conn: Arc::clone(&state.conn),
        exit_guard: Arc::clone(&state.exit_guard),
        app: app.clone(),
    };
    tokio::spawn(async move {
        run_stdout_demux_loop(
            BufReader::new(stdout),
            demux_sink,
            MAX_ACP_STDOUT_LINE_BYTES,
        )
        .await;
    });

    // Perform official ACP v1 `initialize` handshake.
    let init_res = match send_rpc_request(
        &stdin,
        &pending_rpc,
        1,
        "initialize",
        build_initialize_params(),
        Duration::from_secs(INITIALIZE_TIMEOUT_SECS),
    )
    .await
    {
        Ok(res) => res,
        Err(e) => {
            clear_exit_guard_if_epoch(&state.exit_guard, my_epoch);
            let _ = child.start_kill();
            tokio::task::yield_now().await;
            return Err(redact_sensitive_text(
                &append_stderr_tail(e.into_string(), &stderr_ring).await,
            ));
        }
    };

    let protocol_version = init_res.get("protocolVersion").and_then(Value::as_u64);
    let agent_name = init_res
        .get("agentInfo")
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .map(String::from);
    let agent_version = init_res
        .get("agentInfo")
        .and_then(|v| v.get("version"))
        .and_then(Value::as_str)
        .map(String::from);
    let auth_methods: Vec<AcpAuthMethod> = init_res
        .get("authMethods")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let parsed_caps = parse_agent_capabilities(&init_res);

    let mut guard = state.conn.lock().await;
    if state.conn_epoch.load(Ordering::Acquire) != my_epoch {
        clear_exit_guard_if_epoch(&state.exit_guard, my_epoch);
        let _ = child.start_kill();
        return Err("ACP connection superseded or cancelled".to_string());
    }

    let active = ActiveAcpConnection {
        epoch: my_epoch,
        child,
        stdin,
        next_id: AtomicU64::new(2),
        pending_rpc,
        pending_permissions,
        binary_path: bin_str,
        agent_name,
        agent_version,
        protocol_version,
        auth_methods,
        active_session_id: None,
        cwd: Some(effective_cwd_str),
        config_options: Vec::new(),
        http_mcp_enabled: http_mcp,
        supports_http_mcp: parsed_caps.supports_http_mcp,
        supports_load_session: parsed_caps.supports_load_session,
        attached_local_mcp: false,
        local_mcp_scope: None,
        attached_mcp_binding: None,
        in_flight_prompt: Arc::new(AtomicBool::new(false)),
        stderr_ring,
    };

    *guard = Some(active);
    Ok(snapshot_from_conn(&guard, None).await)
}

#[tauri::command]
pub async fn antigravity_acp_disconnect(
    app: AppHandle,
    state: State<'_, AntigravityAcpState>,
) -> Result<(), String> {
    disconnect_inner(&state, Some(&app)).await;
    Ok(())
}

#[tauri::command]
pub async fn antigravity_acp_authenticate(
    state: State<'_, AntigravityAcpState>,
    method_id: String,
) -> Result<Value, String> {
    let trimmed = method_id.trim().to_string();
    if trimmed.is_empty() {
        return Err("Authentication methodId cannot be empty".to_string());
    }
    let (stdin, pending_rpc, id, stderr_ring) = {
        let guard = state.conn.lock().await;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "Antigravity ACP is not connected".to_string())?;
        (
            Arc::clone(&conn.stdin),
            Arc::clone(&conn.pending_rpc),
            conn.next_id.fetch_add(1, Ordering::Relaxed),
            Arc::clone(&conn.stderr_ring),
        )
    };

    match send_rpc_request(
        &stdin,
        &pending_rpc,
        id,
        "authenticate",
        json!({ "methodId": trimmed }),
        Duration::from_secs(AUTHENTICATE_TIMEOUT_SECS),
    )
    .await
    {
        Ok(res) => Ok(sanitize_rpc_payload(res)),
        Err(e) => Err(redact_sensitive_text(
            &append_stderr_tail(e.into_string(), &stderr_ring).await,
        )),
    }
}

#[tauri::command]
pub async fn antigravity_acp_new_session(
    app: AppHandle,
    state: State<'_, AntigravityAcpState>,
    mcp_handle: State<'_, McpServerHandle>,
    cwd: String,
    attach_local_mcp: Option<bool>,
) -> Result<AcpSessionResult, String> {
    let trimmed_cwd = cwd.trim().to_string();
    let cwd_path = Path::new(&trimmed_cwd);
    if trimmed_cwd.is_empty() || !cwd_path.is_absolute() || !cwd_path.is_dir() {
        return Err(format!(
            "Invalid session workspace directory (must be an existing absolute path): {trimmed_cwd}"
        ));
    }

    let (
        my_epoch,
        stdin,
        pending_rpc,
        pending_permissions,
        id,
        http_mcp_enabled,
        supports_http_mcp,
    ) = {
        let guard = state.conn.lock().await;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "Antigravity ACP is not connected".to_string())?;
        (
            conn.epoch,
            Arc::clone(&conn.stdin),
            Arc::clone(&conn.pending_rpc),
            Arc::clone(&conn.pending_permissions),
            conn.next_id.fetch_add(1, Ordering::Relaxed),
            conn.http_mcp_enabled,
            conn.supports_http_mcp,
        )
    };

    // Drain any orphaned pending permission prompts from a previous session before switching.
    let drained_before = drain_pending_permissions(&pending_permissions, &stdin).await;
    for req_key in drained_before {
        emit_acp_event(
            &app,
            json!({
                "kind": "permission_resolved",
                "requestId": req_key,
                "optionId": Value::Null,
            }),
        );
    }

    let running_info =
        if attach_local_mcp == Some(true) && http_mcp_enabled && supports_http_mcp != Some(false) {
            mcp_handle.running_connection_info_with_binding().await
        } else {
            None
        };
    let plan = plan_local_mcp_attachment(
        attach_local_mcp,
        http_mcp_enabled,
        supports_http_mcp,
        running_info,
    );

    let raw_result = send_rpc_request(
        &stdin,
        &pending_rpc,
        id,
        "session/new",
        json!({
            "cwd": trimmed_cwd,
            "mcpServers": plan.mcp_servers,
        }),
        Duration::from_secs(SESSION_OP_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| redact_sensitive_text(&e.into_string()))?;

    let sanitized_raw_result = sanitize_session_raw_result(raw_result);

    let session_id = sanitized_raw_result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ACP session/new response missing sessionId".to_string())?
        .to_string();

    let config_options = sanitized_raw_result
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    {
        let mut guard = state.conn.lock().await;
        match guard.as_mut() {
            Some(active) if active.epoch == my_epoch => {
                active.active_session_id = Some(session_id.clone());
                active.cwd = Some(trimmed_cwd.clone());
                active.config_options = config_options.clone();
                active.attached_local_mcp = plan.attached_local_mcp;
                active.local_mcp_scope = plan.local_mcp_scope.clone();
                active.attached_mcp_binding = plan.attached_mcp_binding.clone();
            }
            _ => {
                return Err("ACP connection superseded or closed during session/new".to_string());
            }
        }
    }

    // Drain any late permission requests from prior sessions that arrived while `session/new` was in flight.
    let drained_after =
        drain_stale_session_permissions(&pending_permissions, &stdin, &session_id).await;
    for req_key in drained_after {
        emit_acp_event(
            &app,
            json!({
                "kind": "permission_resolved",
                "requestId": req_key,
                "optionId": Value::Null,
            }),
        );
    }

    Ok(AcpSessionResult {
        session_id,
        cwd: trimmed_cwd,
        config_options,
        attached_local_mcp: plan.attached_local_mcp,
        local_mcp_scope: plan.local_mcp_scope,
        local_mcp_skip_reason: plan.local_mcp_skip_reason,
        raw_result: sanitized_raw_result,
    })
}

#[tauri::command]
pub async fn antigravity_acp_prompt(
    state: State<'_, AntigravityAcpState>,
    session_id: String,
    text: String,
    context_title: Option<String>,
    context_text: Option<String>,
) -> Result<AcpPromptResult, String> {
    let (sid, prompt_text) = validate_prompt_inputs(&session_id, &text, context_text.as_deref())?;

    let (stdin, pending_rpc, id, _in_flight_guard) = {
        let guard = state.conn.lock().await;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "Antigravity ACP is not connected".to_string())?;
        if conn.active_session_id.as_deref() != Some(sid.as_str()) {
            return Err(format!("ACP session `{sid}` is not the active session"));
        }
        let prompt_guard = InFlightPromptGuard::try_acquire(Arc::clone(&conn.in_flight_prompt))?;
        (
            Arc::clone(&conn.stdin),
            Arc::clone(&conn.pending_rpc),
            conn.next_id.fetch_add(1, Ordering::Relaxed),
            prompt_guard,
        )
    };

    let mut prompt_blocks: Vec<Value> = Vec::new();
    if let Some(ctx) = context_text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let label = sanitize_context_title(context_title.as_deref());
        prompt_blocks.push(json!({
            "type": "text",
            "text": format!("[Attached context: {label}]\n{ctx}"),
        }));
    }
    prompt_blocks.push(json!({
        "type": "text",
        "text": prompt_text,
    }));

    let raw_result = send_rpc_request(
        &stdin,
        &pending_rpc,
        id,
        "session/prompt",
        json!({
            "sessionId": sid,
            "prompt": prompt_blocks,
        }),
        Duration::from_secs(PROMPT_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| redact_sensitive_text(&e.into_string()))?;

    Ok(parse_prompt_result(raw_result))
}

#[tauri::command]
pub async fn antigravity_acp_cancel(
    app: AppHandle,
    state: State<'_, AntigravityAcpState>,
    session_id: String,
) -> Result<(), String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Ok(());
    }
    let (stdin, pending_perms) = {
        let guard = state.conn.lock().await;
        let Some(conn) = guard.as_ref() else {
            return Ok(());
        };
        (
            Arc::clone(&conn.stdin),
            Arc::clone(&conn.pending_permissions),
        )
    };

    // Cancel any outstanding permission prompts belonging to this session first.
    let to_cancel: Vec<(String, Value)> = {
        let mut map = pending_perms.lock().await;
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, entry)| entry.info.session_id == sid)
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter()
            .filter_map(|k| map.remove(&k).map(|e| (k, e.rpc_id)))
            .collect()
    };
    for (req_key, rpc_id) in to_cancel {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "result": build_permission_response_result(None),
        });
        let _ = write_jsonrpc_line(&stdin, &reply).await;
        emit_acp_event(
            &app,
            json!({
                "kind": "permission_resolved",
                "requestId": req_key,
                "optionId": Value::Null,
            }),
        );
    }

    let notification = json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": sid },
    });
    write_jsonrpc_line(&stdin, &notification).await
}

#[tauri::command]
pub async fn antigravity_acp_set_config_option(
    state: State<'_, AntigravityAcpState>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let trimmed_sid = session_id.trim().to_string();
    let (my_epoch, stdin, pending_rpc, id) = {
        let guard = state.conn.lock().await;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "Antigravity ACP is not connected".to_string())?;
        (
            conn.epoch,
            Arc::clone(&conn.stdin),
            Arc::clone(&conn.pending_rpc),
            conn.next_id.fetch_add(1, Ordering::Relaxed),
        )
    };

    let raw_res = send_rpc_request(
        &stdin,
        &pending_rpc,
        id,
        "session/set_config_option",
        json!({
            "sessionId": trimmed_sid,
            "configId": config_id.trim(),
            "value": value.trim(),
        }),
        Duration::from_secs(SESSION_OP_TIMEOUT_SECS),
    )
    .await
    .map_err(|e| redact_sensitive_text(&e.into_string()))?;

    let res = sanitize_rpc_payload(raw_res);

    if let Some(opts) = res.get("configOptions").and_then(Value::as_array) {
        if let Some(active) = state.conn.lock().await.as_mut() {
            if active.epoch == my_epoch
                && active.active_session_id.as_deref() == Some(trimmed_sid.as_str())
            {
                active.config_options = opts.clone();
            }
        }
    }

    Ok(res)
}

#[tauri::command]
pub async fn antigravity_acp_respond_permission(
    app: AppHandle,
    state: State<'_, AntigravityAcpState>,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let req_key = request_id.trim().to_string();
    let (my_epoch, stdin, pending_perms) = {
        let guard = state.conn.lock().await;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "Antigravity ACP is not connected".to_string())?;
        (
            conn.epoch,
            Arc::clone(&conn.stdin),
            Arc::clone(&conn.pending_permissions),
        )
    };

    let entry = pending_perms
        .lock()
        .await
        .remove(&req_key)
        .ok_or_else(|| format!("No pending ACP permission request with id `{req_key}`"))?;

    let reply = json!({
        "jsonrpc": "2.0",
        "id": entry.rpc_id.clone(),
        "result": build_permission_response_result(option_id.as_deref()),
    });
    if let Err(err) = write_jsonrpc_line(&stdin, &reply).await {
        rollback_permission_if_epoch(&state.conn_epoch, &pending_perms, my_epoch, req_key, entry)
            .await;
        return Err(err);
    }

    emit_acp_event(
        &app,
        json!({
            "kind": "permission_resolved",
            "requestId": req_key,
            "optionId": option_id,
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_acp_args_never_bypasses_permissions_or_spoofs_user_agent() {
        for enable_http in [false, true] {
            let args = build_acp_args(enable_http);
            assert_eq!(args[0], "acp");
            assert!(
                !args
                    .iter()
                    .any(|a| a.contains("dangerously-skip-permissions")
                        || a.contains("override_user_agent_name")
                        || a.contains("--yolo")),
                "ACP args must remain strictly compliant: {args:?}"
            );
        }
        assert_eq!(build_acp_args(false), vec!["acp"]);
        assert_eq!(build_acp_args(true), vec!["acp", "--process-per-session"]);
    }

    #[test]
    fn initialize_params_use_honest_niko_buddy_client_info() {
        let params = build_initialize_params();
        assert_eq!(params["protocolVersion"], 1);
        let name = params["clientInfo"]["name"].as_str().unwrap();
        assert_eq!(name, "niko-buddy");
        for forbidden in ["zed", "jetbrains", "intellij", "xcode", "android"] {
            assert!(
                !name.to_ascii_lowercase().contains(forbidden),
                "clientInfo must never spoof whitelisted IDE `{forbidden}`"
            );
        }
        assert!(!params["clientInfo"]["version"].as_str().unwrap().is_empty());
    }

    #[test]
    fn permission_response_maps_selected_and_cancelled_outcomes() {
        let selected = build_permission_response_result(Some("allow_once"));
        assert_eq!(selected["outcome"]["outcome"], "selected");
        assert_eq!(selected["outcome"]["optionId"], "allow_once");

        let cancelled_none = build_permission_response_result(None);
        assert_eq!(cancelled_none["outcome"]["outcome"], "cancelled");

        let cancelled_blank = build_permission_response_result(Some("   "));
        assert_eq!(cancelled_blank["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn parse_permission_request_extracts_title_and_options() {
        let params = json!({
            "sessionId": "sess-1",
            "title": "Edit chapter-01.md",
            "options": [
                { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }
            ]
        });
        let parsed = parse_permission_request("42".to_string(), &params);
        assert_eq!(parsed.request_id, "42");
        assert_eq!(parsed.session_id, "sess-1");
        assert_eq!(parsed.title, "Edit chapter-01.md");
        assert_eq!(parsed.options.len(), 2);
        assert_eq!(parsed.options[0].option_id, "allow_once");
        assert_eq!(parsed.options[1].name, "Reject");
    }

    #[test]
    fn stop_sync_recovers_from_poisoned_exit_guard_without_deadlocking() {
        let state = Arc::new(AntigravityAcpState::default());
        let poison_target = Arc::clone(&state.exit_guard);
        let _ = std::thread::spawn(move || {
            let _guard = poison_target.lock().unwrap();
            panic!("intentional poison to verify Rust 2021 stop_sync safety");
        })
        .join();
        assert!(state.exit_guard.is_poisoned());

        let (tx, rx) = std::sync::mpsc::channel();
        let state_for_stop = Arc::clone(&state);
        std::thread::spawn(move || {
            state_for_stop.stop_sync();
            let _ = tx.send(());
        });
        rx.recv_timeout(Duration::from_secs(2))
            .expect("stop_sync must never deadlock on poisoned exit_guard");
    }

    #[test]
    fn extract_rpc_error_ignores_null_error_field() {
        assert!(extract_rpc_error(&json!({ "id": 1, "result": {}, "error": null })).is_none());
        assert!(extract_rpc_error(&json!({ "id": 1, "result": {} })).is_none());
        let err = extract_rpc_error(&json!({
            "id": 1,
            "error": { "code": -32000, "message": "Authentication required" }
        }))
        .expect("real error must parse");
        assert_eq!(err.code, -32000);
        assert_eq!(err.message, "Authentication required");
    }

    #[test]
    fn clear_exit_guard_if_epoch_preserves_newer_epoch_entries() {
        // On non-Windows ProcessTree is a unit struct; on Windows attach_pid on a live child
        // or test epoch fencing via clear_exit_guard_if_epoch on None/Some.
        let guard: std::sync::Mutex<Option<(u64, ProcessTree)>> = std::sync::Mutex::new(None);
        clear_exit_guard_if_epoch(&guard, 1);
        assert!(guard.lock().unwrap().is_none());

        #[cfg(windows)]
        {
            let mut child = std::process::Command::new("cmd")
                .args(["/c", "ping", "-n", "15", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn dummy child");
            if let Some(tree) = process_tree::attach_pid(child.id()) {
                *guard.lock().unwrap() = Some((2, tree));
                // Stale epoch 1 must NOT clear epoch 2's ProcessTree.
                clear_exit_guard_if_epoch(&guard, 1);
                assert!(guard.lock().unwrap().is_some());
                // Matching epoch 2 clears and terminates the tree.
                clear_exit_guard_if_epoch(&guard, 2);
                assert!(guard.lock().unwrap().is_none());
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn merge_loopback_no_proxy_includes_all_loopbacks_without_duplicates() {
        assert_eq!(merge_loopback_no_proxy(None), "127.0.0.1,localhost,::1");
        assert_eq!(
            merge_loopback_no_proxy(Some(" , , ")),
            "127.0.0.1,localhost,::1"
        );
        assert_eq!(
            merge_loopback_no_proxy(Some("example.com, LOCALHOST, 127.0.0.1, example.com")),
            "example.com,LOCALHOST,127.0.0.1,::1"
        );
        let merged = merge_loopback_no_proxy(Some("127.0.0.1,localhost,::1,.internal"));
        let parts: Vec<&str> = merged.split(',').collect();
        assert_eq!(parts, vec!["127.0.0.1", "localhost", "::1", ".internal"]);
    }

    #[test]
    fn resolve_spawn_cwd_fails_closed_for_empty_relative_or_non_dir() {
        let workspace = ensure_cli_workspace_dir().expect("cli workspace dir");
        assert_eq!(resolve_spawn_cwd(None).unwrap(), workspace);
        assert_eq!(resolve_spawn_cwd(Some("")).unwrap(), workspace);
        assert_eq!(resolve_spawn_cwd(Some("   ")).unwrap(), workspace);
        assert_eq!(resolve_spawn_cwd(Some("relative/path")).unwrap(), workspace);

        let temp_dir =
            std::env::temp_dir().join(format!("niko-acp-cwd-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("not-a-dir.txt");
        std::fs::write(&file_path, b"hi").unwrap();

        assert_eq!(
            resolve_spawn_cwd(Some(&temp_dir.to_string_lossy())).unwrap(),
            temp_dir
        );
        assert_eq!(
            resolve_spawn_cwd(Some(&file_path.to_string_lossy())).unwrap(),
            workspace
        );
        assert_eq!(
            resolve_spawn_cwd(Some(&temp_dir.join("missing").to_string_lossy())).unwrap(),
            workspace
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn redact_bearer_tokens_handles_case_json_and_idempotency() {
        assert_eq!(
            redact_bearer_tokens("Authorization: Bearer secret_abc123.xyz"),
            "Authorization: Bearer [REDACTED]"
        );
        assert_eq!(
            redact_bearer_tokens(r#"{"value":"bearer tok-1","alt":"BEARER   tok_2"}"#),
            r#"{"value":"Bearer [REDACTED]","alt":"Bearer [REDACTED]"}"#
        );
        // Word boundary: should not alter unrelated words ending in "bearer".
        assert_eq!(
            redact_bearer_tokens("torchbearer token123"),
            "torchbearer token123"
        );
        // Idempotent when called repeatedly.
        let once = redact_bearer_tokens("Header: Bearer super-secret");
        assert_eq!(redact_bearer_tokens(&once), once);
        // Multi-byte UTF-8 safe.
        assert_eq!(
            redact_bearer_tokens("认证失败 Bearer 秘钥_abc 结束"),
            "认证失败 Bearer [REDACTED] 结束"
        );
    }

    #[tokio::test]
    async fn read_bounded_line_caps_memory_drains_overflow_and_continues() {
        let input = format!("first\r\n{}\nthird", "x".repeat(50));
        let mut reader = BufReader::with_capacity(8, input.as_bytes());

        let l1 = read_bounded_line(&mut reader, 16).await.unwrap();
        assert_eq!(l1.as_deref(), Some("first"));

        let l2 = read_bounded_line(&mut reader, 16).await.unwrap();
        assert_eq!(
            l2.as_deref(),
            Some(format!("{} ...[truncated]", "x".repeat(16)).as_str())
        );

        let l3 = read_bounded_line(&mut reader, 16).await.unwrap();
        assert_eq!(l3.as_deref(), Some("third"));

        let l4 = read_bounded_line(&mut reader, 16).await.unwrap();
        assert_eq!(l4, None);
    }

    #[tokio::test]
    async fn append_stderr_tail_appends_redacted_recent_lines() {
        let ring: StderrRing = Arc::new(Mutex::new(VecDeque::new()));
        assert_eq!(
            append_stderr_tail("[ACP -32098] closed".to_string(), &ring).await,
            "[ACP -32098] closed"
        );

        {
            let mut guard = ring.lock().await;
            for i in 0..12 {
                guard.push_back(redact_bearer_tokens(&format!("line {i} Bearer secret_{i}")));
            }
        }
        let enriched = append_stderr_tail("[ACP -32098] closed".to_string(), &ring).await;
        assert!(enriched.contains("[agy stderr]:"));
        assert!(!enriched.contains("secret_"));
        assert!(enriched.contains("line 11 Bearer [REDACTED]"));
        assert!(enriched.contains("line 4 Bearer [REDACTED]"));
        assert!(!enriched.contains("line 3 "));
    }

    #[test]
    fn extract_rpc_error_uses_non_auth_default_code_when_missing() {
        let missing_code = extract_rpc_error(&json!({
            "id": 2,
            "error": { "message": "Malformed error without code" }
        }))
        .expect("error without code must parse");
        assert_eq!(missing_code.code, -32096);
        assert_ne!(
            missing_code.code, -32000,
            "missing error code must never masquerade as ACP -32000 auth-required"
        );
        assert_eq!(missing_code.message, "Malformed error without code");
    }

    #[test]
    fn parse_permission_request_extracts_tool_kind_locations_and_redacted_summary() {
        let mut many_locations = Vec::new();
        many_locations.push(json!("wiki/chapters/ch-01.md"));
        many_locations.push(json!({ "path": "wiki/chapters/ch-02.md", "line": 42 }));
        many_locations.push(json!({ "path": "wiki/chapters/ch-03.md" }));
        for i in 0..40 {
            many_locations.push(json!({ "path": format!("file-{i}.md"), "line": i + 1 }));
        }
        let long_raw_input = json!({
            "command": format!("curl -H 'Authorization: Bearer secret_token_123' {}", "中".repeat(700))
        });
        let params = json!({
            "sessionId": "sess-9",
            "toolCall": {
                "title": "Run shell command",
                "kind": "execute",
                "locations": many_locations,
                "rawInput": long_raw_input
            },
            "options": [
                { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" }
            ]
        });

        let parsed = parse_permission_request("99".to_string(), &params);
        assert_eq!(parsed.title, "Run shell command");
        assert_eq!(parsed.tool_kind.as_deref(), Some("execute"));
        assert_eq!(parsed.locations.len(), MAX_PERMISSION_LOCATIONS);
        assert_eq!(parsed.locations[0], "wiki/chapters/ch-01.md");
        assert_eq!(parsed.locations[1], "wiki/chapters/ch-02.md:42");
        assert_eq!(parsed.locations[2], "wiki/chapters/ch-03.md");

        let summary = parsed.raw_input_summary.as_deref().expect("summary");
        assert!(!summary.contains("secret_token_123"));
        assert!(summary.contains("Bearer [REDACTED]"));
        assert!(summary.chars().count() <= MAX_RAW_INPUT_SUMMARY_CHARS);
        assert!(summary.ends_with("..."));

        // Fallback to top-level `params.locations` when `toolCall.locations` is absent.
        let fallback_params = json!({
            "sessionId": "sess-10",
            "locations": ["README.md", { "path": "Cargo.toml", "line": 7 }]
        });
        let fallback = parse_permission_request("100".to_string(), &fallback_params);
        assert_eq!(fallback.locations, vec!["README.md", "Cargo.toml:7"]);

        // CamelCase wire serialization & full Bearer/mcpServers redaction check.
        let serialized = serde_json::to_value(&parsed).expect("serialize permission");
        assert_eq!(serialized["toolKind"], "execute");
        assert!(serialized["rawInputSummary"].is_string());
        assert!(
            !serialized.to_string().contains("secret_token_123"),
            "serialized permission payload must never leak Bearer tokens to WebView"
        );

        let with_mcp = json!({
            "sessionId": "sess-11",
            "title": "Invoke tool with Authorization: Bearer leaked_title_token",
            "mcpServers": [{ "name": "niko-buddy", "headers": [{ "name": "Authorization", "value": "Bearer secret_mcp_tok" }] }],
            "toolCall": { "rawInput": { "auth": "Bearer leaked_raw_token" } }
        });
        let sanitized_perm = parse_permission_request("101".to_string(), &with_mcp);
        let sanitized_json = serde_json::to_value(&sanitized_perm).expect("serialize");
        let sanitized_str = sanitized_json.to_string();
        assert!(!sanitized_str.contains("leaked_title_token"));
        assert!(!sanitized_str.contains("secret_mcp_tok"));
        assert!(!sanitized_str.contains("leaked_raw_token"));
        assert!(sanitized_json["rawParams"].get("mcpServers").is_none());
    }

    #[test]
    fn extract_rpc_error_redacts_bearer_tokens_from_message() {
        let err = extract_rpc_error(&json!({
            "id": 2,
            "error": {
                "code": -32001,
                "message": "MCP HTTP failed: Authorization: Bearer super_secret_mcp_tok"
            }
        }))
        .expect("rpc error");
        assert_eq!(err.code, -32001);
        assert!(!err.message.contains("super_secret_mcp_tok"));
        assert!(err.message.contains("Bearer [REDACTED]"));
    }

    #[test]
    fn in_flight_prompt_guard_rejects_overlap_and_resets_on_drop() {
        let flag = Arc::new(AtomicBool::new(false));
        let guard = InFlightPromptGuard::try_acquire(Arc::clone(&flag)).expect("first acquire");
        assert!(flag.load(Ordering::Acquire));

        let overlap = InFlightPromptGuard::try_acquire(Arc::clone(&flag));
        assert!(overlap.is_err(), "overlapping prompt must be rejected");
        assert!(
            flag.load(Ordering::Acquire),
            "rejected overlap must not clear active flag"
        );

        drop(guard);
        assert!(!flag.load(Ordering::Acquire), "Drop must reset flag");

        let next = InFlightPromptGuard::try_acquire(Arc::clone(&flag));
        assert!(next.is_ok(), "next prompt must succeed after drop");
    }

    #[test]
    fn plan_local_mcp_attachment_covers_all_branches() {
        use crate::mcp_server::session::SessionScope;

        let make_binding = |port: u16, scope: SessionScope, fp: &str, gen: u64| LocalMcpBinding {
            port,
            scope,
            token_fingerprint: fp.to_string(),
            generation: gen,
        };

        // 1) attach != Some(true) -> skip_reason MUST be None
        for opt in [None, Some(false)] {
            let plan = plan_local_mcp_attachment(opt, false, Some(true), None);
            assert!(!plan.attached_local_mcp);
            assert!(plan.mcp_servers.is_empty());
            assert_eq!(plan.local_mcp_scope, None);
            assert_eq!(plan.local_mcp_skip_reason, None);
            assert_eq!(plan.attached_mcp_binding, None);
        }

        // 2) attach == Some(true), http_mcp_enabled == false
        let disabled = plan_local_mcp_attachment(
            Some(true),
            false,
            Some(true),
            Some((
                45871,
                "tok".into(),
                make_binding(45871, SessionScope::Read, "fp1", 1),
            )),
        );
        assert!(!disabled.attached_local_mcp);
        assert_eq!(disabled.local_mcp_scope, None);
        assert_eq!(
            disabled.local_mcp_skip_reason.as_deref(),
            Some("http_mcp_disabled")
        );
        assert_eq!(disabled.attached_mcp_binding, None);

        // 3) attach == Some(true), http_mcp_enabled == true, supports_http_mcp == Some(false)
        let unsupported = plan_local_mcp_attachment(
            Some(true),
            true,
            Some(false),
            Some((
                45871,
                "tok".into(),
                make_binding(45871, SessionScope::Read, "fp1", 1),
            )),
        );
        assert!(!unsupported.attached_local_mcp);
        assert!(unsupported.mcp_servers.is_empty());
        assert_eq!(unsupported.local_mcp_scope, None);
        assert_eq!(
            unsupported.local_mcp_skip_reason.as_deref(),
            Some("agent_unsupported")
        );
        assert_eq!(unsupported.attached_mcp_binding, None);

        // 4) attach == Some(true), http_mcp_enabled == true, MCP server not running
        let not_running = plan_local_mcp_attachment(Some(true), true, Some(true), None);
        assert!(!not_running.attached_local_mcp);
        assert_eq!(not_running.local_mcp_scope, None);
        assert_eq!(
            not_running.local_mcp_skip_reason.as_deref(),
            Some("mcp_server_not_running")
        );
        assert_eq!(not_running.attached_mcp_binding, None);

        // 5) attach == Some(true), http_mcp_enabled == true, supports_http_mcp == Some(true) or None (legacy), running
        for caps in [Some(true), None] {
            let binding = make_binding(45871, SessionScope::Project, "fp_proj", 7);
            let attached = plan_local_mcp_attachment(
                Some(true),
                true,
                caps,
                Some((45871, "secret_tok".into(), binding.clone())),
            );
            assert!(attached.attached_local_mcp);
            assert_eq!(attached.local_mcp_scope.as_deref(), Some("project"));
            assert_eq!(attached.local_mcp_skip_reason, None);
            assert_eq!(attached.attached_mcp_binding, Some(binding));
            assert_eq!(attached.mcp_servers.len(), 1);
            assert_eq!(attached.mcp_servers[0]["url"], "http://127.0.0.1:45871/mcp");
        }
    }

    #[test]
    fn sanitize_session_raw_result_strips_mcp_servers_and_redacts_bearer_recursively() {
        let raw = json!({
            "sessionId": "sess-1",
            "mcpServers": [
                { "name": "niko-buddy", "headers": [{ "name": "Authorization", "value": "Bearer leak_1" }] }
            ],
            "nested": {
                "mcp_servers": [{ "token": "Bearer leak_2" }],
                "debug": "sent Authorization: Bearer leak_3",
                "items": ["ok", "bearer leak_4"]
            },
            "configOptions": [{ "id": "model", "value": "gemini" }]
        });
        let clean = sanitize_session_raw_result(raw);
        assert!(clean.get("mcpServers").is_none());
        assert!(clean["nested"].get("mcp_servers").is_none());
        assert_eq!(
            clean["nested"]["debug"],
            "sent Authorization: Bearer [REDACTED]"
        );
        assert_eq!(clean["nested"]["items"][1], "Bearer [REDACTED]");
        assert_eq!(clean["sessionId"], "sess-1");
        let serialized = clean.to_string();
        assert!(!serialized.contains("leak_"));
    }

    #[test]
    fn parse_prompt_result_and_contract_structs_serialize_camel_case() {
        let r1 = parse_prompt_result(json!({
            "stopReason": "end_turn",
            "usage": { "inputTokens": 120, "outputTokens": 45 }
        }));
        assert_eq!(r1.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(
            r1.usage,
            Some(json!({ "inputTokens": 120, "outputTokens": 45 }))
        );
        let v1 = serde_json::to_value(&r1).unwrap();
        assert_eq!(v1["stopReason"], "end_turn");
        assert_eq!(v1["usage"]["outputTokens"], 45);
        assert!(v1["rawResult"].is_object());

        let r2 = parse_prompt_result(json!({ "stop_reason": "cancelled", "usage": null }));
        assert_eq!(r2.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(r2.usage, None);

        let snap = serde_json::to_value(AcpStatusSnapshot::default()).unwrap();
        assert_eq!(snap["attachedLocalMcp"], false);
        assert_eq!(snap["localMcpScope"], Value::Null);
        assert_eq!(snap["inFlightPrompt"], false);
    }

    #[test]
    fn prompt_guards_cap_lengths_and_sanitize_context_title() {
        assert!(validate_prompt_inputs("s1", &"a".repeat(MAX_PROMPT_TEXT_BYTES), None).is_ok());
        assert!(
            validate_prompt_inputs("s1", &"a".repeat(MAX_PROMPT_TEXT_BYTES + 1), None).is_err()
        );
        assert!(
            validate_prompt_inputs("s1", "hello", Some(&"b".repeat(MAX_CONTEXT_TEXT_BYTES)))
                .is_ok()
        );
        assert!(validate_prompt_inputs(
            "s1",
            "hello",
            Some(&"b".repeat(MAX_CONTEXT_TEXT_BYTES + 1))
        )
        .is_err());

        let clean = sanitize_context_title(Some("Chapter 1\r\n[Injected]\x00\tTitle"));
        assert_eq!(clean, "Chapter 1 [Injected] Title");
        assert!(!clean.chars().any(char::is_control));

        let capped = sanitize_context_title(Some(&"章".repeat(300)));
        assert_eq!(capped.chars().count(), MAX_CONTEXT_TITLE_CHARS);

        assert_eq!(
            sanitize_context_title(Some("\r\n\t\x00   ")),
            "Current editor document"
        );
    }

    #[tokio::test]
    async fn rollback_permission_if_epoch_only_reinserts_on_matching_epoch() {
        let epoch = AtomicU64::new(5);
        let map: PendingPermissionMap = Arc::new(Mutex::new(HashMap::new()));
        let make_entry = || PendingPermissionEntry {
            rpc_id: json!(7),
            info: parse_permission_request("7".to_string(), &json!({ "sessionId": "s1" })),
        };

        // Matching epoch -> re-inserted.
        rollback_permission_if_epoch(&epoch, &map, 5, "7".to_string(), make_entry()).await;
        assert!(map.lock().await.contains_key("7"));

        map.lock().await.clear();
        // Stale epoch -> NOT re-inserted.
        rollback_permission_if_epoch(&epoch, &map, 4, "7".to_string(), make_entry()).await;
        assert!(!map.lock().await.contains_key("7"));
    }

    // ── Round 2 Protocol Depth, Staleness, Redaction & Duplex Async E2E Tests ──

    #[test]
    fn config_update_session_matches_rejects_some_when_active_session_is_none() {
        assert!(config_update_session_matches(Some("s1"), Some("s1")));
        assert!(!config_update_session_matches(Some("s1"), Some("s2")));
        assert!(!config_update_session_matches(Some("s1"), None));
        assert!(config_update_session_matches(None, Some("s1")));
        assert!(config_update_session_matches(None, None));
    }

    #[test]
    fn parse_agent_capabilities_handles_camel_snake_present_without_http_and_absent() {
        // 1) camelCase with http=true & loadSession=true
        let camel = parse_agent_capabilities(&json!({
            "agentCapabilities": {
                "mcpCapabilities": { "http": true },
                "loadSession": true
            }
        }));
        assert_eq!(camel.supports_http_mcp, Some(true));
        assert_eq!(camel.supports_load_session, Some(true));

        // 2) snake_case with http=true & load_session=false
        let snake = parse_agent_capabilities(&json!({
            "agent_capabilities": {
                "mcp_capabilities": { "http": true },
                "load_session": false
            }
        }));
        assert_eq!(snake.supports_http_mcp, Some(true));
        assert_eq!(snake.supports_load_session, Some(false));

        // 3) Present object without http / loadSession -> Some(false) (Guardrail G-A3)
        let without_http = parse_agent_capabilities(&json!({
            "agentCapabilities": {
                "mcpCapabilities": { "sse": true }
            }
        }));
        assert_eq!(without_http.supports_http_mcp, Some(false));
        assert_eq!(without_http.supports_load_session, Some(false));

        let empty_caps = parse_agent_capabilities(&json!({ "agentCapabilities": {} }));
        assert_eq!(empty_caps.supports_http_mcp, Some(false));
        assert_eq!(empty_caps.supports_load_session, Some(false));

        // 4) Completely absent / null -> None (Guardrail G-A3 legacy/mock fallback)
        let absent = parse_agent_capabilities(&json!({ "protocolVersion": 1 }));
        assert_eq!(absent.supports_http_mcp, None);
        assert_eq!(absent.supports_load_session, None);

        let null_caps = parse_agent_capabilities(&json!({ "agentCapabilities": null }));
        assert_eq!(null_caps.supports_http_mcp, None);
        assert_eq!(null_caps.supports_load_session, None);
    }

    #[test]
    fn compute_local_mcp_staleness_enforces_all_five_priority_branches() {
        use crate::mcp_server::session::SessionScope;

        let base = LocalMcpBinding {
            port: 45871,
            scope: SessionScope::Read,
            token_fingerprint: "fp_v1".to_string(),
            generation: 1,
        };

        // 0) Not attached -> never stale regardless of live server
        assert_eq!(compute_local_mcp_staleness(None, None), (false, None));
        assert_eq!(
            compute_local_mcp_staleness(None, Some(&base)),
            (false, None)
        );

        // 1) Stopped -> mcp_server_stopped
        assert_eq!(
            compute_local_mcp_staleness(Some(&base), None),
            (true, Some("mcp_server_stopped"))
        );

        // 2) port_changed takes precedence over token_rotated, scope_changed, server_restarted
        let all_changed = LocalMcpBinding {
            port: 45872,
            scope: SessionScope::Project,
            token_fingerprint: "fp_v2".to_string(),
            generation: 2,
        };
        assert_eq!(
            compute_local_mcp_staleness(Some(&base), Some(&all_changed)),
            (true, Some("port_changed"))
        );

        // 3) token_rotated takes precedence over scope_changed and server_restarted
        let token_scope_gen = LocalMcpBinding {
            port: 45871,
            scope: SessionScope::Project,
            token_fingerprint: "fp_v2".to_string(),
            generation: 2,
        };
        assert_eq!(
            compute_local_mcp_staleness(Some(&base), Some(&token_scope_gen)),
            (true, Some("token_rotated"))
        );

        // 4) scope_changed takes precedence over server_restarted
        let scope_and_gen = LocalMcpBinding {
            port: 45871,
            scope: SessionScope::Project,
            token_fingerprint: "fp_v1".to_string(),
            generation: 2,
        };
        assert_eq!(
            compute_local_mcp_staleness(Some(&base), Some(&scope_and_gen)),
            (true, Some("scope_changed"))
        );

        // 5) server_restarted when port/token/scope all match and only generation differs
        let restarted = LocalMcpBinding {
            generation: 2,
            ..base.clone()
        };
        assert_eq!(
            compute_local_mcp_staleness(Some(&base), Some(&restarted)),
            (true, Some("server_restarted"))
        );

        // 6) Exact match -> fresh
        assert_eq!(
            compute_local_mcp_staleness(Some(&base), Some(&base)),
            (false, None)
        );
    }

    #[test]
    fn sanitize_rpc_payload_redacts_authenticate_and_config_option_secrets() {
        let auth_payload = json!({
            "authenticated": true,
            "accessToken": "ya29.super_secret_oauth",
            "refresh_token": "1//refresh_secret",
            "header": "Authorization: Basic dXNlcjpwYXNz",
            "headers": [
                { "name": "Authorization", "value": "Bearer mcp_secret_99" },
                { "name": "X-API-Key", "value": "raw_api_key_value" },
                { "name": "Content-Type", "value": "application/json" }
            ],
            "configOptions": [
                { "id": "model", "name": "Model", "value": "gemini-2.5-pro" }
            ]
        });
        let clean = sanitize_rpc_payload(auth_payload);
        let wire = clean.to_string();
        assert!(!wire.contains("ya29.super_secret_oauth"), "{wire}");
        assert!(!wire.contains("refresh_secret"), "{wire}");
        assert!(!wire.contains("dXNlcjpwYXNz"), "{wire}");
        assert!(!wire.contains("mcp_secret_99"), "{wire}");
        assert!(!wire.contains("raw_api_key_value"), "{wire}");
        assert_eq!(clean["accessToken"], "[REDACTED]");
        assert_eq!(clean["refresh_token"], "[REDACTED]");
        assert_eq!(clean["header"], "Authorization: Basic [REDACTED]");
        assert_eq!(clean["headers"][0]["value"], "Bearer [REDACTED]");
        assert_eq!(clean["headers"][1]["value"], "[REDACTED]");
        assert_eq!(clean["headers"][2]["value"], "application/json");
        assert_eq!(clean["configOptions"][0]["value"], "gemini-2.5-pro");
    }

    #[test]
    fn status_snapshot_serializes_additive_capabilities_and_staleness_fields() {
        let default_json = serde_json::to_value(AcpStatusSnapshot::default()).unwrap();
        assert!(default_json.get("supportsHttpMcp").is_none());
        assert!(default_json.get("supportsLoadSession").is_none());
        assert_eq!(default_json["localMcpStale"], json!(false));
        assert_eq!(default_json["localMcpStaleReason"], Value::Null);

        let populated = AcpStatusSnapshot {
            connected: true,
            supports_http_mcp: Some(true),
            supports_load_session: Some(false),
            local_mcp_stale: true,
            local_mcp_stale_reason: Some("token_rotated".to_string()),
            ..Default::default()
        };
        let pop_json = serde_json::to_value(populated).unwrap();
        assert_eq!(pop_json["supportsHttpMcp"], json!(true));
        assert_eq!(pop_json["supportsLoadSession"], json!(false));
        assert_eq!(pop_json["localMcpStale"], json!(true));
        assert_eq!(pop_json["localMcpStaleReason"], json!("token_rotated"));
    }

    struct MockDemuxSink {
        my_epoch: u64,
        conn_epoch: Arc<AtomicU64>,
        pending_rpc: PendingRpcMap,
        pending_permissions: PendingPermissionMap,
        active_session_id: Arc<Mutex<Option<String>>>,
        config_options: Arc<Mutex<Vec<Value>>>,
        events: Arc<std::sync::Mutex<Vec<Value>>>,
        client_replies: Arc<Mutex<Vec<Value>>>,
        eof_emitted: Arc<AtomicBool>,
    }

    impl MockDemuxSink {
        fn new(epoch: u64, conn_epoch: Arc<AtomicU64>) -> Self {
            Self {
                my_epoch: epoch,
                conn_epoch,
                pending_rpc: Arc::new(Mutex::new(HashMap::new())),
                pending_permissions: Arc::new(Mutex::new(HashMap::new())),
                active_session_id: Arc::new(Mutex::new(None)),
                config_options: Arc::new(Mutex::new(Vec::new())),
                events: Arc::new(std::sync::Mutex::new(Vec::new())),
                client_replies: Arc::new(Mutex::new(Vec::new())),
                eof_emitted: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    impl DemuxSessionSink for MockDemuxSink {
        fn is_epoch_active(&self) -> bool {
            self.conn_epoch.load(Ordering::Acquire) == self.my_epoch
        }

        fn resolve_rpc_response<'a>(
            &'a self,
            key: String,
            result: Result<Value, AcpRpcError>,
        ) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                if let Some(tx) = self.pending_rpc.lock().await.remove(&key) {
                    let _ = tx.send(result);
                }
            })
        }

        fn write_client_reply<'a>(&'a self, payload: Value) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.client_replies.lock().await.push(payload);
            })
        }

        fn insert_pending_permission<'a>(
            &'a self,
            req_key: String,
            entry: PendingPermissionEntry,
        ) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.pending_permissions.lock().await.insert(req_key, entry);
            })
        }

        fn update_config_options<'a>(
            &'a self,
            evt_sid: Option<String>,
            opts: Vec<Value>,
        ) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                let active_sid = self.active_session_id.lock().await.clone();
                if config_update_session_matches(evt_sid.as_deref(), active_sid.as_deref()) {
                    *self.config_options.lock().await = opts;
                }
            })
        }

        fn emit_event(&self, payload: Value) {
            self.events.lock().unwrap().push(payload);
        }

        fn on_loop_exit<'a>(&'a self) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                let waiters: Vec<_> = self.pending_rpc.lock().await.drain().collect();
                for (_, tx) in waiters {
                    let _ = tx.send(Err(AcpRpcError {
                        code: -32098,
                        message: "agy acp exited unexpectedly".to_string(),
                    }));
                }
                if self.is_epoch_active() {
                    self.eof_emitted.store(true, Ordering::Release);
                    self.emit_event(json!({ "kind": "disconnected", "reason": "eof" }));
                }
            })
        }
    }

    #[tokio::test]
    async fn demux_loop_leaves_prose_untouched_and_redacts_tool_call_bearer() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        let events = Arc::clone(&sink.events);

        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::new(reader), sink, MAX_ACP_STDOUT_LINE_BYTES).await;
        });

        let msg_prose = "He was the bearer of bad news, carrying Bearer sword-01 into the mist.";
        let thought_prose = "Remember: the Bearer of the ring must not reveal the token.";
        let frames = [
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": msg_prose }
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": thought_prose }
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tc-1",
                        "title": "POST /mcp Authorization: Bearer live_secret_title",
                        "rawInput": { "auth": "Bearer live_secret_input" },
                        "mcpServers": [{ "url": "http://127.0.0.1:45871/mcp" }]
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "tc-1",
                        "status": "completed",
                        "rawOutput": "Header: Authorization: Bearer live_secret_output",
                        "content": [{ "type": "text", "text": "bearer live_secret_content" }]
                    }
                }
            }),
        ];
        for frame in frames {
            let mut line = serde_json::to_string(&frame).unwrap();
            line.push('\n');
            writer.write_all(line.as_bytes()).await.unwrap();
        }
        drop(writer);
        task.await.unwrap();

        let recorded = events.lock().unwrap().clone();
        // 4 session_update events + 1 eof disconnected event
        assert_eq!(recorded.len(), 5);
        assert_eq!(
            recorded[0]["params"]["update"]["content"]["text"],
            json!(msg_prose),
            "agent_message_chunk prose must never be altered"
        );
        assert_eq!(
            recorded[1]["params"]["update"]["content"]["text"],
            json!(thought_prose),
            "agent_thought_chunk prose must never be altered"
        );

        let tc_str = recorded[2].to_string();
        assert!(!tc_str.contains("live_secret_title"), "{tc_str}");
        assert!(!tc_str.contains("live_secret_input"), "{tc_str}");
        assert!(recorded[2]["params"]["update"].get("mcpServers").is_none());
        assert!(tc_str.contains("Bearer [REDACTED]"), "{tc_str}");

        let tcu_str = recorded[3].to_string();
        assert!(!tcu_str.contains("live_secret_output"), "{tcu_str}");
        assert!(!tcu_str.contains("live_secret_content"), "{tcu_str}");
        assert!(tcu_str.contains("Bearer [REDACTED]"), "{tcu_str}");
    }

    #[tokio::test]
    async fn demux_loop_correlates_rpc_handles_permissions_and_drains_stale_permissions() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        let pending_rpc = Arc::clone(&sink.pending_rpc);
        let pending_perms = Arc::clone(&sink.pending_permissions);
        let events = Arc::clone(&sink.events);
        let replies = Arc::clone(&sink.client_replies);

        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();
        pending_rpc.lock().await.insert("1".to_string(), tx1);
        pending_rpc.lock().await.insert("2".to_string(), tx2);

        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::new(reader), sink, MAX_ACP_STDOUT_LINE_BYTES).await;
        });

        let frames = [
            json!({ "jsonrpc": "2.0", "id": 1, "result": { "sessionId": "sess-1" } }),
            json!({ "jsonrpc": "2.0", "id": 2, "error": { "code": -32001, "message": "failed Bearer tok_err_9" } }),
            json!({
                "jsonrpc": "2.0",
                "id": 99,
                "method": "session/request_permission",
                "params": {
                    "sessionId": "sess-old",
                    "title": "Run tool",
                    "options": [{ "optionId": "allow_once", "name": "Allow once" }]
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 100,
                "method": "fs/read_text_file",
                "params": { "path": "x.md" }
            }),
        ];
        for frame in frames {
            let mut line = serde_json::to_string(&frame).unwrap();
            line.push('\n');
            writer.write_all(line.as_bytes()).await.unwrap();
        }
        drop(writer);
        task.await.unwrap();

        let res1 = rx1.await.unwrap().expect("rpc 1 ok");
        assert_eq!(res1["sessionId"], "sess-1");
        let err2 = rx2.await.unwrap().expect_err("rpc 2 err");
        assert_eq!(err2.code, -32001);
        assert!(!err2.message.contains("tok_err_9"));
        assert!(err2.message.contains("Bearer [REDACTED]"));

        // Unsupported method replied with -32601
        let client_replies = replies.lock().await.clone();
        assert_eq!(client_replies.len(), 1);
        assert_eq!(client_replies[0]["id"], json!(100));
        assert_eq!(client_replies[0]["error"]["code"], json!(-32601));

        // Permission was recorded and emitted
        assert!(pending_perms.lock().await.contains_key("99"));
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "permission_request" && e["permission"]["requestId"] == "99"));

        // Drain stale permissions over a real duplex writer and verify cancelled JSON-RPC response.
        let (stdin_tx, mut stdin_rx) = tokio::io::duplex(4096);
        let shared_stdin = Arc::new(Mutex::new(stdin_tx));
        let drained = drain_pending_permissions(&pending_perms, &shared_stdin).await;
        assert_eq!(drained, vec!["99".to_string()]);
        assert!(pending_perms.lock().await.is_empty());
        drop(shared_stdin);

        let mut reader_reply = BufReader::new(&mut stdin_rx);
        let reply_line = match read_bounded_stdout_line(&mut reader_reply, 4096)
            .await
            .unwrap()
        {
            BoundedLineOutcome::Line(l) => l,
            other => panic!("expected cancelled reply line, got {other:?}"),
        };
        let reply_json: Value = serde_json::from_str(&reply_line).unwrap();
        assert_eq!(reply_json["id"], json!(99));
        assert_eq!(
            reply_json["result"]["outcome"]["outcome"],
            json!("cancelled")
        );
    }

    #[tokio::test]
    async fn demux_loop_emits_protocol_warning_on_oversized_line_and_recovers_next_frame() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        let events = Arc::clone(&sink.events);

        let limit = 256usize;
        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::with_capacity(32, reader), sink, limit).await;
        });

        // Oversized line (> 256 bytes) carrying a Bearer secret in its prefix, followed by a valid frame.
        let oversized = format!(
            "{{\"prefix\":\"Authorization: Bearer leak_in_oversized\",\"pad\":\"{}\"}}\n",
            "x".repeat(400)
        );
        let expected_bytes = oversized.len() - 1; // excluding '\n'
        assert!(expected_bytes > limit);
        let next_valid = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "recovered" } }
            }
        }))
        .unwrap();
        assert!(next_valid.len() <= limit);

        writer.write_all(oversized.as_bytes()).await.unwrap();
        writer
            .write_all(format!("{next_valid}\n").as_bytes())
            .await
            .unwrap();
        drop(writer);
        task.await.unwrap();

        let recorded = events.lock().unwrap().clone();
        assert_eq!(recorded.len(), 3); // protocol_warning, recovered session_update, disconnected(eof)
        assert_eq!(recorded[0]["kind"], json!("protocol_warning"));
        assert_eq!(recorded[0]["code"], json!("oversized_stdout_line"));
        assert_eq!(recorded[0]["bytes"], json!(expected_bytes));
        assert_eq!(recorded[0]["limitBytes"], json!(limit));
        let preview = recorded[0]["preview"].as_str().unwrap();
        assert!(!preview.contains("leak_in_oversized"), "{preview}");
        assert!(preview.contains("Bearer [REDACTED]"), "{preview}");
        assert_eq!(
            recorded[1]["params"]["update"]["content"]["text"],
            json!("recovered")
        );
    }

    #[tokio::test]
    async fn demux_loop_handles_invalid_utf8_lossily_without_terminating() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        let events = Arc::clone(&sink.events);

        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::new(reader), sink, MAX_ACP_STDOUT_LINE_BYTES).await;
        });

        let mut bad_utf8_line: Vec<u8> = Vec::new();
        bad_utf8_line.extend_from_slice(
            br#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bad-"#,
        );
        bad_utf8_line.extend_from_slice(&[0xff, 0xfe]);
        bad_utf8_line.extend_from_slice(br#"-end"}}}}"#);
        bad_utf8_line.push(b'\n');

        let follow_up = format!(
            "{}\n",
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "after-invalid-utf8" } }
                }
            })
        );

        writer.write_all(&bad_utf8_line).await.unwrap();
        writer.write_all(follow_up.as_bytes()).await.unwrap();
        drop(writer);
        task.await.unwrap();

        let recorded = events.lock().unwrap().clone();
        assert_eq!(recorded.len(), 3);
        let lossy_text = recorded[0]["params"]["update"]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(lossy_text.starts_with("bad-"));
        assert!(lossy_text.contains('\u{FFFD}'));
        assert!(lossy_text.ends_with("-end"));
        assert_eq!(
            recorded[1]["params"]["update"]["content"]["text"],
            json!("after-invalid-utf8")
        );
    }

    #[tokio::test]
    async fn demux_loop_top_of_loop_epoch_fence_ignores_frames_after_epoch_bump() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        let events = Arc::clone(&sink.events);
        let eof_emitted = Arc::clone(&sink.eof_emitted);

        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::new(reader), sink, MAX_ACP_STDOUT_LINE_BYTES).await;
        });

        // Bump epoch BEFORE writing frames.
        epoch.fetch_add(1, Ordering::AcqRel);
        let stale_frame = format!(
            "{}\n",
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "should-be-dropped" } }
                }
            })
        );
        let _ = writer.write_all(stale_frame.as_bytes()).await;
        drop(writer);
        task.await.unwrap();

        assert!(
            events.lock().unwrap().is_empty(),
            "no events (including eof) may be emitted after epoch bump"
        );
        assert!(!eof_emitted.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn demux_loop_config_option_update_rejects_some_sid_when_active_is_none() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        let config_options = Arc::clone(&sink.config_options);

        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::new(reader), sink, MAX_ACP_STDOUT_LINE_BYTES).await;
        });

        let update = format!(
            "{}\n",
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "config_option_update",
                        "configOptions": [{ "id": "model", "value": "gemini" }]
                    }
                }
            })
        );
        writer.write_all(update.as_bytes()).await.unwrap();
        drop(writer);
        task.await.unwrap();

        assert!(
            config_options.lock().await.is_empty(),
            "config_option_update with sessionId=Some(\"s1\") must NOT populate config_options when active_session_id is None"
        );
    }

    #[test]
    fn sanitize_rpc_payload_handles_multibyte_utf8_sensitive_values_without_panicking() {
        let payload = json!({
            "secret": "中文测试",
            "token": "a中文",
            "authorization": "中文授权头内容",
            "headers": [
                { "name": "Authorization", "value": "中文凭据" },
                { "name": "X-API-Key", "value": "秘钥中文值" }
            ]
        });
        let clean = sanitize_rpc_payload(payload);
        assert_eq!(clean["secret"], "[REDACTED]");
        assert_eq!(clean["token"], "[REDACTED]");
        assert_eq!(clean["authorization"], "[REDACTED]");
        assert_eq!(clean["headers"][0]["value"], "[REDACTED]");
        assert_eq!(clean["headers"][1]["value"], "[REDACTED]");
        let wire = clean.to_string();
        assert!(!wire.contains("中文"), "{wire}");
        assert!(!wire.contains("秘钥"), "{wire}");
    }

    #[test]
    fn parse_permission_request_sanitizes_before_extracting_title_and_raw_input_summary() {
        let params = json!({
            "sessionId": "sess-sec",
            "title": "Run request Authorization: Basic dXNlcjpzZWNyZXQ=",
            "toolCall": {
                "title": "Fallback title",
                "kind": "execute",
                "rawInput": {
                    "header": "Authorization: Basic dXNlcjpzZWNyZXQ=",
                    "accessToken": "ya29.raw_input_access_secret",
                    "x-api-key": "raw_input_api_key_secret",
                    "secret": "中文机密值",
                    "safeArg": "chapter-01.md"
                }
            },
            "options": [
                { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" }
            ]
        });

        let parsed = parse_permission_request("201".to_string(), &params);
        assert_eq!(parsed.title, "Run request Authorization: Basic [REDACTED]");
        let summary = parsed.raw_input_summary.as_deref().expect("summary");
        assert!(summary.contains("chapter-01.md"), "{summary}");
        assert!(
            summary.contains("Authorization: Basic [REDACTED]"),
            "{summary}"
        );

        let serialized = serde_json::to_value(&parsed)
            .expect("serialize")
            .to_string();
        for leaked in [
            "dXNlcjpzZWNyZXQ=",
            "ya29.raw_input_access_secret",
            "raw_input_api_key_secret",
            "中文机密值",
        ] {
            assert!(
                !parsed.title.contains(leaked),
                "title leaked `{leaked}`: {}",
                parsed.title
            );
            assert!(
                !summary.contains(leaked),
                "rawInputSummary leaked `{leaked}`: {summary}"
            );
            assert!(
                !serialized.contains(leaked),
                "serialized permission leaked `{leaked}`: {serialized}"
            );
        }
    }

    #[tokio::test]
    async fn demux_loop_sanitizes_config_option_update_before_caching_and_emitting() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let epoch = Arc::new(AtomicU64::new(1));
        let sink = MockDemuxSink::new(1, Arc::clone(&epoch));
        *sink.active_session_id.lock().await = Some("s1".to_string());
        let config_options = Arc::clone(&sink.config_options);
        let events = Arc::clone(&sink.events);

        let task = tokio::spawn(async move {
            run_stdout_demux_loop(BufReader::new(reader), sink, MAX_ACP_STDOUT_LINE_BYTES).await;
        });

        let update = format!(
            "{}\n",
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "config_option_update",
                        "configOptions": [
                            {
                                "id": "model",
                                "value": "gemini-2.5-pro",
                                "accessToken": "ya29.config_secret_tok",
                                "note": "Authorization: Bearer config_bearer_secret"
                            }
                        ]
                    }
                }
            })
        );
        writer.write_all(update.as_bytes()).await.unwrap();
        drop(writer);
        task.await.unwrap();

        let cached = config_options.lock().await.clone();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0]["value"], json!("gemini-2.5-pro"));
        assert_eq!(cached[0]["accessToken"], json!("[REDACTED]"));
        assert_eq!(cached[0]["note"], json!("Authorization: Bearer [REDACTED]"));

        let cached_wire = json!(cached).to_string();
        assert!(!cached_wire.contains("config_secret_tok"), "{cached_wire}");
        assert!(
            !cached_wire.contains("config_bearer_secret"),
            "{cached_wire}"
        );

        let emitted = events.lock().unwrap().clone();
        let emitted_wire = emitted[0].to_string();
        assert!(
            !emitted_wire.contains("config_secret_tok"),
            "{emitted_wire}"
        );
        assert!(
            !emitted_wire.contains("config_bearer_secret"),
            "{emitted_wire}"
        );
    }

    #[tokio::test]
    async fn drain_stale_session_permissions_keeps_matching_session_and_cancels_stale() {
        let pending: PendingPermissionMap = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut map = pending.lock().await;
            map.insert(
                "10".to_string(),
                PendingPermissionEntry {
                    rpc_id: json!(10),
                    info: parse_permission_request(
                        "10".to_string(),
                        &json!({ "sessionId": "sess-old", "title": "Old prompt" }),
                    ),
                },
            );
            map.insert(
                "20".to_string(),
                PendingPermissionEntry {
                    rpc_id: json!(20),
                    info: parse_permission_request(
                        "20".to_string(),
                        &json!({ "sessionId": "sess-keep", "title": "Active prompt" }),
                    ),
                },
            );
            map.insert(
                "30".to_string(),
                PendingPermissionEntry {
                    rpc_id: json!(30),
                    info: parse_permission_request(
                        "30".to_string(),
                        &json!({ "sessionId": "sess-other", "title": "Other stale prompt" }),
                    ),
                },
            );
        }

        let (stdin_tx, mut stdin_rx) = tokio::io::duplex(4096);
        let shared_stdin = Arc::new(Mutex::new(stdin_tx));
        let mut drained =
            drain_stale_session_permissions(&pending, &shared_stdin, "sess-keep").await;
        drained.sort();
        assert_eq!(drained, vec!["10".to_string(), "30".to_string()]);
        drop(shared_stdin);

        // Matching session entry MUST stay untouched in pending_permissions.
        {
            let remaining = pending.lock().await;
            assert_eq!(remaining.len(), 1);
            assert!(remaining.contains_key("20"));
            assert_eq!(remaining["20"].info.session_id, "sess-keep");
        }

        // Both stale entries received JSON-RPC cancelled replies.
        let mut reader = BufReader::new(&mut stdin_rx);
        let mut cancelled_ids: Vec<i64> = Vec::new();
        loop {
            match read_bounded_stdout_line(&mut reader, 4096).await.unwrap() {
                BoundedLineOutcome::Eof => break,
                BoundedLineOutcome::Line(line) => {
                    let v: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(v["result"]["outcome"]["outcome"], json!("cancelled"));
                    cancelled_ids.push(v["id"].as_i64().unwrap());
                }
                other => panic!("unexpected outcome: {other:?}"),
            }
        }
        cancelled_ids.sort();
        assert_eq!(cancelled_ids, vec![10, 30]);
    }
}
