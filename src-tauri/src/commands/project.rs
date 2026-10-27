// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Project management IPC commands.
//!
//! Handles project creation, opening, folder navigation, and legacy directory
//! migration for the Niko Buddy / Niko Buddy desktop application.

use std::fs;
use std::path::Path;

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
    /// 源目录不存在，无事可做。
    SkippedSourceMissing,
    /// 目标已存在（新目录或同名文件占位），跳过以防覆盖；旧目录原样保留待人工处理。
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

    /// 被跳过的步骤（源缺失或目标已存在）。
    pub fn skipped(&self) -> Vec<&MigrationStep> {
        self.steps.iter().filter(|s| s.action != MigrationAction::Migrated).collect()
    }

    /// 是否空跑（无任何实际迁移）。
    pub fn is_noop(&self) -> bool {
        self.migrated().is_empty()
    }
}

/// Rename legacy directories to the current naming convention when safe.
///
/// 返回三步各自的迁移/跳过明细（G2）；调用方忽略返回值时语义与旧版完全一致。
pub fn migrate_project_dirs(root: &Path) -> Result<MigrationReport, String> {
    // 单一事实源：先由 dry-run 算出三步计划，再逐步执行 rename。
    // 这样 dry-run 与实跑共用同一份「哪三步、什么顺序」的定义，不会漂移。
    let planned = migrate_project_dirs_dry_run(root);
    let mut steps = Vec::with_capacity(planned.steps.len());
    for step in planned.steps {
        let action = rename_dir_if_safe(root, step.from, step.to)?;
        steps.push(MigrationStep { from: step.from, to: step.to, action });
    }
    let report = MigrationReport { steps };
    if !report.is_noop() {
        log::info!(
            "[migrate] 项目目录迁移：{} 步实际 rename，{} 步跳过",
            report.migrated().len(),
            report.skipped().len()
        );
    }
    Ok(report)
}

/// Dry-run：只计算三步各自会是什么动作，不触碰文件系统（G2）。
pub fn migrate_project_dirs_dry_run(root: &Path) -> MigrationReport {
    let steps = [(LEGACY_META_DIR, META_DIR), (LEGACY_QMAI_DIR, META_DIR), (LEGACY_KNOWLEDGE_DIR, KNOWLEDGE_DIR)]
        .into_iter()
        .map(|(from, to)| {
            let action = if !root.join(from).exists() {
                MigrationAction::SkippedSourceMissing
            } else if root.join(to).exists() {
                MigrationAction::SkippedTargetExists
            } else {
                // dry-run 下“可迁移”用 Migrated 表示“将会迁移”。
                MigrationAction::Migrated
            };
            MigrationStep { from, to, action }
        })
        .collect();
    MigrationReport { steps }
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

        // 目标已存在 → 跳过，保留新目录内容，旧目录原样留下（不合并、不删除）。
        assert_eq!(root.marker(META_DIR), "current", "不得覆盖既有新目录");
        assert_eq!(root.marker(KNOWLEDGE_DIR), "current-knowledge");
        assert!(root.has(LEGACY_META_DIR), "冲突时旧目录应保留待人工处理");
        assert!(root.has(LEGACY_KNOWLEDGE_DIR));
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

        // 顺序即优先级：.llm-wiki 先迁到 .niko-buddy，.qmai 因目标已存在而跳过。
        assert_eq!(root.marker(META_DIR), "llm-wiki", "先到先得");
        assert!(root.has(LEGACY_QMAI_DIR), "后到的旧目录应保留待人工处理");
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
    fn report_marks_conflicts_as_target_exists() {
        let root = TempRoot::new("report-conflict");
        root.seed(META_DIR, "current");
        root.seed(LEGACY_META_DIR, "legacy");

        let report = migrate_project_dirs(root.path()).unwrap();

        assert_eq!(report.steps[0].action, MigrationAction::SkippedTargetExists);
        assert!(root.has(LEGACY_META_DIR), "冲突时旧目录应保留");
        assert_eq!(report.migrated().len(), 0);
        assert!(report.is_noop());
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
}
