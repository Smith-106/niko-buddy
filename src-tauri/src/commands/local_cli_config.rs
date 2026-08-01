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
    keys.iter()
        .find_map(|key| read_env_nonempty(key))
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
        let dir = create_temp_dir("qmai-local-cli-config-test-claude");
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
        let dir = create_temp_dir("qmai-local-cli-config-test-codex");
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
}
