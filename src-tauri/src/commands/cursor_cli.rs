//! Cursor CLI + cursor-api-proxy management.
//!
//! Detects the local `agent` binary and can start `cursor-api-proxy` so the
//! frontend can talk OpenAI-compatible HTTP. Port is chosen dynamically
//! (prefer 8765, else an ephemeral free port) via `CURSOR_BRIDGE_PORT`.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};

use super::process_tree::{self, ProcessTree};
use tokio::sync::Mutex;

use super::cli_resolver::{child_path_env, find_cli_command};
use super::local_cli_config::{
    apply_local_cli_environment, ensure_cli_workspace_dir, resolve_home_dir,
};

const PREFERRED_PROXY_PORT: u16 = 8765;
const DEFAULT_PROXY_BASE: &str = "http://127.0.0.1:8765";
const PROXY_START_TIMEOUT_MS: u64 = 15_000;
const PROXY_POLL_MS: u64 = 200;

/// npx fallback is pinned to an exact, reviewed release: an unpinned
/// `npx --yes cursor-api-proxy` silently runs whatever `latest` is at spawn
/// time (supply chain + default drift). Bump only after re-reading that
/// release's README for the `CURSOR_BRIDGE_*` names and defaults used below.
const CURSOR_PROXY_NPX_SPEC: &str = "cursor-api-proxy@1.7.0";

/// The app only uses the proxy as an OpenAI-compatible chat endpoint. Pin the
/// safety-relevant switches explicitly (values = cursor-api-proxy 1.7.0
/// defaults) so a user-level `CURSOR_BRIDGE_*` export inherited by the app
/// cannot turn the app's proxy into a workspace-writing agent. A per-request
/// `mode` / `X-Cursor-Mode` would still take precedence.
const CURSOR_PROXY_CHAT_ONLY_ENV: [(&str, &str); 5] = [
    ("CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE", "true"),
    ("CURSOR_BRIDGE_MODE", "ask"),
    ("CURSOR_BRIDGE_FORCE", "false"),
    ("CURSOR_BRIDGE_APPROVE_MCPS", "false"),
    ("CURSOR_BRIDGE_DSH_AUTO_MODE", "false"),
];

#[derive(Default)]
struct ManagedProxy {
    child: Option<Child>,
    /// R5: process-tree guard (Windows JobObject); drop kills descendants.
    tree: Option<ProcessTree>,
    /// e.g. http://127.0.0.1:8765 — the port this managed child actually bound.
    base_url: Option<String>,
}

#[derive(Default)]
pub struct CursorProxyState {
    managed: Arc<Mutex<ManagedProxy>>,
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    model: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct ProxyStatus {
    healthy: bool,
    base_url: String,
    managed: bool,
    error: Option<String>,
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

async fn find_agent_command() -> Result<std::path::PathBuf, String> {
    find_cli_command("agent", &["agent.cmd", "agent.exe"]).await
}

async fn find_proxy_launcher() -> Result<(std::path::PathBuf, Vec<String>), String> {
    let path_bin = find_cli_command(
        "cursor-api-proxy",
        &["cursor-api-proxy.cmd", "cursor-api-proxy.exe"],
    )
    .await
    .ok();
    let npx = find_cli_command("npx", &["npx.cmd", "npx.exe"]).await.ok();
    choose_proxy_launcher(path_bin, npx)
}

/// The pinned version, i.e. the part of [`CURSOR_PROXY_NPX_SPEC`] after `@`.
fn pinned_proxy_version() -> &'static str {
    CURSOR_PROXY_NPX_SPEC
        .rsplit_once('@')
        .map(|(_, v)| v)
        .unwrap_or_default()
}

/// Version of an npm-global `cursor-api-proxy` install, read from its
/// `package.json` next to the PATH shim (never by executing it). Windows npm
/// puts shims in `<prefix>/` and packages in `<prefix>/node_modules`; Unix
/// puts shims in `<prefix>/bin` and packages in `<prefix>/lib/node_modules`.
/// `None` when the layout is unknown (custom shim, other package manager).
fn installed_proxy_version(bin: &std::path::Path) -> Option<String> {
    let real = std::fs::canonicalize(bin).unwrap_or_else(|_| bin.to_path_buf());
    let shim_dir = bin.parent()?;
    let mut candidates = vec![
        shim_dir.join("node_modules/cursor-api-proxy/package.json"),
        shim_dir.join("../lib/node_modules/cursor-api-proxy/package.json"),
    ];
    // Unix shim is a symlink into <pkg>/dist/...; walk up from the real path.
    candidates.extend(
        real.ancestors()
            .skip(1)
            .take(4)
            .map(|d| d.join("package.json")),
    );
    candidates.into_iter().find_map(|path| {
        let text = std::fs::read_to_string(path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        if json.get("name")?.as_str()? != "cursor-api-proxy" {
            return None;
        }
        Some(json.get("version")?.as_str()?.to_string())
    })
}

/// Pick the proxy launcher. A PATH install is used only when it is exactly the
/// pinned version: `CURSOR_PROXY_CHAT_ONLY_ENV` was reviewed against that
/// release, and another version may rename or re-default those switches.
/// Otherwise the pinned npx spec runs; with no npx, fail closed with a fix hint.
fn choose_proxy_launcher(
    path_bin: Option<std::path::PathBuf>,
    npx: Option<std::path::PathBuf>,
) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let pinned = pinned_proxy_version();
    let path_version = path_bin.as_deref().and_then(installed_proxy_version);
    if let Some(bin) = &path_bin {
        if path_version.as_deref() == Some(pinned) {
            return Ok((bin.clone(), vec![]));
        }
    }
    if let Some(npx) = npx {
        if let Some(bin) = &path_bin {
            log::warn!(
                "cursor-api-proxy on PATH ({}) is version {}, not the pinned {pinned}; using npx {CURSOR_PROXY_NPX_SPEC} instead",
                bin.display(),
                path_version.as_deref().unwrap_or("unknown"),
            );
        }
        return Ok((npx, cursor_proxy_npx_args()));
    }
    Err(match (path_bin, path_version) {
        (Some(bin), found) => format!(
            "`cursor-api-proxy` on PATH ({}) is version {}, but the app only runs the reviewed {pinned}. Run `npm i -g {CURSOR_PROXY_NPX_SPEC}`, or install Node.js so `npx` can fetch the pinned version.",
            bin.display(),
            found.as_deref().unwrap_or("unknown"),
        ),
        (None, _) => format!(
            "`cursor-api-proxy` and `npx` not found on PATH. Install Node.js 18+ and `npm i -g {CURSOR_PROXY_NPX_SPEC}`, or ensure `npx` works."
        ),
    })
}

/// npx fallback arguments: exact-version pin (see [`CURSOR_PROXY_NPX_SPEC`]).
fn cursor_proxy_npx_args() -> Vec<String> {
    vec!["--yes".to_string(), CURSOR_PROXY_NPX_SPEC.to_string()]
}

/// Force the app-managed proxy into chat-only mode (see [`CURSOR_PROXY_CHAT_ONLY_ENV`]).
fn apply_cursor_proxy_chat_only_env(cmd: &mut Command) {
    for (key, value) in CURSOR_PROXY_CHAT_ONLY_ENV {
        cmd.env(key, value);
    }
}

/// Unix launch line for `$SHELL -l -c`. A login shell sources the user's
/// profile *after* `cmd.env` is applied, so a profile `export CURSOR_BRIDGE_MODE=agent`
/// (or a `cd`) would win. Re-assert host/port, the chat-only env and the cwd
/// inside the command itself, after profile sourcing.
#[cfg_attr(not(unix), allow(dead_code))]
fn unix_proxy_cmdline(
    launcher: &str,
    extra_args: &[String],
    port: u16,
    workspace: Option<&std::path::Path>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(dir) = workspace {
        parts.push(format!(
            "cd {} 2>/dev/null;",
            shell_quote(&dir.to_string_lossy())
        ));
    }
    parts.push("exec env".to_string());
    parts.push(shell_quote("CURSOR_BRIDGE_HOST=127.0.0.1"));
    parts.push(shell_quote(&format!("CURSOR_BRIDGE_PORT={port}")));
    for (key, value) in CURSOR_PROXY_CHAT_ONLY_ENV {
        parts.push(shell_quote(&format!("{key}={value}")));
    }
    parts.push(shell_quote(launcher));
    for arg in extra_args {
        parts.push(shell_quote(arg));
    }
    parts.join(" ")
}

fn normalize_proxy_base(base_url: Option<String>) -> String {
    let raw = base_url
        .unwrap_or_else(|| DEFAULT_PROXY_BASE.to_string())
        .trim()
        .to_string();
    let trimmed = raw.trim_end_matches('/').to_string();
    if trimmed.to_lowercase().ends_with("/v1") {
        trimmed[..trimmed.len() - 3]
            .trim_end_matches('/')
            .to_string()
    } else {
        trimmed
    }
}

fn parse_http_url(base: &str) -> Result<(String, u16, String), String> {
    let url = base.trim();
    let without_scheme = if let Some(rest) = url.strip_prefix("http://") {
        rest
    } else if url.starts_with("https://") {
        return Err(
            "cursor-api-proxy health check only supports http:// localhost URLs".to_string(),
        );
    } else {
        return Err(format!("Invalid proxy base URL: {base}"));
    };

    let (host_port, path) = match without_scheme.split_once('/') {
        Some((hp, p)) => (hp, format!("/{p}")),
        None => (without_scheme, "/".to_string()),
    };

    let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
        let port: u16 = p
            .parse()
            .map_err(|_| format!("Invalid port in proxy URL: {base}"))?;
        (h.to_string(), port)
    } else {
        (host_port.to_string(), 80)
    };

    Ok((host, port, path))
}

fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Prefer 8765; if taken, bind `:0` once to learn a free ephemeral port.
fn allocate_proxy_port() -> Result<u16, String> {
    if port_available(PREFERRED_PROXY_PORT) {
        return Ok(PREFERRED_PROXY_PORT);
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Failed to allocate free localhost port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read allocated port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn base_url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

async fn http_get_status(base: &str, path: &str) -> Result<u16, String> {
    let (host, port, _) = parse_http_url(base)?;
    let request_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };

    let mut stream = tokio::time::timeout(
        Duration::from_secs(2),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| "health check timed out connecting".to_string())?
    .map_err(|e| format!("health check connect failed: {e}"))?;

    let req =
        format!("GET {request_path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("health check write failed: {e}"))?;

    let mut buf = vec![0u8; 1024];
    let n = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf))
        .await
        .map_err(|_| "health check timed out reading".to_string())?
        .map_err(|e| format!("health check read failed: {e}"))?;

    let text = String::from_utf8_lossy(&buf[..n]);
    let status_line = text.lines().next().unwrap_or("");
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("unexpected health response: {status_line}"))?;
    Ok(code)
}

async fn ping_health(base: &str) -> bool {
    matches!(http_get_status(base, "/health").await, Ok(200))
}

/// Detect whether Cursor `agent` CLI is installed on PATH.
pub async fn do_cursor_cli_detect() -> Result<DetectResult, String> {
    let path = match find_agent_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                model: None,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();
    let mut cmd = Command::new(&path);
    suppress_windows_console(&mut cmd);
    apply_local_cli_environment(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }

    let output = tokio::time::timeout(Duration::from_secs(5), cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let version = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else {
                "agent".to_string()
            };
            Ok(DetectResult {
                installed: true,
                version: Some(version),
                path: Some(path_str),
                model: None,
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(DetectResult {
                installed: true,
                version: None,
                path: Some(path_str),
                model: None,
                error: Some(if stderr.is_empty() {
                    format!("`agent --version` exited with {}", out.status)
                } else {
                    stderr
                }),
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            model: None,
            error: Some(format!("Failed to spawn `agent`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: true,
            version: None,
            path: Some(path_str),
            model: None,
            error: Some("`agent --version` timed out after 5s".to_string()),
        }),
    }
}

#[tauri::command]
pub async fn cursor_cli_detect() -> Result<DetectResult, String> {
    do_cursor_cli_detect().await
}

#[tauri::command]
pub async fn cursor_proxy_status(
    state: State<'_, CursorProxyState>,
) -> Result<ProxyStatus, String> {
    let (base, managed) = {
        let guard = state.managed.lock().await;
        (
            normalize_proxy_base(guard.base_url.clone()),
            guard.child.is_some(),
        )
    };
    let healthy = ping_health(&base).await;
    Ok(ProxyStatus {
        healthy,
        base_url: base,
        managed,
        error: if healthy {
            None
        } else {
            Some("cursor-api-proxy is not reachable".to_string())
        },
    })
}

fn read_nonempty_env(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// Parse `export NAME=value` / `NAME=value` from a shell rc file. No secret logging.
fn read_export_from_rc(rc_path: &std::path::Path, name: &str) -> Option<String> {
    let content = std::fs::read_to_string(rc_path).ok()?;
    let prefix = format!("{name}=");
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        if let Some(rest) = line.strip_prefix(&prefix) {
            let value = rest
                .trim()
                .trim_matches(|c| c == '\'' || c == '"')
                .trim()
                .to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn read_cursor_api_key_from_user_files() -> Option<String> {
    read_cached_user_auth(&CURSOR_API_KEY_CACHE, read_cursor_api_key_uncached)
}

fn read_cursor_api_key_uncached() -> Option<String> {
    let home = resolve_home_dir()?;
    for rel in [
        ".zshrc",
        ".zprofile",
        ".bashrc",
        ".bash_profile",
        ".profile",
    ] {
        if let Some(v) = read_export_from_rc(&home.join(rel), "CURSOR_API_KEY") {
            return Some(v);
        }
    }
    let auth_path = home.join(".cursor").join("auth.json");
    let content = std::fs::read_to_string(auth_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("apiKey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn read_agent_credential_store_from_user_files() -> Option<String> {
    read_cached_user_auth(&CREDENTIAL_STORE_CACHE, read_credential_store_uncached)
}

fn read_credential_store_uncached() -> Option<String> {
    let home = resolve_home_dir()?;
    for rel in [
        ".zshrc",
        ".zprofile",
        ".bashrc",
        ".bash_profile",
        ".profile",
    ] {
        if let Some(v) = read_export_from_rc(&home.join(rel), "AGENT_CLI_CREDENTIAL_STORE") {
            return Some(v);
        }
    }
    None
}

/// P1-13：用户文件 auth 读缓存（TTL 60s）。每次 spawn 代理都经
/// apply_cursor_auth_env 读 5 个 rc + auth.json；同步小文件读虽快但走在
/// async spawn 链上，缓存后仅 TTL 过期才重读。密钥轮换最长 60s 生效。
const AUTH_CACHE_TTL: Duration = Duration::from_secs(60);

struct AuthCacheEntry {
    value: Option<String>,
    fetched: std::time::Instant,
}

static CURSOR_API_KEY_CACHE: std::sync::OnceLock<std::sync::Mutex<AuthCacheEntry>> =
    std::sync::OnceLock::new();
static CREDENTIAL_STORE_CACHE: std::sync::OnceLock<std::sync::Mutex<AuthCacheEntry>> =
    std::sync::OnceLock::new();

fn read_cached_user_auth(
    cache: &std::sync::OnceLock<std::sync::Mutex<AuthCacheEntry>>,
    reader: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Some(entry) = cache.get() {
        if let Ok(guard) = entry.lock() {
            if guard.fetched.elapsed() < AUTH_CACHE_TTL {
                return guard.value.clone();
            }
        }
    }
    let value = reader();
    if let Some(entry) = cache.get() {
        if let Ok(mut guard) = entry.lock() {
            *guard = AuthCacheEntry {
                value: value.clone(),
                fetched: std::time::Instant::now(),
            };
        }
    } else {
        let _ = cache.set(std::sync::Mutex::new(AuthCacheEntry {
            value: value.clone(),
            fetched: std::time::Instant::now(),
        }));
    }
    value
}

/// GUI apps do not load ~/.zshrc. Inject the same Cursor CLI auth the user
/// exports in shell: CURSOR_API_KEY + AGENT_CLI_CREDENTIAL_STORE.
fn apply_cursor_auth_env(cmd: &mut Command) {
    let api_key =
        read_nonempty_env(&["CURSOR_API_KEY"]).or_else(read_cursor_api_key_from_user_files);
    if let Some(api_key) = api_key {
        cmd.env("CURSOR_API_KEY", api_key);
    }

    let store = read_nonempty_env(&["AGENT_CLI_CREDENTIAL_STORE"])
        .or_else(read_agent_credential_store_from_user_files)
        .unwrap_or_else(|| "file".to_string());
    cmd.env("AGENT_CLI_CREDENTIAL_STORE", store);

    if let Some(token) = read_nonempty_env(&["CURSOR_AUTH_TOKEN"]) {
        cmd.env("CURSOR_AUTH_TOKEN", token);
    }

    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        cmd.env_remove(key);
    }
}

#[allow(dead_code)] // 68 号 E1：预留 shell 引用（调用链经 cursor_proxy_ensure 仅在部分平台编译）
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn spawn_proxy_process(port: u16) -> Result<Child, String> {
    let (launcher, extra_args) = find_proxy_launcher().await?;
    let path_env = child_path_env().await;
    // The proxy's cwd is its default `CURSOR_BRIDGE_WORKSPACE`: use the dedicated
    // app-owned directory, not the app's inherited cwd. Best effort, because
    // chat-only mode already runs the Cursor agent in its own temp dir.
    let workspace = ensure_cli_workspace_dir().ok();

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let cmdline = unix_proxy_cmdline(
            &launcher.to_string_lossy(),
            &extra_args,
            port,
            workspace.as_deref(),
        );

        let mut cmd = Command::new(&shell);
        suppress_windows_console(&mut cmd);
        apply_local_cli_environment(&mut cmd);
        if let Some(path_env) = path_env {
            cmd.env("PATH", path_env);
        }
        apply_cursor_auth_env(&mut cmd);
        cmd.env("CURSOR_BRIDGE_HOST", "127.0.0.1");
        cmd.env("CURSOR_BRIDGE_PORT", port.to_string());
        apply_cursor_proxy_chat_only_env(&mut cmd);
        if let Some(dir) = workspace.as_deref() {
            cmd.current_dir(dir);
        }
        cmd.args(["-l", "-c", &cmdline]);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        return cmd
            .spawn()
            .map_err(|e| format!("Failed to start cursor-api-proxy: {e}"));
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new(&launcher);
        suppress_windows_console(&mut cmd);
        apply_local_cli_environment(&mut cmd);
        if let Some(path_env) = path_env {
            cmd.env("PATH", path_env);
        }
        apply_cursor_auth_env(&mut cmd);
        cmd.env("CURSOR_BRIDGE_HOST", "127.0.0.1");
        cmd.env("CURSOR_BRIDGE_PORT", port.to_string());
        apply_cursor_proxy_chat_only_env(&mut cmd);
        if let Some(dir) = workspace.as_deref() {
            cmd.current_dir(dir);
        }
        cmd.args(&extra_args);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        cmd.spawn()
            .map_err(|e| format!("Failed to start cursor-api-proxy: {e}"))
    }
}

async fn stop_managed_child(state: &CursorProxyState) {
    let mut guard = state.managed.lock().await;
    // R5: destroy the whole tree first, then the direct child.
    if let Some(mut tree) = guard.tree.take() {
        tree.terminate();
    }
    if let Some(mut child) = guard.child.take() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }
    guard.base_url = None;
}

async fn wait_until_healthy(base: &str) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(PROXY_START_TIMEOUT_MS);
    while tokio::time::Instant::now() < deadline {
        if ping_health(base).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(PROXY_POLL_MS)).await;
    }
    false
}

/// Ensure cursor-api-proxy is healthy. Starts (or force-restarts) on a free port.
#[tauri::command]
pub async fn cursor_proxy_ensure(
    state: State<'_, CursorProxyState>,
    force_restart: Option<bool>,
) -> Result<ProxyStatus, String> {
    let force = force_restart.unwrap_or(false);

    {
        let mut guard = state.managed.lock().await;
        if let Some(child) = guard.child.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    if !force {
                        if let Some(base) = guard.base_url.clone() {
                            drop(guard);
                            if ping_health(&base).await {
                                return Ok(ProxyStatus {
                                    healthy: true,
                                    base_url: base,
                                    managed: true,
                                    error: None,
                                });
                            }
                        }
                    }
                }
                _ => {
                    guard.child = None;
                    guard.base_url = None;
                }
            }
        }
    }

    stop_managed_child(&state).await;

    let port = allocate_proxy_port()?;
    let base = base_url_for_port(port);
    let child = spawn_proxy_process(port).await?;
    // R5: attach process-tree guard (fail-open).
    let tree = child.id().and_then(process_tree::attach_pid);
    {
        let mut guard = state.managed.lock().await;
        guard.child = Some(child);
        guard.tree = tree;
        guard.base_url = Some(base.clone());
    }

    if wait_until_healthy(&base).await {
        return Ok(ProxyStatus {
            healthy: true,
            base_url: base,
            managed: true,
            error: None,
        });
    }

    stop_managed_child(&state).await;
    Err(format!(
        "Started cursor-api-proxy on {base} but /health did not become ready within {PROXY_START_TIMEOUT_MS}ms. Ensure Node.js 18+, `agent` CLI, and that CURSOR_API_KEY / AGENT_CLI_CREDENTIAL_STORE are set in ~/.zshrc (or auth.json)."
    ))
}

/// Stop the proxy process if this app started it.
#[tauri::command]
pub async fn cursor_proxy_stop(state: State<'_, CursorProxyState>) -> Result<(), String> {
    stop_managed_child(&state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 两个端口分配测试共享 8765 端口，串行化避免 TOCTOU 竞态（68 号 P0-3）
    static TEST_PORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn normalize_strips_v1_suffix() {
        assert_eq!(
            normalize_proxy_base(Some("http://127.0.0.1:8765/v1".into())),
            "http://127.0.0.1:8765"
        );
        assert_eq!(
            normalize_proxy_base(Some("http://127.0.0.1:8765/".into())),
            "http://127.0.0.1:8765"
        );
        assert_eq!(normalize_proxy_base(None), DEFAULT_PROXY_BASE);
    }

    #[test]
    fn parse_localhost_url() {
        let (host, port, path) = parse_http_url("http://127.0.0.1:8765").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 8765);
        assert_eq!(path, "/");
    }

    #[test]
    fn allocate_prefers_8765_when_free() {
        let _guard = TEST_PORT_LOCK.lock().unwrap();
        if port_available(PREFERRED_PROXY_PORT) {
            assert_eq!(allocate_proxy_port().unwrap(), PREFERRED_PROXY_PORT);
        }
    }

    #[test]
    fn allocate_returns_nonzero_when_preferred_taken() {
        let _guard = TEST_PORT_LOCK.lock().unwrap();
        let _hold = std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PROXY_PORT));
        if _hold.is_err() {
            let port = allocate_proxy_port().unwrap();
            assert!(port > 0);
            return;
        }
        let port = allocate_proxy_port().unwrap();
        assert_ne!(port, PREFERRED_PROXY_PORT);
        assert!(port > 0);
    }

    #[test]
    fn auth_cache_serves_cached_value_within_ttl() {
        // P1-13：TTL 内不重读用户文件（reader 只调一次）。
        let cache = std::sync::OnceLock::new();
        let calls = std::cell::Cell::new(0);
        let first = read_cached_user_auth(&cache, || {
            calls.set(calls.get() + 1);
            Some("cached-key".to_string())
        });
        let second = read_cached_user_auth(&cache, || {
            calls.set(calls.get() + 1);
            Some("rotated-key".to_string())
        });
        assert_eq!(first.as_deref(), Some("cached-key"));
        assert_eq!(second.as_deref(), Some("cached-key"));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn reads_export_lines_from_rc() {
        let dir = std::env::temp_dir().join(format!("niko-buddy-cursor-rc-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let rc = dir.join(".zshrc");
        std::fs::write(
            &rc,
            "# comment\nexport CURSOR_API_KEY=crsr_test_key\nexport AGENT_CLI_CREDENTIAL_STORE=file\n",
        )
        .unwrap();
        assert_eq!(
            read_export_from_rc(&rc, "CURSOR_API_KEY").as_deref(),
            Some("crsr_test_key")
        );
        assert_eq!(
            read_export_from_rc(&rc, "AGENT_CLI_CREDENTIAL_STORE").as_deref(),
            Some("file")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn npx_fallback_pins_exact_proxy_version() {
        // D4：npx 兜底必须钉死精确版本，不得随 latest 漂移。
        let args = cursor_proxy_npx_args();
        assert_eq!(args.first().map(String::as_str), Some("--yes"));
        let spec = args.last().unwrap();
        let (name, version) = spec.rsplit_once('@').expect("versioned npx spec");
        assert_eq!(name, "cursor-api-proxy");
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(parts.len(), 3, "exact x.y.z, got {version}");
        assert!(parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())));
    }

    #[test]
    fn managed_proxy_env_forces_chat_only() {
        let mut cmd = Command::new("cursor-api-proxy");
        apply_cursor_proxy_chat_only_env(&mut cmd);
        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().into_owned(),
                    v?.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        for (key, expected) in [
            ("CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE", "true"),
            ("CURSOR_BRIDGE_MODE", "ask"),
            ("CURSOR_BRIDGE_FORCE", "false"),
            ("CURSOR_BRIDGE_APPROVE_MCPS", "false"),
            ("CURSOR_BRIDGE_DSH_AUTO_MODE", "false"),
        ] {
            assert_eq!(envs.get(key).map(String::as_str), Some(expected), "{key}");
        }
    }

    #[test]
    fn unix_proxy_cmdline_reasserts_env_after_profile() {
        // D4：login shell 会在 cmd.env 之后读 profile，强制值必须写进 -c 命令串本身。
        let ws = std::path::Path::new("/home/u/it's cache/cli-workspace");
        let line = unix_proxy_cmdline("/usr/bin/npx", &cursor_proxy_npx_args(), 8765, Some(ws));
        assert!(
            line.starts_with("cd '/home/u/it'\"'\"'s cache/cli-workspace' 2>/dev/null; exec env "),
            "{line}"
        );
        let env_at = line.find("exec env ").unwrap();
        let launcher_at = line.find("'/usr/bin/npx'").unwrap();
        let mut expected = vec![
            "CURSOR_BRIDGE_HOST=127.0.0.1".to_string(),
            "CURSOR_BRIDGE_PORT=8765".to_string(),
        ];
        expected.extend(
            CURSOR_PROXY_CHAT_ONLY_ENV
                .iter()
                .map(|(k, v)| format!("{k}={v}")),
        );
        for pair in expected {
            let at = line
                .find(&shell_quote(&pair))
                .unwrap_or_else(|| panic!("{pair} missing"));
            assert!(
                env_at < at && at < launcher_at,
                "{pair} must sit between env and launcher"
            );
        }
        assert!(
            line.ends_with("'/usr/bin/npx' '--yes' 'cursor-api-proxy@1.7.0'"),
            "{line}"
        );
        assert!(!unix_proxy_cmdline("p", &[], 1, None).starts_with("cd "));
    }

    fn proxy_fixture(layout: &str, version: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("niko-proxy-pin-{layout}-{nanos}"));
        let (shim, pkg) = match layout {
            "win" => (
                root.join("cursor-api-proxy.cmd"),
                root.join("node_modules/cursor-api-proxy"),
            ),
            _ => (
                root.join("bin/cursor-api-proxy"),
                root.join("lib/node_modules/cursor-api-proxy"),
            ),
        };
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
        std::fs::write(&shim, b"shim").unwrap();
        std::fs::write(
            pkg.join("package.json"),
            format!(r#"{{"name":"cursor-api-proxy","version":"{version}"}}"#),
        )
        .unwrap();
        (root, shim)
    }

    #[test]
    fn path_proxy_is_used_only_at_the_pinned_version() {
        // DEBT-20261029-02：PATH 上的全局安装也必须是审过的版本，否则改走钉版本的 npx。
        let pinned = pinned_proxy_version();
        assert_eq!(pinned, "1.7.0");
        let npx = Some(std::path::PathBuf::from("/usr/bin/npx"));
        for layout in ["win", "unix"] {
            let (root, shim) = proxy_fixture(layout, pinned);
            assert_eq!(installed_proxy_version(&shim).as_deref(), Some(pinned));
            let (bin, args) = choose_proxy_launcher(Some(shim.clone()), npx.clone()).unwrap();
            assert_eq!((bin, args), (shim, vec![]));
            let _ = std::fs::remove_dir_all(&root);

            let (root, shim) = proxy_fixture(layout, "9.9.9");
            let (bin, args) = choose_proxy_launcher(Some(shim.clone()), npx.clone()).unwrap();
            assert_eq!((bin, args), (npx.clone().unwrap(), cursor_proxy_npx_args()));
            let err = choose_proxy_launcher(Some(shim), None).unwrap_err();
            assert!(
                err.contains("9.9.9") && err.contains(CURSOR_PROXY_NPX_SPEC),
                "{err}"
            );
            let _ = std::fs::remove_dir_all(&root);
        }
        // 版本无法确认（非 npm 布局）按不符处理。
        let bare = std::env::temp_dir().join("niko-proxy-pin-bare-cursor-api-proxy");
        assert_eq!(installed_proxy_version(&bare), None);
        let (bin, _) = choose_proxy_launcher(Some(bare.clone()), npx.clone()).unwrap();
        assert_eq!(bin, npx.clone().unwrap());
        assert!(choose_proxy_launcher(Some(bare), None)
            .unwrap_err()
            .contains("unknown"));
        assert!(choose_proxy_launcher(None, None)
            .unwrap_err()
            .contains("not found on PATH"));
    }
}
