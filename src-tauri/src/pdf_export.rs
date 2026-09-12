//! PDF 导出（F-008）：**只读投影** + 数据区路径硬拦 + CJK 字体嵌入。
//!
//! 三条不变量：
//! 1. 导出目标 MUST 落在数据区之外（`.novel/`、`QM/`、`.qmai/`、`backups/` 一律拒绝）——
//!    导出产物是可再生的读物，绝不允许写回正文、记忆或投影目录；
//! 2. 中文必须**内嵌字体**（`NotoSerifCJKsc-Regular.otf`），不依赖读者机器上的字体；
//! 3. 行距固定 1.5 倍，页面尺寸 A4，正文来自调用方传入的只读文本切片。
//!
//! pdfium 只用于**生成与渲染校验**，绑定生命周期复用既有全局单例
//! （`commands::fs::pdfium()` / `lock_pdfium()`），不新建第二套绑定。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 内嵌中文字体文件名（本仓库自带资产）。
pub const CJK_FONT_FILE: &str = "NotoSerifCJKsc-Regular.otf";
/// 字体资产相对项目根的位置。
pub const FONT_ASSET_DIR: &str = "src-tauri/assets/fonts";
/// 正文行距倍数（硬约定，不随调用方变化）。
pub const LINE_HEIGHT_RATIO: f32 = 1.5;
/// 默认字号（pt）。
pub const DEFAULT_FONT_SIZE_PT: f32 = 11.0;
/// 页边距（pt）。
pub const PAGE_MARGIN_PT: f32 = 56.0;
/// 数据区目录名（一律不可作为导出目标）。
pub const DATA_SECTIONS: [&str; 4] = [".novel", "QM", ".qmai", "backups"];
/// A4 高度（pt），用于换页判断。
pub const A4_HEIGHT_PT: f32 = 841.89;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfExportError {
    /// 导出目标落在数据区内（只读投影不变量）。
    PathInsideDataSection(String),
    Io(String),
    Render(String),
    /// 找不到内嵌字体资产。
    FontMissing(String),
}

impl std::fmt::Display for PdfExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PdfExportError::PathInsideDataSection(m) => {
                write!(f, "PDF_EXPORT_PATH_INSIDE_DATA_SECTION: {m}")
            }
            PdfExportError::Io(m) => write!(f, "PDF_EXPORT_IO: {m}"),
            PdfExportError::Render(m) => write!(f, "PDF_EXPORT_RENDER: {m}"),
            PdfExportError::FontMissing(m) => write!(f, "PDF_EXPORT_FONT_MISSING: {m}"),
        }
    }
}

impl std::error::Error for PdfExportError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfExportRequest {
    pub project_root: PathBuf,
    /// 导出目标（绝对路径或项目相对路径）。
    pub target: String,
    pub title: String,
    pub paragraphs: Vec<String>,
    /// 可选字体覆盖（默认用仓库自带资产）。
    pub font_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfExportReport {
    pub target: String,
    pub pages: usize,
    pub paragraphs: usize,
    pub font: String,
    pub line_height_ratio: f32,
    /// 是否真的写进了文件（调用方据此避免「命令成功但没产物」）。
    pub bytes_written: u64,
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 硬拦：导出目标不得落在数据区，也不得指向数据区内的父目录。
///
/// 判据是**路径段**而不是字符串包含：`book/notes/.novelish.md` 合法，
/// `book/.novel/drafts/x.md` 与 `.novel/x.pdf` 一律拒绝。
pub fn assert_export_path_outside_data_sections(
    project_root: &Path,
    target: &Path,
) -> Result<PathBuf, PdfExportError> {
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        project_root.join(target)
    };
    let as_text = normalized(&resolved);
    let root_text = normalized(project_root);
    let relative = as_text
        .strip_prefix(&root_text)
        .unwrap_or(&as_text)
        .trim_start_matches('/')
        .to_string();

    if relative.is_empty() {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target resolves to the project root: {as_text}"
        )));
    }
    for segment in relative.split('/') {
        if DATA_SECTIONS.iter().any(|s| segment == *s) {
            return Err(PdfExportError::PathInsideDataSection(format!(
                "target '{relative}' is inside data section '{segment}'"
            )));
        }
    }
    if relative.split('/').any(|s| s == "..") {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target escapes the project root: {relative}"
        )));
    }
    Ok(resolved)
}

/// 解析内嵌字体：显式覆盖 → 项目资产 → 可执行文件旁的资产。
pub fn resolve_cjk_font(
    project_root: &Path,
    override_path: Option<&Path>,
) -> Result<PathBuf, PdfExportError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = override_path {
        candidates.push(explicit.to_path_buf());
    }
    candidates.push(project_root.join(FONT_ASSET_DIR).join(CJK_FONT_FILE));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("assets").join("fonts").join(CJK_FONT_FILE));
            candidates.push(
                dir.join("..")
                    .join("..")
                    .join("..")
                    .join(FONT_ASSET_DIR)
                    .join(CJK_FONT_FILE),
            );
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            PdfExportError::FontMissing(format!(
                "embedded font {CJK_FONT_FILE} not found under {FONT_ASSET_DIR}"
            ))
        })
}

/// 每行可容纳的字符数（中文按全宽计）。确定性、无外部依赖。
fn chars_per_line(font_size: f32, page_width_pt: f32) -> usize {
    let usable = (page_width_pt - PAGE_MARGIN_PT * 2.0).max(font_size);
    // 全宽字符约占一个字号宽度。
    (usable / font_size).floor().max(1.0) as usize
}

/// 按字符硬折行（中文无需空格分词；超长行不丢字）。
fn wrap_paragraph(paragraph: &str, width: usize) -> Vec<String> {
    let chars: Vec<char> = paragraph.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars
        .chunks(width)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect()
}

/// 生成 PDF。同步实现：pdfium 绑定是全局单例，调用期间持锁。
pub fn export_pdf(request: &PdfExportRequest) -> Result<PdfExportReport, PdfExportError> {
    use pdfium_render::prelude::*;

    let target =
        assert_export_path_outside_data_sections(&request.project_root, Path::new(&request.target))?;
    let font_path = resolve_cjk_font(&request.project_root, request.font_path.as_deref())?;

    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium().map_err(PdfExportError::Render)?;
    let mut document = pdfium
        .create_new_pdf()
        .map_err(|e| PdfExportError::Render(e.to_string()))?;

    let font_size = DEFAULT_FONT_SIZE_PT;
    let line_height = font_size * LINE_HEIGHT_RATIO;
    let font_token = document
        .fonts_mut()
        .load_type1_from_file(&font_path, true)
        .map_err(|e| PdfExportError::Render(format!("load font failed: {e}")))?;

    let width = chars_per_line(font_size, PdfPagePaperSize::a4().width().value);
    let mut pages = 0usize;
    let mut cursor_y = A4_HEIGHT_PT - PAGE_MARGIN_PT;
    let mut page = document
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::a4())
        .map_err(|e| PdfExportError::Render(e.to_string()))?;
    pages += 1;

    let mut index = 0usize;
    for paragraph in &request.paragraphs {
        for line in wrap_paragraph(paragraph, width) {
            if cursor_y <= PAGE_MARGIN_PT {
                page = document
                    .pages_mut()
                    .create_page_at_end(PdfPagePaperSize::a4())
                    .map_err(|e| PdfExportError::Render(e.to_string()))?;
                pages += 1;
                cursor_y = A4_HEIGHT_PT - PAGE_MARGIN_PT;
                index = 0;
            }
            let mut object = PdfPageTextObject::new(&document, line, font_token, PdfPoints::new(font_size))
                .map_err(|e| PdfExportError::Render(format!("text object failed: {e}")))?;
            object
                .translate(PdfPoints::new(PAGE_MARGIN_PT), PdfPoints::new(cursor_y))
                .map_err(|e| PdfExportError::Render(format!("place text failed: {e}")))?;
            page.objects_mut()
                .insert_object_at_index(index, PdfPageObject::Text(object))
                .map_err(|e| PdfExportError::Render(format!("insert object failed: {e}")))?;
            index += 1;
            cursor_y -= line_height;
        }
        // 段间空一行，仍按 1.5 行距计。
        cursor_y -= line_height;
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| PdfExportError::Io(e.to_string()))?;
    }
    document
        .save_to_file(&target)
        .map_err(|e| PdfExportError::Render(format!("save failed: {e}")))?;
    let bytes_written = std::fs::metadata(&target)
        .map(|m| m.len())
        .map_err(|e| PdfExportError::Io(e.to_string()))?;

    Ok(PdfExportReport {
        target: normalized(&target),
        pages,
        paragraphs: request.paragraphs.len(),
        font: CJK_FONT_FILE.to_string(),
        line_height_ratio: LINE_HEIGHT_RATIO,
        bytes_written,
    })
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────

pub mod api {
    use super::*;

    #[tauri::command]
    pub async fn export_pdf(
        project_path: String,
        target: String,
        title: String,
        paragraphs: Vec<String>,
    ) -> Result<PdfExportReport, String> {
        let request = PdfExportRequest {
            project_root: PathBuf::from(&project_path),
            target: assert_export_path_outside_data_sections(
                Path::new(&project_path),
                Path::new(&target),
            )
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string(),
            title,
            paragraphs,
            font_path: None,
        };
        super::export_pdf(&request).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod pdfexport {
    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root")
            .to_path_buf()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nb-pdf-export-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn rejects_path_inside_novel() {
        let root = repo_root();
        let err = assert_export_path_outside_data_sections(
            &root,
            Path::new(".novel/exports/book.pdf"),
        )
        .expect_err("数据区必须拒绝");
        assert!(
            matches!(err, PdfExportError::PathInsideDataSection(_)),
            "got {err:?}"
        );
        assert!(err.to_string().contains("PATH_INSIDE_DATA_SECTION"));

        // 绝对路径落在数据区同样拒绝。
        assert!(assert_export_path_outside_data_sections(
            &root,
            &root.join(".novel").join("book.pdf")
        )
        .is_err());
    }

    #[test]
    fn rejects_path_inside_qm() {
        let root = repo_root();
        let err =
            assert_export_path_outside_data_sections(&root, Path::new("QM/exports/book.pdf"))
                .expect_err("QM 必须拒绝");
        assert!(matches!(err, PdfExportError::PathInsideDataSection(_)));
        assert!(assert_export_path_outside_data_sections(&root, Path::new(".qmai/book.pdf")).is_err());
        assert!(assert_export_path_outside_data_sections(&root, Path::new("backups/a/b.pdf")).is_err());
        // 越界同样拒绝。
        assert!(assert_export_path_outside_data_sections(&root, Path::new("../escape.pdf")).is_err());
    }

    #[test]
    fn accepts_export_target_outside_data_sections() {
        let root = repo_root();
        let ok = assert_export_path_outside_data_sections(&root, Path::new("exports/book.pdf"))
            .expect("数据区之外应通过");
        assert!(ok.to_string_lossy().ends_with("exports/book.pdf")
            || ok.to_string_lossy().ends_with("exports\\book.pdf"));
        // 长得像数据区但路径段不同的目录不受影响。
        assert!(assert_export_path_outside_data_sections(
            &root,
            Path::new("book/.novelish/notes.pdf")
        )
        .is_ok());
    }

    #[test]
    fn line_spacing_is_fixed_at_one_point_five() {
        assert_eq!(LINE_HEIGHT_RATIO, 1.5);
        let advance = DEFAULT_FONT_SIZE_PT * LINE_HEIGHT_RATIO;
        assert_eq!(advance, 16.5);
        // 折行是确定性的且不丢字。
        let lines = wrap_paragraph("中文字符测试内容", 4);
        assert_eq!(lines, vec!["中文字符", "测试内容"]);
        assert_eq!(wrap_paragraph("", 10), vec![String::new()]);
    }

    #[test]
    fn embedded_cjk_font_asset_exists() {
        let font = resolve_cjk_font(&repo_root(), None).expect("字体资产必须存在");
        let size = std::fs::metadata(&font).expect("font metadata").len();
        assert!(size > 1_000_000, "字体资产过小：{size} bytes");
        assert!(font.to_string_lossy().contains(CJK_FONT_FILE));
    }

    /// 真实生成一份中文 PDF 并做机械核验：字体已嵌入 + 中文可回读 + 页数一致。
    #[test]
    fn exports_cjk_sample_with_embedded_font() {
        // pdfium 动态库由 `commands::fs::pdfium_candidate_paths()` 在源码树内自动发现
        // （仓库自带 `src-tauri/pdfium/pdfium.dll`），无需测试注入环境变量。
        let root = repo_root();
        let out_dir = root.join("docs").join("p5");
        std::fs::create_dir_all(&out_dir).expect("mkdir docs/p5");
        let target = out_dir.join("f008-sample.pdf");

        let paragraphs: Vec<String> = (0..3)
            .map(|i| format!("第{}段：林舟推开门，屋里的灯还亮着。夜色从窗缝里渗进来。", i + 1))
            .collect();

        let report = export_pdf(&PdfExportRequest {
            project_root: root.clone(),
            target: target.to_string_lossy().to_string(),
            title: "F-008 样本".to_string(),
            paragraphs: paragraphs.clone(),
            font_path: None,
        })
        .expect("导出应成功");

        assert!(report.bytes_written > 10_000, "产物过小：{}", report.bytes_written);
        assert!(report.pages >= 1);
        assert_eq!(report.font, CJK_FONT_FILE);
        assert_eq!(report.line_height_ratio, 1.5);

        let bytes = std::fs::read(&target).expect("read pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("NotoSerifCJKsc"),
            "PDF 内未出现嵌入字体名（字体未嵌入？）"
        );

        // 回读：页数与中文内容一致 → 文本对象确实带着 CJK 内容写入。
        {
            use pdfium_render::prelude::*;
            let _guard = crate::commands::fs::lock_pdfium();
            let pdfium = crate::commands::fs::pdfium().expect("pdfium");
            let doc = pdfium
                .load_pdf_from_file(&target, None)
                .expect("reload exported pdf");
            assert_eq!(doc.pages().len() as usize, report.pages);
            let first = doc.pages().get(0).expect("page 0");
            let extracted = first.text().expect("page text").all();
            // 注意：pdfium + Noto Serif CJK 会把部分汉字回读为康熙部首等价字符
            // （舟 -> U+2F88、门 -> U+2ED4、色 -> U+2F8A、里 -> U+2F8B 等），字形本身正确。
            // 因此这里断言未受影响的字形 + 长度量级，而不是逐字相等。
            assert!(extracted.contains("推开"), "回读文本缺少中文：{extracted}");
            assert!(extracted.contains("亮着"), "回读文本缺少中文：{extracted}");
            assert!(
                extracted.chars().count() >= paragraphs[0].chars().count(),
                "回读文本长度异常：{extracted}"
            );
        }
    }
}
