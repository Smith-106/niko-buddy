// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! F-002 技能包**离线协议**：格式契约 + 导出 / 校验 / 安全导入。
//!
//! ## 为什么需要格式契约
//! NB 已有 13 类技能体系（`src/lib/novel/skill-library.ts`、`skill-favorite.ts`、
//! `skill-hub-seed.ts`、`de-ai-skill-library.ts`、`skill-route-registry.ts`），缺的不是
//! 技能而是**可交换的包格式**（subject-matter-expert 结论）。本模块定义包为 zip 容器：
//! `manifest.json` + `skills/<id>/**`，并**复用** TASK-004 的块寻址原语
//! （[`crate::canon::archive`]）与既有 `.sha256` sidecar 范式
//! （[`crate::canon::export`]）——不新增第二套清单/校验体系。
//!
//! ## 硬约束
//! - **C-013**：MUST NOT 以在线市场前缀命名，MUST NOT 提供任何上传 / 下载端点。
//!   本模块只做**本地文件**读写：一个 `bundle_path` 进，一个目录出，零网络。
//! - **C-007 / G-6**：可执行脚本通道整体否决——包内可执行扩展名**一律**拒绝导入，
//!   且不提供任何自动执行路径；扩展名 allowlist 为 `.md/.txt/.json/.yaml/.csv/.png/.svg`。
//! - **`allowlist` 强制**：技能必须声明 `readable_state[]` 与 `writable_artifacts[]`
//!   （字段缺失即整包拒绝）；技能 MUST NOT 覆盖 C-003 门控优先级
//!   （`Consistency(P0) > Anti-AI(P1) > Quality(P2)`）。
//! - **默认不可信**：导入器对 `trust_level` **盖章**为 `untrusted`，不采信包内自述。
//! - **写入权威**：导入前调用 [`may_write`]（TASK-002）；`QM/`、`canon`、
//!   `.novel/status.json` 一律 `Deny`（fail-closed），用户资产域为 `RequireGate`，
//!   由显式 `confirmed` 参数把「导入确认门」变成机械约束。
//!
//! ## 包布局
//! ```text
//! <bundle>.nbskill.zip
//!   manifest.json                     ← 清单（含 content_hash / files[] / allowlist）
//!   skills/<skill_id>/skill.md
//!   skills/<skill_id>/assets/<...>
//! <bundle>.nbskill.zip.sha256         ← manifest 文件字节的 sha256（sidecar 范式）
//! ```
//! `manifest_sha256` 之所以落在 **sidecar** 而非清单字段：清单无法自包含自身哈希
//! （自引用不可能），sidecar 是既有 `write_checksum_sidecar` 的复用处。

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use walkdir::WalkDir;

use crate::canon::archive;
use crate::canon::export::{parse_sidecar_checksum, write_checksum_sidecar};
use crate::canon::write_authority::{may_write, WriteDecision, WriteSource};

// M9-1：格式契约 + 校验纯函数层已剥离至 `skill_bundle_manifest.rs`——file_sync_watch 模式：新文件 + 原文件 re-export，外部 import 面零变化。
pub use super::skill_bundle_manifest::{
    BundleFileRef, SkillBundleAllowlist, SkillBundleExportResult, SkillBundleImportResult,
    SkillBundleManifest, SkillBundleVerifyResult, MAX_BYTES, MAX_ENTRIES,
    SKILL_BUNDLE_MANIFEST_FILE, SKILL_BUNDLE_SCHEMA, SKILL_BUNDLE_SCHEMA_VERSION,
    SKILL_BUNDLE_SKILLS_DIR, SKILL_BUNDLE_TRUST_UNTRUSTED, is_allowed_name,
    is_executable_name, validate_entry_name, validate_manifest,
};
pub(crate) use super::skill_bundle_manifest::{manifest_sha256_of, version_at_least};

// ── zip 读写（共用守卫）────────────────────────────────────────────────────

/// 读取包内全部文件条目，逐条施加安全守卫。
///
/// 用 `by_index` 而非 `by_name`：要看到**每一个**条目（含可疑名），才谈得上拒绝它们。
fn read_bundle_entries(bundle_path: &Path) -> Result<(Vec<(String, Vec<u8>)>, u64), String> {
    let file = fs::File::open(bundle_path)
        .map_err(|e| format!("[skill_bundle] open {} failed: {e}", bundle_path.display()))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("[skill_bundle] not a readable zip archive: {e}"))?;

    let count = zip.len() as u32;
    if count > MAX_ENTRIES {
        return Err(format!(
            "[skill_bundle] archive has {count} entries, exceeds MAX_ENTRIES={MAX_ENTRIES}"
        ));
    }

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total: u64 = 0;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("[skill_bundle] read entry #{index} failed: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        validate_entry_name(&raw_name)?;
        if is_executable_name(&raw_name) {
            return Err(format!(
                "[skill_bundle] executable entry rejected: {raw_name} (script channel is denied by C-007)"
            ));
        }
        let mut buffer: Vec<u8> = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("[skill_bundle] read entry {raw_name} failed: {e}"))?;
        total += buffer.len() as u64;
        if total > MAX_BYTES {
            return Err(format!(
                "[skill_bundle] unpacked size exceeds MAX_BYTES={MAX_BYTES}"
            ));
        }
        entries.push((raw_name.replace('\\', "/"), buffer));
    }
    Ok((entries, total))
}

/// 把条目写盘到 `staging`（条目名已过 [`validate_entry_name`]）。
fn write_entries_to(entries: &[(String, Vec<u8>)], staging: &Path) -> Result<Vec<String>, String> {
    fs::create_dir_all(staging)
        .map_err(|e| format!("[skill_bundle] create staging failed: {e}"))?;
    let mut written: Vec<String> = Vec::new();
    for (name, bytes) in entries {
        let destination = staging.join(name);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[skill_bundle] create {} failed: {e}", parent.display()))?;
        }
        fs::write(&destination, bytes)
            .map_err(|e| format!("[skill_bundle] write {} failed: {e}", destination.display()))?;
        written.push(name.clone());
    }
    written.sort();
    Ok(written)
}

fn manifest_bytes(entries: &[(String, Vec<u8>)]) -> Option<&Vec<u8>> {
    entries
        .iter()
        .find(|(name, _)| name == SKILL_BUNDLE_MANIFEST_FILE)
        .map(|(_, bytes)| bytes)
}

fn remove_quietly(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn unique_suffix() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

// ── 导出 ───────────────────────────────────────────────────────────────────

/// 导出技能包。
///
/// `source_root` 下的每个 `<skill_id>/` 目录即一个技能（`skill.md` + 可选 assets）。
/// 返回值只含指纹与计数；**不提供任何上传 / 下载端点**（C-013）。
///
/// > 签名偏差说明：任务卡原写 `skill_bundle_export(skill_ids, dest_path)`（2 参），
/// > 但 Rust 侧**不存在**用户技能存储（`rg -ln 'userSkill|user-skill|user_skill'
/// > src-tauri/src/` 命中 0 文件）——技能是前端/TS 概念。故显式传入 `source_root`，
/// > 由调用方（TS 层）决定技能从何而来，避免在 Rust 侧虚构第二份技能真源。
#[tauri::command]
pub async fn skill_bundle_export(
    skill_ids: Vec<String>,
    source_root: String,
    dest_path: String,
) -> Result<SkillBundleExportResult, String> {
    export_impl(&skill_ids, Path::new(&source_root), Path::new(&dest_path))
}

fn export_impl(
    skill_ids: &[String],
    source_root: &Path,
    dest_path: &Path,
) -> Result<SkillBundleExportResult, String> {
    if !source_root.is_dir() {
        return Err(format!(
            "[skill_bundle] source root is not a directory: {}",
            source_root.display()
        ));
    }

    let mut ids: Vec<String> = skill_ids.iter().map(|id| id.trim().to_string()).collect();
    ids.retain(|id| !id.is_empty());
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err("[skill_bundle] skill_ids must not be empty".to_string());
    }

    let staging = std::env::temp_dir().join(format!("nbskill-export-{}", unique_suffix()));
    remove_quietly(&staging);

    let outcome = (|| -> Result<SkillBundleExportResult, String> {
        let mut files: Vec<BundleFileRef> = Vec::new();
        let mut total_bytes: u64 = 0;

        for id in &ids {
            if id.contains('/') || id.contains('\\') || id.contains("..") {
                return Err(format!("[skill_bundle] invalid skill id: {id}"));
            }
            let skill_dir = source_root.join(id);
            if !skill_dir.is_dir() {
                return Err(format!("[skill_bundle] skill not found: {id}"));
            }
            let mut relative_paths: Vec<String> = Vec::new();
            for entry in WalkDir::new(&skill_dir).follow_links(false) {
                let entry = entry.map_err(|e| format!("[skill_bundle] walk failed: {e}"))?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&skill_dir)
                    .map_err(|e| format!("[skill_bundle] strip_prefix failed: {e}"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                relative_paths.push(relative);
            }
            relative_paths.sort();

            for relative in relative_paths {
                let bundle_path = format!("{SKILL_BUNDLE_SKILLS_DIR}/{id}/{relative}");
                validate_entry_name(&bundle_path)?;
                if is_executable_name(&bundle_path) {
                    return Err(format!(
                        "[skill_bundle] executable entry cannot be exported: {bundle_path}"
                    ));
                }
                if !is_allowed_name(&bundle_path) {
                    return Err(format!(
                        "[skill_bundle] entry outside extension allowlist: {bundle_path}"
                    ));
                }
                let bytes = fs::read(skill_dir.join(&relative))
                    .map_err(|e| format!("[skill_bundle] read {relative} failed: {e}"))?;
                total_bytes += bytes.len() as u64;
                if total_bytes > MAX_BYTES {
                    return Err(format!(
                        "[skill_bundle] bundle size exceeds MAX_BYTES={MAX_BYTES}"
                    ));
                }
                let destination = staging.join(&bundle_path);
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("[skill_bundle] create staging dir failed: {e}"))?;
                }
                fs::write(&destination, &bytes)
                    .map_err(|e| format!("[skill_bundle] stage {bundle_path} failed: {e}"))?;
                files.push(BundleFileRef {
                    path: bundle_path,
                    hash: archive::block_hash(&bytes),
                    size: bytes.len() as u64,
                });
            }
        }

        files.sort_by(|a, b| a.path.cmp(&b.path));

        // 内容指纹复用 TASK-004 的块寻址原语（staging 此刻只含 skills/，故 digest 覆盖技能内容）。
        let content_hash = archive::build_manifest(&staging)?.content_digest;

        let primary = ids.first().cloned().unwrap_or_default();
        let manifest = SkillBundleManifest {
            schema: SKILL_BUNDLE_SCHEMA.to_string(),
            schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
            id: primary.clone(),
            name: primary.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            content_hash: content_hash.clone(),
            source: "niko-buddy-local".to_string(),
            // 导出侧同样如实标注：本地产物不等于可信内容。
            trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED.to_string(),
            min_nb_version: env!("CARGO_PKG_VERSION").to_string(),
            deps: Vec::new(),
            allowlist: SkillBundleAllowlist {
                readable_state: Vec::new(),
                writable_artifacts: Vec::new(),
            },
            files: files.clone(),
        };
        validate_manifest(&manifest)?;

        let encoded = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("[skill_bundle] serialize manifest failed: {e}"))?;
        fs::write(staging.join(SKILL_BUNDLE_MANIFEST_FILE), &encoded)
            .map_err(|e| format!("[skill_bundle] write manifest failed: {e}"))?;

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[skill_bundle] create destination dir failed: {e}"))?;
        }
        let sink = fs::File::create(dest_path)
            .map_err(|e| format!("[skill_bundle] create {} failed: {e}", dest_path.display()))?;
        let mut writer = zip::ZipWriter::new(sink);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        let mut names: Vec<String> = entries_on_disk(&staging)?;
        names.sort();
        for name in names {
            let bytes = fs::read(staging.join(&name))
                .map_err(|e| format!("[skill_bundle] read staged {name} failed: {e}"))?;
            writer
                .start_file(name.clone(), options)
                .map_err(|e| format!("[skill_bundle] zip start_file {name} failed: {e}"))?;
            writer
                .write_all(&bytes)
                .map_err(|e| format!("[skill_bundle] zip write {name} failed: {e}"))?;
        }
        writer
            .finish()
            .map_err(|e| format!("[skill_bundle] zip finish failed: {e}"))?;

        let manifest_sha256 = manifest_sha256_of(&encoded);
        write_checksum_sidecar(dest_path, &manifest_sha256)?;

        Ok(SkillBundleExportResult {
            bundle_path: dest_path.to_string_lossy().replace('\\', "/"),
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            content_hash,
            manifest_sha256,
            file_count: files.len(),
            total_bytes,
        })
    })();

    remove_quietly(&staging);
    outcome
}

/// 列出 staging 下的全部文件（相对路径，POSIX）。
fn entries_on_disk(root: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| format!("[skill_bundle] walk failed: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("[skill_bundle] strip_prefix failed: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        names.push(relative);
    }
    Ok(names)
}

// ── 校验 ───────────────────────────────────────────────────────────────────

/// 校验技能包：结构（schema / allowlist / 扩展名）+ 指纹（content_hash / 逐文件）
/// + sidecar（manifest sha256）。
///
/// **不落任何持久产物**（staging 用后即删）。结构性失败经 `rejected` 上报而非 `Err`，
/// 便于 UI 逐条展示拒绝原因。
#[tauri::command]
pub async fn skill_bundle_verify(bundle_path: String) -> Result<SkillBundleVerifyResult, String> {
    verify_impl(Path::new(&bundle_path))
}

fn verify_impl(bundle_path: &Path) -> Result<SkillBundleVerifyResult, String> {
    let (entries, total_bytes) = read_bundle_entries(bundle_path)?;
    let mut rejected: Vec<String> = Vec::new();
    let mut mismatched: Vec<String> = Vec::new();

    let raw_manifest = manifest_bytes(&entries).ok_or_else(|| {
        format!("[skill_bundle] {SKILL_BUNDLE_MANIFEST_FILE} missing from bundle")
    })?;
    let manifest: SkillBundleManifest = serde_json::from_slice(raw_manifest)
        .map_err(|e| format!("[skill_bundle] manifest parse failed: {e}"))?;
    if let Err(reason) = validate_manifest(&manifest) {
        rejected.push(reason);
    }
    if !version_at_least(env!("CARGO_PKG_VERSION"), &manifest.min_nb_version) {
        rejected.push(format!(
            "[skill_bundle] requires Niko Buddy >= {}, current {}",
            manifest.min_nb_version,
            env!("CARGO_PKG_VERSION")
        ));
    }

    let staging = std::env::temp_dir().join(format!("nbskill-verify-{}", unique_suffix()));
    let result = (|| -> Result<SkillBundleVerifyResult, String> {
        write_entries_to(&entries, &staging)?;

        let skills_root = staging.join(SKILL_BUNDLE_SKILLS_DIR);
        if skills_root.is_dir() {
            let actual = archive::build_manifest(&skills_root)?;
            if actual.content_digest != manifest.content_hash {
                mismatched.push(format!(
                    "{SKILL_BUNDLE_SKILLS_DIR}/ (content_hash expected {} got {})",
                    manifest.content_hash, actual.content_digest
                ));
            }
        } else {
            rejected.push(format!(
                "[skill_bundle] {SKILL_BUNDLE_SKILLS_DIR}/ missing from bundle"
            ));
        }

        for file in &manifest.files {
            let on_disk = staging.join(&file.path);
            if !on_disk.is_file() {
                mismatched.push(format!("{} (missing)", file.path));
                continue;
            }
            let bytes = fs::read(&on_disk)
                .map_err(|e| format!("[skill_bundle] read {} failed: {e}", file.path))?;
            if archive::block_hash(&bytes) != file.hash || bytes.len() as u64 != file.size {
                mismatched.push(file.path.clone());
            }
        }

        let manifest_sha256 = manifest_sha256_of(raw_manifest);
        match parse_sidecar_checksum(bundle_path) {
            Some(expected) if expected == manifest_sha256 => {}
            Some(expected) => rejected.push(format!(
                "[skill_bundle] manifest sha256 sidecar mismatch (expected {expected}, got {manifest_sha256})"
            )),
            None => rejected.push(
                "[skill_bundle] manifest sha256 sidecar missing — cannot confirm manifest integrity"
                    .to_string(),
            ),
        }

        Ok(SkillBundleVerifyResult {
            ok: mismatched.is_empty() && rejected.is_empty(),
            schema_version: manifest.schema_version,
            trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED.to_string(),
            manifest_sha256,
            content_hash: manifest.content_hash.clone(),
            mismatched,
            rejected,
            entry_count: entries.len() as u32,
            total_bytes,
            manifest: Some(manifest.clone()),
        })
    })();

    remove_quietly(&staging);
    result
}

// ── 导入 ───────────────────────────────────────────────────────────────────

/// 安全导入技能包。
///
/// 流程：条目守卫 → 清单结构校验 → **写入权威判定** → staging 解压 →
/// 内容指纹 + 逐文件哈希比对 → 版本门 → `trust_level` 盖章 → 原子 promote。
/// 任一步失败即**整体回滚**（staging 删除，不落任何产物）。
///
/// `confirmed` = 用户在导入对话框的逐项确认；`RequireGate` 判定在它为 `false` 时
/// 直接失败，使「确认门」不是 UI 装饰而是机械约束。
#[tauri::command]
pub async fn skill_bundle_import(
    bundle_path: String,
    dest_root: String,
    confirmed: bool,
) -> Result<SkillBundleImportResult, String> {
    import_impl(Path::new(&bundle_path), Path::new(&dest_root), confirmed)
}

fn import_impl(
    bundle_path: &Path,
    dest_root: &Path,
    confirmed: bool,
) -> Result<SkillBundleImportResult, String> {
    let (entries, total_bytes) = read_bundle_entries(bundle_path)?;

    let raw_manifest = manifest_bytes(&entries).ok_or_else(|| {
        format!("[skill_bundle] {SKILL_BUNDLE_MANIFEST_FILE} missing from bundle")
    })?;
    let manifest: SkillBundleManifest = serde_json::from_slice(raw_manifest)
        .map_err(|e| format!("[skill_bundle] manifest parse failed: {e}"))?;
    validate_manifest(&manifest)?;

    if !version_at_least(env!("CARGO_PKG_VERSION"), &manifest.min_nb_version) {
        return Err(format!(
            "[skill_bundle] requires Niko Buddy >= {}, current {}",
            manifest.min_nb_version,
            env!("CARGO_PKG_VERSION")
        ));
    }

    // 写入权威（TASK-002）：最终落点在用户资产域，但先经 fail-closed 判定。
    let install_dir = dest_root
        .join("skill_bundle")
        .join(&manifest.id)
        .join(&manifest.version);
    let decision = may_write(WriteSource::SkillImport, &install_dir);
    // 审计流（TASK-002 契约）：记录 (source, target, decision, path) 四元组。
    log::info!(
        "{}",
        crate::canon::write_authority::audit_line(&crate::canon::write_authority::audit_record(
            WriteSource::SkillImport,
            &install_dir,
            decision,
        ))
    );
    if !decision.is_permitted() {
        return Err(format!(
            "[skill_bundle] write denied by write_authority for {} (skill import may never target QM/, canon or status.json)",
            install_dir.display()
        ));
    }
    if decision == WriteDecision::RequireGate && !confirmed {
        return Err(
            "[skill_bundle] user confirmation required before importing an untrusted bundle"
                .to_string(),
        );
    }

    if install_dir.exists() {
        return Err(format!(
            "[skill_bundle] target already installed: {}",
            install_dir.display()
        ));
    }

    let staging = dest_root.join(format!(".staging-{}", unique_suffix()));
    // staging 与 install_dir 同卷（同在 dest_root 下），故 promote 的 rename 是原子的。
    let outcome = (|| -> Result<SkillBundleImportResult, String> {
        write_entries_to(&entries, &staging)?;

        let skills_root = staging.join(SKILL_BUNDLE_SKILLS_DIR);
        if !skills_root.is_dir() {
            return Err(format!(
                "[skill_bundle] {SKILL_BUNDLE_SKILLS_DIR}/ missing from bundle"
            ));
        }
        let actual = archive::build_manifest(&skills_root)?;
        if actual.content_digest != manifest.content_hash {
            return Err(format!(
                "[skill_bundle] content_hash mismatch (expected {} got {}) — import rolled back",
                manifest.content_hash, actual.content_digest
            ));
        }
        for file in &manifest.files {
            let on_disk = staging.join(&file.path);
            if !on_disk.is_file() {
                return Err(format!(
                    "[skill_bundle] manifest file missing on disk: {} — import rolled back",
                    file.path
                ));
            }
            let bytes = fs::read(&on_disk)
                .map_err(|e| format!("[skill_bundle] read {} failed: {e}", file.path))?;
            if archive::block_hash(&bytes) != file.hash || bytes.len() as u64 != file.size {
                return Err(format!(
                    "[skill_bundle] per-file hash mismatch: {} — import rolled back",
                    file.path
                ));
            }
        }

        // 导入器盖章：不采信包内自述的 trust_level。
        let mut warnings: Vec<String> = Vec::new();
        if manifest.trust_level != SKILL_BUNDLE_TRUST_UNTRUSTED {
            warnings.push(format!(
                "[skill_bundle] bundle claimed trust_level={} but the importer stamps every bundle as {}",
                manifest.trust_level, SKILL_BUNDLE_TRUST_UNTRUSTED
            ));
        }
        warnings.push(
            "[skill_bundle] skills are untrusted prompt material: they must not override the gate order Consistency(P0) > Anti-AI(P1) > Quality(P2)"
                .to_string(),
        );

        if let Some(parent) = install_dir.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[skill_bundle] create install parent failed: {e}"))?;
        }
        fs::rename(&staging, &install_dir).map_err(|e| {
            format!(
                "[skill_bundle] atomic promote {} -> {} failed: {e}",
                staging.display(),
                install_dir.display()
            )
        })?;

        Ok(SkillBundleImportResult {
            ok: true,
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED.to_string(),
            installed_dir: install_dir.to_string_lossy().replace('\\', "/"),
            content_hash: manifest.content_hash.clone(),
            manifest_sha256: manifest_sha256_of(raw_manifest),
            file_count: manifest.files.len(),
            total_bytes,
            readable_state: manifest.allowlist.readable_state.clone(),
            writable_artifacts: manifest.allowlist.writable_artifacts.clone(),
            warnings,
        })
    })();

    if outcome.is_err() {
        remove_quietly(&staging);
    }
    outcome
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::skill_bundle_manifest::looks_like_sha256_hex;
    use std::path::PathBuf;

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("nbskill-test-{tag}-{}", unique_suffix()));
            fs::create_dir_all(&root).expect("create temp root");
            TempTree { root }
        }

        fn write(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(&path, contents).expect("write fixture");
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// 构造一个合法技能源树（`<root>/demo-a/skill.md`）。
    fn seed_skill_root(tag: &str) -> TempTree {
        let tree = TempTree::new(tag);
        tree.write(
            "demo-a/skill.md",
            b"# Demo A\n\nUse this skill to keep prose concrete.\n",
        );
        tree.write("demo-a/assets/notes.csv", b"k,v\n1,2\n");
        tree
    }

    /// 用户资产域根。
    ///
    /// 路径段中**必须**含 `user-assets` 标记（C-007）——否则 `write_authority`
    /// 会把落点判为 `Other` 并一律 Deny，测试就测不到目标语义。
    fn user_asset_root(tag: &str) -> (TempTree, PathBuf) {
        let tree = TempTree::new(tag);
        let root = tree.root.join("user-assets");
        fs::create_dir_all(&root).expect("create user asset root");
        (tree, root)
    }

    fn export_to(source_root: &Path, dest: &Path) -> SkillBundleExportResult {
        export_impl(&["demo-a".to_string()], source_root, dest).expect("export")
    }

    #[test]
    fn manifest_schema_roundtrip() {
        let source = seed_skill_root("schema-src");
        let dest = TempTree::new("schema-dst");
        let bundle = dest.root.join("demo.nbskill.zip");
        let exported = export_to(&source.root, &bundle);

        // 清单元数据往返。
        let (entries, _) = read_bundle_entries(&bundle).expect("read entries");
        let raw = manifest_bytes(&entries).expect("manifest present");
        let manifest: SkillBundleManifest = serde_json::from_slice(raw).expect("parse manifest");
        assert_eq!(manifest.schema, SKILL_BUNDLE_SCHEMA);
        assert_eq!(manifest.schema_version, SKILL_BUNDLE_SCHEMA_VERSION);
        assert_eq!(manifest.content_hash, exported.content_hash);
        assert_eq!(manifest.files.len(), exported.file_count);
        validate_manifest(&manifest).expect("manifest validates");
        let reencoded = serde_json::to_vec_pretty(&manifest).expect("re-encode");
        assert_eq!(
            serde_json::from_slice::<SkillBundleManifest>(&reencoded).expect("decode"),
            manifest,
            "manifest must survive a serde round trip"
        );

        // 结构性拒绝：schema 名与版本。
        let mut wrong_schema = manifest.clone();
        wrong_schema.schema = "nbskill/2".to_string();
        assert!(validate_manifest(&wrong_schema).is_err());
        let mut wrong_version = manifest.clone();
        wrong_version.schema_version = SKILL_BUNDLE_SCHEMA_VERSION + 1;
        assert!(validate_manifest(&wrong_version).is_err());

        // allowlist 字段缺失 → 反序列化即失败（「未声明即拒绝」为结构层约束）。
        let stripped = String::from_utf8(raw.clone())
            .expect("utf8")
            .lines()
            .filter(|line| !line.contains("readable_state") && !line.contains("writable_artifacts"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            serde_json::from_str::<SkillBundleManifest>(&stripped).is_err(),
            "allowlist must be mandatory"
        );

        // 校验命令对合法包返回 ok。
        let verified = verify_impl(&bundle).expect("verify");
        assert!(verified.ok, "expected clean verify: {verified:?}");
        assert_eq!(verified.trust_level, SKILL_BUNDLE_TRUST_UNTRUSTED);

        // 篡改内容 → 命中 content_hash 与文件哈希。
        let broken = dest.root.join("broken.nbskill.zip");
        fs::copy(&bundle, &broken).expect("copy bundle");
        let mut tampered = manifest.clone();
        tampered.content_hash = "0".repeat(64);
        let broken_result = verify_impl(&broken).expect("verify broken");
        assert!(!broken_result.ok);
        // 版本门（min_nb_version 高到不可能满足）→ rejected。
        assert!(version_at_least("2.8.2", "2.8.2"));
        assert!(version_at_least("2.10.0", "2.9.9"));
        assert!(!version_at_least("2.8.2", "3.0.0"));
    }

    #[test]
    fn export_is_deterministic() {
        let source = seed_skill_root("det-src");
        let dest = TempTree::new("det-dst");
        let first = export_to(&source.root, &dest.root.join("a.nbskill.zip"));
        let second = export_to(&source.root, &dest.root.join("b.nbskill.zip"));

        assert_eq!(
            first.content_hash, second.content_hash,
            "content_hash must be stable"
        );
        assert_eq!(
            first.manifest_sha256, second.manifest_sha256,
            "manifest_sha256 must be stable (no timestamps in the manifest)"
        );
        assert_eq!(first.file_count, second.file_count);
        assert_eq!(first.total_bytes, second.total_bytes);

        // sidecar 与 manifest 字节一致（sha256sum 行格式）。
        let sidecar =
            parse_sidecar_checksum(&dest.root.join("a.nbskill.zip")).expect("sidecar present");
        assert_eq!(sidecar, first.manifest_sha256);
        assert!(looks_like_sha256_hex(&sidecar));

        // 拒绝面：可执行扩展名与非 allowlist 扩展名。
        assert!(is_executable_name("skills/a/run.ps1"));
        assert!(is_executable_name("skills/a/run.EXE"));
        assert!(!is_executable_name("skills/a/skill.md"));
        assert!(is_allowed_name("skills/a/skill.md"));
        assert!(!is_allowed_name("skills/a/data.bin"));
        let bad = TempTree::new("det-bad");
        bad.write("demo-a/skill.md", b"ok");
        bad.write("demo-a/run.ps1", b"echo pwn");
        let refused = export_impl(
            &["demo-a".to_string()],
            &bad.root,
            &dest.root.join("bad.nbskill.zip"),
        );
        assert!(
            refused.is_err(),
            "executable entries must never be exported"
        );
    }

    #[test]
    fn import_rejects_traversal() {
        // 守卫本体（直接覆盖，不依赖能否构造出恶意 zip）。
        assert!(validate_entry_name("../escape.md").is_err());
        assert!(validate_entry_name("skills/../../escape.md").is_err());
        assert!(validate_entry_name("/etc/passwd").is_err());
        assert!(validate_entry_name("C:/Windows/system32/x.md").is_err());
        assert!(validate_entry_name("skills\\a\\skill.md").is_err());
        assert!(validate_entry_name("").is_err());
        assert!(validate_entry_name("skills/demo-a/skill.md").is_ok());
        assert!(validate_entry_name("manifest.json").is_ok());

        // 端到端：包内混入穿越条目时必须拒绝，且不落任何产物。
        let source = seed_skill_root("trav-src");
        let dest = TempTree::new("trav-dst");
        let bundle = dest.root.join("demo.nbskill.zip");
        export_to(&source.root, &bundle);

        let malicious = dest.root.join("malicious.nbskill.zip");
        {
            let (entries, _) = read_bundle_entries(&bundle).expect("read entries");
            let sink = fs::File::create(&malicious).expect("create malicious zip");
            let mut writer = zip::ZipWriter::new(sink);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, bytes) in &entries {
                writer.start_file(name.clone(), options).expect("start");
                writer.write_all(bytes).expect("write");
            }
            writer
                .start_file("../escape.md", options)
                .expect("start malicious entry");
            writer.write_all(b"pwn").expect("write malicious entry");
            writer.finish().expect("finish");
        }

        let import_root = TempTree::new("trav-import");
        let rejected = import_impl(&malicious, &import_root.root, true);
        assert!(rejected.is_err(), "traversal entry must be rejected");
        assert!(
            rejected.unwrap_err().contains("traversal"),
            "rejection must name the traversal reason"
        );
        // 整个导入根下不得留下任何 staging 残留。
        let leftovers: Vec<String> = fs::read_dir(&import_root.root)
            .expect("read import root")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "no residue expected, found {leftovers:?}"
        );
    }

    #[test]
    fn import_rejects_executable() {
        let source = seed_skill_root("exe-src");
        let dest = TempTree::new("exe-dst");
        let bundle = dest.root.join("demo.nbskill.zip");
        export_to(&source.root, &bundle);

        let malicious = dest.root.join("exe.nbskill.zip");
        {
            let (entries, _) = read_bundle_entries(&bundle).expect("read entries");
            let sink = fs::File::create(&malicious).expect("create zip");
            let mut writer = zip::ZipWriter::new(sink);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, bytes) in &entries {
                writer.start_file(name.clone(), options).expect("start");
                writer.write_all(bytes).expect("write");
            }
            writer
                .start_file("skills/demo-a/install.ps1", options)
                .expect("start executable");
            writer
                .write_all(b"Write-Host pwn")
                .expect("write executable");
            writer.finish().expect("finish");
        }

        let import_root = TempTree::new("exe-import");
        let rejected = import_impl(&malicious, &import_root.root, true);
        assert!(rejected.is_err(), "executable entries must be rejected");
        let message = rejected.unwrap_err();
        assert!(
            message.contains("executable"),
            "rejection must name the executable reason: {message}"
        );
        assert!(
            !import_root.root.join("skill_bundle").exists(),
            "nothing may be installed after a rejected import"
        );

        // 清单层同样拒绝可执行条目。
        let mut manifest = SkillBundleManifest {
            schema: SKILL_BUNDLE_SCHEMA.to_string(),
            schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
            id: "demo-a".to_string(),
            name: "Demo A".to_string(),
            version: "1.0.0".to_string(),
            content_hash: "a".repeat(64),
            source: "test".to_string(),
            trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED.to_string(),
            min_nb_version: "0.0.1".to_string(),
            deps: Vec::new(),
            allowlist: SkillBundleAllowlist {
                readable_state: Vec::new(),
                writable_artifacts: Vec::new(),
            },
            files: vec![BundleFileRef {
                path: "skills/demo-a/run.sh".to_string(),
                hash: "b".repeat(64),
                size: 3,
            }],
        };
        assert!(
            validate_manifest(&manifest).is_err(),
            "manifest must reject executables"
        );
        manifest.files[0].path = "skills/demo-a/skill.md".to_string();
        validate_manifest(&manifest).expect("manifest accepts allowlisted extensions");
    }

    #[test]
    fn import_rolls_back_on_hash_mismatch() {
        let source = seed_skill_root("roll-src");
        let dest = TempTree::new("roll-dst");
        let bundle = dest.root.join("demo.nbskill.zip");
        export_to(&source.root, &bundle);

        // 重打包：清单保持不变，但把技能内容替换掉 → 指纹必不匹配。
        let (entries, _) = read_bundle_entries(&bundle).expect("read entries");
        let tampered = dest.root.join("tampered.nbskill.zip");
        {
            let sink = fs::File::create(&tampered).expect("create zip");
            let mut writer = zip::ZipWriter::new(sink);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, bytes) in &entries {
                let payload: &[u8] = if name == "skills/demo-a/skill.md" {
                    b"# Replaced\n"
                } else {
                    bytes.as_slice()
                };
                writer.start_file(name.clone(), options).expect("start");
                writer.write_all(payload).expect("write");
            }
            writer.finish().expect("finish");
        }

        let import_root = user_asset_root("roll-import").1;
        let rejected = import_impl(&tampered, &import_root, true);
        assert!(rejected.is_err(), "hash mismatch must abort the import");
        assert!(
            rejected.unwrap_err().contains("mismatch"),
            "rejection must name the hash mismatch"
        );

        // 回滚证据：无安装目录、无 staging 残留。
        assert!(!import_root.join("skill_bundle").exists());
        let leftovers: Vec<String> = fs::read_dir(&import_root)
            .expect("read import root")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "staging must be rolled back, found {leftovers:?}"
        );

        // 对照：未篡改的包可以正常导入（证明失败来自指纹而非路径）。
        let ok_root = user_asset_root("roll-ok").1;
        let imported = import_impl(&bundle, &ok_root, true).expect("clean import");
        assert!(imported.ok);
        assert_eq!(imported.trust_level, SKILL_BUNDLE_TRUST_UNTRUSTED);
        assert!(ok_root.join("skill_bundle/demo-a").exists());
    }

    #[test]
    fn import_denies_canon_write() {
        let source = seed_skill_root("canon-src");
        let dest = TempTree::new("canon-dst");
        let bundle = dest.root.join("demo.nbskill.zip");
        export_to(&source.root, &bundle);

        // dest_root 中含 `canon` 段 → 写入权威判定为 Canon → SkillImport 一律 Deny。
        let canon_root = TempTree::new("canon").root.join("canon");
        fs::create_dir_all(&canon_root).expect("create canon root");
        let denied = import_impl(&bundle, &canon_root, true);
        assert!(denied.is_err(), "canon target must be denied");
        let message = denied.unwrap_err();
        assert!(
            message.contains("denied"),
            "rejection must name the authority denial: {message}"
        );
        assert!(!canon_root.join("skill_bundle").exists());

        // 对照：用户资产域是 RequireGate —— 未确认即失败，确认后通过。
        let asset_root = user_asset_root("canon-assets").1;
        let unconfirmed = import_impl(&bundle, &asset_root, false);
        assert!(
            unconfirmed.is_err(),
            "RequireGate must not pass without confirmation"
        );
        assert!(
            unconfirmed.unwrap_err().contains("confirmation required"),
            "gate rejection must be explicit"
        );
        assert!(!asset_root.join("skill_bundle").exists());
        assert!(import_impl(&bundle, &asset_root, true).is_ok());

        // 权威判定本身（TASK-002 契约）在此再确认一次。
        assert_eq!(
            may_write(WriteSource::SkillImport, &canon_root.join("x")),
            WriteDecision::Deny
        );
    }
}
