//! MCP 传输注册表（F-005）。
//!
//! 默认传输**恒为 stdio**（既有 `commands/mcp_stdio.rs` 保持不变）；切到远程传输
//! （`http` / `sse`）必须显式 `allow_http = true`——这就是 opt-in 的机械门。
//! 配置持久化到既有项目配置目录（`.qmai`）下的 `mcp-transport.json`。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 传输配置文件名（相对项目根的 `.qmai` 目录）。
pub const TRANSPORT_CONFIG_FILE: &str = ".qmai/mcp-transport.json";
/// 默认传输：本地 stdio。
pub const DEFAULT_TRANSPORT: &str = "stdio";
/// 传输模式清单。
pub const TRANSPORTS: [&str; 3] = ["stdio", "http", "sse"];
/// opt-in 字段名（错误信息与配置里都用同一个词）。
pub const ALLOW_HTTP_FLAG: &str = "allow_http";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransportConfig {
    pub transport: String,
    pub allow_http: bool,
}

impl Default for TransportConfig {
    fn default() -> Self {
        TransportConfig {
            transport: DEFAULT_TRANSPORT.to_string(),
            allow_http: false,
        }
    }
}

impl TransportConfig {
    /// 是否远程传输（需要 opt-in）。
    pub fn is_remote(&self) -> bool {
        is_remote_transport(&self.transport)
    }

    /// 当前配置是否允许真正建连。
    pub fn may_connect_remote(&self) -> bool {
        !self.is_remote() || self.allow_http
    }
}

/// 归一传输名；未知值拒绝，不回退默认。
pub fn normalize_transport(value: &str) -> Result<String, String> {
    let lowered = value.trim().to_ascii_lowercase();
    if TRANSPORTS.contains(&lowered.as_str()) {
        Ok(lowered)
    } else {
        Err(format!(
            "unknown transport '{}'; expected one of {}",
            value,
            TRANSPORTS.join("|")
        ))
    }
}

pub fn is_remote_transport(value: &str) -> bool {
    value == "http" || value == "sse"
}

pub fn transport_config_path(project_root: &Path) -> PathBuf {
    project_root.join(TRANSPORT_CONFIG_FILE.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// 读取配置；不存在或损坏时回落到默认（stdio + 未 opt-in）。
pub fn load_config(project_root: &Path) -> TransportConfig {
    let path = transport_config_path(project_root);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return TransportConfig::default();
    };
    serde_json::from_str::<TransportConfig>(&raw).unwrap_or_default()
}

pub fn save_config(project_root: &Path, config: &TransportConfig) -> Result<(), String> {
    let path = transport_config_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("[mcp_transport] create config dir failed: {}", e))?;
    }
    let body = serde_json::to_string_pretty(config)
        .map_err(|e| format!("[mcp_transport] serialize config failed: {}", e))?;
    std::fs::write(&path, format!("{body}\n"))
        .map_err(|e| format!("[mcp_transport] write config failed: {}", e))
}

/// 设置传输模式。切到 http/sse 必须显式 `allow_http = true`。
pub fn set_mode(
    project_root: &Path,
    transport: &str,
    allow_http: bool,
) -> Result<TransportConfig, String> {
    let normalized = normalize_transport(transport)?;
    if is_remote_transport(&normalized) && !allow_http {
        return Err(format!(
            "[mcp_transport] remote transport '{}' requires {} = true (explicit opt-in)",
            normalized, ALLOW_HTTP_FLAG
        ));
    }
    let config = TransportConfig {
        transport: normalized,
        allow_http,
    };
    save_config(project_root, &config)?;
    Ok(config)
}

#[cfg(test)]
mod mcp {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nb-mcp-transport-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("mkdir");
        root
    }

    #[test]
    fn default_transport_is_stdio() {
        let root = temp_root("default");
        let config = load_config(&root);
        assert_eq!(config.transport, DEFAULT_TRANSPORT);
        assert_eq!(config.transport, "stdio");
        assert!(!config.allow_http);
        assert!(!config.is_remote());
        assert!(config.may_connect_remote(), "stdio 不需要 opt-in");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn http_requires_optin() {
        let root = temp_root("http");
        let denied = set_mode(&root, "http", false).expect_err("http 必须 opt-in");
        assert!(denied.contains("allow_http"), "unexpected: {}", denied);
        assert!(
            !transport_config_path(&root).exists(),
            "被拒的设置不得留下配置"
        );

        let allowed = set_mode(&root, "http", true).expect("opt-in 后应通过");
        assert_eq!(allowed.transport, "http");
        assert!(allowed.allow_http);
        assert!(allowed.may_connect_remote());

        let reloaded = load_config(&root);
        assert_eq!(reloaded, allowed, "配置必须可持久化回读");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sse_also_requires_optin() {
        let root = temp_root("sse");
        assert!(set_mode(&root, "sse", false).is_err());
        assert_eq!(set_mode(&root, "sse", true).expect("opt-in").transport, "sse");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_transport_is_rejected_without_fallback() {
        let root = temp_root("unknown");
        let err = set_mode(&root, "carrier-pigeon", true).expect_err("未知传输必须拒绝");
        assert!(err.contains("unknown transport"), "unexpected: {}", err);
        assert_eq!(load_config(&root).transport, "stdio", "不得静默回退到其它模式");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn opting_out_back_to_stdio_clears_remote() {
        let root = temp_root("optout");
        set_mode(&root, "http", true).expect("opt-in");
        let back = set_mode(&root, "stdio", false).expect("回退 stdio");
        assert_eq!(back.transport, "stdio");
        assert!(!back.allow_http);
        assert!(!back.is_remote());
        let _ = std::fs::remove_dir_all(&root);
    }
}
