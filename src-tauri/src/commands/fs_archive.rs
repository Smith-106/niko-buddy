// Copyright (c) 2024 Niko-hub contributors. MIT License.
// SPDX-License-Identifier: MIT

//! Pure archive/text extraction helpers moved out of `fs.rs` (S5 split).
//!
//! This module contains only side-effect-free (or single-file-read) helpers
//! for ZIP/XML/HTML/EPUB text extraction plus their unit tests. Tauri
//! command entry points (`read_file`, `write_file`, …) and shared storage
//! helpers (`resolve_project_storage_path`, `lock_pdfium`, `pdfium`,
//! `set_resource_dir_hint`, …) stay in `fs.rs` and re-export these helpers
//! via `pub use` for path compatibility.

use std::fs;
use std::io::Read as IoRead;

pub(crate) fn read_zip_file(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    Some(content)
}

pub(crate) fn decode_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
}

/// Extract DOCX to Markdown preserving headings, paragraphs, lists, tables, bold/italic.
pub(crate) fn extract_docx_markdown(
    archive: &mut zip::ZipArchive<fs::File>,
) -> Result<String, String> {
    let xml = read_zip_file(archive, "word/document.xml")
        .ok_or_else(|| "No document.xml found".to_string())?;

    let mut result = String::new();
    let mut i = 0;
    let chars: Vec<char> = xml.chars().collect();
    let len = chars.len();

    let mut paragraph_text = String::new();
    let mut is_heading = false;
    let mut heading_level: u8 = 1;
    let mut is_bold = false;
    let mut is_italic = false;
    let mut in_table = false;
    let mut table_row: Vec<String> = Vec::new();
    let mut table_cell_text = String::new();
    let mut in_cell = false;
    let mut is_first_table_row = true;
    let mut in_list_item = false;

    while i < len {
        if chars[i] == '<' {
            // Read tag name
            i += 1;
            let is_closing = i < len && chars[i] == '/';
            if is_closing {
                i += 1;
            }

            let mut tag_name = String::new();
            while i < len && chars[i] != '>' && chars[i] != ' ' && chars[i] != '/' {
                tag_name.push(chars[i]);
                i += 1;
            }

            // Read rest of tag to find attributes
            let mut tag_content = String::new();
            while i < len && chars[i] != '>' {
                tag_content.push(chars[i]);
                i += 1;
            }
            if i < len {
                i += 1;
            } // skip >

            match tag_name.as_str() {
                // Paragraph start
                "w:p" if !is_closing => {
                    paragraph_text.clear();
                    is_heading = false;
                    in_list_item = false;
                }
                // Paragraph end — flush
                "w:p" if is_closing => {
                    let text = paragraph_text.trim().to_string();
                    if !text.is_empty() {
                        if in_table && in_cell {
                            table_cell_text = text;
                        } else if is_heading {
                            let prefix = "#".repeat(heading_level as usize);
                            result.push_str(&format!("{} {}\n\n", prefix, text));
                        } else if in_list_item {
                            result.push_str(&format!("- {}\n", text));
                        } else {
                            result.push_str(&text);
                            result.push_str("\n\n");
                        }
                    }
                    paragraph_text.clear();
                }
                // Heading style detection
                "w:pStyle" if !is_closing => {
                    if tag_content.contains("Heading") || tag_content.contains("heading") {
                        is_heading = true;
                        // Try to extract heading level from val="Heading1" etc.
                        if let Some(pos) = tag_content.find("Heading") {
                            let after = &tag_content[pos + 7..];
                            if let Some(ch) = after.chars().next() {
                                if ch.is_ascii_digit() {
                                    heading_level = ch.to_digit(10).unwrap_or(1) as u8;
                                }
                            }
                        }
                    }
                    if tag_content.contains("ListParagraph")
                        || tag_content.contains("listParagraph")
                    {
                        in_list_item = true;
                    }
                }
                // Bold
                "w:b"
                    if !is_closing
                        && !tag_content.contains("w:val=\"0\"")
                        && !tag_content.contains("w:val=\"false\"") =>
                {
                    is_bold = true;
                }
                // Italic
                "w:i"
                    if !is_closing
                        && !tag_content.contains("w:val=\"0\"")
                        && !tag_content.contains("w:val=\"false\"") =>
                {
                    is_italic = true;
                }
                // Run end — apply formatting
                "w:r" if is_closing => {
                    is_bold = false;
                    is_italic = false;
                }
                // Text content
                "w:t" if !is_closing => {
                    // Read text until </w:t>
                    let mut text = String::new();
                    while i < len {
                        if chars[i] == '<' {
                            break;
                        }
                        text.push(chars[i]);
                        i += 1;
                    }
                    let decoded = decode_xml_entities(&text);
                    if is_bold && is_italic {
                        paragraph_text.push_str(&format!("***{}***", decoded));
                    } else if is_bold {
                        paragraph_text.push_str(&format!("**{}**", decoded));
                    } else if is_italic {
                        paragraph_text.push_str(&format!("*{}*", decoded));
                    } else {
                        paragraph_text.push_str(&decoded);
                    }
                }
                // Table handling
                "w:tbl" if !is_closing => {
                    in_table = true;
                    is_first_table_row = true;
                }
                "w:tbl" if is_closing => {
                    in_table = false;
                    result.push('\n');
                }
                "w:tr" if !is_closing => {
                    table_row.clear();
                }
                "w:tr" if is_closing => {
                    if !table_row.is_empty() {
                        result.push_str("| ");
                        result.push_str(&table_row.join(" | "));
                        result.push_str(" |\n");
                        if is_first_table_row {
                            result.push_str("|");
                            for _ in &table_row {
                                result.push_str(" --- |");
                            }
                            result.push('\n');
                            is_first_table_row = false;
                        }
                    }
                }
                "w:tc" if !is_closing => {
                    in_cell = true;
                    table_cell_text.clear();
                }
                "w:tc" if is_closing => {
                    table_row.push(table_cell_text.trim().to_string());
                    in_cell = false;
                    table_cell_text.clear();
                }
                _ => {}
            }
        } else {
            i += 1;
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract structured text from DOCX]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract PPTX to Markdown with slide numbers and structure.
pub(crate) fn extract_pptx_markdown(
    archive: &mut zip::ZipArchive<fs::File>,
) -> Result<String, String> {
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();

    // Sort by slide number
    slide_names.sort_by(|a, b| {
        let num_a = a
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0);
        let num_b = b
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0);
        num_a.cmp(&num_b)
    });

    let mut result = String::new();

    for (idx, slide_name) in slide_names.iter().enumerate() {
        let xml = match read_zip_file(archive, slide_name) {
            Some(x) => x,
            None => continue,
        };

        result.push_str(&format!("## Slide {}\n\n", idx + 1));

        // Extract text from <a:t>...</a:t> tags, group by <a:p>...</a:p> paragraphs
        // Use string split approach to avoid byte/char index mismatch with CJK characters
        let mut paragraphs: Vec<String> = Vec::new();

        for para_part in xml.split("<a:p") {
            let mut para_text = String::new();
            for t_part in para_part.split("<a:t") {
                if let Some(close_pos) = t_part.find("</a:t>") {
                    if let Some(gt_pos) = t_part.find('>') {
                        if gt_pos < close_pos {
                            let text = &t_part[gt_pos + 1..close_pos];
                            para_text.push_str(&decode_xml_entities(text));
                        }
                    }
                }
            }
            let trimmed = para_text.trim().to_string();
            if !trimmed.is_empty() {
                paragraphs.push(trimmed);
            }
        }

        // First paragraph is usually the slide title
        if let Some(title) = paragraphs.first() {
            result.push_str(&format!("**{}**\n\n", title));
            for para in paragraphs.iter().skip(1) {
                result.push_str(&format!("- {}\n", para));
            }
        }
        result.push('\n');
    }

    if result.trim().is_empty() {
        Ok("[Could not extract text from PPTX]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract OpenDocument format text (basic).
pub(crate) fn extract_odf_text(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let xml =
        read_zip_file(archive, "content.xml").ok_or_else(|| "No content.xml found".to_string())?;

    let mut result = String::new();
    let mut in_tag = false;

    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }

    let cleaned = decode_xml_entities(&result);
    let lines: Vec<&str> = cleaned
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    if lines.is_empty() {
        Ok("[Could not extract text from this file]".to_string())
    } else {
        Ok(lines.join("\n\n"))
    }
}

// ── HTML extraction ─────────────────────────────────────────────────────
//
// `.html` / `.htm` files get a dedicated extraction path: read the file,
// drop every complete `<script>…</script>` / `<style>…</style>` block so
// embedded code and CSS never leak into the plain text, then reuse the
// XHTML stripper (`extract_xhtml_text`) to remove markup while preserving
// block-level line breaks, and finally decode HTML/XML entities. The OPF/
// package concept does not apply to standalone HTML documents.

/// Extract the plain-text body of a standalone HTML/HTML file. Script and
/// style blocks are removed first; remaining tags are stripped with
/// block-level break preservation (reusing the XHTML path), then common
/// HTML/XML entities are decoded.
pub(crate) fn extract_html_file(path: &str) -> Result<String, String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read HTML file '{path}': {e}"))?;
    let stripped = strip_html_script_style(&content);
    Ok(decode_html_entities(&extract_xhtml_text(&stripped)))
}

/// Remove every complete `<script …>…</script>` and `<style …>…</style>`
/// block (opening and closing tags matched case-insensitively; the closing
/// tag may carry trailing whitespace before `>`) from an HTML document, so
/// the tag content never surfaces in the extracted text. Malformed input
/// degrades gracefully to the nearest well-formed boundary.
pub(crate) fn strip_html_script_style(html: &str) -> String {
    fn strip_tag_blocks(html: &str, tag: &str) -> String {
        let mut out = String::with_capacity(html.len());
        let lower = html.to_lowercase();
        let open = format!("<{tag}");
        let close = format!("</{tag}");
        let mut pos = 0usize;
        loop {
            let Some(rel) = lower[pos..].find(&open) else {
                out.push_str(&html[pos..]);
                break;
            };
            let open_start = pos + rel;
            out.push_str(&html[pos..open_start]);
            let Some(gt_rel) = lower[open_start..].find('>') else {
                out.push_str(&html[open_start..]);
                break;
            };
            let gt = open_start + gt_rel;
            // Drop everything after the opening tag up to and including the
            // closing tag. If there is no closing tag, bail out keeping the rest.
            let content = gt + 1;
            let Some(c_rel) = lower[content..].find(&close) else {
                out.push_str(&html[open_start..]);
                break;
            };
            let close_start = content + c_rel;
            let close_gt = match lower[close_start..].find('>') {
                Some(g) => close_start + g,
                None => html.len(),
            };
            pos = close_gt.saturating_add(1);
        }
        out
    }
    strip_tag_blocks(&strip_tag_blocks(html, "script"), "style")
}

/// Parse `META-INF/container.xml` for the OPF path (attribute `full-path` on
/// the first `<rootfile>` element). Returns the raw, OPF-relative path.
pub(crate) fn epub_find_opf_path(container_xml: &str) -> Option<String> {
    let mut found: Option<String> = None;
    each_xml_tag(container_xml, "rootfile", |tag| {
        if found.is_none() {
            if let Some(p) = xml_attr_value(tag, "full-path") {
                found = Some(p);
            }
        }
    });
    found
}

/// Map the OPF `<spine>` `<itemref idref>` sequence to content-document
/// paths (via the `<manifest>` id→href map), preserving reading order.
/// Returns `(idref, href)` pairs, empty if the OPF has no usable spine.
pub(crate) fn epub_spine_order(opf_xml: &str) -> Vec<(String, String)> {
    let mut manifest: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    each_xml_tag(opf_xml, "item", |tag| {
        if let (Some(id), Some(href)) = (xml_attr_value(tag, "id"), xml_attr_value(tag, "href")) {
            manifest.insert(id, href);
        }
    });

    let mut order: Vec<(String, String)> = Vec::new();
    each_xml_tag(opf_xml, "itemref", |tag| {
        if let Some(idref) = xml_attr_value(tag, "idref") {
            if let Some(href) = manifest.get(&idref) {
                order.push((idref, href.clone()));
            }
        }
    });
    order
}

/// Fallback for OPF-less/spine-less EPUBs: every `.xhtml`/`.html` entry
/// (outside META-INF), sorted by name for a deterministic reading order.
pub(crate) fn epub_sorted_content_paths(archive: &mut zip::ZipArchive<fs::File>) -> Vec<String> {
    let mut names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| {
            let lower = n.to_lowercase();
            !n.starts_with("META-INF/") && (lower.ends_with(".xhtml") || lower.ends_with(".html"))
        })
        .collect();
    names.sort();
    names
}

/// Resolve an OPF-relative `href` (which may contain `./` or `../`) against
/// the OPF's directory to an absolute in-archive path.
pub(crate) fn resolve_opf_relative(opf_path: &str, href: &str) -> String {
    let mut base: Vec<&str> = opf_path.split('/').collect();
    base.pop(); // drop the OPF filename, keep its directory
    let mut joined = base.join("/");
    if !base.is_empty() {
        joined.push('/');
    }
    joined.push_str(href);
    normalize_archive_path(&joined)
}

/// Resolve `.`, `..` and empty segments out of an in-archive path. Safe to
/// call on Windows/POSIX because archive names always use `/`.
pub(crate) fn normalize_archive_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// Extract plain text from an XHTML body: strip all tags while converting
/// block-level breaks into newlines, then decode HTML/XML entities. Raw
/// markup (scripts/styles) is dropped along with the tags.
pub(crate) fn extract_xhtml_text(xhtml: &str) -> String {
    let bytes = xhtml.as_bytes();
    let len = bytes.len();
    let mut out = String::new();
    let mut text_buf: Vec<u8> = Vec::new();
    let mut pending_newline = false;

    let mut i = 0;
    while i < len {
        if bytes[i] == b'<' {
            // Flush accumulated text before the tag.
            if !text_buf.is_empty() {
                if pending_newline {
                    while out.ends_with('\n') {
                        out.pop();
                    }
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    pending_newline = false;
                }
                out.push_str(&String::from_utf8_lossy(&text_buf));
                text_buf.clear();
            }

            // Parse tag name + skip attributes to the closing '>'.
            let is_closing = i + 1 < len && bytes[i + 1] == b'/';
            let mut j = i + 1;
            if is_closing {
                j += 1;
            }
            let mut name = String::new();
            while j < len && bytes[j].is_ascii_alphanumeric() {
                name.push(bytes[j] as char);
                j += 1;
            }
            let mut k = j;
            while k < len && bytes[k] != b'>' {
                k += 1;
            }
            if is_block_tag_break(is_closing, &name.to_lowercase()) {
                pending_newline = true;
            }
            i = if k < len { k + 1 } else { len };
        } else {
            text_buf.push(bytes[i]);
            i += 1;
        }
    }

    // Flush any trailing text / blank line.
    if pending_newline {
        while out.ends_with('\n') {
            out.pop();
        }
        if !out.is_empty() {
            out.push('\n');
        }
    }
    if !text_buf.is_empty() {
        out.push_str(&String::from_utf8_lossy(&text_buf));
    }
    out
}

/// Whether a tag implies a paragraph break in plain-text output. Open `<br>`
/// and the *close* tags of common block elements map to a newline so a
/// stripped document reads as discrete lines.
pub(crate) fn is_block_tag_break(open: bool, name: &str) -> bool {
    matches!(
        (open, name),
        (true, "br")
            | (false, "p")
            | (false, "div")
            | (false, "li")
            | (false, "ul")
            | (false, "ol")
            | (false, "h1")
            | (false, "h2")
            | (false, "h3")
            | (false, "h4")
            | (false, "h5")
            | (false, "h6")
            | (false, "tr")
            | (false, "table")
            | (false, "section")
            | (false, "blockquote")
    )
}

/// Iterate over every `<element_name …>` occurrence of the given tag in an
/// XML/HTML fragment, invoking `visit` with the tag content (everything
/// between `<` and `>`). Element names are matched case-insensitively;
/// attribute values are taken from the original (un-lowercased) bytes.
pub(crate) fn each_xml_tag(xml: &str, element_name: &str, mut visit: impl FnMut(&str)) {
    let mut pos = 0usize;
    while let Some(lt_rel) = xml[pos..].find('<') {
        let lt = pos + lt_rel;
        let rest = &xml[lt + 1..];

        // Element name = ASCII alphanumerics right after '<' (skip '/').
        let mut name_start = 0usize;
        if rest.as_bytes().first() == Some(&b'/') {
            name_start = 1;
        }
        let mut j = name_start;
        let bytes = rest.as_bytes();
        while j < bytes.len() && bytes[j].is_ascii_alphanumeric() {
            j += 1;
        }
        let name = rest[name_start..j].to_lowercase();

        // Consume the whole element (`>` included) so nested tags on the
        // same line don't confuse cursor advances.
        let gt_pos = rest.find('>').map(|g| g + 1).unwrap_or(rest.len());
        if name == element_name && j > name_start {
            // Inner content is everything between the name and '>'.
            let inner_end = rest.find('>').unwrap_or(rest.len());
            visit(&rest[..inner_end]);
        }
        pos = lt + 1 + gt_pos;
    }
}

/// Read the value of a well-formed `name="v"` / `name='v'` attribute out of
/// a tag fragment (just the tag's inner text, e.g. `item id="c1" href="…"`).
pub(crate) fn xml_attr_value(fragment: &str, name: &str) -> Option<String> {
    let idx = fragment.find(name)?;
    let rest = fragment[idx + name.len()..].trim_start();
    if !rest.starts_with('=') {
        return None;
    }
    let rest = rest[1..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &rest[quote.len_utf8()..];
    let end = body.find(quote)?;
    Some(body[..end].to_string())
}

/// Decode the common HTML/XML entities found in XHTML text (the five XML
/// built-ins plus a handful of useful numerics and `&nbsp;`).
pub(crate) fn decode_html_entities(text: &str) -> String {
    let mut s = decode_xml_entities(text);
    s = s.replace("&nbsp;", " ");
    s = s.replace("&#160;", " ");
    s = s.replace("&#39;", "'");
    s = s.replace("&#34;", "\"");
    s = s.replace("&#38;", "&");
    s = s.replace("&#60;", "<");
    s = s.replace("&#62;", ">");
    s = s.replace("&copy;", "©");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fs-archive-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_tmp_html(label: &str, content: &str) -> String {
        let dir = make_temp_dir(label);
        let p = dir.join("page.html");
        std::fs::write(&p, content).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn epub_opf_relative_resolution_with_parent_traversal() {
        assert_eq!(
            resolve_opf_relative("OEBPS/content.opf", "Text/ch1.xhtml"),
            "OEBPS/Text/ch1.xhtml"
        );
        assert_eq!(
            resolve_opf_relative("OPS/package.opf", "../OEBPS/ch.xhtml"),
            "OEBPS/ch.xhtml"
        );
    }

    #[test]
    fn html_extracts_body_strips_script_style_and_decodes_entities() {
        let html = r#"<html><head><title>T</title>
<style>body { color: red; }</style>
<script>var secret = "NSA";</script>
</head>
<body>
<h1>Chapter One</h1>
<p>Hello &amp; <b>world</b></p>
<p data-x='1'>Second &nbsp;para</p>
<script>alert('x')</script>
<p>Tail &lt;3 &copy;</p>
</body></html>"#;
        let path = write_tmp_html("script-style", html);
        let out = extract_html_file(&path).unwrap();
        let _ = fs::remove_file(&path);

        // Body text extracted, block-level breaks preserved.
        assert!(out.contains("Chapter One"), "{out}");
        assert!(out.contains("Second  para"), "{out}");
        // Entities decoded.
        assert!(out.contains("Hello & world"), "{out}");
        assert!(out.contains("Tail <3"), "{out}");
        assert!(out.contains("©"), "{out}");
        // Script/style content must NOT appear.
        assert!(!out.contains("secret"), "{out}");
        assert!(!out.contains("alert"), "{out}");
        assert!(!out.contains("color: red"), "{out}");
    }

    #[test]
    fn html_empty_and_garbage_do_not_panic() {
        // Empty file -> okay, empty output.
        let dir = make_temp_dir("html-empty");
        let p = dir.join("empty.html");
        std::fs::write(&p, "").unwrap();
        let p_str = p.to_string_lossy().into_owned();
        let out = extract_html_file(&p_str).unwrap();
        assert_eq!(out, "");
        // Truncated / unbalanced tags must not panic; degrade gracefully.
        let p2 = dir.join("bad.html");
        std::fs::write(&p2, "<p>unclosed <script>oops</script><style>css").unwrap();
        let p2_str = p2.to_string_lossy().into_owned();
        let out2 = extract_html_file(&p2_str).unwrap();
        assert!(out2.contains("unclosed"), "{out2}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_missing_file_is_an_error() {
        let dir = make_temp_dir("html-missing");
        let p = dir.join("missing.html").to_string_lossy().into_owned();
        let err = extract_html_file(&p).unwrap_err();
        let _ = fs::remove_dir_all(&dir);
        assert!(err.contains("Failed to read"), "{err}");
    }
}
