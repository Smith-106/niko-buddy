// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! file-sync watch-filter 纯函数层——M2-1 自 `file_sync.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：[`SourceWatchConfig`] 默认/归一化、[`SourceWatchRules`] 监视判定
//! （[`should_watch_rel`] / [`normalize_rel_path`] / 通配 [`wildcard_match`] /
//! 扩展名与目录归一化）、任务合并 [`merge_kind`]（经 [`FileChangeKind`]）、
//! 路径键 [`normalize_key`] / [`normalize_path_key`] 与稳定哈希
//! [`stable_path_hash`]——全部确定性、零 IO。
//! `file_sync.rs` 经 `pub` / `pub(crate) use` 回引，外部 import 面零变化
//! （外部引用留守原文件：5 个 Tauri 命令、`FileSyncState`、`mark_app_write_path`）。

use std::collections::BTreeSet;
use std::path::{Component, Path};

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

const DEFAULT_SOURCE_WATCH_CONFIG_JSON: &str =
    include_str!("../../../src/lib/source-watch-defaults.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceWatchConfig {
    #[serde(default = "default_source_watch_enabled")]
    pub(crate) enabled: bool,
    #[serde(default = "default_source_watch_auto_ingest")]
    pub(crate) auto_ingest: bool,
    #[serde(default = "default_source_watch_include_extensions")]
    pub(crate) include_extensions: Vec<String>,
    #[serde(default = "default_source_watch_exclude_extensions")]
    pub(crate) exclude_extensions: Vec<String>,
    #[serde(default = "default_source_watch_exclude_dirs")]
    pub(crate) exclude_dirs: Vec<String>,
    #[serde(default = "default_source_watch_exclude_globs")]
    pub(crate) exclude_globs: Vec<String>,
    #[serde(default = "default_source_watch_max_file_size_mb")]
    pub(crate) max_file_size_mb: u64,
}

impl Default for SourceWatchConfig {
    fn default() -> Self {
        serde_json::from_str(DEFAULT_SOURCE_WATCH_CONFIG_JSON)
            .expect("source-watch-defaults.json must match SourceWatchConfig")
    }
}

fn default_source_watch_config() -> SourceWatchConfig {
    SourceWatchConfig::default()
}

fn default_source_watch_enabled() -> bool {
    default_source_watch_config().enabled
}

fn default_source_watch_auto_ingest() -> bool {
    default_source_watch_config().auto_ingest
}

fn default_source_watch_include_extensions() -> Vec<String> {
    default_source_watch_config().include_extensions
}

fn default_source_watch_exclude_extensions() -> Vec<String> {
    default_source_watch_config().exclude_extensions
}

fn default_source_watch_exclude_dirs() -> Vec<String> {
    default_source_watch_config().exclude_dirs
}

fn default_source_watch_exclude_globs() -> Vec<String> {
    default_source_watch_config().exclude_globs
}

fn default_source_watch_max_file_size_mb() -> u64 {
    default_source_watch_config().max_file_size_mb
}

pub(crate) fn normalize_source_watch_config(config: Option<SourceWatchConfig>) -> SourceWatchConfig {
    let mut config = config.unwrap_or_default();
    config.include_extensions = normalize_ext_list(config.include_extensions);
    config.exclude_extensions = normalize_ext_list(config.exclude_extensions);
    config.exclude_dirs = normalize_string_list(config.exclude_dirs);
    config.exclude_globs = normalize_string_list(config.exclude_globs);
    config.max_file_size_mb = config.max_file_size_mb.clamp(1, 4096);
    config
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Created,
    Modified,
    Deleted,
}

pub(crate) fn merge_kind(existing: &FileChangeKind, incoming: &FileChangeKind) -> FileChangeKind {
    match (existing, incoming) {
        (FileChangeKind::Deleted, FileChangeKind::Created)
        | (FileChangeKind::Created, FileChangeKind::Deleted)
        | (_, FileChangeKind::Modified) => FileChangeKind::Modified,
        (_, kind) => kind.clone(),
    }
}

pub(crate) fn normalize_rel_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

pub(crate) fn should_watch_rel(rel: &str, rules: &SourceWatchRules) -> bool {
    if rel.is_empty() {
        return false;
    }
    let lower = rel.to_lowercase();
    if lower.contains("/.niko-buddy/")
        || lower.starts_with(".niko-buddy/")
        || lower.contains("/.llm-wiki/")
        || lower.starts_with(".llm-wiki/")
        // App-managed generated media is intentionally ignored here. The
        // source markdown references drive graph/index refresh; media bytes
        // themselves are not analyzed by the wiki pipeline.
        || lower.starts_with("QM/media/")
        || lower.starts_with("wiki/media/")
        || lower.ends_with(".ds_store")
    {
        return false;
    }
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name == "thumbs.db" || name == "desktop.ini" {
        return false;
    }
    if rules.matches_excluded_dir(&lower) {
        return false;
    }
    if rules
        .exclude_globs
        .iter()
        .any(|pattern| wildcard_match(pattern, rel) || wildcard_match(pattern, name))
    {
        return false;
    }
    if rel.starts_with("raw/sources/") {
        let ext = extension_of(name);
        if !ext.is_empty() && rules.exclude_extensions.contains(ext) {
            return false;
        }
        if !rules.include_extensions.is_empty()
            && (ext.is_empty() || !rules.include_extensions.contains(ext))
        {
            return false;
        }
        return true;
    }
    rel == "purpose.md"
        || rel == "schema.md"
        || (rel.starts_with("QM/") && rel.ends_with(".md"))
        || (rel.starts_with("wiki/") && rel.ends_with(".md"))
}

pub(crate) struct SourceWatchRules<'a> {
    pub(crate) config: &'a SourceWatchConfig,
    include_extensions: BTreeSet<String>,
    exclude_extensions: BTreeSet<String>,
    exclude_dirs: BTreeSet<String>,
    exclude_globs: Vec<String>,
}

impl<'a> SourceWatchRules<'a> {
    pub(crate) fn new(config: &'a SourceWatchConfig) -> Self {
        Self {
            config,
            include_extensions: config.include_extensions.iter().cloned().collect(),
            exclude_extensions: config.exclude_extensions.iter().cloned().collect(),
            exclude_dirs: config
                .exclude_dirs
                .iter()
                .map(|dir| normalize_rel_string(dir).to_lowercase())
                .filter(|dir| !dir.is_empty())
                .collect(),
            exclude_globs: config.exclude_globs.iter().cloned().collect(),
        }
    }

    fn matches_excluded_dir(&self, rel_lower: &str) -> bool {
        self.exclude_dirs.iter().any(|dir| {
            if dir.contains('/') {
                rel_lower == dir
                    || rel_lower.starts_with(&format!("{dir}/"))
                    || rel_lower.contains(&format!("/{dir}/"))
            } else {
                rel_lower.split('/').any(|part| part == dir)
            }
        })
    }
}

fn normalize_rel_string(value: &str) -> String {
    value.replace('\\', "/").trim_matches('/').to_string()
}

fn extension_of(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")
}

fn normalize_ext_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_lowercase().chars().collect::<Vec<_>>();
    let value = value.to_lowercase().chars().collect::<Vec<_>>();
    wildcard_match_inner(&pattern, &value)
}

fn wildcard_match_inner(pattern: &[char], value: &[char]) -> bool {
    let (mut p, mut v) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut match_after_star = 0usize;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            match_after_star = v;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            match_after_star += 1;
            v = match_after_star;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

pub(crate) fn stable_path_hash(path: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(path.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..12].to_string()
}

pub(crate) fn normalize_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

pub(crate) fn normalize_path_key(path: &Path) -> String {
    normalize_key(&path.to_string_lossy().replace('\\', "/"))
}
