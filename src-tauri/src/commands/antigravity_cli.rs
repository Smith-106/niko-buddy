//! Antigravity CLI (local) — Google Antigravity agentic IDE 的本地 binary 接入。
//!
//! 与 Claude Code / Codex CLI 同型：检测 PATH 上的 `antigravity` binary，用其
//! 本地订阅/登录态（Google 账号），不走 API key。spawn 走非交互 headless
//! prompt 模式（stdout JSONL 流 → emitter），kill 终止已注册子进程。
//!
//! 实际状况调整：Antigravity 内核为 Gemini；若 `antigravity` binary 缺失但
//! `gemini` 在，detect 报告 fallback_path，spawn 自动降级到 `gemini`——同一
//! Google 账号订阅、协议更成熟。webview 只能 spawn 这条固定命令，不能跑任意 shell。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::cli_resolver::{child_path_env, find_cli_command};
use super::local_cli_config::apply_local_cli_environment;

const VERSION_TIMEOUT_SECS: u64 = 5;
const DEFAULT_SPAWN_TIMEOUT_MINUTES: u64 = 10;
const MIN_SPAWN_TIMEOUT_MINUTES: u64 = 1;
const MAX_SPAWN_TIMEOUT_MINUTES: u64 = 240;
const STDERR_LIMIT_BYTES: usize = 1024 * 1024;
// 与 codex/claude 一致：stdout 上限 64MB，避免长文响应的管道缓冲死锁。
const STDOUT_LIMIT_BYTES: usize = 64 * 1024 * 1024;

// ── Event emitter abstraction ─────────────────────────────────────
/// 与 codex/claude 同款：emit 数据行 + done 信号。
pub trait AntigravityEmitter: Clone + Send + Sync + 'static {
    fn emit_data(&self, stream_id: &str, data: String);
    fn emit_done(&self, stream_id: &str, code: Option<i32>, stderr: String, stdout: String);
}

#[derive(Clone)]
pub struct TauriAntigravityEmitter {
    app: AppHandle,
}

impl TauriAntigravityEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AntigravityEmitter for TauriAntigravityEmitter {
    fn emit_data(&self, stream_id: &str, data: String) {
        let topic = format!("antigravity-cli:{stream_id}");
        let _ = self.app.emit(&topic, data);
    }
    fn emit_done(&self, stream_id: &str, code: Option<i32>, stderr: String, stdout: String) {
        let done_topic = format!("antigravity-cli:{stream_id}:done");
        let _ = self.app.emit(
            &done_topic,
            serde_json::json!({ "code": code, "stderr": stderr, "stdout": stdout }),
        );
    }
}

#[derive(Default)]
pub struct AntigravityCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    /// 内核降级候选（gemini binary）路径。
    fallback_path: Option<String>,
    model: Option<String>,
    error: Option<String>,
}

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

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

async fn find_antigravity_command() -> Result<std::path::PathBuf, String> {
    find_cli_command("antigravity", &["antigravity.cmd", "antigravity.exe"]).await
}

async fn find_gemini_fallback() -> Option<std::path::PathBuf> {
    find_cli_command("gemini", &["gemini.cmd", "gemini.exe"])
        .await
        .ok()
}

/// 实际 spawn 用：优先 antigravity，缺则 gemini 内核。
async fn resolve_spawn_command() -> Result<(std::path::PathBuf, bool), String> {
    match find_antigravity_command().await {
        Ok(p) => Ok((p, false)),
        Err(e) => match find_gemini_fallback().await {
            Some(g) => Ok((g, true)),
            None => Err(format!("antigravity not found and no gemini fallback. {e}")),
        },
    }
}

async fn probe_version(path: &std::path::Path) -> Result<Option<String>, String> {
    let mut cmd = Command::new(path);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    let output = tokio::time::timeout(
        Duration::from_secs(VERSION_TIMEOUT_SECS),
        cmd.arg("--version").output(),
    )
    .await;
    match output {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(Some(if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else {
                "antigravity".to_string()
            }))
        }
        Ok(Ok(out)) => Err(format!("`--version` exited with {}", out.status)),
        Ok(Err(e)) => Err(format!("Failed to spawn: {e}")),
        Err(_) => Err(format!(
            "`--version` timed out after {VERSION_TIMEOUT_SECS}s"
        )),
    }
}

pub async fn do_antigravity_cli_detect() -> Result<DetectResult, String> {
    let fallback = find_gemini_fallback().await;
    let fallback_str = fallback.as_ref().map(|p| p.to_string_lossy().to_string());

    let path = match find_antigravity_command().await {
        Ok(p) => p,
        Err(error) => {
            if let Some(gpath) = fallback {
                let gstr = gpath.to_string_lossy().to_string();
                let version = probe_version(&gpath).await.ok().flatten();
                return Ok(DetectResult {
                    installed: true,
                    version,
                    path: Some(gstr.clone()),
                    fallback_path: Some(gstr),
                    model: None,
                    error: Some(format!(
                        "antigravity not found; using gemini CLI kernel. {error}"
                    )),
                });
            }
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                fallback_path: fallback_str,
                model: None,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();
    match probe_version(&path).await {
        Ok(version) => Ok(DetectResult {
            installed: true,
            version,
            path: Some(path_str),
            fallback_path: fallback_str,
            model: None,
            error: None,
        }),
        Err(err) => Ok(DetectResult {
            installed: true,
            version: None,
            path: Some(path_str),
            fallback_path: fallback_str,
            model: None,
            error: Some(err),
        }),
    }
}

#[tauri::command]
pub async fn antigravity_cli_detect() -> Result<DetectResult, String> {
    do_antigravity_cli_detect().await
}

/// spawn 参数：antigravity 用 `agent --print`；gemini fallback 用
/// `-p <prompt> --output-format stream-json`（prompt 经 stdin 更稳，故仍传 "-" 占位）。
fn build_spawn_args(model: &str, is_gemini_fallback: bool) -> Vec<String> {
    if is_gemini_fallback {
        // Gemini CLI headless：stdin prompt + stream-json 输出。
        let mut a = vec![
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--yolo".to_string(), // 非交互，跳过确认
        ];
        if !model.trim().is_empty() {
            a.extend(["--model".to_string(), model.to_string()]);
        }
        a.push("-".to_string());
        a
    } else {
        // Antigravity agent headless：stdin prompt + JSONL 输出。
        let mut a = vec![
            "agent".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
        ];
        if !model.trim().is_empty() {
            a.extend(["--model".to_string(), model.to_string()]);
        }
        a.push("-".to_string());
        a
    }
}

fn spawn_timeout_minutes(value: Option<u64>) -> u64 {
    value
        .unwrap_or(DEFAULT_SPAWN_TIMEOUT_MINUTES)
        .clamp(MIN_SPAWN_TIMEOUT_MINUTES, MAX_SPAWN_TIMEOUT_MINUTES)
}

/// Spawn antigravity (or gemini fallback) headless and stream stdout back.
/// Shared by Tauri command and any standalone server handler.
pub async fn do_antigravity_cli_spawn<E: AntigravityEmitter>(
    state: &AntigravityCliState,
    emitter: E,
    stream_id: String,
    model: String,
    prompt: String,
    timeout_minutes: Option<u64>,
) -> Result<(), String> {
    let cli_target = std::env::current_dir()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_else(|_| "cli".to_string());
    let gate = crate::agent_gate::gate_authorize(
        "runCommand",
        &cli_target,
        crate::agent_gate::GateActor::Cli,
    );
    if !gate.may_proceed() {
        return Err(crate::agent_gate::gate_error(&gate));
    }
    if prompt.trim().is_empty() {
        return Err("No prompt to send to antigravity CLI".to_string());
    }

    let (bin, is_gemini) = resolve_spawn_command().await?;
    let mut cmd = Command::new(&bin);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.args(build_spawn_args(&model, is_gemini));

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn antigravity: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to antigravity stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush antigravity stdin: {e}"))?;
    drop(stdin);

    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let timeout_children = Arc::clone(&state.children);
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&timed_out);
    let timeout_stream_id = stream_id.clone();
    let timeout_minutes = spawn_timeout_minutes(timeout_minutes);
    let timeout_duration = Duration::from_secs(timeout_minutes * 60);
    let stream_id_task = stream_id.clone();
    let emitter_task = emitter.clone();

    tokio::spawn(async move {
        tokio::time::sleep(timeout_duration).await;
        if let Some(mut child) = timeout_children.lock().await.remove(&timeout_stream_id) {
            timeout_flag.store(true, Ordering::SeqCst);
            let _ = child.start_kill();
        }
    });

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                log::debug!("[antigravity-cli stderr] {line}");
                append_capped_line(&mut collected, &line, STDERR_LIMIT_BYTES);
            }
            collected
        });

        let mut stdout_text = String::new();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    append_capped_line(&mut stdout_text, &line, STDOUT_LIMIT_BYTES);
                    emitter_task.emit_data(&stream_id_task, line);
                }
                Ok(None) => break,
                Err(e) => {
                    log::error!("[antigravity-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            None
        };

        let mut stderr_text = stderr_task.await.unwrap_or_default();
        if timed_out.load(Ordering::SeqCst) {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&format!(
                "Antigravity CLI timed out after {timeout_minutes} minutes."
            ));
        } else if stderr_text.len() >= STDERR_LIMIT_BYTES {
            stderr_text.push_str("\n[stderr truncated]");
        }
        if stdout_text.len() >= STDOUT_LIMIT_BYTES {
            stdout_text.push_str("\n[stdout truncated]");
        }

        let code = if timed_out.load(Ordering::SeqCst) {
            Some(-1)
        } else {
            exit_code
        };
        emitter_task.emit_done(&stream_id_task, code, stderr_text, stdout_text);
    });

    Ok(())
}

#[tauri::command]
pub async fn antigravity_cli_spawn(
    app: AppHandle,
    state: State<'_, AntigravityCliState>,
    stream_id: String,
    model: String,
    prompt: String,
    timeout_minutes: Option<u64>,
) -> Result<(), String> {
    let emitter = TauriAntigravityEmitter::new(app);
    do_antigravity_cli_spawn(&state, emitter, stream_id, model, prompt, timeout_minutes).await
}

/// Kill a running child registered under `stream_id`. No-op if unknown.
pub async fn do_antigravity_cli_kill(
    state: &AntigravityCliState,
    stream_id: &str,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(stream_id) {
        let _ = child.start_kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn antigravity_cli_kill(
    state: State<'_, AntigravityCliState>,
    stream_id: String,
) -> Result<(), String> {
    do_antigravity_cli_kill(&state, &stream_id).await
}
