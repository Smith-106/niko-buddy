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

use std::path::{Path, PathBuf};

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
    /// 快照时的目标路径（POSIX 分隔符）。
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

/// 为一个目标文件建立快照。
///
/// 目标不存在时仍会建快照（`existed=false`）——这很重要：新建文件的回滚动作是
/// 删除，而"删除"这个动作本身也需要有记录才知道该删什么。
pub fn create_snapshot(project: &Path, target: &Path) -> Result<SnapshotRef, String> {
    let dir = snapshots_dir(project);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建快照目录 {}: {e}", dir.display()))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let id = format!("snap_{now}_{}", short_rand());

    let (bytes, existed) = match std::fs::read(target) {
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
    std::fs::write(body_path(&dir, &id), &bytes)
        .map_err(|e| format!("快照内容写入失败 {}: {e}", body_path(&dir, &id).display()))?;
    let meta = serde_json::json!({
        "id": id,
        "target": target.to_string_lossy().replace('\\', "/"),
        "existed": existed,
        "hash": hash,
        "ts_ms": now,
        "ts": chrono::Utc::now().to_rfc3339(),
    });
    let meta_text =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("快照元数据序列化失败: {e}"))?;
    std::fs::write(meta_path(&dir, &id), meta_text)
        .map_err(|e| format!("快照元数据写入失败 {}: {e}", meta_path(&dir, &id).display()))?;

    Ok(SnapshotRef {
        id,
        target: target.to_string_lossy().replace('\\', "/"),
        existed,
        hash,
    })
}

/// 把某个快照还原到它的目标路径，并**校验还原结果**。
///
/// 校验是这里唯一不能省的一步：`fs::write` 成功不等于内容对了（磁盘满、杀软改写、
/// 路径指向了别处都可能让它"成功"）。还原后重算 hash 与快照记录比对，不一致就
/// 报错——**绝不假装回滚成功**。
pub fn restore_snapshot(project: &Path, snapshot_id: &str) -> Result<RestoredSnapshot, String> {
    let dir = snapshots_dir(project);
    let meta_file = meta_path(&dir, snapshot_id);
    let meta_text = std::fs::read_to_string(&meta_file)
        .map_err(|e| format!("找不到快照 {}（{}）: {e}", snapshot_id, meta_file.display()))?;
    let meta: serde_json::Value = serde_json::from_str(&meta_text)
        .map_err(|e| format!("快照元数据损坏 {snapshot_id}: {e}"))?;

    let target_raw = meta
        .get("target")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("快照 {snapshot_id} 缺少 target 字段"))?;
    let target = PathBuf::from(target_raw);
    let existed = meta
        .get("existed")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("快照 {snapshot_id} 缺少 existed 字段"))?;
    let expected_hash = meta
        .get("hash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("快照 {snapshot_id} 缺少 hash 字段"))?
        .to_string();

    if !existed {
        // 快照时文件不存在 → 回滚就是删掉它。
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "回滚失败：应删除新建的 {}，但删除出错: {e}",
                    target.display()
                ))
            }
        }
        return Ok(RestoredSnapshot {
            target: target_raw.to_string(),
            existed: false,
            hash: expected_hash,
            bytes: 0,
        });
    }

    let bytes = std::fs::read(body_path(&dir, snapshot_id)).map_err(|e| {
        format!(
            "快照 {} 的内容文件缺失或不可读（{}）: {e}",
            snapshot_id,
            body_path(&dir, snapshot_id).display()
        )
    })?;
    let actual = sha256_hex(&bytes);
    if actual != expected_hash {
        return Err(format!(
            "快照 {snapshot_id} 自身已损坏（记录 hash {expected_hash}，实际 {actual}），拒绝用它回滚"
        ));
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("回滚时无法创建目录 {}: {e}", parent.display()))?;
    }
    std::fs::write(&target, &bytes)
        .map_err(|e| format!("回滚写入失败 {}: {e}", target.display()))?;

    // 落盘后再读一次校验：确认磁盘上真的就是快照里那份字节。
    let written = std::fs::read(&target)
        .map_err(|e| format!("回滚后无法回读 {} 以校验: {e}", target.display()))?;
    let written_hash = sha256_hex(&written);
    if written_hash != expected_hash {
        return Err(format!(
            "回滚后校验失败：{} 的内容 hash 是 {written_hash}，期望 {expected_hash}。文件可能已被其他进程改动，请手工核对。",
            target.display()
        ));
    }

    Ok(RestoredSnapshot {
        target: target_raw.to_string(),
        existed: true,
        hash: written_hash,
        bytes: written.len(),
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
    let dir = snapshots_dir(project);
    let read = match std::fs::read_dir(&dir) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("无法读取快照目录 {}: {e}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".meta.json") else {
            continue;
        };
        let ts_ms = std::fs::read_to_string(entry.path())
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
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
    let entries = list_snapshots(project)?;
    let dir = snapshots_dir(project);
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
        let _ = std::fs::remove_file(meta_path(&dir, &entry.id));
        let _ = std::fs::remove_file(body_path(&dir, &entry.id));
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
        let target = project.path().join("canon").join("ch-01.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // 故意包含 CRLF、BOM、非 UTF-8 字节：逐字节一致这条验收必须能扛住这些。
        let original: Vec<u8> = vec![
            0xEF, 0xBB, 0xBF, b'a', b'\r', b'\n', b'b', 0xFF, 0x00, b'\n',
        ];
        std::fs::write(&target, &original).unwrap();

        let snap = create_snapshot(project.path(), &target).unwrap();
        assert!(snap.existed);
        assert_eq!(snap.hash, sha256_hex(&original));

        // 外部 Agent 改坏它。
        std::fs::write(&target, b"rewritten by an external agent").unwrap();
        assert_ne!(sha256_hex(&std::fs::read(&target).unwrap()), snap.hash);

        let restored = restore_snapshot(project.path(), &snap.id).unwrap();
        assert!(restored.existed);
        assert_eq!(restored.hash, snap.hash);
        // 逐字节一致，不是"文本看起来一样"。
        assert_eq!(std::fs::read(&target).unwrap(), original);
    }

    #[test]
    fn snapshot_of_absent_file_restores_by_deleting() {
        let project = TempProject::new("absent");
        let target = project.path().join("canon").join("new-chapter.md");

        let snap = create_snapshot(project.path(), &target).unwrap();
        assert!(!snap.existed, "目标不存在时快照必须记 existed=false");

        // 外部 Agent 新建了它。
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"brand new chapter").unwrap();

        let restored = restore_snapshot(project.path(), &snap.id).unwrap();
        assert!(!restored.existed);
        assert!(!target.exists(), "回滚新建文件必须删除它，而不是留个空文件");
    }

    #[test]
    fn restore_rejects_unknown_snapshot() {
        let project = TempProject::new("unknown");
        let err = restore_snapshot(project.path(), "snap_nope").unwrap_err();
        assert!(err.contains("找不到快照"), "错误要说清找不到什么: {err}");
    }

    #[test]
    fn restore_refuses_corrupted_snapshot() {
        let project = TempProject::new("corrupt");
        let target = project.path().join("QM").join("x.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"v1").unwrap();
        let snap = create_snapshot(project.path(), &target).unwrap();

        // 快照内容被人动过：不能拿它去覆盖真源。
        let dir = snapshots_dir(project.path());
        std::fs::write(body_path(&dir, &snap.id), b"tampered").unwrap();
        let err = restore_snapshot(project.path(), &snap.id).unwrap_err();
        assert!(err.contains("自身已损坏"), "错误要说清是快照坏了: {err}");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"v1",
            "拒绝回滚时不得动目标"
        );
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
}
