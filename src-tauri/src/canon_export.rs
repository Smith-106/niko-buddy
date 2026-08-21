// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! T34c 项目级一键备份/恢复/导出（蓝图 T34c / TASK-P6-34c）。
//!
//! 与既有「全局导出备份」（`commands/backup.rs`，打包所有项目配置 + app-state）
//! 严格区分：本模块是**单项目**备份，包内容 = `.novel/status.json`（会话状态
//! 唯一真源）+ `.novel/drafts/`（草稿工件）+ `.qmai/lancedb/`（Canon 三表
//! LanceDB 库目录快照），zip 容器 + SHA-256 校验和（`.sha256` sidecar +
//! 包内 manifest 双层校验）。
//!
//! ## 能力面（4 个 IPC 命令）
//!   - [`canon_export_project`]：导出项目包 → zip + `<zip>.sha256` sidecar。
//!   - [`canon_restore_project`]：校验后原子替换；替换前自动备份当前状态到
//!     `{project}/backups/auto/pre-restore-<ts>.zip`（supersede 保护）。
//!   - [`canon_verify_export`]：只校验不落盘（容器 SHA-256 + manifest 内容摘要）。
//!   - [`canon_auto_backup`]：supersede / schema 迁移前由 TS 编排层显式调用的
//!     自动备份入口（`{project}/backups/auto/<ts>-<reason>.zip`）。
//!
//! ## 校验设计（两层）
//!   1. **容器层**：整包文件字节流 SHA-256，写入旁挂 `.sha256` 文件（标准
//!      `sha256sum` 行格式）；恢复时优先用入参期望值、其次读 sidecar 比对。
//!   2. **内容层**：manifest 内记录 `content_sha256` —— 对全部数据条目按
//!      「zip 路径 \0 长度(le64) \0 单文件 sha256hex \n」序贯哈希。恢复解压到
//!      staging 后从磁盘重算比对，可捕获容器校验和通过但条目损坏/被换的极端
//!      情况（以及 AES 口令错误时 CRC 碰巧通过的理论边角）。
//!
//! ## 原子替换策略
//!   - status.json：staging → 直接 `fs::rename` 覆盖（Windows MoveFileEx 语义，
//!     同卷原子替换）。
//!   - drafts / lancedb 目录：旧目录先 rename 移开 → staging 目录 rename 就位 →
//!     成功后删移开目录；失败则把移开目录滚回原位。同项目内 rename 保证同卷。
//!   - 全程先解压到 `{project}/backups/.t34c-staging-<ts>/` 校验通过后才动真身；
//!     失败路径 staging 一律清理。
//!
//! ## 口令（可选，纯本地）
//!   传入非空口令时所有条目走 zip AES-256 加密（zip-rs 2 `aes-crypto` 特性，
//!   默认开启）。口令只在本次调用内存中存在，不落盘、不入库、不上云；丢失
//!   口令 = 包不可恢复（文档化预期）。空字符串视同无口令。
//!
//! ## 快照语义注记
//!   LanceDB「checkout 快照」按**目录级文件快照**实现：写路径已由
//!   `canon_commands.rs` 的每项目写锁串行化，桌面单用户场景下目录拷贝即为一致
//!   性快照；目录内含全部 lance 版本历史，恢复即回滚到快照时点。运行期若 canon
//!   store 句柄未关闭，Windows 上目录 swap 可能因占用失败——错误会如实上抛，
//!   由 UI 提示重试（残余风险已文档化）。
//!
//! ## 依赖边界
//!   仅复用已装依赖：`zip` 2（含 aes-crypto）、`sha2`、`walkdir`、`chrono`、
//!   `serde_json`。零新依赖。核心逻辑与 `#[tauri::command]` 分离，`cargo test`
//!   直测。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

use crate::panic_guard::run_guarded;

// ──────────────────────────────────────────────────────────────────────────
// 常量（zip 布局 + 项目相对路径）
// ──────────────────────────────────────────────────────────────────────────

/// manifest 条目名（zip 内）。
const MANIFEST_ENTRY: &str = "manifest.json";
/// status.json 在 zip 内的前缀。
const STATUS_PREFIX: &str = "status/";
/// 草稿目录在 zip 内的前缀（映射 `{project}/.novel/drafts`）。
const DRAFTS_PREFIX: &str = "drafts/";
/// Canon LanceDB 快照在 zip 内的前缀（映射 `{project}/.qmai/lancedb`）。
const LANCEDB_PREFIX: &str = "canon-lancedb/";

/// 会话状态唯一真源（HARD-1）：`.novel/status.json`。
const STATUS_REL: &str = ".novel/status.json";
/// 草稿工件目录。
const DRAFTS_REL: &str = ".novel/drafts";
/// Canon LanceDB 库目录（与 canon_store::db_path 同源）。
const LANCEDB_REL: &str = ".qmai/lancedb";

/// 自动备份落点：`{project}/backups/auto/`。
const AUTO_BACKUP_DIR: &str = "backups/auto";

/// 当前包格式版本（只增不改；恢复端拒绝更新版本并提示）。
pub const FORMAT_VERSION: u32 = 1;
/// manifest.kind 标识（防误导入全局备份等其他 zip）。
pub const MANIFEST_KIND: &str = "niko-buddy-project-backup";

/// 进程级操作互斥锁：export / restore / auto_backup 串行化，防止并发 swap。
static OP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn op_lock() -> &'static tokio::sync::Mutex<()> {
    OP_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// ──────────────────────────────────────────────────────────────────────────
// IPC 类型（camelCase 序列化，与前端契约一一对应）
// ──────────────────────────────────────────────────────────────────────────

/// `canon_export_project` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonExportRequest {
    /// 项目根目录（绝对路径）。
    pub project_path: String,
    /// 输出 zip 绝对路径。
    pub output_zip_path: String,
    /// 可选本地口令（AES-256）；None / 空 = 不加密。
    pub passphrase: Option<String>,
}

/// `canon_export_project` 出参。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonExportResult {
    pub success: bool,
    pub warnings: Vec<String>,
    /// 打包的数据文件数（不含 manifest）。
    pub file_count: u64,
    /// zip 容器字节数。
    pub total_size: u64,
    /// 容器 SHA-256 hex（小写）。
    pub checksum_sha256: Option<String>,
    /// 旁挂校验和文件路径（`<zip>.sha256`）。
    pub sidecar_path: Option<String>,
    pub error: Option<String>,
}

/// `canon_restore_project` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonRestoreRequest {
    /// 目标项目根目录（绝对路径；不存在则创建）。
    pub project_path: String,
    /// 备份 zip 绝对路径。
    pub zip_path: String,
    /// 期望的容器 SHA-256 hex（如 UI 让用户粘贴 sidecar 内容）；None 时自动找
    /// `<zip>.sha256` sidecar，两者皆缺则降级为仅内容层校验（记 warning）。
    pub expected_checksum: Option<String>,
    /// 导出时的口令（若有）。
    pub passphrase: Option<String>,
}

/// `canon_restore_project` 出参。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonRestoreResult {
    pub success: bool,
    pub restored_status: bool,
    pub restored_drafts: bool,
    pub restored_canon_lancedb: bool,
    /// 实际替换的数据文件数。
    pub restored_files: u64,
    /// 容器层校验和是否比对成功（None = 无期望值且无 sidecar，降级）。
    pub checksum_verified: Option<bool>,
    /// 替换前自动备份的 zip 路径（supersede 保护）。
    pub auto_backup_path: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

/// `canon_verify_export` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonVerifyRequest {
    pub zip_path: String,
    pub expected_checksum: Option<String>,
    pub passphrase: Option<String>,
}

/// `canon_verify_export` 出参。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonVerifyResult {
    pub success: bool,
    /// 容器校验和比对结果（None = 无期望值且无 sidecar 可比）。
    pub container_checksum_matches: Option<bool>,
    /// 实际计算的容器 SHA-256 hex。
    pub computed_checksum: Option<String>,
    pub manifest_found: bool,
    /// manifest 记录的数据文件数。
    pub file_count: u64,
    /// 内容层摘要是否与磁盘解压结果一致。
    pub content_digest_verified: bool,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

/// `canon_auto_backup` 入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonAutoBackupRequest {
    pub project_path: String,
    /// 备份原因标签（进文件名，如 "pre-supersede" / "pre-migration"）。
    pub reason: String,
}

/// `canon_auto_backup` 出参。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonAutoBackupResult {
    pub success: bool,
    pub backup_path: Option<String>,
    pub checksum_sha256: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

// ──────────────────────────────────────────────────────────────────────────
// manifest（zip 内自描述）
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectBackupManifest {
    kind: String,
    format_version: u32,
    created_at: String,
    app_version: String,
    project_name: String,
    components: ManifestComponents,
    /// 数据文件数（不含 manifest 自身）。
    file_count: u64,
    content_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestComponents {
    status: bool,
    drafts: bool,
    canon_lancedb: bool,
}

// ──────────────────────────────────────────────────────────────────────────
// 小工具
// ──────────────────────────────────────────────────────────────────────────

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 本地时间戳（文件名安全）：`YYYYMMDD-HHMMSS`。
fn now_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 高精度唯一后缀，避免同一秒内多个操作的命名碰撞。
fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{}-{}", now_stamp(), nanos)
}

/// 归一化 reason 为文件名安全段：非 [a-zA-Z0-9_-] 一律替换为 '-'。
fn sanitize_reason(reason: &str) -> String {
    let cleaned: String = reason
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() { "unspecified".into() } else { trimmed }
}

/// 规范化为 zip 内正斜杠路径。
fn to_zip_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn normalize_pass(passphrase: &Option<String>) -> Option<String> {
    match passphrase {
        Some(p) if !p.trim().is_empty() => Some(p.clone()),
        _ => None,
    }
}

fn err_ctx(prefix: &str, e: impl std::fmt::Display) -> String {
    format!("{prefix}: {e}")
}

// ──────────────────────────────────────────────────────────────────────────
// 组件枚举（pack 与 verify 共用同一套顺序，保证 content digest 逐字节一致）
// ──────────────────────────────────────────────────────────────────────────

/// 三组件在磁盘上的根（None = 该组件不存在）。
struct ComponentRoots {
    status: Option<PathBuf>,
    drafts: Option<PathBuf>,
    lancedb: Option<PathBuf>,
}

impl ComponentRoots {
    fn from_project(project: &Path) -> Self {
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
fn enumerate_dir(root: &Path, zip_prefix: &str) -> Vec<(String, PathBuf)> {
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
fn enumerate_entries(roots: &ComponentRoots) -> Vec<(String, PathBuf)> {
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
fn copy_and_hash(file: &mut fs::File, sink: &mut ZipWriter<fs::File>) -> Result<(u64, String), String> {
    let mut hasher = Sha256::new();
    let mut len: u64 = 0;
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| err_ctx("读取源文件失败", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        sink.write_all(&buf[..n]).map_err(|e| err_ctx("写入 zip 失败", e))?;
        len += n as u64;
    }
    Ok((len, hex(&hasher.finalize())))
}

/// 流式计算单文件 SHA-256（不驻留整文件内存），返回 (len, hex)。
fn hash_file(path: &Path) -> Result<(u64, String), String> {
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
fn compute_content_digest_from_disk(entries: &[(String, PathBuf)]) -> Result<String, String> {
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
// 打包核心
// ──────────────────────────────────────────────────────────────────────────

/// 打包输出信息。
struct PackOutcome {
    file_count: u64,
    total_size: u64,
    checksum_hex: String,
    warnings: Vec<String>,
}

fn base_opts() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
}

/// 把项目三组件打成 zip + 写 `.sha256` sidecar。
///
/// 被 export / restore 前置自动备份 / auto_backup 三方复用。
fn pack_project(
    project_path: &Path,
    output_zip: &Path,
    passphrase: Option<&str>,
    project_name: &str,
) -> Result<PackOutcome, String> {
    let roots = ComponentRoots::from_project(project_path);

    let mut warnings = Vec::new();
    let has_status = roots.status.is_some();
    let has_drafts = roots.drafts.is_some();
    let has_lancedb = roots.lancedb.is_some();
    if !has_status {
        warnings.push(format!("缺少 {STATUS_REL}（尚未生成会话状态？），包内将不含 status"));
    }
    if !has_drafts {
        warnings.push(format!("缺少 {DRAFTS_REL}，包内不含草稿目录"));
    }
    if !has_lancedb {
        warnings.push(format!("缺少 {LANCEDB_REL}，包内不含 Canon LanceDB 快照"));
    }

    let entries = enumerate_entries(&roots);
    let file = fs::File::create(output_zip)
        .map_err(|e| err_ctx(format!("无法创建备份文件 {}", output_zip.display()).as_str(), e))?;
    let mut zip = ZipWriter::new(file);

    // 有口令 → 所有条目 AES-256；无口令 → Deflated 明文。
    // （with_aes_encryption 返回的 FileOptions 借用口令字符串，
    //   故先归一为本地 owned String 再统一构造一次，避免生命周期不齐。）
    let pass_owned: Option<String> = passphrase.map(str::to_string);
    let opts = match pass_owned.as_deref() {
        Some(p) => base_opts().with_aes_encryption(AesMode::Aes256, p),
        None => base_opts(),
    };

    // 1) 数据条目（单遍流式：写 zip + per-file sha256）
    let mut digest = Sha256::new();
    let mut packed: u64 = 0;
    for (name, path) in &entries {
        let mut src =
            fs::File::open(path).map_err(|e| err_ctx(format!("打开 {} 失败", path.display()).as_str(), e))?;
        zip.start_file(name, opts)
            .map_err(|e| err_ctx(format!("创建 zip 条目 {name} 失败").as_str(), e))?;
        let (len, file_hex) = copy_and_hash(&mut src, &mut zip)?;
        // 内容摘要记录（pack/verify 两端共享此格式）
        digest.update(name.as_bytes());
        digest.update(b"\0");
        digest.update(&len.to_le_bytes());
        digest.update(b"\0");
        digest.update(file_hex.as_bytes());
        digest.update(b"\n");
        packed += 1;
    }

    // 2) manifest 最后写入（content digest 此时才齐备；zip 读端随机访问不受顺序影响）
    let manifest = ProjectBackupManifest {
        kind: MANIFEST_KIND.to_string(),
        format_version: FORMAT_VERSION,
        created_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        project_name: project_name.to_string(),
        components: ManifestComponents {
            status: has_status,
            drafts: has_drafts,
            canon_lancedb: has_lancedb,
        },
        file_count: packed,
        content_sha256: hex(&digest.finalize()),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| err_ctx("序列化 manifest 失败", e))?;
    zip.start_file(MANIFEST_ENTRY, opts)
        .map_err(|e| err_ctx("写入 manifest 失败", e))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| err_ctx("写入 manifest 失败", e))?;
    zip.finish().map_err(|e| err_ctx("完成 zip 写入失败", e))?;

    // 3) 容器 SHA-256 + sidecar
    let checksum_hex = stream_file_sha256(output_zip)?;
    write_checksum_sidecar(output_zip, &checksum_hex)?;
    let total_size = fs::metadata(output_zip)
        .map(|m| m.len())
        .map_err(|e| err_ctx("读取备份文件大小失败", e))?;

    Ok(PackOutcome {
        file_count: packed,
        total_size,
        checksum_hex,
        warnings,
    })
}

fn stream_file_sha256(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| err_ctx("打开文件计算 SHA-256 失败", e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| err_ctx("读取文件计算 SHA-256 失败", e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn sidecar_path(zip_path: &Path) -> PathBuf {
    let mut s = zip_path.as_os_str().to_os_string();
    s.push(".sha256");
    PathBuf::from(s)
}

/// 写标准 `sha256sum` 行格式：`<hex>  <filename>`。
fn write_checksum_sidecar(zip_path: &Path, checksum_hex: &str) -> Result<PathBuf, String> {
    let sp = sidecar_path(zip_path);
    let file_name = zip_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "backup.zip".to_string());
    fs::write(&sp, format!("{checksum_hex}  {file_name}\n"))
        .map_err(|e| err_ctx(format!("写入校验和文件 {} 失败", sp.display()).as_str(), e))?;
    Ok(sp)
}

/// 解析 sidecar 首个空白前的 token 作为 hex；不存在/解析失败返回 None。
fn parse_sidecar_checksum(zip_path: &Path) -> Option<String> {
    let text = fs::read_to_string(sidecar_path(zip_path)).ok()?;
    text.split_whitespace().next().map(str::to_lowercase)
}

// ──────────────────────────────────────────────────────────────────────────
// 解包 / 校验核心
// ──────────────────────────────────────────────────────────────────────────

/// 解密感知地读取 zip 内指定条目为字节（AES 口令可选）。
fn read_entry_bytes(
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

fn map_zip_read_err(e: ZipError) -> String {
    match &e {
        ZipError::InvalidPassword => "密码错误或文件损坏".to_string(),
        other => format!("读取 zip 失败: {other}"),
    }
}

/// 容器层校验：有期望值用期望值，否则找 sidecar；都没有返回 None（降级）。
fn compare_container_checksum(
    zip_path: &Path,
    expected: Option<&str>,
) -> Result<(Option<bool>, String), String> {
    let actual = stream_file_sha256(zip_path)?;
    let expected_norm = expected
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .or_else(|| parse_sidecar_checksum(zip_path));
    Ok((
        expected_norm.map(|exp| exp == actual.to_lowercase()),
        actual,
    ))
}

/// staging 内三组件根（从解压产物构造）。
fn staged_roots(staging: &Path) -> ComponentRoots {
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
fn safe_staging_target(staging_canonical: &Path, entry_name: &str) -> Result<Option<PathBuf>, String> {
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

/// 校验后的 staging 结果。
struct StagedArchive {
    manifest: ProjectBackupManifest,
    staged_files: u64,
}

/// 公共前置流程：开 zip → 容器校验和 → 读 manifest → 全量解压到 staging →
/// 内容层摘要复核。任何一层不过即 Err（restore / verify 共用）。
fn stage_verified_archive(
    zip_path: &Path,
    staging_root: &Path,
    expected_checksum: Option<&str>,
    passphrase: Option<&str>,
    warnings: &mut Vec<String>,
) -> Result<StagedArchive, String> {
    if !zip_path.is_file() {
        return Err(format!("备份文件不存在: {}", zip_path.display()));
    }

    // ── 容器层校验和 ──
    let (container_match, _computed_hex) = compare_container_checksum(zip_path, expected_checksum)?;
    match container_match {
        Some(true) => {}
        Some(false) => {
            return Err("SHA-256 校验和不匹配：备份文件可能已被篡改或损坏，已中止恢复".to_string())
        }
        None => warnings
            .push("无法找到 .sha256 校验和文件且未提供期望值，将仅依赖包内内容摘要校验".to_string()),
    }

    // ── 开包 + manifest ──
    let file = fs::File::open(zip_path).map_err(|e| err_ctx("打开备份文件失败", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| err_ctx("读取备份文件失败，可能已损坏", e))?;

    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    let manifest_index = names
        .iter()
        .position(|n| n == MANIFEST_ENTRY)
        .ok_or_else(|| "缺少 manifest.json：不是有效的项目备份包（注意：全局备份请走设置页数据管理）".to_string())?;

    let manifest_bytes = read_entry_bytes(&mut archive, manifest_index, passphrase)?;
    let manifest: ProjectBackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| err_ctx("解析 manifest.json 失败", e))?;
    if manifest.kind != MANIFEST_KIND {
        return Err(format!(
            "备份类型不符：期望 \"{MANIFEST_KIND}\"，实际 \"{}\"",
            manifest.kind
        ));
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(format!(
            "备份格式版本 {} 高于当前支持版本 {FORMAT_VERSION}，请升级应用后再恢复",
            manifest.format_version
        ));
    }

    // ── 全量解压到 staging（Zip-Slip 防护；未知前缀跳过并警告）──
    fs::create_dir_all(staging_root).map_err(|e| err_ctx("创建暂存目录失败", e))?;
    let staging_canonical = staging_root.canonicalize().map_err(|e| err_ctx("解析暂存目录失败", e))?;

    let mut staged_files: u64 = 0;
    for (index, name) in names.iter().enumerate() {
        if name == MANIFEST_ENTRY || name.ends_with('/') {
            continue;
        }
        let target = match safe_staging_target(&staging_canonical, name)? {
            Some(t) => t,
            None => {
                warnings.push(format!("跳过未知条目: {name}"));
                continue;
            }
        };
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| err_ctx(format!("创建目录 {} 失败", parent.display()).as_str(), e))?;
        }
        let data = read_entry_bytes(&mut archive, index, passphrase)?;
        fs::write(&target, &data)
            .map_err(|e| err_ctx(format!("写入暂存文件 {} 失败", target.display()).as_str(), e))?;
        staged_files += 1;
    }

    // ── 内容层摘要复核（从磁盘重算）──
    let roots = staged_roots(staging_root);
    let entries = enumerate_entries(&roots);
    let actual_digest = compute_content_digest_from_disk(&entries)?;
    if actual_digest != manifest.content_sha256.to_lowercase() {
        return Err(
            "内容摘要校验失败：解压后的文件与 manifest 记录不一致（包损坏或口令/版本异常），已中止"
                .to_string(),
        );
    }

    Ok(StagedArchive {
        manifest,
        staged_files,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// 原子替换
// ──────────────────────────────────────────────────────────────────────────

/// 目录原子换位：旧目录移开 → 新目录就位 → 删旧；失败滚回。
/// 返回是否实际发生了替换。
fn swap_directory(staged: &Path, current: &Path, aside: &Path) -> Result<bool, String> {
    let existed = current.exists();
    if existed {
        fs::rename(current, aside).map_err(|e| {
            err_ctx(
                format!("移开现有目录 {} 失败（可能被其他进程占用）", current.display()).as_str(),
                e,
            )
        })?;
    }
    match fs::rename(staged, current) {
        Ok(_) => {
            if aside.exists() {
                let _ = fs::remove_dir_all(aside);
            }
            Ok(true)
        }
        Err(e) => {
            // 滚回：把移开的旧目录放回原位
            if existed && aside.exists() {
                let _ = fs::rename(aside, current);
            }
            Err(err_ctx(
                format!("就位新目录 {} 失败，已回滚", current.display()).as_str(),
                e,
            ))
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 三个业务入口（Tauri 无关，供命令与测试直接调用）
// ──────────────────────────────────────────────────────────────────────────

/// 导出项目包。
pub fn export_project_impl(request: &CanonExportRequest) -> Result<CanonExportResult, String> {
    let project = Path::new(&request.project_path);
    if !project.is_dir() {
        return Ok(failed_export(format!("项目目录不存在: {}", request.project_path)));
    }
    let output = Path::new(&request.output_zip_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| err_ctx("创建输出目录失败", e))?;
    }
    let pass = normalize_pass(&request.passphrase);
    let project_name = project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let outcome = pack_project(project, output, pass.as_deref(), &project_name)?;

    Ok(CanonExportResult {
        success: true,
        warnings: outcome.warnings,
        file_count: outcome.file_count,
        total_size: outcome.total_size,
        checksum_sha256: Some(outcome.checksum_hex),
        sidecar_path: Some(sidecar_path(output).to_string_lossy().to_string()),
        error: None,
    })
}

fn failed_export(error: String) -> CanonExportResult {
    CanonExportResult {
        success: false,
        warnings: vec![],
        file_count: 0,
        total_size: 0,
        checksum_sha256: None,
        sidecar_path: None,
        error: Some(error),
    }
}

/// 只校验不落盘：容器校验和 + manifest + 内容摘要全链路检查（临时目录解压）。
pub fn verify_export_impl(request: &CanonVerifyRequest) -> Result<CanonVerifyResult, String> {
    let zip_path = Path::new(&request.zip_path);
    let pass = normalize_pass(&request.passphrase);
    let mut warnings = Vec::new();

    let (container_match, computed) = if zip_path.is_file() {
        compare_container_checksum(zip_path, request.expected_checksum.as_deref())?
    } else {
        return Ok(CanonVerifyResult {
            success: false,
            container_checksum_matches: None,
            computed_checksum: None,
            manifest_found: false,
            file_count: 0,
            content_digest_verified: false,
            warnings,
            error: Some(format!("备份文件不存在: {}", request.zip_path)),
        });
    };
    if container_match == Some(false) {
        return Ok(CanonVerifyResult {
            success: false,
            container_checksum_matches: Some(false),
            computed_checksum: Some(computed),
            manifest_found: false,
            file_count: 0,
            content_digest_verified: false,
            warnings,
            error: Some("SHA-256 校验和不匹配：备份文件可能已被篡改或损坏".to_string()),
        });
    }

    let staging = std::env::temp_dir().join(format!("t34c-verify-{}", unique_suffix()));
    let staged = stage_verified_archive(
        zip_path,
        &staging,
        request.expected_checksum.as_deref(),
        pass.as_deref(),
        &mut warnings,
    );
    let _ = fs::remove_dir_all(&staging);

    match staged {
        Ok(s) => Ok(CanonVerifyResult {
            success: true,
            container_checksum_matches: container_match,
            computed_checksum: Some(computed),
            manifest_found: true,
            file_count: s.manifest.file_count,
            content_digest_verified: true,
            warnings,
            error: None,
        }),
        Err(e) => Ok(CanonVerifyResult {
            success: false,
            container_checksum_matches: container_match,
            computed_checksum: Some(computed),
            manifest_found: false,
            file_count: 0,
            content_digest_verified: false,
            warnings,
            error: Some(e),
        }),
    }
}

/// 恢复：校验 → 自动备份现状 → staging → 原子替换。
pub fn restore_project_impl(request: &CanonRestoreRequest) -> Result<CanonRestoreResult, String> {
    let project = Path::new(&request.project_path);
    let zip_path = Path::new(&request.zip_path);
    let pass = normalize_pass(&request.passphrase);
    let mut warnings = Vec::new();

    // ── 1. 校验 + 解压 staging ──
    let stamp = unique_suffix();
    let backups_root = project.join("backups");
    let staging = backups_root.join(format!(".t34c-staging-{stamp}"));
    let staged = match stage_verified_archive(
        zip_path,
        &staging,
        request.expected_checksum.as_deref(),
        pass.as_deref(),
        &mut warnings,
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Ok(failed_restore(e, None, None));
        }
    };

    // ── 2. 替换前自动备份（supersede 保护）──
    let auto_dir = project.join(AUTO_BACKUP_DIR);
    let mut auto_backup_path: Option<String> = None;
    let has_current_state =
        project.join(STATUS_REL).is_file() || project.join(DRAFTS_REL).exists() || project.join(LANCEDB_REL).exists();
    if has_current_state {
        fs::create_dir_all(&auto_dir).map_err(|e| err_ctx("创建自动备份目录失败", e))?;
        let auto_zip = auto_dir.join(format!("pre-restore-{}.zip", stamp));
        let current_name = project
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string());
        match pack_project(project, &auto_zip, None, &current_name) {
            Ok(outcome) => {
                auto_backup_path = Some(auto_zip.to_string_lossy().to_string());
                warnings.extend(outcome.warnings.into_iter().map(|w| format!("[自动备份] {w}")));
            }
            Err(e) => {
                // 数据安全原则：有现存状态但备份失败 → 不允许破坏性替换
                let _ = fs::remove_dir_all(&staging);
                return Ok(failed_restore(
                    format!("替换前自动备份失败，已中止恢复以保护现有数据: {e}"),
                    None,
                    None,
                ));
            }
        }
    } else {
        warnings.push("当前项目无可备份状态，跳过恢复前自动备份".to_string());
    }

    // ── 3. 原子替换（任一步失败 → 清理 staging，报告已完成的替换 + 自动备份路径）──
    let components = staged.manifest.components.clone();
    let staged_files = staged.staged_files;
    let replace_result: Result<(bool, bool, bool), String> = (|| {
        let mut rs = false;
        let mut rd = false;
        let mut rl = false;

        // status.json：staging → 直接 rename 覆盖（同卷 MoveFileEx 替换语义）
        if components.status {
            let staged_status = staging.join("status").join("status.json");
            let target_dir = project.join(".novel");
            fs::create_dir_all(&target_dir).map_err(|e| err_ctx("创建 .novel 目录失败", e))?;
            fs::rename(&staged_status, target_dir.join("status.json"))
                .map_err(|e| err_ctx("替换 status.json 失败", e))?;
            rs = true;
        }

        // drafts / canon-lancedb：移开旧目录 → staging 就位 → 删旧
        if components.drafts {
            rd = swap_directory(
                &staging.join("drafts"),
                &project.join(DRAFTS_REL),
                &backups_root.join(format!(".t34c-old-drafts-{stamp}")),
            )?;
        }
        if components.canon_lancedb {
            rl = swap_directory(
                &staging.join("canon-lancedb"),
                &project.join(LANCEDB_REL),
                &backups_root.join(format!(".t34c-old-lancedb-{stamp}")),
            )?;
        }
        Ok((rs, rd, rl))
    })();

    let (restored_status, restored_drafts, restored_lancedb) = match replace_result {
        Ok(tuple) => tuple,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Ok(failed_restore(e, Some(true), auto_backup_path));
        }
    };

    // ── 4. 清理 staging ──
    let _ = fs::remove_dir_all(&staging);

    Ok(CanonRestoreResult {
        success: true,
        restored_status,
        restored_drafts,
        restored_canon_lancedb: restored_lancedb,
        restored_files: staged_files,
        checksum_verified: Some(true),
        auto_backup_path,
        warnings,
        error: None,
    })
}

fn failed_restore(
    error: String,
    checksum_verified: Option<bool>,
    auto_backup_path: Option<String>,
) -> CanonRestoreResult {
    CanonRestoreResult {
        success: false,
        restored_status: false,
        restored_drafts: false,
        restored_canon_lancedb: false,
        restored_files: 0,
        checksum_verified,
        auto_backup_path,
        warnings: vec![],
        error: Some(error),
    }
}

/// supersede / schema 迁移前的自动备份入口。
pub fn auto_backup_impl(request: &CanonAutoBackupRequest) -> Result<CanonAutoBackupResult, String> {
    let project = Path::new(&request.project_path);
    if !project.is_dir() {
        return Ok(CanonAutoBackupResult {
            success: false,
            backup_path: None,
            checksum_sha256: None,
            warnings: vec![],
            error: Some(format!("项目目录不存在: {}", request.project_path)),
        });
    }
    let roots = ComponentRoots::from_project(project);
    if roots.status.is_none() && roots.drafts.is_none() && roots.lancedb.is_none() {
        return Ok(CanonAutoBackupResult {
            success: false,
            backup_path: None,
            checksum_sha256: None,
            warnings: vec![],
            error: Some("项目下没有任何可备份的状态（status/drafts/canon 均不存在）".to_string()),
        });
    }

    let auto_dir = project.join(AUTO_BACKUP_DIR);
    fs::create_dir_all(&auto_dir).map_err(|e| err_ctx("创建自动备份目录失败", e))?;
    let output = auto_dir.join(format!(
        "{}-{}.zip",
        now_stamp(),
        sanitize_reason(&request.reason)
    ));
    let project_name = project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let outcome = pack_project(project, &output, None, &project_name)?;
    Ok(CanonAutoBackupResult {
        success: true,
        backup_path: Some(output.to_string_lossy().to_string()),
        checksum_sha256: Some(outcome.checksum_hex),
        warnings: outcome.warnings,
        error: None,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// `#[tauri::command]` 包装（JS 侧 invoke("canon_export_project", { request })）
// ──────────────────────────────────────────────────────────────────────────

/// 导出项目备份包（zip + SHA-256 sidecar；可选本地 AES-256 口令）。
#[tauri::command]
pub async fn canon_export_project(request: CanonExportRequest) -> Result<CanonExportResult, String> {
    let _guard = op_lock().lock().await;
    run_guarded("canon_export_project", || export_project_impl(&request))
}

/// 从备份包恢复项目（校验通过后原子替换；替换前自动备份现状）。
#[tauri::command]
pub async fn canon_restore_project(request: CanonRestoreRequest) -> Result<CanonRestoreResult, String> {
    let _guard = op_lock().lock().await;
    run_guarded("canon_restore_project", || restore_project_impl(&request))
}

/// 只校验备份包完整性（容器 SHA-256 + 内容摘要），不做任何写操作。
#[tauri::command]
pub async fn canon_verify_export(request: CanonVerifyRequest) -> Result<CanonVerifyResult, String> {
    run_guarded("canon_verify_export", || verify_export_impl(&request))
}

/// supersede / schema 迁移前的自动备份（TS 编排层显式调用）。
#[tauri::command]
pub async fn canon_auto_backup(request: CanonAutoBackupRequest) -> Result<CanonAutoBackupResult, String> {
    let _guard = op_lock().lock().await;
    run_guarded("canon_auto_backup", || auto_backup_impl(&request))
}

// ──────────────────────────────────────────────────────────────────────────
// 测试（导出→校验→恢复全链路 + 篡改/口令/ZipSlip/自动备份）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sha256_hex(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex(&h.finalize())
    }

    /// 唯一临时目录（沿用 canon_commands 测试模式：计数器 + 时间戳，不主动清理）。
    fn tmp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("t34c-{tag}-{}-{}", ts, id));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// 构造一个假项目树：status.json + drafts 若干 + lancedb 若干（纯文件，无需 LanceDB）。
    fn seed_project(tag: &str) -> PathBuf {
        let p = tmp_dir(tag);
        fs::create_dir_all(p.join(".novel/drafts")).unwrap();
        fs::create_dir_all(p.join(".qmai/lancedb")).unwrap();
        fs::write(p.join(".novel/status.json"), r#"{"step":"ch-3","chapter":3}"#).unwrap();
        fs::write(p.join(".novel/drafts/conv_1.json"), r#"{"draft":1}"#).unwrap();
        fs::write(p.join(".novel/drafts/conv_2.superseded.1.json"), r#"{"draft":2-old}"#).unwrap();
        fs::create_dir_all(p.join(".qmai/lancedb/entities.lance")).unwrap();
        fs::write(p.join(".qmai/lancedb/entities.lance/data.lance"), b"lance-bytes-1").unwrap();
        fs::write(p.join(".qmai/lancedb/_versions/manifest-0"), b"lance-manifest").unwrap();
        p
    }

    fn export_req(project: &Path, zip: &Path) -> CanonExportRequest {
        CanonExportRequest {
            project_path: project.to_string_lossy().to_string(),
            output_zip_path: zip.to_string_lossy().to_string(),
            passphrase: None,
        }
    }

    // ── sha256 已知向量 ──

    #[test]
    fn sha256_hex_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    // ── 导出 → 篡改现场 → 恢复：内容还原 + 自动备份存在 ──

    #[test]
    fn export_roundtrip_restores_status_drafts_and_lancedb() {
        let project = seed_project("roundtrip");
        let out_dir = tmp_dir("roundtrip-out");
        let zip = out_dir.join("proj-backup.zip");

        let result = export_project_impl(&export_req(&project, &zip)).unwrap();
        assert!(result.success, "导出应成功: {:?}", result.error);
        assert_eq!(result.file_count, 5, "status+2drafts+2lance 文件");
        assert!(result.checksum_sha256.as_ref().is_some_and(|c| c.len() == 64));
        assert!(sidecar_path(&zip).is_file(), "sidecar 应存在");

        // 破坏现场：改 status、删一个 draft、污染 lancedb
        fs::write(project.join(".novel/status.json"), r#"{"step":"corrupted"}"#).unwrap();
        fs::remove_file(project.join(".novel/drafts/conv_1.json")).unwrap();
        fs::write(project.join(".qmai/lancedb/_versions/manifest-0"), b"tampered").unwrap();

        let restore = restore_project_impl(&CanonRestoreRequest {
            project_path: project.to_string_lossy().to_string(),
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(restore.success, "恢复应成功: {:?}", restore.error);
        assert!(restore.restored_status && restore.restored_drafts && restore.restored_canon_lancedb);
        assert_eq!(restore.restored_files, 5);
        assert_eq!(restore.checksum_verified, Some(true), "sidecar 存在时应通过容器校验");
        assert!(
            restore.auto_backup_path.as_ref().is_some_and(|p| Path::new(p).is_file()),
            "替换前应有自动备份"
        );

        // 现场已还原
        assert_eq!(
            fs::read_to_string(project.join(".novel/status.json")).unwrap(),
            r#"{"step":"ch-3","chapter":3}"#
        );
        assert!(project.join(".novel/drafts/conv_1.json").is_file());
        assert_eq!(
            fs::read(project.join(".qmai/lancedb/_versions/manifest-0")).unwrap(),
            b"lance-manifest"
        );

        // 自动备份本身也应能过 verify
        let ab_path = restore.auto_backup_path.unwrap();
        let ab = Path::new(&ab_path);
        let v = verify_export_impl(&CanonVerifyRequest {
            zip_path: ab.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(v.success, "自动备份包应通过校验: {:?}", v.error);
    }

    // ── 容器篡改检测 ──

    #[test]
    fn verify_detects_tampered_container() {
        let project = seed_project("tamper");
        let zip = tmp_dir("tamper-out").join("t.zip");
        export_project_impl(&export_req(&project, &zip)).unwrap();

        // 翻转压缩数据区一个字节（远离头尾 central directory）
        let mut bytes = fs::read(&zip).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        fs::write(&zip, &bytes).unwrap();

        let v = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(!v.success, "篡改后校验应失败");
        let err = v.error.unwrap();
        assert!(
            err.contains("校验和") || err.contains("损坏") || err.contains("摘要"),
            "错误应指向校验失败: {err}"
        );
    }

    // ── 期望值比对：正确/错误 ──

    #[test]
    fn expected_checksum_mismatch_rejects_restore() {
        let project = seed_project("mismatch");
        let zip = tmp_dir("mismatch-out").join("t.zip");
        let exported = export_project_impl(&export_req(&project, &zip)).unwrap();

        let v = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: Some("deadbeef".to_string()),
            passphrase: None,
        })
        .unwrap();
        assert!(!v.success);
        assert_eq!(v.container_checksum_matches, Some(false));

        // 正确期望值 → 通过
        let v2 = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: exported.checksum_sha256.clone(),
            passphrase: None,
        })
        .unwrap();
        assert!(v2.success, "正确期望值应通过: {:?}", v2.error);
        assert_eq!(v2.container_checksum_matches, Some(true));
    }

    // ── 缺 manifest / 错误类型 ──

    #[test]
    fn non_project_zip_is_rejected() {
        let dir = tmp_dir("nomanifest");
        let zip = dir.join("plain.zip");
        let f = fs::File::create(&zip).unwrap();
        let mut zw = ZipWriter::new(f);
        zw.start_file("random.txt", base_opts()).unwrap();
        zw.write_all(b"not a project backup").unwrap();
        zw.finish().unwrap();

        let v = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(!v.success);
        assert!(v.error.unwrap().contains("manifest"), "应报缺 manifest");
    }

    // ── 口令：正确口令 roundtrip；错误口令被拒 ──

    #[test]
    fn passphrase_roundtrip_ok_and_wrong_password_rejected() {
        let project = seed_project("passphrase");
        let out = tmp_dir("passphrase-out");
        let zip = out.join("enc.zip");

        let exported = export_project_impl(&CanonExportRequest {
            project_path: project.to_string_lossy().to_string(),
            output_zip_path: zip.to_string_lossy().to_string(),
            passphrase: Some("本地口令-local-pass".to_string()),
        })
        .unwrap();
        assert!(exported.success);

        // 正确口令：verify 通过
        let ok = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: Some("本地口令-local-pass".to_string()),
        })
        .unwrap();
        assert!(ok.success, "正确口令应通过: {:?}", ok.error);

        // 错误口令：verify 失败（密码错 或 内容摘要不一致）
        let bad = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: Some("wrong-password".to_string()),
        })
        .unwrap();
        assert!(!bad.success, "错误口令不应通过");
        let msg = bad.error.unwrap_or_default();
        assert!(
            msg.contains("密码") || msg.contains("摘要") || msg.contains("损坏"),
            "错误应指向口令/内容问题: {msg}"
        );

        // 无口令读加密包同样失败
        let none = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(!none.success, "缺口令不应通过");
    }

    // ── 空/空白口令等价无口令（明文可读）──

    #[test]
    fn blank_passphrase_means_plain() {
        let project = seed_project("blankpass");
        let zip = tmp_dir("blankpass-out").join("t.zip");
        let exported = export_project_impl(&CanonExportRequest {
            project_path: project.to_string_lossy().to_string(),
            output_zip_path: zip.to_string_lossy().to_string(),
            passphrase: Some("   ".to_string()),
        })
        .unwrap();
        assert!(exported.success);

        let v = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(v.success, "空白口令应等价明文: {:?}", v.error);
    }

    // ── Zip-Slip 防护 ──

    #[test]
    fn zip_slip_entry_is_rejected_on_restore() {
        let project = seed_project("zipslip-target");
        let evil_dir = tmp_dir("zipslip-src");
        let evil_zip = evil_dir.join("evil.zip");

        // 手工造带 traversal 条目的包：manifest 合法（kind/版本对），
        // 数据区夹带 ../ 逃逸条目 → 解压阶段应被拦截。
        let f = fs::File::create(&evil_zip).unwrap();
        let mut zw = ZipWriter::new(f);
        let manifest_json = serde_json::json!({
            "kind": MANIFEST_KIND,
            "format_version": FORMAT_VERSION,
            "created_at": "2026-01-01T00:00:00Z",
            "app_version": "0",
            "project_name": "evil",
            "components": { "status": false, "drafts": true, "canon_lancedb": false },
            "file_count": 1,
            "content_sha256": "00"
        })
        .to_string();
        zw.start_file(MANIFEST_ENTRY, base_opts()).unwrap();
        zw.write_all(manifest_json.as_bytes()).unwrap();
        zw.start_file("drafts/../../evil.txt", base_opts()).unwrap();
        zw.write_all(b"malicious").unwrap();
        zw.finish().unwrap();

        let restore = restore_project_impl(&CanonRestoreRequest {
            project_path: project.to_string_lossy().to_string(),
            zip_path: evil_zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(!restore.success, "traversal 条目应被拒");
        assert!(restore.error.unwrap().contains("安全拦截"));
        assert!(!evil_dir.join("evil.txt").exists(), "恶意文件不应落到包外");
    }

    // ── 自动备份命令核心 ──

    #[test]
    fn auto_backup_creates_timestamped_zip_with_sidecar() {
        let project = seed_project("autobackup");
        let r = auto_backup_impl(&CanonAutoBackupRequest {
            project_path: project.to_string_lossy().to_string(),
            reason: "pre supersede/迁移!".to_string(),
        })
        .unwrap();
        assert!(r.success, "{:?}", r.error);
        let path = Path::new(r.backup_path.as_ref().unwrap());
        assert!(path.is_file());
        assert!(
            path.file_name().unwrap().to_string_lossy().contains("pre-supersede"),
            "reason 应被清洗进文件名: {}",
            path.display()
        );
        assert!(r.checksum_sha256.as_ref().is_some_and(|c| c.len() == 64));
        assert!(sidecar_path(path).is_file(), "自动备份也应有 sidecar");

        // 空项目 → 报无可备份
        let empty = tmp_dir("autobackup-empty");
        let r2 = auto_backup_impl(&CanonAutoBackupRequest {
            project_path: empty.to_string_lossy().to_string(),
            reason: "pre-migration".to_string(),
        })
        .unwrap();
        assert!(!r2.success);
        assert!(r2.error.unwrap().contains("没有"));
    }

    // ── 缺组件降级：只有 status 的项目也能导出/恢复 ──

    #[test]
    fn export_with_partial_components_warns_but_succeeds() {
        let project = tmp_dir("partial");
        fs::create_dir_all(project.join(".novel")).unwrap();
        fs::write(project.join(".novel/status.json"), r#"{"only":"status"}"#).unwrap();

        let out = tmp_dir("partial-out");
        let zip = out.join("t.zip");
        let exported = export_project_impl(&export_req(&project, &zip)).unwrap();
        assert!(exported.success, "{:?}", exported.error);
        assert_eq!(exported.file_count, 1);
        assert!(
            exported.warnings.iter().any(|w| w.contains("drafts") || w.contains("lancedb")),
            "缺失组件应产生 warning: {:?}",
            exported.warnings
        );

        // 恢复到全新目录：只建 status
        let target = tmp_dir("partial-target");
        let restore = restore_project_impl(&CanonRestoreRequest {
            project_path: target.to_string_lossy().to_string(),
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(restore.success, "{:?}", restore.error);
        assert!(restore.restored_status);
        assert!(!restore.restored_drafts && !restore.restored_canon_lancedb);
        assert_eq!(
            fs::read_to_string(target.join(".novel/status.json")).unwrap(),
            r#"{"only":"status"}"#
        );
    }

    // ── sidecar 格式解析 ──

    #[test]
    fn sidecar_parse_reads_first_token() {
        let dir = tmp_dir("sidecar");
        let zip = dir.join("x.zip");
        fs::write(&zip, b"data").unwrap();
        write_checksum_sidecar(&zip, "ABCDEF1234").unwrap();
        assert_eq!(
            parse_sidecar_checksum(&zip).as_deref(),
            Some("abcdef1234"),
            "首 token 且小写归一"
        );
        assert_eq!(parse_sidecar_checksum(&dir.join("ghost.zip")), None);
    }

    // ── reason 清洗 ──

    #[test]
    fn sanitize_reason_normalizes_unsafe_chars() {
        assert_eq!(sanitize_reason("pre-supersede"), "pre-supersede");
        assert_eq!(sanitize_reason("a b/c\\d:e*?"), "a-b-c-d-e-");
        assert_eq!(sanitize_reason("///"), "unspecified");
    }
}
