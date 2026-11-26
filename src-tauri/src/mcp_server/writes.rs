// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! 直写快照与回滚（方案 `d23eb1df` P3 安全网）。
//!
//! ## 为什么需要它
//!
//! P3 把 C-002 从「外部产物必须先进 Draft 域」修订为「外部直写必须**留痕且可回滚**」。
//! 事前拦截换成了事后追责，那么「事后能不能真的退回去」就是这条修订能否成立的
//! 全部前提——没有快照的直写权限等于把书稿置于不可恢复状态。
//!
//! ## 落点与格式
//!
//! 每个快照是 `.novel/snapshots/` 下的**一对**文件：
//! - `<id>.snap` —— 目标文件的原始字节，一个字节都不动（回滚要逐字节一致）；
//! - `<id>.meta.json` —— `{id, target, existed, hash, ts_ms, ts}`。
//!
//! 为什么不用单文件 JSON 内嵌内容：那需要 base64 编码，而 base64 往返是"逐字节
//! 一致"这条验收最容易悄悄破掉的地方（换行、BOM、非 UTF-8 字节）。原始字节单独
//! 存一份，回滚就是把 `<id>.snap` 复制回去，没有编码环节可出错。
//!
//! `existed=false` 表示快照时目标**还不存在**（新建文件）。回滚这种快照的正确
//! 动作是**删掉**目标文件，而不是写一个空文件——写空文件会留下一个 0 字节的
//! 章节，看起来像回滚成功了。
//!
//! ## 保留策略
//!
//! 最多 50 个且最多 7 天，先到者为准；**但永远保留最新的那一个**。最后半句是
//! 硬约束：「不得自动删到无法回滚最近一次」。所以哪怕最新快照已经放了 8 天，
//! 也留着——宁可多占一份磁盘，也不能让用户刚被写坏的文件没有退路。

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use crate::canon::write_authority::{
    classify_target, may_write, requires_snapshot, WriteDecision, WriteSource,
};
use crate::commands::fs::{write_atomic_physical_bytes, KNOWLEDGE_DIR};

/// 快照目录（项目相对）。
pub const SNAPSHOTS_DIR: &str = ".novel/snapshots";

/// 保留上限：最多这么多个。
pub const MAX_SNAPSHOTS: usize = 50;

/// 保留上限：最多这么久（秒）。
pub const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// 一个快照的引用（写进审计行的 `snapshot_ref`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRef {
    /// 快照 id（`snap_<ms>_<rand>`），同时是文件名前缀。
    pub id: String,
    /// 快照时的物理目标路径（保留 Windows 长路径前缀与分隔符）。
    pub target: String,
    /// 快照时目标是否存在。`false` = 新建文件，回滚要删除。
    pub existed: bool,
    /// 快照内容的 sha256（十六进制）。
    pub hash: String,
}

impl SnapshotRef {
    /// 审计行里的形态：`snap_...`（`id` 本身）。
    ///
    /// 只放 id 而不是完整路径：审计是 append-only 的，路径会随项目搬家失效，
    /// id 不会——回滚时按 id 在快照目录里找。
    pub fn audit_ref(&self) -> &str {
        &self.id
    }
}

/// sha256 十六进制（与 `mcp_server::tools` 的哈希口径一致）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn snapshots_dir(project: &Path) -> PathBuf {
    project.join(".novel").join("snapshots")
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.meta.json"))
}

fn body_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.snap"))
}

pub(super) fn canonical_project(project: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(project)
        .map_err(|e| format!("无法解析活动项目目录 {}: {e}", project.display()))?;
    if !root.is_dir() {
        return Err(format!("活动项目不是目录：{}", root.display()));
    }
    Ok(root)
}

/// 只把真正缺失的后缀补回已解析的祖先；悬空链接或无法访问的祖先不是缺失路径。
fn resolve_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(format!("找不到 {} 的现存祖先: {e}", path.display()));
                };
                missing.push(name);
                existing = parent;
            }
            Err(e) => return Err(format!("无法检查路径 {}: {e}", existing.display())),
        }
    }
    let mut resolved = fs::canonicalize(existing)
        .map_err(|e| format!("无法解析路径 {}: {e}", existing.display()))?;
    if !missing.is_empty() && !resolved.is_dir() {
        return Err(format!("路径祖先不是目录：{}", resolved.display()));
    }
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn require_regular_file_if_present(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err(format!("不是普通文件：{}", path.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("无法检查文件 {}: {e}", path.display())),
    }
}

/// `root` 是活动项目的规范路径。权限仅来自项目内的实际章节/记忆根和既有矩阵。
pub(super) fn resolve_external_truth_target(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.as_os_str().is_empty()
        || (!target.is_absolute()
            && (target.has_root()
                || matches!(target.components().next(), Some(Component::Prefix(_)))))
        || target.components().any(|part| match part {
            Component::ParentDir => true,
            // Windows 数据流不是独立的章节/记忆文件。
            Component::Normal(name) if cfg!(windows) => name.to_string_lossy().contains(':'),
            _ => false,
        })
    {
        return Err(format!("非法直写路径：{}", target.display()));
    }
    let candidate = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let actual = resolve_existing_ancestor(&candidate)?;
    let relative = actual
        .strip_prefix(root)
        .map_err(|_| format!("目标实际路径不在活动项目内：{}", target.display()))?;
    let matches_component = |component: Option<Component<'_>>, expected: &str| {
        let expected = std::ffi::OsStr::new(expected);
        matches!(component, Some(Component::Normal(name)) if
            name == expected || (cfg!(windows) && name.eq_ignore_ascii_case(expected)))
    };
    let mut parts = relative.components();
    let in_knowledge_dir = matches_component(parts.next(), KNOWLEDGE_DIR);
    let surface = parts.next();
    let in_truth_root =
        matches_component(surface, "chapters") || matches_component(surface, "memory");
    let source = WriteSource::ExternalAgent;
    if !in_knowledge_dir
        || !in_truth_root
        || parts.next().is_none()
        || may_write(source, relative) != WriteDecision::Allow
        || !requires_snapshot(source, classify_target(relative))
    {
        return Err(format!(
            "写入被权限范围拒绝：目标不在活动项目实际的 QM/chapters 或 QM/memory 真源面：{}",
            target.display()
        ));
    }
    require_regular_file_if_present(&actual)?;
    Ok(actual)
}

#[cfg(windows)]
fn same_anchored_path(a: &Path, b: &Path) -> bool {
    let mut ca = a.components();
    let mut cb = b.components();
    loop {
        match (ca.next(), cb.next()) {
            (None, None) => return true,
            (Some(Component::Prefix(pa)), Some(Component::Prefix(pb))) => {
                if !pa.as_os_str().eq_ignore_ascii_case(pb.as_os_str()) {
                    return false;
                }
            }
            (Some(Component::RootDir), Some(Component::RootDir))
            | (Some(Component::CurDir), Some(Component::CurDir))
            | (Some(Component::ParentDir), Some(Component::ParentDir)) => {}
            (Some(Component::Normal(sa)), Some(Component::Normal(sb))) => {
                if !sa.eq_ignore_ascii_case(sb) {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

#[cfg(not(windows))]
fn same_anchored_path(a: &Path, b: &Path) -> bool {
    a == b
}

/// 快照和 P3 审计只允许在规范项目根下的固定位置，不接受重定向。
fn anchored_state_path(path: &Path) -> Result<PathBuf, String> {
    let resolved = resolve_existing_ancestor(path)?;
    if !same_anchored_path(resolved.as_path(), path) {
        return Err(format!("项目状态路径不可重定向：{}", path.display()));
    }
    Ok(resolved)
}

fn state_file(path: &Path) -> Result<PathBuf, String> {
    let path = anchored_state_path(path)?;
    require_regular_file_if_present(&path)?;
    Ok(path)
}

pub(super) fn external_audit_path(project: &Path) -> Result<PathBuf, String> {
    let root = canonical_project(project)?;
    state_file(
        &root
            .join(".novel")
            .join("audit")
            .join("external-writes.jsonl"),
    )
}

fn valid_snapshot_id(id: &str) -> bool {
    id.strip_prefix("snap_").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
}

fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.as_bytes().iter().all(u8::is_ascii_hexdigit)
}

fn write_new_snapshot_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("无法创建快照文件 {}: {e}", path.display()))?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    result.map_err(|e| {
        let mut message = format!("无法写入或同步快照文件 {}: {e}", path.display());
        if let Err(cleanup) = fs::remove_file(path) {
            message.push_str(&format!("；清理未完成快照文件失败: {cleanup}"));
        }
        message
    })
}

/// 为一个目标文件建立快照。
///
/// 目标不存在时仍会建快照（`existed=false`）——这很重要：新建文件的回滚动作是
/// 删除，而"删除"这个动作本身也需要有记录才知道该删什么。
pub fn create_snapshot(project: &Path, target: &Path) -> Result<SnapshotRef, String> {
    let root = canonical_project(project)?;
    let dir = anchored_state_path(&snapshots_dir(&root))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建快照目录 {}: {e}", dir.display()))?;
    let target_text = target
        .to_str()
        .ok_or_else(|| format!("快照目标无法无损记录为文本：{}", target.display()))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let id = format!("snap_{now}_{}", short_rand());

    let (bytes, existed) = match fs::read(target) {
        Ok(bytes) => (bytes, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), false),
        Err(e) => {
            return Err(format!(
                "读取目标失败，无法建立快照（{}）: {e}；为安全起见本次写入未执行",
                target.display()
            ))
        }
    };
    let hash = sha256_hex(&bytes);

    // 先写内容再写 meta：反过来会出现"有 meta 没内容"的半个快照，
    // 而回滚时按 meta 去找内容就会炸。
    let meta = serde_json::json!({
        "id": id,
        "target": target_text,
        "existed": existed,
        "hash": hash,
        "ts_ms": now,
        "ts": chrono::Utc::now().to_rfc3339(),
    });
    let meta_text =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("快照元数据序列化失败: {e}"))?;
    let body = body_path(&dir, &id);
    write_new_snapshot_file(&body, &bytes)?;
    if let Err(e) = write_new_snapshot_file(&meta_path(&dir, &id), meta_text.as_bytes()) {
        return Err(match fs::remove_file(&body) {
            Ok(()) => e,
            Err(cleanup) => format!("{e}；清理未完成快照内容失败: {cleanup}"),
        });
    }

    Ok(SnapshotRef {
        id,
        target: target_text.to_owned(),
        existed,
        hash,
    })
}

#[derive(serde::Deserialize)]
struct SnapshotMetadata {
    id: String,
    target: String,
    existed: bool,
    hash: String,
}

/// 按审计绑定的身份还原快照，仅在目标仍持有该次写入的字节时修改，且验证回读。
/// 读校验与替换/删除是分开的系统调用，不构成跨进程 CAS。
pub fn restore_snapshot(
    project: &Path,
    snapshot_id: &str,
    audited_target: &Path,
    expected_before_hash: &str,
    expected_written_hash: &str,
) -> Result<RestoredSnapshot, String> {
    if !valid_snapshot_id(snapshot_id) {
        return Err("非法快照 id".into());
    }
    if !valid_sha256(expected_written_hash)
        || (expected_before_hash != "absent" && !valid_sha256(expected_before_hash))
    {
        return Err("审计缺少有效的写入前后哈希，拒绝回滚".into());
    }

    let root = canonical_project(project)?;
    let dir = anchored_state_path(&snapshots_dir(&root))?;
    let meta_file = state_file(&meta_path(&dir, snapshot_id))?;
    let meta_text = fs::read_to_string(&meta_file)
        .map_err(|e| format!("找不到快照 {}（{}）: {e}", snapshot_id, meta_file.display()))?;
    let meta: SnapshotMetadata = serde_json::from_str(&meta_text)
        .map_err(|e| format!("快照元数据损坏 {snapshot_id}: {e}"))?;
    if meta.id != snapshot_id || !valid_sha256(&meta.hash) {
        return Err(format!("快照 {snapshot_id} 的元数据 id 或 hash 无效"));
    }

    let target = resolve_external_truth_target(&root, audited_target)?;
    let snapshot_target = resolve_external_truth_target(&root, Path::new(&meta.target))?;
    if target != snapshot_target {
        return Err(format!(
            "快照 {snapshot_id} 的目标与审计目标不一致，拒绝回滚"
        ));
    }
    let target_text = target
        .to_str()
        .ok_or_else(|| format!("回滚目标无法无损记录为文本：{}", target.display()))?;

    let body = state_file(&body_path(&dir, snapshot_id))?;
    let bytes = fs::read(&body).map_err(|e| {
        format!(
            "快照 {} 的内容文件缺失或不可读（{}）: {e}",
            snapshot_id,
            body.display()
        )
    })?;
    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(&meta.hash) {
        return Err(format!(
            "快照 {snapshot_id} 自身已损坏（记录 hash {}，实际 {actual}），拒绝用它回滚",
            meta.hash
        ));
    }
    let original_matches = if meta.existed {
        actual.eq_ignore_ascii_case(expected_before_hash)
    } else {
        expected_before_hash == "absent" && bytes.is_empty()
    };
    if !original_matches {
        return Err(format!(
            "快照 {snapshot_id} 的原始内容身份与审计不一致，拒绝回滚"
        ));
    }

    let current = fs::read(&target)
        .map_err(|e| format!("回滚冲突：目标 {} 不存在或无法回读: {e}", target.display()))?;
    if !sha256_hex(&current).eq_ignore_ascii_case(expected_written_hash) {
        return Err(format!(
            "回滚冲突：{} 已不是审计中本次直写的内容，未改动目标",
            target.display()
        ));
    }

    if meta.existed {
        write_atomic_physical_bytes(&target, &bytes)?;
        let written = fs::read(&target)
            .map_err(|e| format!("回滚后无法回读 {} 以校验: {e}", target.display()))?;
        if written != bytes {
            return Err(format!(
                "回滚后校验失败：{} 的字节与快照不一致，请手工核对",
                target.display()
            ));
        }
    } else {
        crate::commands::fs::remove_regular_file_if_unchanged(&target, &current)?;
    }

    Ok(RestoredSnapshot {
        target: target_text.to_owned(),
        existed: meta.existed,
        hash: actual,
        bytes: bytes.len(),
    })
}

/// 一次成功回滚的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredSnapshot {
    pub target: String,
    /// 快照记录里目标当时是否存在。
    pub existed: bool,
    /// 还原后的内容 hash（与快照记录的 hash 一致，否则不会返回 Ok）。
    pub hash: String,
    pub bytes: usize,
}

/// 一份快照的元信息（保留策略与列表用）。
#[derive(Debug, Clone)]
pub struct SnapshotEntry {
    pub id: String,
    pub ts_ms: u64,
}

/// 列出全部快照，按时间**降序**（最新在前）。
pub fn list_snapshots(project: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let root = canonical_project(project)?;
    let dir = anchored_state_path(&snapshots_dir(&root))?;
    list_snapshot_entries(&dir)
}

fn list_snapshot_entries(dir: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("无法读取快照目录 {}: {e}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| format!("无法枚举快照目录 {}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name
            .strip_suffix(".meta.json")
            .filter(|id| valid_snapshot_id(id))
        else {
            continue;
        };
        let meta_path = state_file(&entry.path())?;
        let text = fs::read_to_string(&meta_path)
            .map_err(|e| format!("无法读取快照元数据 {}: {e}", meta_path.display()))?;
        let ts_ms = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|meta| meta.get("ts_ms").and_then(|v| v.as_u64()))
            .unwrap_or(0);
        out.push(SnapshotEntry {
            id: id.to_string(),
            ts_ms,
        });
    }
    out.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms).then_with(|| b.id.cmp(&a.id)));
    Ok(out)
}

/// 按保留策略裁剪快照，返回被删掉的 id。
///
/// 规则：最多 [`MAX_SNAPSHOTS`] 个、最多 [`MAX_AGE_SECS`] 秒，先到者为准；
/// **索引 0（最新）永不删除**。
pub fn prune_snapshots(project: &Path, now_ms: u64) -> Result<Vec<String>, String> {
    let root = canonical_project(project)?;
    let dir = anchored_state_path(&snapshots_dir(&root))?;
    let entries = list_snapshot_entries(&dir)?;
    let mut removed = Vec::new();
    for (rank, entry) in entries.iter().enumerate() {
        if rank == 0 {
            // 「不得自动删到无法回滚最近一次」——最新那份无论多旧都留着。
            continue;
        }
        let too_many = rank >= MAX_SNAPSHOTS;
        let too_old = now_ms.saturating_sub(entry.ts_ms) > MAX_AGE_SECS * 1000;
        if !too_many && !too_old {
            continue;
        }
        let meta = state_file(&meta_path(&dir, &entry.id))?;
        let body = state_file(&body_path(&dir, &entry.id))?;
        for path in [body, meta] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(format!("无法裁剪快照文件 {}: {e}", path.display())),
            }
        }
        removed.push(entry.id.clone());
    }
    Ok(removed)
}

/// 当前时间（unix 毫秒），保留策略的裁剪基准。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn short_rand() -> String {
    uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempProject(PathBuf);

    impl TempProject {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nb-snap-{tag}-{}-{}",
                std::process::id(),
                short_rand()
            ));
            std::fs::create_dir_all(&dir).expect("create temp project");
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn snapshot_then_restore_is_byte_exact() {
        let project = TempProject::new("restore");
        let target = project.path().join("QM").join("chapters").join("ch-01.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // 故意包含 CRLF、BOM、非 UTF-8 字节：逐字节一致这条验收必须能扛住这些。
        let original: Vec<u8> = vec![
            0xEF, 0xBB, 0xBF, b'a', b'\r', b'\n', b'b', 0xFF, 0x00, b'\n',
        ];
        std::fs::write(&target, &original).unwrap();

        let snap = create_snapshot(project.path(), &target).unwrap();
        assert!(snap.existed);
        assert_eq!(snap.hash, sha256_hex(&original));

        let written = b"audited bytes\r\n\xFF";
        std::fs::write(&target, written).unwrap();
        let restored = restore_snapshot(
            project.path(),
            &snap.id,
            &target,
            &snap.hash.to_ascii_uppercase(),
            &sha256_hex(written).to_ascii_uppercase(),
        )
        .unwrap();
        assert!(restored.existed);
        assert_eq!(restored.hash, snap.hash);
        // 逐字节一致，不是"文本看起来一样"。
        assert_eq!(std::fs::read(&target).unwrap(), original);
    }

    #[test]
    fn snapshot_of_absent_file_restores_by_deleting() {
        let project = TempProject::new("absent");
        let target = project
            .path()
            .join("QM")
            .join("memory")
            .join("new-entry.md");

        let snap = create_snapshot(project.path(), &target).unwrap();
        assert!(!snap.existed, "目标不存在时快照必须记 existed=false");

        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let written = b"new audited record";
        std::fs::write(&target, written).unwrap();
        let restored = restore_snapshot(
            project.path(),
            &snap.id,
            &target,
            "absent",
            &sha256_hex(written),
        )
        .unwrap();
        assert!(!restored.existed);
        assert!(!target.exists(), "回滚新建文件必须删除它，而不是留个空文件");
    }

    #[test]
    fn restore_rejects_unknown_snapshot() {
        let project = TempProject::new("unknown");
        let target = project.path().join("QM").join("memory").join("unknown.md");
        let err = restore_snapshot(
            project.path(),
            "snap_nope",
            &target,
            "absent",
            &sha256_hex(b"x"),
        )
        .unwrap_err();
        assert!(err.contains("找不到快照"), "错误要说清找不到什么: {err}");
    }

    #[test]
    fn restore_refuses_corrupted_snapshot() {
        let project = TempProject::new("corrupt");
        let target = project.path().join("QM").join("chapters").join("x.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"v1").unwrap();
        let snap = create_snapshot(project.path(), &target).unwrap();
        std::fs::write(&target, b"v2").unwrap();

        // 快照内容被人动过：不能拿它去覆盖真源。
        let dir = snapshots_dir(project.path());
        std::fs::write(body_path(&dir, &snap.id), b"tampered").unwrap();
        let err = restore_snapshot(
            project.path(),
            &snap.id,
            &target,
            &snap.hash,
            &sha256_hex(b"v2"),
        )
        .unwrap_err();
        assert!(err.contains("自身已损坏"), "错误要说清是快照坏了: {err}");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"v2",
            "拒绝回滚时不得动目标"
        );
    }

    #[test]
    fn restore_refuses_later_edits_and_does_not_recreate_missing_target() {
        let project = TempProject::new("later");
        let dir = project.path().join("QM").join("chapters");
        std::fs::create_dir_all(&dir).unwrap();
        let written = b"audited";
        let later = b"\xEF\xBB\xBFlater edit\xFF";
        for existed in [true, false] {
            let target = dir.join(format!("{existed}.md"));
            if existed {
                std::fs::write(&target, b"original").unwrap();
            }
            let snap = create_snapshot(project.path(), &target).unwrap();
            let before = if existed {
                snap.hash.as_str()
            } else {
                "absent"
            };
            std::fs::write(&target, later).unwrap();
            let restore = || {
                restore_snapshot(
                    project.path(),
                    &snap.id,
                    &target,
                    before,
                    &sha256_hex(written),
                )
            };
            assert!(restore().unwrap_err().contains("回滚冲突"));
            assert_eq!(std::fs::read(&target).unwrap(), later);

            std::fs::remove_file(&target).unwrap();
            assert!(restore().unwrap_err().contains("回滚冲突"));
            assert!(!target.exists());
        }
    }

    #[test]
    fn restore_requires_bound_audited_target_before_hash_and_metadata_id() {
        let project = TempProject::new("identity");
        let dir = project.path().join("QM").join("memory");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("a.md");
        let unrelated = dir.join("b.md");
        std::fs::write(&target, b"original").unwrap();
        let snap = create_snapshot(project.path(), &target).unwrap();
        std::fs::write(&target, b"same audit bytes").unwrap();
        std::fs::write(&unrelated, b"same audit bytes").unwrap();
        let write_hash = sha256_hex(b"same audit bytes");

        let wrong_target = restore_snapshot(
            project.path(),
            &snap.id,
            &unrelated,
            &snap.hash,
            &write_hash,
        )
        .unwrap_err();
        assert!(
            wrong_target.contains("目标与审计目标不一致"),
            "{wrong_target}"
        );
        let wrong_before =
            restore_snapshot(project.path(), &snap.id, &target, "absent", &write_hash).unwrap_err();
        assert!(
            wrong_before.contains("原始内容身份与审计不一致"),
            "{wrong_before}"
        );

        let meta_file = meta_path(&snapshots_dir(project.path()), &snap.id);
        let mut meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&meta_file).unwrap()).unwrap();
        meta["id"] = serde_json::json!("snap_unrelated");
        std::fs::write(&meta_file, serde_json::to_vec(&meta).unwrap()).unwrap();
        let wrong_id = restore_snapshot(project.path(), &snap.id, &target, &snap.hash, &write_hash)
            .unwrap_err();
        assert!(wrong_id.contains("元数据 id 或 hash 无效"), "{wrong_id}");
        assert_eq!(std::fs::read(&target).unwrap(), b"same audit bytes");
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"same audit bytes");
    }

    #[test]
    fn restore_does_not_delete_when_absent_snapshot_has_invalid_body_or_audit() {
        let project = TempProject::new("invalid-absent");
        let target = project.path().join("QM").join("memory").join("x.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let snap = create_snapshot(project.path(), &target).unwrap();
        std::fs::write(&target, b"new audited body").unwrap();
        let write_hash = sha256_hex(b"new audited body");

        let err = restore_snapshot(project.path(), &snap.id, &target, &snap.hash, &write_hash)
            .unwrap_err();
        assert!(err.contains("原始内容身份与审计不一致"), "{err}");

        let dir = snapshots_dir(project.path());
        let meta_file = meta_path(&dir, &snap.id);
        let mut meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&meta_file).unwrap()).unwrap();
        let nonempty = b"not an absent snapshot";
        std::fs::write(body_path(&dir, &snap.id), nonempty).unwrap();
        meta["hash"] = serde_json::json!(sha256_hex(nonempty));
        std::fs::write(meta_file, serde_json::to_vec(&meta).unwrap()).unwrap();
        let err =
            restore_snapshot(project.path(), &snap.id, &target, "absent", &write_hash).unwrap_err();
        assert!(err.contains("原始内容身份与审计不一致"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"new audited body");
    }

    #[test]
    fn restore_fails_closed_on_unrecognized_ids_or_audit_hashes() {
        let project = TempProject::new("invalid-id");
        let target = project.path().join("QM").join("chapters").join("x.md");
        let hash = sha256_hex(b"x");
        for id in ["", "snap_", "snap_a/b", "snap_a\\b", "snap_章节"] {
            let err = restore_snapshot(project.path(), id, &target, "absent", &hash).unwrap_err();
            assert!(err.contains("非法快照 id"), "{err}");
        }
        for (before, after) in [
            ("", hash.as_str()),
            ("absent", "absent"),
            ("absent", "short"),
        ] {
            let err =
                restore_snapshot(project.path(), "snap_ok", &target, before, after).unwrap_err();
            assert!(err.contains("审计缺少有效"), "{err}");
        }
    }

    #[test]
    fn restore_requires_actual_project_and_truth_surface() {
        let project = TempProject::new("scope");
        let other = TempProject::new("other-scope");
        for (target, diagnostic) in [
            (
                project.path().join("QM").join("reference").join("x.md"),
                "真源面",
            ),
            (
                other.path().join("QM").join("chapters").join("x.md"),
                "不在活动项目内",
            ),
        ] {
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, b"original").unwrap();
            let snap = create_snapshot(project.path(), &target).unwrap();
            std::fs::write(&target, b"audited").unwrap();
            let err = restore_snapshot(
                project.path(),
                &snap.id,
                &target,
                &snap.hash,
                &sha256_hex(b"audited"),
            )
            .unwrap_err();
            assert!(err.contains(diagnostic), "{err}");
            assert_eq!(std::fs::read(&target).unwrap(), b"audited");
        }
    }

    #[cfg(unix)]
    #[test]
    fn prospective_truth_path_rejects_ancestor_resolved_outside_project() {
        let project = TempProject::new("prospective");
        let other = TempProject::new("prospective-other");
        let root = canonical_project(project.path()).unwrap();
        let relative = Path::new("QM/chapters/deep/new.md");
        assert_eq!(
            resolve_external_truth_target(&root, relative).unwrap(),
            root.join(relative)
        );
        std::fs::create_dir(root.join("QM")).unwrap();
        std::os::unix::fs::symlink(other.path(), root.join("QM").join("chapters")).unwrap();
        let err = resolve_external_truth_target(&root, relative).unwrap_err();
        assert!(err.contains("不在活动项目内"), "{err}");
        assert!(!other.path().join("deep").exists());
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_redirected_snapshot_artifact_or_directory() {
        let project = TempProject::new("redirected");
        let other = TempProject::new("redirected-other");
        let target = project.path().join("QM").join("chapters").join("x.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"original").unwrap();
        let snap = create_snapshot(project.path(), &target).unwrap();
        std::fs::write(&target, b"audited").unwrap();
        let attempt = || {
            restore_snapshot(
                project.path(),
                &snap.id,
                &target,
                &snap.hash,
                &sha256_hex(b"audited"),
            )
        };

        let dir = snapshots_dir(project.path());
        let body = body_path(&dir, &snap.id);
        let payload = other.path().join("payload.snap");
        std::fs::rename(&body, &payload).unwrap();
        std::os::unix::fs::symlink(&payload, &body).unwrap();
        assert!(attempt().unwrap_err().contains("状态路径不可重定向"));
        assert_eq!(std::fs::read(&target).unwrap(), b"audited");
        std::fs::remove_file(&body).unwrap();
        std::fs::rename(&payload, &body).unwrap();

        let relocated = other.path().join("snapshots");
        std::fs::rename(&dir, &relocated).unwrap();
        std::os::unix::fs::symlink(&relocated, &dir).unwrap();
        assert!(attempt().unwrap_err().contains("状态路径不可重定向"));
        assert_eq!(std::fs::read(&target).unwrap(), b"audited");
    }

    #[test]
    fn prune_keeps_at_most_fifty_and_never_the_newest() {
        let project = TempProject::new("prune50");
        let target = project.path().join("canon").join("ch.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"x").unwrap();

        let mut ids = Vec::new();
        for _ in 0..55 {
            ids.push(create_snapshot(project.path(), &target).unwrap().id);
            // 保证 ts_ms 单调递增（同一毫秒内建 55 个会打乱排序）。
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let removed = prune_snapshots(project.path(), now_ms()).unwrap();
        assert_eq!(removed.len(), 5, "55 个应裁到 50 个");
        let left = list_snapshots(project.path()).unwrap();
        assert_eq!(left.len(), MAX_SNAPSHOTS);
        // 最新的那份必须还在。
        assert_eq!(left[0].id, ids[ids.len() - 1]);
    }

    #[test]
    fn prune_drops_expired_but_keeps_the_newest_forever() {
        let project = TempProject::new("prune7d");
        let target = project.path().join("canon").join("ch.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"x").unwrap();

        let old = create_snapshot(project.path(), &target).unwrap().id;
        std::thread::sleep(std::time::Duration::from_millis(2));
        let newest = create_snapshot(project.path(), &target).unwrap().id;

        // 时间推进到 8 天后：两份都过期，但最新那份必须留下。
        let future = now_ms() + (MAX_AGE_SECS + 24 * 3600) * 1000;
        let removed = prune_snapshots(project.path(), future).unwrap();
        assert_eq!(removed, vec![old], "过期的旧快照应被删");
        let left = list_snapshots(project.path()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, newest, "最新快照无论多旧都必须留着");
    }

    #[test]
    fn prune_on_missing_dir_is_not_an_error() {
        let project = TempProject::new("nodir");
        assert!(list_snapshots(project.path()).unwrap().is_empty());
        assert!(prune_snapshots(project.path(), now_ms())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn audit_ref_is_the_id() {
        let project = TempProject::new("ref");
        let target = project.path().join("canon").join("ch.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"x").unwrap();
        let snap = create_snapshot(project.path(), &target).unwrap();
        assert_eq!(snap.audit_ref(), snap.id);
        assert!(snap.id.starts_with("snap_"));
        assert_eq!(
            snap.target.replace('\\', "/"),
            target.to_string_lossy().replace('\\', "/")
        );
    }

    #[test]
    fn same_anchored_path_matches_exact_and_rejects_redirect() {
        assert!(same_anchored_path(
            Path::new("/proj/.novel/snapshots"),
            Path::new("/proj/.novel/snapshots"),
        ));
        assert!(!same_anchored_path(
            Path::new("/proj/.novel/snapshots"),
            Path::new("/other/.novel/snapshots"),
        ));
        assert!(!same_anchored_path(
            Path::new("/proj/.novel/snapshots"),
            Path::new("/proj/.novel/snapshots/extra"),
        ));
    }

    #[cfg(windows)]
    #[test]
    fn anchored_state_path_ignores_ascii_case_and_rejects_junction_redirect() {
        assert!(same_anchored_path(
            Path::new(r"\\?\C:\Work\Proj\.NOVEL\Snapshots"),
            Path::new(r"\\?\c:\work\proj\.novel\snapshots"),
        ));
        assert!(!same_anchored_path(
            Path::new(r"\\?\C:\Work\Other\.novel\snapshots"),
            Path::new(r"\\?\C:\Work\Proj\.novel\snapshots"),
        ));

        // 真实磁盘目录存在不同 ASCII 大小写（.NOVEL / SNAPSHOTS / AUDIT）时，anchored_state_path 必须放行。
        let project = TempProject::new("win-case");
        std::fs::create_dir_all(project.path().join(".NOVEL").join("SNAPSHOTS")).unwrap();
        std::fs::create_dir_all(project.path().join(".NOVEL").join("AUDIT")).unwrap();
        let target = project.path().join("QM").join("chapters").join("ch1.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"hello").unwrap();

        let snap = create_snapshot(project.path(), &target)
            .expect("Windows 上目录大小写差异不得误报状态路径重定向");
        assert!(snap.id.starts_with("snap_"));
        assert!(
            external_audit_path(project.path()).is_ok(),
            "Windows 上 .NOVEL/AUDIT 大小写差异不得误报状态路径重定向"
        );

        // 真实 junction 重定向到项目外目录时仍必须被拒绝。
        let redirected_proj = TempProject::new("win-junction");
        let outside = TempProject::new("win-junction-outside");
        let novel_dir = redirected_proj.path().join(".novel");
        std::fs::create_dir_all(&novel_dir).unwrap();
        let snap_link = novel_dir.join("snapshots");
        let linked = std::os::windows::fs::symlink_dir(outside.path(), &snap_link).is_ok()
            || std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    &snap_link.to_string_lossy(),
                    &outside.path().to_string_lossy(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
        assert!(linked, "Windows 测试应能建立目录联接或符号链接");

        let root = canonical_project(redirected_proj.path()).unwrap();
        let err = anchored_state_path(&snapshots_dir(&root)).unwrap_err();
        assert!(err.contains("项目状态路径不可重定向"), "{err}");
        let _ = std::fs::remove_dir(&snap_link);
    }
}
