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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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
/// 知识库/正文目录在 zip 内的前缀（优先 `{project}/QM`，仅 QM 不存在时回退 `{project}/wiki`）。
pub(crate) const WIKI_PREFIX: &str = "wiki/";
/// 时光机快照目录在 zip 内的前缀（映射 `{project}/.novel/snapshots`）。
pub(crate) const SNAPSHOTS_PREFIX: &str = "snapshots/";
/// 章节草稿箱目录在 zip 内的前缀（映射 `{project}/.qm-drafts`）。
pub(crate) const QM_DRAFTS_PREFIX: &str = "qm-drafts/";
/// 顶层白名单书魂文档在 zip 内的前缀（仅允许 `soul.md` / `schema.md` / `purpose.md`）。
pub(crate) const ROOT_DOCS_PREFIX: &str = "root-docs/";

/// 会话状态唯一真源（HARD-1）：`.novel/status.json`。
pub(crate) const STATUS_REL: &str = ".novel/status.json";
/// 草稿工件目录。
pub(crate) const DRAFTS_REL: &str = ".novel/drafts";
/// Canon LanceDB 库目录（与 `canon::store::db_path` 同源）。
pub(crate) const LANCEDB_REL: &str = ".niko-buddy/lancedb";
/// 主知识库/正文真源目录（BLOCKING-1：`QM/` 优先于 `wiki/`）。
pub(crate) const QM_REL: &str = "QM";
/// 历史兼容知识库目录（仅 `QM/` 不存在时回退）。
pub(crate) const LEGACY_WIKI_REL: &str = "wiki";
/// 时光机快照目录。
pub(crate) const SNAPSHOTS_REL: &str = ".novel/snapshots";
/// 章节草稿箱目录。
pub(crate) const QM_DRAFTS_REL: &str = ".qm-drafts";
/// 顶层书魂文档白名单（固定 3 文件，导出与恢复严格白名单校验）。
pub(crate) const ROOT_DOC_WHITELIST: [&str; 3] = ["soul.md", "schema.md", "purpose.md"];

/// 单项目备份取消哨兵错误信息（跨 Track 2C/2E 契约）。
pub(crate) const BACKUP_CANCELLED_ERR: &str = "备份已取消";

// ──────────────────────────────────────────────────────────────────────────
// M2-04：zip 解压安全上限（防 zip 炸弹 / 伪造头尺寸 / 超多条目耗尽内存）
// ──────────────────────────────────────────────────────────────────────────

/// manifest.json 条目最大解压字节数（1 MiB）。
pub(crate) const MAX_MANIFEST_ENTRY_BYTES: u64 = 1024 * 1024;
/// 单个数据条目最大解压字节数（256 MiB）。
pub(crate) const MAX_ENTRY_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
/// 单次恢复/校验累计最大解压字节数（1 GiB）。
pub(crate) const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
/// 单个备份 zip 允许的最大条目总数。
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 65_536;

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

/// 高精度唯一后缀（时间戳 + 纳秒 + 进程内单调序列），消除 Windows 低时钟分辨率并发碰撞。
pub(crate) fn unique_suffix() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", now_stamp(), nanos, seq)
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

/// 判定路径是否为符号链接或 Windows 名称代理重解析点（统一委托 `agent_gate_policy`）。
pub(crate) fn is_symlink_or_reparse_point(path: &Path) -> bool {
    crate::agent_gate_policy::is_symlink_or_reparse_point(path)
}

/// 校验 `root` 及 `root -> target` 链路中全部已存在祖先与目标本体均不含符号链接或 Windows 重解析点。
pub(crate) fn assert_no_symlink_in_ancestors(root: &Path, target: &Path) -> Result<(), String> {
    crate::agent_gate_policy::assert_no_symlink_in_ancestors(root, target)
}

fn is_real_file(path: &Path) -> bool {
    path.is_file() && !is_symlink_or_reparse_point(path)
}

fn is_real_dir(path: &Path) -> bool {
    path.is_dir() && !is_symlink_or_reparse_point(path)
}

/// 7 个全量书稿备份组件在磁盘上的根（None/空 = 该组件不存在）。
pub(crate) struct ComponentRoots {
    pub(crate) status: Option<PathBuf>,
    pub(crate) drafts: Option<PathBuf>,
    pub(crate) lancedb: Option<PathBuf>,
    pub(crate) wiki: Option<PathBuf>,
    pub(crate) snapshots: Option<PathBuf>,
    pub(crate) qm_drafts: Option<PathBuf>,
    /// 已按文件名排序的顶层白名单书魂文档 `(filename, disk_path)`。
    pub(crate) root_docs: Vec<(String, PathBuf)>,
}

impl ComponentRoots {
    pub(crate) fn from_project(project: &Path) -> Self {
        // BLOCKING-R2-02：项目根本身为符号链接/重解析点时一律不采纳任何组件。
        if is_symlink_or_reparse_point(project) {
            return ComponentRoots {
                status: None,
                drafts: None,
                lancedb: None,
                wiki: None,
                snapshots: None,
                qm_drafts: None,
                root_docs: Vec::new(),
            };
        }

        // BLOCKING-R2-02：多级子路径先确认中间父目录（`.novel` / `.niko-buddy`）非符号链接/重解析点。
        let novel_safe = !is_symlink_or_reparse_point(&project.join(".novel"));
        let niko_safe = !is_symlink_or_reparse_point(&project.join(".niko-buddy"));

        let status = project.join(STATUS_REL);
        let drafts = project.join(DRAFTS_REL);
        let lancedb = project.join(LANCEDB_REL);
        // BLOCKING-1 铁律：QM/ 优先于 wiki/；仅当 QM/ 不存在（且非悬空符号链接）且 wiki/ 存在时回退 wiki/。
        let qm = project.join(QM_REL);
        let legacy_wiki = project.join(LEGACY_WIKI_REL);
        let wiki = if is_real_dir(&qm) {
            Some(qm)
        } else if !qm.exists() && !is_symlink_or_reparse_point(&qm) && is_real_dir(&legacy_wiki) {
            Some(legacy_wiki)
        } else {
            None
        };
        let snapshots = project.join(SNAPSHOTS_REL);
        let qm_drafts = project.join(QM_DRAFTS_REL);
        let mut root_docs: Vec<(String, PathBuf)> = ROOT_DOC_WHITELIST
            .iter()
            .filter_map(|name| {
                let p = project.join(name);
                is_real_file(&p).then(|| ((*name).to_string(), p))
            })
            .collect();
        root_docs.sort_by(|a, b| a.0.cmp(&b.0));

        ComponentRoots {
            status: (novel_safe && is_real_file(&status)).then_some(status),
            drafts: (novel_safe && is_real_dir(&drafts)).then_some(drafts),
            lancedb: (niko_safe && is_real_dir(&lancedb)).then_some(lancedb),
            wiki,
            snapshots: (novel_safe && is_real_dir(&snapshots)).then_some(snapshots),
            qm_drafts: is_real_dir(&qm_drafts).then_some(qm_drafts),
            root_docs,
        }
    }

    /// 任一组件存在即返回 true（供 `has_current_state` 与 `auto_backup` 统一判定）。
    pub(crate) fn has_any(&self) -> bool {
        self.status.is_some()
            || self.drafts.is_some()
            || self.lancedb.is_some()
            || self.wiki.is_some()
            || self.snapshots.is_some()
            || self.qm_drafts.is_some()
            || !self.root_docs.is_empty()
    }
}

fn should_descend_or_include(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return !is_symlink_or_reparse_point(entry.path());
    }
    if entry.file_type().is_symlink() || is_symlink_or_reparse_point(entry.path()) {
        return false;
    }
    let lower = entry.file_name().to_string_lossy().to_ascii_lowercase();
    !(lower == "backups" || lower.starts_with(".t34c-"))
}

/// 枚举一个组件目录下的全部普通文件 → (zip 内路径, 磁盘路径)，按 zip 路径排序。
/// 不跟随符号链接/Windows 重解析点，并硬排除子级 `backups` 与 `.t34c-*`。
pub(crate) fn enumerate_dir(root: &Path, zip_prefix: &str) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_descend_or_include)
        .filter_map(|e| e.ok())
    {
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        if is_symlink_or_reparse_point(entry.path()) {
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

/// 全部数据条目（status → drafts → lancedb → wiki → snapshots → qm-drafts → root-docs 组内有序）。
/// 兼容 v1：当后 4 个组件皆空时，条目序列与 v1 逐字节一致。
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
    if let Some(w) = &roots.wiki {
        all.extend(enumerate_dir(w, WIKI_PREFIX));
    }
    if let Some(sn) = &roots.snapshots {
        all.extend(enumerate_dir(sn, SNAPSHOTS_PREFIX));
    }
    if let Some(qd) = &roots.qm_drafts {
        all.extend(enumerate_dir(qd, QM_DRAFTS_PREFIX));
    }
    for (name, path) in &roots.root_docs {
        all.push((format!("{ROOT_DOCS_PREFIX}{name}"), path.clone()));
    }
    all
}

/// 流式读取文件：同时喂给 zip writer 和 per-file hasher，返回 (len, hex)。
///
/// 单遍完成「写入 + 摘要」，每 64 KiB 轮询一次取消标志，大文件不驻留内存。
pub(crate) fn copy_and_hash(
    file: &mut fs::File,
    sink: &mut ZipWriter<fs::File>,
    cancel: Option<&AtomicBool>,
) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut len: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err(BACKUP_CANCELLED_ERR.to_string());
        }
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
        digest.update(len.to_le_bytes());
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

/// 解密感知地读取 zip 内指定条目为字节（AES 口令可选），带单条目与累计解压体积上限（防 zip 炸弹）。
pub(crate) fn read_entry_bytes(
    archive: &mut ZipArchive<fs::File>,
    index: usize,
    pass: Option<&str>,
    max_entry_bytes: u64,
    total_read: &mut u64,
    max_total_bytes: u64,
) -> Result<Vec<u8>, String> {
    let zf = match pass {
        Some(p) => archive
            .by_index_decrypt(index, p.as_bytes())
            .map_err(map_zip_read_err)?,
        None => archive.by_index(index).map_err(map_zip_read_err)?,
    };

    // 快拒：先校验 header 声明的未压缩字节数
    let declared_size = zf.size();
    if declared_size > max_entry_bytes {
        return Err(format!(
            "安全拦截：zip 条目声明解压体积 {declared_size} 字节超过单条目上限 {max_entry_bytes} 字节"
        ));
    }
    let remaining_total = max_total_bytes.saturating_sub(*total_read);
    if declared_size > remaining_total {
        return Err(format!(
            "安全拦截：zip 累计解压体积将超过总上限 {max_total_bytes} 字节"
        ));
    }

    // 流式封顶：take(limit + 1) 防伪造 header size 的 zip 炸弹撑爆内存
    let effective_limit = max_entry_bytes.min(remaining_total);
    let read_cap = effective_limit.saturating_add(1);
    let mut buf = Vec::new();
    zf.take(read_cap)
        .read_to_end(&mut buf)
        .map_err(|e| format!("解压读取失败: {e}"))?;

    let actual_len = buf.len() as u64;
    if actual_len > max_entry_bytes {
        return Err(format!(
            "安全拦截：zip 条目实际解压体积超过单条目上限 {max_entry_bytes} 字节"
        ));
    }
    if actual_len > remaining_total {
        return Err(format!(
            "安全拦截：zip 累计实际解压体积超过总上限 {max_total_bytes} 字节"
        ));
    }

    *total_read = total_read.saturating_add(actual_len);
    Ok(buf)
}

pub(crate) fn map_zip_read_err(e: ZipError) -> String {
    match &e {
        ZipError::InvalidPassword => "密码错误或文件损坏".to_string(),
        other => format!("读取 zip 失败: {other}"),
    }
}

/// staging 内全部 7 组件根（从解压产物构造）。
pub(crate) fn staged_roots(staging: &Path) -> ComponentRoots {
    let status = staging.join("status").join("status.json");
    let drafts = staging.join("drafts");
    let lancedb = staging.join("canon-lancedb");
    let wiki = staging.join("wiki");
    let snapshots = staging.join("snapshots");
    let qm_drafts = staging.join("qm-drafts");
    let root_docs_dir = staging.join("root-docs");
    let mut root_docs: Vec<(String, PathBuf)> = ROOT_DOC_WHITELIST
        .iter()
        .filter_map(|name| {
            let p = root_docs_dir.join(name);
            is_real_file(&p).then(|| ((*name).to_string(), p))
        })
        .collect();
    root_docs.sort_by(|a, b| a.0.cmp(&b.0));

    ComponentRoots {
        status: is_real_file(&status).then_some(status),
        drafts: is_real_dir(&drafts).then_some(drafts),
        lancedb: is_real_dir(&lancedb).then_some(lancedb),
        wiki: is_real_dir(&wiki).then_some(wiki),
        snapshots: is_real_dir(&snapshots).then_some(snapshots),
        qm_drafts: is_real_dir(&qm_drafts).then_some(qm_drafts),
        root_docs,
    }
}

/// Zip-Slip 防护的安全目标路径拼接（限定在单组件根目录内，逐 Component 拒绝逃逸与非法字符）。
/// 覆盖全部 7 组件前缀；`root-docs/` 严格仅允许白名单 3 文件（soul.md/schema.md/purpose.md）。
/// 返回 None 表示该条目应跳过（不属于任何已知组件前缀或为空目录条目）。
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
    } else if entry_name.starts_with(WIKI_PREFIX) {
        (WIKI_PREFIX, "wiki")
    } else if entry_name.starts_with(SNAPSHOTS_PREFIX) {
        (SNAPSHOTS_PREFIX, "snapshots")
    } else if entry_name.starts_with(QM_DRAFTS_PREFIX) {
        (QM_DRAFTS_PREFIX, "qm-drafts")
    } else if entry_name.starts_with(ROOT_DOCS_PREFIX) {
        (ROOT_DOCS_PREFIX, "root-docs")
    } else {
        return Ok(None);
    };

    let relative = &entry_name[prefix.len()..];
    if relative.is_empty() {
        return Ok(None);
    }

    // 拒绝反斜杠、控制字符（含 NUL/换行）与 Windows ADS 冒号 `:`
    if relative
        .chars()
        .any(|c| c == '\\' || c == ':' || c.is_control())
    {
        return Err(format!(
            "安全拦截：zip 条目 \"{entry_name}\" 含非法路径字符（反斜杠/控制字符/冒号）"
        ));
    }

    let component_root = staging_canonical.join(component);
    let mut dest = component_root.clone();
    for comp in Path::new(relative).components() {
        match comp {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "安全拦截：zip 条目 \"{entry_name}\" 试图越出组件目录 \"{component}\""
                ));
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(seg) => {
                let seg_str = seg.to_string_lossy();
                if seg_str.contains('\\') || seg_str.contains(':') {
                    return Err(format!("安全拦截：zip 条目 \"{entry_name}\" 含非法路径段"));
                }
                dest.push(seg);
            }
        }
    }

    if !dest.starts_with(&component_root) || dest == component_root {
        return Err(format!(
            "安全拦截：zip 条目 \"{entry_name}\" 试图写入组件目录之外的位置 {}",
            dest.display()
        ));
    }

    if prefix == ROOT_DOCS_PREFIX && !ROOT_DOC_WHITELIST.contains(&relative) {
        return Err(format!(
            "安全拦截：root-docs 条目 \"{entry_name}\" 不在白名单（soul.md/schema.md/purpose.md）内"
        ));
    }

    Ok(Some(dest))
}
