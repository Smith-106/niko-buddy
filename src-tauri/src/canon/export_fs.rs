// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! canon 导出底层文件原语层——M4-1 自 `export.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：zip 布局/项目相对路径常量（[`STATUS_PREFIX`] 等三前缀 + [`STATUS_REL`]
//! 等三相对路径）、小工具（[`hex`] / [`now_stamp`] / [`unique_suffix`] /
//! [`sanitize_reason`] / [`to_zip_path`] / [`normalize_pass`] / [`err_ctx`]）、
//! 组件枚举（[`ComponentRoots`] / [`enumerate_dir`] / [`enumerate_entries`]）、
//! 流式哈希（[`copy_and_hash`] / [`hash_file`] /
//! [`compute_content_digest_from_disk`] / [`stream_file_sha256`]）、zip 选项/路径
//! （[`base_opts`] / [`sidecar_path`]）与解包读原语/路径安全
//! （[`read_entry_bytes`] / [`map_zip_read_err`] / [`staged_roots`] /
//! [`safe_staging_target`]）——全部确定性文件/zip 纯逻辑，零 Tauri。
//! `export.rs` 经 `pub(crate) use` 回引，外部 import 面零变化
//! （外部引用留守原文件：4 个 Tauri 命令、`Canon*` IPC 类型、`FORMAT_VERSION` /
//! `MANIFEST_KIND`、`write_checksum_sidecar` / `parse_sidecar_checksum`、
//! `pack_project` / `stage_verified_archive` / `swap_directory` 与业务入口）。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// ──────────────────────────────────────────────────────────────────────────
// 路径常量（随本层一起剥离；`export.rs` 回引后继续使用）
// ──────────────────────────────────────────────────────────────────────────

/// status.json 在 zip 内的前缀。
pub(crate) const STATUS_PREFIX: &str = "status/";
/// 草稿目录在 zip 内的前缀（映射 `{project}/.novel/drafts`）。
pub(crate) const DRAFTS_PREFIX: &str = "drafts/";
/// Canon LanceDB 快照在 zip 内的前缀（映射 `{project}/.niko-buddy/lancedb`）。
pub(crate) const LANCEDB_PREFIX: &str = "canon-lancedb/";

/// 会话状态唯一真源（HARD-1）：`.novel/status.json`。
pub(crate) const STATUS_REL: &str = ".novel/status.json";
/// 草稿工件目录。
pub(crate) const DRAFTS_REL: &str = ".novel/drafts";
/// Canon LanceDB 库目录（与 `canon::store::db_path` 同源）。
pub(crate) const LANCEDB_REL: &str = ".niko-buddy/lancedb";

// ──────────────────────────────────────────────────────────────────────────
// 小工具
// ──────────────────────────────────────────────────────────────────────────

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 本地时间戳（文件名安全）：`YYYYMMDD-HHMMSS`。
pub(crate) fn now_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 高精度唯一后缀，避免同一秒内多个操作的命名碰撞。
pub(crate) fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{}-{}", now_stamp(), nanos)
}

/// 归一化 reason 为文件名安全段：非 [a-zA-Z0-9_-] 一律替换为 '-'。
pub(crate) fn sanitize_reason(reason: &str) -> String {
    let cleaned: String = reason
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "unspecified".into()
    } else {
        trimmed
    }
}

/// 规范化为 zip 内正斜杠路径。
pub(crate) fn to_zip_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub(crate) fn normalize_pass(passphrase: &Option<String>) -> Option<String> {
    match passphrase {
        Some(p) if !p.trim().is_empty() => Some(p.clone()),
        _ => None,
    }
}

pub(crate) fn err_ctx(prefix: &str, e: impl std::fmt::Display) -> String {
    format!("{prefix}: {e}")
}

// ──────────────────────────────────────────────────────────────────────────
// 组件枚举（pack 与 verify 共用同一套顺序，保证 content digest 逐字节一致）
// ──────────────────────────────────────────────────────────────────────────

/// 三组件在磁盘上的根（None = 该组件不存在）。
pub(crate) struct ComponentRoots {
    pub(crate) status: Option<PathBuf>,
    pub(crate) drafts: Option<PathBuf>,
    pub(crate) lancedb: Option<PathBuf>,
}

impl ComponentRoots {
    pub(crate) fn from_project(project: &Path) -> Self {
        let status = project.join(STATUS_REL);
        let drafts = project.join(DRAFTS_REL);
        let lancedb = project.join(LANCEDB_REL);
        ComponentRoots {
            status: status.is_file().then_some(status),
            drafts: drafts.is_dir().then_some(drafts),
            lancedb: lancedb.is_dir().then_some(lancedb),
        }
    }
}

/// 枚举一个组件目录下的全部文件 → (zip 内路径, 磁盘路径)，按 zip 路径排序。
pub(crate) fn enumerate_dir(root: &Path, zip_prefix: &str) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let name = format!("{zip_prefix}{}", to_zip_path(&rel));
        out.push((name, entry.path().to_path_buf()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// 全部数据条目（status → drafts → lancedb 组内有序）。
pub(crate) fn enumerate_entries(roots: &ComponentRoots) -> Vec<(String, PathBuf)> {
    let mut all = Vec::new();
    if let Some(s) = &roots.status {
        all.push((format!("{STATUS_PREFIX}status.json"), s.clone()));
    }
    if let Some(d) = &roots.drafts {
        all.extend(enumerate_dir(d, DRAFTS_PREFIX));
    }
    if let Some(l) = &roots.lancedb {
        all.extend(enumerate_dir(l, LANCEDB_PREFIX));
    }
    all
}

/// 流式读取文件：同时喂给 zip writer 和 per-file hasher，返回 (len, hex)。
///
/// 单遍完成「写入 + 摘要」，大文件不驻留内存。
pub(crate) fn copy_and_hash(
    file: &mut fs::File,
    sink: &mut ZipWriter<fs::File>,
) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut len: u64 = 0;
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| err_ctx("读取源文件失败", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        sink.write_all(&buf[..n])
            .map_err(|e| err_ctx("写入 zip 失败", e))?;
        len += n as u64;
    }
    Ok((len, hex(&hasher.finalize())))
}

/// 流式计算单文件 SHA-256（不驻留整文件内存），返回 (len, hex)。
pub(crate) fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let mut f = fs::File::open(path)
        .map_err(|e| err_ctx(format!("打开 {} 失败", path.display()).as_str(), e))?;
    let mut hasher = Sha256::new();
    let mut len: u64 = 0;
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| err_ctx("读取文件失败", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok((len, hex(&hasher.finalize())))
}

/// 从磁盘条目集计算内容层摘要（verify 用；记录格式必须与 pack 侧完全一致）。
pub(crate) fn compute_content_digest_from_disk(
    entries: &[(String, PathBuf)],
) -> Result<String, String> {
    let mut digest = Sha256::new();
    for (name, path) in entries {
        let (len, file_hex) = hash_file(path)?;
        digest.update(name.as_bytes());
        digest.update(b"\0");
        digest.update(&len.to_le_bytes());
        digest.update(b"\0");
        digest.update(file_hex.as_bytes());
        digest.update(b"\n");
    }
    Ok(hex(&digest.finalize()))
}

// ──────────────────────────────────────────────────────────────────────────
// zip 选项 / 容器哈希 / sidecar 路径
// ──────────────────────────────────────────────────────────────────────────

pub(crate) fn base_opts() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
}

pub(crate) fn stream_file_sha256(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| err_ctx("打开文件计算 SHA-256 失败", e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| err_ctx("读取文件计算 SHA-256 失败", e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

pub(crate) fn sidecar_path(zip_path: &Path) -> PathBuf {
    let mut s = zip_path.as_os_str().to_os_string();
    s.push(".sha256");
    PathBuf::from(s)
}

// ──────────────────────────────────────────────────────────────────────────
// 解包读原语 / staging 路径安全
// ──────────────────────────────────────────────────────────────────────────

/// 解密感知地读取 zip 内指定条目为字节（AES 口令可选）。
pub(crate) fn read_entry_bytes(
    archive: &mut ZipArchive<fs::File>,
    index: usize,
    pass: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut zf = match pass {
        Some(p) => archive
            .by_index_decrypt(index, p.as_bytes())
            .map_err(map_zip_read_err)?,
        None => archive.by_index(index).map_err(map_zip_read_err)?,
    };
    let mut buf = Vec::new();
    zf.read_to_end(&mut buf)
        .map_err(|e| format!("解压读取失败: {e}"))?;
    Ok(buf)
}

pub(crate) fn map_zip_read_err(e: ZipError) -> String {
    match &e {
        ZipError::InvalidPassword => "密码错误或文件损坏".to_string(),
        other => format!("读取 zip 失败: {other}"),
    }
}

/// staging 内三组件根（从解压产物构造）。
pub(crate) fn staged_roots(staging: &Path) -> ComponentRoots {
    let status = staging.join("status").join("status.json");
    let drafts = staging.join("drafts");
    let lancedb = staging.join("canon-lancedb");
    ComponentRoots {
        status: status.is_file().then_some(status),
        drafts: drafts.is_dir().then_some(drafts),
        lancedb: lancedb.is_dir().then_some(lancedb),
    }
}

/// Zip-Slip 防护的安全目标路径拼接（逐 component 走，拒绝逃逸）。
/// 返回 None 表示该条目应跳过（不属于任何已知组件前缀）。
pub(crate) fn safe_staging_target(
    staging_canonical: &Path,
    entry_name: &str,
) -> Result<Option<PathBuf>, String> {
    let (prefix, component) = if entry_name.starts_with(STATUS_PREFIX) {
        (STATUS_PREFIX, "status")
    } else if entry_name.starts_with(DRAFTS_PREFIX) {
        (DRAFTS_PREFIX, "drafts")
    } else if entry_name.starts_with(LANCEDB_PREFIX) {
        (LANCEDB_PREFIX, "canon-lancedb")
    } else {
        return Ok(None);
    };

    let relative = entry_name[prefix.len()..].trim_start_matches('/');
    if relative.is_empty() {
        return Ok(None);
    }

    let mut dest = staging_canonical.join(component);
    for comp in Path::new(relative).components() {
        match comp {
            std::path::Component::ParentDir => {
                dest.pop();
                if !dest.starts_with(staging_canonical) {
                    return Err(format!(
                        "安全拦截：zip 条目 \"{entry_name}\" 试图写入目标目录之外的位置"
                    ));
                }
            }
            std::path::Component::CurDir => {}
            other => dest.push(other),
        }
    }
    if !dest.starts_with(staging_canonical) {
        return Err(format!(
            "安全拦截：zip 条目 \"{entry_name}\" 试图写入目标目录之外的位置 {}",
            dest.display()
        ));
    }
    Ok(Some(dest))
}
