// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
//! Global outbound HTTP proxy plumbing.
//!
//! Reads user-configured proxy settings from the on-disk `app-state.json`
//! and translates them into HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment
//! variables that reqwest (via tauri-plugin-http) honours at client
//! construction time.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Private-network CIDRs and loopback addresses excluded from proxying
/// when `bypass_local` is enabled.
const DEFAULT_BYPASS_LIST: &str =
    "localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local";

/// Proxy configuration mirroring the frontend's `proxyConfig` object
/// serialised into `app-state.json`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_true", rename = "bypassLocal")]
    pub bypass_local: bool,
}

/// Hand-written `Default` so `bypass_local` agrees with the serde
/// `default = "default_true"` attribute. `derive(Default)` would yield
/// `false`, which silently contradicts the "missing-key means bypass on"
/// contract documented in the serde attribute.
impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            bypass_local: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Deserialises the `proxyConfig` key from the given JSON store file.
/// Returns `None` when the file is missing, unreadable, malformed, or
/// simply lacks a `proxyConfig` section — the caller treats all of
/// those identically to "no proxy configured".
pub fn read_proxy_config_from_store(store_path: &Path) -> Option<ProxyConfig> {
    let raw = std::fs::read_to_string(store_path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let proxy_node = root.get("proxyConfig")?;
    serde_json::from_value(proxy_node.clone()).ok()
}

/// Entry point called at app launch: reads the on-disk store and
/// applies whatever proxy configuration it contains. An unreadable
/// or absent store is treated as a disabled proxy, preventing
/// inherited HTTP_PROXY values from the parent shell from leaking
/// into a user who never enabled the feature.
pub fn apply_proxy_env_from_store(store_path: &Path) -> String {
    let config = read_proxy_config_from_store(store_path).unwrap_or_default();
    apply_proxy_env(&config)
}

/// Applies a `ProxyConfig` by setting the environment variables that
/// reqwest reads at client construction time.
///
/// Returns a short human-readable summary suitable for debug logging.
/// URL validation is strict: only `http://` and `https://` schemes are
/// accepted — anything else (SOCKS5, malformed, missing scheme) is
/// treated as disabled to avoid silent half-working proxies.
///
/// # Concurrency note
///
/// `std::env::set_var` mutates process-wide state and is technically
/// racy if another thread reads env simultaneously. Two call sites
/// exist today:
/// 1. The Tauri setup hook (runs before any HTTP thread starts — safe).
/// 2. The `set_proxy_env` IPC command (microsecond race window with
///    an in-flight `reqwest::Client::new()`; worst case is one fetch
///    reading the previous value — acceptable for a user toggle).
pub fn apply_proxy_env(config: &ProxyConfig) -> String {
    let trimmed_url = config.url.trim();
    let scheme_invalid =
        !trimmed_url.starts_with("http://") && !trimmed_url.starts_with("https://");

    // Every "disabled" path MUST clear all proxy env vars — toggling
    // the proxy off after it was on must stop routing through the
    // (now-removed) proxy immediately.
    if !config.enabled || trimmed_url.is_empty() || scheme_invalid {
        clear_all_proxy_env();
        return if !config.enabled {
            "disabled".to_string()
        } else if trimmed_url.is_empty() {
            "disabled (empty url)".to_string()
        } else {
            // Redact before logging: a malformed URL might still
            // contain a password the user mistyped.
            format!("disabled (unsupported scheme: {})", redact_url(trimmed_url))
        };
    }

    // Apply the proxy URL to all three canonical env var names.
    set_proxy_env_pair("HTTP_PROXY", trimmed_url);
    set_proxy_env_pair("HTTPS_PROXY", trimmed_url);
    set_proxy_env_pair("ALL_PROXY", trimmed_url);

    if config.bypass_local {
        set_proxy_env_pair("NO_PROXY", DEFAULT_BYPASS_LIST);
    } else {
        // Bypass disabled — remove NO_PROXY so a previously-set
        // value doesn't leak through.
        remove_proxy_env_pair("NO_PROXY");
    }

    format!(
        "enabled ({}, bypass_local={})",
        redact_url(trimmed_url),
        config.bypass_local
    )
}

/// Strips basic-auth credentials embedded in a URL before it is
/// written to logs. `http://user:pass@host:port` becomes
/// `http://***@host:port`. URLs without a userinfo component pass
/// through unchanged. This prevents proxy passwords from persisting
/// in stderr, Console.app, or journalctl output.
fn redact_url(url: &str) -> String {
    let scheme_end = match url.find("://") {
        Some(pos) => pos + 3,
        None => return url.to_string(),
    };
    let after_scheme = &url[scheme_end..];

    // The userinfo segment, if present, ends at the first `@` that
    // appears BEFORE the first `/`. A `@` inside the path is not
    // part of credentials and must not be matched.
    let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
    let userinfo_end = match after_scheme[..path_start].find('@') {
        Some(pos) => pos,
        None => return url.to_string(), // no credentials present
    };

    let mut redacted = String::with_capacity(url.len());
    redacted.push_str(&url[..scheme_end]);
    redacted.push_str("***");
    redacted.push_str(&after_scheme[userinfo_end..]);
    redacted
}

/// Removes all four proxy env vars (HTTP, HTTPS, ALL, NO_PROXY).
/// Called whenever the user disables the proxy or provides an
/// invalid URL — this is the code that makes "turn off proxy"
/// actually take effect for subsequent requests.
fn clear_all_proxy_env() {
    remove_proxy_env_pair("HTTP_PROXY");
    remove_proxy_env_pair("HTTPS_PROXY");
    remove_proxy_env_pair("ALL_PROXY");
    remove_proxy_env_pair("NO_PROXY");
}

/// Sets an env var in both upper-case and lower-case forms, since
/// different HTTP client libraries consult different casings.
fn set_proxy_env_pair(name: &str, value: &str) {
    std::env::set_var(name, value);
    std::env::set_var(name.to_ascii_lowercase(), value);
}

/// Removes an env var in both upper-case and lower-case forms.
fn remove_proxy_env_pair(name: &str) {
    std::env::remove_var(name);
    std::env::remove_var(name.to_ascii_lowercase());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared mutex to serialise tests that mutate process-wide env vars.
    /// Cargo runs tests in parallel by default; without this mutex one
    /// test's `set_var` would contaminate another test's assertions.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// All env var names touched by proxy logic (both casings).
    const PROXY_ENV_NAMES: &[&str] = &[
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];

    /// Runs `f` in an isolated environment: snapshots the current
    /// proxy env vars, clears them, executes `f`, then restores
    /// the originals — preventing test cross-contamination.
    fn with_isolated_env<F: FnOnce()>(f: F) {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot: Vec<Option<String>> = PROXY_ENV_NAMES
            .iter()
            .map(|name| std::env::var(name).ok())
            .collect();

        for name in PROXY_ENV_NAMES {
            std::env::remove_var(name);
        }

        f();

        for (name, prev) in PROXY_ENV_NAMES.iter().zip(snapshot) {
            match prev {
                Some(val) => std::env::set_var(name, val),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn disabled_sets_no_env() {
        with_isolated_env(|| {
            let summary = apply_proxy_env(&ProxyConfig {
                enabled: false,
                url: "http://x:1".into(),
                bypass_local: true,
            });
            assert!(summary.contains("disabled"));
            for name in &["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                          "http_proxy", "https_proxy", "all_proxy"] {
                assert!(std::env::var(name).is_err(), "{name} should be unset");
            }
        });
    }

    #[test]
    fn enabled_sets_both_proxy_envs() {
        with_isolated_env(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            for name in &["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                          "http_proxy", "https_proxy", "all_proxy"] {
                assert_eq!(
                    std::env::var(name).unwrap(),
                    "http://127.0.0.1:7890",
                    "{name} mismatch"
                );
            }
            let no_proxy = std::env::var("NO_PROXY").unwrap();
            assert!(no_proxy.contains("localhost"));
            assert!(no_proxy.contains("127.0.0.0/8"));
            assert!(no_proxy.contains("192.168.0.0/16"));
            assert_eq!(std::env::var("no_proxy").unwrap(), no_proxy);
        });
    }

    #[test]
    fn bypass_local_off_clears_no_proxy() {
        with_isolated_env(|| {
            std::env::set_var("NO_PROXY", "stale-value");
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://x:1".into(),
                bypass_local: false,
            });
            // The stale value must be cleared so the user's intent
            // (route everything through the proxy) is honoured.
            assert!(std::env::var("NO_PROXY").is_err());
        });
    }

    #[test]
    fn rejects_unsupported_schemes() {
        with_isolated_env(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "socks5://x:1".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
        });
    }

    #[test]
    fn rejects_empty_url() {
        with_isolated_env(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "   ".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
        });
    }

    #[test]
    fn disable_after_enable_clears_previously_set_env_vars() {
        with_isolated_env(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            assert_eq!(
                std::env::var("HTTP_PROXY").unwrap(),
                "http://127.0.0.1:7890",
            );

            apply_proxy_env(&ProxyConfig {
                enabled: false,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            for name in PROXY_ENV_NAMES {
                assert!(std::env::var(name).is_err(), "{name} must be unset");
            }
        });
    }

    #[test]
    fn unsupported_scheme_after_enable_clears_env() {
        with_isolated_env(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "socks5://x:1".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
        });
    }

    #[test]
    fn https_proxy_url_is_supported() {
        with_isolated_env(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "https://proxy.corp:443".into(),
                bypass_local: false,
            });
            assert_eq!(
                std::env::var("HTTPS_PROXY").unwrap(),
                "https://proxy.corp:443"
            );
        });
    }

    #[test]
    fn redacts_basic_auth_credentials_in_url() {
        assert_eq!(
            redact_url("http://user:pass@proxy.corp:8080"),
            "http://***@proxy.corp:8080",
        );
        // URL with path after host: '@' in path must not be matched
        assert_eq!(
            redact_url("http://user:pass@proxy.corp:8080/some@path"),
            "http://***@proxy.corp:8080/some@path",
        );
        // Username only (no password)
        assert_eq!(
            redact_url("http://user@proxy.corp:8080"),
            "http://***@proxy.corp:8080",
        );
        // No credentials — pass through
        assert_eq!(
            redact_url("http://proxy.corp:8080"),
            "http://proxy.corp:8080",
        );
        // No scheme at all (defensive — invalid URL shouldn't crash)
        assert_eq!(redact_url("garbage"), "garbage");
    }

    #[test]
    fn apply_proxy_env_summary_does_not_leak_password() {
        with_isolated_env(|| {
            let summary = apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://secretuser:secretpass@proxy.corp:8080".into(),
                bypass_local: true,
            });
            assert!(!summary.contains("secretpass"));
            assert!(!summary.contains("secretuser"));
            assert!(summary.contains("***"));
            assert!(summary.contains("proxy.corp:8080"));
        });
    }

    #[test]
    fn default_trait_matches_serde_missing_field_semantics() {
        let via_trait = ProxyConfig::default();
        let via_serde: ProxyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(via_trait.enabled, via_serde.enabled);
        assert_eq!(via_trait.url, via_serde.url);
        assert_eq!(
            via_trait.bypass_local, via_serde.bypass_local,
            "Default trait and serde-default must agree on bypass_local",
        );
        assert!(!via_trait.enabled);
        assert!(via_trait.bypass_local);
    }

    #[test]
    fn parses_camelcase_bypassLocal_field() {
        let json = r#"{"enabled": true, "url": "http://x:1", "bypassLocal": false}"#;
        let cfg: ProxyConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.url, "http://x:1");
        assert!(!cfg.bypass_local);
    }

    #[test]
    fn missing_proxyConfig_returns_none() {
        let dir = tempdir_for_test();
        let path = dir.join("missing.json");
        assert!(read_proxy_config_from_store(&path).is_none());
    }

    #[test]
    fn missing_store_config_clears_inherited_proxy_env() {
        with_isolated_env(|| {
            let dir = tempdir_for_test();
            let path = dir.join("missing.json");
            // Simulate inherited proxy values from a parent shell.
            for name in PROXY_ENV_NAMES {
                std::env::set_var(name, "http://inherited:8080");
            }

            let summary = apply_proxy_env_from_store(&path);

            assert!(summary.contains("disabled"));
            for name in PROXY_ENV_NAMES {
                assert!(std::env::var(name).is_err(), "{name} must be cleared");
            }
        });
    }

    #[test]
    fn parses_proxy_config_from_store_file() {
        let dir = tempdir_for_test();
        let path = dir.join("app-state.json");
        std::fs::write(
            &path,
            r#"{"proxyConfig": {"enabled": true, "url": "http://x:1", "bypassLocal": true}}"#,
        )
        .unwrap();
        let cfg = read_proxy_config_from_store(&path).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.url, "http://x:1");
    }

    #[test]
    fn ignores_store_file_with_no_proxy_section() {
        let dir = tempdir_for_test();
        let path = dir.join("app-state.json");
        std::fs::write(&path, r#"{"otherKey": "value"}"#).unwrap();
        assert!(read_proxy_config_from_store(&path).is_none());
    }

    /// Creates a unique temporary directory for test file I/O.
    fn tempdir_for_test() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("llm-wiki-proxy-test-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
