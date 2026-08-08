// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Wiki-related data types exchanged via Tauri IPC.

use serde::{Deserialize, Serialize};

/// Represents a wiki project with a display name and filesystem path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiProject {
    pub name: String,
    pub path: String,
}

/// A node in the wiki file tree — either a regular file or a directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Child nodes (only present for directory nodes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}
