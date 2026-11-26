// Copyright (c) 2024 Niko-hub contributors. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read as IoRead, Write};
#[cfg(windows)]
use std::os::windows::{
    fs::{MetadataExt, OpenOptionsExt},
    io::AsRawHandle,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{GENERIC_READ, HANDLE},
    Storage::FileSystem::{
        FileAttributeTagInfo, FileDispositionInfo, GetFileInformationByHandleEx,
        SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
    },
};

#[cfg(windows)]
const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
#[cfg(windows)]
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

use crate::commands::file_sync;
use crate::panic_guard::run_guarded;
use crate::types::wiki::FileNode;

use super::fs_archive::extract_html_file;

use super::fs_office::{extract_epub_text, extract_legacy_doc_text, extract_office_text};

// PDF 域（PDFium 绑定 / 动态库解析 / PDF 文本提取）已 verbatim 下沉至
// `fs_pdf.rs`（S5 拆分）。此处重导出保持既有调用路径不变。
// `pdfium_dynamic_library_present` 仅被 `pdf_export.rs` 的测试引用（生产零调用），
// 重导出本身在非测试构建下无人使用，故显式抑制该导入告警（函数侧已带 allow(dead_code)）。
pub(crate) use super::fs_pdf::{extract_pdf_text, lock_pdfium, pdfium, RESOURCE_DIR_HINT};
#[allow(unused_imports)]
pub use super::fs_pdf::{pdfium_dynamic_library_present, set_resource_dir_hint};

/// Known binary formats that need special extraction
const OFFICE_EXTS: &[&str] = &["docx", "pptx", "xlsx", "odt", "ods", "odp"];
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif", "svg",
];
const MEDIA_EXTS: &[&str] = &[
    "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v", "mp3", "wav", "ogg", "flac", "aac",
    "m4a", "wma",
];
const LEGACY_DOC_EXTS: &[&str] = &["doc", "xls", "ppt", "pages", "numbers", "key"];
pub(crate) const KNOWLEDGE_DIR: &str = "QM";

/// Bumped whenever the cached extraction output for any format might
/// change semantics (parser version, extraction rules, …). The value is
/// baked into the cache key (`{name}.v{N}.txt` in `cache_path_for`), so a
/// bump makes every pre-existing cache entry naturally miss and forces
/// re-extraction — no manual cache invalidation needed.
const EXTRACTOR_VERSION: u32 = 1;

const LEGACY_KNOWLEDGE_DIR: &str = "wiki";
const META_DIR: &str = ".niko-buddy";
const LEGACY_META_DIR: &str = ".llm-wiki";

// ISS-20260731-002 处置：真死删——`replace_last_path_segment`（单段替换）在本仓零引用
// （grep 仅定义点；多段场景由 `replace_all_path_segments` 承载）。已删除，误用时按需从 git 恢复。

/// Replace **all** path segments matching `from` with `to`.
/// Used when the path may contain multiple legacy directory names
/// (e.g. `wiki/outlines/1/wiki/chapters/xxx.md` → `QM/outlines/1/QM/chapters/xxx.md`).
fn replace_all_path_segments(path: &str, from: &str, to: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut changed = false;
    let replaced: Vec<String> = parts
        .iter()
        .map(|part| {
            if *part == from {
                changed = true;
                to.to_string()
            } else {
                part.to_string()
            }
        })
        .collect();
    if changed {
        Some(replaced.join("/"))
    } else {
        None
    }
}

/// 段级路径卫生守卫（纵深防御，SEC-005 残余，对齐 TS isSafeIngestPath 的段卫生部分
/// src/lib/ingest.ts:107-156）。仅拒绝路径卫生问题：
///   - NUL / 控制字节（\x00-\x1f）
///   - 归一化后任一段为 `..`
///   - 任一段含 Windows 非法字符 `<>:"|?*`（盘符段 `C:` 除外——绝对路径合法）
///   - 任一段以空格或 `.` 结尾
///   - Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，大小写不敏感）
///
/// 注意：不拒绝绝对路径——本仓库全部合法写入路径均为绝对路径（项目根拼接/对话框
/// 选择），绝对路径拒绝只存在于 TS 相对路径契约层（isSafeIngestPath 的 wiki/ 白名单）。
fn reject_unsafe_storage_path(path: &str) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    if normalized.trim().is_empty() {
        return Err("empty path".into());
    }
    if normalized.chars().any(|c| (c as u32) < 0x20) {
        return Err(format!("path contains control bytes: {path}"));
    }
    for seg in normalized.split('/') {
        if seg == ".." {
            return Err(format!("path contains '..' segment: {path}"));
        }
        // Windows drive letter (e.g. `C:`) is legal for absolute paths.
        if seg.is_empty()
            || (seg.len() == 2
                && seg.ends_with(':')
                && seg.chars().next().unwrap().is_ascii_alphabetic())
        {
            continue;
        }
        if seg.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return Err(format!(
                "path segment '{seg}' contains Windows-illegal chars: {path}"
            ));
        }
        if seg.ends_with(' ') || seg.ends_with('.') {
            return Err(format!("path segment '{seg}' ends with space/dot: {path}"));
        }
        let stem = seg
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit()
                && stem.as_bytes()[3] != b'0');
        if reserved {
            return Err(format!(
                "path segment '{seg}' uses Windows reserved name: {path}"
            ));
        }
    }
    Ok(())
}

pub(crate) fn resolve_project_storage_path(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");

    // 段级卫生守卫（纵深防御）：先拒绝再段替换，替换目标段均为安全常量。
    reject_unsafe_storage_path(&normalized)?;

    // 先尝试替换所有 .llm-wiki → .niko-buddy（可能有多个嵌套）
    if let Some(candidate) = replace_all_path_segments(&normalized, LEGACY_META_DIR, META_DIR) {
        if Path::new(&candidate).exists() || !Path::new(&normalized).exists() {
            return Ok(candidate);
        }
    }

    // 再尝试替换所有 wiki → QM（可能有多个嵌套）
    if let Some(candidate) =
        replace_all_path_segments(&normalized, LEGACY_KNOWLEDGE_DIR, KNOWLEDGE_DIR)
    {
        if Path::new(&candidate).exists() || !Path::new(&normalized).exists() {
            return Ok(candidate);
        }
    }

    Ok(normalized)
}

fn virtualize_project_storage_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.contains(&format!("/{KNOWLEDGE_DIR}/")) {
        return normalized.replace(
            &format!("/{KNOWLEDGE_DIR}/"),
            &format!("/{LEGACY_KNOWLEDGE_DIR}/"),
        );
    }
    if normalized.ends_with(&format!("/{KNOWLEDGE_DIR}")) {
        let prefix = normalized.trim_end_matches(&format!("/{KNOWLEDGE_DIR}"));
        return format!("{prefix}/{LEGACY_KNOWLEDGE_DIR}");
    }
    normalized
}

type TextExtractorFn = fn(&str) -> Result<String, String>;

/// B3 提取器注册表: ext→统一签名提取器。读/预处理两处分派共用同一张表,
/// 新增文本格式只需在此登记, 不再双处同步 match。office 多扩展名集合、
/// image/media 占位与兑底语义不同, 保留在各自分派处。
const TEXT_EXTRACTORS: &[(&str, TextExtractorFn)] = &[
    ("pdf", extract_pdf_text),
    ("epub", extract_epub_text),
    ("html", extract_html_file),
    ("htm", extract_html_file),
    ("doc", extract_legacy_doc_text),
];

fn lookup_text_extractor(ext: &str) -> Option<TextExtractorFn> {
    TEXT_EXTRACTORS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, f)| *f)
}

/// Core logic for `read_file`, callable from both Tauri commands and Axum handlers.
pub fn do_read_file(path: &str) -> Result<String, String> {
    run_guarded("read_file", || {
        let path = resolve_project_storage_path(path)?;
        let p = Path::new(&path);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if let Some(cached) = read_cache(p) {
            return Ok(cached);
        }

        // B3: 注册表命中的格式先走统一提取器 (原 pdf/epub/html/doc 分支等价迁移)
        if let Some(extract) = lookup_text_extractor(&ext) {
            return extract(&path);
        }

        match ext.as_str() {
            e if OFFICE_EXTS.contains(&e) => extract_office_text(&path, e),
            e if IMAGE_EXTS.contains(&e) => {
                let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                Ok(format!(
                    "[Image: {} ({:.1} KB)]",
                    p.file_name().unwrap_or_default().to_string_lossy(),
                    size as f64 / 1024.0
                ))
            }
            e if MEDIA_EXTS.contains(&e) => {
                let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                Ok(format!(
                    "[Media: {} ({:.1} MB)]",
                    p.file_name().unwrap_or_default().to_string_lossy(),
                    size as f64 / 1048576.0
                ))
            }
            e if LEGACY_DOC_EXTS.contains(&e) => Ok(format!(
                "[Document: {} \u{2014} text extraction not supported for .{} format]",
                p.file_name().unwrap_or_default().to_string_lossy(),
                e
            )),
            e if is_plain_text_ext(e) => read_plain_text_file(&path),
            _ => match fs::read_to_string(&path) {
                Ok(content) => Ok(content),
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                    Err(format!("INVALID_UTF8: '{}'", path))
                }
                Err(e) => {
                    let exists = p.exists();
                    if !exists {
                        Err(format!("File does not exist: '{}'", path))
                    } else {
                        Err(format!(
                                "Failed to read file '{}' as text: {} (likely binary, locked, or non-UTF-8)",
                                path, e,
                            ))
                    }
                }
            },
        }
    })
}

#[tauri::command]
pub async fn read_file(path: String, exact_utf8: Option<bool>) -> Result<String, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if exact_utf8.unwrap_or(false) {
            run_guarded("read_file_exact_utf8", || {
                let path = resolve_project_storage_path(&p)?;
                fs::read_to_string(&path).map_err(|err| match err.kind() {
                    ErrorKind::NotFound => format!("ENOENT: '{path}'"),
                    ErrorKind::InvalidData => format!("INVALID_UTF8: '{path}'"),
                    _ => format!("Failed to read exact UTF-8 from '{path}': {err}"),
                })
            })
        } else {
            do_read_file(&p)
        }
    })
    .await
    .map_err(|e| format!("read_file blocking task join error: {e}"))?
}

/// Core logic for `preprocess_file`, callable from both Tauri commands and Axum handlers.
pub fn do_preprocess_file(path: &str) -> Result<String, String> {
    run_guarded("preprocess_file", || {
        let path = resolve_project_storage_path(path)?;
        let p = Path::new(&path);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let text = match lookup_text_extractor(&ext) {
            // B3: 注册表统一提取 (原 pdf/epub/html/doc 分支等价迁移)
            Some(extract) => extract(&path)?,
            None => match ext.as_str() {
                e if OFFICE_EXTS.contains(&e) => extract_office_text(&path, e)?,
                e if is_plain_text_ext(e) => read_plain_text_file(&path)?,
                _ => return Ok("no preprocessing needed".to_string()),
            },
        };

        write_cache(p, &text)?;
        Ok(text)
    })
}

/// Pre-process a file and cache the extracted text.
#[tauri::command]
pub async fn preprocess_file(path: String) -> Result<String, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_preprocess_file(&p))
        .await
        .map_err(|e| format!("preprocess_file blocking task join error: {e}"))?
}

fn is_plain_text_ext(ext: &str) -> bool {
    matches!(ext, "txt" | "md" | "mdx")
}

fn read_plain_text_file(path: &str) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("Failed to read text file '{}': {}", path, e))?;
    Ok(decode_plain_text_bytes(&bytes))
}

fn decode_plain_text_bytes(bytes: &[u8]) -> String {
    if let Some(stripped) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(text) = String::from_utf8(stripped.to_vec()) {
            return text;
        }
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return text;
    }

    let (gbk_text, _, _) = encoding_rs::GBK.decode(bytes);
    gbk_text.into_owned()
}

/// Compute the cache file path for an original file. The key embeds
/// `EXTRACTOR_VERSION`, so a code change that alters extraction output
/// (new parser, new rules) invalidates *every* old cache simply by
/// changing the filename from `{name}.v{N}.txt` — the old files stay on
/// disk untouched but are never looked up again.
fn cache_path_for(original: &Path) -> std::path::PathBuf {
    let parent = original.parent().unwrap_or(Path::new("."));
    let cache_dir = parent.join(".cache");
    let file_name = original.file_name().unwrap_or_default().to_string_lossy();
    let cache_key = format!("{}.v{}.txt", file_name, EXTRACTOR_VERSION);

    // 如果缓存目录创建失败（如根目录无权限），回退到系统临时目录
    if fs::create_dir_all(&cache_dir).is_err() {
        return std::env::temp_dir()
            .join("niko-buddy-cache")
            .join(cache_key);
    }
    cache_dir.join(cache_key)
}

fn read_cache(original: &Path) -> Option<String> {
    let cache_path = cache_path_for(original);
    let original_modified = fs::metadata(original).ok()?.modified().ok()?;
    let cache_modified = fs::metadata(&cache_path).ok()?.modified().ok()?;
    if cache_modified >= original_modified {
        fs::read_to_string(&cache_path).ok()
    } else {
        None
    }
}

fn write_cache(original: &Path, text: &str) -> Result<(), String> {
    let cache_path = cache_path_for(original);
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    crate::commands::file_sync::mark_app_write_path(&cache_path);
    fs::write(&cache_path, text).map_err(|e| format!("Failed to write cache: {}", e))
}

static FILE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Serialize desktop and MCP file commits within this process.
pub(crate) fn lock_file_mutations() -> Result<MutexGuard<'static, ()>, String> {
    let guard = FILE_MUTATION_LOCK.lock().unwrap_or_else(|poisoned| {
        log::error!("[fs] FILE_MUTATION_LOCK poisoned; recovering");
        poisoned.into_inner()
    });
    Ok(guard)
}

pub fn do_write_file(path: &str, contents: &str) -> Result<(), String> {
    run_guarded("write_file", || {
        let _mutation = lock_file_mutations()?;
        let path = resolve_project_storage_path(path)?;
        let p = Path::new(&path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
        }
        file_sync::mark_app_write_path(p);
        fs::write(&path, contents)
            .map_err(|e| format!("Failed to write file '{}': {}", path, e))?;
        file_sync::mark_app_write_path(p);
        crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(p));
        Ok(())
    })
}

#[tauri::command]
pub async fn write_file(path: String, contents: String) -> Result<(), String> {
    let p = path.clone();
    let c = contents.clone();
    tauri::async_runtime::spawn_blocking(move || do_write_file(&p, &c))
        .await
        .map_err(|e| format!("write_file blocking task join error: {e}"))?
}

/// Core logic for `write_file_atomic`, callable from both Tauri commands and Axum handlers.
pub fn do_write_file_atomic(path: &str, contents: &str) -> Result<(), String> {
    run_guarded("write_file_atomic", || {
        let _mutation = lock_file_mutations()?;
        let path = resolve_project_storage_path(path)?;
        let p = Path::new(&path);
        // 守卫：正面写权威接线（草稿 accept / 用户回写权威审计）；仅在明确 Deny 时硬拒，
        // 不误拦 user-assets 的 RequireGate。
        if crate::canon::write_authority::may_write(
            crate::canon::write_authority::WriteSource::UserEdit,
            p,
        ) == crate::canon::write_authority::WriteDecision::Deny
        {
            return Err(format!("Write authority denied for '{}'", path));
        }
        if p.file_name().is_none() {
            return Err(format!("Atomic write target has no file name: '{path}'"));
        }
        if let Some(parent) = p.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
        }

        write_atomic_physical_bytes(p, contents.as_bytes())?;
        crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(p));
        Ok(())
    })
}

struct StagedBytes {
    path: PathBuf,
    owned: bool,
}

impl StagedBytes {
    fn create_staged_file(
        target: &Path,
        reserved: Option<&HashSet<PathBuf>>,
    ) -> Result<(fs::File, Self), String> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let target_key = physical_batch_key(target);
        loop {
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path =
                target.with_file_name(format!(".nb-write-{}-{sequence}.tmp", std::process::id()));
            let key = physical_batch_key(&path);
            if key == target_key || reserved.is_some_and(|paths| paths.contains(&key)) {
                continue;
            }
            let file = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => file,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(format!(
                        "Failed to create temp file '{}': {e}",
                        path.display()
                    ))
                }
            };
            let staged = Self { path, owned: true };
            file_sync::mark_app_write_path(&staged.path);
            return Ok((file, staged));
        }
    }

    fn prepare(
        target: &Path,
        bytes: &[u8],
        reserved: Option<&HashSet<PathBuf>>,
    ) -> Result<Self, String> {
        let (mut file, staged) = Self::create_staged_file(target, reserved)?;
        let synced = file.write_all(bytes).and_then(|()| file.sync_all());
        // Windows 上先关闭句柄，失败时 Drop 才能清理当前暂存文件。
        drop(file);
        synced.map_err(|e| {
            format!(
                "Failed to write/sync temp file '{}': {e}",
                staged.path.display()
            )
        })?;
        Ok(staged)
    }

    fn prepare_from_reader(
        target: &Path,
        mut reader: impl IoRead,
        reserved: Option<&HashSet<PathBuf>>,
    ) -> Result<Self, String> {
        let (mut file, staged) = Self::create_staged_file(target, reserved)?;
        let synced = std::io::copy(&mut reader, &mut file).and_then(|_| file.sync_all());
        // Windows 上先关闭句柄，失败时 Drop 才能清理当前暂存文件。
        drop(file);
        synced.map_err(|e| {
            format!(
                "Failed to write/sync temp file '{}': {e}",
                staged.path.display()
            )
        })?;
        Ok(staged)
    }

    fn commit(
        &mut self,
        target: &Path,
        mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        file_sync::mark_app_write_path(target);
        #[cfg(windows)]
        let result = {
            const RETRY_DELAYS_MS: [u64; 3] = [25, 50, 100];
            let mut attempt = 0;
            loop {
                match rename(&self.path, target) {
                    Ok(()) => break Ok(()),
                    Err(e)
                        if attempt < RETRY_DELAYS_MS.len()
                            && matches!(e.raw_os_error(), Some(5 | 32 | 33)) =>
                    {
                        thread::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt]));
                        attempt += 1;
                    }
                    Err(e) => break Err(e),
                }
            }
        };
        #[cfg(not(windows))]
        let result = rename(&self.path, target);

        result.map_err(|e| {
            format!(
                "Failed to move temp file '{}' to '{}': {e}",
                self.path.display(),
                target.display()
            )
        })?;
        self.owned = false;
        file_sync::mark_app_write_path(target);
        Ok(())
    }
}

impl Drop for StagedBytes {
    fn drop(&mut self) {
        if self.owned {
            if let Err(e) = fs::remove_file(&self.path) {
                if e.kind() != ErrorKind::NotFound {
                    log::warn!(
                        "Failed to clean up temp file '{}': {e}",
                        self.path.display()
                    );
                }
            }
        }
    }
}

/// 在已验证的物理路径下原子替换字节；调用方必须完成路径授权与父目录准备。
pub(crate) fn write_atomic_physical_bytes(path: &Path, contents: &[u8]) -> Result<(), String> {
    StagedBytes::prepare(path, contents, None)?.commit(path, |from, to| fs::rename(from, to))
}

fn physical_batch_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(super::file_sync_watch::normalize_path_key(path))
    } else {
        path.to_path_buf()
    }
}

/// 将已解析的存储路径归一为稳定物理回滚键（规范化父目录 + 文件名，经 `physical_batch_key` 归一），
/// 确保 `wiki/chapters/ch.md` 与 `QM/chapters/ch.md` 命中同一回滚凭据键。
fn physical_rollback_key(path: &Path) -> String {
    let canonical = match (
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty()),
        path.file_name(),
    ) {
        (Some(parent), Some(file_name)) => fs::canonicalize(parent)
            .map(|dir| dir.join(file_name))
            .unwrap_or_else(|_| path.to_path_buf()),
        (None, Some(file_name)) => fs::canonicalize(Path::new("."))
            .map(|dir| dir.join(file_name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
    };
    physical_batch_key(&canonical)
        .to_string_lossy()
        .into_owned()
}

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

fn batch_file_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(format!(
            "Batch target '{}' is not a regular file",
            path.display()
        )),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!(
            "Failed to inspect batch target '{}': {e}",
            path.display()
        )),
    }
}

fn read_raw_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !batch_file_exists(path)? {
        return Ok(None);
    }
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "Failed to read batch target '{}': {e}",
            path.display()
        )),
    }
}

fn canonicalize_existing_ancestor_readonly(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(format!(
                        "Failed to find existing ancestor for '{}': {e}",
                        path.display()
                    ));
                };
                missing.push(name);
                existing = if parent.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    parent
                };
            }
            Err(e) => {
                return Err(format!(
                    "Failed to inspect ancestor '{}': {e}",
                    existing.display()
                ))
            }
        }
    }
    let mut resolved = fs::canonicalize(existing)
        .map_err(|e| format!("Failed to resolve ancestor '{}': {e}", existing.display()))?;
    if !resolved.is_dir() {
        return Err(format!(
            "Batch target parent '{}' is not a directory",
            resolved.display()
        ));
    }
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn resolve_batch_target_readonly(raw_path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_project_storage_path(raw_path)?;
    let path = Path::new(&resolved);
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Batch target has no file name: {resolved}"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = canonicalize_existing_ancestor_readonly(parent)?;
    let target = parent.join(file_name);
    if batch_file_exists(&target)? {
        fs::canonicalize(&target)
            .map_err(|e| format!("Failed to resolve batch target '{}': {e}", target.display()))
    } else {
        Ok(target)
    }
}

struct BatchWrite<'a> {
    target: PathBuf,
    before: Option<Vec<u8>>,
    after: &'a [u8],
}

impl BatchWrite<'_> {
    fn compensate(&self) -> Result<(), String> {
        let target = &self.target;
        match read_raw_optional(target) {
            Ok(current) if current.as_deref() == Some(self.after) => {
                if let Some(before) = &self.before {
                    write_atomic_physical_bytes(target, before)?;
                } else {
                    remove_regular_file_if_unchanged(target, self.after)?;
                }
            }
            Ok(current) if current == self.before => return Ok(()),
            Ok(_) => return Err("target changed after commit; left untouched".into()),
            Err(e) => return Err(e),
        }
        if read_raw_optional(target)? != self.before {
            return Err("compensation readback differs from original bytes".into());
        }
        Ok(())
    }
}

/// 全部暂存文件 fsync 后逐个提交；失败时逆序补偿仍持有本次写入字节的文件。
/// 这是字节级补偿，不提供跨进程线性化或崩溃原子性。
pub fn do_write_files_atomic(
    files: &[(String, String)],
    expected_contents: Option<&[Option<String>]>,
) -> Result<(), String> {
    run_guarded("write_files_atomic", || {
        let _mutation = lock_file_mutations()?;
        do_write_files_atomic_inner(files, expected_contents, |from, to| fs::rename(from, to))
    })
}

fn compensate_batch(batch: &[BatchWrite<'_>], original: String) -> String {
    let conflicts: Vec<_> = batch
        .iter()
        .rev()
        .filter_map(|step| {
            step.compensate()
                .err()
                .map(|e| format!("'{}': {e}", step.target.display()))
        })
        .collect();
    if conflicts.is_empty() {
        format!("{original}; compensated {} committed file(s)", batch.len())
    } else {
        format!("{original}; rollback conflicts: {}", conflicts.join("; "))
    }
}

fn do_write_files_atomic_inner(
    files: &[(String, String)],
    expected_contents: Option<&[Option<String>]>,
    commit_rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    if expected_contents.is_some_and(|values| values.len() != files.len()) {
        return Err("Expected batch contents must match the number of targets".into());
    }
    let mut targets = HashSet::with_capacity(files.len());
    let mut batch = Vec::with_capacity(files.len());
    for (index, (raw_path, contents)) in files.iter().enumerate() {
        let target = resolve_batch_target_readonly(raw_path)?;
        if !targets.insert(physical_batch_key(&target)) {
            return Err(format!(
                "Duplicate physical batch target '{}'",
                target.display()
            ));
        }
        let before = read_raw_optional(&target)?;
        if let Some(expected) = expected_contents {
            if before.as_deref() != expected[index].as_deref().map(str::as_bytes) {
                return Err(format!(
                    "Batch target '{}' changed before staging; left untouched",
                    target.display()
                ));
            }
        }
        batch.push(BatchWrite {
            target,
            before,
            after: contents.as_bytes(),
        });
    }

    for step in &batch {
        if let Some(parent) = step
            .target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create parent dirs for '{}': {e}",
                    step.target.display()
                )
            })?;
        }
    }

    let mut staged = batch
        .iter()
        .map(|step| StagedBytes::prepare(&step.target, step.after, Some(&targets)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut committed = 0;
    for (index, (step, tmp)) in batch.iter().zip(staged.iter_mut()).enumerate() {
        let commit = read_raw_optional(&step.target).and_then(|current| {
            if current != step.before {
                return Err(format!(
                    "Batch target '{}' changed before commit; left untouched",
                    step.target.display()
                ));
            }
            tmp.commit(&step.target, &commit_rename)?;
            committed = index + 1;
            if read_raw_optional(&step.target)?.as_deref() != Some(step.after) {
                return Err(format!(
                    "Batch target '{}' failed readback after commit",
                    step.target.display()
                ));
            }
            Ok(())
        });
        if let Err(original) = commit {
            return Err(compensate_batch(&batch[..committed], original));
        }
    }
    // 成功前终验：前面的目标可能在其后的 rename 回调中被外部改动——
    // 整体逐目标回读，任一不符即按全量已提交批次补偿（含冲突上报）。
    for step in &batch {
        let readback = read_raw_optional(&step.target).and_then(|current| {
            if current.as_deref() == Some(step.after) {
                Ok(())
            } else {
                Err(format!(
                    "Batch target '{}' failed final readback",
                    step.target.display()
                ))
            }
        });
        if let Err(original) = readback {
            return Err(compensate_batch(&batch, original));
        }
    }
    // 全量终验通过后为本次新建条目登记单次内容锁定回滚凭据，并吊销覆盖条目的旧凭据（R-2）。
    for step in &batch {
        let key = physical_rollback_key(&step.target);
        if step.before.is_none() {
            crate::agent_gate::register_creation_rollback_ticket(&key, sha256_bytes(step.after));
        } else {
            crate::agent_gate::invalidate_rollback_ticket(&key);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn write_file_atomic(path: String, contents: String) -> Result<(), String> {
    let p = path.clone();
    let c = contents.clone();
    tauri::async_runtime::spawn_blocking(move || do_write_file_atomic(&p, &c))
        .await
        .map_err(|e| format!("write_file_atomic blocking task join error: {e}"))?
}

/// 文件集写入：全部暂存就绪后逐个提交，失败时执行有条件的补偿。
#[tauri::command]
pub async fn write_files_atomic(
    files: Vec<(String, String)>,
    expected_contents: Option<Vec<Option<String>>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        do_write_files_atomic(&files, expected_contents.as_deref())
    })
    .await
    .map_err(|e| format!("write_files_atomic blocking task join error: {e}"))?
}

const MAX_TREE_NODES: usize = 20_000;
const MAX_RELATED_SCAN_DEPTH: usize = 32;
const MAX_RELATED_SCAN_FILES: usize = 20_000;
const MAX_COPY_DIR_DEPTH: usize = 64;
const MAX_COPY_DIR_FILES: usize = 10_000;

/// Core logic for `list_directory`, callable from both Tauri commands and Axum handlers.
pub fn do_list_directory(path: &str) -> Result<Vec<FileNode>, String> {
    do_list_directory_with_depth(path, None)
}

/// Core logic for `list_directory` with an optional traversal depth cap (`1..=30`, default `30`).
pub fn do_list_directory_with_depth(
    path: &str,
    max_depth: Option<usize>,
) -> Result<Vec<FileNode>, String> {
    run_guarded("list_directory", || {
        let path = resolve_project_storage_path(path)?;
        let p = Path::new(&path);
        if !p.exists() {
            return Err(format!("Path does not exist: '{}'", path));
        }
        if !p.is_dir() {
            return Err(format!("Path is not a directory: '{}'", path));
        }
        let depth_limit = max_depth.unwrap_or(30).clamp(1, 30);
        let mut remaining = MAX_TREE_NODES;
        let nodes = build_tree(p, 0, depth_limit, &mut remaining)?;
        Ok(nodes)
    })
}

#[tauri::command]
pub async fn list_directory(
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<FileNode>, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || match max_depth {
        None => do_list_directory(&p),
        Some(depth) => do_list_directory_with_depth(&p, Some(depth)),
    })
    .await
    .map_err(|e| format!("list_directory blocking task join error: {e}"))?
}

fn build_tree(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    remaining: &mut usize,
) -> Result<Vec<FileNode>, String> {
    if depth >= max_depth || *remaining == 0 {
        return Ok(vec![]);
    }

    let mut entries: Vec<(fs::DirEntry, bool)> = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            // Skip dotfiles; use to_string_lossy so non-UTF-8 filenames are still visible
            if entry.file_name().to_string_lossy().starts_with('.') {
                return None;
            }
            let ft = entry.file_type().ok()?;
            let entry_path = entry.path();
            if ft.is_symlink() || crate::agent_gate_policy::is_symlink_or_reparse_point(&entry_path)
            {
                return None;
            }
            Some((entry, ft.is_dir()))
        })
        .collect();

    // Sort: directories first, then alphabetical within each group (without following symlinks)
    entries.sort_by(|(a, a_is_dir), (b, b_is_dir)| match (a_is_dir, b_is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.file_name().cmp(&b.file_name()),
    });

    let mut nodes = Vec::new();
    for (entry, is_dir) in entries {
        if *remaining == 0 {
            break;
        }
        *remaining -= 1;

        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Always return forward-slash paths so the TS layer can compare
        // and compose paths consistently across Windows and Unix. Windows
        // APIs accept forward slashes, so normalizing here is safe and
        // prevents a whole class of bugs where TS-constructed `/` paths
        // fail to match Rust-returned `\` paths.
        let path_str = virtualize_project_storage_path(&entry_path);

        let children = if is_dir {
            let kids = build_tree(&entry_path, depth + 1, max_depth, remaining)?;
            if kids.is_empty() {
                None
            } else {
                Some(kids)
            }
        } else {
            None
        };

        // ISS-20260709-032: reuse the readdir metadata for mtime so callers do
        // not pay an extra getFileModifiedTime IPC per file.
        let mtime_ms = if is_dir {
            None
        } else {
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
        };

        nodes.push(FileNode {
            name,
            path: path_str,
            is_dir,
            mtime_ms,
            children,
        });
    }

    Ok(nodes)
}

fn is_hard_link_unsupported_error(err: &std::io::Error) -> bool {
    if err.kind() == ErrorKind::Unsupported {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_INVALID_FUNCTION (1) / ERROR_NOT_SUPPORTED (50)：FAT32 / exFAT / 部分网络挂载卷不支持硬链接
        matches!(err.raw_os_error(), Some(1 | 50))
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        {
            // EOPNOTSUPP (45) / ENOSYS (78) / EMLINK (31)
            matches!(err.raw_os_error(), Some(45 | 78 | 31))
        }
        #[cfg(not(target_os = "macos"))]
        {
            // EOPNOTSUPP (95) / ENOSYS (38) / EMLINK (31)
            matches!(err.raw_os_error(), Some(95 | 38 | 31))
        }
    }
}

/// Core logic for `copy_file`, callable from both Tauri commands and Axum handlers.
pub fn do_copy_file(source: &str, destination: &str, exclusive: bool) -> Result<(), String> {
    run_guarded("copy_file", || {
        let _mutation = lock_file_mutations()?;
        let source = resolve_project_storage_path(source)?;
        let destination = resolve_project_storage_path(destination)?;
        let dest = Path::new(&destination);
        if dest.file_name().is_none() {
            return Err(format!(
                "Copy destination has no file name: '{destination}'"
            ));
        }

        // 先校验源可打开且非目录，避免源缺失时误建空父目录。
        let mut input = fs::File::open(&source)
            .map_err(|e| format!("Failed to read copy source '{}': {e}", source))?;
        if input.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            return Err(format!("Copy source '{}' is a directory", source));
        }

        if exclusive {
            match fs::symlink_metadata(dest) {
                Ok(m) if m.file_type().is_file() => return Ok(()),
                Ok(_) => return Err("Exclusive copy destination is not a regular file".into()),
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "Failed to inspect copy destination '{}': {e}",
                        dest.display()
                    ))
                }
            }
            if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
            }
            let mut staged = StagedBytes::prepare_from_reader(dest, &mut input, None)?;
            drop(input);
            file_sync::mark_app_write_path(dest);
            match fs::hard_link(&staged.path, dest) {
                Ok(()) => {
                    // hard_link 成功后 Drop 会自动清理 staged.path，dest 保留完整数据。
                    file_sync::mark_app_write_path(dest);
                    crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(dest));
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    if !fs::symlink_metadata(dest)
                        .map(|m| m.file_type().is_file())
                        .unwrap_or(false)
                    {
                        return Err("Exclusive copy destination is not a regular file".into());
                    }
                }
                Err(e) if is_hard_link_unsupported_error(&e) => {
                    // 不支持硬链接的文件系统回退：持 FILE_MUTATION_LOCK 二次检查 NotFound 后提交。
                    match fs::symlink_metadata(dest) {
                        Ok(m) if m.file_type().is_file() => {}
                        Ok(_) => {
                            return Err("Exclusive copy destination is not a regular file".into());
                        }
                        Err(meta_err) if meta_err.kind() == ErrorKind::NotFound => {
                            staged.commit(dest, |from, to| fs::rename(from, to))?;
                            crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(
                                dest,
                            ));
                        }
                        Err(meta_err) => {
                            return Err(format!(
                                "Failed to inspect copy destination '{}': {meta_err}",
                                dest.display()
                            ));
                        }
                    }
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to create exclusive copy '{}': {e}",
                        dest.display()
                    ))
                }
            }
        } else {
            if let Some(parent) = dest.parent().filter(|p| !p.as_os_str().is_empty()) {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
            }
            let mut staged = StagedBytes::prepare_from_reader(dest, &mut input, None)?;
            drop(input);
            staged.commit(dest, |from, to| fs::rename(from, to))?;
            crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(dest));
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn copy_file(
    source: String,
    destination: String,
    exclusive: Option<bool>,
) -> Result<(), String> {
    let s = source.clone();
    let d = destination.clone();
    let ex = exclusive.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || do_copy_file(&s, &d, ex))
        .await
        .map_err(|e| format!("copy_file blocking task join error: {e}"))?
}

/// 解析目标路径的最深现存祖先（不跟随现存路径自身符号链接），再拼接缺失后缀，用于自包含环路检测。
fn resolve_copy_dest_path(dest: &Path) -> Result<PathBuf, String> {
    let mut existing = dest;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(meta) => {
                if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
                    return Err(format!(
                        "Copy destination contains symlink or reparse point: '{}'",
                        existing.display()
                    ));
                }
                break;
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(format!(
                        "Failed to resolve copy destination '{}': {e}",
                        dest.display()
                    ));
                };
                missing.push(name.to_os_string());
                existing = parent;
            }
            Err(e) => {
                return Err(format!(
                    "Failed to inspect copy destination '{}': {e}",
                    existing.display()
                ));
            }
        }
    }
    let mut resolved = fs::canonicalize(existing).map_err(|e| {
        format!(
            "Failed to canonicalize copy destination ancestor '{}': {e}",
            existing.display()
        )
    })?;
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

/// Core logic for `copy_directory`, callable from both Tauri commands and Axum handlers.
/// Recursively copy a directory, preserving structure.
/// Returns list of copied file paths (destination paths).
pub fn do_copy_directory(source: &str, destination: &str) -> Result<Vec<String>, String> {
    run_guarded("copy_directory", || {
        let _mutation = lock_file_mutations()?;
        let source = resolve_project_storage_path(source)?;
        let destination = resolve_project_storage_path(destination)?;
        let src = Path::new(&source);
        let dest = Path::new(&destination);

        let src_meta = fs::symlink_metadata(src)
            .map_err(|e| format!("Failed to inspect source '{}': {}", source, e))?;
        if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&src_meta) {
            return Err(format!(
                "Source '{}' is a symlink or reparse point and cannot be copied recursively",
                source
            ));
        }
        if !src_meta.is_dir() {
            return Err(format!("'{}' is not a directory", source));
        }

        let src_canon = fs::canonicalize(src)
            .map_err(|e| format!("Failed to resolve source '{}': {}", source, e))?;
        let dest_resolved = resolve_copy_dest_path(dest)?;
        if dest_resolved.starts_with(&src_canon) {
            return Err(format!(
                "Cannot copy directory '{}' into itself or a subdirectory '{}'",
                source, destination
            ));
        }

        file_sync::mark_app_write_path(dest);
        let mut copied_files = Vec::new();

        fn copy_recursive(
            src: &Path,
            dest: &Path,
            files: &mut Vec<String>,
            depth: usize,
        ) -> Result<(), String> {
            if depth > MAX_COPY_DIR_DEPTH {
                return Err(format!(
                    "Copy directory exceeded maximum depth ({MAX_COPY_DIR_DEPTH})"
                ));
            }
            fs::create_dir_all(dest)
                .map_err(|e| format!("Failed to create dir '{}': {}", dest.display(), e))?;

            let entries = fs::read_dir(src)
                .map_err(|e| format!("Failed to read dir '{}': {}", src.display(), e))?;

            for entry in entries {
                let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
                let path = entry.path();
                let name = entry.file_name();
                let dest_path = dest.join(&name);

                if name.to_string_lossy().starts_with('.') {
                    continue;
                }

                let ft = entry
                    .file_type()
                    .map_err(|e| format!("Failed to inspect entry '{}': {}", path.display(), e))?;
                if ft.is_symlink() || crate::agent_gate_policy::is_symlink_or_reparse_point(&path) {
                    continue;
                }

                if ft.is_dir() {
                    copy_recursive(&path, &dest_path, files, depth + 1)?;
                } else if ft.is_file() {
                    if files.len() >= MAX_COPY_DIR_FILES {
                        return Err(format!(
                            "Copy directory exceeded maximum file count ({MAX_COPY_DIR_FILES})"
                        ));
                    }
                    fs::copy(&path, &dest_path)
                        .map_err(|e| format!("Failed to copy '{}': {}", path.display(), e))?;
                    file_sync::mark_app_write_path(&dest_path);
                    crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(
                        &dest_path,
                    ));
                    files.push(virtualize_project_storage_path(&dest_path));
                }
            }
            Ok(())
        }

        copy_recursive(src, dest, &mut copied_files, 0)?;
        Ok(copied_files)
    })
}

#[tauri::command]
pub async fn copy_directory(source: String, destination: String) -> Result<Vec<String>, String> {
    let s = source.clone();
    let d = destination.clone();
    tauri::async_runtime::spawn_blocking(move || do_copy_directory(&s, &d))
        .await
        .map_err(|e| format!("copy_directory blocking task join error: {e}"))?
}

/// Core logic for `delete_file`, callable from both Tauri commands and Axum handlers.
pub fn do_delete_file(path: &str) -> Result<(), String> {
    run_guarded("delete_file", || {
        let path = resolve_project_storage_path(path)?;
        let gate = crate::agent_gate::gate_authorize(
            "deleteFile",
            &path,
            crate::agent_gate::GateActor::Agent,
        );
        if !gate.may_proceed() {
            return Err(crate::agent_gate::gate_error(&gate));
        }
        let p = Path::new(&path);
        let mut last_err: Option<std::io::Error> = None;
        let mut was_dir = false;
        for attempt in 0..4 {
            let mutation_guard = lock_file_mutations()?;
            file_sync::mark_app_write_path(p);
            let is_dir = p.is_dir();
            was_dir = is_dir;
            let result = if is_dir {
                fs::remove_dir_all(p)
            } else {
                fs::remove_file(p)
            };
            match result {
                Ok(()) => {
                    file_sync::mark_app_write_path(p);
                    crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(p));
                    return Ok(());
                }
                Err(err) if attempt > 0 && err.kind() == ErrorKind::NotFound => {
                    file_sync::mark_app_write_path(p);
                    crate::agent_gate::invalidate_rollback_ticket(&physical_rollback_key(p));
                    return Ok(());
                }
                Err(err) if attempt < 3 && is_windows_transient_delete_error(&err) => {
                    drop(mutation_guard);
                    last_err = Some(err);
                    thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
                }
                Err(err) => {
                    let kind = if is_dir { "directory" } else { "file" };
                    return Err(format!("Failed to delete {kind} '{}': {}", path, err));
                }
            }
        }
        let kind = if was_dir { "directory" } else { "file" };
        let err = last_err.unwrap_or_else(|| std::io::Error::other("delete failed"));
        Err(format!("Failed to delete {kind} '{}': {}", path, err))
    })
}

/// Core logic for guarded rollback deletion (`delete_file` with `expected_content`).
pub fn do_delete_file_if_unchanged(path: &str, expected: &str) -> Result<(), String> {
    run_guarded("delete_file_if_unchanged", || {
        let _mutation = lock_file_mutations()?;
        let path = resolve_project_storage_path(path)?;
        let p = Path::new(&path);
        let key = physical_rollback_key(p);
        let digest = sha256_bytes(expected.as_bytes());
        let gate = crate::agent_gate::gate_authorize_rollback_delete(&path, &key, &digest);
        if !gate.may_proceed() {
            return Err(crate::agent_gate::gate_error(&gate));
        }
        remove_regular_file_if_unchanged(p, expected.as_bytes())
    })
}

#[tauri::command]
pub async fn delete_file(path: String, expected_content: Option<String>) -> Result<(), String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || match expected_content {
        None => do_delete_file(&p),
        Some(expected) => do_delete_file_if_unchanged(&p, &expected),
    })
    .await
    .map_err(|e| format!("delete_file blocking task join error: {e}"))?
}

#[cfg(windows)]
pub(crate) fn remove_regular_file_if_unchanged(path: &Path, expected: &[u8]) -> Result<(), String> {
    // Deny write/delete sharing so the comparison and disposition belong to the same file handle.
    let mut file = match fs::OpenOptions::new()
        .access_mode(GENERIC_READ.0 | DELETE.0)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not open rollback target '{}': {error}",
                path.display()
            ))
        }
    };
    let meta = file.metadata().map_err(|e| {
        format!(
            "Could not inspect rollback target '{}': {e}",
            path.display()
        )
    })?;
    if !meta.is_file() {
        return Err(format!(
            "Rollback target '{}' is not a regular file",
            path.display()
        ));
    }
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        let mut tag_info = FILE_ATTRIBUTE_TAG_INFO::default();
        let query = unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileAttributeTagInfo,
                (&mut tag_info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };
        const IS_REPARSE_TAG_NAME_SURROGATE: u32 = 0x2000_0000;
        let is_forbidden_reparse = match query {
            Ok(()) => {
                (tag_info.ReparseTag & IS_REPARSE_TAG_NAME_SURROGATE) != 0
                    || matches!(
                        tag_info.ReparseTag,
                        IO_REPARSE_TAG_SYMLINK | IO_REPARSE_TAG_MOUNT_POINT
                    )
            }
            Err(_) => true, // fail-closed：无法识别重解析标签时拒绝
        };
        if is_forbidden_reparse {
            return Err(format!(
                "Rollback target '{}' is not a regular file",
                path.display()
            ));
        }
    }
    let mut current = Vec::new();
    use std::io::Read;
    (&mut file)
        .take(expected.len() as u64 + 1)
        .read_to_end(&mut current)
        .map_err(|e| format!("Could not read rollback target '{}': {e}", path.display()))?;
    if current != expected {
        return Err("target changed after commit; left untouched".into());
    }
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    file_sync::mark_app_write_path(path);
    // The handle and disposition stay valid for the duration of the synchronous call.
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|e| format!("Could not remove rollback target '{}': {e}", path.display()))?;
    drop(file);
    verify_rollback_target_removed(path)
}

#[cfg(not(windows))]
pub(crate) fn remove_regular_file_if_unchanged(path: &Path, expected: &[u8]) -> Result<(), String> {
    // Best-effort legacy scope: cross-process handle semantics are Windows-only.
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Ok(m) if m.is_file() => {}
        Ok(_) => return Err("Rollback target is not a regular file".into()),
        Err(e) => return Err(e.to_string()),
    }
    if read_raw_optional(path)?.as_deref() != Some(expected) {
        return Err("target changed after commit; left untouched".into());
    }
    file_sync::mark_app_write_path(path);
    fs::remove_file(path).map_err(|e| e.to_string())?;
    verify_rollback_target_removed(path)
}

fn verify_rollback_target_removed(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    const BACKOFF_MS: [u64; 5] = [0, 10, 20, 40, 80];
    #[cfg(not(windows))]
    const BACKOFF_MS: [u64; 1] = [0];

    for (idx, &delay_ms) in BACKOFF_MS.iter().enumerate() {
        if delay_ms > 0 {
            thread::sleep(Duration::from_millis(delay_ms));
        }
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == ErrorKind::NotFound => {
                file_sync::mark_app_write_path(path);
                return Ok(());
            }
            Ok(_) if idx + 1 < BACKOFF_MS.len() => continue,
            Err(error)
                if idx + 1 < BACKOFF_MS.len() && is_windows_transient_delete_error(&error) =>
            {
                continue;
            }
            Ok(_) => {
                return Err(format!(
                    "Rollback target '{}' still exists after guarded removal",
                    path.display()
                ));
            }
            Err(error) => {
                return Err(format!(
                    "Could not verify removal of '{}': {error}",
                    path.display()
                ));
            }
        }
    }
    Err(format!(
        "Rollback target '{}' still exists after guarded removal",
        path.display()
    ))
}

fn is_windows_transient_delete_error(err: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(32 | 33))
            || err.kind() == std::io::ErrorKind::PermissionDenied
    }
    #[cfg(not(windows))]
    {
        let _ = err;
        false
    }
}

/// Core logic for `find_related_wiki_pages`, callable from both Tauri commands and Axum handlers.
/// Find wiki pages that reference a given source file name.
/// Scans all .md files under wiki/ for the source filename in frontmatter or content.
pub fn do_find_related_wiki_pages(
    project_path: &str,
    source_name: &str,
) -> Result<Vec<String>, String> {
    run_guarded("find_related_wiki_pages", || {
        let wiki_dir = Path::new(project_path).join(KNOWLEDGE_DIR);
        let wiki_dir = if wiki_dir.is_dir() {
            wiki_dir
        } else {
            Path::new(project_path).join(LEGACY_KNOWLEDGE_DIR)
        };
        if !wiki_dir.is_dir() {
            return Ok(vec![]);
        }

        let mut related = Vec::new();
        collect_related_pages(&wiki_dir, source_name, &mut related)?;
        Ok(related)
    })
}

/// Find wiki pages that reference a given source file name.
/// Scans all .md files under wiki/ for the source filename in frontmatter or content.
#[tauri::command]
pub async fn find_related_wiki_pages(
    project_path: String,
    source_name: String,
) -> Result<Vec<String>, String> {
    let pp = project_path.clone();
    let sn = source_name.clone();
    tauri::async_runtime::spawn_blocking(move || do_find_related_wiki_pages(&pp, &sn))
        .await
        .map_err(|e| format!("find_related_wiki_pages blocking task join error: {e}"))?
}

fn collect_related_pages(
    dir: &Path,
    source_name: &str,
    results: &mut Vec<String>,
) -> Result<(), String> {
    let mut remaining = MAX_RELATED_SCAN_FILES;
    collect_related_pages_bounded(dir, source_name, results, 0, &mut remaining)
}

fn collect_related_pages_bounded(
    dir: &Path,
    source_name: &str,
    results: &mut Vec<String>,
    depth: usize,
    remaining: &mut usize,
) -> Result<(), String> {
    if depth >= MAX_RELATED_SCAN_DEPTH || *remaining == 0 {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    // Get just the filename without path — use Path for cross-platform separator handling
    let source_path = std::path::Path::new(source_name);
    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(source_name);
    let file_name_lower = file_name.to_lowercase();

    // Derive stem (filename without extension) for source summary matching
    let file_stem = file_name
        .rsplit('.')
        .skip(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(".");
    let file_stem_lower = if file_stem.is_empty() {
        file_name_lower.clone()
    } else {
        file_stem.to_lowercase()
    };

    for entry in entries.flatten() {
        if *remaining == 0 {
            break;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() || crate::agent_gate_policy::is_symlink_or_reparse_point(&path) {
            continue;
        }
        if ft.is_dir() {
            collect_related_pages_bounded(&path, source_name, results, depth + 1, remaining)?;
        } else if ft.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
            *remaining -= 1;
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Skip index.md, log.md, overview.md — updated separately
            if fname == "index.md" || fname == "log.md" || fname == "overview.md" {
                continue;
            }

            if let Ok(content) = fs::read_to_string(&path) {
                let content_lower = content.to_lowercase();

                // Match 1: frontmatter sources field contains the exact filename
                // e.g., sources: ["2603.25723v1.pdf"]
                let sources_match = content_lower.contains(&format!("\"{}\"", file_name_lower))
                    || content_lower.contains(&format!("'{}'", file_name_lower));

                // Match 2: source summary page (wiki/sources/{stem}.md)
                // Use Path component iteration to avoid hardcoded separator assumptions
                let is_in_sources_dir = path.components().any(|c| c.as_os_str() == "sources");
                let is_source_summary =
                    is_in_sources_dir && fname.to_lowercase().starts_with(&file_stem_lower);

                // Match 3: the page's *sources block* mentions the
                // filename. Covers the multi-line YAML list form
                //
                //   sources:
                //     - test.md         (unquoted, missed by Match 1)
                //     - "other.md"
                //
                // Previous version substring-matched against the ENTIRE
                // frontmatter, which false-positived whenever the
                // filename happened to appear in title / description /
                // any other field — those pages were then handed to
                // the TS delete flow and, because their actual sources
                // list didn't include the deleted file, silently
                // wiped. Tightened: scope the substring check to the
                // `sources:` block only (inline line + any indented
                // continuation lines of a YAML list).
                let frontmatter_match = if let Some(rest) = content.strip_prefix("---\n") {
                    if let Some(fm_end_rel) = rest.find("\n---") {
                        let frontmatter = &rest[..fm_end_rel].to_lowercase();
                        let mut found = false;
                        let mut in_sources_block = false;
                        for line in frontmatter.split('\n') {
                            if line.starts_with("sources:") {
                                // Inline-form `sources: [...]` lives
                                // entirely on this one line; check it.
                                if line.contains(&file_name_lower) {
                                    found = true;
                                    break;
                                }
                                in_sources_block = true;
                                continue;
                            }
                            if in_sources_block {
                                // Continuation lines of a YAML list are
                                // indented; an un-indented line means
                                // we've left the sources block for
                                // another top-level field.
                                if line.is_empty()
                                    || line.starts_with(' ')
                                    || line.starts_with('\t')
                                {
                                    if line.contains(&file_name_lower) {
                                        found = true;
                                        break;
                                    }
                                } else {
                                    in_sources_block = false;
                                }
                            }
                        }
                        found
                    } else {
                        false
                    }
                } else {
                    false
                };

                if sources_match || is_source_summary || frontmatter_match {
                    // Normalize to forward slashes — matches build_tree /
                    // copy_directory so TS-side comparisons work on Windows.
                    results.push(virtualize_project_storage_path(&path));
                }
            }
        }
    }
    Ok(())
}

/// Core logic for `create_directory`, callable from both Tauri commands and Axum handlers.
pub fn do_create_directory(path: &str) -> Result<(), String> {
    run_guarded("create_directory", || {
        let _mutation = lock_file_mutations()?;
        let path = resolve_project_storage_path(path)?;
        fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create directory '{}': {}", path, e))
    })
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_create_directory(&p))
        .await
        .map_err(|e| format!("create_directory blocking task join error: {e}"))?
}

/// Read any file as base64 + a guessed mime type. Used by the
/// vision-caption pipeline to slurp extracted image bytes off disk
/// without round-tripping them through the JS string-as-UTF8 path
/// (`read_file` would corrupt PNG bytes — they aren't valid UTF-8).
///
/// Mime detection is by extension only — the caption helper doesn't
/// care about exact accuracy (vision models accept any common
/// raster format), and the alternative (sniffing magic bytes via
/// `infer` or similar) adds a dependency for marginal benefit.
/// Unknown extensions fall back to `application/octet-stream`,
/// which all major vision endpoints accept (Anthropic / OpenAI both
/// also support that as a generic fallback).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBase64 {
    pub base64: String,
    pub mime_type: String,
}

/// Core logic for `read_file_as_base64`, callable from both Tauri commands and Axum handlers.
pub fn do_read_file_as_base64(path: &str) -> Result<FileBase64, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    run_guarded("read_file_as_base64", || {
        let path = resolve_project_storage_path(path)?;
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
        let p = Path::new(&path);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime_type = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "tiff" | "tif" => "image/tiff",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        }
        .to_string();
        Ok(FileBase64 {
            base64: B64.encode(&bytes),
            mime_type,
        })
    })
}

#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<FileBase64, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_read_file_as_base64(&p))
        .await
        .map_err(|e| format!("read_file_as_base64 blocking task join error: {e}"))?
}

/// Core logic for `file_exists`, callable from both Tauri commands and Axum handlers.
/// Cheap existence check without reading or classifying the file.
/// Returns true iff `path` refers to something on disk right now.
pub fn do_file_exists(path: &str) -> Result<bool, String> {
    run_guarded("file_exists", || {
        let path = resolve_project_storage_path(path)?;
        Ok(Path::new(&path).exists())
    })
}

#[tauri::command]
pub async fn file_exists(path: String) -> Result<bool, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_file_exists(&p))
        .await
        .map_err(|e| format!("file_exists blocking task join error: {e}"))?
}

/// Core logic for `path_is_directory`, callable from both Tauri commands and Axum handlers.
///
/// 数据完整性关键（DI-1）：目录判定必须走 `metadata.file_type().is_dir()`。
/// **禁止**用 `get_file_size` / `metadata.len()` 推断 —— Windows 上目录的
/// `metadata(dir).len()` 返回 `Ok(0)`，会被 TS 侧误判为普通文件，导致
/// `copy_file` 对目录必然失败（错误被吞）后源目录仍被递归删除。
/// 缺失路径视为「不是目录」（`Ok(false)`），其余 I/O 错误如实上抛。
pub fn do_path_is_directory(path: &str) -> Result<bool, String> {
    run_guarded("path_is_directory", || {
        let path = resolve_project_storage_path(path)?;
        match fs::metadata(&path) {
            // 跟随符号链接（与 `Path::is_dir()` / 其余命令语义一致）。
            Ok(metadata) => Ok(metadata.file_type().is_dir()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("Failed to stat '{}': {}", path, e)),
        }
    })
}

#[tauri::command]
pub async fn path_is_directory(path: String) -> Result<bool, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_path_is_directory(&p))
        .await
        .map_err(|e| format!("path_is_directory blocking task join error: {e}"))?
}

/// Core logic for `get_file_modified_time`, callable from both Tauri commands and Axum handlers.
/// Get the last modified timestamp of a file in milliseconds since Unix epoch.
pub fn do_get_file_modified_time(path: &str) -> Result<u64, String> {
    run_guarded("get_file_modified_time", || {
        let path = resolve_project_storage_path(path)?;
        let metadata = fs::metadata(&path)
            .map_err(|e| format!("Failed to get metadata for '{}': {}", path, e))?;
        let modified = metadata
            .modified()
            .map_err(|e| format!("Failed to get modified time for '{}': {}", path, e))?;
        let duration = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error for '{}': {}", path, e))?;
        Ok(duration.as_millis() as u64)
    })
}

#[tauri::command]
pub async fn get_file_modified_time(path: String) -> Result<u64, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_get_file_modified_time(&p))
        .await
        .map_err(|e| format!("get_file_modified_time blocking task join error: {e}"))?
}

/// Core logic for `get_file_size`, callable from both Tauri commands and Axum handlers.
pub fn do_get_file_size(path: &str) -> Result<u64, String> {
    run_guarded("get_file_size", || {
        let path = resolve_project_storage_path(path)?;
        let metadata = fs::metadata(&path)
            .map_err(|e| format!("Failed to get metadata for '{}': {}", path, e))?;
        Ok(metadata.len())
    })
}

#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_get_file_size(&p))
        .await
        .map_err(|e| format!("get_file_size blocking task join error: {e}"))?
}

/// Core logic for `get_file_md5`, callable from both Tauri commands and Axum handlers.
/// Compute MD5 hash of a file. Returns the hex-encoded hash string.
pub fn do_get_file_md5(path: &str) -> Result<String, String> {
    use md5::{Digest, Md5};
    run_guarded("get_file_md5", || {
        let path = resolve_project_storage_path(path)?;
        let mut file =
            fs::File::open(&path).map_err(|e| format!("Failed to open file '{}': {}", path, e))?;
        let mut hasher = Md5::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let result = hasher.finalize();
        Ok(format!("{:x}", result))
    })
}

#[tauri::command]
pub async fn get_file_md5(path: String) -> Result<String, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || do_get_file_md5(&p))
        .await
        .map_err(|e| format!("get_file_md5 blocking task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::super::fs_office::{extract_legacy_doc_text_from_bytes, EXTRACT_MAX_ENTRIES};
    use super::*;
    use std::io::Write;

    /// SEC-005 纵深防御：段级卫生守卫拒绝 NUL/控制字节/`..`/Windows 非法字符/保留名
    #[test]
    fn reject_unsafe_storage_path_rejects_hazards() {
        // NUL / 控制字节
        assert!(reject_unsafe_storage_path("a\0b").is_err());
        assert!(reject_unsafe_storage_path("a\x1fb.md").is_err());
        // `..` 段（任意位置）
        assert!(reject_unsafe_storage_path("wiki/../x.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/sub/../../x.md").is_err());
        // Windows 非法字符（盘符段除外）
        assert!(reject_unsafe_storage_path("wiki/a<b.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/a>b.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/a|b.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/a?b.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/a*b.md").is_err());
        // 段尾空格/点（TS 语义：段以空格或 . 结尾才拒）
        assert!(reject_unsafe_storage_path("wiki/name ").is_err());
        assert!(reject_unsafe_storage_path("wiki/a.md.").is_err());
        // Windows 保留名（大小写不敏感）
        assert!(reject_unsafe_storage_path("wiki/CON.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/prn/x.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/aux.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/NUL.txt").is_err());
        assert!(reject_unsafe_storage_path("wiki/COM1.md").is_err());
        assert!(reject_unsafe_storage_path("wiki/lpt9/x.md").is_err());
        // 空/纯空白
        assert!(reject_unsafe_storage_path("").is_err());
        assert!(reject_unsafe_storage_path("   ").is_err());
    }

    /// SEC-005 纵深防御：合法路径（含绝对路径/盘符/legacy 段/点文件）全部放行
    #[test]
    fn reject_unsafe_storage_path_accepts_legit_paths() {
        // 绝对路径合法（主链全部调用方传绝对路径）
        assert!(reject_unsafe_storage_path("C:/Users/niko/proj/wiki/a.md").is_ok());
        assert!(reject_unsafe_storage_path("/Users/niko/proj/wiki/a.md").is_ok());
        // 盘符段放行
        assert!(reject_unsafe_storage_path("C:/a/b.md").is_ok());
        // 点文件/多扩展名
        assert!(reject_unsafe_storage_path("wiki/.hidden.md").is_ok());
        assert!(reject_unsafe_storage_path("wiki/a.tar.gz").is_ok());
        // COM10/LPT10 非保留名（仅 COM1-9/LPT1-9）
        assert!(reject_unsafe_storage_path("wiki/COM10.md").is_ok());
        // 中文/Unicode 路径
        assert!(reject_unsafe_storage_path("wiki/角色/草稿.md").is_ok());
        // legacy 段替换目标（安全常量段）
        assert!(reject_unsafe_storage_path("proj/.llm-wiki/x.md").is_ok());
        assert!(reject_unsafe_storage_path("proj/wiki/outlines/1/wiki/chapters/x.md").is_ok());
    }

    /// SEC-005：resolve 在卫生拒绝后返回 Err；legacy 段替换兼容不受影响
    #[test]
    fn resolve_project_storage_path_guards_and_preserves_legacy() {
        // 卫生拒绝穿透 resolve
        assert!(resolve_project_storage_path("wiki/../x.md").is_err());
        assert!(resolve_project_storage_path("a\0b").is_err());
        assert!(resolve_project_storage_path("C:/CON.md").is_err());
        // 正常路径 OK
        assert!(resolve_project_storage_path("C:/Users/niko/proj/wiki/a.md").is_ok());
        // 绝对路径（对话框/主链形态）不被拒
        assert!(resolve_project_storage_path("C:/Users/niko/proj/novel/ch1.md").is_ok());
    }

    /// B3: 注册表无重复 ext 且非空 (新增格式登记时的完整性门)
    #[test]
    fn extractor_registry_has_no_duplicate_exts() {
        assert!(TEXT_EXTRACTORS.len() >= 5);
        let mut seen = std::collections::HashSet::new();
        for (ext, _) in TEXT_EXTRACTORS {
            assert!(seen.insert(*ext), "duplicate ext in TEXT_EXTRACTORS: {ext}");
        }
    }

    /// B3: 注册表分派路由冒烟 —— html 走提取器而非兑底 (错误文案可区分)
    #[test]
    fn read_dispatch_routes_registered_ext_via_registry() {
        let missing = std::env::temp_dir()
            .join(format!("b3-registry-smoke-{}.html", std::process::id()))
            .to_string_lossy()
            .to_string();
        let err = do_read_file(&missing).unwrap_err();
        // 兑底文案含 "as text"; 提取器路径的错误不含该短语
        assert!(
            !err.contains("as text"),
            "html 应走注册表提取器而非兜底: {err}"
        );
    }

    /// Write `bytes` to a fresh tmp path with `.pdf` suffix and return
    /// the path (the OS tmpdir is NOT cleaned up — acceptable for tests).
    fn tmp_pdf_with_bytes(bytes: &[u8]) -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "panic-guard-{}.pdf",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    fn tmp_text_with_bytes(ext: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "niko-buddy-text-{}.{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            ext
        ));
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn decode_plain_text_bytes_supports_gbk_chinese_novel_text() {
        let (bytes, _, _) = encoding_rs::GBK.encode("第1章 税银案\n许七安醒来。");
        let decoded = decode_plain_text_bytes(bytes.as_ref());

        assert!(decoded.contains("第1章 税银案"));
        assert!(decoded.contains("许七安醒来"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn preprocess_file_returns_text_content_for_txt_books() {
        let path = tmp_text_with_bytes("txt", "第1章 税银案\n正文".as_bytes());
        let result = preprocess_file(path.clone()).await.unwrap();
        let _ = fs::remove_file(&path);

        assert!(result.contains("第1章 税银案"));
        assert_ne!(result, "no preprocessing needed");
    }

    /// Verify read_file does NOT crash the test process on malformed PDFs.
    /// We try a handful of payloads that have historically caused
    /// pdf-extract/lopdf panics — any process abort would fail the test
    /// runner before it can report.
    ///
    /// `multi_thread` flavor: `read_file` now uses
    /// `tauri::async_runtime::spawn_blocking`, which moves work onto
    /// the tokio blocking pool. The blocking pool requires a multi-
    /// threaded runtime — the default `#[tokio::test]` is single-
    /// threaded current-thread, on which `.await` of a `spawn_blocking`
    /// future deadlocks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_file_survives_malformed_pdf_inputs() {
        let payloads: &[(&str, &[u8])] = &[
            ("empty", b""),
            ("not_a_pdf", b"this is plainly not a PDF file"),
            ("header_only", b"%PDF-1.4\n"),
            (
                "broken_xref",
                b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\nxref\nBROKENBROKEN\ntrailer\n<</Size 1>>\nstartxref\n999999\n%%EOF\n",
            ),
            (
                "junk_after_header",
                b"%PDF-1.4\n\x00\x01\x02\x03\x04\x05\x06\x07\xFF\xFE\xFDjunkgarbage",
            ),
        ];

        for (name, bytes) in payloads {
            let path = tmp_pdf_with_bytes(bytes);
            let result = read_file(path.clone(), None).await;
            let _ = fs::remove_file(&path);
            eprintln!(
                "[{name}] => {:?}",
                result.as_ref().map(|s| &s[..s.len().min(80)])
            );
        }
    }

    /// Smoke test: a real PDF panic (synthesized) is caught. We can't
    /// guarantee that any particular byte sequence above actually panics
    /// pdf-extract across versions, so also trigger an explicit panic
    /// through read_file's guarded path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_file_returns_err_on_missing_file_instead_of_panicking() {
        let result = read_file(
            "/nonexistent/path/that/does/not/exist.pdf".to_string(),
            None,
        )
        .await;
        assert!(result.is_err() || result.is_ok()); // must at least return
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exact_utf8_read_distinguishes_missing_and_invalid_bytes() {
        let dir = std::env::temp_dir().join(format!("qmai-exact-utf8-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("ledger.json");
        let path_text = path.to_str().unwrap().to_owned();
        let missing = read_file(path_text.clone(), Some(true)).await.unwrap_err();
        assert!(missing.starts_with("ENOENT:"), "{missing}");
        fs::write(&path, [0xff, 0x0a]).unwrap();
        let invalid = read_file(path_text.clone(), Some(true)).await.unwrap_err();
        assert!(invalid.starts_with("INVALID_UTF8:"), "{invalid}");
        fs::write(&path, b"\xef\xbb\xbf{}\r\n").unwrap();
        assert_eq!(
            read_file(path_text, Some(true)).await.unwrap(),
            "\u{feff}{}\r\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// S4-R2 kill-9 harness：崩溃写原子性＋恢复时间阈值，连续 5 轮通过。
    /// 子进程＝同一测试二进制（env NIKO_CRASH_WRITER=目标路径）循环写单调版本；
    /// 父进程用 std child.kill()（TerminateProcess/SIGKILL，不做任何清理）击杀后断言：
    /// 目标文件恒为某次完整写入（`v-%08d-` 前缀＋定长载荷，零撕裂/零空文件），
    /// 且 kill 后首次读回耗时 < 2000ms。每轮独立目标文件与目录。
    #[test]
    fn crash_kill_write_atomicity_and_recovery() {
        let exe = std::env::current_exe().expect("current test exe");
        let root = std::env::temp_dir().join(format!("niko-crash-harness-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("harness root");
        for round in 0..5u32 {
            let target = root.join(format!("chapter-{round}.md"));
            let target_s = target.to_string_lossy().to_string();
            let mut child = std::process::Command::new(&exe)
                .arg("__crash_writer_loop")
                .arg("--nocapture")
                .env("NIKO_CRASH_WRITER", &target_s)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn crash writer");
            // 等子进程至少完成几次写入（版本单调递增，载荷 4KB/次，远超 rename 窗口）
            std::thread::sleep(std::time::Duration::from_millis(1500));
            child.kill().expect("kill crash writer");
            let _ = child.wait();
            // 恢复：首次读回计时（阈值 2000ms，真实读回为毫秒级）
            let t0 = std::time::Instant::now();
            let content = std::fs::read_to_string(&target)
                .unwrap_or_else(|e| panic!("round {round}: 目标文件不可读: {e}"));
            let elapsed = t0.elapsed();
            assert!(
                elapsed < std::time::Duration::from_millis(2000),
                "round {round}: 恢复读回超时: {elapsed:?}"
            );
            // 完整性：必须匹配某次完整写入，拒绝撕裂/截断/空文件
            assert!(!content.is_empty(), "round {round}: 空文件（撕裂）");
            let head = content.split('-').collect::<Vec<_>>();
            assert!(
                content.starts_with("v-") && head.len() >= 3 && content.len() > 4100,
                "round {round}: 内容非完整版本（撕裂）: len={} head={:?}",
                content.len(),
                &content[..content.len().min(32)]
            );
            let _ = std::fs::remove_file(&target);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// kill-9 harness 子进程入口：env 置位时循环写单调版本直到被击杀；
    /// 常规测试运行时 env 未置位，直接返回（恒通过）。
    #[test]
    fn __crash_writer_loop() {
        let Ok(path) = std::env::var("NIKO_CRASH_WRITER") else {
            return;
        };
        let mut i: u64 = 0;
        loop {
            i += 1;
            let payload = format!("v-{i:08}-{}", "x".repeat(4096));
            let _ = do_write_file_atomic(&path, &payload);
        }
    }

    /// Ad-hoc probe: run the production PDF extraction path against every
    /// .pdf under a user-provided directory and print a per-file report of
    /// Ok / Err (library returned an error) / Panic (library panicked and
    /// was caught by panic_guard). Gated with #[ignore] so it never runs
    /// in CI; execute locally with:
    ///
    ///   PDF_PROBE_DIR=/path/to/pdfs cargo test --lib \
    ///     -- --ignored --nocapture pdf_probe
    #[test]
    #[ignore = "local probe; set PDF_PROBE_DIR"]
    fn pdf_probe() {
        let dir = std::env::var("PDF_PROBE_DIR")
            .unwrap_or_else(|_| "/Users/nash_su/Downloads/pdftests".to_string());
        let root = std::path::Path::new(&dir);
        if !root.exists() {
            eprintln!("[pdf_probe] dir not found: {}", root.display());
            return;
        }

        let mut pdfs: Vec<std::path::PathBuf> = Vec::new();
        fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            if let Ok(entries) = fs::read_dir(d) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else if p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("pdf"))
                        .unwrap_or(false)
                    {
                        out.push(p);
                    }
                }
            }
        }
        walk(root, &mut pdfs);
        pdfs.sort();

        eprintln!(
            "\n[pdf_probe] found {} PDFs under {}\n",
            pdfs.len(),
            root.display()
        );

        let mut ok = 0usize;
        let mut err = 0usize;
        let mut panicked = 0usize;

        for (idx, path) in pdfs.iter().enumerate() {
            let display = path.display().to_string();
            // Call extract_pdf_text directly (not read_file) so we bypass
            // the .cache sibling dir and always exercise the parser.
            let path_str = path.to_string_lossy().to_string();
            let result = std::panic::catch_unwind(|| extract_pdf_text(&path_str));
            match result {
                Ok(Ok(text)) => {
                    ok += 1;
                    eprintln!(
                        "[{:>3}/{}] OK     ({:>7} chars)  {}",
                        idx + 1,
                        pdfs.len(),
                        text.len(),
                        display
                    );
                }
                Ok(Err(e)) => {
                    err += 1;
                    eprintln!(
                        "[{:>3}/{}] ERR    {}  →  {}",
                        idx + 1,
                        pdfs.len(),
                        display,
                        e
                    );
                }
                Err(payload) => {
                    panicked += 1;
                    let msg = if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else {
                        "(non-string panic)".to_string()
                    };
                    eprintln!(
                        "[{:>3}/{}] PANIC  {}  →  {}",
                        idx + 1,
                        pdfs.len(),
                        display,
                        msg
                    );
                }
            }
        }

        eprintln!(
            "\n[pdf_probe] summary: {} OK / {} ERR / {} PANIC (total {})",
            ok,
            err,
            panicked,
            pdfs.len()
        );
    }

    // ── collect_related_pages: regression coverage for the three match ─────
    // strategies used by findRelatedWikiPages.
    //
    // Strategy 1: quoted filename anywhere in content
    //               (e.g. `sources: ["test.md"]` inline form)
    // Strategy 2: page lives under wiki/sources/ and starts with file stem
    //               (the source summary page)
    // Strategy 3: filename appears inside the frontmatter's sources BLOCK
    //               (tightened: no longer false-positives on `title:`
    //                `description:` or any other field that happens to
    //                include the filename as a substring)
    //
    // These tests are the regression guard for the Strategy 3 fix — before
    // the tightening, a page whose title included the deleted filename
    // would be surfaced here and then wrongly deleted downstream.

    fn make_wiki(files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wiki-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        for (rel, body) in files {
            let p = dir.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, body).unwrap();
        }
        dir
    }

    fn collect(wiki: &std::path::Path, source: &str) -> Vec<String> {
        let mut out = Vec::new();
        collect_related_pages(wiki, source, &mut out).unwrap();
        // Normalize to the wiki-relative suffix so assertions are
        // independent of the temp prefix.
        let prefix = wiki.to_string_lossy().replace('\\', "/");
        out.into_iter()
            .map(|p| {
                let p = p.replace('\\', "/");
                p.strip_prefix(&format!("{}/", prefix))
                    .map(str::to_string)
                    .unwrap_or(p)
            })
            .collect()
    }

    #[test]
    fn collect_related_strategy1_inline_quoted_sources() {
        let wiki = make_wiki(&[
            (
                "concepts/rope.md",
                "---\ntitle: RoPE\nsources: [\"test.md\"]\n---\nbody\n",
            ),
            (
                "concepts/unrelated.md",
                "---\ntitle: Unrelated\nsources: [\"other.md\"]\n---\nbody\n",
            ),
        ]);
        let mut got = collect(&wiki, "test.md");
        got.sort();
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy1_single_quoted_sources() {
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources: ['test.md']\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy2_source_summary_page() {
        // A page inside wiki/sources/ whose filename starts with the
        // deleted source's stem counts as the source-summary page —
        // kept linked even if its sources field happens to be missing.
        let wiki = make_wiki(&[
            ("sources/test.md", "---\ntitle: Test Summary\n---\nbody\n"),
            (
                "concepts/unrelated.md",
                "---\ntitle: Unrelated\nsources: [\"other.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["sources/test.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_multi_line_yaml_list() {
        // Multi-line YAML sources block with an unquoted entry — Strategy
        // 1 can't see this (no quotes), Strategy 3 has to walk the
        // sources block line by line.
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources:\n  - test.md\n  - \"other.md\"\ntags: []\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_does_not_false_positive_on_title_substring() {
        // Regression guard for the bug we just fixed: a page whose
        // title / description contains the deleted filename MUST NOT
        // be surfaced when its actual sources list is unrelated.
        // Before the fix, the whole frontmatter was substring-scanned
        // and this page would have been returned → downstream delete
        // flow → silent data loss on an innocent page.
        let wiki = make_wiki(&[
            (
                "concepts/rope.md",
                "---\ntitle: Analysis of test.md\ndescription: Discusses test.md in depth\nsources: [\"other.md\"]\n---\nbody\n",
            ),
            (
                "concepts/real-match.md",
                "---\ntitle: Real\nsources: [\"test.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        // Only the real-match page is surfaced. The title-substring
        // page is correctly ignored now.
        assert_eq!(got, vec!["concepts/real-match.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_stops_at_next_top_level_field() {
        // Scan must stop at the next top-level YAML key so that a
        // filename appearing in a later field (e.g. `notes:`) doesn't
        // get pulled into the sources block.
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources:\n  - other.md\nnotes: See test.md for context\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        // sources block has only other.md; test.md appears in `notes:`
        // which is outside the block — must not match.
        assert!(got.is_empty(), "expected empty, got {got:?}");
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_returns_empty_when_nothing_matches() {
        let wiki = make_wiki(&[(
            "concepts/unrelated.md",
            "---\ntitle: X\nsources: [\"other.md\"]\n---\nbody\n",
        )]);
        let got = collect(&wiki, "nonexistent.md");
        assert!(got.is_empty());
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_skips_index_log_overview() {
        // Listing pages (index.md, log.md, overview.md) reference the
        // filename heavily but should never be returned here — they're
        // cleaned separately via the TS cleanup helpers.
        let wiki = make_wiki(&[
            (
                "index.md",
                "---\ntitle: Index\n---\n- [[Test]]\nsources: [\"test.md\"]\n",
            ),
            (
                "log.md",
                "---\ntitle: Log\n---\nIngested test.md on 2026-01-01\n",
            ),
            (
                "overview.md",
                "---\ntitle: Overview\n---\nCovers test.md and other.md\n",
            ),
            (
                "concepts/real.md",
                "---\ntitle: Real\nsources: [\"test.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/real.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_case_insensitive_filename_match() {
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources: [\"Test.md\"]\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    // ── copy_directory: folder import recursion + filtering ──────────
    //
    // The folder-import flow on the JS side calls this command and
    // expects:
    //   1. Recursion goes ALL the way down (no depth cap) — users
    //      drop trees with arbitrary nesting and every file inside
    //      should reach the wiki.
    //   2. Dotfiles / dot-directories are skipped (`.git`, `.cache`,
    //      `.DS_Store`) — otherwise a folder with a `.git/` would
    //      import megabytes of git plumbing as "source files."
    //   3. Returned paths are FLAT (one entry per file, regardless
    //      of depth) and use forward slashes (the JS layer normalizes
    //      everything to `/` before doing path comparisons).
    //
    // These are exactly the invariants `handleImportFolder` in
    // sources-view.tsx assumes — pinning them here keeps a future
    // refactor of the recursive copier from silently breaking the
    // folder import button.

    fn make_temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "llmwiki-copydir-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pull the inner sync `copy_recursive` body out from
    /// `copy_directory` so the test doesn't need to spin up a
    /// tokio runtime just to exercise file-system recursion.
    /// Mirrors the same logic the async command uses.
    fn copy_dir_for_test(src: &Path, dest: &Path) -> Vec<String> {
        std::fs::create_dir_all(dest).unwrap();
        let mut out = Vec::new();
        fn rec(src: &Path, dest: &Path, files: &mut Vec<String>) {
            std::fs::create_dir_all(dest).unwrap();
            for entry in std::fs::read_dir(src).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let dest_path = dest.join(&name);
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    rec(&path, &dest_path, files);
                } else {
                    std::fs::copy(&path, &dest_path).unwrap();
                    files.push(dest_path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        rec(src, dest, &mut out);
        out
    }

    #[test]
    fn copy_directory_recurses_arbitrary_depth() {
        let src = make_temp_dir("src-deep");
        // Build /src/a/b/c/d/e/leaf.txt — five levels under root.
        let leaf_dir = src.join("a/b/c/d/e");
        std::fs::create_dir_all(&leaf_dir).unwrap();
        std::fs::write(leaf_dir.join("leaf.txt"), b"deep content").unwrap();
        // Plus a top-level file to ensure root files come along too.
        std::fs::write(src.join("top.md"), b"# top").unwrap();

        let dest = make_temp_dir("dest-deep");
        let copied = copy_dir_for_test(&src, &dest);

        assert_eq!(copied.len(), 2, "expected two files, got: {:?}", copied);
        // Deep file made it across with full nesting preserved.
        let leaf_dest = dest.join("a/b/c/d/e/leaf.txt");
        assert!(
            leaf_dest.exists(),
            "deep leaf.txt missing at {:?}",
            leaf_dest
        );
        assert_eq!(std::fs::read(&leaf_dest).unwrap(), b"deep content");
        // Top-level file too.
        assert!(dest.join("top.md").exists());
        // Returned paths are forward-slashed and absolute.
        for p in &copied {
            assert!(!p.contains('\\'), "path should be /-normalized: {p}");
            assert!(Path::new(p).is_absolute(), "path should be absolute: {p}");
        }

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn copy_directory_skips_dotfiles_and_dot_directories() {
        let src = make_temp_dir("src-dots");
        // Visible content:
        std::fs::write(src.join("keep.md"), b"keep me").unwrap();
        std::fs::create_dir_all(src.join("subdir")).unwrap();
        std::fs::write(src.join("subdir/keep2.md"), b"keep me too").unwrap();
        // Things that must be skipped:
        std::fs::write(src.join(".DS_Store"), b"junk").unwrap();
        std::fs::create_dir_all(src.join(".git/objects")).unwrap();
        std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        std::fs::write(src.join(".git/objects/abc"), b"\x78\x9c").unwrap();
        std::fs::write(src.join(".env"), b"SECRET=foo").unwrap();
        // Sneaky one: a dot-prefixed dir nested inside a normal dir
        // should ALSO be skipped (the dotfile rule applies at every
        // recursion level, not just the top).
        std::fs::create_dir_all(src.join("subdir/.cache")).unwrap();
        std::fs::write(src.join("subdir/.cache/blob"), b"cache").unwrap();

        let dest = make_temp_dir("dest-dots");
        let copied = copy_dir_for_test(&src, &dest);

        assert_eq!(
            copied.len(),
            2,
            "should copy only the 2 visible files, got: {:?}",
            copied,
        );
        assert!(dest.join("keep.md").exists());
        assert!(dest.join("subdir/keep2.md").exists());
        // Dot-stuff must NOT be on disk in the destination.
        assert!(!dest.join(".DS_Store").exists());
        assert!(!dest.join(".git").exists());
        assert!(!dest.join(".env").exists());
        assert!(!dest.join("subdir/.cache").exists());

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    // ── path_is_directory: DI-1 目录判定门（禁止 len() 推断） ──────────
    //
    // 背景：data-manager「移入回收站」旧实现用 `get_file_size` 失败推断目录；
    // 但 Windows 上 `metadata(dir).len()` 返回 Ok(0)，目录被误判为文件 →
    // `copy_file` 对目录必败（错误被吞）→ 源目录被 remove_dir_all 递归删除
    // （不可恢复，DI-1）。目录判定的唯一可信来源是 file_type().is_dir()。

    #[test]
    fn path_is_directory_distinguishes_dir_from_file() {
        let root = make_temp_dir("path-kind");
        let dir = root.join("domain-dir");
        fs::create_dir_all(dir.join("nested")).unwrap();
        let empty_dir = root.join("empty-dir");
        fs::create_dir_all(&empty_dir).unwrap();
        let file = root.join("domain-file.json");
        fs::write(&file, b"{}").unwrap();
        let missing = root.join("missing");

        assert!(
            do_path_is_directory(&dir.to_string_lossy()).unwrap(),
            "existing directory must be reported as directory"
        );
        assert!(
            do_path_is_directory(&empty_dir.to_string_lossy()).unwrap(),
            "empty directory must be reported as directory"
        );
        assert!(
            !do_path_is_directory(&file.to_string_lossy()).unwrap(),
            "regular file must not be reported as directory"
        );
        assert!(
            !do_path_is_directory(&missing.to_string_lossy()).unwrap(),
            "missing path must be reported as not-a-directory"
        );

        // 文档化关键事实：Windows 上目录的 metadata.len() 为 Ok(0)（正是旧
        // TS 启发式 size < 0 把目录误判为文件的来源）。目录判定必须独立于
        // len()，本测试断言 file_type 路径不受 len 影响。
        #[cfg(windows)]
        assert_eq!(
            fs::metadata(&empty_dir).unwrap().len(),
            0,
            "Windows 上空目录 metadata.len()==0 —— len()==0 绝不可作为文件判定依据"
        );
        assert!(fs::metadata(&empty_dir).unwrap().file_type().is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_directory_returns_flat_list_with_forward_slashes() {
        let src = make_temp_dir("src-flat");
        std::fs::create_dir_all(src.join("year/2024/q3")).unwrap();
        std::fs::write(src.join("year/2024/q3/report.pdf"), b"%PDF-fake").unwrap();
        std::fs::write(src.join("year/2024/notes.md"), b"# notes").unwrap();

        let dest = make_temp_dir("dest-flat");
        let copied = copy_dir_for_test(&src, &dest);

        // Both files in the flat list, ordered by file-system traversal
        // (we don't care about exact order, but every entry must be
        // forward-slashed and end with the expected filename).
        let names: Vec<String> = copied
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert!(names.contains(&"report.pdf".to_string()));
        assert!(names.contains(&"notes.md".to_string()));
        assert_eq!(copied.len(), 2);
        for p in &copied {
            assert!(p.contains('/'), "should contain at least one /: {p}");
            assert!(!p.contains('\\'), "should NOT contain \\: {p}");
        }

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn legacy_doc_best_effort_extracts_utf16_text() {
        let mut bytes = Vec::new();
        for unit in "第一章 危机降临\n主角立刻行动".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }

        let extracted = extract_legacy_doc_text_from_bytes(&bytes)
            .expect("legacy doc text should be extracted");

        assert!(extracted.contains("第一章 危机降临"), "{extracted}");
        assert!(extracted.contains("主角立刻行动"), "{extracted}");
    }

    // ── cache versioning (C1) ───────────────────────────────────────────

    #[test]
    fn cache_path_embeds_extractor_version() {
        let dir = make_temp_dir("cachever");
        let original = dir.join("book.epub");
        let cache = cache_path_for(&original);

        let expected = format!("book.epub.v{}.txt", EXTRACTOR_VERSION);
        assert!(
            cache.to_string_lossy().ends_with(&expected),
            "got {}",
            cache.display()
        );
        // A future version bump yields a different key ⇒ old caches
        // naturally miss without any explicit cleanup.
        let next = dir
            .join(".cache")
            .join(format!("book.epub.v{}.txt", EXTRACTOR_VERSION + 1));
        assert_ne!(cache, next);
        // The pre-version legacy name is also distinct.
        let legacy = dir.join(".cache").join("book.epub.txt");
        assert_ne!(cache, legacy);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── EPUB extraction ─────────────────────────────────────────────────

    /// Build an EPUB (ZIP) archive in memory from `(archive_path, content)`
    /// pairs, using the stored default compression so the bytes round-trip.
    fn build_epub(files: &[(&str, &str)]) -> Vec<u8> {
        use zip::write::SimpleFileOptions;
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, content) in files {
                w.start_file(*name, options).unwrap();
                w.write_all(content.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    /// Persist `bytes` to a freshly named `.epub` in the OS tempdir.
    fn tmp_epub(label: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "niko-buddy-epub-{label}-{}.epub",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    const MINI_EPUB_CONTAINER: &str = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    fn mini_opf(spine_idrefs: &[&str]) -> String {
        let mut man = String::from("<manifest>\n");
        let mut spin = String::from("<spine>\n");
        for id in spine_idrefs {
            man.push_str(&format!(
                "<item id=\"{id}\" href=\"Text/{id}.xhtml\" media-type=\"application/xhtml+xml\"/>\n"
            ));
            spin.push_str(&format!("<itemref idref=\"{id}\"/>\n"));
        }
        man.push_str("</manifest>\n");
        spin.push_str("</spine>\n");
        format!("<?xml version=\"1.0\"?><package version=\"3.0\">{man}{spin}</package>")
    }

    #[test]
    fn epub_extracts_text_in_spine_order_and_decodes_entities() {
        let c1 = r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch1</title></head><body>
<h1>Chapter One</h1>
<p>Hello &amp; <b>world</b></p>
<p>Second &nbsp;para</p>
</body></html>"#;
        let c2 = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>Chapter Two</h2><p>Tail &lt;3</p><p>Final.</p></body></html>"#;
        let bytes = build_epub(&[
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", MINI_EPUB_CONTAINER),
            ("OEBPS/content.opf", &mini_opf(&["c1", "c2"])),
            ("OEBPS/Text/c1.xhtml", c1),
            ("OEBPS/Text/c2.xhtml", c2),
        ]);
        let path = tmp_epub("spine", &bytes);
        let out = extract_epub_text(&path).unwrap();
        let _ = fs::remove_file(&path);

        // Entities decoded, tags stripped; c1 precedes c2 (spine order).
        assert!(out.contains("Hello & world"), "{out}");
        assert!(out.contains("Second  para"), "{out}");
        assert!(out.contains("Tail <3"), "{out}");
        assert!(
            out.find("Chapter One").unwrap() < out.find("Chapter Two").unwrap(),
            "spine order violated: {out}"
        );
        // Paragraph breaks preserved as separate lines (no inline fusion).
        assert!(out.contains("Second  para"), "{out}");
    }

    #[test]
    fn epub_falls_back_to_sorted_content_when_spine_empty() {
        // OPF exists but has no <spine>/<itemref> → fallback to sorted
        // .xhtml entries, which must NOT include META-INF.
        let opf = r#"<?xml version="1.0"?><package>ok</package>"#;
        let bytes = build_epub(&[
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", MINI_EPUB_CONTAINER),
            ("OEBPS/content.opf", opf),
            ("OEBPS/Text/b.xhtml", "<p>Beta body</p>"),
            ("OEBPS/Text/a.xhtml", "<p>Alpha body</p>"),
        ]);
        let path = tmp_epub("fallback", &bytes);
        let out = extract_epub_text(&path).unwrap();
        let _ = fs::remove_file(&path);

        let alpha = out.find("Alpha body").unwrap();
        let beta = out.find("Beta body").unwrap();
        assert!(
            alpha < beta,
            "fallback should sort a.xhtml before b.xhtml: {out}"
        );
    }

    #[test]
    fn epub_rejects_zip_bomb_entry_count() {
        // More entries than the limit SHOULD be rejected before any body
        // is decompressed (entry-count limb of the zip-bomb defense).
        let mut files: Vec<(&str, &str)> = Vec::with_capacity(EXTRACT_MAX_ENTRIES + 1);
        for i in 0..EXTRACT_MAX_ENTRIES + 1 {
            files.push((format!("entry{i:05}.bin").leak(), "x"));
        }
        let bytes = build_epub(&files);
        let path = tmp_epub("bomb-count", &bytes);
        let err = extract_epub_text(&path).unwrap_err();
        let _ = fs::remove_file(&path);
        assert!(err.contains("exceeds limit"), "{err}");
    }

    #[test]
    fn epub_rejects_corrupt_or_non_zip() {
        let path = tmp_epub("corrupt", b"definitely not a zip archive");
        let err = extract_epub_text(&path).unwrap_err();
        let _ = fs::remove_file(&path);
        assert!(!err.is_empty());
        assert!(
            err.contains("EPUB") || err.contains("ZIP"),
            "expected EPUB/ZIP error mentioning, got: {err}"
        );
    }

    #[test]
    fn epub_missing_container_is_an_error() {
        // Valid ZIP but no META-INF/container.xml -> clear error, no partial
        // output, and certainly no panic.
        let bytes = build_epub(&[("mimetype", "application/epub+zip")]);
        let path = tmp_epub("nocontainer", &bytes);
        let err = extract_epub_text(&path).unwrap_err();
        let _ = fs::remove_file(&path);
        assert!(err.contains("container.xml"), "{err}");
    }

    // ---- HTML extraction (A10) ------------------------------------------------

    #[test]
    fn html_dispatch_handles_htm_via_do_read_file_route() {
        // `.htm` must be routed through `extract_html_file` (not the raw
        // `read_to_string` fallback): script bodies are stripped and
        // entities are decoded on that path.
        let html = r#"<html><body><script>secret()</script><h2>Visible Text</h2><p>Fish &amp; chips</p></body></html>"#;
        let dir = make_temp_dir("htm-route");
        let p = dir.join("page.htm");
        std::fs::write(&p, html).unwrap();
        let p_str = p.to_string_lossy().into_owned();
        let out = do_read_file(&p_str).unwrap();
        let _ = fs::remove_file(&p);
        let _ = fs::remove_dir_all(&dir);
        assert!(out.contains("Visible Text"), "{out}");
        // HTML-specialized extraction applies: entity decoded + script gone.
        assert!(out.contains("Fish & chips"), "{out}");
        assert!(!out.contains("&amp;"), "{out}");
        assert!(!out.contains("secret()"), "{out}");
    }

    // ===== 58 号 P0-B2：write_file_atomic 冒烟（IPC 命令层关键路径） =====

    #[test]
    fn write_file_atomic_smoke_writes_content_and_reads_back() {
        let dir = make_temp_dir("wfa-smoke");
        let p = dir.join("sub").join("ch1.md");
        let p_str = p.to_string_lossy().into_owned();
        do_write_file_atomic(&p_str, "# 第一章\n\n正文。").unwrap();
        let read = std::fs::read_to_string(&p).unwrap();
        assert_eq!(read, "# 第一章\n\n正文。");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_atomic_smoke_rejects_unsafe_path() {
        // 越界路径（`..`）必须被拒绝，不产生任何文件
        let dir = make_temp_dir("wfa-unsafe");
        let bad = dir.join("..").join("escape.md");
        let bad_str = bad.to_string_lossy().into_owned();
        assert!(do_write_file_atomic(&bad_str, "x").is_err());
        assert!(!bad.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_atomic_smoke_overwrites_existing() {
        let dir = make_temp_dir("wfa-overwrite");
        let p = dir.join("ch.md");
        let p_str = p.to_string_lossy().into_owned();
        do_write_file_atomic(&p_str, "旧内容").unwrap();
        do_write_file_atomic(&p_str, "新内容").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "新内容");
        assert_no_batch_temps(&dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_atomic_rejects_empty_file_name() {
        let err = do_write_file_atomic("/", "data").unwrap_err();
        assert!(err.contains("no file name"), "{err}");
    }

    #[test]
    fn write_file_atomic_cleans_staged_temp_and_keeps_original_on_rename_failure() {
        let dir = make_temp_dir("wfa-rename-fail");
        let target = dir.join("chapter.md");
        fs::write(&target, b"original content").unwrap();

        // 模拟 rename 失败：StagedBytes Drop 必须自动清理 .nb-write-* 暂存文件且原文件完好。
        let err = StagedBytes::prepare(&target, b"new content", None)
            .unwrap()
            .commit(&target, |_, _| {
                Err(std::io::Error::other("synthetic rename failure"))
            })
            .unwrap_err();
        assert!(err.contains("synthetic rename failure"), "{err}");
        assert_eq!(fs::read(&target).unwrap(), b"original content");
        assert_no_batch_temps(&dir);

        // 真实 fs::rename 失败（目标为非空目录）经 do_write_file_atomic 也必须清理暂存文件。
        let dir_target = dir.join("existing-dir");
        fs::create_dir_all(&dir_target).unwrap();
        fs::write(dir_target.join("keep.txt"), b"keep").unwrap();
        let dir_target_str = dir_target.to_string_lossy().into_owned();
        assert!(do_write_file_atomic(&dir_target_str, "overwrite").is_err());
        assert_eq!(fs::read(dir_target.join("keep.txt")).unwrap(), b"keep");
        assert_no_batch_temps(&dir);

        let _ = fs::remove_dir_all(&dir);
    }

    fn batch_entry(path: &Path, contents: &str) -> (String, String) {
        (path.to_str().unwrap().to_owned(), contents.to_owned())
    }

    fn assert_no_batch_temps(dir: &Path) {
        assert!(fs::read_dir(dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".nb-write-")));
    }

    #[test]
    fn batch_late_rename_failure_restores_exact_bytes() {
        let dir = make_temp_dir("batch-compensate");
        let first = dir.join("first.md");
        let second = dir.join("second.md");
        let last = dir.join("last.md");
        let original = b"\xEF\xBB\xBFbefore\r\n\xFF\0";
        fs::write(&first, original).unwrap();
        fs::write(&second, b"second original").unwrap();
        let files = [
            batch_entry(&first, "first updated"),
            batch_entry(&second, "second updated"),
            batch_entry(&last, "never committed"),
        ];

        let calls = std::cell::Cell::new(0);
        let err = do_write_files_atomic_inner(&files, None, |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                fs::rename(from, to)
            } else {
                Err(std::io::Error::other("synthetic late rename failure"))
            }
        })
        .unwrap_err();

        assert_eq!(calls.get(), 2);
        assert!(err.contains("synthetic late rename failure"), "{err}");
        assert!(err.contains("compensated 1"), "{err}");
        assert_eq!(fs::read(&first).unwrap(), original);
        assert_eq!(fs::read(&second).unwrap(), b"second original");
        assert!(!last.exists());
        assert_no_batch_temps(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn batch_rollback_preserves_newer_edit_and_removes_its_own_creation() {
        let dir = make_temp_dir("batch-compensation-conflict");
        let first = dir.join("first.md");
        let new = dir.join("new.md");
        let last = dir.join("last.md");
        fs::write(&first, b"first original").unwrap();
        let files = [
            batch_entry(&new, "new payload"),
            batch_entry(&first, "first updated"),
            batch_entry(&last, "never committed"),
        ];

        let calls = std::cell::Cell::new(0);
        let later = b"newer edit\xFF";
        let err = do_write_files_atomic_inner(&files, None, |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() < 3 {
                fs::rename(from, to)
            } else {
                fs::write(&first, later)?;
                Err(std::io::Error::other("synthetic late rename failure"))
            }
        })
        .unwrap_err();

        assert_eq!(calls.get(), 3);
        assert!(err.contains("synthetic late rename failure"), "{err}");
        assert!(
            err.contains("rollback conflicts") && err.contains("first.md"),
            "{err}"
        );
        assert_eq!(fs::read(&first).unwrap(), later);
        assert!(!new.exists());
        assert!(!last.exists());
        assert_no_batch_temps(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn batch_rechecks_the_next_target_before_commit() {
        let dir = make_temp_dir("batch-recheck");
        let first = dir.join("first.md");
        let next = dir.join("next.md");
        fs::write(&first, b"original").unwrap();
        let files = [batch_entry(&first, "updated"), batch_entry(&next, "new")];
        let calls = std::cell::Cell::new(0);
        let err = do_write_files_atomic_inner(&files, None, |from, to| {
            calls.set(calls.get() + 1);
            fs::rename(from, to)?;
            fs::write(&next, b"created elsewhere")
        })
        .unwrap_err();

        assert_eq!(calls.get(), 1);
        assert!(err.contains("changed before commit"), "{err}");
        assert_eq!(fs::read(&first).unwrap(), b"original");
        assert_eq!(fs::read(&next).unwrap(), b"created elsewhere");
        assert_no_batch_temps(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn batch_final_readback_keeps_later_edit_and_compensates_other_targets() {
        let dir = make_temp_dir("batch-final-readback");
        let first = dir.join("first.md");
        let second = dir.join("second.md");
        fs::write(&first, b"first original").unwrap();
        fs::write(&second, b"second original").unwrap();
        let files = [
            batch_entry(&first, "first updated"),
            batch_entry(&second, "second updated"),
        ];
        let calls = std::cell::Cell::new(0);
        let err = do_write_files_atomic_inner(&files, None, |from, to| {
            calls.set(calls.get() + 1);
            fs::rename(from, to)?;
            if calls.get() == 2 {
                fs::write(&first, b"external ")?;
            }
            Ok(())
        })
        .unwrap_err();
        assert_eq!(calls.get(), 2);
        assert!(err.contains("failed final readback"), "{err}");
        assert!(err.contains("rollback conflicts"), "{err}");
        assert_eq!(fs::read(&first).unwrap(), b"external ");
        assert_eq!(fs::read(&second).unwrap(), b"second original");
        assert_no_batch_temps(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn batch_expected_stale_before_staging() {
        let dir = make_temp_dir("batch-expected-stale");
        let first = dir.join("first.md");
        let next = dir.join("next.md");
        fs::write(&first, b"actual").unwrap();
        let files = [batch_entry(&first, "updated"), batch_entry(&next, "new")];
        let expected = [Some("old".to_owned()), None];
        let err = do_write_files_atomic_inner(&files, Some(&expected), |_, _| {
            panic!("stale input must not commit")
        })
        .unwrap_err();
        assert!(err.contains("changed before staging"), "{err}");
        assert_eq!(fs::read(&first).unwrap(), b"actual");
        assert!(!next.exists());
        assert_no_batch_temps(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn batch_postrename_readback_reports_conflict_and_keeps_foreign_bytes() {
        let dir = make_temp_dir("batch-readback-conflict");
        let first = dir.join("first.md");
        let marker = dir.join("saved.md");
        fs::write(&first, b"original").unwrap();
        let files = [
            batch_entry(&first, "updated"),
            batch_entry(&marker, "marker"),
        ];
        let calls = std::cell::Cell::new(0);
        let err = do_write_files_atomic_inner(&files, None, |from, to| {
            calls.set(calls.get() + 1);
            fs::rename(from, to)?;
            fs::write(to, b"later edit")
        })
        .unwrap_err();
        assert_eq!(calls.get(), 1);
        assert!(err.contains("failed readback"), "{err}");
        assert!(err.contains("rollback conflicts"), "{err}");
        assert_eq!(fs::read(&first).unwrap(), b"later edit");
        assert!(!marker.exists());
        assert_no_batch_temps(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn batch_rejects_duplicate_paths_after_virtual_mapping() {
        let dir = make_temp_dir("batch-duplicate");
        let physical = dir.join("QM").join("same.md");
        let virtual_path = dir.join("wiki").join("same.md");
        fs::create_dir_all(physical.parent().unwrap()).unwrap();
        fs::write(&physical, b"original").unwrap();
        let files = [
            batch_entry(&virtual_path, "first"),
            batch_entry(&physical, "second"),
        ];
        let err = do_write_files_atomic_inner(&files, None, |_, _| {
            panic!("a duplicate must be rejected before committing")
        })
        .unwrap_err();
        assert!(err.contains("Duplicate physical batch target"), "{err}");
        assert_eq!(fs::read(&physical).unwrap(), b"original");
        assert!(!virtual_path.exists());
        assert_no_batch_temps(physical.parent().unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// exclusive copy: 字节级复制；目标已存在时 no-op 不覆盖既有字节。
    #[test]
    fn exclusive_copy_keeps_existing_destination_bytes() {
        let dir = make_temp_dir("copy-exclusive");
        let src = dir.join("src.bin");
        let dst = dir.join("dst.bin");
        let src_str = src.to_string_lossy().into_owned();
        let dst_str = dst.to_string_lossy().into_owned();

        // 非 UTF-8 字节按原样复制（readback 验证无重编码）。
        let payload: Vec<u8> = vec![0xff, 0x0a, 0x00, 0x41, 0x80];
        std::fs::write(&src, &payload).unwrap();
        do_copy_file(&src_str, &dst_str, true).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), payload);

        // 改源后再次 exclusive 复制：既有目标字节保持不动。
        std::fs::write(&src, b"changed").unwrap();
        do_copy_file(&src_str, &dst_str, true).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), payload);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn guarded_removal_deletes_unchanged_new_file() {
        let dir = make_temp_dir("guarded-delete");
        let target = dir.join("new-file.md");
        fs::write(&target, b"expected bytes").unwrap();

        remove_regular_file_if_unchanged(&target, b"expected bytes").unwrap();

        assert!(!target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn guarded_removal_keeps_changed_bytes() {
        let dir = make_temp_dir("guarded-delete-changed");
        let target = dir.join("new-file.md");
        fs::write(&target, b"foreign bytes").unwrap();

        let err = remove_regular_file_if_unchanged(&target, b"expected bytes").unwrap_err();

        assert!(err.contains("target changed"), "{err}");
        assert_eq!(fs::read(&target).unwrap(), b"foreign bytes");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn guarded_removal_refuses_open_writer_and_deletes_after_drop() {
        let dir = make_temp_dir("guarded-delete-lock");
        let target = dir.join("new-file.md");
        fs::write(&target, b"expected bytes").unwrap();

        // 一个仍持有写权限的句柄阻止 share_mode(0) 独占打开 → 守卫拒绝且字节保持。
        let writer = fs::OpenOptions::new().write(true).open(&target).unwrap();
        let err = remove_regular_file_if_unchanged(&target, b"expected bytes").unwrap_err();
        assert!(err.contains("Could not open rollback target"), "{err}");
        assert_eq!(fs::read(&target).unwrap(), b"expected bytes");

        drop(writer);
        remove_regular_file_if_unchanged(&target, b"expected bytes").unwrap();
        assert!(!target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ── R-2：新建正式章节单次内容锁定回滚凭据闭环集成测试 ────────────────

    struct RollbackGateProject {
        root: PathBuf,
    }

    impl RollbackGateProject {
        fn new(tag: &str) -> Self {
            let root = make_temp_dir(&format!("rollback-gate-{tag}"));
            fs::create_dir_all(root.join("QM").join("chapters")).unwrap();
            fs::create_dir_all(root.join(".novel").join("audit")).unwrap();
            let canonical = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
            crate::agent_gate::set_gate_project_root(canonical);
            crate::agent_gate::__reset_state_for_test();
            Self { root }
        }

        fn audit_log(&self) -> String {
            fs::read_to_string(
                self.root
                    .join(".novel")
                    .join("audit")
                    .join("gate-audit.jsonl"),
            )
            .unwrap_or_default()
        }
    }

    impl Drop for RollbackGateProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn rollback_delete_allows_newly_created_qm_chapter_and_legacy_wiki_alias_with_audit() {
        let _serial = crate::agent_gate::gate_test_serial();
        let proj = RollbackGateProject::new("allow-new");

        // 1. 直接经 QM/chapters/ 新建并按原路径回滚删除。
        let qm_ch = proj.root.join("QM").join("chapters").join("chapter-001.md");
        let body_a = "---\ntype: chapter\nchapter_number: 1\n---\n正文 A\n";
        do_write_files_atomic(&[batch_entry(&qm_ch, body_a)], Some(&[None])).unwrap();
        assert!(qm_ch.exists());

        do_delete_file_if_unchanged(qm_ch.to_str().unwrap(), body_a).unwrap();
        assert!(!qm_ch.exists(), "新建章节凭精确内容回滚必须成功删除");

        // 2. 经 legacy wiki/chapters/ 新建，随后经 QM/chapters/ 回滚删除（须命中同一回滚键）。
        let wiki_ch2 = proj
            .root
            .join("wiki")
            .join("chapters")
            .join("chapter-002.md");
        let qm_ch2 = proj.root.join("QM").join("chapters").join("chapter-002.md");
        let body_b = "---\ntype: chapter\nchapter_number: 2\n---\n正文 B\n";
        do_write_files_atomic(&[batch_entry(&wiki_ch2, body_b)], Some(&[None])).unwrap();
        assert!(qm_ch2.exists());

        do_delete_file_if_unchanged(qm_ch2.to_str().unwrap(), body_b).unwrap();
        assert!(
            !qm_ch2.exists(),
            "经 wiki/ 别名新建后按 QM/ 路径回滚必须命中同一凭据"
        );

        // 3. 经 QM/chapters/ 新建，随后经 wiki/chapters/ 回滚删除。
        let qm_ch3 = proj.root.join("QM").join("chapters").join("chapter-003.md");
        let wiki_ch3 = proj
            .root
            .join("wiki")
            .join("chapters")
            .join("chapter-003.md");
        let body_c = "---\ntype: chapter\nchapter_number: 3\n---\n正文 C\n";
        do_write_files_atomic(&[batch_entry(&qm_ch3, body_c)], Some(&[None])).unwrap();
        assert!(qm_ch3.exists());

        do_delete_file_if_unchanged(wiki_ch3.to_str().unwrap(), body_c).unwrap();
        assert!(
            !qm_ch3.exists(),
            "经 QM/ 新建后按 wiki/ 别名回滚必须命中同一凭据"
        );

        // 审计日志必须包含 rollbackDeleteFile 与 rollback_ticket_verified。
        let audit = proj.audit_log();
        let records: Vec<crate::agent_gate::GateAuditRecord> = audit
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let rollback_records: Vec<_> = records
            .iter()
            .filter(|rec| rec.op == "rollbackDeleteFile")
            .collect();
        assert_eq!(rollback_records.len(), 3, "3 次回滚删除均应落审计日志");
        for rec in rollback_records {
            assert_eq!(rec.decision, crate::agent_gate::Decision::Allowed);
            assert_eq!(rec.actor, crate::agent_gate::GateActor::Agent);
            assert!(
                rec.hit_criteria
                    .iter()
                    .any(|c| c == "rollback_ticket_verified"),
                "审计判据必须记录 rollback_ticket_verified: {:?}",
                rec.hit_criteria
            );
        }
    }

    #[test]
    fn rollback_delete_denies_wrong_content_and_single_use_replay() {
        let _serial = crate::agent_gate::gate_test_serial();
        let proj = RollbackGateProject::new("replay-wrong");

        let ch = proj.root.join("QM").join("chapters").join("chapter-001.md");
        let ch_str = ch.to_str().unwrap();
        let exact = "exact freshly created content";
        do_write_files_atomic(&[batch_entry(&ch, exact)], Some(&[None])).unwrap();

        // 错内容调用 → 必须硬拒 GATE_DENIED，且文件保留。
        let wrong_err = do_delete_file_if_unchanged(ch_str, "tampered content").unwrap_err();
        assert!(
            wrong_err.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "错内容必须硬拒 GATE_DENIED: {wrong_err}"
        );
        assert!(ch.exists());

        // 首次精确内容调用 → 消耗单次凭据并删除成功。
        do_delete_file_if_unchanged(ch_str, exact).unwrap();
        assert!(!ch.exists());

        // 重建同名同内容文件后二次重放同一凭据 → 必须硬拒 GATE_DENIED。
        fs::write(&ch, exact).unwrap();
        let replay_err = do_delete_file_if_unchanged(ch_str, exact).unwrap_err();
        assert!(
            replay_err.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "单次凭据消耗后二次调用必须硬拒 GATE_DENIED: {replay_err}"
        );
        assert!(ch.exists());
    }

    #[test]
    fn rollback_delete_denies_existing_or_overwritten_qm_chapters() {
        let _serial = crate::agent_gate::gate_test_serial();
        let proj = RollbackGateProject::new("existing-overwrite");

        // 1. 既有文件（未经本次新建）即使传精确内容也必须硬拒。
        let existing = proj.root.join("QM").join("chapters").join("existing.md");
        let existing_str = existing.to_str().unwrap();
        fs::write(&existing, "pre-existing chapter").unwrap();
        let err_existing =
            do_delete_file_if_unchanged(existing_str, "pre-existing chapter").unwrap_err();
        assert!(
            err_existing.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "既有章节必须硬拒: {err_existing}"
        );
        assert!(existing.exists());

        // 2. `do_write_files_atomic` 覆盖既有文件（before.is_some()）不发放凭据 → 仍硬拒。
        do_write_files_atomic(
            &[batch_entry(&existing, "overwritten via batch")],
            Some(&[Some("pre-existing chapter".to_string())]),
        )
        .unwrap();
        let err_batch_overwrite =
            do_delete_file_if_unchanged(existing_str, "overwritten via batch").unwrap_err();
        assert!(
            err_batch_overwrite.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "批量覆盖既有章节不得生成回滚凭据: {err_batch_overwrite}"
        );
        assert!(existing.exists());

        // 3. 新建后被 `do_write_file` / `do_write_file_atomic` 覆盖 → 旧凭据必须被立即吊销。
        let ch_write = proj.root.join("QM").join("chapters").join("ch-write.md");
        let ch_write_str = ch_write.to_str().unwrap();
        do_write_files_atomic(&[batch_entry(&ch_write, "v1")], Some(&[None])).unwrap();
        do_write_file(ch_write_str, "v2").unwrap();
        let err_after_write = do_delete_file_if_unchanged(ch_write_str, "v2").unwrap_err();
        assert!(
            err_after_write.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "do_write_file 覆盖后凭据应被吊销: {err_after_write}"
        );
        let err_after_write_old = do_delete_file_if_unchanged(ch_write_str, "v1").unwrap_err();
        assert!(
            err_after_write_old.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "do_write_file 覆盖后旧内容凭据亦不得有效: {err_after_write_old}"
        );
        assert!(ch_write.exists());

        let ch_atomic = proj.root.join("QM").join("chapters").join("ch-atomic.md");
        let ch_atomic_str = ch_atomic.to_str().unwrap();
        do_write_files_atomic(&[batch_entry(&ch_atomic, "v1")], Some(&[None])).unwrap();
        do_write_file_atomic(ch_atomic_str, "v2").unwrap();
        let err_after_atomic = do_delete_file_if_unchanged(ch_atomic_str, "v2").unwrap_err();
        assert!(
            err_after_atomic.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "do_write_file_atomic 覆盖后凭据应被吊销: {err_after_atomic}"
        );
        assert!(ch_atomic.exists());
    }

    #[test]
    fn plain_delete_file_still_denies_newly_created_qm_chapter() {
        let _serial = crate::agent_gate::gate_test_serial();
        let proj = RollbackGateProject::new("plain-delete");

        let ch = proj.root.join("QM").join("chapters").join("chapter-001.md");
        let ch_str = ch.to_str().unwrap();
        do_write_files_atomic(&[batch_entry(&ch, "fresh body")], Some(&[None])).unwrap();
        assert!(ch.exists());

        // 普通 do_delete_file（无 expected_content）即使文件刚新建也必须硬拒。
        let err = do_delete_file(ch_str).unwrap_err();
        assert!(
            err.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "无 expected 的普通删除即使刚新建也必须硬拒: {err}"
        );
        assert!(ch.exists());
    }

    #[test]
    fn rollback_delete_still_denied_while_gate_is_halted() {
        let _serial = crate::agent_gate::gate_test_serial();
        let proj = RollbackGateProject::new("halted");

        let ch = proj.root.join("QM").join("chapters").join("chapter-001.md");
        let ch_str = ch.to_str().unwrap();
        let body = "fresh body under halt";
        do_write_files_atomic(&[batch_entry(&ch, body)], Some(&[None])).unwrap();
        assert!(ch.exists());

        // 触发循环熔断。
        let loop_target = "output/halt-trigger.bin";
        for _ in 0..(crate::agent_gate::LOOP_THRESHOLD - 1) {
            let out = crate::agent_gate::gate_authorize(
                "deleteFile",
                loop_target,
                crate::agent_gate::GateActor::Agent,
            );
            assert_eq!(out.decision, crate::agent_gate::Decision::RequireConfirm);
            let id = out.request_id.expect("request id");
            let _ = crate::agent_gate::resolve_impl(&id, crate::agent_gate::Decision::Denied, "no");
        }
        let halting = crate::agent_gate::gate_authorize(
            "deleteFile",
            loop_target,
            crate::agent_gate::GateActor::Agent,
        );
        assert_eq!(halting.decision, crate::agent_gate::Decision::Denied);
        assert!(crate::agent_gate::loop_state_impl().halted);

        // 熔断态下即使持有效回滚凭据，仍必须硬拒。
        let err = do_delete_file_if_unchanged(ch_str, body).unwrap_err();
        assert!(
            err.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "熔断态下回滚删除必须仍被硬拒: {err}"
        );
        assert!(ch.exists());

        // 收尾：人工解除熔断，避免污染同进程其他测试。
        let halt_id = crate::agent_gate::loop_state_impl()
            .halt_request_id
            .expect("halt id");
        crate::agent_gate::resolve_impl(
            &halt_id,
            crate::agent_gate::Decision::ResumeAfterHalt,
            "test cleanup",
        )
        .expect("resume halt");
        assert!(!crate::agent_gate::loop_state_impl().halted);
    }

    // ── R-6v2：FS 原子性、poison 恢复、不提前建目录与 Windows 瞬态重试单测 ──

    #[test]
    fn file_mutation_lock_recovers_from_poison() {
        let _ = std::thread::spawn(|| {
            let _guard = FILE_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            panic!("intentional poison for FILE_MUTATION_LOCK");
        })
        .join();

        assert!(FILE_MUTATION_LOCK.is_poisoned());
        let recovered = lock_file_mutations().expect("poisoned FILE_MUTATION_LOCK must recover");
        drop(recovered);

        let dir = make_temp_dir("poison-atomic-write");
        let target = dir.join("user-assets").join("ok.md");
        let target_str = target.to_string_lossy().into_owned();
        do_write_file_atomic(&target_str, "recovered write")
            .expect("poison 恢复后且 user-assets(RequireGate) 下原子写必须成功");
        assert_eq!(fs::read_to_string(&target).unwrap(), "recovered write");
        assert_no_batch_temps(target.parent().unwrap());

        FILE_MUTATION_LOCK.clear_poison();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_file_missing_source_does_not_create_parent_dir() {
        let dir = make_temp_dir("copy-missing-src");
        let missing_src = dir.join("does-not-exist.bin");
        let missing_src_str = missing_src.to_string_lossy().into_owned();

        // exclusive=true：源缺失不得创建目标父目录。
        let exclusive_parent = dir.join("never-created-exclusive");
        let exclusive_dst = exclusive_parent.join("backup.bin");
        let err_ex =
            do_copy_file(&missing_src_str, &exclusive_dst.to_string_lossy(), true).unwrap_err();
        assert!(err_ex.contains("Failed to read copy source"), "{err_ex}");
        assert!(
            !exclusive_parent.exists(),
            "exclusive=true 源缺失时绝不能创建目标父目录"
        );

        // exclusive=false：源缺失同样不得创建目标父目录。
        let overwrite_parent = dir.join("never-created-overwrite");
        let overwrite_dst = overwrite_parent.join("copy.bin");
        let err_ow =
            do_copy_file(&missing_src_str, &overwrite_dst.to_string_lossy(), false).unwrap_err();
        assert!(err_ow.contains("Failed to read copy source"), "{err_ow}");
        assert!(
            !overwrite_parent.exists(),
            "exclusive=false 源缺失时绝不能创建目标父目录"
        );

        // 正常复制（exclusive=true 与 exclusive=false）均经 StagedBytes 发布且无暂存残留。
        let real_src = dir.join("real.bin");
        fs::write(&real_src, b"payload-v1").unwrap();
        let real_src_str = real_src.to_string_lossy().into_owned();
        do_copy_file(&real_src_str, &exclusive_dst.to_string_lossy(), true).unwrap();
        assert_eq!(fs::read(&exclusive_dst).unwrap(), b"payload-v1");
        assert_no_batch_temps(&exclusive_parent);

        fs::write(&real_src, b"payload-v2").unwrap();
        do_copy_file(&real_src_str, &exclusive_dst.to_string_lossy(), false).unwrap();
        assert_eq!(fs::read(&exclusive_dst).unwrap(), b"payload-v2");
        assert_no_batch_temps(&exclusive_parent);

        // exclusive=true 目标为目录时必须报错。
        let dir_dst = dir.join("target-is-dir");
        fs::create_dir_all(&dir_dst).unwrap();
        let err_dir = do_copy_file(&real_src_str, &dir_dst.to_string_lossy(), true).unwrap_err();
        assert!(err_dir.contains("not a regular file"), "{err_dir}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_validation_failure_does_not_create_missing_parent_dirs() {
        let dir = make_temp_dir("batch-readonly-validate");
        let existing = dir.join("existing.md");
        fs::write(&existing, b"actual content").unwrap();

        let missing_dir_a = dir.join("uncreated-a");
        let missing_target_a = missing_dir_a.join("nested").join("ch1.md");
        let files = [
            batch_entry(&missing_target_a, "new chapter"),
            batch_entry(&existing, "updated existing"),
        ];
        let expected = [None, Some("stale expected".to_owned())];
        let err = do_write_files_atomic(&files, Some(&expected)).unwrap_err();
        assert!(err.contains("changed before staging"), "{err}");
        assert!(
            !missing_dir_a.exists(),
            "expected_contents 校验失败前绝不能提前创建缺失父目录"
        );
        assert_eq!(fs::read(&existing).unwrap(), b"actual content");

        // 重复目标校验失败时，同样不得提前创建缺失父目录。
        let missing_dir_dup = dir.join("uncreated-dup");
        let dup_target = missing_dir_dup.join("dup.md");
        let dup_files = [
            batch_entry(&dup_target, "first"),
            batch_entry(&dup_target, "second"),
        ];
        let dup_err = do_write_files_atomic(&dup_files, None).unwrap_err();
        assert!(
            dup_err.contains("Duplicate physical batch target"),
            "{dup_err}"
        );
        assert!(
            !missing_dir_dup.exists(),
            "去重校验失败前绝不能提前创建缺失父目录"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn staged_bytes_commit_retries_windows_sharing_violation_and_skips_synthetic() {
        let dir = make_temp_dir("staged-win-retry");
        let target = dir.join("chapter.md");
        fs::write(&target, b"initial").unwrap();

        // 前 2 次模拟 Windows ERROR_SHARING_VIOLATION (32)，第 3 次成功提交。
        let calls = std::cell::Cell::new(0usize);
        let mut staged = StagedBytes::prepare(&target, b"updated after retry", None).unwrap();
        staged
            .commit(&target, |from, to| {
                let n = calls.get() + 1;
                calls.set(n);
                if n < 3 {
                    Err(std::io::Error::from_raw_os_error(32))
                } else {
                    fs::rename(from, to)
                }
            })
            .expect("Windows 错误码 32 瞬态冲突应重试并最终成功");
        assert_eq!(calls.get(), 3);
        assert_eq!(fs::read(&target).unwrap(), b"updated after retry");
        assert_no_batch_temps(&dir);

        // 连续 4 次均返回 32：最多尝试 4 次后失败并清理暂存文件。
        let fail_calls = std::cell::Cell::new(0usize);
        {
            let mut staged_fail = StagedBytes::prepare(&target, b"never committed", None).unwrap();
            let err = staged_fail
                .commit(&target, |_, _| {
                    fail_calls.set(fail_calls.get() + 1);
                    Err(std::io::Error::from_raw_os_error(32))
                })
                .unwrap_err();
            assert!(err.contains("Failed to move temp file"), "{err}");
        }
        assert_eq!(fail_calls.get(), 4, "Windows 瞬态错误最多尝试 4 次");
        assert_eq!(fs::read(&target).unwrap(), b"updated after retry");
        assert_no_batch_temps(&dir);

        // 无 raw_os_error 的合成错误不重试（保持既有单测 calls.get() 契约）。
        let synth_calls = std::cell::Cell::new(0usize);
        {
            let mut staged_synth = StagedBytes::prepare(&target, b"synth", None).unwrap();
            let err = staged_synth
                .commit(&target, |_, _| {
                    synth_calls.set(synth_calls.get() + 1);
                    Err(std::io::Error::other("synthetic non-os error"))
                })
                .unwrap_err();
            assert!(err.contains("synthetic non-os error"), "{err}");
        }
        assert_eq!(synth_calls.get(), 1, "无 os_error 的合成错误不得重试");
        assert_no_batch_temps(&dir);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_directory_rejects_self_containment_loop() {
        let root = make_temp_dir("copy-dir-loop");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), "hello").unwrap();

        let nested = src.join("sub").join("dest");
        let err = do_copy_directory(&src.to_string_lossy(), &nested.to_string_lossy())
            .expect_err("copying directory into its own subdirectory must fail");
        assert!(err.contains("into itself"), "unexpected error: {err}");

        let same_err = do_copy_directory(&src.to_string_lossy(), &src.to_string_lossy())
            .expect_err("copying directory onto itself must fail");
        assert!(
            same_err.contains("into itself"),
            "unexpected error: {same_err}"
        );

        let sibling = root.join("sibling");
        let copied = do_copy_directory(&src.to_string_lossy(), &sibling.to_string_lossy())
            .expect("sibling copy should succeed");
        assert_eq!(copied.len(), 1);
        assert_eq!(fs::read_to_string(sibling.join("a.txt")).unwrap(), "hello");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_directory_with_depth_one_skips_nested_children() {
        let root = make_temp_dir("list-dir-depth");
        let sub = root.join("sub");
        let deeper = sub.join("deeper");
        fs::create_dir_all(&deeper).unwrap();
        fs::write(root.join("top.md"), "top").unwrap();
        fs::write(sub.join("nested.md"), "nested").unwrap();
        fs::write(deeper.join("leaf.md"), "leaf").unwrap();

        let root_str = root.to_string_lossy().into_owned();
        let shallow = do_list_directory_with_depth(&root_str, Some(1)).unwrap();
        assert_eq!(shallow.len(), 2);
        assert_eq!(shallow[0].name, "sub");
        assert!(shallow[0].is_dir);
        assert!(
            shallow[0].children.is_none(),
            "max_depth=1 must not traverse into nested subdirectories"
        );
        assert_eq!(shallow[1].name, "top.md");
        assert!(!shallow[1].is_dir);
        assert!(shallow[1].children.is_none());

        // max_depth=0 clamps to 1
        let clamped = do_list_directory_with_depth(&root_str, Some(0)).unwrap();
        assert_eq!(clamped.len(), 2);
        assert!(clamped[0].children.is_none());

        // Default (None) still traverses full tree
        let full = do_list_directory(&root_str).unwrap();
        assert_eq!(full.len(), 2);
        let sub_children = full[0]
            .children
            .as_ref()
            .expect("default list_directory must traverse subdirectories");
        assert_eq!(sub_children.len(), 2);
        assert_eq!(sub_children[0].name, "deeper");
        assert_eq!(sub_children[1].name, "nested.md");
        let deeper_children = sub_children[0]
            .children
            .as_ref()
            .expect("default list_directory must traverse deeper subdirectories");
        assert_eq!(deeper_children.len(), 1);
        assert_eq!(deeper_children[0].name, "leaf.md");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_directory_invalidates_rollback_ticket_on_overwritten_target() {
        let _serial = crate::agent_gate::gate_test_serial();
        let proj = RollbackGateProject::new("copy-dir-invalidate");

        let dst_dir = proj.root.join("QM").join("chapters");
        let ch = dst_dir.join("ch-copy.md");
        let ch_str = ch.to_str().unwrap();
        do_write_files_atomic(&[batch_entry(&ch, "v1")], Some(&[None])).unwrap();

        let src_dir = proj.root.join("incoming");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("ch-copy.md"), "v2 from copy").unwrap();

        do_copy_directory(&src_dir.to_string_lossy(), &dst_dir.to_string_lossy()).unwrap();
        assert_eq!(fs::read_to_string(&ch).unwrap(), "v2 from copy");

        let err_v2 = do_delete_file_if_unchanged(ch_str, "v2 from copy").unwrap_err();
        assert!(
            err_v2.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "copy_directory 覆盖后回滚凭据必须被吊销: {err_v2}"
        );
        let err_v1 = do_delete_file_if_unchanged(ch_str, "v1").unwrap_err();
        assert!(
            err_v1.starts_with(crate::agent_gate::GATE_DENIED_PREFIX),
            "copy_directory 覆盖后旧内容凭据亦不得有效: {err_v1}"
        );
        assert!(ch.exists());
    }
}

/// Core logic for `get_executable_dir`, callable from both Tauri commands and Axum handlers.
pub fn do_get_executable_dir() -> Result<String, String> {
    run_guarded("get_executable_dir", || {
        let exe =
            std::env::current_exe().map_err(|e| format!("Failed to get executable path: {}", e))?;
        let dir = exe
            .parent()
            .ok_or_else(|| "Failed to get executable directory".to_string())?;
        Ok(dir.to_string_lossy().into_owned())
    })
}

#[tauri::command]
pub fn get_executable_dir() -> Result<String, String> {
    do_get_executable_dir()
}

/// Core logic for `get_resource_dir`, callable from both Tauri commands and Axum handlers.
pub fn do_get_resource_dir() -> Result<String, String> {
    run_guarded("get_resource_dir", || {
        if let Some(dir) = RESOURCE_DIR_HINT.get() {
            Ok(dir.to_string_lossy().into_owned())
        } else {
            Err("Resource directory not set".to_string())
        }
    })
}

#[tauri::command]
pub fn get_resource_dir() -> Result<String, String> {
    do_get_resource_dir()
}
