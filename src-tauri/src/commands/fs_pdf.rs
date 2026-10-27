// Copyright (c) 2024 Niko-hub contributors. MIT License.
// SPDX-License-Identifier: MIT

//! PDFium 绑定与 PDF 文本提取，从 `fs.rs` verbatim 下沉（S5 拆分，与
//! `fs_archive.rs` / `fs_office.rs` 同惯例）。
//!
//! 本模块只含 PDF 域：全局 Pdfium 实例、串行化锁、动态库候选路径解析、
//! PDF → markdown 文本提取。Tauri 命令入口（`read_file`/`write_file`/…）
//! 与共享存储助手留在 `fs.rs`，经 `pub use` 重导出保持路径兼容。

use std::path::Path;

use super::fs::KNOWLEDGE_DIR;

/// Global PDFium instance — the library prefers a single binding shared
/// across threads over repeatedly binding/unbinding.
static PDFIUM: std::sync::OnceLock<Result<pdfium_render::prelude::Pdfium, String>> =
    std::sync::OnceLock::new();

/// Serializes every PDFium call. PDFium's C library is documented as
/// safe across threads only when no PDFium object is touched from
/// two threads simultaneously — interleaved calls are UB and have
/// caused EXC_BAD_ACCESS segfaults on macOS ARM64 in production.
///
/// This mutex matters because our heavy fs commands are now `async
/// fn`, so Tauri schedules them on the tokio multi-threaded runtime
/// instead of running them on a single thread. Without this lock,
/// two concurrent `read_file`/`extract_*_pdf` calls can land on
/// different worker threads and interleave inside pdfium → crash.
///
/// We use `std::sync::Mutex` (not `tokio::sync::Mutex`) because the
/// lock is acquired *inside* `spawn_blocking`, never held across
/// `.await` — async-aware mutexes would just add overhead for no
/// benefit here.
static PDFIUM_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire the PDFium serialization lock. Auto-recovers from poison
/// (a previous panic on a malformed PDF leaves the mutex poisoned,
/// but pdfium has no shared state for that panic to have corrupted —
/// the next caller can safely take the lock and proceed).
pub(crate) fn lock_pdfium() -> std::sync::MutexGuard<'static, ()> {
    PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Additional resource directory hint, set by the Tauri setup() callback
/// once the AppHandle is available. Lets the pdfium resolver find the
/// bundled dylib without re-implementing Tauri's platform-specific
/// resource-dir logic.
pub(crate) static RESOURCE_DIR_HINT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Called from Tauri's setup() with the resolved resource directory.
/// No-op if already set.
pub fn set_resource_dir_hint(dir: std::path::PathBuf) {
    crate::agent_gate::set_gate_project_root(dir.clone());
    let _ = RESOURCE_DIR_HINT.set(dir);
}

/// Enumerate plausible locations for the PDFium dynamic library on the
/// current platform. Order from most specific to least:
///   1. `$PDFIUM_DYNAMIC_LIB_PATH` env var (local dev convenience)
///   2. Tauri resource dir (set via setup()) — the authoritative location
///   3. Paths relative to the executable where Tauri's bundler lands
///      resources on each platform (macOS Frameworks / Resources /
///      MacOS dir, Windows sibling, Linux sibling)
/// 测试/诊断用：候选路径里是否存在任一 pdfium 动态库（只做文件存在性探测，不 dlopen）。
/// CI 的 mac/ubuntu 作业会把 pdfium 解压到 `src-tauri/pdfium/libpdfium.dylib|so`，
/// 因此该探测与 CI 解包布局对齐后即可让渲染类测试在三平台真实运行。
/// ISS-20260731-002 处置：误报保留——生产零调用，但为 pdf_export 渲染测试的唯一可用性探针
/// （`pdf_export.rs` tests 经 `pdfium_available()` 调用；生产渲染走同源 `pdfium_candidate_paths`）。
/// 新增 allow 零容忍：本条为既有抑制，附因保留，不新增。
#[allow(dead_code)]
pub fn pdfium_dynamic_library_present() -> bool {
    !pdfium_candidate_paths().is_empty()
}

/// Enumerate plausible locations for the PDFium dynamic library on the
/// current platform. Order from most specific to least:
///   1. `$PDFIUM_DYNAMIC_LIB_PATH` env var (local dev convenience)
///   2. Tauri resource dir (set via setup()) — the authoritative location
///   3. Paths relative to the executable where Tauri's bundler lands
///      resources on each platform (macOS Frameworks / Resources /
///      MacOS dir, Windows sibling, Linux sibling)
///   4. OS dynamic loader search path (last resort)
pub(crate) fn pdfium_candidate_paths() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();

    // 源码树内的自带副本（开发 / 测试 / 便携布局）：发布包里若不存在会被自然跳过。
    // dylib/so 两个名字与 CI「Install PDFium binary」步骤的解包目标一致
    // （ci.yml: cp … "src-tauri/pdfium/${{ matrix.pdfium_library }}"）。
    const VENDORED: [&str; 4] = [
        "pdfium/pdfium.dll",
        "pdfium/libpdfium.dll",
        "pdfium/libpdfium.dylib",
        "pdfium/libpdfium.so",
    ];
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for rel in VENDORED {
        let candidate = manifest_dir.join(rel);
        if candidate.is_file() {
            v.push(candidate.to_string_lossy().into_owned());
        }
    }

    if let Ok(p) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        v.push(p);
    }

    // Tauri-resolved resource directory (set during setup()).
    //
    // Tauri's `bundle.resources` array form preserves relative paths,
    // so `"pdfium/pdfium.dll"` in tauri.<target>.conf.json lands at
    // `<resource_dir>/pdfium/pdfium.dll` — NOT at the root. Older
    // versions of this function only probed the root, which made
    // Windows installs fail with "Failed to locate Pdfium library"
    // (OS error 126) even though the DLL was in the installer.
    // We now probe both the `pdfium/` subdir (where the current
    // bundle config actually puts it) and the root (in case a future
    // config change flattens it).
    if let Some(resource_dir) = RESOURCE_DIR_HINT.get() {
        let push = |v: &mut Vec<String>, p: std::path::PathBuf| {
            v.push(p.to_string_lossy().into_owned());
        };
        #[cfg(target_os = "macos")]
        {
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.dylib"));
            push(&mut v, resource_dir.join("libpdfium.dylib"));
        }
        #[cfg(target_os = "windows")]
        {
            push(&mut v, resource_dir.join("pdfium").join("pdfium.dll"));
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.dll"));
            push(&mut v, resource_dir.join("pdfium.dll"));
            push(&mut v, resource_dir.join("libpdfium.dll"));
        }
        #[cfg(target_os = "linux")]
        {
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.so"));
            push(&mut v, resource_dir.join("libpdfium.so"));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let push = |v: &mut Vec<String>, p: std::path::PathBuf| {
                v.push(p.to_string_lossy().into_owned());
            };

            #[cfg(target_os = "macos")]
            {
                // Tauri .app bundle layout:
                //   Contents/MacOS/<binary>
                //   Contents/Frameworks/libpdfium.dylib   ← preferred (macOS config uses bundle.macOS.frameworks)
                //   Contents/Resources/libpdfium.dylib    ← fallback
                //   Contents/Resources/pdfium/libpdfium.dylib  ← if array-form resources ever used on macOS
                push(&mut v, exe_dir.join("../Frameworks/libpdfium.dylib"));
                push(&mut v, exe_dir.join("../Resources/pdfium/libpdfium.dylib"));
                push(&mut v, exe_dir.join("../Resources/libpdfium.dylib"));
                push(&mut v, exe_dir.join("libpdfium.dylib"));
            }

            #[cfg(target_os = "windows")]
            {
                // bblanchon/pdfium-binaries ships the Windows DLL as
                // `pdfium.dll` (no `lib` prefix). Probe flat and
                // `pdfium/` subdir forms at both exe root and the
                // classic Tauri `resources/` sibling — covers every
                // layout variant we've observed across NSIS / MSI /
                // portable builds.
                push(&mut v, exe_dir.join("pdfium.dll"));
                push(&mut v, exe_dir.join("pdfium").join("pdfium.dll"));
                push(&mut v, exe_dir.join("libpdfium.dll"));
                push(&mut v, exe_dir.join("resources").join("pdfium.dll"));
                push(
                    &mut v,
                    exe_dir.join("resources").join("pdfium").join("pdfium.dll"),
                );
            }

            #[cfg(target_os = "linux")]
            {
                push(&mut v, exe_dir.join("libpdfium.so"));
                push(&mut v, exe_dir.join("pdfium").join("libpdfium.so"));
                push(&mut v, exe_dir.join("resources").join("libpdfium.so"));
                push(
                    &mut v,
                    exe_dir
                        .join("resources")
                        .join("pdfium")
                        .join("libpdfium.so"),
                );
                push(&mut v, exe_dir.join("../lib/libpdfium.so"));
            }
        }
    }

    v
}

pub(crate) fn pdfium() -> Result<&'static pdfium_render::prelude::Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            use pdfium_render::prelude::*;
            let candidates = pdfium_candidate_paths();
            for path in &candidates {
                if let Ok(bindings) = Pdfium::bind_to_library(path) {
                    log::info!("[pdfium] loaded dynamic library from {path}");
                    return Ok(Pdfium::new(bindings));
                }
            }
            // Last resort: let the OS dynamic loader find it.
            Pdfium::bind_to_system_library()
                .map(Pdfium::new)
                .map_err(|e| {
                    format!(
                        "Failed to locate Pdfium library. Tried: {} — and the system search path. Last error: {e}",
                        if candidates.is_empty() {
                            "(no candidates)".to_string()
                        } else {
                            candidates.join(", ")
                        }
                    )
                })
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Extract a PDF as markdown — text + per-page image references
/// when the file lives under a project's `raw/sources/` (the
/// layout the import pipeline produces). Falls back to text-only
/// when the PDF is opened from anywhere else.
///
/// Layout heuristic: a PDF at `<project>/raw/sources/<name>.pdf`
/// implies project root = `<project>` and image dest =
/// `<project>/QM/media/<name>/`. We use absolute filesystem paths
/// in the emitted `![](url)` references so the markdown previews
/// (raw-source view AND wiki-summary view) both render via
/// `convertFileSrc` without anyone having to know which directory
/// they're rendering from.
///
/// Lock: delegates to `extract_pdf_markdown`, which acquires the
/// pdfium lock internally. We must NOT take it here too —
/// `std::sync::Mutex` is non-reentrant.
pub(crate) fn extract_pdf_text(path: &str) -> Result<String, String> {
    use crate::commands::extract_images::{extract_pdf_markdown, ExtractOptions};

    let p = Path::new(path);
    let parent = p.parent();
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // The path-component check uses `ends_with` on `Path` which
    // matches the LAST component (not a string-suffix check), so
    // `/foo/raw/sources/bar.pdf` correctly identifies as under
    // `raw/sources/` while `/foo/braw/source-thing/bar.pdf` does
    // not.
    let parent_is_sources = parent.map(|d| d.ends_with("sources")).unwrap_or(false);
    let raw_dir = parent.and_then(|d| d.parent());
    let raw_is_raw = raw_dir.map(|d| d.ends_with("raw")).unwrap_or(false);
    let project_root = if parent_is_sources && raw_is_raw {
        raw_dir.and_then(|d| d.parent())
    } else {
        None
    };

    if let Some(root) = project_root {
        if !stem.is_empty() {
            let media_dir = root.join(KNOWLEDGE_DIR).join("media").join(&stem);
            // Forward-slash absolute path so we don't ship `\` into
            // markdown that the JS-side resolver would then have to
            // re-normalize. The resolver does handle backslashes,
            // but emitting clean URLs in the first place avoids
            // surprises in cache files we save to disk.
            let url_prefix = media_dir.to_string_lossy().replace('\\', "/");
            return extract_pdf_markdown(
                path,
                Some(&media_dir),
                &url_prefix,
                &ExtractOptions::default(),
            );
        }
    }

    // PDFs not under <project>/raw/sources/ — text-only fallback.
    // Skip the image side of the extraction entirely (no media
    // destination → extract_pdf_markdown only writes text + page
    // headers, no pdfium image-object enumeration).
    extract_pdf_markdown(path, None, "", &ExtractOptions::default())
}
