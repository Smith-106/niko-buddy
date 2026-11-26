//! PDF 导出（F-008）：**只读投影** + 数据区路径硬拦 + CJK 字体嵌入。
//!
//! 三条不变量：
//! 1. 导出目标 MUST 落在数据区之外（`.novel/`、`QM/`、`.niko-buddy/`、`backups/` 一律拒绝）——
//!    导出产物是可再生的读物，绝不允许写回正文、记忆或投影目录；
//! 2. 中文必须**内嵌字体**（`NotoSerifCJKsc-Regular.otf`），不依赖读者机器上的字体；
//! 3. 行距固定 1.5 倍，页面尺寸 A4，正文来自调用方传入的只读文本切片。
//!
//! pdfium 只用于**生成与渲染校验**，绑定生命周期复用既有全局单例
//! （`commands::fs::pdfium()` / `lock_pdfium()`），不新建第二套绑定。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
/// 数据区目录名（一律不可作为导出目标；保留旧公开常量兼容外部引用）。
pub const DATA_SECTIONS: [&str; 4] = [".novel", "QM", ".niko-buddy", "backups"];
/// 完整导出禁止数据区路径段（小写归一后匹配，用于校验落在 `project_root` 内部的路径）。
const FORBIDDEN_EXPORT_SEGMENTS: [&str; 7] = [
    ".novel",
    "qm",
    "wiki",
    ".niko-buddy",
    "canon",
    "backups",
    ".qm-drafts",
];
/// 强特征数据区目录段：即使独立导出（无 `project_root`）也一律禁止。
const STRONG_DATA_SEGMENTS: [&str; 3] = [".novel", ".niko-buddy", ".qm-drafts"];
/// 项目通用词数据区目录段：仅当其直接父目录存在 `.novel` 目录或 `.novel/status.json`（真实项目根）时拦截，
/// 避免误杀项目外用户目录（如 `D:\Backups\book.docx`、`D:\wiki\book.epub`）。
const PROJECT_DATA_SEGMENTS: [&str; 4] = ["qm", "wiki", "canon", "backups"];
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

/// 剥离 Windows canonicalize 产出的 `//?/` / `//?/UNC/` 逐字前缀，确保词法路径与规范化路径可一致比较。
pub(crate) fn strip_windows_verbatim_prefix(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("//?/UNC/") {
        rest
    } else if let Some(rest) = text.strip_prefix("//?/") {
        rest
    } else {
        text
    }
}

fn is_windows_drive_segment(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn clean_export_segment(seg: &str) -> &str {
    let without_ads = seg.split(':').next().unwrap_or(seg);
    without_ads.trim_end_matches(['.', ' '])
}

pub(crate) fn has_illegal_colon(path_str: &str) -> bool {
    let replaced = path_str.replace('\\', "/");
    for seg in replaced.split('/') {
        if seg.is_empty() || seg == "?" || is_windows_drive_segment(seg) {
            continue;
        }
        if seg.contains(':') {
            return true;
        }
    }
    false
}

fn is_symlink_or_reparse_point(path: &Path) -> bool {
    crate::agent_gate_policy::is_symlink_or_reparse_point(path)
}

fn is_macos_system_symlink(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        matches!(path.to_str(), Some("/var" | "/tmp" | "/etc"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

pub(crate) fn assert_no_symlink_in_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() || ancestor.file_name().is_none() {
            break;
        }
        if !is_macos_system_symlink(ancestor) && is_symlink_or_reparse_point(ancestor) {
            return Err(format!(
                "export path '{}' traverses symlink or reparse point '{}'",
                path.display(),
                ancestor.display()
            ));
        }
    }
    Ok(())
}

pub(crate) fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    loop {
        if cur.exists() {
            let mut base = std::fs::canonicalize(cur).ok()?;
            for part in tail.into_iter().rev() {
                base.push(part);
            }
            return Some(base);
        }
        let name = cur.file_name()?.to_os_string();
        tail.push(name);
        cur = cur.parent()?;
        if cur.as_os_str().is_empty() {
            return None;
        }
    }
}

fn check_segments_outside_data_sections(
    raw: &[String],
    folded: &[String],
    scope_desc: &str,
) -> Result<(), String> {
    if raw.iter().any(|s| s == "..") {
        return Err(format!("target escapes via '..': {scope_desc}"));
    }
    for seg in raw.iter().chain(folded.iter()) {
        if is_windows_drive_segment(seg) {
            continue;
        }
        let cleaned = clean_export_segment(seg);
        if FORBIDDEN_EXPORT_SEGMENTS.contains(&cleaned) {
            return Err(format!(
                "target '{scope_desc}' is inside data section '{cleaned}'"
            ));
        }
    }
    Ok(())
}

fn is_project_root_dir(dir: &Path) -> bool {
    let probe = if dir.as_os_str().is_empty() {
        Path::new(".")
    } else {
        dir
    };
    let novel_dir = probe.join(".novel");
    novel_dir.is_dir() || novel_dir.join("status.json").is_file()
}

fn check_standalone_path_components(path: &Path, scope_desc: &str) -> Result<(), String> {
    let mut prefix = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                return Err(format!("target escapes via '..': {scope_desc}"));
            }
            std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::CurDir => {
                prefix.push(comp.as_os_str());
            }
            std::path::Component::Normal(os_seg) => {
                let lower = os_seg.to_string_lossy().to_ascii_lowercase();
                let cleaned = clean_export_segment(&lower);
                if STRONG_DATA_SEGMENTS.contains(&cleaned) {
                    return Err(format!(
                        "target '{scope_desc}' is inside data section '{cleaned}'"
                    ));
                }
                if PROJECT_DATA_SEGMENTS.contains(&cleaned) && is_project_root_dir(&prefix) {
                    return Err(format!(
                        "target '{scope_desc}' is inside project data section '{cleaned}'"
                    ));
                }
                prefix.push(os_seg);
            }
        }
    }
    Ok(())
}

/// 独立导出路径安全校验（DOCX / EPUB 等无 `project_root` 场景共用）：
/// 1. 基础安全校验：非空、无控制字节、有文件名、无非法 NTFS ADS `:`、无 `..`、无符号链接/Windows 重解析点；
/// 2. 强特征目录（`.novel` / `.niko-buddy` / `.qm-drafts`）始终禁止；
/// 3. 通用词段（`backups` / `wiki` / `qm` / `canon`）仅当其直接父目录为真实项目根（存在 `.novel` 目录或 `.novel/status.json`）时拦截，
///    放行 `D:\Backups\book.docx`、`D:\wiki\book.epub` 等合法项目外目录。
pub(crate) fn assert_standalone_export_path_safe(target: &Path) -> Result<(), String> {
    let raw_str = target.to_string_lossy();
    if raw_str.trim().is_empty() {
        return Err("export path must not be empty".to_string());
    }
    if raw_str.chars().any(|c| (c as u32) < 0x20) {
        return Err(format!("export path contains control bytes: {raw_str}"));
    }
    if target.file_name().is_none() {
        return Err(format!("export path has no file name: {raw_str}"));
    }
    if has_illegal_colon(&raw_str) {
        return Err(format!(
            "export path contains illegal NTFS ADS colon: {raw_str}"
        ));
    }

    let target_norm = normalized(target);
    let (raw, _) = crate::agent_gate_policy::normalized_lower_segments(
        strip_windows_verbatim_prefix(&target_norm),
    );
    if raw.iter().any(|s| s == "..") {
        return Err(format!("target escapes via '..': {raw_str}"));
    }

    check_standalone_path_components(target, &raw_str)?;
    assert_no_symlink_in_path(target)?;

    if let Some(canon) = canonicalize_existing_prefix(target) {
        let canon_norm = normalized(&canon);
        let (c_raw, _) = crate::agent_gate_policy::normalized_lower_segments(
            strip_windows_verbatim_prefix(&canon_norm),
        );
        if c_raw.iter().any(|s| s == "..") {
            return Err(format!("target escapes via '..': {raw_str}"));
        }
        check_standalone_path_components(&canon, &raw_str)?;
    }
    Ok(())
}

/// 硬拦：导出目标若落在 `project_root` 内部，不得落在项目数据区内；
/// 若规范化后位于 `project_root` 外部，仅执行基础安全校验（非空、无控制字节、无非法 ADS、无 `..`、无符号链接、有文件名），
/// 不对项目外无关祖先目录（如 `D:\Backups\book.pdf`）套用项目数据区黑名单。
pub fn assert_export_path_outside_data_sections(
    project_root: &Path,
    target: &Path,
) -> Result<PathBuf, PdfExportError> {
    let raw_target_str = target.to_string_lossy();
    if raw_target_str.trim().is_empty() {
        return Err(PdfExportError::PathInsideDataSection(
            "target path must not be empty".to_string(),
        ));
    }
    if raw_target_str.chars().any(|c| (c as u32) < 0x20) {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target contains control bytes: {raw_target_str}"
        )));
    }
    if has_illegal_colon(&raw_target_str) {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target contains illegal ADS colon: {raw_target_str}"
        )));
    }

    let raw_target_norm = normalized(target);
    let (target_raw, _) = crate::agent_gate_policy::normalized_lower_segments(
        strip_windows_verbatim_prefix(&raw_target_norm),
    );
    if target_raw.iter().any(|s| s == "..") {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target escapes the project root: {raw_target_str}"
        )));
    }

    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        project_root.join(target)
    };
    if resolved.file_name().is_none() {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target has no file name: {}",
            normalized(&resolved)
        )));
    }

    let resolved_text = normalized(&resolved);
    let root_text = normalized(project_root);
    let (res_raw, res_folded) = crate::agent_gate_policy::normalized_lower_segments(
        strip_windows_verbatim_prefix(&resolved_text),
    );
    let (root_raw, root_folded) = crate::agent_gate_policy::normalized_lower_segments(
        strip_windows_verbatim_prefix(&root_text),
    );

    if res_raw.iter().any(|s| s == "..") {
        return Err(PdfExportError::PathInsideDataSection(format!(
            "target escapes the project root: {resolved_text}"
        )));
    }

    let lex_in_project = (!target.is_absolute())
        || (!root_folded.is_empty() && res_folded.starts_with(&root_folded));
    if lex_in_project {
        if !root_folded.is_empty() && res_folded == root_folded {
            return Err(PdfExportError::PathInsideDataSection(format!(
                "target resolves to the project root: {resolved_text}"
            )));
        }
        let rel_folded = if !root_folded.is_empty() && res_folded.starts_with(&root_folded) {
            &res_folded[root_folded.len()..]
        } else {
            res_folded.as_slice()
        };
        let rel_raw = if !root_raw.is_empty() && res_raw.starts_with(&root_raw) {
            &res_raw[root_raw.len()..]
        } else if !root_folded.is_empty() && res_folded.starts_with(&root_folded) {
            rel_folded
        } else {
            res_raw.as_slice()
        };
        if rel_folded.is_empty() {
            return Err(PdfExportError::PathInsideDataSection(format!(
                "target resolves to the project root: {resolved_text}"
            )));
        }
        check_segments_outside_data_sections(rel_raw, rel_folded, &resolved_text)
            .map_err(PdfExportError::PathInsideDataSection)?;
    }

    assert_no_symlink_in_path(&resolved).map_err(PdfExportError::PathInsideDataSection)?;

    if let (Some(canon_resolved), Ok(canon_root)) = (
        canonicalize_existing_prefix(&resolved),
        std::fs::canonicalize(project_root),
    ) {
        let canon_text = normalized(&canon_resolved);
        let canon_root_text = normalized(&canon_root);
        let (c_raw, c_folded) = crate::agent_gate_policy::normalized_lower_segments(
            strip_windows_verbatim_prefix(&canon_text),
        );
        let (cr_raw, cr_folded) = crate::agent_gate_policy::normalized_lower_segments(
            strip_windows_verbatim_prefix(&canon_root_text),
        );
        if !cr_folded.is_empty() && c_folded.starts_with(&cr_folded) {
            if c_folded == cr_folded {
                return Err(PdfExportError::PathInsideDataSection(format!(
                    "target resolves to the project root: {canon_text}"
                )));
            }
            let c_rel_folded = &c_folded[cr_folded.len()..];
            let c_rel_raw = if !cr_raw.is_empty() && c_raw.starts_with(&cr_raw) {
                &c_raw[cr_raw.len()..]
            } else {
                c_rel_folded
            };
            check_segments_outside_data_sections(c_rel_raw, c_rel_folded, &canon_text)
                .map_err(PdfExportError::PathInsideDataSection)?;
        }
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
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
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

struct PdfTempGuard {
    path: PathBuf,
    armed: bool,
}

impl PdfTempGuard {
    fn new(target: &Path) -> Result<Self, PdfExportError> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).map_err(|e| PdfExportError::Io(e.to_string()))?;
        for _ in 0..1024 {
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let tmp = parent.join(format!(".nb-pdf-{}-{seq}.tmp", std::process::id()));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
            {
                Ok(file) => {
                    // 立即关闭句柄以防 Windows 占用冲突，由 pdfium 覆写该唯一临时文件
                    drop(file);
                    return Ok(Self {
                        path: tmp,
                        armed: true,
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(PdfExportError::Io(e.to_string())),
            }
        }
        Err(PdfExportError::Io(
            "failed to allocate unique temporary pdf file".to_string(),
        ))
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PdfTempGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// 生成 PDF。同步实现（BLOCKING-5 锁序不变量）：
/// 1. 先持 `PDFIUM_LOCK` (T5) 渲染到同目录唯一临时文件 `.nb-pdf-{pid}-{seq}.tmp`；
/// 2. 显式 `drop(document)` 与 `drop(_guard)` 释放 `PDFIUM_LOCK` (T5)；
/// 3. 再获取 `lock_file_mutations()` (T4)，二次校验目标非符号链接/非数据区后原子替换。
pub fn export_pdf(request: &PdfExportRequest) -> Result<PdfExportReport, PdfExportError> {
    use pdfium_render::prelude::*;

    let target = assert_export_path_outside_data_sections(
        &request.project_root,
        Path::new(&request.target),
    )?;
    let font_path = resolve_cjk_font(&request.project_root, request.font_path.as_deref())?;

    let mut temp_guard = PdfTempGuard::new(&target)?;

    let pages = {
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
                let mut object =
                    PdfPageTextObject::new(&document, line, font_token, PdfPoints::new(font_size))
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

        document
            .save_to_file(&temp_guard.path)
            .map_err(|e| PdfExportError::Render(format!("save failed: {e}")))?;
        // BLOCKING-5：按 page → document → PDFIUM_LOCK (T5) 顺序显式释放，绝不持 T5 再取 T4！
        drop(page);
        drop(document);
        drop(_guard);
        pages
    };

    let bytes_written = {
        let _mutation = crate::commands::fs::lock_file_mutations().map_err(PdfExportError::Io)?;
        assert_export_path_outside_data_sections(&request.project_root, &target)?;
        if is_symlink_or_reparse_point(&target) {
            return Err(PdfExportError::PathInsideDataSection(format!(
                "target '{}' is a symlink or reparse point",
                target.display()
            )));
        }
        std::fs::rename(&temp_guard.path, &target)
            .map_err(|e| PdfExportError::Io(format!("atomic replace failed: {e}")))?;
        temp_guard.disarm();
        std::fs::metadata(&target)
            .map(|m| m.len())
            .map_err(|e| PdfExportError::Io(e.to_string()))?
    };

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
        tauri::async_runtime::spawn_blocking(move || {
            crate::panic_guard::run_guarded("export_pdf", || {
                let safe_target = assert_export_path_outside_data_sections(
                    Path::new(&project_path),
                    Path::new(&target),
                )
                .map_err(|e| e.to_string())?;
                let request = PdfExportRequest {
                    project_root: PathBuf::from(&project_path),
                    target: safe_target.to_string_lossy().to_string(),
                    title,
                    paragraphs,
                    font_path: None,
                };
                super::export_pdf(&request).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("export_pdf blocking task join error: {e}"))?
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
        let err =
            assert_export_path_outside_data_sections(&root, Path::new(".novel/exports/book.pdf"))
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
        let err = assert_export_path_outside_data_sections(&root, Path::new("QM/exports/book.pdf"))
            .expect_err("QM 必须拒绝");
        assert!(matches!(err, PdfExportError::PathInsideDataSection(_)));
        assert!(
            assert_export_path_outside_data_sections(&root, Path::new(".niko-buddy/book.pdf"))
                .is_err()
        );
        assert!(
            assert_export_path_outside_data_sections(&root, Path::new("backups/a/b.pdf")).is_err()
        );
        // 越界同样拒绝。
        assert!(
            assert_export_path_outside_data_sections(&root, Path::new("../escape.pdf")).is_err()
        );
    }

    #[test]
    fn accepts_export_target_outside_data_sections() {
        let root = repo_root();
        let ok = assert_export_path_outside_data_sections(&root, Path::new("exports/book.pdf"))
            .expect("数据区之外应通过");
        assert!(
            ok.to_string_lossy().ends_with("exports/book.pdf")
                || ok.to_string_lossy().ends_with("exports\\book.pdf")
        );
        // 长得像数据区但路径段不同的目录不受影响。
        assert!(assert_export_path_outside_data_sections(
            &root,
            Path::new("book/.novelish/notes.pdf")
        )
        .is_ok());
    }

    #[test]
    fn rejects_case_variants_ads_trailing_dots_and_extra_data_sections() {
        let root = repo_root();
        for bad in [
            "qm/out.pdf",
            "Qm./out.pdf",
            "QM:ads/out.pdf",
            "exports/book.pdf:stream",
            "wiki/out.pdf",
            "WiKi/out.pdf",
            "canon/out.pdf",
            ".qm-drafts/out.pdf",
            ".NOVEL/out.pdf",
            "exports/../QM/out.pdf",
        ] {
            assert!(
                assert_export_path_outside_data_sections(&root, Path::new(bad)).is_err(),
                "expected project export guard to reject {bad:?}"
            );
        }
        // 独立导出对强特征目录、ADS 与 `..` 始终无条件拒绝。
        for always_bad in [
            "QM:ads/out.docx",
            "exports/book.docx:stream",
            ".qm-drafts/out.docx",
            ".NOVEL/out.docx",
            ".niko-buddy/out.epub",
            "exports/../QM/out.docx",
        ] {
            assert!(
                assert_standalone_export_path_safe(Path::new(always_bad)).is_err(),
                "expected standalone export guard to reject {always_bad:?}"
            );
        }
        assert!(assert_standalone_export_path_safe(Path::new("exports/book.docx")).is_ok());
    }

    #[test]
    fn allows_external_backups_and_wiki_while_blocking_real_project_data_sections() {
        let base =
            std::env::temp_dir().join(format!("niko-pdf-guard-r2-01-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("my-novel");
        std::fs::create_dir_all(project.join(".novel")).expect("mkdir .novel");
        let external_backups = base.join("Backups");
        let external_wiki = base.join("wiki");
        std::fs::create_dir_all(&external_backups).expect("mkdir Backups");
        std::fs::create_dir_all(&external_wiki).expect("mkdir wiki");

        // 1) 项目外合法目录（Backups/wiki）放行 PDF / DOCX / EPUB
        assert!(
            assert_export_path_outside_data_sections(&project, &external_backups.join("book.pdf"))
                .is_ok(),
            "项目外 Backups/book.pdf 不应被误杀"
        );
        assert!(
            assert_export_path_outside_data_sections(&project, &external_wiki.join("book.pdf"))
                .is_ok(),
            "项目外 wiki/book.pdf 不应被误杀"
        );
        assert!(
            assert_standalone_export_path_safe(&external_backups.join("book.docx")).is_ok(),
            "独立导出到非项目根下的 Backups/book.docx 应放行"
        );
        assert!(
            assert_standalone_export_path_safe(&external_wiki.join("book.epub")).is_ok(),
            "独立导出到非项目根下的 wiki/book.epub 应放行"
        );

        // 2) 真实项目根（含 .novel/）下的数据区目录仍严格拒绝
        for bad_rel in [
            "QM/book.docx",
            "Qm./book.docx",
            "backups/book.epub",
            "wiki/book.docx",
            "canon/book.epub",
            ".novel/book.docx",
            ".niko-buddy/book.epub",
            ".qm-drafts/book.docx",
        ] {
            let bad_path = project.join(bad_rel);
            assert!(
                assert_standalone_export_path_safe(&bad_path).is_err(),
                "真实项目根下的 {bad_rel} 必须被独立导出拦截"
            );
            assert!(
                assert_export_path_outside_data_sections(&project, &bad_path).is_err(),
                "真实项目根下的 {bad_rel} 必须被项目导出拦截"
            );
        }

        // 3) 若项目本身位于名为 Backups 的外层目录下，项目内 exports/ 仍放行，而项目内 backups/ 仍拦截
        let nested_project = external_backups.join("nested-novel");
        std::fs::create_dir_all(nested_project.join(".novel")).expect("mkdir nested .novel");
        assert!(assert_export_path_outside_data_sections(
            &nested_project,
            &nested_project.join("exports").join("book.pdf")
        )
        .is_ok());
        assert!(assert_standalone_export_path_safe(
            &nested_project.join("exports").join("book.docx")
        )
        .is_ok());
        assert!(assert_export_path_outside_data_sections(
            &nested_project,
            &nested_project.join("backups").join("book.pdf")
        )
        .is_err());
        assert!(assert_standalone_export_path_safe(
            &nested_project.join("backups").join("book.epub")
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&base);
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

    /// pdfium 动态库可用性：CI 极简环境可能没有（见 commands::fs::pdfium_dynamic_library_present），
    /// 渲染类用例据此跳过而非误报缺陷。
    fn pdfium_available() -> bool {
        crate::commands::fs::pdfium_dynamic_library_present()
    }

    /// 生成 F-008 交付样本 docs/p5/f008-sample.pdf（返回报告与段落，供断言复用）。
    fn write_f008_sample(root: &std::path::Path) -> (PdfExportReport, Vec<String>) {
        let out_dir = root.join("docs").join("p5");
        std::fs::create_dir_all(&out_dir).expect("mkdir docs/p5");
        let target = out_dir.join("f008-sample.pdf");
        let paragraphs: Vec<String> = (0..3)
            .map(|i| {
                format!(
                    "第{}段：林舟推开门，屋里的灯还亮着。夜色从窗缝里渗进来。",
                    i + 1
                )
            })
            .collect();
        let report = export_pdf(&PdfExportRequest {
            project_root: root.to_path_buf(),
            target: target.to_string_lossy().to_string(),
            title: "F-008 样本".to_string(),
            paragraphs: paragraphs.clone(),
            font_path: None,
        })
        .expect("导出应成功");
        (report, paragraphs)
    }

    /// 真实生成一份中文 PDF 并做机械核验：字体已嵌入 + 中文可回读 + 页数一致。
    #[test]
    fn exports_cjk_sample_with_embedded_font() {
        if !pdfium_available() {
            eprintln!("skip: pdfium 动态库不可用，跳过导出用例");
            return;
        }
        // pdfium 动态库由 `commands::fs::pdfium_candidate_paths()` 在源码树内自动发现
        // （仓库自带 `src-tauri/pdfium/pdfium.dll` / `libpdfium.dylib` / `libpdfium.so`），
        // 无需测试注入环境变量。
        let root = repo_root();
        let (report, paragraphs) = write_f008_sample(&root);
        let target = root.join("docs").join("p5").join("f008-sample.pdf");

        assert!(
            report.bytes_written > 10_000,
            "产物过小：{}",
            report.bytes_written
        );
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

    /// 空段（空行）导出探针：wrap_paragraph 对空段返回 [""]，空串直接进
    /// PdfPageTextObject::new —— 若 pdfium 拒绝空串，含空行章节的导出会整体失败。
    #[test]
    fn exports_with_empty_paragraphs() {
        if !pdfium_available() {
            eprintln!("skip: pdfium 动态库不可用，跳过导出用例");
            return;
        }
        let root = repo_root();
        let out_dir = root.join("docs").join("p5");
        std::fs::create_dir_all(&out_dir).expect("mkdir docs/p5");
        let target = out_dir.join("empty-paragraph-probe.pdf");
        let report = export_pdf(&PdfExportRequest {
            project_root: root.clone(),
            target: target.to_string_lossy().to_string(),
            title: "空段探针".to_string(),
            paragraphs: vec![
                "首段内容".to_string(),
                String::new(),
                "空行之后的内容".to_string(),
            ],
            font_path: None,
        })
        .expect("含空行导出应成功");
        assert!(report.pages >= 1);
        let _ = std::fs::remove_file(&target);
    }

    /// 渲染 PDF 第 1 页并量测文本行带：返回 (行带质心 px, 页高 pt, 图像高 px)。
    /// 量测对象是**渲染像素**而非生成代码里的常量，因此能独立验证声明的行距。
    fn render_and_measure(
        pdf_path: &std::path::Path,
        png_path: Option<&std::path::Path>,
        scale: f32,
    ) -> (Vec<(f64, u32)>, f64, u32) {
        use pdfium_render::prelude::*;
        let _guard = crate::commands::fs::lock_pdfium();
        let pdfium = crate::commands::fs::pdfium().expect("pdfium");
        let doc = pdfium.load_pdf_from_file(pdf_path, None).expect("load pdf");
        assert!(!doc.pages().is_empty(), "PDF 至少一页");
        let page = doc.pages().get(0).expect("page 0");
        let page_h_pt = page.height().value as f64;

        let cfg = PdfRenderConfig::new().scale_page_by_factor(scale);
        let img = page
            .render_with_config(&cfg)
            .expect("render page 0")
            .as_image()
            .expect("bitmap -> image")
            .to_luma8();
        if let Some(p) = png_path {
            img.save_with_format(p, image::ImageFormat::Png)
                .expect("save png");
        }

        let (w, h) = img.dimensions();
        // 背景 = 出现次数最多的灰度（不假定页面色极性）。
        let mut hist = [0u32; 256];
        for p in img.pixels() {
            hist[p.0[0] as usize] += 1;
        }
        let bg = hist
            .iter()
            .enumerate()
            .max_by_key(|(_, c)| **c)
            .map(|(i, _)| i as i32)
            .expect("histogram non-empty");

        // 逐行墨迹量 → 文本行带 → 带质心（行位置的稳健代理）。
        let mut rows = vec![0u32; h as usize];
        for (i, p) in img.pixels().enumerate() {
            if (p.0[0] as i32 - bg).abs() > 64 {
                rows[i / w as usize] += 1;
            }
        }
        let mut bands: Vec<(f64, u32)> = Vec::new();
        let mut cur: Option<(usize, u32, f64)> = None; // last_row, ink, weighted
        for (y, ink) in rows.iter().enumerate() {
            if *ink == 0 {
                continue;
            }
            match cur.as_mut() {
                Some((last, total, weighted)) if y - *last <= 2 => {
                    *last = y;
                    *total += ink;
                    *weighted += (y as f64) * (*ink as f64);
                }
                Some((last, total, weighted)) => {
                    bands.push((*weighted / *total as f64, *total));
                    *last = y;
                    *total = *ink;
                    *weighted = (y as f64) * (*ink as f64);
                }
                None => cur = Some((y, *ink, (y as f64) * (*ink as f64))),
            }
        }
        if let Some((_, total, weighted)) = cur {
            bands.push((weighted / total as f64, total));
        }
        // 噪声带（几乎无墨迹）剔除。
        let bands: Vec<(f64, u32)> = bands.into_iter().filter(|(_, t)| *t >= 50).collect();
        (bands, page_h_pt, h)
    }

    fn deltas_pt(bands: &[(f64, u32)], page_h_pt: f64, px_h: u32) -> Vec<f64> {
        let pt_per_px = page_h_pt / px_h as f64;
        bands
            .windows(2)
            .map(|w| (w[1].0 - w[0].0) * pt_per_px)
            .collect()
    }

    /// F-008 目视证据链：把交付样本第 1 页用 pdfium **渲染**成 PNG，并从渲染像素量测行距。
    /// 边界声明：本用例产出的是客观渲染证据 + 机械量测，**不构成人工目视结论**；
    /// 人工目视仍需用户用系统阅读器确认。
    #[test]
    fn renders_sample_page_and_measures_line_spacing() {
        if !pdfium_available() {
            eprintln!("skip: pdfium 动态库不可用，跳过渲染量测用例");
            return;
        }
        let root = repo_root();
        let pdf_path = root.join("docs").join("p5").join("f008-sample.pdf");
        if !pdf_path.exists() {
            // 交付样本由 exports_cjk_sample_with_embedded_font 生成，但 cargo test 并行
            // 不保证其先落地（CI 全新 checkout 必缺失）——缺失时就地补生成，消除顺序依赖。
            let _ = write_f008_sample(&root);
        }
        let png_path = root.join("docs").join("p5").join("f008-sample-p1.png");

        let (bands, page_h_pt, px_h) = render_and_measure(&pdf_path, Some(&png_path), 2.0);
        let deltas = deltas_pt(&bands, page_h_pt, px_h);
        let png_bytes = std::fs::metadata(&png_path).map(|m| m.len()).unwrap_or(0);

        // 客观灰度统计 + 首行放大裁剪：给人工/多模态目视提供不需要缩放就能看清的素材。
        let (min_luma, dark_px, bg_luma, crop_path, crop_size) = {
            let img = image::open(&png_path).expect("open png").to_luma8();
            let mut min_luma = 255u8;
            let mut dark_px = 0usize;
            let mut hist = [0u32; 256];
            for p in img.pixels() {
                let v = p.0[0];
                hist[v as usize] += 1;
                if v < min_luma {
                    min_luma = v;
                }
                if v < 128 {
                    dark_px += 1;
                }
            }
            let bg_luma = hist
                .iter()
                .enumerate()
                .max_by_key(|(_, c)| **c)
                .map(|(i, _)| i as u8)
                .unwrap_or(255);
            let (w, h) = img.dimensions();
            let cy = bands[0].0.round() as u32;
            let top = cy.saturating_sub(24).min(h.saturating_sub(1));
            let bottom = (cy + 24).min(h);
            let crop = image::imageops::crop_imm(&img, 0, top, w, bottom - top).to_image();
            let crop_path = pdf_path.with_file_name("f008-sample-p1-line1.png");
            crop.save_with_format(&crop_path, image::ImageFormat::Png)
                .expect("save crop");
            let crop_size = std::fs::metadata(&crop_path).map(|m| m.len()).unwrap_or(0);
            (min_luma, dark_px, bg_luma, crop_path, crop_size)
        };
        println!(
            "[F-008] 灰度：背景={bg_luma}, 最暗={min_luma}, 深色像素={dark_px}, 首行裁剪={} ({} bytes)",
            crop_path.display(),
            crop_size
        );

        println!(
            "[F-008] PNG={} ({} bytes), 图像高 {} px, 页高 {:.0}pt",
            png_path.display(),
            png_bytes,
            px_h,
            page_h_pt
        );
        for (i, (y, ink)) in bands.iter().enumerate() {
            println!("[F-008] 行带{i}: 质心 y={y:.1}px 墨迹={ink}");
        }
        let shown: Vec<String> = deltas.iter().map(|d| format!("{d:.2}")).collect();
        println!("[F-008] 相邻行带间距(pt): {}", shown.join(", "));

        assert!(
            png_bytes > 10_000,
            "PNG 过小，渲染可能失败：{png_bytes} bytes"
        );
        assert!(
            dark_px > 5_000,
            "渲染结果深色像素过少（{dark_px}），文字可能未真正绘制"
        );
        // 样本 = 3 个单行段落，无折行；因此能测到的是**段间距**（段间空一行 = 2 × 1.5 × 11 = 33pt）。
        assert_eq!(bands.len(), 3, "样本应恰好 3 个文本行带（3 个单行段落）");
        let expected_para = (DEFAULT_FONT_SIZE_PT * LINE_HEIGHT_RATIO * 2.0) as f64;
        for d in &deltas {
            assert!(
                (*d - expected_para).abs() <= 0.8,
                "段间距应为 {expected_para}pt（1.5 行距 + 段间空一行），实测 {d:.2}pt，全部：{deltas:?}"
            );
        }
    }

    /// 折行段落的**段内行距**硬判据：量测对象是临时生成的多行 PDF
    /// （不入库，避免把测量用例污染到交付样本），确认 11pt 字号的行基线差 = 16.5pt。
    #[test]
    fn wrapped_lines_keep_one_point_five_leading() {
        if !pdfium_available() {
            eprintln!("skip: pdfium 动态库不可用，跳过折行量测用例");
            return;
        }
        let root = repo_root();
        let tmp = temp_dir("lead");
        let target = tmp.join("wrap.pdf");
        let font = resolve_cjk_font(&root, None).expect("字体资产");
        // 130 字 -> 按 43 字/行折成 4 行，足以量测段内行距。
        let long: String =
            "林舟推开门，屋里的灯还亮着。夜色从窗缝里渗进来，落在桌角的信纸上。".repeat(4);
        let report = export_pdf(&PdfExportRequest {
            project_root: tmp.clone(),
            target: target.to_string_lossy().to_string(),
            title: "折行量测".to_string(),
            paragraphs: vec![long.clone()],
            font_path: Some(font.clone()),
        })
        .expect("导出折行样本");
        assert!(report.bytes_written > 10_000);

        let (bands, page_h_pt, px_h) = render_and_measure(&target, None, 2.0);
        let deltas = deltas_pt(&bands, page_h_pt, px_h);
        println!(
            "[F-008] 折行段落：{} 字 -> {} 行带，段内行距(pt) {:?}",
            long.chars().count(),
            bands.len(),
            deltas.iter().map(|d| format!("{d:.2}")).collect::<Vec<_>>()
        );
        assert!(
            bands.len() >= 3,
            "折行样本行带过少（{}），无法量测段内行距",
            bands.len()
        );
        let expected = (DEFAULT_FONT_SIZE_PT * LINE_HEIGHT_RATIO) as f64;
        for d in &deltas {
            assert!(
                (*d - expected).abs() <= 0.8,
                "段内行距应为 {expected}pt（11pt × 1.5），实测 {d:.2}pt，全部：{deltas:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
