use std::collections::HashMap;
#[cfg(windows)]
use std::ffi::{OsStr, OsString};
#[cfg(windows)]
use std::path::Component;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use super::process_tree::{self, ProcessTree};

const MAX_MCP_STDIO_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MCP_STDIO_CHILDREN: usize = 16;
const MAX_MCP_STDIO_TIMEOUT_MS: u64 = 300_000;
const MAX_MCP_STDIO_WRITE_BYTES: usize = 4 * 1024 * 1024;

#[cfg(windows)]
const MAX_CMD_SHIM_INSPECT_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub struct McpStdioState {
    /// 进程表锁仅用于查找/插入/摘除句柄，绝不跨 IO `.await` 持有。
    children: Arc<Mutex<HashMap<u32, Arc<McpChildHandle>>>>,
}

struct McpChildHandle {
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<McpStdoutReader>,
    process: Mutex<McpChildProcess>,
}

struct McpStdoutReader {
    reader: BufReader<ChildStdout>,
    /// 超时取消时保留尚未遇到 `\n` 的半行字节，避免 JSON-RPC 帧被截断丢失。
    partial: Vec<u8>,
    /// 单行超限后排空至下一个 `\n` 的状态标记，避免跨 chunk 超长行残片污染后续 JSON-RPC 帧。
    discarding_overflow: bool,
}

struct McpChildProcess {
    child: Child,
    tree: Option<ProcessTree>,
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

fn reject_control_line_chars(value: &str, label: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n']) {
        return Err(format!("MCP 启动失败：{label} 包含非法控制字符"));
    }
    Ok(())
}

/// 禁止通过 `options.env` 覆写的危险环境变量精确黑名单（大小写不敏感）。
const FORBIDDEN_SPAWN_ENV_KEYS: [&str; 20] = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "LD_DEBUG",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "RUBYOPT",
    "RUBYLIB",
    "PERL5OPT",
    "PERL5LIB",
    "BASH_ENV",
    "ENV",
    "IFS",
    "COMSPEC",
    "PATHEXT",
    "PROMPT_COMMAND",
    "ELECTRON_RUN_AS_NODE",
    "PATH",
    "APPDATA",
    "USERPROFILE",
];

/// 禁止通过 `options.env` 覆写的危险环境变量前缀（大小写不敏感）。
const FORBIDDEN_SPAWN_ENV_PREFIXES: [&str; 3] = ["DYLD_", "PYTHON", "BASH_FUNC_"];

/// 校验子进程环境变量：拒空 key、非法字符与进程劫持类环境变量，且错误消息绝不回显 value。
fn validate_spawn_env(env: &HashMap<String, String>) -> Result<(), String> {
    for (key, value) in env {
        let trimmed_key = key.trim();
        if trimmed_key.is_empty() {
            return Err("MCP 启动失败：环境变量名不能为空".to_string());
        }
        if key.contains('=') || key.chars().any(|c| c == '\0' || c.is_control()) {
            return Err("MCP 启动失败：环境变量名包含非法字符".to_string());
        }
        if value.chars().any(|c| c == '\0' || c.is_control()) {
            return Err(format!(
                "MCP 启动失败：环境变量 `{trimmed_key}` 的值包含非法控制字符"
            ));
        }
        let upper = trimmed_key.to_ascii_uppercase();
        if FORBIDDEN_SPAWN_ENV_KEYS.contains(&upper.as_str())
            || FORBIDDEN_SPAWN_ENV_PREFIXES
                .iter()
                .any(|prefix| upper.starts_with(prefix))
        {
            return Err(format!(
                "MCP 启动失败：禁止覆写受保护环境变量 `{trimmed_key}`"
            ));
        }
    }
    Ok(())
}

fn check_resolved_program_gate(program: &Path) -> Result<(), String> {
    let resolved_program = program.to_string_lossy();
    if crate::agent_gate::is_protected_target(&resolved_program) {
        let resolved_gate = crate::agent_gate::gate_authorize(
            "runCommand",
            &resolved_program,
            crate::agent_gate::GateActor::Cli,
        );
        if !resolved_gate.may_proceed() {
            return Err(crate::agent_gate::gate_error(&resolved_gate));
        }
    }
    Ok(())
}

fn clamp_mcp_read_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(30_000)
        .clamp(1, MAX_MCP_STDIO_TIMEOUT_MS)
}

#[cfg(not(windows))]
fn resolve_unix_executable(command: &str, cwd: &Path) -> Result<PathBuf, String> {
    let cmd_path = Path::new(command);
    let resolved = if command.contains('/') {
        let candidate = if cmd_path.is_absolute() {
            cmd_path.to_path_buf()
        } else {
            cwd.join(cmd_path)
        };
        if candidate.is_file() {
            candidate
        } else {
            return Err(format!("MCP 启动失败：找不到可执行文件 `{command}`"));
        }
    } else {
        let host_path = std::env::var_os("PATH");
        which::which_in(command, host_path.as_deref(), cwd)
            .map_err(|_| format!("MCP 启动失败：在 PATH 中找不到 `{command}`"))?
    };
    std::fs::canonicalize(&resolved)
        .map_err(|e| format!("MCP 启动失败：无法规范化可执行文件路径 `{command}`：{e}"))
}

fn validate_spawn_inputs<'a>(
    command: &'a str,
    args: &[String],
    cwd: Option<&'a str>,
) -> Result<(&'a str, Option<&'a str>), String> {
    reject_control_line_chars(command, "命令")?;
    let trimmed_cmd = command.trim();
    if trimmed_cmd.is_empty() {
        return Err("MCP 启动失败：命令不能为空".to_string());
    }
    for (idx, arg) in args.iter().enumerate() {
        reject_control_line_chars(arg, &format!("第 {} 个参数", idx + 1))?;
    }
    let trimmed_cwd = match cwd {
        Some(raw_cwd) => {
            reject_control_line_chars(raw_cwd, "工作目录")?;
            let trimmed = raw_cwd.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        None => None,
    };
    Ok((trimmed_cmd, trimmed_cwd))
}

/// 构造 `agent_gate` 目标：
/// - 若 `command` 或 `cwd` 命中真源保护区，原样上送保护目标，触发硬拒绝；
/// - 否则把 `(command, args, cwd)` 长度前缀哈希后纳入 `#req=`，使不同 MCP 服务拥有不同指纹，
///   避免连续启动 3 个不同 MCP 误触发循环熔断。
fn build_mcp_gate_target(command: &str, args: &[String], cwd: Option<&str>) -> String {
    if crate::agent_gate::is_protected_target(command) {
        return command.to_string();
    }
    if let Some(dir) = cwd {
        if crate::agent_gate::is_protected_target(dir) {
            return dir.to_string();
        }
    }

    let mut hasher = Sha256::new();
    let mut feed = |bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    feed(command.as_bytes());
    feed(&(args.len() as u64).to_le_bytes());
    for arg in args {
        feed(arg.as_bytes());
    }
    if let Some(dir) = cwd {
        feed(b"cwd");
        feed(dir.as_bytes());
    } else {
        feed(b"no-cwd");
    }
    let digest = hasher.finalize();
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();

    let label_raw = command
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or("mcp")
        .to_string();
    let label: String = label_raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let label = if label.is_empty() || label == "." || label == ".." {
        "mcp"
    } else {
        label.as_str()
    };
    format!("mcp-stdio/{label}#req={hex}")
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsLaunchSpec {
    program: PathBuf,
    args: Vec<String>,
}

#[cfg(windows)]
fn normalized_windows_leaf_name(raw: &str) -> String {
    let normalized = raw.trim().replace('\\', "/");
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    // 先剥离前导盘符前缀（如 `C:cmd.exe`），再按 `:` 剥离 NTFS ADS，避免盘符绕过。
    let without_drive = if file_name.len() >= 2
        && file_name.as_bytes()[0].is_ascii_alphabetic()
        && file_name.as_bytes()[1] == b':'
    {
        &file_name[2..]
    } else {
        file_name
    };
    let without_ads = without_drive.split(':').next().unwrap_or(without_drive);
    without_ads
        .trim_end_matches(['.', ' '])
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn is_forbidden_windows_shell(command: &str) -> bool {
    let clean = normalized_windows_leaf_name(command);
    matches!(clean.as_str(), "cmd" | "cmd.exe" | "command.com")
}

#[cfg(windows)]
fn is_batch_extension(path: &Path) -> bool {
    let clean = normalized_windows_leaf_name(&path.to_string_lossy());
    clean.ends_with(".cmd") || clean.ends_with(".bat")
}

/// 无法拆包的 `.cmd`/`.bat` 禁止包含 cmd.exe 元字符及控制字符，防止批处理参数注入。
#[cfg(windows)]
fn reject_windows_batch_metachars(value: &str, label: &str) -> Result<(), String> {
    const FORBIDDEN: [char; 12] = ['&', '|', '<', '>', '^', '%', '!', '"', '(', ')', ';', '`'];
    if let Some(ch) = value
        .chars()
        .find(|ch| ch.is_control() || FORBIDDEN.contains(ch))
    {
        return Err(format!(
            "MCP 启动失败：{label} 包含批处理禁用字符（{ch:?}）"
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn build_windows_search_paths() -> Option<OsString> {
    let base_path = std::env::var_os("PATH");

    let mut dirs: Vec<PathBuf> = base_path
        .as_deref()
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();

    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);

    let npm_dir = app_data
        .map(|dir| dir.join("npm"))
        .or_else(|| user_profile.map(|dir| dir.join("AppData").join("Roaming").join("npm")))
        .filter(|dir| dir.is_dir());

    if let Some(npm_dir) = npm_dir {
        let npm_lower = npm_dir.to_string_lossy().to_ascii_lowercase();
        let already_present = dirs
            .iter()
            .any(|d| d.to_string_lossy().to_ascii_lowercase() == npm_lower);
        if !already_present {
            dirs.push(npm_dir);
        }
    }

    if dirs.is_empty() {
        None
    } else {
        std::env::join_paths(dirs).ok()
    }
}

#[cfg(windows)]
struct ResolvedWindowsExecutable {
    original: PathBuf,
    canonical: PathBuf,
}

#[cfg(windows)]
fn resolve_windows_executable(
    command: &str,
    search_paths: Option<&OsStr>,
    cwd: &Path,
) -> Result<ResolvedWindowsExecutable, String> {
    if is_forbidden_windows_shell(command) {
        return Err(
            "MCP 启动失败：禁止直接调用 Windows 命令行解释器（cmd / command.com）".to_string(),
        );
    }

    let cmd_path = Path::new(command);
    // 显式拒绝盘符相对路径（如 `C:tool.exe`），防止依赖进程隐式每盘当前目录。
    if !cmd_path.is_absolute() && matches!(cmd_path.components().next(), Some(Component::Prefix(_)))
    {
        return Err(format!(
            "MCP 启动失败：禁止使用 Windows 盘符相对路径 `{command}`"
        ));
    }

    // 拒绝普通路径段含 NTFS ADS (`:`) 或 Windows 自动剥离的尾部 `.` / 空格（如 `.cmd.` / `.cmd .` / `.cmd::$DATA`）。
    for comp in cmd_path.components() {
        if let Component::Normal(seg) = comp {
            let seg_str = seg.to_string_lossy();
            if seg_str.contains(':') || seg_str.ends_with('.') || seg_str.ends_with(' ') {
                return Err(format!(
                    "MCP 启动失败：命令路径段 `{seg_str}` 包含非法 NTFS 数据流或尾部点/空格"
                ));
            }
        }
    }

    let has_path_sep = command.contains('\\') || command.contains('/');
    let has_explicit_ext = cmd_path.extension().is_some();

    let resolved = if has_explicit_ext {
        if has_path_sep {
            let candidate = if cmd_path.is_absolute() {
                cmd_path.to_path_buf()
            } else {
                cwd.join(cmd_path)
            };
            if candidate.is_file() {
                candidate
            } else {
                which::which_in(command, search_paths, cwd)
                    .map_err(|_| format!("MCP 启动失败：找不到可执行文件 `{command}`"))?
            }
        } else {
            which::which_in(command, search_paths, cwd)
                .map_err(|_| format!("MCP 启动失败：在 PATH 中找不到 `{command}`"))?
        }
    } else {
        // 优先直接可执行文件（.exe / .com），其次才落到 .cmd / .bat。
        let mut found = None;
        for ext in ["exe", "com", "cmd", "bat"] {
            let candidate_name = format!("{command}.{ext}");
            if has_path_sep {
                let candidate_path = if cmd_path.is_absolute() {
                    PathBuf::from(&candidate_name)
                } else {
                    cwd.join(&candidate_name)
                };
                if candidate_path.is_file() {
                    found = Some(candidate_path);
                    break;
                }
            } else if let Ok(path) = which::which_in(&candidate_name, search_paths, cwd) {
                found = Some(path);
                break;
            }
        }
        if let Some(path) = found {
            path
        } else if has_path_sep {
            let candidate_path = if cmd_path.is_absolute() {
                cmd_path.to_path_buf()
            } else {
                cwd.join(cmd_path)
            };
            if candidate_path.is_file() {
                candidate_path
            } else {
                which::which_in(command, search_paths, cwd)
                    .map_err(|_| format!("MCP 启动失败：找不到可执行文件 `{command}`"))?
            }
        } else {
            which::which_in(command, search_paths, cwd)
                .map_err(|_| format!("MCP 启动失败：在 PATH 中找不到 `{command}`"))?
        }
    };

    let canonical = match std::fs::canonicalize(&resolved) {
        Ok(canon) => PathBuf::from(strip_windows_verbatim_prefix(&canon)),
        Err(_) => resolved.clone(),
    };

    if is_forbidden_windows_shell(&resolved.to_string_lossy())
        || is_forbidden_windows_shell(&canonical.to_string_lossy())
    {
        return Err(
            "MCP 启动失败：禁止直接调用 Windows 命令行解释器（cmd / command.com）".to_string(),
        );
    }
    Ok(ResolvedWindowsExecutable {
        original: resolved,
        canonical,
    })
}

#[cfg(windows)]
fn strip_windows_verbatim_prefix(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    }
}

#[cfg(windows)]
fn ends_with_node_invoker(prefix: &str) -> bool {
    let lower = prefix.trim_end().to_ascii_lowercase();
    for invoker in [
        "\"%_prog%\"",
        "\"%~dp0\\node.exe\"",
        "\"%~dp0/node.exe\"",
        "\"%~dp0node.exe\"",
        "\"%dp0%\\node.exe\"",
        "\"%dp0%/node.exe\"",
        "\"%dp0%node.exe\"",
        "\"node.exe\"",
        "\"node\"",
        "node.exe",
        "node",
    ] {
        if let Some(before) = lower.strip_suffix(invoker) {
            if before.is_empty()
                || before
                    .chars()
                    .last()
                    .is_some_and(|ch| ch.is_ascii_whitespace() || ch == '&' || ch == '|')
            {
                return true;
            }
        }
    }
    false
}

#[cfg(windows)]
fn strip_cmd_shim_dp0_prefix(token: &str) -> Option<&str> {
    let lower = token.to_ascii_lowercase();
    for prefix in ["%dp0%\\", "%dp0%/", "%dp0%", "%~dp0\\", "%~dp0/", "%~dp0"] {
        if lower.starts_with(prefix) {
            let rest = token[prefix.len()..].trim_start_matches(['\\', '/']);
            if !rest.is_empty() {
                return Some(rest);
            }
        }
    }
    None
}

#[cfg(windows)]
fn parse_npm_cmd_shim_script(content: &str) -> Option<String> {
    for raw_line in content.lines() {
        let line = raw_line.trim();
        let Some(before_star) = line.strip_suffix("%*") else {
            continue;
        };
        if !before_star
            .chars()
            .last()
            .is_some_and(|ch| ch.is_ascii_whitespace())
        {
            continue;
        }
        let before_args = before_star.trim_end();
        let Some(without_end_quote) = before_args.strip_suffix('"') else {
            continue;
        };
        let Some(open_quote_idx) = without_end_quote.rfind('"') else {
            continue;
        };
        let script_token = &without_end_quote[open_quote_idx + 1..];
        let before_script = without_end_quote[..open_quote_idx].trim_end();
        if !ends_with_node_invoker(before_script) {
            continue;
        }
        if let Some(rel) = strip_cmd_shim_dp0_prefix(script_token) {
            return Some(rel.to_string());
        }
    }
    None
}

#[cfg(windows)]
fn validate_unpacked_js_script(shim_dir: &Path, rel_path: &str) -> Option<PathBuf> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty()
        || trimmed.chars().any(|c| c.is_control())
        || trimmed.contains(['%', '"', ':', '*', '?', '<', '>', '|'])
    {
        return None;
    }
    let rel = Path::new(trimmed);
    if rel.is_absolute()
        || rel.has_root()
        || rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let ext = rel.extension().and_then(|e| e.to_str())?;
    if !matches!(ext.to_ascii_lowercase().as_str(), "js" | "cjs" | "mjs") {
        return None;
    }
    let canon_dir = std::fs::canonicalize(shim_dir).ok()?;
    let candidate = shim_dir.join(rel);
    let meta = std::fs::symlink_metadata(&candidate).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    let canon_script = std::fs::canonicalize(&candidate).ok()?;
    if !canon_script.starts_with(&canon_dir) {
        return None;
    }
    if crate::agent_gate::is_protected_target(&canon_script.to_string_lossy()) {
        return None;
    }
    Some(canon_script)
}

#[cfg(windows)]
fn find_windows_node_exe(
    shim_dir: &Path,
    search_paths: Option<&OsStr>,
    cwd: &Path,
) -> Option<PathBuf> {
    let candidate = {
        let sibling = shim_dir.join("node.exe");
        if sibling.is_file() {
            sibling
        } else {
            which::which_in("node.exe", search_paths, cwd).ok()?
        }
    };
    if !candidate.is_file() {
        return None;
    }
    let canonical = match std::fs::canonicalize(&candidate) {
        Ok(canon) => PathBuf::from(strip_windows_verbatim_prefix(&canon)),
        Err(_) => candidate.clone(),
    };
    if is_forbidden_windows_shell(&candidate.to_string_lossy())
        || is_forbidden_windows_shell(&canonical.to_string_lossy())
        || is_batch_extension(&candidate)
        || is_batch_extension(&canonical)
    {
        return None;
    }
    Some(canonical)
}

#[cfg(windows)]
fn try_unpack_windows_npm_shim(
    batch_path: &Path,
    args: &[String],
    search_paths: Option<&OsStr>,
    cwd: &Path,
) -> Option<WindowsLaunchSpec> {
    let shim_dir = batch_path.parent()?;
    let file_name_lower = batch_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mut script_canon = if file_name_lower == "npx.cmd" {
        validate_unpacked_js_script(shim_dir, r"node_modules\npm\bin\npx-cli.js")
    } else if file_name_lower == "npm.cmd" {
        validate_unpacked_js_script(shim_dir, r"node_modules\npm\bin\npm-cli.js")
    } else {
        None
    };

    if script_canon.is_none() {
        let meta = std::fs::metadata(batch_path).ok()?;
        if meta.len() <= MAX_CMD_SHIM_INSPECT_BYTES {
            let content = std::fs::read_to_string(batch_path).ok()?;
            if let Some(rel_script) = parse_npm_cmd_shim_script(&content) {
                script_canon = validate_unpacked_js_script(shim_dir, &rel_script);
            }
        }
    }

    let script_canon = script_canon?;
    let node_exe = find_windows_node_exe(shim_dir, search_paths, cwd)?;
    let script_arg = strip_windows_verbatim_prefix(&script_canon);
    let mut launch_args = Vec::with_capacity(args.len() + 1);
    launch_args.push(script_arg);
    launch_args.extend(args.iter().cloned());
    Some(WindowsLaunchSpec {
        program: node_exe,
        args: launch_args,
    })
}

/// Windows 安全启动解析：绝不手拼 `cmd /c`。
#[cfg(windows)]
fn resolve_windows_launch(
    command: &str,
    args: &[String],
    search_paths: Option<&OsStr>,
    cwd: &Path,
) -> Result<WindowsLaunchSpec, String> {
    let resolved = resolve_windows_executable(command, search_paths, cwd)?;
    if is_batch_extension(&resolved.original) || is_batch_extension(&resolved.canonical) {
        if let Some(unpacked) =
            try_unpack_windows_npm_shim(&resolved.canonical, args, search_paths, cwd).or_else(
                || try_unpack_windows_npm_shim(&resolved.original, args, search_paths, cwd),
            )
        {
            return Ok(unpacked);
        }
        reject_windows_batch_metachars(&resolved.original.to_string_lossy(), "批处理路径")?;
        reject_windows_batch_metachars(&resolved.canonical.to_string_lossy(), "批处理路径")?;
        for (idx, arg) in args.iter().enumerate() {
            reject_windows_batch_metachars(arg, &format!("第 {} 个参数", idx + 1))?;
        }
    }
    Ok(WindowsLaunchSpec {
        program: resolved.canonical,
        args: args.to_vec(),
    })
}

fn trim_line_endings(buf: &mut Vec<u8>) {
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
}

/// 有界按行读取（取消安全、跨 chunk 溢出不发生帧错位）：
/// - 单行上限 `max_bytes`，超限时清空 `partial`、置 `discarding_overflow = true` 并排空至下一个 `\n`（或 EOF）后报错；
/// - 若排空期间被外层 `tokio::time::timeout` 取消，下次调用检测到 `discarding_overflow == true` 会先继续排空至 `\n`；
/// - 正常半行遇 `tokio::time::timeout` 取消时保留 `partial` 中已读字节，下次读取无缝续拼；
/// - EOF 且无残余半行返回 `Ok(None)`。
async fn read_line_bounded<R>(
    reader: &mut R,
    partial: &mut Vec<u8>,
    discarding_overflow: &mut bool,
    max_bytes: usize,
) -> Result<Option<String>, String>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        if *discarding_overflow {
            partial.clear();
            let available = reader
                .fill_buf()
                .await
                .map_err(|e| format!("MCP 读取失败：{e}"))?;
            if available.is_empty() {
                *discarding_overflow = false;
                return Err(format!(
                    "MCP 读取失败：单行输出超过上限（{max_bytes} 字节）"
                ));
            }
            if let Some(newline_idx) = available.iter().position(|&b| b == b'\n') {
                reader.consume(newline_idx + 1);
                *discarding_overflow = false;
                return Err(format!(
                    "MCP 读取失败：单行输出超过上限（{max_bytes} 字节）"
                ));
            }
            let avail_len = available.len();
            reader.consume(avail_len);
            continue;
        }

        if let Some(pos) = partial.iter().position(|&b| b == b'\n') {
            let mut line_bytes: Vec<u8> = partial.drain(..=pos).collect();
            trim_line_endings(&mut line_bytes);
            if line_bytes.len() > max_bytes {
                return Err(format!(
                    "MCP 读取失败：单行输出超过上限（{max_bytes} 字节）"
                ));
            }
            let text = String::from_utf8(line_bytes)
                .map_err(|e| format!("MCP 读取失败：输出不是有效 UTF-8：{e}"))?;
            return Ok(Some(text));
        }

        let available = reader
            .fill_buf()
            .await
            .map_err(|e| format!("MCP 读取失败：{e}"))?;

        if available.is_empty() {
            if partial.is_empty() {
                return Ok(None);
            }
            let mut line_bytes = std::mem::take(partial);
            trim_line_endings(&mut line_bytes);
            if line_bytes.len() > max_bytes {
                return Err(format!(
                    "MCP 读取失败：单行输出超过上限（{max_bytes} 字节）"
                ));
            }
            let text = String::from_utf8(line_bytes)
                .map_err(|e| format!("MCP 读取失败：输出不是有效 UTF-8：{e}"))?;
            return Ok(Some(text));
        }

        if let Some(newline_idx) = available.iter().position(|&b| b == b'\n') {
            let take_len = newline_idx + 1;
            let mut slice = &available[..newline_idx];
            let mut drop_partial_cr = false;
            if let Some(without_cr) = slice.strip_suffix(b"\r") {
                slice = without_cr;
            } else if slice.is_empty() && partial.last() == Some(&b'\r') {
                drop_partial_cr = true;
            }
            let effective_len = partial
                .len()
                .saturating_sub(usize::from(drop_partial_cr))
                .saturating_add(slice.len());
            if effective_len > max_bytes {
                reader.consume(take_len);
                partial.clear();
                return Err(format!(
                    "MCP 读取失败：单行输出超过上限（{max_bytes} 字节）"
                ));
            }
            if drop_partial_cr {
                partial.pop();
            }
            partial.extend_from_slice(slice);
            reader.consume(take_len);
            let mut line_bytes = std::mem::take(partial);
            trim_line_endings(&mut line_bytes);
            let text = String::from_utf8(line_bytes)
                .map_err(|e| format!("MCP 读取失败：输出不是有效 UTF-8：{e}"))?;
            return Ok(Some(text));
        }

        let avail_len = available.len();
        let projected = partial.len().saturating_add(avail_len);
        let trailing_cr_only =
            projected == max_bytes.saturating_add(1) && available.last() == Some(&b'\r');
        if projected > max_bytes && !trailing_cr_only {
            reader.consume(avail_len);
            partial.clear();
            *discarding_overflow = true;
            continue;
        }
        partial.extend_from_slice(available);
        reader.consume(avail_len);
    }
}

fn ensure_child_capacity(active_count: usize) -> Result<(), String> {
    if active_count >= MAX_MCP_STDIO_CHILDREN {
        return Err(format!(
            "MCP 启动失败：活跃子进程数量已达上限（{MAX_MCP_STDIO_CHILDREN}）"
        ));
    }
    Ok(())
}

async fn reap_exited_children(state: &McpStdioState) -> usize {
    let snapshot: Vec<(u32, Arc<McpChildHandle>)> = {
        let children = state.children.lock().await;
        children
            .iter()
            .map(|(&pid, h)| (pid, Arc::clone(h)))
            .collect()
    };
    let mut dead = Vec::new();
    for (pid, handle) in snapshot {
        let mut proc_guard = handle.process.lock().await;
        if matches!(proc_guard.child.try_wait(), Ok(Some(_))) {
            dead.push((pid, Arc::clone(&handle)));
        }
    }
    let mut children = state.children.lock().await;
    for (pid, handle) in dead {
        if children
            .get(&pid)
            .is_some_and(|existing| Arc::ptr_eq(existing, &handle))
        {
            children.remove(&pid);
        }
    }
    children.len()
}

async fn terminate_child_process(handle: &Arc<McpChildHandle>) -> Result<(), String> {
    let mut proc_guard = handle.process.lock().await;
    let terminated_tree = if let Some(mut tree) = proc_guard.tree.take() {
        tree.terminate();
        true
    } else {
        false
    };
    match proc_guard.child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) | Err(_) => match proc_guard.child.kill().await {
            Ok(()) => Ok(()),
            Err(e) => {
                if terminated_tree
                    && tokio::time::timeout(Duration::from_secs(2), proc_guard.child.wait())
                        .await
                        .is_ok_and(|res| res.is_ok())
                {
                    Ok(())
                } else {
                    Err(format!("MCP 关闭失败：{e}"))
                }
            }
        },
    }
}

async fn cleanup_dead_handle(state: &McpStdioState, pid: u32, handle: &Arc<McpChildHandle>) {
    let removed = {
        let mut children = state.children.lock().await;
        if children
            .get(&pid)
            .is_some_and(|existing| Arc::ptr_eq(existing, handle))
        {
            children.remove(&pid)
        } else {
            None
        }
    };
    if let Some(dead) = removed {
        let _ = terminate_child_process(&dead).await;
    }
}

async fn spawn_mcp_stdio_process(
    state: &McpStdioState,
    options: McpStdioSpawnOptions,
) -> Result<u32, String> {
    let args = options.args.unwrap_or_default();
    let (command, cwd) = validate_spawn_inputs(&options.command, &args, options.cwd.as_deref())?;
    if let Some(env) = options.env.as_ref() {
        validate_spawn_env(env)?;
    }

    let gate_target = build_mcp_gate_target(command, &args, cwd);
    let gate = crate::agent_gate::gate_authorize(
        "runCommand",
        &gate_target,
        crate::agent_gate::GateActor::Cli,
    );
    if !gate.may_proceed() {
        return Err(crate::agent_gate::gate_error(&gate));
    }

    if let Some(canon_dir) = cwd.and_then(|dir| std::fs::canonicalize(dir).ok()) {
        check_resolved_program_gate(&canon_dir)?;
    }

    let active_children = reap_exited_children(state).await;
    ensure_child_capacity(active_children)?;

    #[cfg(windows)]
    let mut cmd = {
        let search_paths = build_windows_search_paths();
        let effective_cwd = cwd.map(Path::new).unwrap_or_else(|| Path::new("."));
        let spec = resolve_windows_launch(command, &args, search_paths.as_deref(), effective_cwd)?;
        check_resolved_program_gate(&spec.program)?;
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let effective_cwd = cwd.map(Path::new).unwrap_or_else(|| Path::new("."));
        let canonical = resolve_unix_executable(command, effective_cwd)?;
        check_resolved_program_gate(&canonical)?;
        let mut cmd = Command::new(&canonical);
        cmd.args(&args);
        cmd
    };

    suppress_windows_console(&mut cmd);
    cmd.kill_on_drop(true);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(env) = options.env {
        for (key, value) in env {
            cmd.env(key.trim(), value);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("MCP 启动失败：{e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "MCP 启动失败：无法获取进程 ID".to_string())?;
    let tree = process_tree::attach_pid(pid);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP 启动失败：无法打开 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP 启动失败：无法打开 stdout".to_string())?;

    let handle = Arc::new(McpChildHandle {
        stdin: Mutex::new(stdin),
        stdout: Mutex::new(McpStdoutReader {
            reader: BufReader::new(stdout),
            partial: Vec::new(),
            discarding_overflow: false,
        }),
        process: Mutex::new(McpChildProcess { child, tree }),
    });

    let inserted = {
        let mut children = state.children.lock().await;
        if children.len() >= MAX_MCP_STDIO_CHILDREN {
            false
        } else {
            children.insert(pid, Arc::clone(&handle));
            true
        }
    };
    if !inserted {
        let _ = terminate_child_process(&handle).await;
        return Err(format!(
            "MCP 启动失败：活跃子进程数量已达上限（{MAX_MCP_STDIO_CHILDREN}）"
        ));
    }
    Ok(pid)
}

async fn write_mcp_stdio_payload(
    state: &McpStdioState,
    pid: u32,
    data: &str,
) -> Result<(), String> {
    if data.len() > MAX_MCP_STDIO_WRITE_BYTES {
        return Err(format!(
            "MCP 写入失败：载荷体积超过上限（{MAX_MCP_STDIO_WRITE_BYTES} 字节）"
        ));
    }
    let handle = {
        let children = state.children.lock().await;
        children
            .get(&pid)
            .cloned()
            .ok_or_else(|| format!("MCP 写入失败：未找到进程 {pid}"))?
    };
    let mut stdin = handle.stdin.lock().await;
    stdin
        .write_all(data.as_bytes())
        .await
        .map_err(|e| format!("MCP 写入失败：{e}"))?;
    if !data.ends_with('\n') {
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("MCP 写入失败：{e}"))?;
    }
    stdin
        .flush()
        .await
        .map_err(|e| format!("MCP 写入失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_stdio_spawn(
    state: State<'_, McpStdioState>,
    options: McpStdioSpawnOptions,
) -> Result<u32, String> {
    spawn_mcp_stdio_process(&state, options).await
}

#[tauri::command]
pub async fn mcp_stdio_write(
    state: State<'_, McpStdioState>,
    pid: u32,
    data: String,
) -> Result<(), String> {
    write_mcp_stdio_payload(&state, pid, &data).await
}

#[tauri::command]
pub async fn mcp_stdio_read(
    state: State<'_, McpStdioState>,
    pid: u32,
    timeout_ms: Option<u64>,
) -> Result<Option<String>, String> {
    let timeout = Duration::from_millis(clamp_mcp_read_timeout_ms(timeout_ms));
    let handle = {
        let children = state.children.lock().await;
        children
            .get(&pid)
            .cloned()
            .ok_or_else(|| format!("MCP 读取失败：未找到进程 {pid}"))?
    };

    let read_result = {
        let mut stdout = handle.stdout.lock().await;
        let McpStdoutReader {
            reader,
            partial,
            discarding_overflow,
        } = &mut *stdout;
        tokio::time::timeout(
            timeout,
            read_line_bounded(
                reader,
                partial,
                discarding_overflow,
                MAX_MCP_STDIO_LINE_BYTES,
            ),
        )
        .await
    };

    match read_result {
        Ok(Ok(Some(line))) => Ok(Some(line)),
        Ok(Ok(None)) => {
            cleanup_dead_handle(&state, pid, &handle).await;
            Err("MCP 读取失败：进程已结束".to_string())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn mcp_stdio_kill(state: State<'_, McpStdioState>, pid: u32) -> Result<(), String> {
    let handle = {
        let mut children = state.children.lock().await;
        children.remove(&pid)
    };
    let Some(handle) = handle else {
        return Ok(());
    };
    terminate_child_process(&handle).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_spawn_inputs_rejects_empty_and_control_chars() {
        assert!(validate_spawn_inputs("", &[], None).is_err());
        assert!(validate_spawn_inputs("   ", &[], None).is_err());
        assert!(validate_spawn_inputs("npx\nwhoami", &[], None).is_err());
        assert!(validate_spawn_inputs("npx\r", &[], None).is_err());
        assert!(validate_spawn_inputs("npx\0", &[], None).is_err());
        assert!(validate_spawn_inputs("npx", &["ok".into(), "bad\narg".into()], None).is_err());
        assert!(validate_spawn_inputs("npx", &["bad\0arg".into()], None).is_err());
        assert!(validate_spawn_inputs("npx", &[], Some("dir\r\n")).is_err());

        let (cmd, cwd) = validate_spawn_inputs("  npx  ", &["-y".into()], Some("  ")).unwrap();
        assert_eq!(cmd, "npx");
        assert_eq!(cwd, None);
    }

    #[tokio::test]
    async fn spawn_enforces_agent_gate_and_isolates_distinct_servers() {
        let _serial = crate::agent_gate::gate_test_serial_async().await;
        let temp_root = std::env::temp_dir().join(format!(
            "nb-mcp-gate-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(temp_root.join(".novel/audit")).unwrap();
        crate::agent_gate::set_gate_project_root(temp_root.clone());
        crate::agent_gate::__reset_state_for_test();

        let state = McpStdioState::default();
        // 受保护 command 必被 agent_gate 硬拒绝
        let err_cmd = spawn_mcp_stdio_process(
            &state,
            McpStdioSpawnOptions {
                command: "QM/evil-tool.exe".to_string(),
                args: None,
                cwd: None,
                env: None,
            },
        )
        .await
        .unwrap_err();
        assert!(
            err_cmd.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "受保护 command 必须被 gate 拒绝：{err_cmd}"
        );

        // 受保护 cwd 必被 agent_gate 硬拒绝
        let err_cwd = spawn_mcp_stdio_process(
            &state,
            McpStdioSpawnOptions {
                command: "npx".to_string(),
                args: Some(vec!["-y".into(), "server-memory".into()]),
                cwd: Some(r"C:\proj\CANON".to_string()),
                env: None,
            },
        )
        .await
        .unwrap_err();
        assert!(
            err_cwd.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "受保护 cwd 必须被 gate 拒绝：{err_cwd}"
        );

        // 3 个以上不同 MCP 服务（不同 args 或 cwd）拥有不同指纹，不得误触发循环熔断
        for idx in 0..(crate::agent_gate::LOOP_THRESHOLD + 2) {
            let target = build_mcp_gate_target(
                "npx",
                &["-y".to_string(), format!("@mcp/server-{idx}")],
                Some(&format!("/work/server-{idx}")),
            );
            let out = crate::agent_gate::gate_authorize(
                "runCommand",
                &target,
                crate::agent_gate::GateActor::Cli,
            );
            assert!(
                out.may_proceed(),
                "不同 MCP 服务 {idx} 不得触发误熔断：{}",
                out.reason
            );
        }

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[tokio::test]
    async fn read_line_bounded_enforces_limit_and_clears_partial() {
        let (mut writer, reader_stream) = tokio::io::duplex(256);
        let mut reader = BufReader::new(reader_stream);
        let mut partial = Vec::new();
        let mut discarding_overflow = false;

        writer.write_all(b"12345678\r\n").await.unwrap();
        let exact = read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 8)
            .await
            .expect("正好达到上限的合法行应放行");
        assert_eq!(exact.as_deref(), Some("12345678"));
        assert!(partial.is_empty());
        assert!(!discarding_overflow);

        writer.write_all(b"123456789\nnext-ok\n").await.unwrap();
        let overflow = read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 8)
            .await
            .unwrap_err();
        assert!(overflow.contains("超过上限"), "{overflow}");
        assert!(partial.is_empty(), "超限后必须清空 partial 缓冲");
        assert!(!discarding_overflow);

        let next = read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 8)
            .await
            .expect("超限行之后的下一行应可继续读取");
        assert_eq!(next.as_deref(), Some("next-ok"));
    }

    #[tokio::test]
    async fn read_line_bounded_preserves_partial_across_timeout_and_detects_eof() {
        let (mut writer, reader_stream) = tokio::io::duplex(256);
        let mut reader = BufReader::new(reader_stream);
        let mut partial = Vec::new();
        let mut discarding_overflow = false;

        writer.write_all(b"{\"jsonrpc\":\"2.0\",").await.unwrap();
        let timed_out = tokio::time::timeout(
            Duration::from_millis(25),
            read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 1024),
        )
        .await;
        assert!(timed_out.is_err(), "未收到换行符前应触发超时");
        assert_eq!(
            partial.as_slice(),
            b"{\"jsonrpc\":\"2.0\",".as_slice(),
            "超时后半行字节必须保留在 partial 中"
        );
        assert!(!discarding_overflow);

        writer.write_all(b"\"id\":1}\n").await.unwrap();
        let completed =
            read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 1024)
                .await
                .expect("补齐换行后应返回完整一行");
        assert_eq!(completed.as_deref(), Some("{\"jsonrpc\":\"2.0\",\"id\":1}"));
        assert!(partial.is_empty());

        drop(writer);
        let eof = read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 1024)
            .await
            .expect("EOF 返回 Ok(None)");
        assert_eq!(eof, None);
    }

    #[tokio::test]
    async fn read_line_bounded_drains_cross_chunk_overflow_and_recovers_after_timeout() {
        // 1) 多 chunk 超长行（无 `\n` 的首 chunk 已触发超限，后续 chunk 含残片与 `\n`，紧跟合法短 JSON 行）。
        let (mut writer, reader_stream) = tokio::io::duplex(256);
        let mut reader = BufReader::with_capacity(8, reader_stream);
        let mut partial = Vec::new();
        let mut discarding_overflow = false;

        let producer = tokio::spawn(async move {
            writer.write_all(b"123456").await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            writer.write_all(b"789012").await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            writer
                .write_all(b"TAIL-GARBAGE\n{\"id\":2}\n")
                .await
                .unwrap();
        });

        let overflow = read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 8)
            .await
            .unwrap_err();
        assert!(overflow.contains("超过上限"), "{overflow}");
        assert!(partial.is_empty());
        assert!(!discarding_overflow);

        let next = read_line_bounded(&mut reader, &mut partial, &mut discarding_overflow, 64)
            .await
            .expect("排空超长行后应读到完整下一帧，不得出现 TAIL-GARBAGE 错位");
        assert_eq!(next.as_deref(), Some("{\"id\":2}"));
        producer.await.unwrap();

        // 2) 超限排空过程中遇 timeout 取消：下次读取仍先排空至 `\n` 并报错，再下一读才返回合法帧。
        let (mut writer2, reader_stream2) = tokio::io::duplex(256);
        let mut reader2 = BufReader::with_capacity(8, reader_stream2);
        let mut partial2 = Vec::new();
        let mut discarding2 = false;

        writer2.write_all(b"0123456789ABCDEF").await.unwrap();
        let timed_out = tokio::time::timeout(
            Duration::from_millis(30),
            read_line_bounded(&mut reader2, &mut partial2, &mut discarding2, 8),
        )
        .await;
        assert!(timed_out.is_err(), "未见到换行前排空应超时");
        assert!(
            discarding2,
            "超时取消时必须保持 discarding_overflow=true，防止残片被当成下一帧"
        );
        assert!(partial2.is_empty());

        writer2
            .write_all(b"STILL-OVERFLOW\n{\"id\":3}\n")
            .await
            .unwrap();
        let drained_err = read_line_bounded(&mut reader2, &mut partial2, &mut discarding2, 8)
            .await
            .unwrap_err();
        assert!(drained_err.contains("超过上限"), "{drained_err}");
        assert!(!discarding2);

        let clean = read_line_bounded(&mut reader2, &mut partial2, &mut discarding2, 64)
            .await
            .expect("排空完成后应读到干净的下一帧");
        assert_eq!(clean.as_deref(), Some("{\"id\":3}"));
    }

    #[test]
    fn validate_spawn_env_blocks_dangerous_keys_and_control_chars() {
        let mut safe = HashMap::new();
        safe.insert("MCP_LOG_LEVEL".to_string(), "info".to_string());
        safe.insert(
            "OPENAI_API_BASE".to_string(),
            "https://example.com".to_string(),
        );
        validate_spawn_env(&safe).expect("normal env vars should pass");

        let secret_val = "super-secret-env-payload";
        for forbidden_key in [
            "LD_PRELOAD",
            "ld_preload",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
            "LD_DEBUG",
            "DYLD_INSERT_LIBRARIES",
            "dyld_library_path",
            "NODE_OPTIONS",
            "node_extra_ca_certs",
            "PYTHONSTARTUP",
            "PYTHONPATH",
            "pythonhome",
            "RUBYOPT",
            "RUBYLIB",
            "PERL5OPT",
            "PERL5LIB",
            "BASH_ENV",
            "BASH_FUNC_evil%%",
            "ENV",
            "IFS",
            "COMSPEC",
            "PATHEXT",
            "PROMPT_COMMAND",
            "ELECTRON_RUN_AS_NODE",
            "PATH",
            "path",
            "APPDATA",
            "USERPROFILE",
        ] {
            let mut env = HashMap::new();
            env.insert(forbidden_key.to_string(), secret_val.to_string());
            let err = validate_spawn_env(&env).expect_err("dangerous env var must be rejected");
            assert!(err.contains("禁止覆写"), "key={forbidden_key}, err={err}");
            assert!(
                !err.contains(secret_val),
                "error must never echo env value: {err}"
            );
        }

        for (bad_k, bad_v) in [
            ("", "ok"),
            ("   ", "ok"),
            ("BAD=KEY", "ok"),
            ("BAD\0KEY", "ok"),
            ("BAD\nKEY", "ok"),
            ("OK_KEY", "bad\0val"),
            ("OK_KEY", "bad\nval"),
        ] {
            let mut env = HashMap::new();
            env.insert(bad_k.to_string(), bad_v.to_string());
            assert!(
                validate_spawn_env(&env).is_err(),
                "invalid env ({bad_k:?}, {bad_v:?}) must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn mcp_stdio_enforces_concurrency_write_size_and_timeout_limits() {
        assert_eq!(MAX_MCP_STDIO_CHILDREN, 16);
        assert_eq!(MAX_MCP_STDIO_TIMEOUT_MS, 300_000);
        assert_eq!(MAX_MCP_STDIO_WRITE_BYTES, 4 * 1024 * 1024);

        assert!(ensure_child_capacity(MAX_MCP_STDIO_CHILDREN - 1).is_ok());
        assert!(ensure_child_capacity(MAX_MCP_STDIO_CHILDREN).is_err());

        assert_eq!(clamp_mcp_read_timeout_ms(None), 30_000);
        assert_eq!(clamp_mcp_read_timeout_ms(Some(0)), 1);
        assert_eq!(
            clamp_mcp_read_timeout_ms(Some(999_999)),
            MAX_MCP_STDIO_TIMEOUT_MS
        );
        assert_eq!(clamp_mcp_read_timeout_ms(Some(5_000)), 5_000);

        let state = McpStdioState::default();
        let oversized = "x".repeat(MAX_MCP_STDIO_WRITE_BYTES + 1);
        let write_err = write_mcp_stdio_payload(&state, 42, &oversized)
            .await
            .expect_err("oversized write payload must be rejected");
        assert!(write_err.contains("载荷体积超过上限"), "{write_err}");

        let _serial = crate::agent_gate::gate_test_serial_async().await;
        let protected_err = check_resolved_program_gate(Path::new("/proj/QM/hidden-tool"))
            .expect_err("resolved protected target must be blocked by agent_gate");
        assert!(
            protected_err.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "{protected_err}"
        );
    }
}

#[cfg(all(test, not(windows)))]
mod unix_tests {
    use super::*;

    #[tokio::test]
    async fn unix_resolve_canonicalizes_symlink_and_blocks_protected_target() {
        let _serial = crate::agent_gate::gate_test_serial_async().await;
        let tmp = std::env::temp_dir().join(format!(
            "nb-mcp-unix-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let qm_dir = tmp.join("QM");
        std::fs::create_dir_all(&qm_dir).unwrap();
        let protected_bin = qm_dir.join("evil.sh");
        std::fs::write(&protected_bin, "#!/bin/sh\necho hi\n").unwrap();
        let innocent_link = tmp.join("innocent-tool");
        std::os::unix::fs::symlink(&protected_bin, &innocent_link).unwrap();

        let canonical = resolve_unix_executable(&innocent_link.to_string_lossy(), &tmp)
            .expect("symlink target should canonicalize");
        let err = check_resolved_program_gate(&canonical)
            .expect_err("symlink pointing into QM/ must be rejected after canonicalize");
        assert!(
            err.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nb-mcp-win-{tag}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn canonical_clean(path: &Path) -> PathBuf {
        PathBuf::from(strip_windows_verbatim_prefix(
            &std::fs::canonicalize(path).unwrap(),
        ))
    }

    #[test]
    fn windows_launch_rejects_cmd_and_command_com() {
        let tmp = TempDir::new("reject-shell");
        for shell in [
            "cmd",
            "CMD",
            "cmd.exe",
            "CMD.EXE",
            r"C:\Windows\System32\cmd.exe",
            "command.com",
            "COMMAND.COM",
            "C:cmd",
            "C:cmd.exe",
            "C:COMMAND.COM",
            "C:cmd.exe::$DATA",
            "C:cmd.exe .",
        ] {
            assert!(
                is_forbidden_windows_shell(shell),
                "is_forbidden_windows_shell 必须识别 {shell}"
            );
            let err = resolve_windows_launch(
                shell,
                &["/c".into(), "echo".into()],
                Some(tmp.0.as_os_str()),
                &tmp.0,
            )
            .unwrap_err();
            assert!(
                err.contains("禁止直接调用"),
                "必须拒绝直接调用 {shell}：{err}"
            );
        }

        // 非 shell 的盘符相对路径同样必须被拒绝
        let drive_rel_err = resolve_windows_launch(
            "C:mcp-tool.exe",
            &["--safe".into()],
            Some(tmp.0.as_os_str()),
            &tmp.0,
        )
        .unwrap_err();
        assert!(
            drive_rel_err.contains("盘符相对路径"),
            "盘符相对路径必须被拒绝：{drive_rel_err}"
        );
    }

    #[test]
    fn windows_launch_prefers_exe_over_cmd() {
        let tmp = TempDir::new("prefer-exe");
        let exe_path = tmp.0.join("mcp-tool.exe");
        let cmd_path = tmp.0.join("mcp-tool.cmd");
        std::fs::write(&exe_path, b"fake-exe").unwrap();
        std::fs::write(&cmd_path, "@echo off\r\n").unwrap();

        let spec = resolve_windows_launch(
            "mcp-tool",
            &["--flag".into(), "a&b".into()],
            Some(tmp.0.as_os_str()),
            &tmp.0,
        )
        .expect("应优先解析直接 .exe");
        assert_eq!(spec.program, canonical_clean(&exe_path));
        assert_eq!(spec.args, vec!["--flag", "a&b"]);
    }

    #[test]
    fn windows_launch_unpacks_npx_cmd_to_node_and_npx_cli_js() {
        let tmp = TempDir::new("unpack-npx");
        let node_exe = tmp.0.join("node.exe");
        let npx_cmd = tmp.0.join("npx.cmd");
        let npx_cli = tmp
            .0
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npx-cli.js");
        std::fs::create_dir_all(npx_cli.parent().unwrap()).unwrap();
        std::fs::write(&node_exe, b"fake-node").unwrap();
        std::fs::write(&npx_cmd, "@ECHO OFF\r\n").unwrap();
        std::fs::write(&npx_cli, "console.log('ok');\n").unwrap();

        let spec = resolve_windows_launch(
            "npx",
            &[
                "-y".into(),
                "@modelcontextprotocol/server-memory".into(),
                "--tag=a&b".into(),
            ],
            Some(tmp.0.as_os_str()),
            &tmp.0,
        )
        .expect("npx.cmd 应拆包为 node.exe + npx-cli.js 直启");
        assert_eq!(spec.program, canonical_clean(&node_exe));
        assert_eq!(spec.args.len(), 4);
        assert!(
            spec.args[0].to_ascii_lowercase().ends_with("npx-cli.js"),
            "首参应为 npx-cli.js：{}",
            spec.args[0]
        );
        assert_eq!(
            &spec.args[1..],
            &[
                "-y".to_string(),
                "@modelcontextprotocol/server-memory".to_string(),
                "--tag=a&b".to_string(),
            ][..]
        );
    }

    #[test]
    fn windows_launch_unpacks_standard_npm_cmd_shim() {
        let tmp = TempDir::new("unpack-shim");
        let node_exe = tmp.0.join("node.exe");
        let shim_cmd = tmp.0.join("mcp-memory.cmd");
        let entry_js = tmp
            .0
            .join("node_modules")
            .join("@modelcontextprotocol")
            .join("server-memory")
            .join("dist")
            .join("index.js");
        std::fs::create_dir_all(entry_js.parent().unwrap()).unwrap();
        std::fs::write(&node_exe, b"fake-node").unwrap();
        std::fs::write(&entry_js, "console.log('memory');\n").unwrap();
        std::fs::write(
            &shim_cmd,
            "@ECHO off\r\nSET dp0=%~dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@modelcontextprotocol\\server-memory\\dist\\index.js\" %*\r\n",
        )
        .unwrap();

        let spec = resolve_windows_launch(
            "mcp-memory",
            &["--stdio".into()],
            Some(tmp.0.as_os_str()),
            &tmp.0,
        )
        .expect("标准 npm cmd-shim 应拆包为 node.exe + JS");
        assert_eq!(spec.program, canonical_clean(&node_exe));
        assert!(spec.args[0].to_ascii_lowercase().ends_with("index.js"));
        assert_eq!(&spec.args[1..], &["--stdio".to_string()][..]);
    }

    #[test]
    fn windows_launch_rejects_batch_metachars_when_cmd_cannot_be_unpacked() {
        let tmp = TempDir::new("batch-metachars");
        let custom_cmd = tmp.0.join("custom-mcp.cmd");
        std::fs::write(&custom_cmd, "@echo off\r\necho custom %*\r\n").unwrap();

        let ok = resolve_windows_launch(
            "custom-mcp",
            &["--mode".into(), "stdio".into()],
            Some(tmp.0.as_os_str()),
            &tmp.0,
        )
        .expect("安全参数应允许直接调用批处理（不手拼 cmd /c）");
        assert_eq!(ok.program, canonical_clean(&custom_cmd));
        assert_eq!(ok.args, vec!["--mode", "stdio"]);

        for bad_arg in [
            "a&whoami", "a|b", "a<b", "a>b", "a^b", "%PATH%", "!VAR!", "a\"b", "(a)", "a;b", "a`b",
            "a\tb",
        ] {
            let err = resolve_windows_launch(
                "custom-mcp",
                &[bad_arg.to_string()],
                Some(tmp.0.as_os_str()),
                &tmp.0,
            )
            .unwrap_err();
            assert!(
                err.contains("批处理禁用字符"),
                "批处理参数含 {bad_arg:?} 必须被拒：{err}"
            );
        }

        // 无法拆包的批处理路径本身含元字符也必须被拒
        let bad_dir = tmp.0.join("dir(1)");
        std::fs::create_dir_all(&bad_dir).unwrap();
        let bad_cmd = bad_dir.join("custom-bad.cmd");
        std::fs::write(&bad_cmd, "@echo off\r\necho custom %*\r\n").unwrap();
        let err_path = resolve_windows_launch(
            &bad_cmd.to_string_lossy(),
            &["--safe".into()],
            Some(tmp.0.as_os_str()),
            &tmp.0,
        )
        .unwrap_err();
        assert!(
            err_path.contains("批处理禁用字符"),
            "批处理路径含元字符必须被拒：{err_path}"
        );
    }

    #[test]
    fn windows_launch_rejects_batch_extension_suffix_and_ads_bypass() {
        let tmp = TempDir::new("batch-bypass");
        let custom_cmd = tmp.0.join("custom-mcp.cmd");
        std::fs::write(&custom_cmd, "@echo off\r\necho custom %*\r\n").unwrap();

        for disguised in [
            "custom-mcp.cmd.",
            "custom-mcp.cmd .",
            "custom-mcp.cmd::$DATA",
            "C:custom-mcp.BAT::$DATA",
        ] {
            assert!(
                is_batch_extension(Path::new(disguised)),
                "is_batch_extension 必须识别伪装批处理后缀：{disguised}"
            );
        }

        let full_dot = format!("{}.", custom_cmd.display());
        let full_space_dot = format!("{} .", custom_cmd.display());
        let full_ads = format!("{}::$DATA", custom_cmd.display());
        for variant in [
            "custom-mcp.cmd.",
            "custom-mcp.cmd .",
            "custom-mcp.cmd::$DATA",
            full_dot.as_str(),
            full_space_dot.as_str(),
            full_ads.as_str(),
        ] {
            let err = resolve_windows_launch(
                variant,
                &["a&whoami".into()],
                Some(tmp.0.as_os_str()),
                &tmp.0,
            )
            .unwrap_err();
            assert!(
                err.contains("非法 NTFS 数据流或尾部点/空格") || err.contains("批处理禁用字符"),
                "伪装批处理路径 {variant:?} 带元字符参数必须被拦截：{err}"
            );
        }

        // 若当前环境具备创建文件符号链接权限，同步验证符号链接指向 .cmd / cmd.exe 的规范目标拦截。
        let alias_to_cmd = tmp.0.join("alias-batch.exe");
        if std::os::windows::fs::symlink_file(&custom_cmd, &alias_to_cmd).is_ok() {
            let err = resolve_windows_launch(
                &alias_to_cmd.to_string_lossy(),
                &["a&whoami".into()],
                Some(tmp.0.as_os_str()),
                &tmp.0,
            )
            .unwrap_err();
            assert!(
                err.contains("批处理禁用字符"),
                "指向 .cmd 的 .exe 符号链接必须经规范路径触发批处理元字符拦截：{err}"
            );
        }

        let fake_cmd_exe = tmp.0.join("cmd.exe");
        std::fs::write(&fake_cmd_exe, b"fake-cmd").unwrap();
        let alias_to_shell = tmp.0.join("innocent.exe");
        if std::os::windows::fs::symlink_file(&fake_cmd_exe, &alias_to_shell).is_ok() {
            let err = resolve_windows_launch(
                &alias_to_shell.to_string_lossy(),
                &["/c".into(), "echo".into()],
                Some(tmp.0.as_os_str()),
                &tmp.0,
            )
            .unwrap_err();
            assert!(
                err.contains("禁止直接调用"),
                "指向 cmd.exe 的符号链接必须经规范路径被拒绝：{err}"
            );
        }
    }

    #[test]
    fn build_windows_search_paths_uses_host_env_only() {
        // 函数不再接受外部 env_override，只使用宿主 PATH / APPDATA / USERPROFILE。
        let search = build_windows_search_paths();
        if let Some(host_path) = std::env::var_os("PATH") {
            if !host_path.is_empty() {
                let joined = search.expect("host PATH should yield non-empty search paths");
                let dirs: Vec<PathBuf> = std::env::split_paths(&joined).collect();
                assert!(!dirs.is_empty());
            }
        }
    }
}
