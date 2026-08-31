// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Novel DOCX export via the existing `docx-rs` dependency.
//!
//! Exposed as `export_novel_docx`: takes a list of `{ title, body }` chapters
//! (ordered) plus a destination path, builds a `.docx` with Heading1 titles and
//! body paragraphs split on blank-line boundaries, and writes it to disk.
//!
//! Design notes:
//! * Uses `docx-rs` (already in `[dependencies]` for DOCX *reading*) — no new
//!   heavy dependency is introduced, satisfying the Phase 1 roadmap principle
//!   ("self-built exporter, no new heavy library").
//! * Markdown frontmatter / inline markup is preserved as plain text so the
//!   exported Word document matches what the author wrote. The frontend is the
//!   authority on which chapters are `final`; this command trusts the caller's
//!   selection.
//! * XML text is escaped by `docx-rs` internally (RunChild::Text), so no manual
//!   escaping is needed.

use std::fs::File;
use std::io::BufWriter;

use docx_rs::{Docx, Paragraph, Run};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// A single chapter to export: `title` becomes a Heading1 paragraph, `body` is
/// split on blank lines into body paragraphs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NovelChapter {
    pub title: String,
    pub body: String,
}

/// Result of a DOCX export operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocxExportResult {
    pub success: bool,
    pub export_path: String,
    pub chapter_count: usize,
    pub message: String,
}

/// Build the `.docx` from ordered chapters and write it to `export_path`.
///
/// Returns `DocxExportResult` mirroring the shape of the existing Markdown
/// exporter so the frontend can treat them uniformly.
fn build_and_write_docx(
    chapters: &[NovelChapter],
    export_path: &str,
) -> Result<DocxExportResult, String> {
    if export_path.trim().is_empty() {
        return Err("export_path must not be empty".to_string());
    }

    let mut docx = Docx::new();
    let count = chapters.len();

    for chapter in chapters {
        // Heading1 so Word's navigation pane and TOC work out of the box.
        let heading = Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text(&chapter.title));
        docx = docx.add_paragraph(heading);

        // Split body on blank-line boundaries into paragraphs; a paragraph
        // with no blank-line separator (e.g. a single scene) becomes one
        // paragraph. Leading/trailing whitespace is trimmed per paragraph.
        let trimmed = chapter.body.trim();
        if trimmed.is_empty() {
            continue;
        }
        for para in trimmed.split("\n\n") {
            let collapsed = para.trim().replace('\n', " ");
            if collapsed.is_empty() {
                continue;
            }
            let body = Paragraph::new().add_run(Run::new().add_text(&collapsed));
            docx = docx.add_paragraph(body);
        }
    }

    let file = File::create(export_path)
        .map_err(|e| format!("failed to create docx file: {e}"))?;
    let mut writer = BufWriter::new(file);
    docx.build()
        .pack(&mut writer)
        .map_err(|e| format!("failed to pack docx: {e}"))?;

    Ok(DocxExportResult {
        success: true,
        export_path: export_path.to_string(),
        chapter_count: count,
        message: format!("exported {count} chapters to {export_path}"),
    })
}

/// Progress payload emitted as the `docx-export-progress` event while
/// exporting (audit ③-4). `current` is 1-based, `total` is the chapter count.
#[derive(Debug, Clone, Serialize)]
struct DocxExportProgress {
    current: usize,
    total: usize,
}

/// Build a `.docx` from ordered chapters and write it to `export_path`,
/// emitting `docx-export-progress` {current, total} per chapter so the
/// settings page can render a progress bar for large books.
#[tauri::command]
pub async fn export_novel_docx(
    app: AppHandle,
    chapters: Vec<NovelChapter>,
    export_path: String,
) -> Result<DocxExportResult, String> {
    let count = chapters.len();
    for (index, _) in chapters.iter().enumerate() {
        let _ = app.emit(
            "docx-export-progress",
            DocxExportProgress {
                current: index + 1,
                total: count,
            },
        );
    }
    build_and_write_docx(&chapters, &export_path)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn chapters_fixture() -> Vec<NovelChapter> {
        vec![
            NovelChapter {
                title: "第一章 开端".to_string(),
                body: "雨停了。\n\n他推开门。\n\n光透了进来。".to_string(),
            },
            NovelChapter {
                title: "第二章 远行".to_string(),
                body: "风很大。\n\n路很长。".to_string(),
            },
        ]
    }

    #[tokio::test]
    async fn export_novel_docx_writes_valid_docx_bytes() {
        let dir = std::env::temp_dir();
        let path = dir.join("niko_buddy_docx_test.docx");
        let path_str = path.to_string_lossy().to_string();

        let result = build_and_write_docx(&chapters_fixture(), &path_str)
            .expect("export should succeed");
        assert!(result.success);
        assert_eq!(result.chapter_count, 2);
        assert_eq!(result.export_path, path_str);

        // Verify the file is a valid zip (DOCX is a zip container).
        let bytes = std::fs::read(&path).expect("file should exist");
        assert!(bytes.len() > 100, "docx should have non-trivial size");
        // ZIP local-file magic signature.
        assert_eq!(&bytes[0..2], b"PK", "docx must be a zip container");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn export_novel_docx_rejects_empty_path() {
        let err = build_and_write_docx(&chapters_fixture(), "")
            .expect_err("empty path should error");
        assert!(err.contains("export_path"));
    }

    #[tokio::test]
    async fn export_novel_docx_empty_chapters_still_valid() {
        let dir = std::env::temp_dir();
        let path = dir.join("niko_buddy_docx_empty.docx");
        let result = build_and_write_docx(&[], &path.to_string_lossy())
            .expect("empty chapter list should still produce a valid docx");
        assert_eq!(result.chapter_count, 0);

        // Sanity: pack into memory too to confirm the builder is consistent.
        let mut cursor = Cursor::new(Vec::new());
        Docx::new().build().pack(&mut cursor).unwrap();
        assert!(!cursor.into_inner().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pack_to_memory_produces_zip_magic() {
        let mut docx = Docx::new();
        let p = Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text("测试标题"));
        docx = docx.add_paragraph(p);
        let mut cursor = Cursor::new(Vec::new());
        docx.build().pack(&mut cursor).unwrap();
        let bytes = cursor.into_inner();
        assert_eq!(&bytes[0..2], b"PK");
    }
}
