// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! T34c 项目级一键备份/恢复/导出（蓝图 T34c / TASK-P6-34c）。
//!
//! 与既有「全局导出备份」（`commands/backup.rs`，打包所有项目配置 + app-state）
//! 严格区分：本模块是**单项目**备份，包内容 = `.novel/status.json`（会话状态
//! 唯一真源）+ `.novel/drafts/`（草稿工件）+ `.niko-buddy/lancedb/`（Canon 三表
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
//!   `canon/commands.rs` 的每项目写锁串行化，桌面单用户场景下目录拷贝即为一致
//!   性快照；目录内含全部 lance 版本历史，恢复即回滚到快照时点。运行期若 canon
//!   store 句柄未关闭，Windows 上目录 swap 可能因占用失败——错误会如实上抛，
//!   由 UI 提示重试（残余风险已文档化）。
//!
//! ## 依赖边界
//!   仅复用已装依赖：`zip` 2（含 aes-crypto）、`sha2`、`walkdir`、`chrono`、
//!   `serde_json`。零新依赖。核心逻辑与 `#[tauri::command]` 分离，`cargo test`
//!   直测。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use zip::{AesMode, ZipArchive, ZipWriter};

use crate::canon::commands::CanonCommandState;
use crate::commands::backup::BackupProgressPayload;
use crate::panic_guard::run_guarded;

// M4-1：文件底层原语已剥离至 `export_fs.rs`——fs_archive 模式：新文件 + 原文件 re-export，外部 import 面零变化。
pub(crate) use super::export_fs::{
    assert_no_symlink_in_ancestors, base_opts, compute_content_digest_from_disk, copy_and_hash,
    enumerate_entries, err_ctx, hex, is_symlink_or_reparse_point, normalize_pass, now_stamp,
    read_entry_bytes, safe_staging_target, sanitize_reason, sidecar_path, staged_roots,
    stream_file_sha256, unique_suffix, ComponentRoots, BACKUP_CANCELLED_ERR, DRAFTS_PREFIX,
    DRAFTS_REL, LANCEDB_PREFIX, LANCEDB_REL, LEGACY_WIKI_REL, MAX_ARCHIVE_ENTRIES,
    MAX_ENTRY_UNCOMPRESSED_BYTES, MAX_MANIFEST_ENTRY_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES,
    QM_DRAFTS_PREFIX, QM_DRAFTS_REL, QM_REL, ROOT_DOCS_PREFIX, ROOT_DOC_WHITELIST,
    SNAPSHOTS_PREFIX, SNAPSHOTS_REL, STATUS_PREFIX, STATUS_REL, WIKI_PREFIX,
};

// ──────────────────────────────────────────────────────────────────────────
// 常量（zip 布局 + 项目相对路径）
// ──────────────────────────────────────────────────────────────────────────

/// manifest 条目名（zip 内）。
const MANIFEST_ENTRY: &str = "manifest.json";

/// 自动备份落点：`{project}/backups/auto/`。
const AUTO_BACKUP_DIR: &str = "backups/auto";

/// 当前包格式版本（v2：P0-03 全量书稿 7 组件；校验/恢复兼容 1..=FORMAT_VERSION）。
pub const FORMAT_VERSION: u32 = 2;
/// manifest.kind 标识（防误导入全局备份等其他 zip）。
pub const MANIFEST_KIND: &str = "niko-buddy-project-backup";

/// 进程级操作互斥锁：export / restore / auto_backup 串行化，防止并发 swap。
static OP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn op_lock() -> &'static tokio::sync::Mutex<()> {
    OP_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 单项目备份取消标志（契约 3：由 `commands::backup::cancel_backup` 联动触发）。
static CANON_EXPORT_CANCEL: AtomicBool = AtomicBool::new(false);

/// 请求取消正在进行的单项目备份/自动备份。
pub fn request_cancel() {
    CANON_EXPORT_CANCEL.store(true, Ordering::SeqCst);
}

/// 重置单项目备份取消标志（持 `OP_LOCK` 后启动新任务前调用）。
pub fn reset_cancel() {
    CANON_EXPORT_CANCEL.store(false, Ordering::SeqCst);
}

/// 仅测试用读写锁：防止全局 `request_cancel()` 测试与并行单元测试串扰。
#[cfg(test)]
static CANCEL_TEST_RWLOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());

/// ③-3 审计补齐：canon 导出/恢复进度事件。
///
/// 复用既有 `backup-progress` 事件名与 `BackupProgressPayload` 形态
/// （backup.rs 已确认：`{operation, stage, current, total, message}`，
/// camelCase），以 `operation` 区分 canon_export / canon_restore，前端进度条
/// 无需新监听器。`app` 为 `None`（纯逻辑/测试）时不发事件。
fn emit_canon_progress(
    app: Option<&AppHandle>,
    operation: &str,
    stage: &str,
    current: usize,
    total: usize,
    message: &str,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "backup-progress",
            BackupProgressPayload {
                operation: operation.into(),
                stage: stage.into(),
                current,
                total,
                message: message.into(),
            },
        );
    }
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

/// 备份包内各组件文件计数（契约 4：camelCase 序列化，`canonLancedb` 小写 d 与既有字段一致）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonBackupComponentCounts {
    pub status: u64,
    pub drafts: u64,
    pub qm_drafts: u64,
    pub canon_lancedb: u64,
    pub wiki: u64,
    pub snapshots: u64,
    pub root_docs: u64,
}

/// `canon_restore_project` 出参。
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// v2 新增：恢复包的 manifest 格式版本（校验失败时为 0）。
    #[serde(default)]
    pub format_version: u32,
    /// v2 新增：是否恢复了知识库/正文目录（QM/ 或 wiki/）。
    #[serde(default)]
    pub restored_wiki: bool,
    /// v2 新增：是否恢复了时光机快照目录（.novel/snapshots/）。
    #[serde(default)]
    pub restored_snapshots: bool,
    /// v2 新增：是否恢复了章节草稿箱（.qm-drafts/）。
    #[serde(default)]
    pub restored_qm_drafts: bool,
    /// v2 新增：是否恢复了顶层白名单书魂文档（soul.md/schema.md/purpose.md）。
    #[serde(default)]
    pub restored_root_docs: bool,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// v2 新增：manifest 格式版本（校验失败/缺 manifest 时为 0）。
    #[serde(default)]
    pub format_version: u32,
    /// v2 新增：各组件文件计数。
    #[serde(default)]
    pub component_counts: CanonBackupComponentCounts,
    /// v2 新增：备份创建时间（manifest.created_at）。
    #[serde(default)]
    pub created_at: Option<String>,
    /// v2 新增：备份项目名称（manifest.project_name）。
    #[serde(default)]
    pub project_name: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ManifestComponents {
    #[serde(default)]
    status: bool,
    #[serde(default)]
    drafts: bool,
    #[serde(default)]
    canon_lancedb: bool,
    #[serde(default)]
    wiki: bool,
    #[serde(default)]
    snapshots: bool,
    #[serde(default)]
    qm_drafts: bool,
    #[serde(default)]
    root_docs: bool,
}

// ──────────────────────────────────────────────────────────────────────────
// TASK-004 薄适配：向块寻址原语（canon::archive）暴露单项目根
//
// 本模块的容器层 / 内容层二层校验面向 **zip 容器**（.sha256 sidecar + 包内
// manifest）；`canon::archive` 的块集合层指纹面向 **非 zip 场景**（F-002 技能包
// 与 F-004 远端块）。两者层次不同、不互为替代。以下适配只做转发，**既有导出
// 路径行为零改动**（向后兼容）。
// ──────────────────────────────────────────────────────────────────────────

/// 薄适配（TASK-004）：把单项目根映射到 [`crate::canon::archive`] 的块寻址原语。
///
/// 使 F-002（技能包）与 F-004（远端块）复用**同一** manifest 定义（INV-7：
/// 一次落地多处受益）。本函数不改变 `pack_project` / `canon_verify_export` /
/// `.sha256` sidecar 的任何既有语义。
/// 目前唯一调用点在测试内，故限定测试 cfg。
#[cfg(test)]
pub fn archive_manifest_for_project(
    project_path: &Path,
) -> Result<crate::canon::archive::ArchiveManifest, String> {
    crate::canon::archive::build_manifest(project_path)
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

/// 清理半成品备份 zip 与对应 `.sha256` sidecar（必须在释放 zip 文件句柄之后调用，防 Windows 句柄占用）。
fn cleanup_partial_backup(output_zip: &Path) {
    let _ = fs::remove_file(output_zip);
    let _ = fs::remove_file(sidecar_path(output_zip));
}

/// 统计条目中 7 个组件各自包含的文件数。
fn count_entries_by_component(entries: &[(String, PathBuf)]) -> CanonBackupComponentCounts {
    let mut counts = CanonBackupComponentCounts::default();
    for (name, _) in entries {
        if name.starts_with(STATUS_PREFIX) {
            counts.status += 1;
        } else if name.starts_with(DRAFTS_PREFIX) {
            counts.drafts += 1;
        } else if name.starts_with(QM_DRAFTS_PREFIX) {
            counts.qm_drafts += 1;
        } else if name.starts_with(LANCEDB_PREFIX) {
            counts.canon_lancedb += 1;
        } else if name.starts_with(WIKI_PREFIX) {
            counts.wiki += 1;
        } else if name.starts_with(SNAPSHOTS_PREFIX) {
            counts.snapshots += 1;
        } else if name.starts_with(ROOT_DOCS_PREFIX) {
            counts.root_docs += 1;
        }
    }
    counts
}

/// 把项目全量 7 组件打成 v2 zip + 写 `.sha256` sidecar（支持 64 KiB 粒度轮询取消并清理半成品）。
///
/// 被 export / restore 前置自动备份 / auto_backup 三方复用。
fn pack_project_with_cancel(
    app: Option<&AppHandle>,
    operation: &str,
    project_path: &Path,
    output_zip: &Path,
    passphrase: Option<&str>,
    project_name: &str,
    cancel: Option<&AtomicBool>,
) -> Result<PackOutcome, String> {
    let is_cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::SeqCst));
    if is_cancelled() {
        cleanup_partial_backup(output_zip);
        return Err(BACKUP_CANCELLED_ERR.to_string());
    }
    if is_symlink_or_reparse_point(project_path) {
        return Err(format!(
            "安全拦截：项目根目录 {} 为符号链接或重解析点",
            project_path.display()
        ));
    }
    if is_symlink_or_reparse_point(output_zip)
        || is_symlink_or_reparse_point(&sidecar_path(output_zip))
    {
        return Err(format!(
            "安全拦截：输出路径 {} 或其 sidecar 为符号链接/重解析点",
            output_zip.display()
        ));
    }

    let roots = ComponentRoots::from_project(project_path);

    let mut warnings = Vec::new();
    let has_status = roots.status.is_some();
    let has_drafts = roots.drafts.is_some();
    let has_lancedb = roots.lancedb.is_some();
    let has_wiki = roots.wiki.is_some();
    let has_snapshots = roots.snapshots.is_some();
    let has_qm_drafts = roots.qm_drafts.is_some();
    let has_root_docs = !roots.root_docs.is_empty();

    if !has_status {
        warnings.push(format!(
            "缺少 {STATUS_REL}（尚未生成会话状态？），包内将不含 status"
        ));
    }
    if !has_drafts {
        warnings.push(format!("缺少 {DRAFTS_REL}，包内不含草稿目录"));
    }
    if !has_lancedb {
        warnings.push(format!("缺少 {LANCEDB_REL}，包内不含 Canon LanceDB 快照"));
    }

    let entries = enumerate_entries(&roots);

    // 将 ZipWriter 作用域收敛在块内，确保取消或出错时先关闭文件句柄再删除半成品（Windows 必需）。
    let pack_res: Result<u64, String> = (|| {
        let file = fs::File::create(output_zip).map_err(|e| {
            err_ctx(
                format!("无法创建备份文件 {}", output_zip.display()).as_str(),
                e,
            )
        })?;
        let mut zip = ZipWriter::new(file);

        // 有口令 → 所有条目 AES-256；无口令 → Deflated 明文。
        let pass_owned: Option<String> = passphrase.map(str::to_string);
        let opts = match pass_owned.as_deref() {
            Some(p) => base_opts().with_aes_encryption(AesMode::Aes256, p),
            None => base_opts(),
        };

        // 1) 数据条目（单遍流式：写 zip + per-file sha256，每 64 KiB 轮询取消）
        let mut digest = Sha256::new();
        let mut packed: u64 = 0;
        for (name, path) in &entries {
            if is_cancelled() {
                return Err(BACKUP_CANCELLED_ERR.to_string());
            }
            let mut src = fs::File::open(path)
                .map_err(|e| err_ctx(format!("打开 {} 失败", path.display()).as_str(), e))?;
            zip.start_file(name, opts)
                .map_err(|e| err_ctx(format!("创建 zip 条目 {name} 失败").as_str(), e))?;
            let (len, file_hex) = copy_and_hash(&mut src, &mut zip, cancel)?;
            // 内容摘要记录（pack/verify 两端共享此格式）
            digest.update(name.as_bytes());
            digest.update(b"\0");
            digest.update(len.to_le_bytes());
            digest.update(b"\0");
            digest.update(file_hex.as_bytes());
            digest.update(b"\n");
            packed += 1;
            // ③-3：打包进度（current=已打包条目数, total=条目总数, message=条目名）。
            emit_canon_progress(app, operation, "pack", packed as usize, entries.len(), name);
        }

        if is_cancelled() {
            return Err(BACKUP_CANCELLED_ERR.to_string());
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
                wiki: has_wiki,
                snapshots: has_snapshots,
                qm_drafts: has_qm_drafts,
                root_docs: has_root_docs,
            },
            file_count: packed,
            content_sha256: hex(&digest.finalize()),
        };
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| err_ctx("序列化 manifest 失败", e))?;
        zip.start_file(MANIFEST_ENTRY, opts)
            .map_err(|e| err_ctx("写入 manifest 失败", e))?;
        zip.write_all(manifest_json.as_bytes())
            .map_err(|e| err_ctx("写入 manifest 失败", e))?;
        zip.finish().map_err(|e| err_ctx("完成 zip 写入失败", e))?;
        Ok(packed)
    })();

    let packed = match pack_res {
        Ok(n) => n,
        Err(e) => {
            cleanup_partial_backup(output_zip);
            return Err(e);
        }
    };

    if is_cancelled() {
        cleanup_partial_backup(output_zip);
        return Err(BACKUP_CANCELLED_ERR.to_string());
    }

    // 3) 容器 SHA-256 + sidecar
    let checksum_hex = match stream_file_sha256(output_zip) {
        Ok(h) => h,
        Err(e) => {
            cleanup_partial_backup(output_zip);
            return Err(e);
        }
    };
    if let Err(e) = write_checksum_sidecar(output_zip, &checksum_hex) {
        cleanup_partial_backup(output_zip);
        return Err(e);
    }
    if is_cancelled() {
        cleanup_partial_backup(output_zip);
        return Err(BACKUP_CANCELLED_ERR.to_string());
    }
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

/// 写标准 `sha256sum` 行格式：`<hex>  <filename>`。
///
/// TASK-005 技能包复用同一 sidecar 范式（`<bundle>.sha256` 存 manifest sha256）。
pub(crate) fn write_checksum_sidecar(
    zip_path: &Path,
    checksum_hex: &str,
) -> Result<PathBuf, String> {
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
pub(crate) fn parse_sidecar_checksum(zip_path: &Path) -> Option<String> {
    let text = fs::read_to_string(sidecar_path(zip_path)).ok()?;
    text.split_whitespace().next().map(str::to_lowercase)
}

// ──────────────────────────────────────────────────────────────────────────
// 解包 / 校验核心
// ──────────────────────────────────────────────────────────────────────────

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

/// 校验后的 staging 结果。
struct StagedArchive {
    manifest: ProjectBackupManifest,
    staged_files: u64,
    component_counts: CanonBackupComponentCounts,
    /// 容器层 SHA-256 校验和比对结果（None = 无期望值且无 sidecar，如实透传）。
    container_checksum_verified: Option<bool>,
}

#[derive(Clone, Copy)]
struct StageArchiveParams<'a> {
    app: Option<&'a AppHandle>,
    operation: &'a str,
    zip_path: &'a Path,
    staging_root: &'a Path,
    expected_checksum: Option<&'a str>,
    passphrase: Option<&'a str>,
}

/// 公共前置流程：开 zip → 容器校验和 → 条目数与解压体积护栏 → 读 manifest →
/// 全量解压到 staging → 内容层摘要复核。任何一层不过即 Err（restore / verify 共用）。
fn stage_verified_archive(
    params: &StageArchiveParams<'_>,
    warnings: &mut Vec<String>,
    container_verified_out: &mut Option<bool>,
) -> Result<StagedArchive, String> {
    let StageArchiveParams {
        app,
        operation,
        zip_path,
        staging_root,
        expected_checksum,
        passphrase,
    } = *params;
    if !zip_path.is_file() {
        return Err(format!("备份文件不存在: {}", zip_path.display()));
    }

    // ── 容器层校验和 ──
    let (container_match, _computed_hex) = compare_container_checksum(zip_path, expected_checksum)?;
    *container_verified_out = container_match;
    match container_match {
        Some(true) => {}
        Some(false) => {
            return Err("SHA-256 校验和不匹配：备份文件可能已被篡改或损坏，已中止恢复".to_string())
        }
        None => warnings.push(
            "无法找到 .sha256 校验和文件且未提供期望值，将仅依赖包内内容摘要校验".to_string(),
        ),
    }

    // ── 开包 + 条目数上限 + manifest ──
    let file = fs::File::open(zip_path).map_err(|e| err_ctx("打开备份文件失败", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| err_ctx("读取备份文件失败，可能已损坏", e))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "安全拦截：zip 条目总数 {} 超过上限 {MAX_ARCHIVE_ENTRIES}",
            archive.len()
        ));
    }

    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    let manifest_index = names
        .iter()
        .position(|n| n == MANIFEST_ENTRY)
        .ok_or_else(|| {
            "缺少 manifest.json：不是有效的项目备份包（注意：全局备份请走设置页数据管理）"
                .to_string()
        })?;

    let mut total_uncompressed: u64 = 0;
    let manifest_bytes = read_entry_bytes(
        &mut archive,
        manifest_index,
        passphrase,
        MAX_MANIFEST_ENTRY_BYTES,
        &mut total_uncompressed,
        MAX_TOTAL_UNCOMPRESSED_BYTES,
    )?;
    let manifest: ProjectBackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| err_ctx("解析 manifest.json 失败", e))?;
    if manifest.kind != MANIFEST_KIND {
        return Err(format!(
            "备份类型不符：期望 \"{MANIFEST_KIND}\"，实际 \"{}\"",
            manifest.kind
        ));
    }
    if manifest.format_version == 0 {
        return Err("备份格式版本无效（0）".to_string());
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(format!(
            "备份格式版本 {} 高于当前支持版本 {FORMAT_VERSION}，请升级应用后再恢复",
            manifest.format_version
        ));
    }

    // ── 全量解压到 staging（Zip-Slip + zip 炸弹防护；未知前缀跳过并警告）──
    fs::create_dir_all(staging_root).map_err(|e| err_ctx("创建暂存目录失败", e))?;
    let staging_canonical = staging_root
        .canonicalize()
        .map_err(|e| err_ctx("解析暂存目录失败", e))?;

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
            fs::create_dir_all(parent)
                .map_err(|e| err_ctx(format!("创建目录 {} 失败", parent.display()).as_str(), e))?;
        }
        let data = read_entry_bytes(
            &mut archive,
            index,
            passphrase,
            MAX_ENTRY_UNCOMPRESSED_BYTES,
            &mut total_uncompressed,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        )?;
        fs::write(&target, &data).map_err(|e| {
            err_ctx(
                format!("写入暂存文件 {} 失败", target.display()).as_str(),
                e,
            )
        })?;
        staged_files += 1;
        // ③-3：解压进度（current=已解压文件数, total=包内条目数, message=条目名）。
        emit_canon_progress(
            app,
            operation,
            "extract",
            staged_files as usize,
            names.len(),
            name,
        );
    }

    // ── 内容层摘要复核（从磁盘重算）──
    let roots = staged_roots(staging_root);
    let entries = enumerate_entries(&roots);
    let component_counts = count_entries_by_component(&entries);
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
        component_counts,
        container_checksum_verified: container_match,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// 两阶段原子替换与逆序回滚（M2-04 + P0-03 7 组件全覆盖）
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoreComponentKind {
    Status,
    Drafts,
    CanonLanceDb,
    Wiki,
    Snapshots,
    QmDrafts,
    RootDoc(&'static str),
}

impl RestoreComponentKind {
    fn label(self) -> &'static str {
        match self {
            Self::Status => "status.json",
            Self::Drafts => "drafts",
            Self::CanonLanceDb => "canon-lancedb",
            Self::Wiki => "wiki",
            Self::Snapshots => "snapshots",
            Self::QmDrafts => "qm-drafts",
            Self::RootDoc(name) => name,
        }
    }

    fn is_dir(self) -> bool {
        matches!(
            self,
            Self::Drafts | Self::CanonLanceDb | Self::Wiki | Self::Snapshots | Self::QmDrafts
        )
    }
}

struct SwappedComponent {
    kind: RestoreComponentKind,
    staged: PathBuf,
    current: PathBuf,
    aside: PathBuf,
    existed_before: bool,
}

#[derive(Debug, Clone, Default)]
struct ReplaceOutcome {
    restored_status: bool,
    restored_drafts: bool,
    restored_canon_lancedb: bool,
    restored_wiki: bool,
    restored_snapshots: bool,
    restored_qm_drafts: bool,
    restored_root_docs: bool,
    error: Option<String>,
}

/// BLOCKING-1 铁律：v2 恢复 `wiki/` 时优先替换现存 `{project}/QM`，
/// 否则若 `{project}/wiki` 存在则替换 `wiki/`，两者皆无默认写 `{project}/QM`。
fn resolve_wiki_restore_target(project: &Path) -> Result<PathBuf, String> {
    let qm = project.join(QM_REL);
    if is_symlink_or_reparse_point(&qm) {
        return Err(format!(
            "安全拦截：恢复目标 {} 为符号链接或重解析点，已中止恢复",
            qm.display()
        ));
    }
    if qm.exists() {
        return Ok(qm);
    }
    let legacy = project.join(LEGACY_WIKI_REL);
    if is_symlink_or_reparse_point(&legacy) {
        return Err(format!(
            "安全拦截：恢复目标 {} 为符号链接或重解析点，已中止恢复",
            legacy.display()
        ));
    }
    if legacy.exists() {
        return Ok(legacy);
    }
    Ok(qm)
}

/// 两阶段组件换位（可注入 `rename_fn` 测试半程失败与二次回滚失败）：
/// - v1 兼容：仅对 `manifest.components.* == true` 的组件加入换位计划，绝不触碰为 `false` 的既有目录/文件；
/// - 阶段 1：按 `status → drafts → canon-lancedb → wiki → snapshots → qm-drafts → root-docs(逐文件)`
///   顺序移开旧目标至 `.t34c-old-*` 并就位新目标（暂不删除旧副本）；
/// - 阶段 2A（全部成功）：清理 `.t34c-old-*` 旧副本；
/// - 阶段 2B（任一步失败）：对已换位组件（含逐个 `root-docs` 文件）按逆序回滚并如实回报 `restored_*`。
fn replace_staged_components_with_rename<F>(
    components: &ManifestComponents,
    staging: &Path,
    project: &Path,
    backups_root: &Path,
    stamp: &str,
    warnings: &mut Vec<String>,
    mut rename_fn: F,
) -> ReplaceOutcome
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    // BLOCKING-R2-02：在构建计划或创建目录前，先确认项目根与 backups_root 及其祖先链不含符号链接/重解析点。
    if is_symlink_or_reparse_point(project) {
        return ReplaceOutcome {
            error: Some(format!(
                "安全拦截：项目根目录 {} 为符号链接或重解析点，已中止替换",
                project.display()
            )),
            ..Default::default()
        };
    }
    if is_symlink_or_reparse_point(backups_root)
        || assert_no_symlink_in_ancestors(project, backups_root).is_err()
    {
        return ReplaceOutcome {
            error: Some(format!(
                "安全拦截：备份暂存根目录 {} 或其祖先链含符号链接或重解析点，已中止替换",
                backups_root.display()
            )),
            ..Default::default()
        };
    }

    let mut plan: Vec<(RestoreComponentKind, PathBuf, PathBuf, PathBuf)> = Vec::new();
    if components.status {
        plan.push((
            RestoreComponentKind::Status,
            staging.join("status").join("status.json"),
            project.join(STATUS_REL),
            backups_root.join(format!(".t34c-old-status-{stamp}.json")),
        ));
    }
    if components.drafts {
        plan.push((
            RestoreComponentKind::Drafts,
            staging.join("drafts"),
            project.join(DRAFTS_REL),
            backups_root.join(format!(".t34c-old-drafts-{stamp}")),
        ));
    }
    if components.canon_lancedb {
        plan.push((
            RestoreComponentKind::CanonLanceDb,
            staging.join("canon-lancedb"),
            project.join(LANCEDB_REL),
            backups_root.join(format!(".t34c-old-lancedb-{stamp}")),
        ));
    }
    if components.wiki {
        match resolve_wiki_restore_target(project) {
            Ok(wiki_target) => plan.push((
                RestoreComponentKind::Wiki,
                staging.join("wiki"),
                wiki_target,
                backups_root.join(format!(".t34c-old-wiki-{stamp}")),
            )),
            Err(e) => {
                return ReplaceOutcome {
                    error: Some(e),
                    ..Default::default()
                };
            }
        }
    }
    if components.snapshots {
        plan.push((
            RestoreComponentKind::Snapshots,
            staging.join("snapshots"),
            project.join(SNAPSHOTS_REL),
            backups_root.join(format!(".t34c-old-snapshots-{stamp}")),
        ));
    }
    if components.qm_drafts {
        plan.push((
            RestoreComponentKind::QmDrafts,
            staging.join("qm-drafts"),
            project.join(QM_DRAFTS_REL),
            backups_root.join(format!(".t34c-old-qm-drafts-{stamp}")),
        ));
    }
    if components.root_docs {
        let mut sorted_whitelist = ROOT_DOC_WHITELIST;
        sorted_whitelist.sort();
        let mut found_any_root_doc = false;
        for name in sorted_whitelist {
            let staged_doc = staging.join("root-docs").join(name);
            if staged_doc.is_file() {
                found_any_root_doc = true;
                plan.push((
                    RestoreComponentKind::RootDoc(name),
                    staged_doc,
                    project.join(name),
                    backups_root.join(format!(".t34c-old-rootdoc-{name}-{stamp}")),
                ));
            }
        }
        if !found_any_root_doc {
            return ReplaceOutcome {
                error: Some(format!(
                    "暂存目录缺少组件 root-docs 白名单文件 ({})，已中止替换",
                    staging.join("root-docs").display()
                )),
                ..Default::default()
            };
        }
    }

    if plan.is_empty() {
        return ReplaceOutcome::default();
    }

    // ── 预检与空目录物化（动真身前完成，校验整条祖先链无 symlink/junction，避免 ENOENT 或半程换位）──
    for (kind, staged, current, aside) in &plan {
        if let Err(e) = assert_no_symlink_in_ancestors(project, current) {
            return ReplaceOutcome {
                error: Some(format!(
                    "安全拦截：目标 {} ({}) 或其祖先链含符号链接或重解析点，已中止替换 ({e})",
                    kind.label(),
                    current.display()
                )),
                ..Default::default()
            };
        }
        if let Err(e) = assert_no_symlink_in_ancestors(project, aside) {
            return ReplaceOutcome {
                error: Some(format!(
                    "安全拦截：备份回退路径 {} ({}) 或其祖先链含符号链接或重解析点，已中止替换 ({e})",
                    kind.label(),
                    aside.display()
                )),
                ..Default::default()
            };
        }
        if kind.is_dir() {
            if !staged.exists() {
                if let Err(e) = fs::create_dir_all(staged) {
                    return ReplaceOutcome {
                        error: Some(err_ctx(
                            format!(
                                "为空目录组件 {} 创建暂存目录 {} 失败",
                                kind.label(),
                                staged.display()
                            )
                            .as_str(),
                            e,
                        )),
                        ..Default::default()
                    };
                }
            }
        } else if !staged.is_file() {
            return ReplaceOutcome {
                error: Some(format!(
                    "暂存目录缺少组件 {} 文件 ({})，已中止替换",
                    kind.label(),
                    staged.display()
                )),
                ..Default::default()
            };
        }
    }

    if let Err(e) = fs::create_dir_all(backups_root) {
        return ReplaceOutcome {
            error: Some(err_ctx("创建备份暂存根目录失败", e)),
            ..Default::default()
        };
    }

    // ── 阶段 1：顺序移开旧目标并就位新目标（暂留 .t34c-old-*）──
    let mut swapped: Vec<SwappedComponent> = Vec::new();
    let mut phase1_err: Option<String> = None;
    let mut rollback_failures: Vec<String> = Vec::new();

    for (kind, staged, current, aside) in plan {
        if let Some(parent) = current.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                phase1_err = Some(err_ctx(
                    format!("创建目标父目录 {} 失败", parent.display()).as_str(),
                    e,
                ));
                break;
            }
        }
        let existed_before = current.exists();
        if existed_before {
            if let Err(e) = rename_fn(&current, &aside) {
                phase1_err = Some(err_ctx(
                    format!(
                        "移开现有 {} ({}) 失败（可能被其他进程占用）",
                        kind.label(),
                        current.display()
                    )
                    .as_str(),
                    e,
                ));
                break;
            }
        }
        if let Err(e) = rename_fn(&staged, &current) {
            if existed_before {
                if let Err(rb_err) = rename_fn(&aside, &current) {
                    let msg = format!(
                        "恢复 {} 原副本失败（旧副本保留在 {}）: {rb_err}",
                        kind.label(),
                        aside.display()
                    );
                    warnings.push(msg.clone());
                    rollback_failures.push(msg);
                }
            }
            phase1_err = Some(err_ctx(
                format!("就位新 {} ({}) 失败", kind.label(), current.display()).as_str(),
                e,
            ));
            break;
        }
        swapped.push(SwappedComponent {
            kind,
            staged,
            current,
            aside,
            existed_before,
        });
    }

    // ── 阶段 2A：全部成功 → 清理 .t34c-old-* 旧副本 ──
    if phase1_err.is_none() {
        let mut outcome = ReplaceOutcome::default();
        for sc in &swapped {
            match sc.kind {
                RestoreComponentKind::Status => outcome.restored_status = true,
                RestoreComponentKind::Drafts => outcome.restored_drafts = true,
                RestoreComponentKind::CanonLanceDb => outcome.restored_canon_lancedb = true,
                RestoreComponentKind::Wiki => outcome.restored_wiki = true,
                RestoreComponentKind::Snapshots => outcome.restored_snapshots = true,
                RestoreComponentKind::QmDrafts => outcome.restored_qm_drafts = true,
                RestoreComponentKind::RootDoc(_) => outcome.restored_root_docs = true,
            }
            if sc.existed_before && sc.aside.exists() {
                let rm_res = if sc.kind.is_dir() {
                    fs::remove_dir_all(&sc.aside)
                } else {
                    fs::remove_file(&sc.aside)
                };
                if let Err(e) = rm_res {
                    warnings.push(format!(
                        "清理旧副本 {} 失败（不影响恢复结果）: {e}",
                        sc.aside.display()
                    ));
                }
            }
        }
        return outcome;
    }

    // ── 阶段 2B：任一失败 → 对已换位组件（含逐个 root-docs）逆序回滚并如实回报 restored_* ──
    let mut restored_status = swapped
        .iter()
        .any(|s| s.kind == RestoreComponentKind::Status);
    let mut restored_drafts = swapped
        .iter()
        .any(|s| s.kind == RestoreComponentKind::Drafts);
    let mut restored_canon_lancedb = swapped
        .iter()
        .any(|s| s.kind == RestoreComponentKind::CanonLanceDb);
    let mut restored_wiki = swapped.iter().any(|s| s.kind == RestoreComponentKind::Wiki);
    let mut restored_snapshots = swapped
        .iter()
        .any(|s| s.kind == RestoreComponentKind::Snapshots);
    let mut restored_qm_drafts = swapped
        .iter()
        .any(|s| s.kind == RestoreComponentKind::QmDrafts);
    let mut remaining_root_docs = swapped
        .iter()
        .filter(|s| matches!(s.kind, RestoreComponentKind::RootDoc(_)))
        .count();

    let had_swapped = !swapped.is_empty();
    for sc in swapped.into_iter().rev() {
        let rolled_back_cleanly = match rename_fn(&sc.current, &sc.staged) {
            Ok(()) => {
                if sc.existed_before {
                    match rename_fn(&sc.aside, &sc.current) {
                        Ok(()) => true,
                        Err(e) => {
                            let msg = format!(
                                "回滚 {} 失败（无法还原旧副本，旧副本保留在 {}）: {e}",
                                sc.kind.label(),
                                sc.aside.display()
                            );
                            warnings.push(msg.clone());
                            rollback_failures.push(msg);
                            false
                        }
                    }
                } else {
                    true
                }
            }
            Err(e) => {
                let msg = format!(
                    "回滚 {} 失败（无法移出新版本，旧副本保留在 {}）: {e}",
                    sc.kind.label(),
                    sc.aside.display()
                );
                warnings.push(msg.clone());
                rollback_failures.push(msg);
                false
            }
        };

        if rolled_back_cleanly {
            match sc.kind {
                RestoreComponentKind::Status => restored_status = false,
                RestoreComponentKind::Drafts => restored_drafts = false,
                RestoreComponentKind::CanonLanceDb => restored_canon_lancedb = false,
                RestoreComponentKind::Wiki => restored_wiki = false,
                RestoreComponentKind::Snapshots => restored_snapshots = false,
                RestoreComponentKind::QmDrafts => restored_qm_drafts = false,
                RestoreComponentKind::RootDoc(_) => {
                    remaining_root_docs = remaining_root_docs.saturating_sub(1);
                }
            }
        }
    }

    let primary_err = phase1_err.unwrap_or_else(|| "替换组件失败".to_string());
    let final_err = if !rollback_failures.is_empty() {
        format!(
            "{primary_err}；部分组件回滚失败: {}",
            rollback_failures.join("；")
        )
    } else if had_swapped {
        format!("{primary_err}（已逆序回滚先前的组件变更）")
    } else {
        primary_err
    };

    ReplaceOutcome {
        restored_status,
        restored_drafts,
        restored_canon_lancedb,
        restored_wiki,
        restored_snapshots,
        restored_qm_drafts,
        restored_root_docs: remaining_root_docs > 0,
        error: Some(final_err),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 三个业务入口（Tauri 无关，供命令与测试直接调用）
// ──────────────────────────────────────────────────────────────────────────

/// 导出项目备份包（③-3：可选进度回调，command 包装层传入 AppHandle；
/// 测试/纯逻辑调用传 `None` 不发进度事件）。
pub fn export_project_impl_with_progress(
    request: &CanonExportRequest,
    app: Option<&AppHandle>,
) -> Result<CanonExportResult, String> {
    #[cfg(test)]
    let _cancel_read = CANCEL_TEST_RWLOCK.read().unwrap_or_else(|e| e.into_inner());
    export_project_impl_with_cancel(request, app, Some(&CANON_EXPORT_CANCEL))
}

fn export_project_impl_with_cancel(
    request: &CanonExportRequest,
    app: Option<&AppHandle>,
    cancel: Option<&AtomicBool>,
) -> Result<CanonExportResult, String> {
    let project = Path::new(&request.project_path);
    if is_symlink_or_reparse_point(project) {
        return Ok(failed_export(format!(
            "安全拦截：项目根目录 {} 为符号链接或重解析点",
            request.project_path
        )));
    }
    if !project.is_dir() {
        return Ok(failed_export(format!(
            "项目目录不存在: {}",
            request.project_path
        )));
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

    let outcome = match pack_project_with_cancel(
        app,
        "canon_export",
        project,
        output,
        pass.as_deref(),
        &project_name,
        cancel,
    ) {
        Ok(o) => o,
        Err(e) if e == BACKUP_CANCELLED_ERR => {
            return Ok(failed_export(BACKUP_CANCELLED_ERR.to_string()));
        }
        Err(e) => return Err(e),
    };

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
            format_version: 0,
            component_counts: CanonBackupComponentCounts::default(),
            created_at: None,
            project_name: None,
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
            format_version: 0,
            component_counts: CanonBackupComponentCounts::default(),
            created_at: None,
            project_name: None,
        });
    }

    let staging = std::env::temp_dir().join(format!("t34c-verify-{}", unique_suffix()));
    let mut staged_container_verified = container_match;
    let staged = stage_verified_archive(
        &StageArchiveParams {
            app: None,
            operation: "canon_verify",
            zip_path,
            staging_root: &staging,
            expected_checksum: request.expected_checksum.as_deref(),
            passphrase: pass.as_deref(),
        },
        &mut warnings,
        &mut staged_container_verified,
    );
    let _ = fs::remove_dir_all(&staging);

    match staged {
        Ok(s) => Ok(CanonVerifyResult {
            success: true,
            container_checksum_matches: s.container_checksum_verified,
            computed_checksum: Some(computed),
            manifest_found: true,
            file_count: s.manifest.file_count,
            content_digest_verified: true,
            warnings,
            error: None,
            format_version: s.manifest.format_version,
            component_counts: s.component_counts,
            created_at: Some(s.manifest.created_at),
            project_name: Some(s.manifest.project_name),
        }),
        Err(e) => Ok(CanonVerifyResult {
            success: false,
            container_checksum_matches: staged_container_verified,
            computed_checksum: Some(computed),
            manifest_found: false,
            file_count: 0,
            content_digest_verified: false,
            warnings,
            error: Some(e),
            format_version: 0,
            component_counts: CanonBackupComponentCounts::default(),
            created_at: None,
            project_name: None,
        }),
    }
}

/// 恢复：校验 → 自动备份现状 → staging → 两阶段原子替换（失败逆序回滚）。
/// 恢复项目备份包（③-3：可选进度回调，command 包装层传入 AppHandle；
/// 测试/纯逻辑调用传 `None` 不发进度事件）。
pub fn restore_project_impl_with_progress(
    request: &CanonRestoreRequest,
    app: Option<&AppHandle>,
) -> Result<CanonRestoreResult, String> {
    let project = Path::new(&request.project_path);
    let zip_path = Path::new(&request.zip_path);
    let pass = normalize_pass(&request.passphrase);
    let mut warnings = Vec::new();

    // ── 1. 校验 + 解压 staging ──
    let stamp = unique_suffix();
    let backups_root = project.join("backups");
    let staging = backups_root.join(format!(".t34c-staging-{stamp}"));
    let auto_dir = project.join(AUTO_BACKUP_DIR);

    // BLOCKING-R2-02：在解压 staging、自动备份或换位前校验 project、backups_root、staging、auto_dir 及其祖先链。
    if is_symlink_or_reparse_point(project) {
        return Ok(failed_restore(
            format!(
                "安全拦截：项目根目录 {} 为符号链接或重解析点，已中止恢复",
                project.display()
            ),
            None,
            None,
            warnings,
            0,
        ));
    }
    for (label, path) in [
        ("backups 根目录", backups_root.as_path()),
        ("staging 目录", staging.as_path()),
        ("自动备份目录", auto_dir.as_path()),
    ] {
        if is_symlink_or_reparse_point(path)
            || assert_no_symlink_in_ancestors(project, path).is_err()
        {
            return Ok(failed_restore(
                format!(
                    "安全拦截：{label} ({}) 或其祖先链含符号链接或重解析点，已中止恢复",
                    path.display()
                ),
                None,
                None,
                warnings,
                0,
            ));
        }
    }

    let mut container_verified: Option<bool> = None;
    let staged = match stage_verified_archive(
        &StageArchiveParams {
            app,
            operation: "canon_restore",
            zip_path,
            staging_root: &staging,
            expected_checksum: request.expected_checksum.as_deref(),
            passphrase: pass.as_deref(),
        },
        &mut warnings,
        &mut container_verified,
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Ok(failed_restore(e, container_verified, None, warnings, 0));
        }
    };
    let manifest_version = staged.manifest.format_version;

    // ── 2. 替换前自动备份（supersede 保护，覆盖全部 7 组件）──
    let mut auto_backup_path: Option<String> = None;
    let has_current_state = ComponentRoots::from_project(project).has_any();
    if has_current_state {
        if let Err(e) = assert_no_symlink_in_ancestors(project, &auto_dir) {
            let _ = fs::remove_dir_all(&staging);
            return Ok(failed_restore(
                format!(
                    "安全拦截：自动备份目录 ({}) 或其祖先链含符号链接或重解析点，已中止恢复 ({e})",
                    auto_dir.display()
                ),
                staged.container_checksum_verified,
                None,
                warnings,
                manifest_version,
            ));
        }
        fs::create_dir_all(&auto_dir).map_err(|e| err_ctx("创建自动备份目录失败", e))?;
        let auto_zip = auto_dir.join(format!("pre-restore-{}.zip", stamp));
        let current_name = project
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string());
        match pack_project_with_cancel(
            app,
            "canon_restore",
            project,
            &auto_zip,
            None,
            &current_name,
            None,
        ) {
            Ok(outcome) => {
                auto_backup_path = Some(auto_zip.to_string_lossy().to_string());
                warnings.extend(
                    outcome
                        .warnings
                        .into_iter()
                        .map(|w| format!("[自动备份] {w}")),
                );
            }
            Err(e) => {
                // 数据安全原则：有现存状态但备份失败 → 不允许破坏性替换
                let _ = fs::remove_dir_all(&staging);
                return Ok(failed_restore(
                    format!("替换前自动备份失败，已中止恢复以保护现有数据: {e}"),
                    staged.container_checksum_verified,
                    None,
                    warnings,
                    manifest_version,
                ));
            }
        }
    } else {
        warnings.push("当前项目无可备份状态，跳过恢复前自动备份".to_string());
    }

    // ── 3. 两阶段原子替换（任一步失败 → 逆序回滚并如实回报每个 restored_* 状态）──
    let components = staged.manifest.components.clone();
    let staged_files = staged.staged_files;
    let replace_outcome = replace_staged_components_with_rename(
        &components,
        &staging,
        project,
        &backups_root,
        &stamp,
        &mut warnings,
        |from: &Path, to: &Path| fs::rename(from, to),
    );

    // ── 4. 清理 staging ──
    let _ = fs::remove_dir_all(&staging);

    if let Some(err) = replace_outcome.error {
        return Ok(CanonRestoreResult {
            success: false,
            restored_status: replace_outcome.restored_status,
            restored_drafts: replace_outcome.restored_drafts,
            restored_canon_lancedb: replace_outcome.restored_canon_lancedb,
            restored_files: 0,
            checksum_verified: staged.container_checksum_verified,
            auto_backup_path,
            warnings,
            error: Some(err),
            format_version: manifest_version,
            restored_wiki: replace_outcome.restored_wiki,
            restored_snapshots: replace_outcome.restored_snapshots,
            restored_qm_drafts: replace_outcome.restored_qm_drafts,
            restored_root_docs: replace_outcome.restored_root_docs,
        });
    }

    Ok(CanonRestoreResult {
        success: true,
        restored_status: replace_outcome.restored_status,
        restored_drafts: replace_outcome.restored_drafts,
        restored_canon_lancedb: replace_outcome.restored_canon_lancedb,
        restored_files: staged_files,
        checksum_verified: staged.container_checksum_verified,
        auto_backup_path,
        warnings,
        error: None,
        format_version: manifest_version,
        restored_wiki: replace_outcome.restored_wiki,
        restored_snapshots: replace_outcome.restored_snapshots,
        restored_qm_drafts: replace_outcome.restored_qm_drafts,
        restored_root_docs: replace_outcome.restored_root_docs,
    })
}

fn failed_restore(
    error: String,
    checksum_verified: Option<bool>,
    auto_backup_path: Option<String>,
    warnings: Vec<String>,
    format_version: u32,
) -> CanonRestoreResult {
    CanonRestoreResult {
        success: false,
        restored_status: false,
        restored_drafts: false,
        restored_canon_lancedb: false,
        restored_files: 0,
        checksum_verified,
        auto_backup_path,
        warnings,
        error: Some(error),
        format_version,
        restored_wiki: false,
        restored_snapshots: false,
        restored_qm_drafts: false,
        restored_root_docs: false,
    }
}

/// supersede / schema 迁移前的自动备份入口。
/// 自动备份（③-3：可选进度回调，command 包装层传入 AppHandle；
/// 测试/纯逻辑调用传 `None` 不发进度事件）。
pub fn auto_backup_impl_with_progress(
    request: &CanonAutoBackupRequest,
    app: Option<&AppHandle>,
) -> Result<CanonAutoBackupResult, String> {
    #[cfg(test)]
    let _cancel_read = CANCEL_TEST_RWLOCK.read().unwrap_or_else(|e| e.into_inner());
    auto_backup_impl_with_cancel(request, app, Some(&CANON_EXPORT_CANCEL))
}

fn auto_backup_impl_with_cancel(
    request: &CanonAutoBackupRequest,
    app: Option<&AppHandle>,
    cancel: Option<&AtomicBool>,
) -> Result<CanonAutoBackupResult, String> {
    let project = Path::new(&request.project_path);
    if is_symlink_or_reparse_point(project) {
        return Ok(CanonAutoBackupResult {
            success: false,
            backup_path: None,
            checksum_sha256: None,
            warnings: vec![],
            error: Some(format!(
                "安全拦截：项目根目录 {} 为符号链接或重解析点",
                request.project_path
            )),
        });
    }
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
    if !roots.has_any() {
        return Ok(CanonAutoBackupResult {
            success: false,
            backup_path: None,
            checksum_sha256: None,
            warnings: vec![],
            error: Some(
                "项目下没有任何可备份的状态（status/drafts/canon/QM/snapshots/qm-drafts/root-docs 均不存在）"
                    .to_string(),
            ),
        });
    }

    let auto_dir = project.join(AUTO_BACKUP_DIR);
    if let Err(e) = assert_no_symlink_in_ancestors(project, &auto_dir) {
        return Ok(CanonAutoBackupResult {
            success: false,
            backup_path: None,
            checksum_sha256: None,
            warnings: vec![],
            error: Some(format!(
                "安全拦截：自动备份目录 ({}) 或其祖先链含符号链接或重解析点 ({e})",
                auto_dir.display()
            )),
        });
    }
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

    let outcome = match pack_project_with_cancel(
        app,
        "canon_auto_backup",
        project,
        &output,
        None,
        &project_name,
        cancel,
    ) {
        Ok(o) => o,
        Err(e) if e == BACKUP_CANCELLED_ERR => {
            return Ok(CanonAutoBackupResult {
                success: false,
                backup_path: None,
                checksum_sha256: None,
                warnings: vec![],
                error: Some(BACKUP_CANCELLED_ERR.to_string()),
            });
        }
        Err(e) => return Err(e),
    };
    Ok(CanonAutoBackupResult {
        success: true,
        backup_path: Some(output.to_string_lossy().to_string()),
        checksum_sha256: Some(outcome.checksum_hex),
        warnings: outcome.warnings,
        error: None,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// 带 CanonCommandState 锁序与缓存失效协调的可测试包装（M2-04 + BLOCKING-2）
// 全局锁序：T1 (OP_LOCK) → T2 (write_lock) → T4 (FILE_MUTATION_LOCK) → T5 (agent_gate / revisions)
// ──────────────────────────────────────────────────────────────────────────

fn check_controlled_export_sandbox_rel(rel: &[String]) -> Result<(), String> {
    // 必须位于 <project>/backups/exports/<...>/<file>.zip（至少 3 段），
    // 硬拒绝 backups/bad.zip、backups/auto/...、backups/.t34c-... 等路径。
    if rel.len() < 3 || rel[0] != "backups" || rel[1] != "exports" {
        return Err("输出路径未位于受控导出沙箱 backups/exports/ 下".to_string());
    }
    for seg in &rel[2..] {
        if seg == ".."
            || seg.starts_with(".t34c-")
            || matches!(
                seg.as_str(),
                "auto"
                    | ".novel"
                    | "qm"
                    | "wiki"
                    | ".niko-buddy"
                    | "canon"
                    | "backups"
                    | ".qm-drafts"
            )
        {
            return Err(format!("受控导出沙箱路径包含禁止段 '{seg}'"));
        }
        if crate::agent_gate_policy::is_windows_reserved_device_name(seg) {
            return Err(format!("受控导出沙箱路径包含 Windows 保留设备名 '{seg}'"));
        }
    }
    Ok(())
}

fn assert_controlled_backup_export_sandbox(
    project_root: &Path,
    output_zip: &Path,
) -> Result<(), String> {
    let raw_str = output_zip.to_string_lossy();
    if raw_str.trim().is_empty()
        || raw_str.chars().any(|c| (c as u32) < 0x20)
        || raw_str.ends_with('/')
        || raw_str.ends_with('\\')
    {
        return Err("导出路径格式非法".to_string());
    }
    if crate::pdf_export::has_illegal_colon(&raw_str) {
        return Err("导出路径包含非法 NTFS ADS 冒号".to_string());
    }
    if output_zip
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("导出路径不允许包含 '..'".to_string());
    }

    let raw_norm = raw_str.replace('\\', "/");
    let (raw_segs, _) = crate::agent_gate_policy::normalized_lower_segments(
        crate::pdf_export::strip_windows_verbatim_prefix(&raw_norm),
    );
    if raw_segs.iter().any(|s| s == "..") {
        return Err("导出路径不允许包含 '..'".to_string());
    }

    let resolved = if output_zip.is_absolute() {
        output_zip.to_path_buf()
    } else {
        project_root.join(output_zip)
    };
    let file_name = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "导出路径缺少有效文件名".to_string())?;
    if file_name.ends_with('.') || file_name.ends_with(' ') {
        return Err(format!("导出文件名非法: '{file_name}'"));
    }
    if crate::agent_gate_policy::is_windows_reserved_device_name(file_name) {
        return Err(format!("导出文件名使用 Windows 保留设备名: '{file_name}'"));
    }
    let ext_ok = resolved
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    let stem_ok = file_name
        .rsplit_once('.')
        .is_some_and(|(stem, _)| !stem.trim().is_empty());
    if !ext_ok || !stem_ok {
        return Err(format!(
            "受控导出沙箱仅允许非空主干的 .zip 文件: '{file_name}'"
        ));
    }

    let resolved_text = resolved.to_string_lossy().replace('\\', "/");
    let root_text = project_root.to_string_lossy().replace('\\', "/");
    let (res_raw, res_folded) = crate::agent_gate_policy::normalized_lower_segments(
        crate::pdf_export::strip_windows_verbatim_prefix(&resolved_text),
    );
    let (_, root_folded) = crate::agent_gate_policy::normalized_lower_segments(
        crate::pdf_export::strip_windows_verbatim_prefix(&root_text),
    );
    if res_raw.iter().any(|s| s == "..")
        || root_folded.is_empty()
        || !res_folded.starts_with(&root_folded)
    {
        return Err("导出路径未落在当前项目受控导出沙箱内".to_string());
    }
    let rel_slice = &res_folded[root_folded.len()..];
    check_controlled_export_sandbox_rel(rel_slice)?;

    // 校验项目内相对段本身不带 Windows 尾点/尾空格绕过（如 `backups./exports/run.zip`）。
    for comp in resolved.components().rev().take(rel_slice.len()) {
        if let std::path::Component::Normal(os_seg) = comp {
            let s = os_seg.to_string_lossy();
            if s.ends_with('.') || s.ends_with(' ') {
                return Err(format!("导出路径段不允许以点或空格结尾: '{s}'"));
            }
        }
    }

    crate::pdf_export::assert_no_symlink_in_path(&resolved)?;
    assert_no_symlink_in_ancestors(project_root, &resolved)?;
    assert_no_symlink_in_ancestors(project_root, &sidecar_path(&resolved))?;

    if let (Some(canon_resolved), Ok(canon_root)) = (
        crate::pdf_export::canonicalize_existing_prefix(&resolved),
        fs::canonicalize(project_root),
    ) {
        let canon_text = canon_resolved.to_string_lossy().replace('\\', "/");
        let canon_root_text = canon_root.to_string_lossy().replace('\\', "/");
        let (c_raw, c_folded) = crate::agent_gate_policy::normalized_lower_segments(
            crate::pdf_export::strip_windows_verbatim_prefix(&canon_text),
        );
        let (_, cr_folded) = crate::agent_gate_policy::normalized_lower_segments(
            crate::pdf_export::strip_windows_verbatim_prefix(&canon_root_text),
        );
        if c_raw.iter().any(|s| s == "..")
            || cr_folded.is_empty()
            || !c_folded.starts_with(&cr_folded)
        {
            return Err("规范化后的导出路径逃逸项目受控导出沙箱".to_string());
        }
        check_controlled_export_sandbox_rel(&c_folded[cr_folded.len()..])?;
    }

    Ok(())
}

/// 导出输出路径安全校验（BLOCKING-R2-01）：
/// 1. 放行项目外安全目录（如 `D:\Backups\out.zip`）与项目内非数据区目录；
/// 2. 对项目内受控导出沙箱 `<project>/backups/exports/<file>.zip`（MCP `export.run` 输出目录）定向放行；
/// 3. 硬拒绝 `<project>/backups/bad.zip`、`<project>/backups/auto/...`、`<project>/backups/.t34c-...`
///    及 `QM/`/`.novel/`/`wiki/`/`.niko-buddy/`/`canon/`/`.qm-drafts/` 等全部项目内数据区与符号链接。
fn assert_canon_export_output_path_safe(
    project_root: &Path,
    output_zip: &Path,
) -> Result<(), String> {
    match crate::pdf_export::assert_export_path_outside_data_sections(project_root, output_zip) {
        Ok(_) => Ok(()),
        Err(base_err) => {
            if assert_controlled_backup_export_sandbox(project_root, output_zip).is_ok() {
                Ok(())
            } else {
                Err(format!(
                    "安全拦截：导出输出路径不可落在受保护数据区 ({base_err})"
                ))
            }
        }
    }
}

pub(crate) async fn canon_export_with_state(
    app: Option<&AppHandle>,
    state: Option<&CanonCommandState>,
    request: CanonExportRequest,
) -> Result<CanonExportResult, String> {
    let _op_guard = op_lock().lock().await;
    reset_cancel();
    let write_lock = state.map(|s| s.write_lock(&request.project_path));
    let _write_guard = match write_lock.as_ref() {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let app_owned = app.cloned();
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("canon_export_project", || {
            // BLOCKING-R2-01：放行项目外安全目录与项目内受控导出沙箱 `<project>/backups/exports/*.zip`，
            // 硬拒绝 `backups/bad.zip`、`backups/auto/...`、`backups/.t34c-...` 与全部项目内数据区。
            assert_canon_export_output_path_safe(
                Path::new(&request.project_path),
                Path::new(&request.output_zip_path),
            )?;
            // F-001：canon 写入路径也过门；导出产物落盘前记录审计。
            let gate = crate::agent_gate::gate_authorize(
                "writeFile",
                &request.output_zip_path,
                crate::agent_gate::GateActor::Agent,
            );
            if !gate.may_proceed() {
                return Err(crate::agent_gate::gate_error(&gate));
            }
            export_project_impl_with_progress(&request, app_owned.as_ref())
        })
    })
    .await
    .map_err(|e| format!("export task join error: {e}"))?
}

pub(crate) async fn canon_restore_with_state(
    app: Option<&AppHandle>,
    state: Option<&CanonCommandState>,
    request: CanonRestoreRequest,
) -> Result<CanonRestoreResult, String> {
    let _op_guard = op_lock().lock().await;
    let project_path = request.project_path.clone();
    let write_lock = state.map(|s| s.write_lock(&project_path));
    let _write_guard = match write_lock.as_ref() {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let app_owned = app.cloned();
    let result = match tauri::async_runtime::spawn_blocking(move || {
        run_guarded("canon_restore_project", || {
            // BLOCKING-2 严格锁序 T1 → T2 → T4 → T5（T4 绝不跨 .await）：
            let _mutation = crate::commands::fs::lock_file_mutations()?;
            let gate = crate::agent_gate::gate_authorize(
                "canonRestore",
                &request.project_path,
                crate::agent_gate::GateActor::User,
            );
            if !gate.may_proceed() {
                return Err(crate::agent_gate::gate_error(&gate));
            }
            restore_project_impl_with_progress(&request, app_owned.as_ref())
        })
    })
    .await
    {
        Ok(res) => res,
        Err(e) => Err(format!("export task join error: {e}")),
    };
    // M2-04：凡恢复触碰过 canon-lancedb 或返回失败（含 Err / success=false），
    // 均在释放 write_lock 前无条件失效缓存，防止残留旧 revision。
    if let Some(st) = state {
        let should_invalidate = match &result {
            Ok(res) => res.restored_canon_lancedb || !res.success,
            Err(_) => true,
        };
        if should_invalidate {
            st.invalidate_project(&project_path);
        }
    }
    result
}

pub(crate) async fn canon_auto_backup_with_state(
    app: Option<&AppHandle>,
    state: Option<&CanonCommandState>,
    request: CanonAutoBackupRequest,
) -> Result<CanonAutoBackupResult, String> {
    let _op_guard = op_lock().lock().await;
    reset_cancel();
    let write_lock = state.map(|s| s.write_lock(&request.project_path));
    let _write_guard = match write_lock.as_ref() {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let app_owned = app.cloned();
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("canon_auto_backup", || {
            auto_backup_impl_with_progress(&request, app_owned.as_ref())
        })
    })
    .await
    .map_err(|e| format!("export task join error: {e}"))?
}

// ──────────────────────────────────────────────────────────────────────────
// `#[tauri::command]` 包装（JS 侧 invoke("canon_export_project", { request })）
// ──────────────────────────────────────────────────────────────────────────

/// 导出项目备份包（zip + SHA-256 sidecar；可选本地 AES-256 口令）。
#[tauri::command]
pub async fn canon_export_project(
    app: tauri::AppHandle,
    request: CanonExportRequest,
) -> Result<CanonExportResult, String> {
    let state = app.try_state::<CanonCommandState>();
    canon_export_with_state(Some(&app), state.as_ref().map(|s| s.inner()), request).await
}

/// 从备份包恢复项目（校验通过后原子替换；替换前自动备份现状）。
#[tauri::command]
pub async fn canon_restore_project(
    app: tauri::AppHandle,
    request: CanonRestoreRequest,
) -> Result<CanonRestoreResult, String> {
    let state = app.try_state::<CanonCommandState>();
    canon_restore_with_state(Some(&app), state.as_ref().map(|s| s.inner()), request).await
}

/// 只校验备份包完整性（容器 SHA-256 + 内容摘要），不做任何写操作。
#[tauri::command]
pub async fn canon_verify_export(request: CanonVerifyRequest) -> Result<CanonVerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("canon_verify_export", || verify_export_impl(&request))
    })
    .await
    .map_err(|e| format!("export task join error: {e}"))?
}

/// supersede / schema 迁移前的自动备份（TS 编排层显式调用）。
#[tauri::command]
pub async fn canon_auto_backup(
    app: tauri::AppHandle,
    request: CanonAutoBackupRequest,
) -> Result<CanonAutoBackupResult, String> {
    let state = app.try_state::<CanonCommandState>();
    canon_auto_backup_with_state(Some(&app), state.as_ref().map(|s| s.inner()), request).await
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

    /// 唯一临时目录（沿用 `canon::commands` 测试模式：计数器 + 时间戳，不主动清理）。
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
        fs::create_dir_all(p.join(".niko-buddy/lancedb")).unwrap();
        fs::write(
            p.join(".novel/status.json"),
            r#"{"step":"ch-3","chapter":3}"#,
        )
        .unwrap();
        fs::write(p.join(".novel/drafts/conv_1.json"), r#"{"draft":1}"#).unwrap();
        fs::write(
            p.join(".novel/drafts/conv_2.superseded.1.json"),
            r#"{"draft":2-old}"#,
        )
        .unwrap();
        fs::create_dir_all(p.join(".niko-buddy/lancedb/entities.lance")).unwrap();
        fs::create_dir_all(p.join(".niko-buddy/lancedb/_versions")).unwrap();
        fs::write(
            p.join(".niko-buddy/lancedb/entities.lance/data.lance"),
            b"lance-bytes-1",
        )
        .unwrap();
        fs::write(
            p.join(".niko-buddy/lancedb/_versions/manifest-0"),
            b"lance-manifest",
        )
        .unwrap();
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
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    // ── 导出 → 篡改现场 → 恢复：内容还原 + 自动备份存在 ──

    #[test]
    fn export_roundtrip_restores_status_drafts_and_lancedb() {
        let project = seed_project("roundtrip");
        let out_dir = tmp_dir("roundtrip-out");
        let zip = out_dir.join("proj-backup.zip");

        let result = export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();
        assert!(result.success, "导出应成功: {:?}", result.error);
        assert_eq!(result.file_count, 5, "status+2drafts+2lance 文件");
        assert!(result
            .checksum_sha256
            .as_ref()
            .is_some_and(|c| c.len() == 64));
        assert!(sidecar_path(&zip).is_file(), "sidecar 应存在");

        // 破坏现场：改 status、删一个 draft、污染 lancedb
        fs::write(
            project.join(".novel/status.json"),
            r#"{"step":"corrupted"}"#,
        )
        .unwrap();
        fs::remove_file(project.join(".novel/drafts/conv_1.json")).unwrap();
        fs::write(
            project.join(".niko-buddy/lancedb/_versions/manifest-0"),
            b"tampered",
        )
        .unwrap();

        let restore = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: project.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(restore.success, "恢复应成功: {:?}", restore.error);
        assert!(
            restore.restored_status && restore.restored_drafts && restore.restored_canon_lancedb
        );
        assert_eq!(restore.restored_files, 5);
        assert_eq!(
            restore.checksum_verified,
            Some(true),
            "sidecar 存在时应通过容器校验"
        );
        assert!(
            restore
                .auto_backup_path
                .as_ref()
                .is_some_and(|p| Path::new(p).is_file()),
            "替换前应有自动备份"
        );

        // 现场已还原
        assert_eq!(
            fs::read_to_string(project.join(".novel/status.json")).unwrap(),
            r#"{"step":"ch-3","chapter":3}"#
        );
        assert!(project.join(".novel/drafts/conv_1.json").is_file());
        assert_eq!(
            fs::read(project.join(".niko-buddy/lancedb/_versions/manifest-0")).unwrap(),
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
        export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();

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
        let exported =
            export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();

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

        let exported = export_project_impl_with_progress(
            &CanonExportRequest {
                project_path: project.to_string_lossy().to_string(),
                output_zip_path: zip.to_string_lossy().to_string(),
                passphrase: Some("本地口令-local-pass".to_string()),
            },
            None,
        )
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
        let exported = export_project_impl_with_progress(
            &CanonExportRequest {
                project_path: project.to_string_lossy().to_string(),
                output_zip_path: zip.to_string_lossy().to_string(),
                passphrase: Some("   ".to_string()),
            },
            None,
        )
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

        let restore = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: project.to_string_lossy().to_string(),
                zip_path: evil_zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(!restore.success, "traversal 条目应被拒");
        assert!(restore.error.unwrap().contains("安全拦截"));
        assert!(!evil_dir.join("evil.txt").exists(), "恶意文件不应落到包外");
    }

    // ── 自动备份命令核心 ──

    #[test]
    fn auto_backup_creates_timestamped_zip_with_sidecar() {
        let project = seed_project("autobackup");
        let r = auto_backup_impl_with_progress(
            &CanonAutoBackupRequest {
                project_path: project.to_string_lossy().to_string(),
                reason: "pre supersede/迁移!".to_string(),
            },
            None,
        )
        .unwrap();
        assert!(r.success, "{:?}", r.error);
        let path = Path::new(r.backup_path.as_ref().unwrap());
        assert!(path.is_file());
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("pre-supersede"),
            "reason 应被清洗进文件名: {}",
            path.display()
        );
        assert!(r.checksum_sha256.as_ref().is_some_and(|c| c.len() == 64));
        assert!(sidecar_path(path).is_file(), "自动备份也应有 sidecar");

        // 空项目 → 报无可备份
        let empty = tmp_dir("autobackup-empty");
        let r2 = auto_backup_impl_with_progress(
            &CanonAutoBackupRequest {
                project_path: empty.to_string_lossy().to_string(),
                reason: "pre-migration".to_string(),
            },
            None,
        )
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
        let exported =
            export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();
        assert!(exported.success, "{:?}", exported.error);
        assert_eq!(exported.file_count, 1);
        assert!(
            exported
                .warnings
                .iter()
                .any(|w| w.contains("drafts") || w.contains("lancedb")),
            "缺失组件应产生 warning: {:?}",
            exported.warnings
        );

        // 恢复到全新目录：只建 status
        let target = tmp_dir("partial-target");
        let restore = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: target.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
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
        assert_eq!(sanitize_reason("a b/c\\d:e*?"), "a-b-c-d-e");
        assert_eq!(sanitize_reason("///"), "unspecified");
    }

    // ── TASK-004 薄适配：块寻址原语（既有导出路径行为不变）──

    #[test]
    fn archive_adapter_forwards_to_block_addressing_primitives() {
        let project = seed_project("archive-adapter");
        let via_adapter = archive_manifest_for_project(&project).unwrap();
        let direct = crate::canon::archive::build_manifest(&project).unwrap();

        // 薄适配 = 纯转发（除 created_at 外逐字段一致）。
        assert_eq!(via_adapter.blocks, direct.blocks);
        assert_eq!(via_adapter.content_digest, direct.content_digest);
        assert_eq!(via_adapter.id, direct.id);
        assert_eq!(
            via_adapter.schema_version,
            crate::canon::archive::ARCHIVE_SCHEMA_VERSION
        );

        // 既有 zip 容器内容层摘要仍可用且行为不变（回归）。
        let roots = ComponentRoots::from_project(&project);
        let entries = enumerate_entries(&roots);
        let legacy = compute_content_digest_from_disk(&entries).unwrap();
        assert_eq!(legacy.len(), 64, "既有内容层摘要仍为 sha256 hex");

        // 两层指纹层次不同（块集合层 vs zip 条目层），不互为替代。
        assert_ne!(legacy, via_adapter.content_digest);
    }

    // ── M2-04 #1：跨组件路径穿越 drafts/../status/status.json 与非法路径字符拦截 ──

    #[test]
    fn zip_slip_cross_component_traversal_is_rejected() {
        let staging = tmp_dir("zipslip-cross-stage").canonicalize().unwrap();
        for evil_entry in [
            "drafts/../status/status.json",
            "drafts/..\\status\\status.json",
            "drafts/foo.json:evil_ads",
            "drafts/foo\0bar.json",
            "drafts//etc/passwd",
            "drafts/.",
        ] {
            let res = safe_staging_target(&staging, evil_entry);
            assert!(
                res.is_err(),
                "恶意条目 {evil_entry:?} 应被 safe_staging_target 拦截"
            );
            assert!(
                res.unwrap_err().contains("安全拦截"),
                "错误应含安全拦截标记"
            );
        }

        // 端到端恢复拦截：恶意包试图从 drafts 跨组件覆写 status/status.json
        let project = seed_project("zipslip-cross-target");
        let evil_zip = tmp_dir("zipslip-cross-src").join("cross.zip");
        let f = fs::File::create(&evil_zip).unwrap();
        let mut zw = ZipWriter::new(f);
        let manifest_json = serde_json::json!({
            "kind": MANIFEST_KIND,
            "format_version": FORMAT_VERSION,
            "created_at": "2026-01-01T00:00:00Z",
            "app_version": "0",
            "project_name": "evil-cross",
            "components": { "status": true, "drafts": true, "canon_lancedb": false },
            "file_count": 1,
            "content_sha256": "00"
        })
        .to_string();
        zw.start_file(MANIFEST_ENTRY, base_opts()).unwrap();
        zw.write_all(manifest_json.as_bytes()).unwrap();
        zw.start_file("drafts/../status/status.json", base_opts())
            .unwrap();
        zw.write_all(br#"{"pwned":true}"#).unwrap();
        zw.finish().unwrap();

        let restore = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: project.to_string_lossy().to_string(),
                zip_path: evil_zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(!restore.success, "跨组件穿越包必须被拒");
        assert!(restore.error.unwrap().contains("安全拦截"));
        assert_eq!(
            fs::read_to_string(project.join(".novel/status.json")).unwrap(),
            r#"{"step":"ch-3","chapter":3}"#,
            "目标 status.json 必须保持原样"
        );
    }

    // ── M2-04 #2：zip 炸弹单条目、总上限与伪造 header size 流式封顶 ──

    #[test]
    fn read_entry_bytes_enforces_entry_and_total_zip_bomb_limits() {
        assert_eq!(MAX_MANIFEST_ENTRY_BYTES, 1024 * 1024);
        assert_eq!(MAX_ENTRY_UNCOMPRESSED_BYTES, 256 * 1024 * 1024);
        assert_eq!(MAX_TOTAL_UNCOMPRESSED_BYTES, 1024 * 1024 * 1024);
        assert_eq!(MAX_ARCHIVE_ENTRIES, 65_536);

        // 1) 单条目快拒与累计总上限
        let dir = tmp_dir("zipbomb");
        let zip_path = dir.join("two.zip");
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut zw = ZipWriter::new(f);
            zw.start_file("drafts/a.txt", base_opts()).unwrap();
            zw.write_all(&vec![b'A'; 256]).unwrap();
            zw.start_file("drafts/b.txt", base_opts()).unwrap();
            zw.write_all(&vec![b'B'; 256]).unwrap();
            zw.finish().unwrap();
        }
        {
            let mut archive = ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
            let mut total = 0u64;
            let err = read_entry_bytes(&mut archive, 0, None, 100, &mut total, 1024).unwrap_err();
            assert!(err.contains("单条目上限"), "应触发单条目上限: {err}");
            assert_eq!(total, 0);

            let ok = read_entry_bytes(&mut archive, 0, None, 300, &mut total, 400).unwrap();
            assert_eq!(ok.len(), 256);
            assert_eq!(total, 256);

            let err2 = read_entry_bytes(&mut archive, 1, None, 300, &mut total, 400).unwrap_err();
            assert!(err2.contains("总上限"), "第二条目应触发总上限: {err2}");
            assert_eq!(total, 256);
        }

        // 2) 伪造 header uncompressed_size 炸弹：实际 512 字节但头声明 10 字节，靠 take(limit+1) 流式拦截
        let spoof_zip = dir.join("spoofed.zip");
        {
            let f = fs::File::create(&spoof_zip).unwrap();
            let mut zw = ZipWriter::new(f);
            zw.start_file("drafts/bomb.bin", base_opts()).unwrap();
            zw.write_all(&vec![0u8; 512]).unwrap();
            zw.finish().unwrap();
        }
        let mut raw = fs::read(&spoof_zip).unwrap();
        let lfh = raw
            .windows(4)
            .position(|w| w == b"PK\x03\x04")
            .expect("local file header");
        let cdh = raw
            .windows(4)
            .position(|w| w == b"PK\x01\x02")
            .expect("central directory header");
        assert_eq!(&raw[lfh + 22..lfh + 26], &512u32.to_le_bytes());
        assert_eq!(&raw[cdh + 24..cdh + 28], &512u32.to_le_bytes());
        raw[lfh + 22..lfh + 26].copy_from_slice(&10u32.to_le_bytes());
        raw[cdh + 24..cdh + 28].copy_from_slice(&10u32.to_le_bytes());
        fs::write(&spoof_zip, &raw).unwrap();

        let mut spoof_archive = ZipArchive::new(fs::File::open(&spoof_zip).unwrap()).unwrap();
        assert_eq!(
            spoof_archive.by_index(0).unwrap().size(),
            10,
            "伪造后头声明尺寸应为 10 字节"
        );
        let mut total_entry = 0u64;
        let err_entry =
            read_entry_bytes(&mut spoof_archive, 0, None, 100, &mut total_entry, 1024).unwrap_err();
        assert!(
            err_entry.contains("实际解压体积超过单条目上限"),
            "流式封顶应拦截伪造头单条目炸弹: {err_entry}"
        );
        assert_eq!(total_entry, 0);

        let mut total_budget = 0u64;
        let err_total = read_entry_bytes(&mut spoof_archive, 0, None, 1024, &mut total_budget, 100)
            .unwrap_err();
        assert!(
            err_total.contains("总上限"),
            "流式封顶应拦截伪造头累计总上限炸弹: {err_total}"
        );
        assert_eq!(total_budget, 0);
    }

    // ── M2-04 #3：无 sidecar 时 checksum_verified 如实返回 None 并保留 warnings ──

    #[test]
    fn restore_without_sidecar_reports_checksum_verified_none_and_keeps_warnings() {
        let project = seed_project("nosidecar-src");
        let out = tmp_dir("nosidecar-out");
        let zip = out.join("backup.zip");
        let exported =
            export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();
        assert!(exported.success);
        // 删除 .sha256 sidecar
        fs::remove_file(sidecar_path(&zip)).unwrap();
        assert!(!sidecar_path(&zip).exists());

        let target = tmp_dir("nosidecar-target");
        let restored = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: target.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(restored.success, "{:?}", restored.error);
        assert_eq!(
            restored.checksum_verified, None,
            "无 sidecar 且无 expected_checksum 时绝不可伪造成 Some(true)"
        );
        assert!(
            restored.warnings.iter().any(|w| w.contains(".sha256")),
            "应保留缺 sidecar 告警: {:?}",
            restored.warnings
        );

        // 失败路径（提供错误期望校验和）如实回报 Some(false)
        let bad = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: target.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: Some("0000deadbeef".to_string()),
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(!bad.success);
        assert_eq!(bad.checksum_verified, Some(false));

        // 失败路径（无 sidecar + 错误口令）如实回报 None 且保留 warnings
        let enc_zip = out.join("enc.zip");
        export_project_impl_with_progress(
            &CanonExportRequest {
                project_path: project.to_string_lossy().to_string(),
                output_zip_path: enc_zip.to_string_lossy().to_string(),
                passphrase: Some("secret-pass".to_string()),
            },
            None,
        )
        .unwrap();
        fs::remove_file(sidecar_path(&enc_zip)).unwrap();
        let bad_pass = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: target.to_string_lossy().to_string(),
                zip_path: enc_zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: Some("wrong-pass".to_string()),
            },
            None,
        )
        .unwrap();
        assert!(!bad_pass.success);
        assert_eq!(bad_pass.checksum_verified, None);
        assert!(
            bad_pass.warnings.iter().any(|w| w.contains(".sha256")),
            "失败路径也应保留缺 sidecar 告警"
        );
    }

    // ── M2-04 #4：半程失败逆序回滚 + 二次回滚失败如实上报 restored_* ──

    #[test]
    fn replace_staged_components_rolls_back_in_reverse_and_reports_rollback_failure() {
        fn seed_swap_pair(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
            let project = tmp_dir(&format!("{tag}-proj"));
            let backups = project.join("backups");
            let staging = backups.join(".t34c-staging-test");
            fs::create_dir_all(project.join(".novel/drafts")).unwrap();
            fs::create_dir_all(project.join(".niko-buddy/lancedb")).unwrap();
            fs::write(project.join(STATUS_REL), "old-status").unwrap();
            fs::write(project.join(".novel/drafts/d.txt"), "old-draft").unwrap();
            fs::write(project.join(".niko-buddy/lancedb/l.bin"), "old-lance").unwrap();

            fs::create_dir_all(staging.join("status")).unwrap();
            fs::create_dir_all(staging.join("drafts")).unwrap();
            fs::create_dir_all(staging.join("canon-lancedb")).unwrap();
            fs::write(staging.join("status/status.json"), "new-status").unwrap();
            fs::write(staging.join("drafts/d.txt"), "new-draft").unwrap();
            fs::write(staging.join("canon-lancedb/l.bin"), "new-lance").unwrap();
            (project, backups, staging)
        }

        let all_components = ManifestComponents {
            status: true,
            drafts: true,
            canon_lancedb: true,
            ..Default::default()
        };

        // 1) canon-lancedb 失败 → 按 drafts → status 逆序完整回滚
        let (project, backups, staging) = seed_swap_pair("rb-clean");
        let lancedb_target = project.join(LANCEDB_REL);
        let mut rename_log: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut warnings = Vec::new();
        let outcome = replace_staged_components_with_rename(
            &all_components,
            &staging,
            &project,
            &backups,
            "s1",
            &mut warnings,
            |from: &Path, to: &Path| {
                rename_log.push((from.to_path_buf(), to.to_path_buf()));
                if from == lancedb_target.as_path() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "lancedb locked",
                    ));
                }
                fs::rename(from, to)
            },
        );
        assert!(outcome.error.is_some());
        assert!(!outcome.restored_status);
        assert!(!outcome.restored_drafts);
        assert!(!outcome.restored_canon_lancedb);
        assert_eq!(
            fs::read_to_string(project.join(STATUS_REL)).unwrap(),
            "old-status"
        );
        assert_eq!(
            fs::read_to_string(project.join(".novel/drafts/d.txt")).unwrap(),
            "old-draft"
        );
        assert_eq!(
            fs::read_to_string(project.join(".niko-buddy/lancedb/l.bin")).unwrap(),
            "old-lance"
        );
        // 核验逆序回滚：回滚 drafts 早于回滚 status
        let fail_idx = rename_log
            .iter()
            .position(|(from, _)| from == &lancedb_target)
            .unwrap();
        let rb_drafts_idx = rename_log[fail_idx + 1..]
            .iter()
            .position(|(from, _)| from == &project.join(DRAFTS_REL))
            .expect("应回滚 drafts");
        let rb_status_idx = rename_log[fail_idx + 1..]
            .iter()
            .position(|(from, _)| from == &project.join(STATUS_REL))
            .expect("应回滚 status");
        assert!(
            rb_drafts_idx < rb_status_idx,
            "阶段 2B 必须按逆序先回滚 drafts 再回滚 status"
        );

        // 2) 二次回滚失败：lancedb 换位失败后，drafts 回滚成功但 status 回滚失败 →
        //    restored_status 如实保持 true，restored_drafts 为 false，warnings/error 如实上报
        let (project2, backups2, staging2) = seed_swap_pair("rb-partial-fail");
        let lancedb_target2 = project2.join(LANCEDB_REL);
        let status_target2 = project2.join(STATUS_REL);
        let mut status_moves = 0usize;
        let mut warnings2 = Vec::new();
        let outcome2 = replace_staged_components_with_rename(
            &all_components,
            &staging2,
            &project2,
            &backups2,
            "s2",
            &mut warnings2,
            |from: &Path, to: &Path| {
                if from == lancedb_target2.as_path() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "lancedb locked",
                    ));
                }
                if from == status_target2.as_path() {
                    status_moves += 1;
                    // 第 1 次为阶段 1 移开旧 status；第 2 次为阶段 2B 回滚移出新 status → 注入失败
                    if status_moves == 2 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "status rollback denied",
                        ));
                    }
                }
                fs::rename(from, to)
            },
        );
        let err2 = outcome2.error.expect("应返回复合错误");
        assert!(
            outcome2.restored_status,
            "status 回滚失败时 restored_status 须如实保持 true"
        );
        assert!(
            !outcome2.restored_drafts,
            "drafts 已成功回滚，restored_drafts 应为 false"
        );
        assert!(!outcome2.restored_canon_lancedb);
        assert!(
            err2.contains("status.json"),
            "错误应点名回滚失败组件: {err2}"
        );
        assert!(
            warnings2.iter().any(|w| w.contains("status.json")),
            "warnings 应记录回滚失败详情: {:?}",
            warnings2
        );
        assert_eq!(
            fs::read_to_string(project2.join(STATUS_REL)).unwrap(),
            "new-status"
        );
        assert_eq!(
            fs::read_to_string(project2.join(".novel/drafts/d.txt")).unwrap(),
            "old-draft"
        );
    }

    // ── M2-04 #5：canon_restore_with_state 写锁串行化与 revision 缓存失效 ──

    #[tokio::test]
    async fn canon_restore_with_state_serializes_write_lock_and_invalidates_revision() {
        use std::sync::Arc;

        use crate::canon::commands_core::{canon_get_revision_impl, canon_ingest_episode_impl};
        use crate::canon::types::CanonEpisode;

        let _serial = crate::agent_gate::gate_test_serial_async().await;
        let project = tmp_dir("restore-state-lock");
        crate::agent_gate::set_gate_project_root(project.clone());
        crate::agent_gate::__reset_state_for_test();
        let pid = project.to_string_lossy().to_string();
        fs::create_dir_all(project.join(".novel/drafts")).unwrap();
        fs::write(project.join(STATUS_REL), r#"{"chapter":2}"#).unwrap();
        fs::write(project.join(".novel/drafts/ch2.json"), r#"{"v":2}"#).unwrap();

        let state = Arc::new(CanonCommandState::default());
        // 写入 2 条 episode → 持久化 revision = 2
        let r1 = canon_ingest_episode_impl(
            &state,
            pid.clone(),
            CanonEpisode::new("ep1", 1, "alice", "d1"),
        )
        .await
        .unwrap();
        assert_eq!(r1.max_revision, 1);
        let r2 = canon_ingest_episode_impl(
            &state,
            pid.clone(),
            CanonEpisode::new("ep2", 2, "alice", "d2"),
        )
        .await
        .unwrap();
        assert_eq!(r2.max_revision, 2);

        // 在 rev=2 时导出备份包
        let zip = tmp_dir("restore-state-out").join("rev2.zip");
        let exp = export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();
        assert!(exp.success, "{:?}", exp.error);

        // 继续推进到 rev=5（内存与磁盘均为 5）
        for ch in 3..=5 {
            canon_ingest_episode_impl(
                &state,
                pid.clone(),
                CanonEpisode::new(format!("ep{ch}"), ch, "alice", format!("d{ch}")),
            )
            .await
            .unwrap();
        }
        assert_eq!(state.current_revision(&pid), 5);
        assert!(state.is_loaded(&pid));

        // 持同项目 write_lock，验证 canon_restore_with_state 会被写锁串行阻塞
        let lock = state.write_lock(&pid);
        let guard = lock.lock().await;
        let state_bg = Arc::clone(&state);
        let req = CanonRestoreRequest {
            project_path: pid.clone(),
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        };
        let handle = tokio::spawn(async move {
            canon_restore_with_state(None, Some(state_bg.as_ref()), req).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        assert!(
            !handle.is_finished(),
            "持有 write_lock 时 canon_restore_with_state 必须等待写锁释放"
        );

        // 释放写锁后恢复完成，并在释放写锁前已使 CanonCommandState 缓存失效
        drop(guard);
        let res = handle.await.unwrap().unwrap();
        assert!(res.success, "{:?}", res.error);
        assert!(res.restored_canon_lancedb);
        assert!(
            !state.is_loaded(&pid),
            "恢复 lancedb 后 loaded 标记必须被 invalidate_project 清除"
        );
        assert_eq!(
            state.current_revision(&pid),
            0,
            "恢复 lancedb 后内存 revision 缓存必须被清空"
        );

        // 后续查询重新从恢复后的磁盘库加载真实 revision = 2（而非陈旧缓存 5）
        let reloaded = canon_get_revision_impl(&state, pid).await.unwrap();
        assert_eq!(reloaded.max_revision, 2, "重新加载后应读到备份时点 rev=2");
    }

    // ── M2-04 #6（BLOCKING-3 回归）：空 .novel/drafts/ 目录导出恢复不报 ENOENT 且还原为空目录 ──

    #[test]
    fn restore_empty_drafts_directory_succeeds_and_clears_target_drafts() {
        let project = tmp_dir("empty-drafts-proj");
        fs::create_dir_all(project.join(DRAFTS_REL)).unwrap();
        fs::write(project.join(STATUS_REL), r#"{"chapter":1}"#).unwrap();
        assert_eq!(fs::read_dir(project.join(DRAFTS_REL)).unwrap().count(), 0);

        let zip = tmp_dir("empty-drafts-out").join("empty-drafts.zip");
        let exported =
            export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();
        assert!(exported.success, "{:?}", exported.error);
        assert_eq!(exported.file_count, 1, "仅含 status.json，drafts 目录为空");

        // 备份后在目标项目写入新草稿并改写 status.json
        fs::write(
            project.join(".novel/drafts/new_draft.json"),
            r#"{"draft":"after-backup"}"#,
        )
        .unwrap();
        fs::write(project.join(STATUS_REL), r#"{"chapter":9}"#).unwrap();
        assert_eq!(fs::read_dir(project.join(DRAFTS_REL)).unwrap().count(), 1);

        // 恢复备份：空 drafts 目录须先物化暂存目录，成功还原为空目录而不报 ENOENT
        let restored = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: project.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(restored.success, "空目录恢复应成功: {:?}", restored.error);
        assert!(restored.restored_status);
        assert!(restored.restored_drafts);
        assert!(project.join(DRAFTS_REL).is_dir());
        assert_eq!(
            fs::read_dir(project.join(DRAFTS_REL)).unwrap().count(),
            0,
            "恢复后 .novel/drafts/ 必须被还原为空目录"
        );
        assert_eq!(
            fs::read_to_string(project.join(STATUS_REL)).unwrap(),
            r#"{"chapter":1}"#
        );

        // 补充验证：manifest 宣称含 status 但 staging 缺 status.json 时，须在动真身前提前中止
        let guard_staging = project.join("backups/.t34c-staging-missing-status");
        fs::create_dir_all(&guard_staging).unwrap();
        let mut rename_called = false;
        let mut guard_warnings = Vec::new();
        let guard_outcome = replace_staged_components_with_rename(
            &ManifestComponents {
                status: true,
                drafts: true,
                canon_lancedb: false,
                ..Default::default()
            },
            &guard_staging,
            &project,
            &project.join("backups"),
            "missing-status",
            &mut guard_warnings,
            |from: &Path, to: &Path| {
                rename_called = true;
                fs::rename(from, to)
            },
        );
        assert!(guard_outcome.error.is_some());
        assert!(!rename_called, "缺 status.json 时不得动任何现有组件");
        assert!(!guard_outcome.restored_status && !guard_outcome.restored_drafts);
    }

    // ── R-3v2：异步导出 / 校验 / 自动备份通过 spawn_blocking 执行且保持锁序与契约不变 ──

    #[tokio::test]
    async fn async_export_verify_and_auto_backup_run_via_spawn_blocking() {
        let _serial = crate::agent_gate::gate_test_serial_async().await;
        let project = seed_project("async-offload");
        crate::agent_gate::set_gate_project_root(project.clone());
        crate::agent_gate::__reset_state_for_test();

        let state = CanonCommandState::default();
        let out_dir = tmp_dir("async-offload-out");
        let zip = out_dir.join("offloaded.zip");

        let exported = canon_export_with_state(None, Some(&state), export_req(&project, &zip))
            .await
            .unwrap();
        assert!(exported.success, "{:?}", exported.error);
        assert_eq!(exported.file_count, 5);

        let verified = canon_verify_export(CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: exported.checksum_sha256.clone(),
            passphrase: None,
        })
        .await
        .unwrap();
        assert!(verified.success, "{:?}", verified.error);
        assert_eq!(verified.container_checksum_matches, Some(true));
        assert!(verified.content_digest_verified);

        let auto = canon_auto_backup_with_state(
            None,
            Some(&state),
            CanonAutoBackupRequest {
                project_path: project.to_string_lossy().to_string(),
                reason: "pre-spawn-blocking-check".to_string(),
            },
        )
        .await
        .unwrap();
        assert!(auto.success, "{:?}", auto.error);
        assert!(auto
            .backup_path
            .as_ref()
            .is_some_and(|p| Path::new(p).is_file()));
    }

    // ── P0-03：v2 全量 7 组件打包与恢复 + QM/ 优先于 wiki/ + backups/.t34c-* 硬排除 ──

    #[test]
    fn v2_full_export_verify_and_restore_covers_all_seven_components_and_qm_priority() {
        let project = seed_project("v2-full");
        // 同时准备 QM/ 与 legacy wiki/：BLOCKING-1 铁律要求 QM/ 优先于 wiki/
        fs::create_dir_all(project.join("QM/chapters")).unwrap();
        fs::create_dir_all(project.join("QM/backups")).unwrap();
        fs::create_dir_all(project.join("QM/.t34c-temp")).unwrap();
        fs::write(project.join("QM/chapters/ch1.md"), "正文来自 QM").unwrap();
        fs::write(project.join("QM/backups/skip.zip"), b"must-not-pack").unwrap();
        fs::write(project.join("QM/.t34c-temp/skip.tmp"), b"must-not-pack").unwrap();
        fs::create_dir_all(project.join("wiki/chapters")).unwrap();
        fs::write(project.join("wiki/chapters/ch1.md"), "旧 wiki 不应被打包").unwrap();

        // snapshots / .qm-drafts / 顶层白名单书魂文档 + 非白名单顶层文件
        fs::create_dir_all(project.join(".novel/snapshots/snap-1")).unwrap();
        fs::write(
            project.join(".novel/snapshots/snap-1/meta.json"),
            r#"{"id":"snap-1"}"#,
        )
        .unwrap();
        fs::create_dir_all(project.join(".qm-drafts")).unwrap();
        fs::write(project.join(".qm-drafts/ch2-draft.md"), "草稿箱内容").unwrap();
        fs::write(project.join("soul.md"), "# Soul").unwrap();
        fs::write(project.join("schema.md"), "# Schema").unwrap();
        fs::write(project.join("purpose.md"), "# Purpose").unwrap();
        fs::write(project.join("secret-ignored.md"), "not in whitelist").unwrap();

        let out_dir = tmp_dir("v2-full-out");
        let zip = out_dir.join("v2-full.zip");
        let exported =
            export_project_impl_with_progress(&export_req(&project, &zip), None).unwrap();
        assert!(exported.success, "{:?}", exported.error);
        // 5 (status+2drafts+2lance) + 1 (QM/chapters/ch1.md) + 1 (snapshot) + 1 (qm-draft) + 3 (root-docs) = 11
        assert_eq!(exported.file_count, 11);

        // verify 返回完整 v2 盘点字段（含 camelCase 序列化核验）
        let verified = verify_export_impl(&CanonVerifyRequest {
            zip_path: zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(verified.success, "{:?}", verified.error);
        assert_eq!(verified.format_version, 2);
        assert_eq!(verified.component_counts.status, 1);
        assert_eq!(verified.component_counts.drafts, 2);
        assert_eq!(verified.component_counts.canon_lancedb, 2);
        assert_eq!(verified.component_counts.wiki, 1);
        assert_eq!(verified.component_counts.snapshots, 1);
        assert_eq!(verified.component_counts.qm_drafts, 1);
        assert_eq!(verified.component_counts.root_docs, 3);
        assert!(verified
            .created_at
            .as_deref()
            .is_some_and(|s| !s.is_empty()));
        assert!(verified
            .project_name
            .as_deref()
            .is_some_and(|s| !s.is_empty()));

        let v_json = serde_json::to_value(&verified).unwrap();
        assert_eq!(v_json["formatVersion"], 2);
        assert_eq!(v_json["componentCounts"]["canonLancedb"], 2);
        assert_eq!(v_json["componentCounts"]["qmDrafts"], 1);
        assert_eq!(v_json["componentCounts"]["rootDocs"], 3);

        // 恢复到空目标目录 → 默认落位到 QM/，全部 7 组件还原且非白名单文件不存在
        let fresh_target = tmp_dir("v2-fresh-target");
        let restored = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: fresh_target.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(restored.success, "{:?}", restored.error);
        assert_eq!(restored.format_version, 2);
        assert!(restored.restored_status);
        assert!(restored.restored_drafts);
        assert!(restored.restored_canon_lancedb);
        assert!(restored.restored_wiki);
        assert!(restored.restored_snapshots);
        assert!(restored.restored_qm_drafts);
        assert!(restored.restored_root_docs);
        assert_eq!(
            fs::read_to_string(fresh_target.join("QM/chapters/ch1.md")).unwrap(),
            "正文来自 QM"
        );
        assert!(!fresh_target.join("QM/backups/skip.zip").exists());
        assert!(!fresh_target.join("QM/.t34c-temp/skip.tmp").exists());
        assert_eq!(
            fs::read_to_string(fresh_target.join(".novel/snapshots/snap-1/meta.json")).unwrap(),
            r#"{"id":"snap-1"}"#
        );
        assert_eq!(
            fs::read_to_string(fresh_target.join(".qm-drafts/ch2-draft.md")).unwrap(),
            "草稿箱内容"
        );
        assert_eq!(
            fs::read_to_string(fresh_target.join("soul.md")).unwrap(),
            "# Soul"
        );
        assert_eq!(
            fs::read_to_string(fresh_target.join("schema.md")).unwrap(),
            "# Schema"
        );
        assert_eq!(
            fs::read_to_string(fresh_target.join("purpose.md")).unwrap(),
            "# Purpose"
        );
        assert!(!fresh_target.join("secret-ignored.md").exists());

        // 若目标仅存在 legacy wiki/ 且不存在 QM/，恢复应回写至 wiki/
        let legacy_target = tmp_dir("v2-legacy-wiki-target");
        fs::create_dir_all(legacy_target.join("wiki")).unwrap();
        fs::write(legacy_target.join("wiki/old.md"), "old").unwrap();
        let restored_legacy = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: legacy_target.to_string_lossy().to_string(),
                zip_path: zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(restored_legacy.success, "{:?}", restored_legacy.error);
        assert!(restored_legacy.restored_wiki);
        assert_eq!(
            fs::read_to_string(legacy_target.join("wiki/chapters/ch1.md")).unwrap(),
            "正文来自 QM"
        );
        assert!(!legacy_target.join("QM").exists());

        // 仅含 QM/ 的项目也应被 auto_backup 识别为有可备份状态
        let qm_only = tmp_dir("v2-qm-only");
        fs::create_dir_all(qm_only.join("QM")).unwrap();
        fs::write(qm_only.join("QM/ch1.md"), "only qm").unwrap();
        let ab = auto_backup_impl_with_progress(
            &CanonAutoBackupRequest {
                project_path: qm_only.to_string_lossy().to_string(),
                reason: "qm-only".to_string(),
            },
            None,
        )
        .unwrap();
        assert!(ab.success, "{:?}", ab.error);
    }

    // ── P0-03：v1 旧包向后兼容——恢复绝不删除或触碰现存 QM/snapshots/.qm-drafts/root-docs ──

    #[test]
    fn v1_restore_does_not_touch_existing_qm_snapshots_qm_drafts_or_root_docs() {
        // 手工构造严格 v1 格式备份包（format_version=1，manifest 仅含 3 个旧字段）
        let src = tmp_dir("v1-src");
        let v1_zip = src.join("legacy-v1.zip");
        let status_bytes = br#"{"step":"v1-restored","chapter":1}"#;
        let status_hex = sha256_hex(status_bytes);
        let mut content_h = Sha256::new();
        content_h.update(b"status/status.json\0");
        content_h.update((status_bytes.len() as u64).to_le_bytes());
        content_h.update(b"\0");
        content_h.update(status_hex.as_bytes());
        content_h.update(b"\n");
        let content_sha = hex(&content_h.finalize());

        {
            let f = fs::File::create(&v1_zip).unwrap();
            let mut zw = ZipWriter::new(f);
            zw.start_file("status/status.json", base_opts()).unwrap();
            zw.write_all(status_bytes).unwrap();
            let manifest_v1 = serde_json::json!({
                "kind": MANIFEST_KIND,
                "format_version": 1,
                "created_at": "2026-01-01T00:00:00Z",
                "app_version": "2.6.0",
                "project_name": "legacy-book",
                "components": { "status": true, "drafts": false, "canon_lancedb": false },
                "file_count": 1,
                "content_sha256": content_sha
            })
            .to_string();
            zw.start_file(MANIFEST_ENTRY, base_opts()).unwrap();
            zw.write_all(manifest_v1.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let zip_sha = stream_file_sha256(&v1_zip).unwrap();
        write_checksum_sidecar(&v1_zip, &zip_sha).unwrap();

        // 目标项目已拥有现存 QM / snapshots / .qm-drafts / soul.md
        let target = tmp_dir("v1-target");
        fs::create_dir_all(target.join(".novel/snapshots/s1")).unwrap();
        fs::create_dir_all(target.join("QM/chapters")).unwrap();
        fs::create_dir_all(target.join(".qm-drafts")).unwrap();
        fs::write(target.join(".novel/status.json"), r#"{"step":"current"}"#).unwrap();
        fs::write(target.join("QM/chapters/ch10.md"), "珍贵正文不得丢失").unwrap();
        fs::write(target.join(".novel/snapshots/s1/a.txt"), "快照不得丢失").unwrap();
        fs::write(target.join(".qm-drafts/d1.md"), "草稿箱不得丢失").unwrap();
        fs::write(target.join("soul.md"), "书魂不得丢失").unwrap();

        let v = verify_export_impl(&CanonVerifyRequest {
            zip_path: v1_zip.to_string_lossy().to_string(),
            expected_checksum: None,
            passphrase: None,
        })
        .unwrap();
        assert!(v.success, "{:?}", v.error);
        assert_eq!(v.format_version, 1);
        assert_eq!(v.component_counts.status, 1);
        assert_eq!(v.component_counts.wiki, 0);

        let r = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: target.to_string_lossy().to_string(),
                zip_path: v1_zip.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(r.success, "{:?}", r.error);
        assert_eq!(r.format_version, 1);
        assert!(r.restored_status);
        assert!(!r.restored_wiki);
        assert!(!r.restored_snapshots);
        assert!(!r.restored_qm_drafts);
        assert!(!r.restored_root_docs);
        assert_eq!(
            fs::read_to_string(target.join(".novel/status.json")).unwrap(),
            r#"{"step":"v1-restored","chapter":1}"#
        );
        // 现存书稿、快照、草稿箱、书魂全部毫发无损
        assert_eq!(
            fs::read_to_string(target.join("QM/chapters/ch10.md")).unwrap(),
            "珍贵正文不得丢失"
        );
        assert_eq!(
            fs::read_to_string(target.join(".novel/snapshots/s1/a.txt")).unwrap(),
            "快照不得丢失"
        );
        assert_eq!(
            fs::read_to_string(target.join(".qm-drafts/d1.md")).unwrap(),
            "草稿箱不得丢失"
        );
        assert_eq!(
            fs::read_to_string(target.join("soul.md")).unwrap(),
            "书魂不得丢失"
        );
    }

    // ── 契约 3：导出取消清理半成品 zip 与 sidecar 并返回 "备份已取消" ──

    #[test]
    fn export_cancel_cleans_up_partial_zip_and_sidecar() {
        let project = seed_project("cancel-test");
        // 写入 >128 KiB 文件，覆盖 copy_and_hash 64 KiB 分块取消路径
        fs::create_dir_all(project.join("QM")).unwrap();
        fs::write(project.join("QM/big.md"), vec![b'x'; 192 * 1024]).unwrap();

        let out_dir = tmp_dir("cancel-out");
        let zip = out_dir.join("cancelled.zip");
        // 预先放置残留 sidecar，确认取消后会连同半成品 zip 一起清理
        fs::write(sidecar_path(&zip), "stale-sidecar").unwrap();

        struct ResetGuard;
        impl Drop for ResetGuard {
            fn drop(&mut self) {
                reset_cancel();
            }
        }

        // 使用 GATE_TEST_LOCK → CANCEL_TEST_RWLOCK.write() 隔离全局标志，零串扰验证 request_cancel/reset_cancel
        let _gate_serial = crate::agent_gate::gate_test_serial();
        let _cancel_write = CANCEL_TEST_RWLOCK
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let _reset_guard = ResetGuard;
        request_cancel();

        let res = export_project_impl_with_cancel(
            &export_req(&project, &zip),
            None,
            Some(&CANON_EXPORT_CANCEL),
        )
        .unwrap();
        assert!(!res.success);
        assert_eq!(res.error.as_deref(), Some(BACKUP_CANCELLED_ERR));
        assert!(!zip.exists(), "取消后不得残留半成品 zip");
        assert!(!sidecar_path(&zip).exists(), "取消后不得残留 sidecar");

        // 直接验证 copy_and_hash 在流式拷贝途中响应取消标志
        let tmp_zip = out_dir.join("midstream.zip");
        let local_cancel = AtomicBool::new(true);
        let mut src = fs::File::open(project.join("QM/big.md")).unwrap();
        let dst = fs::File::create(&tmp_zip).unwrap();
        let mut zw = ZipWriter::new(dst);
        zw.start_file("wiki/big.md", base_opts()).unwrap();
        let err = copy_and_hash(&mut src, &mut zw, Some(&local_cancel)).unwrap_err();
        assert_eq!(err, BACKUP_CANCELLED_ERR);
        drop(zw);
        let _ = fs::remove_file(&tmp_zip);
    }

    // ── BLOCKING-2 & BLOCKING-R2-01：放行项目内 backups/exports/*.zip 沙箱与项目外 Backups/*.zip，硬拒绝数据区 ──

    #[tokio::test]
    async fn canon_export_with_state_rejects_protected_output_paths() {
        let _serial = crate::agent_gate::gate_test_serial_async().await;
        let project = seed_project("export-guard");
        crate::agent_gate::set_gate_project_root(project.clone());
        crate::agent_gate::__reset_state_for_test();

        let state = CanonCommandState::default();
        for bad_rel in [
            "QM/bad.zip",
            "wiki/bad.zip",
            ".novel/bad.zip",
            ".niko-buddy/bad.zip",
            ".qm-drafts/bad.zip",
            "backups/bad.zip",
            "backups/auto/bad.zip",
            "backups/.t34c-staging/bad.zip",
            "backups/exports/bad.txt",
            "backups/exports/.zip",
            "backups/exports/CON.zip",
            "backups/exports/../bad.zip",
            "backups./exports/bad.zip",
        ] {
            let bad_zip = project.join(bad_rel);
            let err = canon_export_with_state(None, Some(&state), export_req(&project, &bad_zip))
                .await
                .expect_err("输出落入受保护数据区或越出受控导出沙箱必须被拒绝");
            assert!(
                err.contains("安全拦截") || err.contains("PATH_INSIDE_DATA_SECTION"),
                "错误应指向数据区拦截 ({bad_rel}): {err}"
            );
            assert!(!bad_zip.exists());
        }

        // 1) MCP export.run 受控导出沙箱：<project>/backups/exports/run.zip 端到端成功
        let sandbox_zip = project.join("backups").join("exports").join("run.zip");
        let sandbox_res =
            canon_export_with_state(None, Some(&state), export_req(&project, &sandbox_zip))
                .await
                .expect("项目内 backups/exports/run.zip 应放行");
        assert!(sandbox_res.success, "{:?}", sandbox_res.error);
        assert!(sandbox_zip.is_file());
        assert!(sidecar_path(&sandbox_zip).is_file());
        let verified_sandbox = verify_export_impl(&CanonVerifyRequest {
            zip_path: sandbox_zip.to_string_lossy().to_string(),
            expected_checksum: sandbox_res.checksum_sha256.clone(),
            passphrase: None,
        })
        .unwrap();
        assert!(verified_sandbox.success, "{:?}", verified_sandbox.error);

        // 2) MCP export.run 受控子目录：<project>/backups/exports/sub/run2.zip 同样放行
        let sandbox_sub_zip = project
            .join("backups")
            .join("exports")
            .join("sub")
            .join("run2.zip");
        let sandbox_sub_res =
            canon_export_with_state(None, Some(&state), export_req(&project, &sandbox_sub_zip))
                .await
                .expect("项目内 backups/exports/sub/run2.zip 应放行");
        assert!(sandbox_sub_res.success, "{:?}", sandbox_sub_res.error);
        assert!(sandbox_sub_zip.is_file());

        // 3) 项目外合法目录（含 Backups 祖先名）：.../Backups/out.zip 端到端成功
        let ext_backups = tmp_dir("export-guard-ext").join("Backups");
        fs::create_dir_all(&ext_backups).unwrap();
        let ext_zip = ext_backups.join("out.zip");
        let ext_res = canon_export_with_state(None, Some(&state), export_req(&project, &ext_zip))
            .await
            .expect("项目外 Backups/out.zip 应放行");
        assert!(ext_res.success, "{:?}", ext_res.error);
        assert!(ext_zip.is_file());
        assert!(sidecar_path(&ext_zip).is_file());
    }

    // ── BLOCKING-R2-02：祖先目录（project / backups / .novel / backups/exports）符号链接与目录联接拦截 ──

    #[test]
    fn ancestor_symlink_or_junction_is_blocked_in_component_roots_restore_and_export() {
        fn make_dir_link(target: &Path, link: &Path) -> bool {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(target, link).is_ok()
            }
            #[cfg(windows)]
            {
                let link_win = link.to_string_lossy().replace('/', "\\");
                let target_win = target.to_string_lossy().replace('/', "\\");
                std::os::windows::fs::symlink_dir(target, link).is_ok()
                    || std::process::Command::new("cmd")
                        .args(["/c", "mklink", "/J", &link_win, &target_win])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .is_ok_and(|s| s.success())
            }
        }
        fn remove_dir_link(link: &Path) {
            #[cfg(windows)]
            {
                let _ = fs::remove_dir(link);
            }
            #[cfg(unix)]
            {
                let _ = fs::remove_file(link);
            }
        }

        // 先生成一份合法备份包用于测试恢复拦截
        let src_project = seed_project("symlink-src");
        let zip_path = tmp_dir("symlink-src-out").join("valid.zip");
        let exp =
            export_project_impl_with_progress(&export_req(&src_project, &zip_path), None).unwrap();
        assert!(exp.success, "{:?}", exp.error);

        // 1) 中间父目录 `.novel` 为符号链接/目录联接 → ComponentRoots 忽略 + restore 与 replace 均拒绝
        let outside_novel = tmp_dir("symlink-outside-novel");
        fs::create_dir_all(outside_novel.join("drafts")).unwrap();
        fs::create_dir_all(outside_novel.join("snapshots/s1")).unwrap();
        fs::write(outside_novel.join("status.json"), "outside-untouched").unwrap();
        fs::write(outside_novel.join("drafts/d.txt"), "outside-draft").unwrap();
        fs::write(outside_novel.join("snapshots/s1/a.txt"), "outside-snap").unwrap();

        let proj_novel_link = tmp_dir("symlink-proj-novel");
        let novel_link = proj_novel_link.join(".novel");
        assert!(
            make_dir_link(&outside_novel, &novel_link),
            "测试环境应能创建目录链接或 Windows Junction"
        );

        let roots = ComponentRoots::from_project(&proj_novel_link);
        assert!(roots.status.is_none(), ".novel 为符号链接时不得采纳 status");
        assert!(roots.drafts.is_none(), ".novel 为符号链接时不得采纳 drafts");
        assert!(
            roots.snapshots.is_none(),
            ".novel 为符号链接时不得采纳 snapshots"
        );

        let restored_novel = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: proj_novel_link.to_string_lossy().to_string(),
                zip_path: zip_path.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(!restored_novel.success);
        assert!(
            restored_novel
                .error
                .as_deref()
                .is_some_and(|e| e.contains("符号链接") || e.contains("重解析点")),
            "恢复到 .novel 符号链接祖先应报安全拦截: {:?}",
            restored_novel.error
        );
        assert_eq!(
            fs::read_to_string(outside_novel.join("status.json")).unwrap(),
            "outside-untouched",
            "不得穿透 .novel 符号链接覆盖外部文件"
        );

        // 直接测 replace_staged_components_with_rename 预检拦截：rename_fn 绝不可被调用
        let fake_staging = proj_novel_link.join("backups/.t34c-staging-sym");
        fs::create_dir_all(fake_staging.join("status")).unwrap();
        fs::write(fake_staging.join("status/status.json"), "new").unwrap();
        let mut rename_called = false;
        let mut warn = Vec::new();
        let rep = replace_staged_components_with_rename(
            &ManifestComponents {
                status: true,
                ..Default::default()
            },
            &fake_staging,
            &proj_novel_link,
            &proj_novel_link.join("backups"),
            "sym",
            &mut warn,
            |from: &Path, to: &Path| {
                rename_called = true;
                fs::rename(from, to)
            },
        );
        assert!(rep.error.is_some());
        assert!(!rename_called, "祖先链含符号链接时预检必须在换位前中止");
        remove_dir_link(&novel_link);

        // 2) `backups` 根目录为符号链接/目录联接 → restore 与 auto_backup 均在动目录前中止
        let outside_backups = tmp_dir("symlink-outside-backups");
        let proj_backups_link = tmp_dir("symlink-proj-backups");
        fs::create_dir_all(proj_backups_link.join("QM")).unwrap();
        fs::write(proj_backups_link.join("QM/ch1.md"), "正文").unwrap();
        let backups_link = proj_backups_link.join("backups");
        assert!(make_dir_link(&outside_backups, &backups_link));

        let restored_backups = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: proj_backups_link.to_string_lossy().to_string(),
                zip_path: zip_path.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(!restored_backups.success);
        assert!(
            restored_backups
                .error
                .as_deref()
                .is_some_and(|e| e.contains("符号链接") || e.contains("重解析点")),
            "backups 根目录为符号链接时应拒绝恢复: {:?}",
            restored_backups.error
        );
        assert_eq!(
            fs::read_dir(&outside_backups).unwrap().count(),
            0,
            "不得穿透 backups 符号链接写入 staging"
        );

        let ab = auto_backup_impl_with_progress(
            &CanonAutoBackupRequest {
                project_path: proj_backups_link.to_string_lossy().to_string(),
                reason: "symlink-backups".to_string(),
            },
            None,
        )
        .unwrap();
        assert!(!ab.success);
        assert!(
            ab.error
                .as_deref()
                .is_some_and(|e| e.contains("符号链接") || e.contains("重解析点")),
            "backups 为符号链接时 auto_backup 应拦截: {:?}",
            ab.error
        );
        remove_dir_link(&backups_link);

        // 3) `backups/exports` 为符号链接/目录联接 → 受控导出沙箱拒绝
        let proj_exp_link = tmp_dir("symlink-proj-exports");
        fs::create_dir_all(proj_exp_link.join("backups")).unwrap();
        let exports_link = proj_exp_link.join("backups").join("exports");
        assert!(make_dir_link(&outside_backups, &exports_link));
        assert!(
            assert_canon_export_output_path_safe(&proj_exp_link, &exports_link.join("escape.zip"))
                .is_err(),
            "backups/exports 为符号链接时受控导出沙箱必须拒绝"
        );
        remove_dir_link(&exports_link);

        // 4) `project` 本身为符号链接/目录联接 → ComponentRoots 与 restore 均拦截
        let proj_root_parent = tmp_dir("symlink-proj-root-parent");
        let proj_root_link = proj_root_parent.join("linked-project");
        assert!(make_dir_link(&src_project, &proj_root_link));
        assert!(
            !ComponentRoots::from_project(&proj_root_link).has_any(),
            "project 本身为符号链接时不得采纳任何组件"
        );
        let restored_root = restore_project_impl_with_progress(
            &CanonRestoreRequest {
                project_path: proj_root_link.to_string_lossy().to_string(),
                zip_path: zip_path.to_string_lossy().to_string(),
                expected_checksum: None,
                passphrase: None,
            },
            None,
        )
        .unwrap();
        assert!(!restored_root.success);
        remove_dir_link(&proj_root_link);
    }

    // ── NON_BLOCKING-R2-03：unique_suffix 单调无碰撞 ──

    #[test]
    fn unique_suffix_is_monotonic_and_collision_free() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            assert!(
                seen.insert(unique_suffix()),
                "连续调用 unique_suffix() 不得在低时钟分辨率下碰撞"
            );
        }
    }

    #[test]
    fn root_docs_whitelist_and_per_file_reverse_rollback() {
        let staging_canon = tmp_dir("rootdocs-wl").canonicalize().unwrap();
        assert!(safe_staging_target(&staging_canon, "root-docs/soul.md")
            .unwrap()
            .is_some());
        assert!(safe_staging_target(&staging_canon, "root-docs/schema.md")
            .unwrap()
            .is_some());
        assert!(safe_staging_target(&staging_canon, "root-docs/purpose.md")
            .unwrap()
            .is_some());
        assert!(
            safe_staging_target(&staging_canon, "root-docs/evil.md").is_err(),
            "非白名单 root-docs 文件必须被安全拦截"
        );
        assert!(
            safe_staging_target(&staging_canon, "root-docs/sub/soul.md").is_err(),
            "子目录 root-docs 必须被安全拦截"
        );

        // 逐文件 root-docs 逆序回滚：purpose.md 换位成功后 soul.md 失败 → purpose.md 自动回滚
        let project = tmp_dir("rootdocs-rb");
        let backups = project.join("backups");
        let staging = backups.join(".t34c-staging-rd");
        fs::create_dir_all(staging.join("root-docs")).unwrap();
        fs::write(project.join("purpose.md"), "old-purpose").unwrap();
        fs::write(project.join("soul.md"), "old-soul").unwrap();
        fs::write(staging.join("root-docs/purpose.md"), "new-purpose").unwrap();
        fs::write(staging.join("root-docs/soul.md"), "new-soul").unwrap();

        let soul_target = project.join("soul.md");
        let mut warnings = Vec::new();
        let outcome = replace_staged_components_with_rename(
            &ManifestComponents {
                root_docs: true,
                ..Default::default()
            },
            &staging,
            &project,
            &backups,
            "rd1",
            &mut warnings,
            |from: &Path, to: &Path| {
                if from == soul_target.as_path() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "soul.md locked",
                    ));
                }
                fs::rename(from, to)
            },
        );
        assert!(outcome.error.is_some());
        assert!(!outcome.restored_root_docs);
        assert_eq!(
            fs::read_to_string(project.join("purpose.md")).unwrap(),
            "old-purpose",
            "先前已换位的 purpose.md 必须被逆序回滚"
        );
        assert_eq!(
            fs::read_to_string(project.join("soul.md")).unwrap(),
            "old-soul"
        );
    }
}
