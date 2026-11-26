// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Backup / restore subsystem.
//!
//! Provides zip-based project export and import with progress reporting,
//! Zip Slip protection, and tauri-plugin-store integration for app state.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use walkdir::WalkDir;
use zip::write::ZipWriter;
use zip::CompressionMethod;

/// Cancellation flag for the in-progress export backup.
/// Set by the `cancel_backup` IPC command; checked per file/project during export.
static BACKUP_CANCEL: AtomicBool = AtomicBool::new(false);

use crate::panic_guard::run_guarded;

// ── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectBackupInfo {
    pub id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportParams {
    pub save_path: String,
    pub local_storage_data: serde_json::Value,
    pub projects: Vec<ProjectBackupInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub success: bool,
    pub warnings: Vec<String>,
    pub file_count: usize,
    pub total_size: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportStrategy {
    Full,
    // 四-2：主名统一 camel（globalOnly），旧 kebab（global-only，前端现状在发）经 alias 加法兼容。
    #[serde(alias = "global-only")]
    GlobalOnly,
    Selective,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRestoreInfo {
    pub id: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportParams {
    pub zip_path: String,
    pub strategy: ImportStrategy,
    pub projects: Option<Vec<ProjectRestoreInfo>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    pub app_state: Option<serde_json::Value>,
    pub local_storage_data: Option<serde_json::Value>,
    pub projects: Vec<ProjectRestoreResult>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRestoreResult {
    pub id: String,
    pub path: String,
    pub name: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub backup_version: u32,
    /// 备份**从不**包含凭据：凭据只存 OS 凭据库（`credential_vault`），
    /// 不落 `.niko-buddy` 项目数据区任何文件。此字段恒为 false，用于恢复时的明示。
    pub credentials_included: bool,
    pub created_at: String,
    pub app_version: String,
    pub projects: Vec<ProjectBackupInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgressPayload {
    pub operation: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

// ── Constants ───────────────────────────────────────────────────────────────

/// Subdirectories inside each project that should be included in a backup.
const PROJECT_SUBDIRS: &[&str] = &[".niko-buddy", ".novel", "book-analysis", "raw"];

/// Top-level project files to include in a backup.
const PROJECT_FILES: &[&str] = &["soul.md", "schema.md", "purpose.md"];

/// Possible on-disk names for the knowledge directory (new vs. legacy).
const KNOWLEDGE_DIR_CANDIDATES: &[&str] = &["QM", "wiki"];

/// Canonical name used inside the zip archive for the knowledge directory.
const KNOWLEDGE_ZIP_NAME: &str = "wiki";

/// 备份归档安全上限（防目录环路与 zip bomb 解压耗尽磁盘/内存）。
const MAX_BACKUP_WALK_DEPTH: usize = 64;
const MAX_BACKUP_ENTRIES: usize = 50_000;
const MAX_BACKUP_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BACKUP_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

// ── Internal helpers ────────────────────────────────────────────────────────

fn emit_progress(
    app: &tauri::AppHandle,
    operation: &str,
    stage: &str,
    current: usize,
    total: usize,
    message: &str,
) {
    let _ = app.emit(
        "backup-progress",
        BackupProgressPayload {
            operation: operation.into(),
            stage: stage.into(),
            current,
            total,
            message: message.into(),
        },
    );
}

/// Replace the entire app-state store with the contents of `app_state_json`.
fn restore_app_state_via_store(
    app: &tauri::AppHandle,
    app_state_json: &serde_json::Value,
) -> Result<(), String> {
    let store = app
        .store("app-state.json")
        .map_err(|e| format!("无法加载应用状态存储: {e}"))?;

    store.clear();

    let obj = app_state_json
        .as_object()
        .ok_or_else(|| "app-state.json 格式错误，应为 JSON 对象".to_string())?;

    for (key, value) in obj {
        store.set(key.clone(), value.clone());
    }

    store
        .save()
        .map_err(|e| format!("保存应用状态存储失败: {e}"))?;

    Ok(())
}

/// Recursively add every file under `base_dir` to the zip archive under
/// `zip_prefix`. Large files are streamed via `std::io::copy` to keep
/// memory usage bounded. Never follows symlinks or Windows reparse points.
fn add_dir_to_zip(
    zip: &mut ZipWriter<fs::File>,
    base_dir: &Path,
    zip_prefix: &str,
    file_count: &mut usize,
    warnings: &mut Vec<String>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if crate::agent_gate_policy::is_symlink_or_reparse_point(base_dir) {
        warnings.push(format!("跳过符号链接目录: {}", base_dir.display()));
        return Ok(());
    }
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let walker = WalkDir::new(base_dir)
        .follow_links(false)
        .max_depth(MAX_BACKUP_WALK_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || (!e.path_is_symlink()
                    && !crate::agent_gate_policy::is_symlink_or_reparse_point(e.path()))
        });

    for walk_entry in walker {
        if cancel.load(Ordering::SeqCst) {
            return Err("备份已取消".into());
        }
        let entry = match walk_entry {
            Ok(e) => e,
            Err(e) => {
                warnings.push(format!("备份遍历跳过: {}", e));
                continue;
            }
        };

        let path = entry.path();
        if path == base_dir {
            continue;
        }
        if entry.path_is_symlink() || crate::agent_gate_policy::is_symlink_or_reparse_point(path) {
            continue;
        }

        let relative = path
            .strip_prefix(base_dir)
            .map_err(|e| format!("路径剥离失败: {e}"))?;
        let zip_name = format!(
            "{}/{}",
            zip_prefix,
            relative.to_string_lossy().replace('\\', "/")
        );

        if entry.file_type().is_dir() {
            zip.add_directory(&zip_name, opts)
                .map_err(|e| format!("创建 zip 目录失败: {e}"))?;
        } else if entry.file_type().is_file() {
            if cancel.load(Ordering::SeqCst) {
                return Err("备份已取消".into());
            }
            let file = fs::File::open(path)
                .map_err(|e| format!("打开文件失败 {}: {e}", path.display()))?;
            zip.start_file(&zip_name, opts)
                .map_err(|e| format!("创建 zip 文件条目失败: {e}"))?;
            let mut reader = std::io::BufReader::new(file);
            std::io::copy(&mut reader, zip).map_err(|e| format!("写入 zip 失败: {e}"))?;
            *file_count += 1;
        }
    }
    Ok(())
}

/// Read a single named file from a zip archive with a strict byte limit, returning `None` if absent.
fn extract_file_from_zip(
    archive: &mut zip::ZipArchive<fs::File>,
    name: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    match archive.by_name(name) {
        Ok(file) => {
            let mut buf = Vec::new();
            std::io::Read::take(file, max_bytes.saturating_add(1))
                .read_to_end(&mut buf)
                .map_err(|e| format!("读取 zip 内文件 {} 失败: {e}", name))?;
            if (buf.len() as u64) > max_bytes {
                return Err(format!(
                    "安全拦截：zip 内文件 \"{}\" 解压超过大小上限 {} 字节",
                    name, max_bytes
                ));
            }
            Ok(Some(buf))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(format!("访问 zip 内文件 {} 失败: {e}", name)),
    }
}

/// 校验 `path` 自身及所有已存在祖先链不含符号链接或 Windows 名称代理重解析点。
fn assert_path_chain_has_no_symlink(path: &Path, label: &str) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.as_os_str().is_empty() {
            break;
        }
        #[cfg(target_os = "macos")]
        if candidate == Path::new("/var")
            || candidate == Path::new("/tmp")
            || candidate == Path::new("/etc")
        {
            current = candidate.parent();
            continue;
        }
        match fs::symlink_metadata(candidate) {
            Ok(meta) => {
                if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
                    return Err(format!(
                        "安全拦截：{label}路径包含符号链接或重解析点 {}",
                        candidate.display()
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!("无法检查{label}路径 {}: {e}", candidate.display()));
            }
        }
        current = candidate.parent();
    }
    Ok(())
}

/// Extract all entries under `zip_prefix` into `target_dir`, with
/// Zip Slip protection, symlink/reparse rejection, and bounded streaming decompression.
fn extract_dir_from_zip(
    archive: &mut zip::ZipArchive<fs::File>,
    zip_prefix: &str,
    target_dir: &Path,
) -> Result<usize, String> {
    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err(format!(
            "安全拦截：备份归档包含 {} 个条目，超过安全上限 {}",
            archive.len(),
            MAX_BACKUP_ENTRIES
        ));
    }
    assert_path_chain_has_no_symlink(target_dir, "恢复目标目录")?;

    let mut written = 0usize;
    let mut total_bytes: u64 = 0;

    // Collect matching entry names up front to avoid borrow issues.
    let names: Vec<String> = archive
        .file_names()
        .filter(|n| n.starts_with(zip_prefix))
        .map(|n| n.to_string())
        .collect();

    // Single canonicalize call — avoids per-entry TOCTOU overhead.
    let canonical_target = target_dir
        .canonicalize()
        .map_err(|e| format!("无法解析目标目录: {e}"))?;

    for name in names {
        let raw_relative = &name[zip_prefix.len()..];
        if raw_relative.is_empty() {
            continue;
        }
        // 拒绝前导斜杠、反斜杠、冒号（盘符 / NTFS ADS）、NUL 与控制字符，彻底禁止任何 `..` 静默回退。
        if raw_relative.starts_with('/')
            || raw_relative.contains('\\')
            || raw_relative.contains(':')
            || raw_relative.chars().any(|c| c == '\0' || c.is_control())
        {
            return Err(format!(
                "安全拦截：zip 条目 \"{}\" 包含非法路径字符或根路径前缀",
                name
            ));
        }
        let is_dir_entry = raw_relative.ends_with('/');
        if raw_relative.ends_with("//") {
            return Err(format!("安全拦截：zip 条目 \"{}\" 包含非法空路径段", name));
        }
        let trimmed_rel = raw_relative.trim_end_matches('/');
        if trimmed_rel.is_empty() {
            continue;
        }

        let mut safe_dest = canonical_target.clone();
        for seg in trimmed_rel.split('/') {
            crate::agent_gate_policy::validate_safe_single_segment(seg, "zip entry segment")
                .map_err(|e| format!("安全拦截：zip 条目 \"{}\" 路径段非法 ({e})", name))?;
            safe_dest.push(seg);
        }

        if !safe_dest.starts_with(&canonical_target) {
            return Err(format!(
                "安全拦截：zip 条目 \"{}\" 试图写入目标目录之外的位置 {}",
                name,
                safe_dest.display()
            ));
        }

        crate::agent_gate_policy::assert_no_symlink_in_ancestors(&canonical_target, &safe_dest)
            .map_err(|e| format!("安全拦截：目标路径包含符号链接或重解析点 ({e})"))?;

        // Directory entry — just create and move on.
        if is_dir_entry {
            fs::create_dir_all(&safe_dest)
                .map_err(|e| format!("创建目录失败 {}: {e}", safe_dest.display()))?;
            continue;
        }

        // File entry — ensure parent dirs then stream contents with strict limits.
        if let Some(parent) = safe_dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建父目录失败 {}: {e}", parent.display()))?;
            crate::agent_gate_policy::assert_no_symlink_in_ancestors(&canonical_target, parent)
                .map_err(|e| format!("安全拦截：目标父目录包含符号链接或重解析点 ({e})"))?;
        }
        if crate::agent_gate_policy::is_symlink_or_reparse_point(&safe_dest) {
            return Err(format!(
                "安全拦截：目标文件不允许为符号链接或重解析点 {}",
                safe_dest.display()
            ));
        }

        let remaining = MAX_BACKUP_TOTAL_BYTES.saturating_sub(total_bytes);
        let limit = MAX_BACKUP_ENTRY_BYTES.min(remaining);
        let zip_file = archive
            .by_name(&name)
            .map_err(|e| format!("打开 zip 内文件 {} 失败: {e}", name))?;
        let mut out_file = fs::File::create(&safe_dest)
            .map_err(|e| format!("创建目标文件失败 {}: {e}", safe_dest.display()))?;
        let mut limited = zip_file.take(limit.saturating_add(1));
        let copied = std::io::copy(&mut limited, &mut out_file)
            .map_err(|e| format!("解压写入文件失败 {}: {e}", safe_dest.display()))?;
        drop(out_file);
        if copied > limit {
            let _ = fs::remove_file(&safe_dest);
            return Err(format!(
                "安全拦截：zip 条目 \"{}\" 解压体积超过安全上限",
                name
            ));
        }
        total_bytes = total_bytes.saturating_add(copied);
        written += 1;
    }
    Ok(written)
}

// ── Core export logic (Tauri-agnostic) ──────────────────────────────────────

/// Build a zip archive containing the full application backup.
///
/// * `params`          – what to export and where to write the zip.
/// * `app_state_path`  – on-disk location of `app-state.json`.
/// * `on_progress`     – callback invoked at each major stage.
pub fn do_export_backup<F: Fn(&BackupProgressPayload)>(
    params: ExportParams,
    app_state_path: &Path,
    on_progress: F,
) -> Result<ExportResult, String> {
    // 持 T4 FILE_MUTATION_LOCK（同步执行，绝不跨 .await）保护备份读写一致性。
    let _mutation = crate::commands::fs::lock_file_mutations()?;
    let save_path = Path::new(&params.save_path);
    assert_path_chain_has_no_symlink(save_path, "备份输出文件")?;
    assert_path_chain_has_no_symlink(app_state_path, "应用状态文件")?;
    for project in &params.projects {
        assert_path_chain_has_no_symlink(Path::new(&project.path), "导出项目目录")?;
    }
    let total_steps = params.projects.len() + 2; // manifest + global + projects

    on_progress(&BackupProgressPayload {
        operation: "export".into(),
        stage: "preparing".into(),
        current: 0,
        total: total_steps,
        message: "正在准备导出...".into(),
    });

    let file = fs::File::create(save_path).map_err(|e| format!("无法创建备份文件: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let mut file_count: usize = 0;
    let mut warnings: Vec<String> = Vec::new();
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // ── 1. manifest.json ────────────────────────────────────────────────────
    let manifest = BackupManifest {
        backup_version: 1,
        credentials_included: false,
        created_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        projects: params.projects.clone(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest 失败: {e}"))?;
    zip.start_file("manifest.json", opts)
        .map_err(|e| format!("写入 manifest 失败: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("写入 manifest 失败: {e}"))?;

    on_progress(&BackupProgressPayload {
        operation: "export".into(),
        stage: "collecting".into(),
        current: 1,
        total: total_steps,
        message: "正在收集全局配置...".into(),
    });

    // ── 2. global/app-state.json ────────────────────────────────────────────
    zip.start_file("global/app-state.json", opts)
        .map_err(|e| format!("创建 app-state zip 条目失败: {e}"))?;
    if app_state_path.exists() {
        let state_bytes =
            fs::read(app_state_path).map_err(|e| format!("读取 app-state.json 失败: {e}"))?;
        zip.write_all(&state_bytes)
            .map_err(|e| format!("写入 app-state 到 zip 失败: {e}"))?;
        file_count += 1;
    } else {
        zip.write_all(b"{}")
            .map_err(|e| format!("写入空 app-state 失败: {e}"))?;
        warnings.push("app-state.json 不存在，已写入空对象".into());
    }

    // ── 3. global/local-storage.json ────────────────────────────────────────
    zip.start_file("global/local-storage.json", opts)
        .map_err(|e| format!("创建 local-storage zip 条目失败: {e}"))?;
    let ls_json = serde_json::to_string_pretty(&params.local_storage_data)
        .map_err(|e| format!("序列化 localStorage 失败: {e}"))?;
    zip.write_all(ls_json.as_bytes())
        .map_err(|e| format!("写入 local-storage 到 zip 失败: {e}"))?;
    file_count += 1;

    // ── 4. project-registry.json ────────────────────────────────────────────
    let registry_json = serde_json::json!({
        "projects": params.projects.iter().map(|p| {
            serde_json::json!({ "id": p.id, "path": p.path, "name": p.name })
        }).collect::<Vec<_>>()
    });
    zip.start_file("project-registry.json", opts)
        .map_err(|e| format!("创建 registry zip 条目失败: {e}"))?;
    let registry_str = serde_json::to_string_pretty(&registry_json)
        .map_err(|e| format!("序列化 registry 失败: {e}"))?;
    zip.write_all(registry_str.as_bytes())
        .map_err(|e| format!("写入 registry 到 zip 失败: {e}"))?;

    // ── 5. Per-project data ─────────────────────────────────────────────────
    for (idx, project) in params.projects.iter().enumerate() {
        if BACKUP_CANCEL.load(Ordering::SeqCst) {
            // Release the zip/file handle before deletion so Windows allows remove_file
            // (otherwise the open handle blocks deletion and leaves a partial zip on disk).
            drop(zip);
            let _ = fs::remove_file(save_path);
            return Err("备份已取消".into());
        }
        let project_path = Path::new(&project.path);
        if !project_path.exists() {
            warnings.push(format!(
                "项目路径不存在，已跳过: {} ({})",
                project.name, project.path
            ));
            continue;
        }

        on_progress(&BackupProgressPayload {
            operation: "export".into(),
            stage: "packing".into(),
            current: idx + 2,
            total: total_steps,
            message: format!("正在打包项目: {}", project.name),
        });

        let zip_prefix = format!("projects/{}", project.id);

        // Knowledge directory (prefer QM, fall back to wiki; stored as wiki).
        for candidate in KNOWLEDGE_DIR_CANDIDATES {
            let candidate_path = project_path.join(candidate);
            if candidate_path.is_dir() {
                let sub_prefix = format!("{}/{}", zip_prefix, KNOWLEDGE_ZIP_NAME);
                if let Err(e) = add_dir_to_zip(
                    &mut zip,
                    &candidate_path,
                    &sub_prefix,
                    &mut file_count,
                    &mut warnings,
                    &BACKUP_CANCEL,
                ) {
                    if BACKUP_CANCEL.load(Ordering::SeqCst) {
                        drop(zip);
                        let _ = fs::remove_file(save_path);
                        return Err("备份已取消".into());
                    }
                    warnings.push(format!(
                        "复制项目 {} 的知识目录({})失败: {}",
                        project.name, candidate, e
                    ));
                }
                break; // only pack the first one found
            }
        }

        // Other project subdirectories.
        for subdir in PROJECT_SUBDIRS {
            if BACKUP_CANCEL.load(Ordering::SeqCst) {
                drop(zip);
                let _ = fs::remove_file(save_path);
                return Err("备份已取消".into());
            }
            let subdir_path = project_path.join(subdir);
            if subdir_path.is_dir() {
                let sub_prefix = format!("{}/{}", zip_prefix, subdir);
                if let Err(e) = add_dir_to_zip(
                    &mut zip,
                    &subdir_path,
                    &sub_prefix,
                    &mut file_count,
                    &mut warnings,
                    &BACKUP_CANCEL,
                ) {
                    if BACKUP_CANCEL.load(Ordering::SeqCst) {
                        drop(zip);
                        let _ = fs::remove_file(save_path);
                        return Err("备份已取消".into());
                    }
                    warnings.push(format!(
                        "复制项目 {} 的 {} 目录失败: {}",
                        project.name, subdir, e
                    ));
                }
            }
        }

        // Top-level project files.
        for file_name in PROJECT_FILES {
            if BACKUP_CANCEL.load(Ordering::SeqCst) {
                drop(zip);
                let _ = fs::remove_file(save_path);
                return Err("备份已取消".into());
            }
            let file_path = project_path.join(file_name);
            if file_path.is_file()
                && !crate::agent_gate_policy::is_symlink_or_reparse_point(&file_path)
            {
                let data = fs::read(&file_path)
                    .map_err(|e| format!("读取文件失败 {}: {e}", file_path.display()))?;
                let entry_name = format!("{}/{}", zip_prefix, file_name);
                zip.start_file(&entry_name, opts)
                    .map_err(|e| format!("创建 zip 文件条目失败: {e}"))?;
                zip.write_all(&data)
                    .map_err(|e| format!("写入 zip 失败: {e}"))?;
                file_count += 1;
            }
        }
    }

    on_progress(&BackupProgressPayload {
        operation: "export".into(),
        stage: "writing".into(),
        current: total_steps,
        total: total_steps,
        message: "正在写入备份文件...".into(),
    });

    zip.finish()
        .map_err(|e| format!("完成 zip 写入失败: {e}"))?;

    let total_size = fs::metadata(save_path).map(|m| m.len()).unwrap_or(0);

    if BACKUP_CANCEL.load(Ordering::SeqCst) {
        let _ = fs::remove_file(save_path);
        return Err("备份已取消".into());
    }

    on_progress(&BackupProgressPayload {
        operation: "export".into(),
        stage: "done".into(),
        current: total_steps,
        total: total_steps,
        message: "导出完成".into(),
    });

    Ok(ExportResult {
        success: true,
        warnings,
        file_count,
        total_size,
        error: None,
    })
}

// ── Core import logic (Tauri-agnostic) ──────────────────────────────────────

/// Restore application state and/or projects from a zip backup archive.
///
/// * `params`         – what to restore and from where.
/// * `app_state_dir`  – directory where `app-state.json` should be written.
/// * `on_progress`    – callback invoked at each major stage.
pub fn do_import_backup<F: Fn(&BackupProgressPayload)>(
    params: ImportParams,
    app_state_dir: &Path,
    on_progress: F,
) -> Result<ImportResult, String> {
    let zip_path = Path::new(&params.zip_path);
    assert_path_chain_has_no_symlink(zip_path, "备份归档文件")?;
    assert_path_chain_has_no_symlink(app_state_dir, "应用状态目录")?;
    if !zip_path.exists() {
        return Ok(ImportResult {
            success: false,
            app_state: None,
            local_storage_data: None,
            projects: vec![],
            warnings: vec![],
            error: Some("备份文件不存在".into()),
        });
    }

    on_progress(&BackupProgressPayload {
        operation: "import".into(),
        stage: "preparing".into(),
        current: 0,
        total: 1,
        message: "正在准备导入...".into(),
    });

    // 全局锁序 DAG：T3 (MIGRATE_LOCK) -> T4 (FILE_MUTATION_LOCK)。
    // 本段在解压/写盘期间持 T4，随后显式 `drop(_mutation)` 释放 T4，再调用 `migrate_project_dirs` (T3)。
    let _mutation = crate::commands::fs::lock_file_mutations()?;

    let file = fs::File::open(zip_path).map_err(|e| format!("打开备份文件失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("读取备份文件失败，可能已损坏: {e}"))?;
    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err(format!(
            "安全拦截：备份归档包含 {} 个条目，超过安全上限 {}",
            archive.len(),
            MAX_BACKUP_ENTRIES
        ));
    }

    let mut warnings: Vec<String> = Vec::new();
    let mut app_state: Option<serde_json::Value> = None;
    let mut local_storage_data: Option<serde_json::Value> = None;
    let mut project_results: Vec<ProjectRestoreResult> = Vec::new();
    let mut extracted_for_migration: Vec<(PathBuf, String)> = Vec::new();

    // ── Read manifest ───────────────────────────────────────────────────────
    let manifest_projects = if let Some(manifest_bytes) =
        extract_file_from_zip(&mut archive, "manifest.json", MAX_BACKUP_METADATA_BYTES)?
    {
        let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| format!("解析 manifest.json 失败: {e}"))?;
        if manifest.backup_version > 1 {
            warnings.push(format!(
                "备份版本 {} 可能不兼容当前版本",
                manifest.backup_version
            ));
        }
        manifest.projects
    } else {
        warnings.push("备份文件缺少 manifest.json".into());
        vec![]
    };

    // ── Global restore ──────────────────────────────────────────────────────
    let need_global = matches!(
        params.strategy,
        ImportStrategy::Full | ImportStrategy::GlobalOnly
    );

    if need_global {
        on_progress(&BackupProgressPayload {
            operation: "import".into(),
            stage: "restoring".into(),
            current: 0,
            total: 1,
            message: "正在恢复全局配置...".into(),
        });

        // app-state.json
        if let Some(state_bytes) = extract_file_from_zip(
            &mut archive,
            "global/app-state.json",
            MAX_BACKUP_METADATA_BYTES,
        )? {
            let state_json: serde_json::Value = serde_json::from_slice(&state_bytes)
                .map_err(|e| format!("解析 app-state.json 失败: {e}"))?;

            fs::create_dir_all(app_state_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
            let state_path = app_state_dir.join("app-state.json");
            assert_path_chain_has_no_symlink(&state_path, "应用状态文件")?;
            let state_str = serde_json::to_string_pretty(&state_json)
                .map_err(|e| format!("序列化 app-state 失败: {e}"))?;
            crate::commands::fs::write_atomic_physical_bytes(&state_path, state_str.as_bytes())
                .map_err(|e| format!("写入 app-state.json 失败: {e}"))?;

            app_state = Some(state_json);
        }

        // local-storage.json
        if let Some(ls_bytes) = extract_file_from_zip(
            &mut archive,
            "global/local-storage.json",
            MAX_BACKUP_METADATA_BYTES,
        )? {
            let ls_json: serde_json::Value = serde_json::from_slice(&ls_bytes)
                .map_err(|e| format!("解析 local-storage.json 失败: {e}"))?;
            local_storage_data = Some(ls_json);
        }
    }

    // ── Project restore ─────────────────────────────────────────────────────
    let need_projects = matches!(
        params.strategy,
        ImportStrategy::Full | ImportStrategy::Selective
    );

    if need_projects {
        let restore_targets: Vec<(String, String, String)> = match &params.strategy {
            ImportStrategy::Full => manifest_projects
                .iter()
                .map(|p| (p.id.clone(), p.path.clone(), p.name.clone()))
                .collect(),
            ImportStrategy::Selective => params
                .projects
                .as_ref()
                .map(|ps| {
                    ps.iter()
                        .map(|p| {
                            let name = manifest_projects
                                .iter()
                                .find(|m| m.id == p.id)
                                .map(|m| m.name.clone())
                                .unwrap_or_else(|| "已恢复项目".to_string());
                            (p.id.clone(), p.target_path.clone(), name)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            _ => vec![],
        };

        let total = restore_targets.len();

        for (idx, (project_id, target_path, project_name)) in restore_targets.iter().enumerate() {
            on_progress(&BackupProgressPayload {
                operation: "import".into(),
                stage: "restoring".into(),
                current: idx + 1,
                total: total.max(1),
                message: format!("正在恢复项目: {}", project_name),
            });

            let zip_prefix = format!("projects/{}/", project_id);
            let target = Path::new(target_path);
            assert_path_chain_has_no_symlink(target, "恢复目标目录")?;

            fs::create_dir_all(target)
                .map_err(|e| format!("创建项目目录失败 {}: {e}", target.display()))?;
            assert_path_chain_has_no_symlink(target, "恢复目标目录")?;

            match extract_dir_from_zip(&mut archive, &zip_prefix, target) {
                Ok(_count) => {
                    extracted_for_migration.push((target.to_path_buf(), project_name.clone()));
                    project_results.push(ProjectRestoreResult {
                        id: project_id.clone(),
                        path: target_path.clone(),
                        name: project_name.clone(),
                        success: true,
                        error: None,
                    });
                }
                Err(e) => {
                    project_results.push(ProjectRestoreResult {
                        id: project_id.clone(),
                        path: target_path.clone(),
                        name: project_name.clone(),
                        success: false,
                        error: Some(e),
                    });
                }
            }
        }
    }

    // 严格遵守全局锁序 T3 (MIGRATE_LOCK) -> T4 (FILE_MUTATION_LOCK)：
    // 必须显式释放 T4 后再调用获取 T3 的 `migrate_project_dirs`，杜绝锁序反转死锁。
    drop(_mutation);

    for (target, project_name) in extracted_for_migration {
        // Auto-migrate legacy directory names after extraction.
        if let Err(e) = crate::commands::project::migrate_project_dirs(&target) {
            warnings.push(format!("项目 {} 目录迁移失败: {}", project_name, e));
        }
    }

    on_progress(&BackupProgressPayload {
        operation: "import".into(),
        stage: "done".into(),
        current: 1,
        total: 1,
        message: "导入完成".into(),
    });

    let any_failed = project_results.iter().any(|p| !p.success);

    Ok(ImportResult {
        success: !any_failed,
        app_state,
        local_storage_data,
        projects: project_results,
        warnings,
        error: None,
    })
}

// ── Tauri commands ──────────────────────────────────────────────────────────

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn cancel_backup() {
    BACKUP_CANCEL.store(true, Ordering::SeqCst);
    crate::canon::export::request_cancel();
}

#[tauri::command]
pub async fn export_backup(
    app: tauri::AppHandle,
    params: ExportParams,
) -> Result<ExportResult, String> {
    // Reset cancellation flag at the start of each export.
    BACKUP_CANCEL.store(false, Ordering::SeqCst);
    // 前置（plugin-store 落盘）：快操作，留 async 侧；panic 仍由 run_guarded 转 Err。
    let app_state_path = run_guarded("export_backup", || {
        // Flush the plugin-store to disk first so the zip gets the latest state.
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("无法获取 app_data_dir: {err}"))?;

        match app.store("app-state.json") {
            Ok(store) => {
                if let Err(e) = store.save() {
                    // 非致命：导出继续，但 zip 内 app-state 可能落后于内存态。
                    log::warn!("保存 app-state 存储失败: {e}");
                }
                Ok(app_data_dir.join("app-state.json"))
            }
            Err(e) => {
                // 非致命：回退到磁盘上的 app-state.json。
                log::warn!("无法获取 app-state 存储句柄: {e}");
                Ok(app_data_dir.join("app-state.json"))
            }
        }
    })?;

    let app_clone = app.clone();
    // P1-12：同步 zip 编解码搬入 spawn_blocking，不再阻塞 async worker；
    // blocking 侧 panic 经 JoinError 转 Err（命令签名/进度事件不变）。
    tokio::task::spawn_blocking(move || {
        do_export_backup(params, &app_state_path, move |payload| {
            emit_progress(
                &app_clone,
                &payload.operation,
                &payload.stage,
                payload.current,
                payload.total,
                &payload.message,
            );
        })
    })
    .await
    .map_err(|e| {
        if e.is_panic() {
            "Internal error in export_backup: 构建任务 panic".to_string()
        } else {
            format!("备份导出失败：构建任务异常: {e}")
        }
    })?
}

#[tauri::command]
pub async fn import_backup(
    app: tauri::AppHandle,
    params: ImportParams,
) -> Result<ImportResult, String> {
    // 前置（app_data_dir）：快操作，留 async 侧。
    let app_data_dir = run_guarded("import_backup", || {
        app.path()
            .app_data_dir()
            .map_err(|err| format!("无法获取 app_data_dir: {err}"))
    })?;

    let app_clone = app.clone();
    // P1-12：同 export，同步 zip 编解码搬入 spawn_blocking。
    let result = tokio::task::spawn_blocking(move || {
        do_import_backup(params, &app_data_dir, move |payload| {
            emit_progress(
                &app_clone,
                &payload.operation,
                &payload.stage,
                payload.current,
                payload.total,
                &payload.message,
            );
        })
    })
    .await
    .map_err(|e| {
        if e.is_panic() {
            "Internal error in import_backup: 构建任务 panic".to_string()
        } else {
            format!("备份导入失败：构建任务异常: {e}")
        }
    })??;

    // Re-hydrate the in-memory plugin-store so the app doesn't revert to
    // the old state on next shutdown.
    if let Some(ref app_state_json) = result.app_state {
        restore_app_state_via_store(&app, app_state_json)?;
    }

    Ok(result)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn import_strategy_accepts_camel_and_legacy_kebab() {
        // camel 主名＋旧 kebab alias 双可读（前端现状发 global-only）。
        for raw in [
            "\"globalOnly\"",
            "\"global-only\"",
            "\"full\"",
            "\"selective\"",
        ] {
            let parsed: ImportStrategy = serde_json::from_str(raw).unwrap();
            let _ = parsed;
        }
        assert!(matches!(
            serde_json::from_str::<ImportStrategy>("\"global-only\"").unwrap(),
            ImportStrategy::GlobalOnly
        ));
    }

    #[test]
    fn test_extract_dir_rejects_path_traversal() {
        let tmp = std::env::temp_dir().join("niko_buddy_zipslip_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let zip_path = tmp.join("evil.zip");
        let zip_file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = ZipWriter::new(zip_file);
        zip.start_file("prefix/../../../../evil.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"malicious").unwrap();
        zip.finish().unwrap();

        let target = tmp.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();

        let result = extract_dir_from_zip(&mut archive, "prefix/", &target);
        assert!(result.is_err(), "应拒绝路径遍历条目");
        let err = result.unwrap_err();
        assert!(err.contains("安全拦截"), "错误信息应包含安全拦截: {}", err);

        assert!(
            !tmp.join("evil.txt").exists(),
            "evil.txt 不应存在于临时目录"
        );
        assert!(
            !std::env::temp_dir().join("evil.txt").exists(),
            "evil.txt 不应存在于上级目录"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_extract_dir_accepts_normal_paths() {
        let tmp = std::env::temp_dir().join("niko_buddy_zipslip_normal_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let zip_path = tmp.join("normal.zip");
        let zip_file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = ZipWriter::new(zip_file);
        zip.start_file("prefix/chapter1.md", SimpleFileOptions::default())
            .unwrap();
        zip.write_all("# 第一章".as_bytes()).unwrap();
        zip.start_file("prefix/sub/chapter2.md", SimpleFileOptions::default())
            .unwrap();
        zip.write_all("# 第二章".as_bytes()).unwrap();
        zip.finish().unwrap();

        let target = tmp.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();

        let count = extract_dir_from_zip(&mut archive, "prefix/", &target).unwrap();
        assert_eq!(count, 2);
        assert!(target.join("chapter1.md").exists());
        assert!(target.join("sub/chapter2.md").exists());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn do_export_backup_aborts_and_deletes_partial_zip_when_cancelled_mid_pack() {
        static CANCEL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = CANCEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        BACKUP_CANCEL.store(false, Ordering::SeqCst);

        let tmp = std::env::temp_dir().join(format!(
            "nb-backup-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let proj = tmp.join("proj");
        std::fs::create_dir_all(proj.join("QM")).unwrap();
        std::fs::write(proj.join("QM").join("ch1.md"), "正文").unwrap();
        let save_path = tmp.join("cancelled.zip");
        let app_state_path = tmp.join("app-state.json");
        std::fs::write(&app_state_path, "{}").unwrap();

        let params = ExportParams {
            save_path: save_path.to_string_lossy().to_string(),
            local_storage_data: serde_json::json!({}),
            projects: vec![ProjectBackupInfo {
                id: "p1".into(),
                path: proj.to_string_lossy().to_string(),
                name: "Test".into(),
            }],
        };

        let result = do_export_backup(params, &app_state_path, |payload| {
            // 在进入 packing 阶段触发取消：此时 add_dir_to_zip 必须中断并删掉半成品 zip，不得吞进 warnings。
            if payload.stage == "packing" {
                BACKUP_CANCEL.store(true, Ordering::SeqCst);
            }
        });
        BACKUP_CANCEL.store(false, Ordering::SeqCst);

        let err = result.expect_err("取消后导出必须返回 Err 而非带 warnings 的 Ok");
        assert!(err.contains("取消"), "got: {err}");
        assert!(!save_path.exists(), "取消后不得残留半成品 zip 文件");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_file_from_zip_enforces_streaming_size_limit() {
        let tmp = std::env::temp_dir().join(format!(
            "nb-backup-limit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let zip_path = tmp.join("big.zip");
        {
            let zip_file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = ZipWriter::new(zip_file);
            zip.start_file("manifest.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&[b'a'; 128]).unwrap();
            zip.finish().unwrap();
        }
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        let err = extract_file_from_zip(&mut archive, "manifest.json", 64)
            .expect_err("超过字节上限必须拒绝");
        assert!(err.contains("安全拦截"), "{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_dir_rejects_midpath_dotdot_separators_control_and_reserved_names() {
        let tmp = std::env::temp_dir().join(format!(
            "nb-backup-strict-seg-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&tmp).unwrap();

        for bad_entry in [
            "prefix/a/b/../../evil.txt",
            "prefix/./dot.txt",
            r"prefix/a\b.txt",
            "prefix/C:evil.txt",
            "prefix/ads.txt:$DATA",
            "prefix/bad\x01ctrl.txt",
            "prefix/trailing.",
            "prefix/trailing ",
            "prefix/CON",
            "prefix/nul.md",
            "prefix/COM1.txt",
            "prefix//double-slash.txt",
        ] {
            let zip_path = tmp.join("case.zip");
            {
                let zip_file = std::fs::File::create(&zip_path).unwrap();
                let mut zip = ZipWriter::new(zip_file);
                zip.start_file(bad_entry, SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(b"payload").unwrap();
                zip.finish().unwrap();
            }
            let target = tmp.join("target");
            let _ = std::fs::remove_dir_all(&target);
            std::fs::create_dir_all(&target).unwrap();
            let mut archive =
                zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
            let result = extract_dir_from_zip(&mut archive, "prefix/", &target);
            assert!(result.is_err(), "非法 zip 条目必须被拒: {bad_entry:?}");
            let err = result.unwrap_err();
            assert!(
                err.contains("安全拦截"),
                "bad_entry={bad_entry:?}, err={err}"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_and_import_roundtrip_succeeds_and_rejects_symlink_paths() {
        let tmp = std::env::temp_dir().join(format!(
            "nb-backup-symlink-dag-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let src_proj = tmp.join("src-proj");
        std::fs::create_dir_all(src_proj.join("QM")).unwrap();
        std::fs::write(src_proj.join("QM").join("ch1.md"), "# Chapter 1").unwrap();
        let app_state_path = tmp.join("app-state.json");
        std::fs::write(&app_state_path, r#"{"theme":"light"}"#).unwrap();
        let save_path = tmp.join("backup.zip");

        let export_res = do_export_backup(
            ExportParams {
                save_path: save_path.to_string_lossy().to_string(),
                local_storage_data: serde_json::json!({"k":"v"}),
                projects: vec![ProjectBackupInfo {
                    id: "p1".into(),
                    path: src_proj.to_string_lossy().to_string(),
                    name: "MyNovel".into(),
                }],
            },
            &app_state_path,
            |_| {},
        )
        .expect("normal export should succeed");
        assert!(export_res.success);

        let restore_proj = tmp.join("restored-proj");
        let restore_state_dir = tmp.join("restored-state");
        let import_res = do_import_backup(
            ImportParams {
                zip_path: save_path.to_string_lossy().to_string(),
                strategy: ImportStrategy::Selective,
                projects: Some(vec![ProjectRestoreInfo {
                    id: "p1".into(),
                    target_path: restore_proj.to_string_lossy().to_string(),
                }]),
            },
            &restore_state_dir,
            |_| {},
        )
        .expect("normal import should succeed without T4->T3 deadlock");
        assert!(import_res.success);
        assert!(
            restore_proj.join("wiki").join("ch1.md").is_file()
                || restore_proj.join("QM").join("ch1.md").is_file()
        );

        // 构造目录 symlink/junction，验证 do_export_backup 与 do_import_backup 均拦截。
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link_dir = tmp.join("link-dir");
        let linked = {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&outside, &link_dir).is_ok()
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(&outside, &link_dir).is_ok()
                    || std::process::Command::new("cmd")
                        .args([
                            "/c",
                            "mklink",
                            "/J",
                            &link_dir.to_string_lossy(),
                            &outside.to_string_lossy(),
                        ])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .is_ok_and(|s| s.success())
            }
        };
        if linked {
            let export_err = do_export_backup(
                ExportParams {
                    save_path: link_dir.join("out.zip").to_string_lossy().to_string(),
                    local_storage_data: serde_json::json!({}),
                    projects: vec![],
                },
                &app_state_path,
                |_| {},
            )
            .expect_err("symlink ancestor in save_path must be rejected");
            assert!(export_err.contains("安全拦截"), "{export_err}");

            let import_err = do_import_backup(
                ImportParams {
                    zip_path: save_path.to_string_lossy().to_string(),
                    strategy: ImportStrategy::Selective,
                    projects: Some(vec![ProjectRestoreInfo {
                        id: "p1".into(),
                        target_path: link_dir.join("target").to_string_lossy().to_string(),
                    }]),
                },
                &restore_state_dir,
                |_| {},
            )
            .expect_err("symlink ancestor in restore target must be rejected");
            assert!(import_err.contains("安全拦截"), "{import_err}");

            let _ = std::fs::remove_dir(&link_dir);
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
