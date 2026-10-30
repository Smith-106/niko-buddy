// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! skill-bundle 格式契约纯函数层——M9-1 自 `skill_bundle.rs` 增量剥离（S4 单轮收敛，file_sync_watch 模式）。
//!
//! 收容：包格式常量（`SKILL_BUNDLE_*` / `MAX_*`）、清单与 IPC 结果类型
//! （[`BundleFileRef`] / [`SkillBundleAllowlist`] / [`SkillBundleManifest`] /
//! [`SkillBundleExportResult`] / [`SkillBundleVerifyResult`] / [`SkillBundleImportResult`]）、
//! 名称与扩展名守卫（[`is_executable_name`] / [`is_allowed_name`] /
//! [`validate_entry_name`]）、清单校验 [`validate_manifest`]与其内聚辅助
//! （`manifest_sha256_of` / `looks_like_sha256_hex` / `version_at_least`）——全部确定性、零 IO、零 Tauri。
//! `skill_bundle.rs` 经 `pub` / `pub(crate) use` 回引，外部 import 面零变化
//! （外部引用留守原文件：3 个 Tauri 命令）。
//!
//! M9-1 可见性调整（最小化）：`manifest_sha256_of` / `version_at_least` /
//! `looks_like_sha256_hex` 提为 `pub(crate)`供原文件 impl 与单测复用；
//! `SkillBundleVerifyResult::schema_version` 由私有改为 `pub(crate)`供 `verify_impl`
//! 跨模块构造；均无新增 `allow(dead_code)`。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 包格式标识（G-6：显式 schema 名，不识别即拒收）。
pub const SKILL_BUNDLE_SCHEMA: &str = "nbskill/1";

/// 清单 schema 版本（major 不识别即拒收）。
pub const SKILL_BUNDLE_SCHEMA_VERSION: u32 = 1;

/// 清单文件名。
pub const SKILL_BUNDLE_MANIFEST_FILE: &str = "manifest.json";

/// 技能根目录名。
pub const SKILL_BUNDLE_SKILLS_DIR: &str = "skills";

/// 导入器对 `trust_level` 的盖章值（不采信包内自述）。
pub const SKILL_BUNDLE_TRUST_UNTRUSTED: &str = "untrusted";

/// 条目数上限（zip bomb 防护第一道）。
pub const MAX_ENTRIES: u32 = 512;

/// 解压后总字节上限（zip bomb 防护第二道）。
pub const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// 允许的扩展名 allowlist（G-6）。不在表内即拒绝。
const ALLOWED_EXTENSIONS: [&str; 7] = ["md", "txt", "json", "yaml", "csv", "png", "svg"];

/// 可执行扩展名 denylist（C-007：脚本通道整体否决）。
///
/// 与 TS 侧 `src/lib/novel/user-asset-domain.ts` 的 `USER_ASSET_EXECUTABLE_EXTENSIONS`
/// 同源；跨语言各持一份实现是刻意的——任一侧被删改都不应静默削弱另一侧的拒绝能力。
const EXECUTABLE_EXTENSIONS: [&str; 21] = [
    "exe", "dll", "so", "dylib", "ps1", "bat", "cmd", "com", "scr", "sh", "bash", "zsh", "fish",
    "py", "pyc", "js", "mjs", "cjs", "rb", "pl", "wasm",
];

// ── 清单类型 ───────────────────────────────────────────────────────────────

/// 清单内的单文件引用（path 相对包根，POSIX 分隔符）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleFileRef {
    pub path: String,
    pub hash: String,
    pub size: u64,
}

/// 技能可写产物白名单（G-6）：**未声明即拒绝**。
///
/// 两个字段都**不带** `#[serde(default)]`——字段缺失时反序列化直接失败，
/// 使「未声明即拒绝」成为结构层约束而非运行时检查。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleAllowlist {
    /// 技能允许读取的运行态键（只读声明）。
    pub readable_state: Vec<String>,
    /// 技能允许写入的产物路径（相对项目根；空数组表示不写任何产物）。
    pub writable_artifacts: Vec<String>,
}

/// 技能包清单。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleManifest {
    /// 格式标识（必须等于 [`SKILL_BUNDLE_SCHEMA`]）。
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    /// 技能内容指纹（= 归档块集合的 `content_digest`，来自 TASK-004 原语）。
    pub content_hash: String,
    /// 产出来源（自由标签；不参与信任判定）。
    pub source: String,
    /// 包内自述的信任级别；**导入器一律盖章为 `untrusted`**。
    pub trust_level: String,
    /// 要求的最低 NB 版本（点分数字比较）。
    pub min_nb_version: String,
    /// 依赖的其他技能 id。
    #[serde(default)]
    pub deps: Vec<String>,
    /// 可写产物白名单（G-6）。
    pub allowlist: SkillBundleAllowlist,
    /// 逐文件哈希表（导入时逐文件比对；同时覆盖进 `content_hash`）。
    #[serde(default)]
    pub files: Vec<BundleFileRef>,
}

/// 导出结果（IPC 载荷；不含任何路径穿越信息以外的敏感内容）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleExportResult {
    pub bundle_path: String,
    pub id: String,
    pub version: String,
    pub content_hash: String,
    pub manifest_sha256: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

/// 校验结果（`ok = mismatched.is_empty() && rejected.is_empty()`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleVerifyResult {
    pub ok: bool,
    pub(crate) schema_version: u32,
    pub trust_level: String,
    pub manifest_sha256: String,
    pub content_hash: String,
    /// 哈希不匹配的条目路径。
    pub mismatched: Vec<String>,
    /// 结构性拒绝原因（schema / allowlist / 扩展名 / sidecar / 版本）。
    pub rejected: Vec<String>,
    pub entry_count: u32,
    pub total_bytes: u64,
    /// 清单本体（供导入对话框逐项展示；清单缺失/不可解析时校验直接报错）。
    pub manifest: Option<SkillBundleManifest>,
}

/// 导入结果。**不包含**任何可执行路径；`trust_level` 恒为 `untrusted`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleImportResult {
    pub ok: bool,
    pub id: String,
    pub name: String,
    pub version: String,
    /// 导入器盖章后的信任级别（恒为 `untrusted`）。
    pub trust_level: String,
    /// 原子 promote 后的安装目录（用户资产域内）。
    pub installed_dir: String,
    pub content_hash: String,
    pub manifest_sha256: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub readable_state: Vec<String>,
    pub writable_artifacts: Vec<String>,
    pub warnings: Vec<String>,
}

// ── 名称与扩展名守卫 ───────────────────────────────────────────────────────

fn extension_of(name: &str) -> Option<String> {
    let file = name.rsplit('/').next().unwrap_or(name);
    file.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
}

/// 可执行扩展名 → true（C-007：一律拒绝导入）。
pub fn is_executable_name(name: &str) -> bool {
    extension_of(name)
        .map(|ext| EXECUTABLE_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// 扩展名在 allowlist 内 → true。无扩展名的条目（目录除外）一律不在表内。
pub fn is_allowed_name(name: &str) -> bool {
    extension_of(name)
        .map(|ext| ALLOWED_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// 条目名安全守卫：拒绝绝对路径、Windows 盘符、反斜杠分隔符与 `..` 穿越。
///
/// 与 `commands/backup.rs::extract_dir_from_zip` 的组件级归一化同源；此处的差别是
/// **在读取阶段就拒绝**（不依赖解压目录的 canonicalize），因此 zip 内部再无机会
/// 触碰目标目录之外的位置。
pub fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("[skill_bundle] empty zip entry name".to_string());
    }
    if name.contains('\\') {
        return Err(format!(
            "[skill_bundle] zip entry must use POSIX separators: {name}"
        ));
    }
    if name.starts_with('/') {
        return Err(format!(
            "[skill_bundle] absolute zip entry rejected: {name}"
        ));
    }
    // Windows 盘符（`C:/...`）与 UNC 前缀。
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!(
            "[skill_bundle] drive-qualified zip entry rejected: {name}"
        ));
    }
    for component in name.split('/') {
        if component == ".." {
            return Err(format!("[skill_bundle] path traversal rejected: {name}"));
        }
        if component.is_empty() && !name.ends_with('/') {
            return Err(format!(
                "[skill_bundle] malformed zip entry rejected: {name}"
            ));
        }
    }
    Ok(())
}

pub(crate) fn manifest_sha256_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn looks_like_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 点分数字版本比较：`current >= required` → true。
///
/// 只比较数字段（`1.2.10` vs `1.2.9` 必须判为「够新」）；非数字后缀忽略，
/// 因为 NB 版本号本身是点分数字形态。
pub(crate) fn version_at_least(current: &str, required: &str) -> bool {
    fn segments(value: &str) -> Vec<u64> {
        value
            .split('.')
            .map(|part| {
                let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<u64>().unwrap_or(0)
            })
            .collect()
    }
    let mut lhs = segments(current);
    let mut rhs = segments(required);
    let width = lhs.len().max(rhs.len());
    lhs.resize(width, 0);
    rhs.resize(width, 0);
    lhs >= rhs
}

/// 清单结构校验（纯函数；拒绝原因拼成 `Err`）。
pub fn validate_manifest(manifest: &SkillBundleManifest) -> Result<(), String> {
    if manifest.schema != SKILL_BUNDLE_SCHEMA {
        return Err(format!(
            "[skill_bundle] unsupported schema {} (expected {SKILL_BUNDLE_SCHEMA})",
            manifest.schema
        ));
    }
    if manifest.schema_version != SKILL_BUNDLE_SCHEMA_VERSION {
        return Err(format!(
            "[skill_bundle] unsupported schema_version {} (supported: {SKILL_BUNDLE_SCHEMA_VERSION})",
            manifest.schema_version
        ));
    }
    for (field, value) in [
        ("id", &manifest.id),
        ("name", &manifest.name),
        ("version", &manifest.version),
        ("min_nb_version", &manifest.min_nb_version),
    ] {
        if value.trim().is_empty() {
            return Err(format!(
                "[skill_bundle] manifest field {field} must not be empty"
            ));
        }
    }
    if !looks_like_sha256_hex(&manifest.content_hash) {
        return Err(
            "[skill_bundle] manifest content_hash must be a 64-char sha256 hex".to_string(),
        );
    }
    if manifest.files.is_empty() {
        return Err("[skill_bundle] manifest files[] must not be empty".to_string());
    }
    let mut seen: BTreeMap<&str, ()> = BTreeMap::new();
    for file in &manifest.files {
        validate_entry_name(&file.path)?;
        if !file
            .path
            .starts_with(&format!("{SKILL_BUNDLE_SKILLS_DIR}/"))
        {
            return Err(format!(
                "[skill_bundle] manifest file must live under {SKILL_BUNDLE_SKILLS_DIR}/: {}",
                file.path
            ));
        }
        if !looks_like_sha256_hex(&file.hash) {
            return Err(format!(
                "[skill_bundle] manifest file hash must be sha256 hex: {}",
                file.path
            ));
        }
        if is_executable_name(&file.path) {
            return Err(format!(
                "[skill_bundle] executable entry rejected by manifest: {}",
                file.path
            ));
        }
        if !is_allowed_name(&file.path) {
            return Err(format!(
                "[skill_bundle] entry outside extension allowlist: {}",
                file.path
            ));
        }
        if seen.insert(file.path.as_str(), ()).is_some() {
            return Err(format!(
                "[skill_bundle] duplicate manifest file: {}",
                file.path
            ));
        }
    }
    // allowlist 字段存在性由 serde 保证；此处校验声明内容本身不可越界。
    for artifact in &manifest.allowlist.writable_artifacts {
        if artifact.contains("..") || artifact.starts_with('/') || artifact.contains('\\') {
            return Err(format!(
                "[skill_bundle] writable_artifacts entry must be a relative POSIX path: {artifact}"
            ));
        }
    }
    Ok(())
}
