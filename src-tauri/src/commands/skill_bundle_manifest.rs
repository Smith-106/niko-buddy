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

/// 人工复核通过后由独立收据文件背书的信任级别（不采信 `manifest.json` 自述）。
pub const SKILL_BUNDLE_TRUST_REVIEWED: &str = "reviewed";

/// 独立人工复核收据 schema 标识。
pub const SKILL_BUNDLE_REVIEW_SCHEMA: &str = "nbskill-review/1";

/// 独立人工复核收据 schema 版本。
pub const SKILL_BUNDLE_REVIEW_SCHEMA_VERSION: u32 = 1;

/// 独立人工复核收据文件名（位于 `<installed_dir>/` 顶层、`skills/` 之外，不污染 `content_hash`）。
pub const SKILL_BUNDLE_REVIEW_RECEIPT_FILE: &str = ".nb-review-receipt.json";

/// 条目数上限（zip bomb 防护第一道）。
pub const MAX_ENTRIES: u32 = 512;

/// 解压后总字节上限（zip bomb 防护第二道）。
pub const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// 单向声明式 `SKILL.md` 导出的总字节上限（2 MiB）。
pub const MAX_DECLARATIVE_EXPORT_BYTES: u64 = 2 * 1024 * 1024;

/// 单向声明式 `SKILL.md` 导出的最大写入文件数（含 `SKILL.md`）。
pub const MAX_DECLARATIVE_EXPORT_FILES: usize = 64;

/// 导出 `SKILL.md` frontmatter `description` 字符数上限。
pub const MAX_SKILL_DESCRIPTION_CHARS: usize = 200;

/// 人工复核备注字符数上限。
pub const MAX_REVIEWER_NOTE_CHARS: usize = 500;

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

/// 单向声明式导出额外禁止的脚本/二进制扩展名（叠加 `EXECUTABLE_EXTENSIONS` 与 `hooks.json`）。
const DECLARATIVE_FORBIDDEN_EXTRA_EXTENSIONS: [&str; 10] = [
    "psm1", "vbs", "hta", "jar", "lua", "scpt", "lnk", "bin", "ts", "tsx",
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

/// 独立人工复核收据（`<installed_dir>/.nb-review-receipt.json`，位于 `skills/` 之外）。
///
/// 通过密码学绑定 `bundle_id + bundle_version + content_hash + manifest_sha256` 证明人工复核针对的是
/// 当前磁盘上的确切包体，任何篡改都会使收据失效并回落为 `untrusted`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleReviewReceipt {
    pub schema: String,
    pub schema_version: u32,
    pub bundle_id: String,
    pub bundle_version: String,
    pub trust_level: String,
    pub content_hash: String,
    pub manifest_sha256: String,
    pub reviewed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_note: Option<String>,
}

/// 已安装技能包清单条目（`skill_bundle_list_installed` 投影）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleInstalledEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub installed_dir: String,
    pub trust_level: String,
    pub content_hash: String,
    pub manifest_sha256: String,
    pub file_count: usize,
    pub reviewed_at: Option<String>,
    pub reviewer_note: Option<String>,
    pub skill_ids: Vec<String>,
    pub integrity_ok: bool,
}

/// 人工复核状态更新结果（`skill_bundle_mark_reviewed` 返回）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleReviewResult {
    pub ok: bool,
    pub bundle_id: String,
    pub bundle_version: String,
    pub trust_level: String,
    pub content_hash: String,
    pub manifest_sha256: String,
    pub receipt_path: String,
    pub reviewed_at: Option<String>,
}

/// 单向声明式 `SKILL.md` 导出结果（`skill_bundle_export_declarative_skill_md` 返回）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBundleDeclarativeExportResult {
    pub ok: bool,
    pub bundle_id: String,
    pub bundle_version: String,
    pub source_skill_id: String,
    pub exported_skill_name: String,
    pub trust_level: String,
    pub content_hash: String,
    pub manifest_sha256: String,
    pub skill_md_sha256: String,
    pub export_dir: String,
    pub skill_md_path: String,
    pub written_files: Vec<String>,
    pub skipped_non_md_files: Vec<String>,
    pub declarative_only: bool,
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

/// 单向声明式导出禁用条目判定：命中可执行扩展名、扩展脚本/二进制扩展名或 `hooks.json`（大小写不敏感）均返回 `true`。
pub fn is_forbidden_declarative_entry(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if is_executable_name(&normalized) {
        return true;
    }
    if extension_of(&normalized)
        .is_some_and(|ext| DECLARATIVE_FORBIDDEN_EXTRA_EXTENSIONS.contains(&ext.as_str()))
    {
        return true;
    }
    let basename = normalized.rsplit('/').next().unwrap_or(&normalized);
    basename.eq_ignore_ascii_case("hooks.json")
}

/// 严格 `.md` 判定（大小写不敏感，且要求主干非空）。
pub fn is_markdown_entry(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let file = normalized.rsplit('/').next().unwrap_or(&normalized);
    file.rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && ext.eq_ignore_ascii_case("md"))
}

/// 校验并归一化声明式技能目录/frontmatter slug：`^[a-z0-9][a-z0-9-]{0,63}$`，拒绝 Windows 保留设备名。
pub fn sanitize_skill_slug(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.chars().any(|c| c == '\0' || c.is_control()) {
        return Err("[skill_bundle] skill slug must not be empty or contain control chars".into());
    }
    if !raw
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!(
            "[skill_bundle] skill slug contains disallowed characters (expected ASCII [a-z0-9_-]): '{raw}'"
        ));
    }
    let slug: String = raw
        .bytes()
        .map(|b| match b {
            b'_' => '-',
            other => (other as char).to_ascii_lowercase(),
        })
        .collect();
    if slug.is_empty() || slug.len() > 64 {
        return Err(format!(
            "[skill_bundle] skill slug length must be 1..=64 characters: '{raw}'"
        ));
    }
    let first = slug.as_bytes()[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(format!(
            "[skill_bundle] skill slug must start with [a-z0-9]: '{raw}'"
        ));
    }
    if !slug
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(format!(
            "[skill_bundle] skill slug must match ^[a-z0-9][a-z0-9-]{{0,63}}$: '{raw}'"
        ));
    }
    if crate::agent_gate_policy::is_windows_reserved_device_name(&slug) {
        return Err(format!(
            "[skill_bundle] skill slug uses a Windows reserved device name: '{slug}'"
        ));
    }
    Ok(slug)
}

fn sanitize_single_line_description(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if c == '\0'
                || c == '\r'
                || c == '\n'
                || c == '\u{2028}'
                || c == '\u{2029}'
                || c.is_control()
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .chars()
        .take(MAX_SKILL_DESCRIPTION_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        if let Ok(decoded) = serde_json::from_str::<String>(trimmed) {
            return decoded;
        }
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("''", "'");
    }
    trimmed.to_string()
}

fn looks_like_yaml_frontmatter_lines(lines: &[&str]) -> bool {
    let mut saw_key_value = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') || trimmed.starts_with("- ") {
            continue;
        }
        if let Some((key, _)) = trimmed.split_once(':') {
            let k = key.trim();
            if !k.is_empty()
                && k.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                saw_key_value = true;
                continue;
            }
        }
        return false;
    }
    saw_key_value
}

fn extract_frontmatter_description(fm_lines: &[&str]) -> Option<String> {
    let mut idx = 0usize;
    while idx < fm_lines.len() {
        let line = fm_lines[idx];
        if !line.starts_with(' ') && !line.starts_with('\t') {
            if let Some((key, rest)) = line.split_once(':') {
                if key.trim().eq_ignore_ascii_case("description") {
                    let rhs = rest.trim();
                    if matches!(rhs, "" | "|" | "|-" | "|+" | ">" | ">-" | ">+") {
                        let mut parts = Vec::new();
                        let mut next = idx + 1;
                        while next < fm_lines.len() {
                            let cont = fm_lines[next];
                            if cont.starts_with(' ') || cont.starts_with('\t') {
                                parts.push(cont.trim());
                                next += 1;
                            } else if cont.trim().is_empty() {
                                next += 1;
                            } else {
                                break;
                            }
                        }
                        let joined = parts.join(" ");
                        if !joined.trim().is_empty() {
                            return Some(joined);
                        }
                    } else {
                        return Some(unquote_yaml_scalar(rhs));
                    }
                }
            }
        }
        idx += 1;
    }
    None
}

fn extract_first_prose_line(body: &str) -> Option<String> {
    let mut in_code_fence = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#')
            || trimmed.starts_with("<!--")
            || trimmed.chars().all(|c| matches!(c, '-' | '*' | '_' | ' '))
        {
            continue;
        }
        let candidate = trimmed
            .trim_start_matches(['>', '-', '*', '+'])
            .trim_start();
        let cleaned = sanitize_single_line_description(candidate);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    None
}

fn sanitize_comment_token(raw: &str) -> String {
    let mut cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() && *c != '>' && *c != '<')
        .collect();
    while cleaned.contains("--") {
        cleaned = cleaned.replace("--", "-");
    }
    cleaned
}

/// 将人工复核包中的原始技能 Markdown 清洗为严格声明式 `SKILL.md`：
/// - 剥离全部原始 YAML frontmatter（永不透传 `hooks:` / `tools:` / `exec:` / `command:` 等字段）；
/// - 严格仅输出 `{name, description}` 单行 YAML 1.2 frontmatter（`description` 经控制字符剥离、空白折叠、200 字符截断与 JSON 双引号转义）；
/// - 附带单向导出溯源注释，随后保留清洗后的正文。
pub fn render_sanitized_skill_md(
    slug: &str,
    raw_markdown: &str,
    fallback_desc: &str,
    bundle_id: &str,
    bundle_version: &str,
    content_hash: &str,
) -> Result<String, String> {
    if raw_markdown.contains('\0') {
        return Err("[skill_bundle] source skill markdown must not contain NUL bytes".into());
    }
    let clean_slug = sanitize_skill_slug(slug)?;
    let without_bom = raw_markdown
        .strip_prefix('\u{feff}')
        .unwrap_or(raw_markdown);
    let normalized = without_bom.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.lines().collect();

    let mut cursor = 0usize;
    let mut extracted_desc: Option<String> = None;

    // 剥离起始位置的一层或多层 YAML frontmatter（防止叠加 frontmatter 注入）。
    let mut first_block = true;
    loop {
        while !first_block && cursor < lines.len() && lines[cursor].trim().is_empty() {
            cursor += 1;
        }
        if cursor >= lines.len() || lines[cursor].trim() != "---" {
            break;
        }
        let Some(rel_end) = lines[cursor + 1..]
            .iter()
            .position(|line| matches!(line.trim(), "---" | "..."))
        else {
            break;
        };
        let fm_slice = &lines[cursor + 1..cursor + 1 + rel_end];
        if !first_block && !looks_like_yaml_frontmatter_lines(fm_slice) {
            break;
        }
        if extracted_desc.is_none() {
            extracted_desc = extract_frontmatter_description(fm_slice);
        }
        cursor = cursor + 1 + rel_end + 1;
        first_block = false;
    }

    let body = lines[cursor..].join("\n");
    let body_trimmed = body.trim_start_matches('\n');

    let desc = extracted_desc
        .as_deref()
        .map(sanitize_single_line_description)
        .filter(|s| !s.is_empty())
        .or_else(|| extract_first_prose_line(body_trimmed))
        .or_else(|| {
            let clean = sanitize_single_line_description(fallback_desc);
            if clean.is_empty() {
                None
            } else {
                Some(clean)
            }
        })
        .unwrap_or_else(|| {
            sanitize_single_line_description(&format!(
                "Declarative skill exported from {bundle_id}"
            ))
        });

    let quoted_desc = serde_json::to_string(&desc)
        .map_err(|e| format!("[skill_bundle] failed to serialize skill description: {e}"))?;
    let safe_id = sanitize_comment_token(bundle_id);
    let safe_ver = sanitize_comment_token(bundle_version);
    let safe_hash = sanitize_comment_token(content_hash);

    let mut out = format!(
        "---\nname: {clean_slug}\ndescription: {quoted_desc}\n---\n\n<!-- Exported one-way from reviewed nbskill/1 bundle: id={safe_id} version={safe_ver} content_hash={safe_hash} -->\n\n{body_trimmed}"
    );
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// 严格校验人工复核收据与当前磁盘已验证包体的密码学绑定关系。
pub fn validate_review_receipt(
    receipt: &SkillBundleReviewReceipt,
    expected_id: &str,
    expected_version: &str,
    expected_content_hash: &str,
    expected_manifest_sha256: &str,
) -> Result<(), String> {
    if receipt.schema != SKILL_BUNDLE_REVIEW_SCHEMA {
        return Err(format!(
            "[skill_bundle] unsupported review receipt schema '{}' (expected '{SKILL_BUNDLE_REVIEW_SCHEMA}')",
            receipt.schema
        ));
    }
    if receipt.schema_version != SKILL_BUNDLE_REVIEW_SCHEMA_VERSION {
        return Err(format!(
            "[skill_bundle] unsupported review receipt schema_version {} (expected {SKILL_BUNDLE_REVIEW_SCHEMA_VERSION})",
            receipt.schema_version
        ));
    }
    if receipt.trust_level != SKILL_BUNDLE_TRUST_REVIEWED {
        return Err(format!(
            "[skill_bundle] review receipt trust_level must be '{SKILL_BUNDLE_TRUST_REVIEWED}', got '{}'",
            receipt.trust_level
        ));
    }
    if receipt.bundle_id != expected_id {
        return Err(format!(
            "[skill_bundle] review receipt bundle_id mismatch (expected '{expected_id}', got '{}')",
            receipt.bundle_id
        ));
    }
    if receipt.bundle_version != expected_version {
        return Err(format!(
            "[skill_bundle] review receipt bundle_version mismatch (expected '{expected_version}', got '{}')",
            receipt.bundle_version
        ));
    }
    if !looks_like_sha256_hex(&receipt.content_hash)
        || receipt.content_hash != expected_content_hash
    {
        return Err(format!(
            "[skill_bundle] review receipt content_hash mismatch (expected '{expected_content_hash}', got '{}')",
            receipt.content_hash
        ));
    }
    if !looks_like_sha256_hex(&receipt.manifest_sha256)
        || receipt.manifest_sha256 != expected_manifest_sha256
    {
        return Err(format!(
            "[skill_bundle] review receipt manifest_sha256 mismatch (expected '{expected_manifest_sha256}', got '{}')",
            receipt.manifest_sha256
        ));
    }
    if receipt.reviewed_at.trim().is_empty() || receipt.reviewed_at.chars().any(char::is_control) {
        return Err(
            "[skill_bundle] review receipt reviewed_at must be a non-empty timestamp without control chars"
                .into(),
        );
    }
    if let Some(note) = &receipt.reviewer_note {
        if note.chars().any(char::is_control) {
            return Err(
                "[skill_bundle] review receipt reviewer_note must not contain control chars".into(),
            );
        }
        if note.chars().count() > MAX_REVIEWER_NOTE_CHARS {
            return Err(format!(
                "[skill_bundle] review receipt reviewer_note exceeds {MAX_REVIEWER_NOTE_CHARS} chars"
            ));
        }
    }
    Ok(())
}

/// 条目名安全守卫：拒绝空名、控制字符、绝对路径、Windows 盘符/ADS `:`、反斜杠、`.`/`..`、
/// 尾点/首尾空格、Windows 非法字符与保留设备名。
///
/// 在读取阶段就拒绝（不依赖解压目录的 canonicalize），使 zip 内部无机会触碰目标目录之外的位置。
pub fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("[skill_bundle] empty zip entry name".to_string());
    }
    if name.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(format!(
            "[skill_bundle] control character in zip entry rejected: {name}"
        ));
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
    // Windows 盘符（`C:/...`）与 NTFS ADS（`foo.md::$DATA`）。
    if name.contains(':') {
        return Err(format!(
            "[skill_bundle] drive-qualified or colon zip entry rejected: {name}"
        ));
    }
    let body = name.strip_suffix('/').unwrap_or(name);
    if body.is_empty() {
        return Err(format!(
            "[skill_bundle] malformed zip entry rejected: {name}"
        ));
    }
    for component in body.split('/') {
        if component == ".." {
            return Err(format!("[skill_bundle] path traversal rejected: {name}"));
        }
        if component.is_empty() || component == "." {
            return Err(format!(
                "[skill_bundle] malformed zip entry rejected: {name}"
            ));
        }
        if component != component.trim() || component.ends_with('.') {
            return Err(format!(
                "[skill_bundle] trailing dot or whitespace in zip entry rejected: {name}"
            ));
        }
        if component.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return Err(format!(
                "[skill_bundle] illegal filename character in zip entry rejected: {name}"
            ));
        }
        if crate::agent_gate_policy::is_windows_reserved_device_name(component) {
            return Err(format!(
                "[skill_bundle] Windows reserved device name in zip entry rejected: {name}"
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
    crate::agent_gate_policy::validate_safe_single_segment(&manifest.id, "manifest.id")
        .map_err(|e| format!("[skill_bundle] {e}"))?;
    crate::agent_gate_policy::validate_safe_single_segment(&manifest.version, "manifest.version")
        .map_err(|e| format!("[skill_bundle] {e}"))?;
    for (field, value) in [
        ("name", &manifest.name),
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
        if file
            .path
            .rsplit('/')
            .next()
            .is_some_and(|base| base.eq_ignore_ascii_case(SKILL_BUNDLE_REVIEW_RECEIPT_FILE))
        {
            return Err(format!(
                "[skill_bundle] review receipt filename forbidden in manifest: {}",
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
        if artifact.contains("..")
            || artifact.starts_with('/')
            || artifact.contains('\\')
            || artifact.contains(':')
            || artifact.chars().any(|c| c == '\0' || c.is_control())
        {
            return Err(format!(
                "[skill_bundle] writable_artifacts entry must be a relative POSIX path: {artifact}"
            ));
        }
    }
    Ok(())
}
