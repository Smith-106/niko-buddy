//! epub_export.rs — EPUB3 导出命令（54 号设计 ⑥，reference 池 EPUB 模式吸收）。
//!
//! 与 `docx_export` 同构：接收有序章节 → 构建最小合规 EPUB3 包 → 写 `export_path`。
//! 合规要点（EPUB3 规范）：
//!   - `mimetype` 必须是 ZIP 首条目且 **stored（不压缩）**；
//!   - `META-INF/container.xml` 指向 content.opf；
//!   - content.opf 声明 metadata/manifest/spine（spine 顺序 = 章节顺序）；
//!   - 章节正文为 XHTML5，标题转义，段落按空行切分。

use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::{AppHandle, Emitter};

use super::docx_export::{split_body_paragraphs, NovelChapter};

/// EPUB 书籍元数据（前端可选传入；缺省走内置默认）。
/// identifier 缺省时每次导出生成新的 UUID v4，保证同一作者多次导出不撞号
///（上游评审：编辑 E4，dc:identifier 全量同号问题）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubMeta {
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub identifier: Option<String>,
}

impl EpubMeta {
    fn title(&self) -> String {
        let t = self.title.as_deref().unwrap_or("").trim();
        if t.is_empty() { "Niko Buddy 导出".to_string() } else { t.to_string() }
    }
    fn author(&self) -> Option<String> {
        let a = self.author.as_deref().unwrap_or("").trim();
        if a.is_empty() { None } else { Some(a.to_string()) }
    }
    fn language(&self) -> String {
        let l = self.language.as_deref().unwrap_or("").trim();
        if l.is_empty() { "zh-CN".to_string() } else { l.to_string() }
    }
    fn identifier(&self) -> String {
        let id = self.identifier.as_deref().unwrap_or("").trim();
        if id.is_empty() {
            format!("urn:uuid:{}", uuid::Uuid::new_v4())
        } else {
            id.to_string()
        }
    }
}

/// EPUB 导出结果（与 DocxExportResult 同构，前端共用成功/路径/章节数）。
/// serde camelCase：Tauri 返回值按 Rust 字段名序列化，TS 侧期望 exportedPath/chapterCount/message，
/// 修复 40fe41d2 引入的契约错配（path/chapters vs exportedPath/chapterCount）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubExportResult {
    pub success: bool,
    pub exported_path: String,
    pub chapter_count: usize,
    pub message: String,
}

/// 构建并写出 EPUB3 包（默认元数据；保持旧调用兼容）。
pub fn build_and_write_epub(
    chapters: &[NovelChapter],
    export_path: &str,
) -> Result<EpubExportResult, String> {
    build_and_write_epub_with_meta(chapters, export_path, &EpubMeta { title: None, author: None, language: None, identifier: None })
}

/// 构建并写出 EPUB3 包（前端可注入 title/author/language/identifier）。
pub fn build_and_write_epub_with_meta(
    chapters: &[NovelChapter],
    export_path: &str,
    meta: &EpubMeta,
) -> Result<EpubExportResult, String> {
    if chapters.is_empty() {
        return Err("EPUB 导出失败：章节列表为空".to_string());
    }
    let file = std::fs::File::create(export_path)
        .map_err(|e| format!("EPUB 导出失败：无法创建文件 {export_path}: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();

    // 1) mimetype 必须 stored（EPUB3 规范硬性要求）
    zip.start_file(
        "mimetype",
        options.compression_method(zip::CompressionMethod::Stored),
    )
    .map_err(|e| format!("EPUB 导出失败：mimetype 写入错误: {e}"))?;
    zip.write_all(b"application/epub+zip")
        .map_err(|e| format!("EPUB 导出失败：mimetype 写入错误: {e}"))?;

    // 2) container.xml
    zip.start_file("META-INF/container.xml", options)
        .map_err(|e| format!("EPUB 导出失败：container.xml 写入错误: {e}"))?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .map_err(|e| format!("EPUB 导出失败：container.xml 写入错误: {e}"))?;

    // 3) content.opf（manifest + spine 按章节顺序；nav 文档满足 EPUB3 规范）
    let manifest: String = chapters
        .iter()
        .enumerate()
        .map(|(i, _)| format!(r#"<item id="ch{i}" href="chapters/ch{i}.xhtml" media-type="application/xhtml+xml"/>"#))
        .collect::<Vec<_>>()
        .join("\n    ");
    let nav_items: String = chapters
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let title = escape_xml(&c.title);
            format!(r#"<li><a href="chapters/ch{i}.xhtml">{title}</a></li>"#)
        })
        .collect::<Vec<_>>()
        .join("\n      ");
    let spine: String = chapters
        .iter()
        .enumerate()
        .map(|(i, _)| format!(r#"<itemref idref="ch{i}"/>"#))
        .collect::<Vec<_>>()
        .join("\n    ");
    let book_title = escape_xml(&meta.title());
    let book_lang = escape_xml(&meta.language());
    let book_id = escape_xml(&meta.identifier());
    let author_el = match meta.author() {
        Some(a) => format!("\n    <dc:creator>{}</dc:creator>", escape_xml(&a)),
        None => String::new(),
    };
    let opf = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{book_id}</dc:identifier>
    <dc:title>{book_title}</dc:title>{author_el}
    <dc:language>{book_lang}</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    {manifest}
  </manifest>
  <spine>
    {spine}
  </spine>
</package>"#
    );
    zip.start_file("OEBPS/content.opf", options)
        .map_err(|e| format!("EPUB 导出失败：content.opf 写入错误: {e}"))?;
    zip.write_all(opf.as_bytes())
        .map_err(|e| format!("EPUB 导出失败：content.opf 写入错误: {e}"))?;

    // 3b) nav.xhtml（EPUB3 规范要求 manifest 含 nav 文档，epubcheck 否则报 ERROR）
    let nav = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
      {nav_items}
  </ol>
</nav>
</body>
</html>"#
    );
    zip.start_file("OEBPS/nav.xhtml", options)
        .map_err(|e| format!("EPUB 导出失败：nav.xhtml 写入错误: {e}"))?;
    zip.write_all(nav.as_bytes())
        .map_err(|e| format!("EPUB 导出失败：nav.xhtml 写入错误: {e}"))?;

    // 4) 章节 XHTML（标题转义 + 空行切段；单段超长按中文句读兜底切分）
    for (i, chapter) in chapters.iter().enumerate() {
        let title = escape_xml(&chapter.title);
        let paragraphs: Vec<String> = split_body_paragraphs(&chapter.body)
            .iter()
            .map(|p| format!("<p>{}</p>", escape_xml(p)))
            .collect();
        let xhtml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>{title}</title></head>
<body>
<h1>{title}</h1>
{}
</body>
</html>"#,
            paragraphs.join("\n")
        );
        zip.start_file(format!("OEBPS/chapters/ch{i}.xhtml"), options)
            .map_err(|e| format!("EPUB 导出失败：章节 {i} 写入错误: {e}"))?;
        zip.write_all(xhtml.as_bytes())
            .map_err(|e| format!("EPUB 导出失败：章节 {i} 写入错误: {e}"))?;
    }

    zip.finish()
        .map_err(|e| format!("EPUB 导出失败：ZIP 收尾错误: {e}"))?;
    Ok(EpubExportResult {
        success: true,
        exported_path: export_path.to_string(),
        chapter_count: chapters.len(),
        message: format!("exported {} chapters to {export_path}", chapters.len()),
    })
}

/// XML 转义（标题/正文中的 & < > " 等）。
fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 导出命令（与 export_novel_docx 同构，emit `epub-export-progress` 供进度条）。
/// meta 可选：前端传入书籍标题/作者/语言/标识；缺省走默认（identifier 每次新 UUID）。
#[tauri::command]
pub async fn export_novel_epub(
    app: AppHandle,
    chapters: Vec<NovelChapter>,
    export_path: String,
    meta: Option<EpubMeta>,
) -> Result<EpubExportResult, String> {
    let count = chapters.len();
    for (index, _) in chapters.iter().enumerate() {
        let _ = app.emit(
            "epub-export-progress",
            serde_json::json!({ "current": index + 1, "total": count }),
        );
    }
    let m = meta.unwrap_or(EpubMeta { title: None, author: None, language: None, identifier: None });
    build_and_write_epub_with_meta(&chapters, &export_path, &m)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn chapters_fixture() -> Vec<NovelChapter> {
        vec![
            NovelChapter {
                title: "第一章 开端".to_string(),
                body: "雨停了。\n\n他推开门。\n\n光透了进来。".to_string(),
            },
            NovelChapter {
                title: "第二章 真相".to_string(),
                body: "他看见了 <真相> & 秘密。".to_string(),
            },
        ]
    }

    #[test]
    fn epub_export_writes_valid_zip_with_mimetype_first() {
        let dir = std::env::temp_dir().join(format!("niko-epub-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.epub");
        let result = build_and_write_epub(&chapters_fixture(), path.to_str().unwrap()).unwrap();
        assert!(result.success);
        assert_eq!(result.chapter_count, 2);

        // 回读 ZIP：mimetype 必须是首条目且 stored
        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert_eq!(zip.len(), 6); // mimetype + container + opf + nav + 2 章
        let mut names: Vec<String> = zip.file_names().map(|s| s.to_string()).collect();
        assert_eq!(names[0], "mimetype");
        assert_eq!(
            zip.by_index(0).unwrap().compression(),
            zip::CompressionMethod::Stored
        );
        let mut mt = String::new();
        zip.by_name("mimetype")
            .unwrap()
            .read_to_string(&mut mt)
            .unwrap();
        assert_eq!(mt, "application/epub+zip");

        // container.xml 指向 content.opf
        let mut container = String::new();
        zip.by_name("META-INF/container.xml")
            .unwrap()
            .read_to_string(&mut container)
            .unwrap();
        assert!(container.contains("OEBPS/content.opf"));

        // nav.xhtml 存在且 manifest 声明 properties="nav"（EPUB3 规范）
        let mut nav = String::new();
        zip.by_name("OEBPS/nav.xhtml")
            .unwrap()
            .read_to_string(&mut nav)
            .unwrap();
        assert!(nav.contains("epub:type=\"toc\""));
        assert!(nav.contains("chapters/ch0.xhtml"));
        let mut opf = String::new();
        zip.by_name("OEBPS/content.opf")
            .unwrap()
            .read_to_string(&mut opf)
            .unwrap();
        assert!(opf.contains("properties=\"nav\""));

        // 章节 XHTML：标题转义 + 段落切分
        let mut ch1 = String::new();
        zip.by_name("OEBPS/chapters/ch0.xhtml")
            .unwrap()
            .read_to_string(&mut ch1)
            .unwrap();
        assert!(ch1.contains("<h1>第一章 开端</h1>"));
        assert!(ch1.contains("<p>雨停了。</p>"));
        let mut ch2 = String::new();
        zip.by_name("OEBPS/chapters/ch1.xhtml")
            .unwrap()
            .read_to_string(&mut ch2)
            .unwrap();
        assert!(ch2.contains("&lt;真相&gt; &amp; 秘密"));
        names.clear();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn epub_export_rejects_empty_chapters() {
        let err = build_and_write_epub(&[], "unused.epub").unwrap_err();
        assert!(err.contains("章节列表为空"));
    }

    #[test]
    fn epub_export_default_identifier_is_unique_per_run() {
        // 缺省 identifier 每次生成新 UUID v4：同一作者多次导出不撞号（编辑 E4）。
        let dir = std::env::temp_dir().join(format!("niko-epub-uuid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p1 = dir.join("a.epub");
        let p2 = dir.join("b.epub");
        build_and_write_epub(&chapters_fixture(), p1.to_str().unwrap()).unwrap();
        build_and_write_epub(&chapters_fixture(), p2.to_str().unwrap()).unwrap();
        let read_opf = |p: &std::path::Path| -> String {
            let file = std::fs::File::open(p).unwrap();
            let mut zip = zip::ZipArchive::new(file).unwrap();
            let mut opf = String::new();
            zip.by_name("OEBPS/content.opf").unwrap().read_to_string(&mut opf).unwrap();
            opf
        };
        let opf1 = read_opf(&p1);
        let opf2 = read_opf(&p2);
        assert!(!opf1.contains("niko-buddy-export"), "默认 identifier 不再是固定字符串");
        assert_ne!(opf1, opf2, "两次默认导出 identifier 必须不同");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn epub_export_with_meta_injects_title_author_language() {
        let dir = std::env::temp_dir().join(format!("niko-epub-meta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.epub");
        let meta = EpubMeta {
            title: Some("测试书名".to_string()),
            author: Some("测试作者".to_string()),
            language: Some("zh-TW".to_string()),
            identifier: Some("urn:uuid:fixed-test-id".to_string()),
        };
        build_and_write_epub_with_meta(&chapters_fixture(), path.to_str().unwrap(), &meta).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut opf = String::new();
        zip.by_name("OEBPS/content.opf").unwrap().read_to_string(&mut opf).unwrap();
        assert!(opf.contains("<dc:title>测试书名</dc:title>"));
        assert!(opf.contains("<dc:creator>测试作者</dc:creator>"));
        assert!(opf.contains("<dc:language>zh-TW</dc:language>"));
        assert!(opf.contains("urn:uuid:fixed-test-id"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
