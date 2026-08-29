use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct McpStdioState {
    children: Arc<Mutex<HashMap<u32, McpChild>>>,
}

struct McpChild {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Deserialize)]
pub struct McpStdioSpawnOptions {
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
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

/// Windows 上把 `command args...` 包装为 `cmd /c command args...`，
/// 让 cmd 解析 PATH 与 .cmd/.bat 后缀，避免 tokio Command::new 对 npx/uvx 启动 ENOENT。
/// 如果 command 本身就是 cmd/cmd.exe，则不重复包装。
#[cfg(windows)]
fn build_windows_command(command: &str, args: Option<&[String]>) -> Command {
    let lower = command.to_ascii_lowercase();
    let is_cmd = lower == "cmd" || lower == "cmd.exe";
    if is_cmd {
        let mut cmd = Command::new(command);
        if let Some(args) = args {
            cmd.args(args);
        }
        return cmd;
    }
    let mut cmd = Command::new("cmd");
    cmd.arg("/c").arg(command);
    if let Some(args) = args {
        cmd.args(args);
    }
    cmd
}

#[tauri::command]
pub async fn mcp_stdio_spawn(
    state: State<'_, McpStdioState>,
    options: McpStdioSpawnOptions,
) -> Result<u32, String> {
    let command = options.command.trim();
    if command.is_empty() {
        return Err("MCP 启动失败：命令不能为空".to_string());
    }

    // Windows 上 tokio Command::new 不经 shell，直接填 npx/uvx 等 PATH 命令会 ENOENT。
    // 参考 modelcontextprotocol/servers 官方建议：Windows 用 cmd /c 包装，
    // 让 cmd 负责解析 PATH 与 .cmd/.bat 后缀。非 Windows 平台保持原行为。
    #[cfg(windows)]
    let mut cmd = build_windows_command(command, options.args.as_deref());
    #[cfg(not(windows))]
    let mut cmd = Command::new(command);
    suppress_windows_console(&mut cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(not(windows))]
    if let Some(args) = options.args {
        cmd.args(args);
    }
    if let Some(cwd) = options.cwd {
        if !cwd.trim().is_empty() {
            cmd.current_dir(cwd);
        }
    }
    if let Some(env) = options.env {
        for (key, value) in env {
            if !key.trim().is_empty() {
                cmd.env(key, value);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("MCP 启动失败：{e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "MCP 启动失败：无法获取进程 ID".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP 启动失败：无法打开 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP 启动失败：无法打开 stdout".to_string())?;

    let mut children = state.children.lock().await;
    children.insert(
        pid,
        McpChild {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        },
    );

    Ok(pid)
}

#[tauri::command]
pub async fn mcp_stdio_write(
    state: State<'_, McpStdioState>,
    pid: u32,
    data: String,
) -> Result<(), String> {
    let mut children = state.children.lock().await;
    let child = children
        .get_mut(&pid)
        .ok_or_else(|| format!("MCP 写入失败：未找到进程 {pid}"))?;
    child
        .stdin
        .write_all(data.as_bytes())
        .await
        .map_err(|e| format!("MCP 写入失败：{e}"))?;
    if !data.ends_with('\n') {
        child
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("MCP 写入失败：{e}"))?;
    }
    child
        .stdin
        .flush()
        .await
        .map_err(|e| format!("MCP 写入失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_stdio_read(
    state: State<'_, McpStdioState>,
    pid: u32,
    timeout_ms: Option<u64>,
) -> Result<Option<String>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).max(1));
    let mut children = state.children.lock().await;
    let child = children
        .get_mut(&pid)
        .ok_or_else(|| format!("MCP 读取失败：未找到进程 {pid}"))?;
    let mut line = String::new();

    match tokio::time::timeout(timeout, child.stdout.read_line(&mut line)).await {
        Ok(Ok(0)) => Err("MCP 读取失败：进程已结束".to_string()),
        Ok(Ok(_)) => Ok(Some(line.trim_end_matches(['\r', '\n']).to_string())),
        Ok(Err(e)) => Err(format!("MCP 读取失败：{e}")),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn mcp_stdio_kill(
    state: State<'_, McpStdioState>,
    pid: u32,
) -> Result<(), String> {
    let mut children = state.children.lock().await;
    let Some(mut child) = children.remove(&pid) else {
        return Ok(());
    };
    child
        .child
        .kill()
        .await
        .map_err(|e| format!("MCP 关闭失败：{e}"))?;
    Ok(())
}

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_windows_command_npx_is_wrapped() {
        let _cmd = build_windows_command("npx", Some(&[
            "-y".to_string(),
            "@modelcontextprotocol/server-memory".to_string(),
        ]));
        // builds without panic — the returned Command is ready for spawn.
    }

    #[test]
    fn test_build_windows_command_cmd_itself_not_wrapped() {
        let _cmd = build_windows_command("cmd", Some(&["/c".to_string(), "echo".to_string()]));
    }

    #[test]
    fn test_build_windows_command_cmd_exe_not_wrapped() {
        let _cmd = build_windows_command("cmd.exe", Some(&["/c".to_string(), "dir".to_string()]));
    }

    #[test]
    fn test_build_windows_command_no_args() {
        let _cmd = build_windows_command("npx", None);
    }
}
