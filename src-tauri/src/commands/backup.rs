// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Backup / restore subsystem.
//!
//! Provides zip-based project export and import with progress reporting,
//! Zip Slip protection, and tauri-plugin-store integration for app state.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use walkdir::WalkDir;
use zip::write::ZipWriter;
use zip::CompressionMethod;

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
#[serde(rename_all = "kebab-case")]
pub enum ImportStrategy {
    Full,
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
const PROJECT_SUBDIRS: &[&str] = &[".qmai", ".novel", "book-analysis", "raw"];

/// Top-level project files to include in a backup.
const PROJECT_FILES: &[&str] = &["soul.md", "schema.md", "purpose.md"];

/// Possible on-disk names for the knowledge directory (new vs. legacy).
const KNOWLEDGE_DIR_CANDIDATES: &[&str] = &["QM", "wiki"];

/// Canonical name used inside the zip archive for the knowledge directory.
const KNOWLEDGE_ZIP_NAME: &str = "wiki";

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
/// `zip_prefix`.  Large files are streamed via `std::io::copy` to keep
/// memory usage bounded.
fn add_dir_to_zip(
    zip: &mut ZipWriter<fs::File>,
    base_dir: &Path,
    zip_prefix: &str,
    file_count: &mut usize,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for walk_entry in WalkDir::new(base_dir).into_iter() {
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

/// Read a single named file from a zip archive, returning `None` if absent.
fn extract_file_from_zip(
    archive: &mut zip::ZipArchive<fs::File>,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    match archive.by_name(name) {
        Ok(mut file) => {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut file, &mut buf)
                .map_err(|e| format!("读取 zip 内文件 {} 失败: {e}", name))?;
            Ok(Some(buf))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(format!("访问 zip 内文件 {} 失败: {e}", name)),
    }
}

/// Extract all entries under `zip_prefix` into `target_dir`, with
/// Zip Slip protection via component-level path normalisation.
fn extract_dir_from_zip(
    archive: &mut zip::ZipArchive<fs::File>,
    zip_prefix: &str,
    target_dir: &Path,
) -> Result<usize, String> {
    let mut written = 0usize;

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
        let relative = &name[zip_prefix.len()..];
        let relative = relative.trim_start_matches('/');
        if relative.is_empty() {
            continue;
        }

        // Walk each component and reject any traversal that escapes target.
        let mut safe_dest = canonical_target.clone();
        for component in Path::new(relative).components() {
            match component {
                std::path::Component::ParentDir => {
                    safe_dest.pop();
                    if !safe_dest.starts_with(&canonical_target) {
                        return Err(format!(
                            "安全拦截：zip 条目 \"{}\" 试图写入目标目录之外的位置",
                            name
                        ));
                    }
                }
                std::path::Component::CurDir => {}
                other => safe_dest.push(other),
            }
        }

        if !safe_dest.starts_with(&canonical_target) {
            return Err(format!(
                "安全拦截：zip 条目 \"{}\" 试图写入目标目录之外的位置 {}",
                name,
                safe_dest.display()
            ));
        }

        // Directory entry — just create and move on.
        if name.ends_with('/') {
            fs::create_dir_all(&safe_dest)
                .map_err(|e| format!("创建目录失败 {}: {e}", safe_dest.display()))?;
            continue;
        }

        // File entry — ensure parent dirs then write contents.
        if let Some(parent) = safe_dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建父目录失败 {}: {e}", parent.display()))?;
        }

        let mut zip_file = archive
            .by_name(&name)
            .map_err(|e| format!("打开 zip 内文件 {} 失败: {e}", name))?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut zip_file, &mut buf)
            .map_err(|e| format!("读取 zip 内文件 {} 失败: {e}", name))?;
        fs::write(&safe_dest, &buf)
            .map_err(|e| format!("写入文件失败 {}: {e}", safe_dest.display()))?;
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
    let save_path = Path::new(&params.save_path);
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
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    // ── 1. manifest.json ────────────────────────────────────────────────────
    let manifest = BackupManifest {
        backup_version: 1,
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
        let state_bytes = fs::read(app_state_path)
            .map_err(|e| format!("读取 app-state.json 失败: {e}"))?;
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
                ) {
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
            let subdir_path = project_path.join(subdir);
            if subdir_path.is_dir() {
                let sub_prefix = format!("{}/{}", zip_prefix, subdir);
                if let Err(e) = add_dir_to_zip(
                    &mut zip,
                    &subdir_path,
                    &sub_prefix,
                    &mut file_count,
                    &mut warnings,
                ) {
                    warnings.push(format!(
                        "复制项目 {} 的 {} 目录失败: {}",
                        project.name, subdir, e
                    ));
                }
            }
        }

        // Top-level project files.
        for file_name in PROJECT_FILES {
            let file_path = project_path.join(file_name);
            if file_path.is_file() {
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

    let file = fs::File::open(zip_path).map_err(|e| format!("打开备份文件失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("读取备份文件失败，可能已损坏: {e}"))?;

    let mut warnings: Vec<String> = Vec::new();
    let mut app_state: Option<serde_json::Value> = None;
    let mut local_storage_data: Option<serde_json::Value> = None;
    let mut project_results: Vec<ProjectRestoreResult> = Vec::new();

    // ── Read manifest ───────────────────────────────────────────────────────
    let manifest_projects = if let Some(manifest_bytes) =
        extract_file_from_zip(&mut archive, "manifest.json")?
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
        if let Some(state_bytes) =
            extract_file_from_zip(&mut archive, "global/app-state.json")?
        {
            let state_json: serde_json::Value = serde_json::from_slice(&state_bytes)
                .map_err(|e| format!("解析 app-state.json 失败: {e}"))?;

            fs::create_dir_all(app_state_dir)
                .map_err(|e| format!("创建数据目录失败: {e}"))?;
            let state_path = app_state_dir.join("app-state.json");
            let state_str = serde_json::to_string_pretty(&state_json)
                .map_err(|e| format!("序列化 app-state 失败: {e}"))?;
            fs::write(&state_path, state_str.as_bytes())
                .map_err(|e| format!("写入 app-state.json 失败: {e}"))?;

            app_state = Some(state_json);
        }

        // local-storage.json
        if let Some(ls_bytes) =
            extract_file_from_zip(&mut archive, "global/local-storage.json")?
        {
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

        for (idx, (project_id, target_path, project_name)) in
            restore_targets.iter().enumerate()
        {
            on_progress(&BackupProgressPayload {
                operation: "import".into(),
                stage: "restoring".into(),
                current: idx + 1,
                total: total.max(1),
                message: format!("正在恢复项目: {}", project_name),
            });

            let zip_prefix = format!("projects/{}/", project_id);
            let target = Path::new(target_path);

            fs::create_dir_all(target)
                .map_err(|e| format!("创建项目目录失败 {}: {e}", target.display()))?;

            match extract_dir_from_zip(&mut archive, &zip_prefix, target) {
                Ok(_count) => {
                    // Auto-migrate legacy directory names after extraction.
                    if let Err(e) = crate::commands::project::migrate_project_dirs(target) {
                        warnings.push(format!("项目 {} 目录迁移失败: {}", project_name, e));
                    }
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

#[tauri::command]
pub async fn export_backup(
    app: tauri::AppHandle,
    params: ExportParams,
) -> Result<ExportResult, String> {
    run_guarded("export_backup", || {
        // Flush the plugin-store to disk first so the zip gets the latest state.
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("无法获取 app_data_dir: {err}"))?;

        let app_state_path = match app.store("app-state.json") {
            Ok(store) => {
                if let Err(e) = store.save() {
                    eprintln!("保存 app-state 存储失败: {e}");
                }
                app_data_dir.join("app-state.json")
            }
            Err(e) => {
                eprintln!("无法获取 app-state 存储句柄: {e}");
                app_data_dir.join("app-state.json")
            }
        };

        let app_clone = app.clone();
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
}

#[tauri::command]
pub async fn import_backup(
    app: tauri::AppHandle,
    params: ImportParams,
) -> Result<ImportResult, String> {
    run_guarded("import_backup", || {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("无法获取 app_data_dir: {err}"))?;

        let app_clone = app.clone();
        let result = do_import_backup(params, &app_data_dir, move |payload| {
            emit_progress(
                &app_clone,
                &payload.operation,
                &payload.stage,
                payload.current,
                payload.total,
                &payload.message,
            );
        })?;

        // Re-hydrate the in-memory plugin-store so the app doesn't revert to
        // the old state on next shutdown.
        if let Some(ref app_state_json) = result.app_state {
            restore_app_state_via_store(&app, app_state_json)?;
        }

        Ok(result)
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn test_extract_dir_rejects_path_traversal() {
        let tmp = std::env::temp_dir().join("qmai_zipslip_test");
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
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();

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
        let tmp = std::env::temp_dir().join("qmai_zipslip_normal_test");
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
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();

        let count = extract_dir_from_zip(&mut archive, "prefix/", &target).unwrap();
        assert_eq!(count, 2);
        assert!(target.join("chapter1.md").exists());
        assert!(target.join("sub/chapter2.md").exists());

        std::fs::remove_dir_all(&tmp).ok();
    }
}
