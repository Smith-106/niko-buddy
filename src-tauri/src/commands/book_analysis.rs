// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Tauri IPC commands for book analysis workflows.
//!
//! Provides commands to start, monitor, pause, resume and cancel
//! long-running book analysis tasks (junli / chuanban / both modes).

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

// ── Data types ─────────────────────────────────────────────────────────────

/// Configuration payload sent by the frontend when launching an analysis job.
///
/// * `mode`        — analysis mode: `"junli"`, `"chuanban"` or `"both"`
/// * `source_type` — input origin: `"file"` or `"url"`
/// * `source_path` — local filesystem path (when `source_type == "file"`)
/// * `source_url`  — remote URL          (when `source_type == "url"`)
/// * `chunk_size`  — number of chapters per processing chunk  (default 8)
/// * `summary_group_size` — chapters per summary group        (default 3)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookAnalysisConfig {
    pub mode: String,
    pub source_type: String,
    pub source_path: Option<String>,
    pub source_url: Option<String>,
    #[serde(default)]
    pub chunk_size: usize,
    #[serde(default)]
    pub summary_group_size: usize,
}

impl Default for BookAnalysisConfig {
    fn default() -> Self {
        Self {
            mode: "both".to_string(),
            source_type: "file".to_string(),
            source_path: None,
            source_url: None,
            chunk_size: 8,
            summary_group_size: 3,
        }
    }
}

/// Metadata produced once the analysis pipeline has finished ingesting a book.
#[derive(Debug, Serialize, Deserialize)]
pub struct BookAnalysisMetadata {
    pub title: String,
    pub author: Option<String>,
    pub total_chapters: usize,
    pub total_words: usize,
    pub source_type: String,
    pub source_url: Option<String>,
    pub created_at: u64,
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Start a new book analysis job.
///
/// Validates the supplied [`BookAnalysisConfig`], then returns a unique
/// task ID that the frontend uses to poll progress or control the job.
///
/// # Errors
///
/// Returns `Err(String)` when:
/// * `source_type == "file"` but no path is provided or the file does not exist.
/// * `source_type == "url"`  but no URL is provided.
#[tauri::command]
pub async fn start_book_analysis(
    _app_handle: AppHandle,
    _project_path: String,
    config: BookAnalysisConfig,
) -> Result<String, String> {
    // Validate file-backed sources.
    if config.source_type == "file" {
        match &config.source_path {
            Some(path) if Path::new(path).exists() => {}
            Some(_) => return Err("文件不存在".to_string()),
            None => return Err("未指定文件路径".to_string()),
        }
    } else if config.source_type == "url" && config.source_url.is_none() {
        return Err("未指定URL".to_string());
    }

    // Build a millisecond-precision task identifier.
    let task_id = format!(
        "book-analysis-{}",
        chrono::Utc::now().timestamp_millis()
    );

    // TODO: Implement full pipeline
    //   1. Create book-analysis directory tree under the project root.
    //   2. Read local file or fetch remote URL content.
    //   3. Split the text into chapters.
    //   4. Spawn a background analysis worker.

    Ok(task_id)
}

/// Retrieve the current progress snapshot for a running analysis job.
///
/// Returns a JSON-encoded progress object (currently a stub `{}`).
#[tauri::command]
pub async fn get_book_analysis_progress(task_id: String) -> Result<String, String> {
    // TODO: Look up task_id in the in-memory state store.
    let _ = &task_id;
    Ok("{}".to_string())
}

/// Pause a running analysis job so it can be resumed later.
#[tauri::command]
pub async fn pause_book_analysis(task_id: String) -> Result<(), String> {
    // TODO: Signal the background worker to suspend at the next safe point.
    let _ = &task_id;
    Ok(())
}

/// Resume a previously paused analysis job.
#[tauri::command]
pub async fn resume_book_analysis(task_id: String) -> Result<(), String> {
    // TODO: Signal the background worker to continue processing.
    let _ = &task_id;
    Ok(())
}

/// Cancel an analysis job and clean up any temporary artefacts.
#[tauri::command]
pub async fn cancel_book_analysis(task_id: String) -> Result<(), String> {
    // TODO: Terminate the background worker and remove the task entry.
    let _ = &task_id;
    Ok(())
}
