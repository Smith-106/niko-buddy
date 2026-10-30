// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Local CLI configuration: TOML/JSON config parsing and environment variable
//! bridging for spawning external CLI processes from the desktop app.

use std::path::{Path, PathBuf};

use serde::Serialize;

// ── Public data types ──────────────────────────────────────────────────────

/// Subset of a local CLI's config file that the desktop cares about.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct LocalCliConfigInfo {
    /// The model identifier configured in the CLI's settings file.
    pub model: Option<String>,
}

/// Snapshot of environment variables that should be forwarded to a spawned
/// CLI process so that it behaves the same way as the user's shell would.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct LocalCliEnvironmentInfo {
    pub path: Option<String>,
    pub home: Option<String>,
    pub user_profile: Option<String>,
    pub app_data: Option<String>,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub all_proxy: Option<String>,
    pub no_proxy: Option<String>,
}

// ── Environment helpers ────────────────────────────────────────────────────

/// Apply the captured environment to a `tokio::process::Command`, returning
/// the snapshot that was applied.  Empty/missing values cause the key to be
/// *removed* so that the child process does not inherit stale parent state.
pub fn apply_local_cli_environment(cmd: &mut tokio::process::Command) -> LocalCliEnvironmentInfo {
    let info = current_local_cli_environment();

    // Core OS variables – always set/unset explicitly.
    set_or_remove(cmd, "PATH", &info.path);
    set_or_remove(cmd, "HOME", &info.home);
    set_or_remove(cmd, "USERPROFILE", &info.user_profile);
    set_or_remove(cmd, "APPDATA", &info.app_data);

    // Proxy variables – set both upper-case and lower-case forms.
    apply_proxy_pair(cmd, "HTTP_PROXY", &info.http_proxy);
    apply_proxy_pair(cmd, "HTTPS_PROXY", &info.https_proxy);
    apply_proxy_pair(cmd, "ALL_PROXY", &info.all_proxy);
    apply_proxy_pair(cmd, "NO_PROXY", &info.no_proxy);

    info
}

/// Unconditionally set or remove a single environment variable on a command.
fn set_or_remove(cmd: &mut tokio::process::Command, key: &str, value: &Option<String>) {
    match value {
        Some(v) if !v.is_empty() => cmd.env(key, v),
        _ => cmd.env_remove(key),
    };
}

/// For proxy-style variables we set *both* the upper-case and lower-case
/// variant, or remove both when absent/empty.
fn apply_proxy_pair(cmd: &mut tokio::process::Command, upper_key: &str, value: &Option<String>) {
    let lower_key = upper_key.to_ascii_lowercase();
    match value {
        Some(v) if !v.is_empty() => {
            cmd.env(upper_key, v);
            cmd.env(lower_key, v);
        }
        _ => {
            cmd.env_remove(upper_key);
            cmd.env_remove(lower_key);
        }
    }
}

/// Read the current process environment and build a snapshot struct.
pub fn current_local_cli_environment() -> LocalCliEnvironmentInfo {
    LocalCliEnvironmentInfo {
        path: read_env_nonempty("PATH"),
        home: resolve_home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|v| !v.trim().is_empty()),
        user_profile: read_env_nonempty("USERPROFILE"),
        app_data: read_env_nonempty("APPDATA"),
        http_proxy: read_env_first_nonempty(&["HTTP_PROXY", "http_proxy"]),
        https_proxy: read_env_first_nonempty(&["HTTPS_PROXY", "https_proxy"]),
        all_proxy: read_env_first_nonempty(&["ALL_PROXY", "all_proxy"]),
        no_proxy: read_env_first_nonempty(&["NO_PROXY", "no_proxy"]),
    }
}

/// Read a single environment variable, returning `None` if missing or blank.
fn read_env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Try a list of keys in order and return the first non-empty value found.
fn read_env_first_nonempty(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| read_env_nonempty(key))
}

// ── Home directory resolution ───────────────────────────────────────────────

/// Resolve the user's home directory from environment variables.
/// Prefers `$HOME` (Unix convention) over `$USERPROFILE` (Windows).
pub fn resolve_home_dir() -> Option<PathBuf> {
    nonempty_env_path("HOME").or_else(|| nonempty_env_path("USERPROFILE"))
}

fn nonempty_env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

// ── Dedicated CLI working directory ─────────────────────────────────────────

/// Path segments of the dedicated CLI working directory under the per-user
/// cache base; mirrors Tauri's `app_cache_dir()` layout (`<cache>/<identifier>`).
const CLI_WORKSPACE_SUBDIR: [&str; 2] = ["com.niko-buddy.app", "cli-workspace"];

/// Per-user cache base: `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on
/// macOS, `$XDG_CACHE_HOME` or `~/.cache` elsewhere.
///
/// Deliberately never the shared system temp dir: a fixed, predictable name in
/// a world-writable `/tmp` could be pre-seeded by another local user with
/// project-level CLI config (for example `.claude/settings.json` hooks).
#[cfg(windows)]
fn cli_workspace_base() -> Option<PathBuf> {
    nonempty_env_path("LOCALAPPDATA")
        .or_else(|| resolve_home_dir().map(|home| home.join("AppData").join("Local")))
}

#[cfg(target_os = "macos")]
fn cli_workspace_base() -> Option<PathBuf> {
    resolve_home_dir().map(|home| home.join("Library").join("Caches"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn cli_workspace_base() -> Option<PathBuf> {
    nonempty_env_path("XDG_CACHE_HOME")
        .filter(|path| path.is_absolute())
        .or_else(|| resolve_home_dir().map(|home| home.join(".cache")))
}

/// Dedicated CLI working directory under `base`.
fn cli_workspace_dir_under(base: &Path) -> PathBuf {
    CLI_WORKSPACE_SUBDIR
        .iter()
        .fold(base.to_path_buf(), |dir, part| dir.join(part))
}

/// Create (if needed) and return the dedicated CLI working directory under
/// `base`; split from [`ensure_cli_workspace_dir`] so tests can use a temp base.
fn ensure_cli_workspace_dir_in(base: &Path) -> Result<PathBuf, String> {
    let dir = cli_workspace_dir_under(base);
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Failed to create local CLI working directory {}: {e}",
            dir.display()
        )
    })?;
    Ok(dir)
}

/// Working directory for every spawned local CLI (claude / codex / gemini /
/// antigravity / cursor-api-proxy): one fixed, app-owned directory that holds
/// no user files.
///
/// Claude Code auto-approves read-only tools inside its working directory, so
/// spawning from `$HOME` exposed the whole home tree without approval; the
/// other CLIs resolve relative paths and project-level config from their cwd,
/// which used to be whatever the app inherited (install dir, `/`, or the repo
/// in dev). Fails closed: callers must not fall back to `$HOME` or the
/// inherited cwd.
pub fn ensure_cli_workspace_dir() -> Result<PathBuf, String> {
    ensure_cli_workspace_dir_from(cli_workspace_base())
}

/// Fail-closed core of [`ensure_cli_workspace_dir`]: no base or a relative
/// base (which would resolve against the inherited cwd) is an error.
fn ensure_cli_workspace_dir_from(base: Option<PathBuf>) -> Result<PathBuf, String> {
    let base = base.filter(|base| base.is_absolute()).ok_or_else(|| {
        "Cannot resolve a per-user cache directory for the local CLI working directory".to_string()
    })?;
    ensure_cli_workspace_dir_in(&base)
}

/// Gate target for one local CLI spawn: `cli-workspace/<provider>#req=<sha256 prefix>`.
///
/// The loop breaker in `agent_gate` halts on the same (op, target) 3 times in
/// 60s. A per-machine constant target halted every gated op after three
/// ordinary model calls; with the request digest only identical requests (same
/// provider, model and payload) count toward the threshold. Parts are
/// length-prefixed so ("ab","c") and ("a","bc") differ.
///
/// The target is a fixed label, not the absolute workspace path: the spawn cwd
/// is always the app-owned [`ensure_cli_workspace_dir`], and its absolute path
/// embeds the OS user name, so a user named `QM` or `canon` would hit the
/// gate's protected-path substring checks and hard-deny every CLI call.
pub fn cli_gate_target(provider: &str, model: &str, payload: &[&[u8]]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [provider.as_bytes(), model.as_bytes()]
        .into_iter()
        .chain(payload.iter().copied())
    {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    let digest = hasher.finalize();
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("cli-workspace/{provider}#req={hex}")
}

// ── Config file readers ─────────────────────────────────────────────────────

/// Read `~/.claude/settings.json` and extract the `model` field.
pub fn read_claude_local_config(home_dir: Option<&Path>) -> LocalCliConfigInfo {
    let Some(home) = home_dir else {
        return LocalCliConfigInfo::default();
    };
    let settings_path = home.join(".claude").join("settings.json");
    let content = match std::fs::read_to_string(&settings_path) {
        Ok(c) => c,
        Err(_) => return LocalCliConfigInfo::default(),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return LocalCliConfigInfo::default(),
    };

    LocalCliConfigInfo {
        model: extract_string_field(&json, "model"),
    }
}

/// Read `~/.codex/config.toml` and extract the `model` field.
pub fn read_codex_local_config(home_dir: Option<&Path>) -> LocalCliConfigInfo {
    let Some(home) = home_dir else {
        return LocalCliConfigInfo::default();
    };
    let config_path = home.join(".codex").join("config.toml");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return LocalCliConfigInfo::default(),
    };
    let toml_value: toml::Value = match content.parse() {
        Ok(v) => v,
        Err(_) => return LocalCliConfigInfo::default(),
    };

    LocalCliConfigInfo {
        model: extract_toml_string_field(&toml_value, "model"),
    }
}

/// Pull a non-empty string field from a JSON object.
fn extract_string_field(json: &serde_json::Value, field: &str) -> Option<String> {
    json.get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

/// Pull a non-empty string field from a TOML value.
fn extract_toml_string_field(toml_val: &toml::Value, field: &str) -> Option<String> {
    toml_val
        .get(field)
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claude_model_from_settings_json() {
        let dir = create_temp_dir("niko-buddy-local-cli-config-test-claude");
        let claude_dir = dir.join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(
            claude_dir.join("settings.json"),
            r#"{"model":"haiku","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:15721"}}"#,
        )
        .unwrap();

        let config = read_claude_local_config(Some(&dir));
        assert_eq!(config.model.as_deref(), Some("haiku"));
    }

    #[test]
    fn reads_codex_model_from_config_toml() {
        let dir = create_temp_dir("niko-buddy-local-cli-config-test-codex");
        let codex_dir = dir.join(".codex");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(
            codex_dir.join("config.toml"),
            "model_provider = \"custom\"\nmodel = \"gpt-5.4\"\n",
        )
        .unwrap();

        let config = read_codex_local_config(Some(&dir));
        assert_eq!(config.model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn current_environment_prefers_existing_proxy_values() {
        let _guard = env_mutex_lock();
        set_env_pair("HTTP_PROXY", Some("http://proxy:7890"));
        set_env_pair("HTTPS_PROXY", Some("http://proxy:7890"));
        set_env_pair("ALL_PROXY", Some("http://proxy:7890"));
        set_env_pair("NO_PROXY", Some("localhost,127.0.0.1"));

        let info = current_local_cli_environment();
        assert_eq!(info.http_proxy.as_deref(), Some("http://proxy:7890"));
        assert_eq!(info.https_proxy.as_deref(), Some("http://proxy:7890"));
        assert_eq!(info.all_proxy.as_deref(), Some("http://proxy:7890"));
        assert_eq!(info.no_proxy.as_deref(), Some("localhost,127.0.0.1"));
    }

    #[test]
    fn cli_workspace_dir_is_a_fixed_dedicated_subdir() {
        let base = create_temp_dir("niko-buddy-cli-workspace-test");
        let dir = ensure_cli_workspace_dir_in(&base).unwrap();
        assert!(dir.is_dir());
        assert_eq!(
            dir.strip_prefix(&base).unwrap(),
            Path::new("com.niko-buddy.app").join("cli-workspace")
        );
        // Same path every time: spawns reuse one directory instead of piling
        // up per-cwd CLI state (e.g. ~/.claude/projects/<cwd>).
        assert_eq!(ensure_cli_workspace_dir_in(&base).unwrap(), dir);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cli_gate_target_keys_on_request_not_machine() {
        let base = cli_gate_target("claude", "m", &[b"hello"]);
        let (label, req) = base.split_once("#req=").expect("digest suffix");
        assert_eq!(label, "cli-workspace/claude");
        assert_eq!(req.len(), 16);
        assert!(req
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Stable for the identical request.
        assert_eq!(cli_gate_target("claude", "m", &[b"hello"]), base);
        // Any change in provider, model or payload is a different key.
        for other in [
            cli_gate_target("codex", "m", &[b"hello"]),
            cli_gate_target("claude", "m2", &[b"hello"]),
            cli_gate_target("claude", "m", &[b"hello!"]),
            cli_gate_target("claude", "m", &[b"hel", b"lo"]),
        ] {
            assert_ne!(other, base);
        }
        assert_ne!(
            cli_gate_target("p", "m", &[b"ab", b"c"]),
            cli_gate_target("p", "m", &[b"a", b"bc"])
        );
    }

    #[test]
    fn cli_workspace_is_never_under_shared_temp() {
        let _guard = env_mutex_lock();
        if let Some(base) = cli_workspace_base() {
            let dir = cli_workspace_dir_under(&base);
            assert!(!dir.starts_with(std::env::temp_dir()), "{}", dir.display());
        }
    }

    // ── Test helpers ────────────────────────────────────────────────────────

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Acquire a process-wide mutex so env-var mutations in tests don't race.
    fn env_mutex_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
        ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Set or remove an env var for both its upper-case and lower-case forms.
    fn set_env_pair(key: &str, value: Option<&str>) {
        let lower = key.to_ascii_lowercase();
        match value {
            Some(v) => {
                std::env::set_var(key, v);
                std::env::set_var(lower, v);
            }
            None => {
                std::env::remove_var(key);
                std::env::remove_var(lower);
            }
        }
    }

    #[test]
    fn cli_workspace_resolution_fails_closed() {
        // 无缓存根、相对路径根、根下无法建目录：一律报错，不得回退到 $HOME 或继承的 cwd。
        let err = ensure_cli_workspace_dir_from(None).unwrap_err();
        assert!(err.contains("Cannot resolve"), "{err}");
        let err = ensure_cli_workspace_dir_from(Some(PathBuf::from("relative/cache"))).unwrap_err();
        assert!(err.contains("Cannot resolve"), "{err}");
        assert!(!Path::new("relative").exists());

        let base = create_temp_dir("niko-buddy-cli-workspace-failclosed");
        let file_base = base.join("not-a-dir");
        std::fs::write(&file_base, b"x").unwrap();
        let err = ensure_cli_workspace_dir_from(Some(file_base)).unwrap_err();
        assert!(err.contains("Failed to create"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
