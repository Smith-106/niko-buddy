// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Tauri IPC commands for reading files and listing directory contents.
//!
//! These commands give the frontend controlled access to the local filesystem
//! for wiki content loading and project tree navigation.

use std::fs;
use std::path::Path;

/// Read the entire UTF-8 content of a file at the given path.
///
/// # Errors
///
/// Returns `Err(String)` if the file cannot be opened or decoded.
#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path)
        .map_err(|e| format!("无法读取文件 {path}: {e}"))
}

/// List the names of regular files inside a directory (non-recursive).
///
/// * If the path does not exist, an empty `Vec` is returned.
/// * If the path exists but is not a directory, `Err` is returned.
///
/// Only immediate child files are included; sub-directories are skipped.
#[tauri::command]
pub fn list_directory_files(path: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Ok(Vec::new());
    }

    if !dir.is_dir() {
        return Err(format!("{path} 不是一个目录"));
    }

    let entries = fs::read_dir(dir)
        .map_err(|e| format!("无法读取目录 {path}: {e}"))?;

    let files: Vec<String> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_type = entry.file_type().ok()?;
            file_type.is_file().then(|| {
                entry.file_name().to_str().map(String::from)
            }).flatten()
        })
        .collect();

    Ok(files)
}
