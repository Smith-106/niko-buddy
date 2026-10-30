// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Project management IPC commands.
//!
//! Handles project creation, opening, folder navigation, and legacy directory
//! migration for the Niko Buddy / Niko Buddy desktop application.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::commands::fs::resolve_project_storage_path;
use crate::panic_guard::run_guarded;
use crate::types::wiki::WikiProject;

// ── Directory name constants ────────────────────────────────────────────────

const KNOWLEDGE_DIR: &str = "QM";
const LEGACY_KNOWLEDGE_DIR: &str = "wiki";
const META_DIR: &str = ".niko-buddy";
const LEGACY_META_DIR: &str = ".llm-wiki";
const LEGACY_QMAI_DIR: &str = ".qmai";
/// G4：新旧目录并存时的同名冲突备份目录（旧侧副本移入此处，不删除）。
const LEGACY_CONFLICTS_DIR: &str = "legacy-conflicts";

/// 迁移三步的单一事实源（顺序即优先级）：dry-run、实跑、冲突报告共用这一份。
const MIGRATION_STEPS: [(&str, &str); 3] = [
    (LEGACY_META_DIR, META_DIR),
    (LEGACY_QMAI_DIR, META_DIR),
    (LEGACY_KNOWLEDGE_DIR, KNOWLEDGE_DIR),
];

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_project(name: String, path: String) -> Result<WikiProject, String> {
    run_guarded("create_project", || create_project_impl(name, path))
}

#[tauri::command]
pub fn open_project(app: AppHandle, path: String) -> Result<WikiProject, String> {
    run_guarded("open_project", || open_project_impl(&app, &path))
}

#[tauri::command]
pub fn open_project_folder(app: AppHandle, path: String) -> Result<(), String> {
    run_guarded("open_project_folder", || {
        open_project_folder_impl(&app, &path)
    })
}

#[tauri::command]
pub async fn open_file_location(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("open_file_location", || {
            open_file_location_impl(&app, &path)
        })
    })
    .await
    .map_err(|e| format!("open_file_location blocking task join error: {e}"))?
}

// ── Implementation: create_project ──────────────────────────────────────────

pub fn create_project_impl(name: String, path: String) -> Result<WikiProject, String> {
    let root = Path::new(&path).join(&name);

    if root.exists() {
        return Err(format!("目录已存在：'{}'", root.display()));
    }

    // Bootstrap the standard directory layout.
    let subdirs: &[&str] = &[
        "raw/sources",
        "raw/assets",
        "QM/entities",
        "QM/concepts",
        "QM/sources",
        "QM/queries",
        "QM/comparisons",
        "QM/synthesis",
        "QM/chapters",
        "QM/outlines",
        ".niko-buddy",
        ".novel/snapshots",
    ];
    for subdir in subdirs {
        fs::create_dir_all(root.join(subdir))
            .map_err(|e| format!("创建目录 '{}' 失败：{}", subdir, e))?;
    }

    let today = Local::now().format("%Y-%m-%d").to_string();

    // schema.md — project page-type reference and frontmatter contract
    write_project_file(root.join("schema.md"), schema_markdown_content())?;

    // purpose.md — editable template for the author's goals
    write_project_file(root.join("purpose.md"), purpose_markdown_content())?;

    // QM/index.md — section index stub
    write_project_file(root.join("QM/index.md"), index_markdown_content())?;

    // QM/log.md — creation-day log entry
    write_project_file(
        root.join("QM/log.md"),
        &format!("# 创作日志\n\n## {today}\n\n- 项目创建\n"),
    )?;

    // QM/overview.md — high-level project overview stub
    write_project_file(root.join("QM/overview.md"), overview_markdown_content())?;

    // .obsidian — compatibility layer for Obsidian users
    bootstrap_obsidian_config(&root)?;

    Ok(WikiProject {
        name,
        // Normalise to forward slashes so the TS layer gets a consistent path.
        path: root.to_string_lossy().replace('\\', "/"),
    })
}

// ── Implementation: open_project ────────────────────────────────────────────

fn open_project_impl(app: &AppHandle, path: &str) -> Result<WikiProject, String> {
    let root = Path::new(path);

    validate_wiki_project_root(root)?;
    migrate_project_dirs(root)?;

    // 架构-1：启动（或切换）status.json 独立监听。失败不阻断项目打开
    // （仅日志降级）——事件监听是增强能力，不是打开项目的硬依赖。
    if let Err(e) = crate::status_watcher::start_status_watcher(app, path) {
        log::warn!("[status-watcher] start failed for '{}': {e}", path);
    }

    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    Ok(WikiProject {
        name,
        path: path.replace('\\', "/"),
    })
}

// ── Implementation: open_project_folder ─────────────────────────────────────

fn open_project_folder_impl(app: &AppHandle, path: &str) -> Result<(), String> {
    let root = Path::new(path);
    validate_wiki_project_root(root)?;

    let canonical = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path '{}': {}", path, e))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // Prefer opening the folder directly; fall back to "reveal in explorer".
    match app.opener().open_path(canonical_str.clone(), None::<&str>) {
        Ok(()) => Ok(()),
        Err(open_err) => app
            .opener()
            .reveal_item_in_dir(canonical_str)
            .map_err(|reveal_err| {
                format!(
                    "Failed to open project folder: {}; reveal fallback also failed: {}",
                    open_err, reveal_err
                )
            }),
    }
}

// ── Implementation: open_file_location ──────────────────────────────────────

fn open_file_location_impl(app: &AppHandle, path: &str) -> Result<(), String> {
    let resolved = resolve_project_storage_path(path)?;
    let file_path = Path::new(&resolved);
    if !file_path.exists() {
        return Err(format!("文件不存在：'{}'", resolved));
    }
    let canonical = file_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file path '{}': {}", resolved, e))?;
    let canonical_str = canonical.to_string_lossy().to_string();
    app.opener()
        .reveal_item_in_dir(canonical_str)
        .map_err(|e| format!("Failed to reveal file in directory: {}", e))
}

// ── Validation ──────────────────────────────────────────────────────────────

/// Confirm that `root` looks like a valid Niko Buddy project directory.
/// If lightweight markers are missing they are auto-created for convenience.
pub fn validate_wiki_project_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Err(format!("路径不存在：'{}'", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("路径不是文件夹：'{}'", root.display()));
    }

    let has_schema = root.join("schema.md").exists();
    let has_wiki = root.join(KNOWLEDGE_DIR).is_dir() || root.join(LEGACY_KNOWLEDGE_DIR).is_dir();
    let has_novel = root.join(".novel").is_dir();
    let has_md_files = fs::read_dir(root)
        .map(|mut entries| {
            entries.any(|entry| {
                entry
                    .map(|e| e.path().extension().map(|ext| ext == "md").unwrap_or(false))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if !has_schema && !has_wiki && !has_novel && !has_md_files {
        return Err(format!(
            "不是有效的项目文件夹（未找到 schema.md、wiki 目录或 Markdown 文件）：'{}'",
            root.display()
        ));
    }

    // Auto-create schema.md if it does not exist yet.
    if !has_schema {
        write_project_file(root.join("schema.md"), schema_stub_content())
            .map_err(|e| format!("自动创建 schema.md 失败：{}", e))?;
    }

    // Ensure the knowledge directory exists (new name).
    if !has_wiki {
        fs::create_dir_all(root.join(KNOWLEDGE_DIR))
            .map_err(|e| format!("自动创建 wiki 目录失败：{}", e))?;
    }

    Ok(())
}

// ── Migration ───────────────────────────────────────────────────────────────

/// 单步迁移动作（G2 迁移报告：每对 from→to 到底发生了什么）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationAction {
    /// 已执行 rename，旧目录内容搬到新位置。
    Migrated,
    /// G4 新旧目录并存：已按「以新目录为准」合并（仅旧侧搬入、同名一致丢旧副本、
    /// 同名冲突移入 legacy-conflicts/ 备份）。
    Merged,
    /// 源目录不存在，无事可做。
    SkippedSourceMissing,
    /// 目标已存在且无法逐文件合并（同名文件占位），跳过以防覆盖；旧目录原样保留待人工处理。
    SkippedTargetExists,
}

/// 单步迁移明细：哪一对目录、什么动作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationStep {
    pub from: &'static str,
    pub to: &'static str,
    pub action: MigrationAction,
}

/// G2 迁移报告：三步顺序迁移各自的迁移/跳过明细。
///
/// 向后兼容说明：此前签名为 `Result<(), String>`；现有调用方只有三类用法
/// （`migrate_project_dirs(root)?;` 丢弃 Ok 值、`if let Err(e) = ...` 只看 Err、
/// 测试 `...unwrap();` 作语句丢弃返回值），改为 `Result<MigrationReport, String>`
/// 后三类调用均无需改动即可编译通过，错误语义不变。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MigrationReport {
    pub steps: Vec<MigrationStep>,
}

impl MigrationReport {
    /// 实际发生 rename 的步骤。
    pub fn migrated(&self) -> Vec<&MigrationStep> {
        self.steps.iter().filter(|s| s.action == MigrationAction::Migrated).collect()
    }

    /// G4 发生逐文件合并的步骤。
    pub fn merged(&self) -> Vec<&MigrationStep> {
        self.steps.iter().filter(|s| s.action == MigrationAction::Merged).collect()
    }

    /// 被跳过的步骤（源缺失或目标无法合并）。
    pub fn skipped(&self) -> Vec<&MigrationStep> {
        self.steps
            .iter()
            .filter(|s| s.action != MigrationAction::Migrated && s.action != MigrationAction::Merged)
            .collect()
    }

    /// 是否空跑（无任何实际迁移/合并）。
    pub fn is_noop(&self) -> bool {
        self.migrated().is_empty() && self.merged().is_empty()
    }
}

/// Rename legacy directories to the current naming convention when safe.
///
/// G4：新旧两代目录并存时按「以新目录为准」合并（见 [`merge_legacy_into_target`]）。
/// 返回三步各自的迁移/合并/跳过明细（G2）；调用方忽略返回值时仍会执行迁移。
pub fn migrate_project_dirs(root: &Path) -> Result<MigrationReport, String> {
    // 单一事实源：先由 dry-run 算出三步计划，再逐步执行。
    // 这样 dry-run 与实跑共用同一份「哪三步、什么顺序」的定义，不会漂移。
    let planned = migrate_project_dirs_dry_run(root);
    let mut steps = Vec::with_capacity(planned.steps.len());
    // G3 可逆：记录本次已完成的 rename，任一步失败则逆序回滚，
    // 保证「要么全迁、要么不动」——不会留下迁一半的半成品项目。
    let mut completed: Vec<(&'static str, &'static str)> = Vec::new();
    // G4：合并步骤同样可逆（搬入/备份的文件撤回旧目录；丢弃的同名副本内容仍在新目录，无需恢复）。
    let mut merges: Vec<MergeRecord> = Vec::new();
    for step in planned.steps {
        let mut record = MergeRecord::default();
        match apply_migration_step(root, step.from, step.to, &mut record) {
            Ok(action) => {
                match action {
                    MigrationAction::Migrated => completed.push((step.from, step.to)),
                    MigrationAction::Merged => merges.push(record),
                    _ => {}
                }
                steps.push(MigrationStep { from: step.from, to: step.to, action });
            }
            Err(err) => {
                // 合并中途失败时 record 里已记录完成的文件搬动，一并回滚。
                merges.push(record);
                let rolled_back_merges = rollback_merges(&merges);
                let rolled_back = rollback_renames(root, &completed);
                return Err(format!(
                    "{err}（已回滚 {rolled_back}/{} 步已完成迁移、{rolled_back_merges} 个已合并文件）",
                    completed.len()
                ));
            }
        }
    }
    let report = MigrationReport { steps };
    if !report.is_noop() {
        log::info!(
            "[migrate] 项目目录迁移：{} 步实际 rename，{} 步合并，{} 步跳过",
            report.migrated().len(),
            report.merged().len(),
            report.skipped().len()
        );
    }
    Ok(report)
}

/// G4 合并记录：一次新旧目录合并到底搬动了什么，供失败回滚使用。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MergeRecord {
    /// (旧侧源路径, 新目录目标路径)：本次搬入新目录的文件。
    moved_in: Vec<(PathBuf, PathBuf)>,
    /// (旧侧源路径, legacy-conflicts 备份路径)：本次备份的同名冲突文件。
    backed_up: Vec<(PathBuf, PathBuf)>,
    /// 内容与新目录完全一致而被丢弃的旧副本。内容仍在新目录中，回滚无需恢复。
    discarded: Vec<PathBuf>,
}

/// 执行单步迁移：目标缺失 → rename；新旧目录并存 → G4 合并；目标被同名文件占位 → 跳过。
fn apply_migration_step(
    root: &Path,
    from: &'static str,
    to: &'static str,
    record: &mut MergeRecord,
) -> Result<MigrationAction, String> {
    let source = root.join(from);
    let target = root.join(to);
    if !source.exists() {
        return Ok(MigrationAction::SkippedSourceMissing);
    }
    if !target.exists() {
        return rename_dir_if_safe(root, from, to);
    }
    if !target.is_dir() || !source.is_dir() {
        // 同名文件占位：无法逐文件合并，保持原样（不覆盖、不删除）。
        return Ok(MigrationAction::SkippedTargetExists);
    }
    merge_legacy_into_target(root, from, to, record)?;
    Ok(MigrationAction::Merged)
}

/// G4 合并（产品决策：以新目录为准）。
///
/// 逐文件规则：
/// - 仅旧侧存在 → 搬入新目录（同相对路径，自动建父目录）；
/// - 两侧同名且字节一致 → 丢弃旧副本（内容已在新目录，不丢数据）；
/// - 两侧同名但内容不同 → 旧侧移入 `legacy-conflicts/<旧目录名>/<相对路径>` 备份，
///   不删除、不覆盖新目录版本；
/// - 新侧独有的文件不受影响。
///
/// 合并后旧目录只剩空壳，递归剪掉空目录；非空（外部并发写入）则保留。
fn merge_legacy_into_target(
    root: &Path,
    from: &str,
    to: &str,
    record: &mut MergeRecord,
) -> Result<(), String> {
    let legacy = root.join(from);
    let target = root.join(to);
    let backup_root = root.join(LEGACY_CONFLICTS_DIR).join(from);
    let mut files = Vec::new();
    collect_relative_files(&legacy, &legacy, &mut files)?;
    files.sort();
    for rel in files {
        let src = legacy.join(&rel);
        let dst = target.join(&rel);
        if !dst.exists() {
            ensure_parent_dir(&dst)?;
            fs::rename(&src, &dst).map_err(|e| {
                format!("合并搬入 '{}' 到 '{}' 失败：{}", src.display(), dst.display(), e)
            })?;
            record.moved_in.push((src, dst));
        } else if dst.is_file() && files_identical(&src, &dst)? {
            fs::remove_file(&src)
                .map_err(|e| format!("丢弃同名一致旧副本 '{}' 失败：{}", src.display(), e))?;
            record.discarded.push(src);
        } else {
            let backup = backup_root.join(&rel);
            ensure_parent_dir(&backup)?;
            fs::rename(&src, &backup).map_err(|e| {
                format!(
                    "冲突文件 '{}' 备份到 '{}' 失败：{}",
                    src.display(),
                    backup.display(),
                    e
                )
            })?;
            record.backed_up.push((src, backup));
        }
    }
    prune_empty_dirs(&legacy)?;
    // 同名冲突时保留的是新目录版本；旧版本只在备份里。必须留一条可见记录，
    // 否则用户无从得知「有旧内容被换下来、放在哪里」。
    if !record.backed_up.is_empty() {
        log::warn!(
            "[migrate] '{}' → '{}' 合并时有 {} 个同名文件内容不同，已保留新目录版本，旧版本备份在 '{}'",
            from,
            to,
            record.backed_up.len(),
            backup_root.display()
        );
    }
    Ok(())
}

/// 建父目录（`dst` 的父路径）。
fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录 '{}' 失败：{}", parent.display(), e))?;
    }
    Ok(())
}

/// 递归剪掉空目录；非空目录保留（`remove_dir` 本身拒绝删非空目录）。
fn prune_empty_dirs(dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败（{}）：{}", dir.display(), e))?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            prune_empty_dirs(&entry.path())?;
        }
    }
    let _ = fs::remove_dir(dir);
    Ok(())
}

/// G4 回滚：把合并搬入/备份的文件逆序撤回旧目录。
///
/// 只在源位置空缺时动手（避免覆盖回滚期间被外部创建的同名文件）。
/// 返回实际撤回的文件数（尽力而为：单文件失败不阻断后续撤回）。
fn rollback_merges(records: &[MergeRecord]) -> usize {
    let mut rolled_back = 0usize;
    for record in records.iter().rev() {
        for (src, backup) in record.backed_up.iter().rev() {
            if backup.exists() && !src.exists() && ensure_parent_dir(src).is_ok() {
                if fs::rename(backup, src).is_ok() {
                    rolled_back += 1;
                }
            }
        }
        for (src, dst) in record.moved_in.iter().rev() {
            if dst.exists() && !src.exists() && ensure_parent_dir(src).is_ok() {
                if fs::rename(dst, src).is_ok() {
                    rolled_back += 1;
                }
            }
        }
    }
    if rolled_back > 0 {
        log::warn!("[migrate] 合并失败，已回滚 {rolled_back} 个文件");
    }
    rolled_back
}

/// G3 回滚：把本次已完成的 rename 逆序撤回（`to` → `from`）。
///
/// 只在 `to` 存在且 `from` 不存在时动手，避免覆盖回滚期间被外部创建的同名目录。
/// 返回实际撤回的步数（尽力而为：单步失败不阻断后续撤回）。
fn rollback_renames(root: &Path, completed: &[(&'static str, &'static str)]) -> usize {
    let mut rolled_back = 0usize;
    for (from, to) in completed.iter().rev() {
        let current = root.join(to);
        let original = root.join(from);
        if current.exists() && !original.exists() && fs::rename(&current, &original).is_ok() {
            rolled_back += 1;
        }
    }
    if rolled_back > 0 {
        log::warn!("[migrate] 迁移失败，已回滚 {rolled_back} 步");
    }
    rolled_back
}

/// Dry-run：只计算三步各自会是什么动作，不触碰文件系统（G2）。
///
/// G4：两侧目录并存时预测为 `Merged`（实跑会逐文件合并），只有目标被同名文件占位
/// 才预测为 `SkippedTargetExists`——保证预测与实跑结论一致。
pub fn migrate_project_dirs_dry_run(root: &Path) -> MigrationReport {
    let steps = MIGRATION_STEPS
        .into_iter()
        .map(|(from, to)| {
            let source = root.join(from);
            let target = root.join(to);
            let action = if !source.exists() {
                MigrationAction::SkippedSourceMissing
            } else if !target.exists() {
                // dry-run 下“可迁移”用 Migrated 表示“将会迁移”。
                MigrationAction::Migrated
            } else if source.is_dir() && target.is_dir() {
                MigrationAction::Merged
            } else {
                MigrationAction::SkippedTargetExists
            };
            MigrationStep { from, to, action }
        })
        .collect();
    MigrationReport { steps }
}

/// G4 冲突明细：新旧两代目录并存时的逐文件比对。
///
/// 只读：不移动、不覆盖、不删除任何文件，只产出报告。实跑的合并规则（以新目录为准，
/// 同名冲突移入 `legacy-conflicts/`）见 [`merge_legacy_into_target`]；本报告用于预览
/// 「这次合并会搬什么、丢什么、备份什么」。
///
/// 产品决策「以新目录为准」落地后，dry-run 已改为直接预测 [`MigrationAction::Merged`]，
/// 本报告保留为**测试专用**的独立语义校验（`#[cfg(test)]`）：它从另一角度验证
/// 合并规则的三分类与实跑结果一致，不作为生产 API 接线。
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationConflictReport {
    pub from: &'static str,
    pub to: &'static str,
    /// 仅旧目录有的文件（相对路径，`/` 分隔）：任何规则下都可无冲突搬入新目录。
    pub only_in_legacy: Vec<String>,
    /// 两边同名且字节一致：任何规则下旧副本都可安全丢弃。
    pub identical: Vec<String>,
    /// 两边同名但内容不同（或一侧是目录、一侧是文件）：真正需要规则裁决的冲突。
    pub conflicting: Vec<String>,
}

#[cfg(test)]
impl MigrationConflictReport {
    /// 是否存在需要规则裁决的同名冲突。
    #[cfg(test)]
    pub fn has_conflicts(&self) -> bool {
        !self.conflicting.is_empty()
    }
}

/// G4 只读冲突报告：对每个「新旧目录并存」的步骤，列出仅旧侧文件、
/// 同名一致文件与同名冲突文件。其余步骤（源缺失 / 可直接 rename）不产出条目。
///
/// 测试专用：dry-run 已改用 `MigrationAction::Merged` 预测，本函数仅作三分类的
/// 独立交叉校验。
#[cfg(test)]
pub fn migrate_project_dirs_conflicts(root: &Path) -> Result<Vec<MigrationConflictReport>, String> {
    let mut reports = Vec::new();
    for (from, to) in MIGRATION_STEPS {
        let legacy_root = root.join(from);
        let target_root = root.join(to);
        if !legacy_root.exists() || !target_root.exists() {
            continue;
        }
        let mut report = MigrationConflictReport {
            from,
            to,
            only_in_legacy: Vec::new(),
            identical: Vec::new(),
            conflicting: Vec::new(),
        };
        if !legacy_root.is_dir() || !target_root.is_dir() {
            // 一侧是同名文件占位：整对目录无法逐文件合并，整体记为冲突。
            report.conflicting.push(".".to_string());
            reports.push(report);
            continue;
        }
        let mut legacy_files = Vec::new();
        collect_relative_files(&legacy_root, &legacy_root, &mut legacy_files)?;
        legacy_files.sort();
        for rel in legacy_files {
            let legacy_path = legacy_root.join(&rel);
            let target_path = target_root.join(&rel);
            if !target_path.exists() {
                report.only_in_legacy.push(rel);
            } else if !target_path.is_file() {
                report.conflicting.push(rel);
            } else if files_identical(&legacy_path, &target_path)? {
                report.identical.push(rel);
            } else {
                report.conflicting.push(rel);
            }
        }
        reports.push(report);
    }
    Ok(reports)
}

/// 递归收集 `dir` 下所有普通文件相对 `base` 的路径（`/` 分隔）。符号链接不跟随、不收集。
fn collect_relative_files(base: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录 '{}' 失败：{}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败（{}）：{}", dir.display(), e))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型 '{}' 失败：{}", path.display(), e))?;
        if file_type.is_dir() {
            collect_relative_files(base, &path, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("计算相对路径 '{}' 失败：{}", path.display(), e))?;
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// 先比长度再比字节，判断两个文件内容是否一致。
fn files_identical(a: &Path, b: &Path) -> Result<bool, String> {
    let len_a = fs::metadata(a).map_err(|e| format!("读取元数据 '{}' 失败：{}", a.display(), e))?.len();
    let len_b = fs::metadata(b).map_err(|e| format!("读取元数据 '{}' 失败：{}", b.display(), e))?.len();
    if len_a != len_b {
        return Ok(false);
    }
    let bytes_a = fs::read(a).map_err(|e| format!("读取文件 '{}' 失败：{}", a.display(), e))?;
    let bytes_b = fs::read(b).map_err(|e| format!("读取文件 '{}' 失败：{}", b.display(), e))?;
    Ok(bytes_a == bytes_b)
}

/// Rename `root/from` to `root/to` only when `from` exists and `to` does not,
/// preventing accidental overwrites. 返回本次动作供迁移报告使用。
fn rename_dir_if_safe(root: &Path, from: &str, to: &str) -> Result<MigrationAction, String> {
    let source = root.join(from);
    let target = root.join(to);
    if !source.exists() {
        return Ok(MigrationAction::SkippedSourceMissing);
    }
    if target.exists() {
        return Ok(MigrationAction::SkippedTargetExists); // Nothing to do or target already present.
    }
    fs::rename(&source, &target).map_err(|e| {
        format!(
            "迁移目录 '{}' 到 '{}' 失败：{}",
            source.display(),
            target.display(),
            e
        )
    })?;
    Ok(MigrationAction::Migrated)
}

// ── File-writing helper ─────────────────────────────────────────────────────

/// Write `contents` to `path`, creating all missing parent directories first.
fn write_project_file(path: std::path::PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create parent dirs for '{}': {}",
                path.display(),
                e
            )
        })?;
    }
    fs::write(&path, contents)
        .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))
}

// ── Bootstrap helpers (Obsidian compatibility) ──────────────────────────────

fn bootstrap_obsidian_config(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join(".obsidian"))
        .map_err(|e| format!("Failed to create .obsidian: {}", e))?;

    let app_json = r#"{
  "attachmentFolderPath": "raw/assets",
  "userIgnoreFilters": [
    ".cache",
    ".niko-buddy",
    ".superpowers"
  ],
  "useMarkdownLinks": false,
  "newLinkFormat": "shortest",
  "showUnsupportedFiles": false
}"#;
    write_project_file(root.join(".obsidian/app.json"), app_json)?;

    let appearance_json = r#"{
  "baseFontSize": 16,
  "theme": "obsidian"
}"#;
    write_project_file(root.join(".obsidian/appearance.json"), appearance_json)?;

    let core_plugins_json = r#"{
  "file-explorer": true,
  "global-search": true,
  "graph": true,
  "backlink": true,
  "tag-pane": true,
  "page-preview": true,
  "outgoing-link": true,
  "starred": true
}"#;
    write_project_file(root.join(".obsidian/core-plugins.json"), core_plugins_json)?;

    Ok(())
}

// ── Markdown content generators ─────────────────────────────────────────────

fn schema_markdown_content() -> &'static str {
    r#"# 小说项目 Schema

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
| chapter | QM/chapters/ | 章节正文 |
| outline | QM/outlines/ | 大纲（总纲/分卷/章节） |
| entity | QM/entities/ | 人物、地点、组织、物品 |
| concept | QM/concepts/ | 设定、能力体系、世界观规则 |
| source | QM/sources/ | 参考资料 |
| query | QM/queries/ | 待解决的创作问题 |
| comparison | QM/comparisons/ | 对比分析 |
| synthesis | QM/synthesis/ | 综合总结 |
| overview | QM/ | 项目概述 |

## 命名规范

- 文件名：`kebab-case.md`
- 人物：使用角色名（如 `林烬.md`）
- 地点：使用地名（如 `皇城.md`）
- 章节：`第N章-标题.md`（如 `第1章-暗夜.md`）
- 大纲：`总纲.md`、`第N卷大纲.md`

## Frontmatter

所有页面必须包含 YAML frontmatter：

```yaml
---
type: chapter | outline | entity | concept | source | query | comparison | synthesis | overview
title: 标题
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

章节页面额外包含：
```yaml
chapter_number: 1
chapter_status: draft | writing | review | done
```

大纲页面额外包含：
```yaml
outline_type: master-outline | volume-outline | chapter-outline
```

## 交叉引用规则

- 使用 `[[页面名]]` 语法链接页面
- 人物页面应出现在 `QM/index.md` 中
- 章节页面引用出场人物和地点
- 大纲页面引用相关章节

## 矛盾处理

当设定出现矛盾时：
1. 在相关页面标注矛盾
2. 创建或更新查询页面追踪问题
3. 解决后在综合页面中记录"#
}

fn purpose_markdown_content() -> &'static str {
    r#"# 小说项目目标

## 核心设定

<!-- 小说核心世界观和主题 -->

## 主要人物

<!-- 列出主要角色及其核心特征 -->

1.
2.
3.

## 故事范围

<!-- 故事涵盖的内容范围 -->

**包含：**
-

**不包含：**
-

## 当前进度

<!-- 更新写作进度 -->

> 待开始
"#
}

fn index_markdown_content() -> &'static str {
    r#"# 索引

## 人物

## 设定

## 参考资料

## 待解决问题

## 对比分析

## 综合总结

## 章节

## 大纲
"#
}

fn overview_markdown_content() -> &'static str {
    r#"---
type: overview
title: 项目概述
tags: []
related: []
---

# 概述

<!-- 提供小说项目的高层摘要，包括核心设定、主要人物和当前进度。定期更新。 -->
"#
}

fn schema_stub_content() -> &'static str {
    r#"# 小说项目 Schema

## 页面类型

| 类型 | 目录 | 用途 |
|------|------|------|
| chapter | QM/chapters/ | 章节正文 |
| outline | QM/outlines/ | 大纲（总纲/分卷/章节） |
| entity | QM/entities/ | 人物、地点、组织、物品 |
| concept | QM/concepts/ | 设定、能力体系、世界观规则 |
| source | QM/sources/ | 参考资料 |
| overview | QM/ | 概述页面 |

## Frontmatter

所有页面必须包含 YAML frontmatter：

```yaml
---
type: chapter | outline | entity | concept | source | overview
title: 标题
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

章节页面额外包含：
```yaml
chapter_number: 1
chapter_status: draft | writing | review | done
outline_type: master-outline | volume-outline | chapter-outline
```
"#
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 每次测试独占的临时项目根（OS tmpdir 不自动清理，测试内自清）。
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("niko-migrate-{tag}-{nanos}"));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// 建目录并放一个标记文件，便于断言「搬的是同一份内容」。
        fn seed(&self, name: &str, marker: &str) {
            let dir = self.0.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("marker.txt"), marker).unwrap();
        }

        fn has(&self, name: &str) -> bool {
            self.0.join(name).exists()
        }

        fn marker(&self, name: &str) -> String {
            fs::read_to_string(self.0.join(name).join("marker.txt")).unwrap()
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn migrates_all_three_legacy_dirs() {
        let root = TempRoot::new("all");
        root.seed(LEGACY_META_DIR, "meta");
        root.seed(LEGACY_KNOWLEDGE_DIR, "knowledge");

        migrate_project_dirs(root.path()).unwrap();

        assert!(root.has(META_DIR), "旧元数据目录应迁移为 .niko-buddy");
        assert!(!root.has(LEGACY_META_DIR), "旧元数据目录不应残留");
        assert!(root.has(KNOWLEDGE_DIR), "wiki 应迁移为 QM");
        assert!(!root.has(LEGACY_KNOWLEDGE_DIR), "wiki 不应残留");
        assert_eq!(root.marker(META_DIR), "meta", "迁移应保留内容");
        assert_eq!(root.marker(KNOWLEDGE_DIR), "knowledge", "迁移应保留内容");
    }

    #[test]
    fn noop_when_nothing_to_migrate() {
        let root = TempRoot::new("empty");
        // 空根：三步全部跳过，仍返回 Ok（幂等基线）。
        migrate_project_dirs(root.path()).unwrap();
        assert!(!root.has(META_DIR));
        assert!(!root.has(KNOWLEDGE_DIR));
    }

    #[test]
    fn never_overwrites_existing_target() {
        let root = TempRoot::new("conflict");
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");
        root.seed(KNOWLEDGE_DIR, "current-knowledge");
        root.seed(LEGACY_KNOWLEDGE_DIR, "legacy-knowledge");

        migrate_project_dirs(root.path()).unwrap();

        // G4（以新目录为准）：新目录版本原样保留，旧侧同名冲突文件不删除、
        // 而是备份到 legacy-conflicts/<旧目录名>/ 下。
        assert_eq!(root.marker(META_DIR), "current", "不得覆盖既有新目录");
        assert_eq!(root.marker(KNOWLEDGE_DIR), "current-knowledge");
        assert_eq!(
            fs::read_to_string(root.path().join(LEGACY_CONFLICTS_DIR).join(LEGACY_META_DIR).join("marker.txt"))
                .unwrap(),
            "legacy",
            "同名冲突的旧副本应备份到 legacy-conflicts，不丢数据"
        );
        assert_eq!(
            fs::read_to_string(root.path().join(LEGACY_CONFLICTS_DIR).join(LEGACY_KNOWLEDGE_DIR).join("marker.txt"))
                .unwrap(),
            "legacy-knowledge"
        );
        assert!(!root.has(LEGACY_META_DIR), "合并后旧目录空壳应被清掉");
        assert!(!root.has(LEGACY_KNOWLEDGE_DIR));
    }

    #[test]
    fn is_idempotent_across_repeated_runs() {
        let root = TempRoot::new("idem");
        root.seed(LEGACY_META_DIR, "meta");
        root.seed(LEGACY_KNOWLEDGE_DIR, "knowledge");

        migrate_project_dirs(root.path()).unwrap();
        // 第二次：源已不存在，全部跳过，仍 Ok。
        migrate_project_dirs(root.path()).unwrap();
        migrate_project_dirs(root.path()).unwrap();

        assert_eq!(root.marker(META_DIR), "meta");
        assert_eq!(root.marker(KNOWLEDGE_DIR), "knowledge");
    }

    #[test]
    fn first_legacy_meta_name_wins_when_both_present() {
        let root = TempRoot::new("twogen");
        root.seed(LEGACY_META_DIR, "llm-wiki");
        root.seed(LEGACY_QMAI_DIR, "qmai");

        migrate_project_dirs(root.path()).unwrap();

        // 顺序即优先级：.llm-wiki 先迁到 .niko-buddy；.qmai 随后与之并存，
        // 按 G4「以新目录为准」合并——同名冲突的 .qmai 副本进备份，新目录不被覆盖。
        assert_eq!(root.marker(META_DIR), "llm-wiki", "先到先得");
        assert!(!root.has(LEGACY_QMAI_DIR), "合并后旧目录空壳应被清掉");
        assert_eq!(
            fs::read_to_string(root.path().join(LEGACY_CONFLICTS_DIR).join(LEGACY_QMAI_DIR).join("marker.txt"))
                .unwrap(),
            "qmai",
            "后到旧目录的冲突文件应备份而非丢弃"
        );
    }

    #[test]
    fn qmai_dir_migrates_when_llm_wiki_absent() {
        let root = TempRoot::new("qmai");
        root.seed(LEGACY_QMAI_DIR, "qmai");

        migrate_project_dirs(root.path()).unwrap();

        assert_eq!(root.marker(META_DIR), "qmai");
        assert!(!root.has(LEGACY_QMAI_DIR));
    }

    /// 目标路径被同名文件占用时走跳过分支（exists() 为真），不报错、不覆盖。
    ///
    /// 未覆盖分支：fs::rename 真正失败时的中文错误串。构造该失败需要跨盘/独占句柄
    /// 等环境相关条件，跨平台不稳定，故不伪造；错误串格式由 rename_dir_if_safe
    /// 的 map_err 单点保证。
    #[test]
    fn skips_when_target_path_is_occupied_by_a_file() {
        let root = TempRoot::new("occupied");
        root.seed(LEGACY_KNOWLEDGE_DIR, "k");
        // 目标位置放一个同名文件：exists() 为真 → 走跳过分支，不报错。
        fs::write(root.path().join(KNOWLEDGE_DIR), b"blocker").unwrap();
        migrate_project_dirs(root.path()).unwrap();
        assert!(root.has(LEGACY_KNOWLEDGE_DIR), "目标被占用时应跳过而非报错");
    }

    // ── G2 迁移报告 ────────────────────────────────────────────────────

    #[test]
    fn report_lists_migrated_and_skipped_steps() {
        let root = TempRoot::new("report");
        root.seed(LEGACY_META_DIR, "meta");
        root.seed(LEGACY_KNOWLEDGE_DIR, "knowledge");

        let report = migrate_project_dirs(root.path()).unwrap();

        // 三步顺序固定：.llm-wiki→.niko-buddy / .qmai→.niko-buddy / wiki→QM。
        assert_eq!(report.steps.len(), 3);
        assert_eq!(report.steps[0].action, MigrationAction::Migrated);
        // .qmai 不存在 → 源缺失跳过。
        assert_eq!(report.steps[1].action, MigrationAction::SkippedSourceMissing);
        assert_eq!(report.steps[2].action, MigrationAction::Migrated);
        assert_eq!(report.migrated().len(), 2);
        assert_eq!(report.skipped().len(), 1);
        assert!(!report.is_noop());
    }

    #[test]
    fn report_marks_coexisting_dirs_as_merged() {
        let root = TempRoot::new("report-conflict");
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");

        let report = migrate_project_dirs(root.path()).unwrap();

        // G4：两侧目录并存 → 逐文件合并（不是跳过）。
        assert_eq!(report.steps[0].action, MigrationAction::Merged);
        assert_eq!(report.merged().len(), 1);
        assert_eq!(report.migrated().len(), 0);
        assert!(!report.is_noop(), "发生合并就不算空跑");
        assert_eq!(root.marker(META_DIR), "current", "新目录版本不被覆盖");
    }

    #[test]
    fn dry_run_predicts_without_touching_fs() {
        let root = TempRoot::new("dryrun");
        root.seed(LEGACY_QMAI_DIR, "qmai");

        let predicted = migrate_project_dirs_dry_run(root.path());
        // dry-run 不搬任何东西。
        assert!(root.has(LEGACY_QMAI_DIR), "dry-run 不得改动文件系统");
        assert!(!root.has(META_DIR));
        // 预测：.llm-wiki 缺失跳过，.qmai 将迁移，wiki 缺失跳过。
        assert_eq!(predicted.steps[0].action, MigrationAction::SkippedSourceMissing);
        assert_eq!(predicted.steps[1].action, MigrationAction::Migrated);
        assert_eq!(predicted.steps[2].action, MigrationAction::SkippedSourceMissing);
        // 实跑结论应与预测一致。
        let actual = migrate_project_dirs(root.path()).unwrap();
        assert_eq!(actual, predicted);
    }

    // ── G3 回滚（可逆）───────────────────────────────────────────────

    #[test]
    fn rollback_restores_completed_renames_in_reverse_order() {
        let root = TempRoot::new("rollback");
        // 模拟「前两步已迁移完成」：旧名消失、新名就位。
        root.seed(META_DIR, "meta-moved");
        root.seed(KNOWLEDGE_DIR, "knowledge-moved");
        let completed: Vec<(&'static str, &'static str)> =
            vec![(LEGACY_META_DIR, META_DIR), (LEGACY_KNOWLEDGE_DIR, KNOWLEDGE_DIR)];

        let rolled_back = rollback_renames(root.path(), &completed);

        assert_eq!(rolled_back, 2, "两步均应撤回");
        assert!(root.has(LEGACY_META_DIR), "旧 meta 目录应恢复");
        assert!(root.has(LEGACY_KNOWLEDGE_DIR), "旧 knowledge 目录应恢复");
        assert!(!root.has(META_DIR), "新 meta 目录应消失");
        assert!(!root.has(KNOWLEDGE_DIR), "新 knowledge 目录应消失");
        // 内容随目录一起回滚（搬的是同一份）。
        assert_eq!(root.marker(LEGACY_META_DIR), "meta-moved");
        assert_eq!(root.marker(LEGACY_KNOWLEDGE_DIR), "knowledge-moved");
    }

    #[test]
    fn rollback_never_overwrites_a_recreated_legacy_dir() {
        let root = TempRoot::new("rollback-conflict");
        // 回滚期间外部又建了同名旧目录 → 不得覆盖，该步计为未撤回。
        root.seed(META_DIR, "moved");
        root.seed(LEGACY_META_DIR, "recreated");
        let completed: Vec<(&'static str, &'static str)> = vec![(LEGACY_META_DIR, META_DIR)];

        let rolled_back = rollback_renames(root.path(), &completed);

        assert_eq!(rolled_back, 0, "目标旧名已存在时不得覆盖");
        assert_eq!(root.marker(LEGACY_META_DIR), "recreated", "外部新建内容应保留");
        assert_eq!(root.marker(META_DIR), "moved", "已迁移目录应原地不动");
    }

    #[test]
    fn rollback_is_noop_when_nothing_completed() {
        let root = TempRoot::new("rollback-empty");
        assert_eq!(rollback_renames(root.path(), &[]), 0);
    }

    // ── F1 老书 fixture：真实旧版目录布局端到端演练 ────────────────────

    /// 旧版老书真实布局：`.llm-wiki/`（元数据）+ `wiki/`（知识库）+ 正文与素材。
    /// 迁移后应变成 `.niko-buddy/` + `QM/`，且正文/素材原封不动。
    #[test]
    fn legacy_book_fixture_migrates_to_current_layout() {
        let root = TempRoot::new("legacy-book");
        root.seed(LEGACY_META_DIR, "legacy-meta");
        root.seed(LEGACY_KNOWLEDGE_DIR, "legacy-knowledge");
        // 老书正文与素材：迁移不得触碰。
        root.seed("raw/sources", "source");
        root.seed("exports", "export");
        fs::write(root.path().join("complete-novel.md"), "# 老书正文\n").unwrap();

        let report = migrate_project_dirs(root.path()).unwrap();

        // 结构：旧名消失、新名就位。
        assert!(!root.has(LEGACY_META_DIR), "旧 meta 目录应已迁走");
        assert!(!root.has(LEGACY_KNOWLEDGE_DIR), "旧 knowledge 目录应已迁走");
        assert!(root.has(META_DIR), "应出现 .niko-buddy");
        assert!(root.has(KNOWLEDGE_DIR), "应出现 QM");
        // 内容：搬的是同一份。
        assert_eq!(root.marker(META_DIR), "legacy-meta");
        assert_eq!(root.marker(KNOWLEDGE_DIR), "legacy-knowledge");
        // 正文与素材原封不动。
        assert_eq!(root.marker("raw/sources"), "source");
        assert_eq!(root.marker("exports"), "export");
        assert_eq!(
            fs::read_to_string(root.path().join("complete-novel.md")).unwrap(),
            "# 老书正文\n"
        );
        // 报告：两步实际迁移。
        assert_eq!(report.migrated().len(), 2);
        assert!(!report.is_noop());
    }

    /// 老书演练可重复：迁移完再跑一次应零动作（幂等，不会把 QM 再搬一次）。
    #[test]
    fn legacy_book_fixture_migration_is_repeatable() {
        let root = TempRoot::new("legacy-book-repeat");
        root.seed(LEGACY_META_DIR, "m");
        root.seed(LEGACY_KNOWLEDGE_DIR, "k");

        migrate_project_dirs(root.path()).unwrap();
        let second = migrate_project_dirs(root.path()).unwrap();

        assert!(second.is_noop(), "第二次应零动作");
        assert_eq!(root.marker(META_DIR), "m");
        assert_eq!(root.marker(KNOWLEDGE_DIR), "k");
    }

    /// G4：新旧目录并存时只读产出逐文件冲突报告（仅旧侧 / 同名一致 / 同名冲突），不改动任何文件。
    #[test]
    fn conflicts_report_classifies_files_without_touching_fs() {
        let root = TempRoot::new("g4-classify");
        // 新旧元数据目录并存：marker.txt 内容不同 → 冲突。
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");
        let legacy = root.path().join(LEGACY_META_DIR);
        let current = root.path().join(META_DIR);
        // 同名且字节一致 → identical。
        fs::write(legacy.join("same.json"), "{}").unwrap();
        fs::write(current.join("same.json"), "{}").unwrap();
        // 仅旧侧存在（含嵌套子目录）→ only_in_legacy，相对路径用 / 分隔。
        fs::create_dir_all(legacy.join("sub")).unwrap();
        fs::write(legacy.join("sub").join("old.md"), "old").unwrap();
        // 仅新侧存在的文件不应出现在报告中。
        fs::write(current.join("new-only.md"), "new").unwrap();

        let reports = migrate_project_dirs_conflicts(root.path()).unwrap();
        let meta = reports
            .iter()
            .find(|r| r.from == LEGACY_META_DIR)
            .expect("新旧元数据目录并存时应产出冲突报告");

        assert_eq!(meta.to, META_DIR);
        assert_eq!(meta.only_in_legacy, vec!["sub/old.md".to_string()]);
        assert_eq!(meta.identical, vec!["same.json".to_string()]);
        assert_eq!(meta.conflicting, vec!["marker.txt".to_string()]);
        assert!(meta.has_conflicts());

        // 只读：两侧内容原样保留，旧目录不被搬走或删除。
        assert_eq!(root.marker(META_DIR), "current");
        assert_eq!(root.marker(LEGACY_META_DIR), "legacy");
        assert!(legacy.join("sub").join("old.md").exists());
        assert!(!current.join("sub").exists(), "报告阶段不得搬入任何文件");
    }

    /// G4：无并存目录（空根或可直接 rename）时不产出冲突条目。
    #[test]
    fn conflicts_report_empty_when_no_coexisting_dirs() {
        let empty = TempRoot::new("g4-empty");
        assert!(migrate_project_dirs_conflicts(empty.path()).unwrap().is_empty());

        let renamable = TempRoot::new("g4-renamable");
        renamable.seed(LEGACY_KNOWLEDGE_DIR, "k");
        assert!(migrate_project_dirs_conflicts(renamable.path()).unwrap().is_empty());
        assert!(renamable.has(LEGACY_KNOWLEDGE_DIR), "报告阶段不得执行 rename");
    }

    /// G4：全部同名文件一致时无需规则裁决（has_conflicts=false）。
    #[test]
    fn conflicts_report_identical_only_has_no_conflicts() {
        let root = TempRoot::new("g4-identical");
        root.seed(KNOWLEDGE_DIR, "same");
        root.seed(LEGACY_KNOWLEDGE_DIR, "same");

        let reports = migrate_project_dirs_conflicts(root.path()).unwrap();
        let knowledge = reports
            .iter()
            .find(|r| r.from == LEGACY_KNOWLEDGE_DIR)
            .expect("新旧知识目录并存时应产出报告");
        assert_eq!(knowledge.identical, vec!["marker.txt".to_string()]);
        assert!(knowledge.only_in_legacy.is_empty());
        assert!(!knowledge.has_conflicts());
    }

    /// G4：目标位置被同名文件占位时整对记为冲突（"."），不报错。
    #[test]
    fn conflicts_report_marks_file_placeholder_as_whole_conflict() {
        let root = TempRoot::new("g4-placeholder");
        root.seed(LEGACY_KNOWLEDGE_DIR, "k");
        fs::write(root.path().join(KNOWLEDGE_DIR), "placeholder").unwrap();

        let reports = migrate_project_dirs_conflicts(root.path()).unwrap();
        let knowledge = reports
            .iter()
            .find(|r| r.from == LEGACY_KNOWLEDGE_DIR)
            .expect("占位文件场景应产出报告");
        assert_eq!(knowledge.conflicting, vec![".".to_string()]);
        assert!(knowledge.has_conflicts());
    }

    // ── G4 合并实跑（产品决策：以新目录为准）───────────────────────────

    /// G4 三条逐文件规则同时生效：仅旧侧搬入、同名一致丢旧副本、同名冲突备份。
    #[test]
    fn merge_moves_unique_files_drops_identical_and_backs_up_conflicts() {
        let root = TempRoot::new("g4-merge");
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");
        let legacy = root.path().join(LEGACY_META_DIR);
        let current = root.path().join(META_DIR);
        // 仅旧侧（含嵌套）→ 搬入。
        fs::create_dir_all(legacy.join("sub")).unwrap();
        fs::write(legacy.join("sub").join("old.md"), "old").unwrap();
        // 同名一致 → 丢旧副本。
        fs::write(legacy.join("same.json"), "{}").unwrap();
        fs::write(current.join("same.json"), "{}").unwrap();
        // 同名冲突 → 备份。
        fs::write(legacy.join("diff.json"), "legacy-version").unwrap();
        fs::write(current.join("diff.json"), "current-version").unwrap();

        let report = migrate_project_dirs(root.path()).unwrap();

        assert_eq!(report.steps[0].action, MigrationAction::Merged);
        // 仅旧侧文件已搬入新目录（父目录自动建）。
        assert_eq!(fs::read_to_string(current.join("sub").join("old.md")).unwrap(), "old");
        // 同名冲突：新目录版本胜出，旧版本备份在 legacy-conflicts/<旧目录名>/ 下。
        assert_eq!(fs::read_to_string(current.join("diff.json")).unwrap(), "current-version");
        assert_eq!(
            fs::read_to_string(root.path().join(LEGACY_CONFLICTS_DIR).join(LEGACY_META_DIR).join("diff.json"))
                .unwrap(),
            "legacy-version"
        );
        // 同名一致：旧副本已丢弃（内容仍在新目录）。
        assert!(!legacy.join("same.json").exists());
        assert_eq!(fs::read_to_string(current.join("same.json")).unwrap(), "{}");
        // 合并后旧目录空壳被清掉。
        assert!(!root.has(LEGACY_META_DIR));
    }

    /// G4：新侧独有的文件不得被碰，且合并可重跑（第二次已无旧目录 → 零动作）。
    #[test]
    fn merge_keeps_target_only_files_and_is_idempotent() {
        let root = TempRoot::new("g4-idem");
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");
        let current = root.path().join(META_DIR);
        fs::write(current.join("new-only.md"), "new").unwrap();

        migrate_project_dirs(root.path()).unwrap();
        let second = migrate_project_dirs(root.path()).unwrap();

        assert_eq!(fs::read_to_string(current.join("new-only.md")).unwrap(), "new");
        assert!(second.is_noop(), "第二次应零动作");
        assert_eq!(root.marker(META_DIR), "current");
    }

    /// G4 回滚：合并失败时搬入/备份的文件逆序撤回旧目录。
    #[test]
    fn rollback_merges_restores_moved_in_and_backed_up_files() {
        let root = TempRoot::new("g4-rollback");
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");
        let legacy = root.path().join(LEGACY_META_DIR);
        let current = root.path().join(META_DIR);
        fs::create_dir_all(legacy.join("sub")).unwrap();
        fs::write(legacy.join("sub").join("old.md"), "old").unwrap();
        fs::write(legacy.join("diff.json"), "legacy-version").unwrap();
        fs::write(current.join("diff.json"), "current-version").unwrap();

        let mut record = MergeRecord::default();
        merge_legacy_into_target(root.path(), LEGACY_META_DIR, META_DIR, &mut record).unwrap();
        assert!(!legacy.join("sub").join("old.md").exists(), "合并后旧侧文件应已搬走");

        let rolled_back = rollback_merges(&[record]);

        // 搬入 1 个（sub/old.md）+ 备份 2 个（marker.txt、diff.json）均应撤回。
        assert_eq!(rolled_back, 3);
        assert_eq!(fs::read_to_string(legacy.join("sub").join("old.md")).unwrap(), "old");
        assert_eq!(fs::read_to_string(legacy.join("diff.json")).unwrap(), "legacy-version");
        assert_eq!(root.marker(LEGACY_META_DIR), "legacy");
        assert!(!current.join("sub").join("old.md").exists(), "回滚后新目录不得残留搬入文件");
        assert_eq!(fs::read_to_string(current.join("diff.json")).unwrap(), "current-version", "新目录版本不受影响");
    }
}
