// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Project management IPC commands.
//!
//! Handles project creation, opening, folder navigation, and legacy directory
//! migration for the QMAI / Niko Buddy desktop application.

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
const META_DIR: &str = ".qmai";
const LEGACY_META_DIR: &str = ".llm-wiki";

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
    run_guarded("open_project_folder", || open_project_folder_impl(&app, &path))
}

#[tauri::command]
pub async fn open_file_location(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("open_file_location", || open_file_location_impl(&app, &path))
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
        ".qmai",
        ".novel/snapshots",
    ];
    for subdir in subdirs {
        fs::create_dir_all(root.join(subdir))
            .map_err(|e| format!("创建目录 '{}' 失败：{}", subdir, e))?;
    }

    let today = Local::now().format("%Y-%m-%d").to_string();

    // schema.md — project page-type reference and frontmatter contract
    write_project_file(
        root.join("schema.md"),
        schema_markdown_content(),
    )?;

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

/// Confirm that `root` looks like a valid QMAI project directory.
/// If lightweight markers are missing they are auto-created for convenience.
pub fn validate_wiki_project_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Err(format!("路径不存在：'{}'", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("路径不是文件夹：'{}'", root.display()));
    }

    let has_schema = root.join("schema.md").exists();
    let has_wiki =
        root.join(KNOWLEDGE_DIR).is_dir() || root.join(LEGACY_KNOWLEDGE_DIR).is_dir();
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

/// Rename legacy directories to the current naming convention when safe.
pub fn migrate_project_dirs(root: &Path) -> Result<(), String> {
    rename_dir_if_safe(root, LEGACY_META_DIR, META_DIR)?;
    rename_dir_if_safe(root, LEGACY_KNOWLEDGE_DIR, KNOWLEDGE_DIR)?;
    Ok(())
}

/// Rename `root/from` to `root/to` only when `from` exists and `to` does not,
/// preventing accidental overwrites.
fn rename_dir_if_safe(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let source = root.join(from);
    let target = root.join(to);
    if !source.exists() || target.exists() {
        return Ok(()); // Nothing to do or target already present.
    }
    fs::rename(&source, &target).map_err(|e| {
        format!(
            "迁移目录 '{}' 到 '{}' 失败：{}",
            source.display(),
            target.display(),
            e
        )
    })
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
    ".qmai",
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
