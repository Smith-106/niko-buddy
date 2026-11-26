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
    read_zip_file_with_budget, resolve_opf_relative, MAX_ZIP_TEXT_ENTRY_BYTES,
};

/// Office / EPUB / legacy-doc 源文件体积硬上限（128 MiB），防止读取超大文件导致 OOM。
pub(crate) const MAX_OFFICE_FILE_BYTES: u64 = 128 * 1024 * 1024;

/// EPUB / Office ZIP extraction safety limits (zip-bomb defense).
///  - `EXTRACT_MAX_ENTRIES`: hard cap on the number of archive entries.
///  - `EXTRACT_MAX_TOTAL_SIZE`: hard cap on the *sum of uncompressed* entry
///    sizes (a real ebook rarely exceeds a few MB; 512 MiB is very generous
///    for a legit title while still bounding decompression work).
pub(crate) const EXTRACT_MAX_ENTRIES: usize = 4096;
pub(crate) const EXTRACT_MAX_TOTAL_SIZE: u64 = 512 * 1024 * 1024;

fn check_office_file_size_limit(path: &str, label: &str) -> Result<u64, String> {
    let meta =
        fs::metadata(path).map_err(|e| format!("Failed to inspect {label} '{path}': {e}"))?;
    if meta.len() > MAX_OFFICE_FILE_BYTES {
        return Err(format!(
            "{label} '{path}' rejected: file size {} bytes exceeds limit {MAX_OFFICE_FILE_BYTES}",
            meta.len()
        ));
    }
    Ok(meta.len())
}

fn validate_zip_archive_limits(
    archive: &mut zip::ZipArchive<fs::File>,
    path: &str,
    label: &str,
) -> Result<(), String> {
    validate_zip_archive_limits_with_cap(archive, path, label, EXTRACT_MAX_TOTAL_SIZE)
}

fn validate_zip_archive_limits_with_cap<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
    label: &str,
    max_total_size: u64,
) -> Result<(), String> {
    let entry_count = archive.len();
    if entry_count > EXTRACT_MAX_ENTRIES {
        return Err(format!(
            "{label} '{path}' rejected: {entry_count} entries exceeds limit {EXTRACT_MAX_ENTRIES}"
        ));
    }
    // 1) 快速预检：校验 header 声明的未压缩字节总和
    let mut total_uncompressed: u64 = 0;
    for i in 0..entry_count {
        let entry = archive
            .by_index_raw(i)
            .map_err(|e| format!("Failed to inspect {label} entry #{i}: {e}"))?;
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
    }
    if total_uncompressed > max_total_size {
        return Err(format!(
            "{label} '{path}' rejected: uncompressed size {total_uncompressed} bytes exceeds {max_total_size}"
        ));
    }
    // 2) 流式实测：逐条目实际解压到 std::io::sink()，O(1) 内存拦截伪造 header size=0 的 ZIP 炸弹
    let mut actual_total: u64 = 0;
    for i in 0..entry_count {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to decompress {label} entry #{i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let remaining = max_total_size.saturating_sub(actual_total);
        let mut limited = entry.take(remaining.saturating_add(1));
        let copied = std::io::copy(&mut limited, &mut std::io::sink())
            .map_err(|e| format!("Failed to stream {label} entry #{i}: {e}"))?;
        actual_total = actual_total.saturating_add(copied);
        if actual_total > max_total_size {
            return Err(format!(
                "{label} '{path}' rejected: actual uncompressed size exceeds limit {max_total_size}"
            ));
        }
    }
    Ok(())
}

fn validate_zip_file_at_path(path: &str, label: &str) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open {label} '{path}': {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read {label} (ZIP) '{path}': {e}"))?;
    validate_zip_archive_limits(&mut archive, path, label)
}

/// Extract text from Office Open XML formats, converting to Markdown.
pub(crate) fn extract_office_text(path: &str, ext: &str) -> Result<String, String> {
    check_office_file_size_limit(path, "Office document")?;

    // Spreadsheets: use calamine (supports xlsx, xls, ods)
    if matches!(ext, "xlsx" | "xls" | "ods") {
        if matches!(ext, "xlsx" | "ods") {
            validate_zip_file_at_path(path, "Spreadsheet")?;
        }
        return extract_spreadsheet(path);
    }

    // DOCX: use docx-rs library for proper parsing
    if ext == "docx" {
        validate_zip_file_at_path(path, "DOCX")?;
        return extract_docx_with_library(path);
    }

    // PPTX and ODF: use ZIP-based parsing
    let file = fs::File::open(path).map_err(|e| format!("Failed to open '{}': {}", path, e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive '{}': {}", path, e))?;
    validate_zip_archive_limits(&mut archive, path, "Office archive")?;

    match ext {
        "pptx" => extract_pptx_markdown(&mut archive),
        "odt" | "odp" => extract_odf_text(&mut archive),
        _ => Ok("[Unsupported format]".to_string()),
    }
}

pub(crate) fn extract_legacy_doc_text(path: &str) -> Result<String, String> {
    check_office_file_size_limit(path, "Legacy .doc")?;
    let bytes = read_legacy_doc_payload(path)?;
    extract_legacy_doc_text_from_bytes(&bytes)
        .map_err(|e| format!("旧版 .doc 文本提取失败 '{}': {}", path, e))
}

pub(crate) fn read_legacy_doc_payload(path: &str) -> Result<Vec<u8>, String> {
    check_office_file_size_limit(path, "Legacy .doc")?;
    let mut payload = Vec::new();

    if let Ok(mut compound) = cfb::open(path) {
        for stream_name in ["WordDocument", "0Table", "1Table"] {
            if let Ok(stream) = compound.open_stream(stream_name) {
                let remaining = MAX_OFFICE_FILE_BYTES.saturating_sub(payload.len() as u64);
                let mut bytes = Vec::new();
                stream
                    .take(remaining.saturating_add(1))
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("Failed to read .doc stream '{}': {}", stream_name, e))?;
                if (bytes.len() as u64) > remaining {
                    return Err(format!(
                        "Legacy .doc '{}' rejected: stream payload exceeds limit {MAX_OFFICE_FILE_BYTES}",
                        path
                    ));
                }
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
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_le_bytes)
        .collect();
    let utf16_be_units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_be_bytes)
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
    check_office_file_size_limit(path, "EPUB")?;
    let file = fs::File::open(path).map_err(|e| format!("Failed to open EPUB '{path}': {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read EPUB (ZIP) '{path}': {e}"))?;

    // Zip-bomb defense BEFORE touching any entry body.
    validate_zip_archive_limits(&mut archive, path, "EPUB")?;

    // 共享实际流式解压总字节预算，防止恶意 ZIP 伪造 header uncompressed size 绕过。
    let mut total_unpacked: u64 = 0;

    // Locate the OPF via META-INF/container.xml.
    let container_xml = read_zip_file_with_budget(
        &mut archive,
        "META-INF/container.xml",
        MAX_ZIP_TEXT_ENTRY_BYTES,
        &mut total_unpacked,
        EXTRACT_MAX_TOTAL_SIZE,
    )?
    .ok_or_else(|| format!("EPUB '{path}': missing META-INF/container.xml"))?;
    let opf_path = epub_find_opf_path(&container_xml)
        .ok_or_else(|| format!("EPUB '{path}': container.xml has no rootfile full-path"))?;
    let opf_xml = read_zip_file_with_budget(
        &mut archive,
        &opf_path,
        MAX_ZIP_TEXT_ENTRY_BYTES,
        &mut total_unpacked,
        EXTRACT_MAX_TOTAL_SIZE,
    )?
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
        if let Some(content) = read_zip_file_with_budget(
            &mut archive,
            doc,
            MAX_ZIP_TEXT_ENTRY_BYTES,
            &mut total_unpacked,
            EXTRACT_MAX_TOTAL_SIZE,
        )? {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn validate_zip_archive_limits_rejects_excess_entries() {
        let dir = std::env::temp_dir().join(format!(
            "nb-fs-office-limit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let zp = dir.join("many.pptx");
        {
            let f = fs::File::create(&zp).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for i in 0..=EXTRACT_MAX_ENTRIES {
                w.start_file(format!("e{i}.txt"), opts).unwrap();
                w.write_all(b"x").unwrap();
            }
            w.finish().unwrap();
        }
        let err = extract_office_text(zp.to_str().unwrap(), "pptx")
            .expect_err("超过 ZIP 条目上限的 Office 归档必须拒绝");
        assert!(err.contains("entries exceeds limit"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_zip_archive_limits_rejects_forged_header_zip_bomb() {
        // 构造真实 Deflated 压缩的 4096 字节条目，再篡改 Local Header (+22..26) 与
        // Central Directory Header (+24..28) 声明的 uncompressed_size 为 4 字节，
        // 确认 header 预检被绕过后仍由流式解压实测拦截。
        let mut raw_zip = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut raw_zip);
            let mut w = zip::ZipWriter::new(cursor);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            w.start_file("payload.xml", opts).unwrap();
            w.write_all(&[b'A'; 4096]).unwrap();
            w.finish().unwrap();
        }

        // 在合理上限内，未篡改归档应放行
        {
            let mut archive =
                zip::ZipArchive::new(std::io::Cursor::new(raw_zip.as_slice())).unwrap();
            validate_zip_archive_limits_with_cap(&mut archive, "ok.docx", "DOCX", 4096).unwrap();
        }

        // 篡改 LFH (PK\x03\x04) 与 CDH (PK\x01\x02) 的 uncompressed_size 字段为 4
        let forged_size = 4u32.to_le_bytes();
        let lfh_pos = raw_zip
            .windows(4)
            .position(|w| w == [0x50, 0x4b, 0x03, 0x04])
            .expect("LFH magic");
        raw_zip[lfh_pos + 22..lfh_pos + 26].copy_from_slice(&forged_size);
        let cdh_pos = raw_zip
            .windows(4)
            .position(|w| w == [0x50, 0x4b, 0x01, 0x02])
            .expect("CDH magic");
        raw_zip[cdh_pos + 24..cdh_pos + 28].copy_from_slice(&forged_size);

        let mut forged_archive = zip::ZipArchive::new(std::io::Cursor::new(raw_zip)).unwrap();
        assert_eq!(
            forged_archive.by_index_raw(0).unwrap().size(),
            4,
            "确认 header 声明大小已被伪造为 4 字节"
        );
        let err =
            validate_zip_archive_limits_with_cap(&mut forged_archive, "forged.docx", "DOCX", 512)
                .expect_err("伪造 header 声明大小但实际解压超限的 ZIP 必须被流式检测拒绝");
        assert!(
            err.contains("actual uncompressed size exceeds limit"),
            "{err}"
        );
    }
}
