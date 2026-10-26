// Copyright (c) 2024 Niko-hub contributors. MIT License.
// SPDX-License-Identifier: MIT

//! Office / legacy-doc / EPUB 纯文本提取层——M14-1 自 `fs.rs` 增量剥离（S4 单轮收敛，file_sync_watch.rs 模式）。
//!
//! 收容：[`extract_office_text`]（OOXML 路由：xlsx/xls/ods→[`extract_spreadsheet`]、
//! docx→[`extract_docx_with_library`]、pptx→ZIP 解析、odt/odp→ODF 解析）、
//! 旧版 doc（[`extract_legacy_doc_text`]/[`read_legacy_doc_payload`]/
//! [`extract_legacy_doc_text_from_bytes`]/[`clean_legacy_doc_text`]/
//! [`legacy_doc_text_score`]）与 EPUB 全文（[`extract_epub_text`]，zip-bomb 防御
//! [`EXTRACT_MAX_ENTRIES`]/[`EXTRACT_MAX_TOTAL_SIZE`]）——全确定性、零 Tauri 入口。
//! ZIP/XML/HTML 底层助手仍在 `fs_archive`（双生零重复，只复用）；
//! `fs.rs` 经 `pub(crate) use` 回引，外部 import 面零变化。

use std::fs;
use std::io::Read as IoRead;

use calamine::{open_workbook_auto, Data, Reader};

use super::fs_archive::{
    decode_html_entities, epub_find_opf_path, epub_sorted_content_paths, epub_spine_order,
    extract_docx_markdown, extract_odf_text, extract_pptx_markdown, extract_xhtml_text,
    read_zip_file, resolve_opf_relative,
};

/// EPUB extraction safety limits (zip-bomb defense).
///  - `EXTRACT_MAX_ENTRIES`: hard cap on the number of archive entries.
///  - `EXTRACT_MAX_TOTAL_SIZE`: hard cap on the *sum of uncompressed* entry
///    sizes (a real ebook rarely exceeds a few MB; 512 MiB is very generous
///    for a legit title while still bounding decompression work).
pub(crate) const EXTRACT_MAX_ENTRIES: usize = 4096;
pub(crate) const EXTRACT_MAX_TOTAL_SIZE: u64 = 512 * 1024 * 1024;

/// Extract text from Office Open XML formats, converting to Markdown.
pub(crate) fn extract_office_text(path: &str, ext: &str) -> Result<String, String> {
    // Spreadsheets: use calamine (supports xlsx, xls, ods)
    if matches!(ext, "xlsx" | "xls" | "ods") {
        return extract_spreadsheet(path);
    }

    // DOCX: use docx-rs library for proper parsing
    if ext == "docx" {
        return extract_docx_with_library(path);
    }

    // PPTX and ODF: use ZIP-based parsing
    let file = fs::File::open(path).map_err(|e| format!("Failed to open '{}': {}", path, e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive '{}': {}", path, e))?;

    match ext {
        "pptx" => extract_pptx_markdown(&mut archive),
        "odt" | "odp" => extract_odf_text(&mut archive),
        _ => Ok("[Unsupported format]".to_string()),
    }
}

pub(crate) fn extract_legacy_doc_text(path: &str) -> Result<String, String> {
    let bytes = read_legacy_doc_payload(path)?;
    extract_legacy_doc_text_from_bytes(&bytes)
        .map_err(|e| format!("旧版 .doc 文本提取失败 '{}': {}", path, e))
}

pub(crate) fn read_legacy_doc_payload(path: &str) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();

    if let Ok(mut compound) = cfb::open(path) {
        for stream_name in ["WordDocument", "0Table", "1Table"] {
            if let Ok(mut stream) = compound.open_stream(stream_name) {
                let mut bytes = Vec::new();
                stream
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("Failed to read .doc stream '{}': {}", stream_name, e))?;
                payload.extend_from_slice(&bytes);
                payload.push(b'\n');
            }
        }
        if !payload.is_empty() {
            return Ok(payload);
        }
    }

    fs::read(path).map_err(|e| format!("Failed to read legacy .doc '{}': {}", path, e))
}

pub(crate) fn extract_legacy_doc_text_from_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("文件内容为空".to_string());
    }

    let utf16_le_units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let utf16_be_units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
        .collect();
    let (gbk_text, _, _) = encoding_rs::GBK.decode(bytes);
    let utf8_text = String::from_utf8_lossy(bytes);

    let candidates = [
        String::from_utf16_lossy(&utf16_le_units),
        String::from_utf16_lossy(&utf16_be_units),
        gbk_text.into_owned(),
        utf8_text.into_owned(),
    ];

    let mut best = String::new();
    let mut best_score = 0usize;

    for candidate in candidates {
        let cleaned = clean_legacy_doc_text(&candidate);
        let score = legacy_doc_text_score(&cleaned);
        if score > best_score {
            best_score = score;
            best = cleaned;
        }
    }

    if best_score == 0 || best.trim().is_empty() {
        return Err("无法从旧版 .doc 中提取可读文本".to_string());
    }

    Ok(best)
}

pub(crate) fn clean_legacy_doc_text(input: &str) -> String {
    let mut normalized = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == '\r' {
            normalized.push('\n');
        } else if ch == '\n' || ch == '\t' {
            normalized.push(ch);
        } else if ch.is_control() || ch == '\0' {
            normalized.push(' ');
        } else {
            normalized.push(ch);
        }
    }

    let lines: Vec<String> = normalized
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();

    lines.join("\n")
}

pub(crate) fn legacy_doc_text_score(input: &str) -> usize {
    let total = input.chars().count();
    if total == 0 {
        return 0;
    }

    let readable = input
        .chars()
        .filter(|ch| {
            matches!(ch, '\n' | '\t')
                || ch.is_ascii_alphanumeric()
                || ('\u{4e00}'..='\u{9fff}').contains(ch)
                || "，。！？；：、“”‘’（）《》【】—…,.!?;:-_()[] ".contains(*ch)
        })
        .count();
    let replacement_penalty = input.chars().filter(|ch| *ch == '\u{fffd}').count() * 100;
    let keyword_bonus = ["第", "章", "主角", "正文", "目录", "卷"]
        .iter()
        .filter(|keyword| input.contains(**keyword))
        .count()
        * 50;
    let ratio_score = (readable * 1000) / total;
    ratio_score
        .saturating_add(readable * 4)
        .saturating_add(keyword_bonus)
        .saturating_sub(replacement_penalty)
}

/// Extract DOCX using docx-rs library for proper structural parsing.
pub(crate) fn extract_docx_with_library(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read DOCX '{}': {}", path, e))?;
    let docx = docx_rs::read_docx(&bytes)
        .map_err(|e| format!("Failed to parse DOCX '{}': {:?}", path, e))?;

    let mut result = String::new();

    for child in docx.document.children {
        match child {
            docx_rs::DocumentChild::Paragraph(para) => {
                let mut para_text = String::new();
                let mut is_heading = false;
                let mut heading_level: u8 = 1;

                // Check paragraph style for headings
                if let Some(style) = &para.property.style {
                    let style_val = &style.val;
                    if style_val.contains("Heading") || style_val.contains("heading") {
                        is_heading = true;
                        // Extract level number
                        for ch in style_val.chars() {
                            if ch.is_ascii_digit() {
                                heading_level = ch.to_digit(10).unwrap_or(1) as u8;
                                break;
                            }
                        }
                    }
                }

                // Check for list (numbering)
                let is_list = para.property.numbering_property.is_some();

                // Extract text from runs
                for child in &para.children {
                    if let docx_rs::ParagraphChild::Run(run) = child {
                        let is_bold = run.run_property.bold.is_some();
                        let is_italic = run.run_property.italic.is_some();

                        for run_child in &run.children {
                            if let docx_rs::RunChild::Text(text) = run_child {
                                let t = &text.text;
                                if is_bold && is_italic {
                                    para_text.push_str(&format!("***{}***", t));
                                } else if is_bold {
                                    para_text.push_str(&format!("**{}**", t));
                                } else if is_italic {
                                    para_text.push_str(&format!("*{}*", t));
                                } else {
                                    para_text.push_str(t);
                                }
                            }
                        }
                    }
                }

                let text = para_text.trim().to_string();
                if text.is_empty() {
                    continue;
                }

                if is_heading {
                    let prefix = "#".repeat(heading_level as usize);
                    result.push_str(&format!("{} {}\n\n", prefix, text));
                } else if is_list {
                    result.push_str(&format!("- {}\n", text));
                } else {
                    result.push_str(&text);
                    result.push_str("\n\n");
                }
            }
            docx_rs::DocumentChild::Table(table) => {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for row in &table.rows {
                    let docx_rs::TableChild::TableRow(tr) = row;
                    let mut cells: Vec<String> = Vec::new();
                    for cell in &tr.cells {
                        let docx_rs::TableRowChild::TableCell(tc) = cell;
                        let mut cell_text = String::new();
                        for child in &tc.children {
                            if let docx_rs::TableCellContent::Paragraph(para) = child {
                                for pchild in &para.children {
                                    if let docx_rs::ParagraphChild::Run(run) = pchild {
                                        for rc in &run.children {
                                            if let docx_rs::RunChild::Text(t) = rc {
                                                cell_text.push_str(&t.text);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        cells.push(cell_text.trim().replace('|', "\\|"));
                    }
                    rows.push(cells);
                }
                if !rows.is_empty() {
                    let max_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
                    for (i, row) in rows.iter().enumerate() {
                        let mut padded = row.clone();
                        padded.resize(max_cols, String::new());
                        result.push_str("| ");
                        result.push_str(&padded.join(" | "));
                        result.push_str(" |\n");
                        if i == 0 {
                            result.push('|');
                            for _ in 0..max_cols {
                                result.push_str(" --- |");
                            }
                            result.push('\n');
                        }
                    }
                    result.push('\n');
                }
            }
            _ => {}
        }
    }

    if result.trim().is_empty() {
        // Fallback to ZIP-based extraction
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        extract_docx_markdown(&mut archive)
    } else {
        Ok(result)
    }
}





/// Extract spreadsheet to Markdown using calamine (supports xlsx, xls, ods).
pub(crate) fn extract_spreadsheet(path: &str) -> Result<String, String> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|e| format!("Failed to open spreadsheet '{}': {}", path, e))?;

    let mut result = String::new();
    let sheet_names = workbook.sheet_names().to_vec();

    for sheet_name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(sheet_name) {
            if range.is_empty() {
                continue;
            }

            if sheet_names.len() > 1 {
                result.push_str(&format!("## {}\n\n", sheet_name));
            }

            let mut rows: Vec<Vec<String>> = Vec::new();
            let mut max_cols = 0;

            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|cell| match cell {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => {
                            if *f == (*f as i64) as f64 {
                                format!("{}", *f as i64)
                            } else {
                                format!("{:.2}", f)
                            }
                        }
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(dt) => format!("{}", dt),
                        Data::DateTimeIso(s) => s.clone(),
                        Data::DurationIso(s) => s.clone(),
                        Data::Error(e) => format!("ERR:{:?}", e),
                    })
                    .collect();
                if cells.len() > max_cols {
                    max_cols = cells.len();
                }
                rows.push(cells);
            }

            // Skip empty sheets
            if rows.is_empty() || max_cols == 0 {
                continue;
            }

            for (i, row) in rows.iter().enumerate() {
                let mut padded = row.clone();
                padded.resize(max_cols, String::new());
                // Escape pipe characters in cell values
                let escaped: Vec<String> = padded.iter().map(|c| c.replace('|', "\\|")).collect();
                result.push_str("| ");
                result.push_str(&escaped.join(" | "));
                result.push_str(" |\n");

                if i == 0 {
                    result.push('|');
                    for _ in 0..max_cols {
                        result.push_str(" --- |");
                    }
                    result.push('\n');
                }
            }
            result.push('\n');
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract data from spreadsheet]".to_string())
    } else {
        Ok(result)
    }
}


// HTML extraction helpers (`extract_html_file` / `strip_html_script_style`)
// now live in `fs_archive.rs` (re-exported above for path compatibility).


// ── EPUB extraction ──────────────────────────────────────────────────────
//
// EPUB files are ZIP archives. We locate the content OPF via
// `META-INF/container.xml`, read the `<spine>` (ordered list of content
// documents) through the `<manifest>` id→href map, then strip tags from
// each XHTML document in spine order, preserving paragraph breaks and
// decoding basic HTML/XML entities. If the package structure is absent or
// malformed we fall back to reading every `.xhtml`/`.html` entry sorted by
// name. Zip-bomb safety is enforced up front (entry count + sum of
// uncompressed sizes) before any decompression is allowed.

/// Extract the full plain-text body of an EPUB.
pub(crate) fn extract_epub_text(path: &str) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open EPUB '{path}': {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read EPUB (ZIP) '{path}': {e}"))?;

    // Zip-bomb defense BEFORE touching any entry body.
    let entry_count = archive.len();
    if entry_count > EXTRACT_MAX_ENTRIES {
        return Err(format!(
            "EPUB '{path}' rejected: {entry_count} entries exceeds limit {EXTRACT_MAX_ENTRIES}"
        ));
    }
    let mut total_uncompressed: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read EPUB entry #{i}: {e}"))?;
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
    }
    if total_uncompressed > EXTRACT_MAX_TOTAL_SIZE {
        return Err(format!(
            "EPUB '{path}' rejected: uncompressed size {total_uncompressed} bytes exceeds {EXTRACT_MAX_TOTAL_SIZE}"
        ));
    }

    // Locate the OPF via META-INF/container.xml.
    let container_xml = read_zip_file(&mut archive, "META-INF/container.xml")
        .ok_or_else(|| format!("EPUB '{path}': missing META-INF/container.xml"))?;
    let opf_path = epub_find_opf_path(&container_xml)
        .ok_or_else(|| format!("EPUB '{path}': container.xml has no rootfile full-path"))?;
    let opf_xml = read_zip_file(&mut archive, &opf_path)
        .ok_or_else(|| format!("EPUB '{path}': OPF '{opf_path}' not found"))?;

    // Spine-ordered content documents (resolved against the OPF directory).
    let spine = epub_spine_order(&opf_xml);
    let doc_paths: Vec<String> = if spine.is_empty() {
        epub_sorted_content_paths(&mut archive)
    } else {
        spine
            .iter()
            .map(|(_, href)| resolve_opf_relative(&opf_path, href))
            .collect()
    };

    let mut result = String::new();
    for doc in &doc_paths {
        if let Some(content) = read_zip_file(&mut archive, doc) {
            let text = decode_html_entities(&extract_xhtml_text(&content));
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                result.push_str(trimmed);
                result.push_str("\n\n");
            }
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract text from EPUB]".to_string())
    } else {
        Ok(result)
    }
}
