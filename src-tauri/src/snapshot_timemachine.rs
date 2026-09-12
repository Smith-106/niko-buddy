//! 快照时间机器：只读时间线枚举 + 两点前后对照 + 原子恢复。
//!
//! 只消费既有的 `.novel/snapshots/` 与 `.novel/` 状态文件，**不新建任何历史存储**（C1）。
//! 恢复走 TASK-001 的确认门（`gate_authorize`，op = `restoreSnapshot`），
//! 落盘方式为「同目录 `.tmp` + `fs::rename` 覆盖」，任一 rename 失败即逆序还原。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 既有快照目录；本模块只读枚举它。
pub const SNAPSHOT_DIR: &str = ".novel/snapshots";
/// 状态真源。
pub const STATUS_FILE: &str = ".novel/status.json";
/// 投影状态账本；恢复范围必须包含它。
pub const PROJECTION_STATUS_FILE: &str = ".novel/projection-status.json";
/// 原子落盘用的临时后缀。
pub const TMP_SUFFIX: &str = ".tmp";
/// 回滚用的备份后缀。
pub const BACKUP_SUFFIX: &str = ".bak.tmp";
/// 时间线分页大小（卡片要求 100~200+ 条链可翻页）。
pub const PAGE_SIZE: usize = 50;

/// 七大世界状态。第一列是逻辑状态名，第二列是候选文件名。
///
/// 本项目里 entities / relations / events / timeline / worldbuilding 由 canon 管理，
/// `.novel/` 下通常**没有**对应 JSON —— 这些项解析为空时跳过（不发明状态文件），
/// 其一致性由恢复后的既有 canon 校验命令负责。characters / foreshadowing 另有
/// 真实 `.novel/` 文件名，列在后面。
pub const WORLD_STATE_FILES: [(&str, &[&str]); 7] = [
    ("entities", &["entities.json"]),
    ("relations", &["relations.json"]),
    ("events", &["events.json"]),
    ("timeline", &["timeline.json"]),
    ("worldbuilding", &["worldbuilding.json"]),
    ("characters", &["characters.json", "character-states.json"]),
    ("foreshadowing", &["foreshadowing.json", "foreshadowing-tracker.json"]),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotMeta {
    pub id: String,
    /// 目录 mtime（毫秒）；无 mtime 时为 0。
    pub ts_ms: u64,
    /// 从目录名解析出的章节跨度；解析不出为 None。
    pub chapter_span: Option<String>,
    pub file_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotChain {
    pub points: Vec<SnapshotMeta>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FieldDiff {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateDiff {
    pub state: String,
    pub before_hash: String,
    pub after_hash: String,
    pub changed: Vec<FieldDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiff {
    pub snapshot_id: String,
    pub status_diff: Vec<FieldDiff>,
    pub world_state_diffs: Vec<StateDiff>,
    pub projection_status_diff: Vec<FieldDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonVerifyOutcome {
    pub verified: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreOutcome {
    pub snapshot_id: String,
    /// 实际被覆盖的既有文件（相对项目根）。
    pub restored: Vec<String>,
    /// 是否走了逆序还原分支。
    pub rolled_back: bool,
    pub gate_decision: String,
    pub verify: Option<CanonVerifyOutcome>,
    pub message: String,
}

fn abs(root: &Path, rel: &str) -> PathBuf {
    root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn snapshot_root(root: &Path) -> PathBuf {
    abs(root, SNAPSHOT_DIR)
}

/// 时间线枚举；分页默认 `PAGE_SIZE`。
fn do_list_chain(root: &Path, offset: usize, limit: usize) -> SnapshotChain {
    let dir = snapshot_root(root);
    let mut points: Vec<SnapshotMeta> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            let (file_count, size_bytes) = measure(&path);
            points.push(SnapshotMeta {
                id: id.clone(),
                ts_ms: mtime_ms(&path),
                chapter_span: chapter_span_from_id(&id),
                file_count,
                size_bytes,
            });
        }
    }
    // 新的在前，链式阅读顺序稳定。
    points.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms).then_with(|| a.id.cmp(&b.id)));

    let limit = if limit == 0 { PAGE_SIZE } else { limit };
    let total = points.len();
    let page = points.into_iter().skip(offset).take(limit).collect();
    SnapshotChain {
        points: page,
        total,
        offset,
        limit,
        page_size: PAGE_SIZE,
    }
}

fn measure(dir: &Path) -> (usize, u64) {
    let mut count = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                count += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (count, bytes)
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 只从目录名里识别章节跨度，不做任何猜造。
fn chapter_span_from_id(id: &str) -> Option<String> {
    let digits: Vec<&str> = id
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    if digits.is_empty() {
        return None;
    }
    if digits.len() >= 2 {
        Some(format!("{}-{}", digits[0], digits[1]))
    } else {
        Some(digits[0].to_string())
    }
}

fn flatten(value: &Value, prefix: &str, out: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let next = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                flatten(v, &next, out);
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                let next = format!("{}[{}]", prefix, i);
                flatten(v, &next, out);
            }
        }
        other => {
            out.insert(prefix.to_string(), other.to_string());
        }
    }
}

fn read_snapshot_json(path: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return out;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return out;
    };
    flatten(&value, "", &mut out);
    out
}

fn diff_maps(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Vec<FieldDiff> {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut out = Vec::new();
    for k in keys {
        let b = before.get(k).cloned().unwrap_or_default();
        let a = after.get(k).cloned().unwrap_or_default();
        if b != a {
            out.push(FieldDiff {
                path: k.clone(),
                before: b,
                after: a,
            });
        }
    }
    out
}

fn hash_map(map: &BTreeMap<String, String>) -> String {
    let mut acc: u64 = 0xcbf2_9ce4_8422_2325;
    for (k, v) in map {
        for byte in k.as_bytes().iter().chain(v.as_bytes()) {
            acc ^= *byte as u64;
            acc = acc.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{:016x}", acc)
}

/// 某个世界状态在给定根下的实际文件（候选里第一个存在的）。
fn world_state_path(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|name| abs(root, &format!(".novel/{}", name)))
        .find(|p| p.is_file())
}

/// 两点前后对照：快照点 = before，当前状态 = after。
fn do_preview_point(root: &Path, snapshot_id: &str) -> SnapshotDiff {
    let snap = snapshot_root(root).join(snapshot_id);

    let status_diff = diff_maps(
        &read_snapshot_json(&snap.join("status.json")),
        &read_snapshot_json(&abs(root, STATUS_FILE)),
    );

    let projection_status_diff = diff_maps(
        &read_snapshot_json(&snap.join("projection-status.json")),
        &read_snapshot_json(&abs(root, PROJECTION_STATUS_FILE)),
    );

    let mut world_state_diffs = Vec::new();
    for (state, candidates) in WORLD_STATE_FILES.iter() {
        let snapshot_file = candidates
            .iter()
            .map(|n| snap.join(n))
            .find(|p| p.is_file());
        let live_file = world_state_path(root, candidates);
        let (Some(sf), Some(lf)) = (snapshot_file, live_file) else {
            continue;
        };
        let before = read_snapshot_json(&sf);
        let after = read_snapshot_json(&lf);
        world_state_diffs.push(StateDiff {
            state: (*state).to_string(),
            before_hash: hash_map(&before),
            after_hash: hash_map(&after),
            changed: diff_maps(&before, &after),
        });
    }

    SnapshotDiff {
        snapshot_id: snapshot_id.to_string(),
        status_diff,
        world_state_diffs,
        projection_status_diff,
    }
}

/// 恢复覆盖的目标清单：状态真源 + 存在着的世界状态文件 + 投影状态账本。
fn restore_targets(root: &Path, snap: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut out: Vec<(PathBuf, PathBuf)> = Vec::new();
    let status_name = STATUS_FILE.rsplit('/').next().unwrap_or("status.json");
    if snap.join(status_name).is_file() {
        out.push((snap.join(status_name), abs(root, STATUS_FILE)));
    }
    let projection_name = PROJECTION_STATUS_FILE
        .rsplit('/')
        .next()
        .unwrap_or("projection-status.json");
    if snap.join(projection_name).is_file() {
        out.push((
            snap.join(projection_name),
            abs(root, PROJECTION_STATUS_FILE),
        ));
    }
    for (_, candidates) in WORLD_STATE_FILES.iter() {
        for name in candidates.iter() {
            let source = snap.join(name);
            if source.is_file() {
                let target = abs(root, &format!(".novel/{}", name));
                out.push((source, target));
            }
        }
    }
    out
}

/// 原子恢复：写 `.tmp` → `fs::rename` 覆盖；任一失败即用备份逆序还原。
fn do_restore_atomic(
    root: &Path,
    snapshot_id: &str,
    confirm_token: &str,
) -> Result<RestoreOutcome, String> {
    let snap = snapshot_root(root).join(snapshot_id);
    if !snap.is_dir() {
        return Err(format!("unknown snapshot: {}", snapshot_id));
    }
    if confirm_token.trim().is_empty() {
        return Err("restore requires an explicit confirmation token".to_string());
    }

    // 执行前必须过门（op = restoreSnapshot）。确认令牌非空即视为人工发起。
    let gate = crate::agent_gate::gate_authorize(
        "restoreSnapshot",
        &abs(root, STATUS_FILE).to_string_lossy(),
        crate::agent_gate::GateActor::User,
    );
    if !gate.may_proceed() {
        return Err(crate::agent_gate::gate_error(&gate));
    }

    let targets = restore_targets(root, &snap);
    if targets.is_empty() {
        return Err(format!(
            "snapshot {} contains no restorable state file",
            snapshot_id
        ));
    }

    let mut restored: Vec<String> = Vec::new();
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new(); // (path, backup)
    let mut failure: Option<(PathBuf, String)> = None;

    for (source, target) in &targets {
        let tmp = PathBuf::from(format!("{}{}", target.to_string_lossy(), TMP_SUFFIX));
        let backup = PathBuf::from(format!("{}{}", target.to_string_lossy(), BACKUP_SUFFIX));
        let body = match std::fs::read(source) {
            Ok(b) => b,
            Err(e) => {
                failure = Some((target.clone(), format!("read snapshot file failed: {}", e)));
                break;
            }
        };
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if target.is_file() {
            if let Err(e) = std::fs::copy(target, &backup) {
                failure = Some((target.clone(), format!("backup failed: {}", e)));
                break;
            }
            staged.push((target.clone(), backup.clone()));
        }
        if let Err(e) = std::fs::write(&tmp, &body) {
            failure = Some((target.clone(), format!("stage failed: {}", e)));
            break;
        }
        if let Err(e) = std::fs::rename(&tmp, target) {
            failure = Some((target.clone(), format!("rename failed: {}", e)));
            break;
        }
        restored.push(
            target
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| target.to_string_lossy().to_string()),
        );
    }

    let rolled_back = failure.is_some();
    if let Some((failed_path, reason)) = failure {
        // 逆序还原已覆盖的文件。
        for (path, backup) in staged.iter().rev() {
            if backup.is_file() {
                let _ = std::fs::rename(backup, path);
            }
        }
        cleanup_tmp(root);
        return Err(format!(
            "restore aborted at {}: {} (rolled back)",
            failed_path.to_string_lossy(),
            reason
        ));
    }

    for (_, backup) in staged.iter() {
        let _ = std::fs::remove_file(backup);
    }
    cleanup_tmp(root);

    Ok(RestoreOutcome {
        snapshot_id: snapshot_id.to_string(),
        restored,
        rolled_back,
        gate_decision: gate.decision.as_str().to_string(),
        verify: None,
        message: "restored atomically".to_string(),
    })
}

fn cleanup_tmp(root: &Path) {
    let dir = abs(root, ".novel");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(TMP_SUFFIX) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 回滚后强制复验：复用既有 canon 校验命令，不新建任何历史存储。
pub async fn verify_after_restore(root: &Path) -> CanonVerifyOutcome {
    let Some(zip) = latest_canon_export(root) else {
        return CanonVerifyOutcome {
            verified: false,
            detail: "no canon export container found to verify".to_string(),
        };
    };
    let request = crate::canon::export::CanonVerifyRequest {
        zip_path: zip.to_string_lossy().to_string(),
        expected_checksum: None,
        passphrase: None,
    };
    match crate::canon::export::canon_verify_export(request).await {
        Ok(result) => CanonVerifyOutcome {
            verified: result.success,
            detail: format!(
                "canon verify ran on {}: success={} warnings={}",
                zip.to_string_lossy(),
                result.success,
                result.warnings.len()
            ),
        },
        Err(e) => CanonVerifyOutcome {
            verified: false,
            detail: format!("canon verify reported an error: {}", e),
        },
    }
}

fn latest_canon_export(root: &Path) -> Option<PathBuf> {
    let dir = abs(root, "backups");
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut stack = vec![dir];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|e| e == "zip").unwrap_or(false) {
                candidates.push(p);
            }
        }
    }
    candidates.sort();
    candidates.pop()
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn snapshot_list_chain(
    project_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<SnapshotChain, String> {
    Ok(snapshot::snapshot_list_chain(
        Path::new(&project_path),
        offset.unwrap_or(0),
        limit.unwrap_or(PAGE_SIZE),
    ))
}

#[tauri::command]
pub async fn snapshot_preview_point(
    project_path: String,
    snapshot_id: String,
) -> Result<SnapshotDiff, String> {
    Ok(snapshot::snapshot_preview_point(
        Path::new(&project_path),
        &snapshot_id,
    ))
}

#[tauri::command]
pub async fn snapshot_restore_atomic(
    project_path: String,
    snapshot_id: String,
    confirm_token: String,
) -> Result<RestoreOutcome, String> {
    let root = PathBuf::from(&project_path);
    let mut result = snapshot::snapshot_restore_atomic(&root, &snapshot_id, &confirm_token)?;
    result.verify = Some(snapshot::verify_after_restore(&root).await);
    Ok(result)
}

/// 核心同步实现：卡片要求的三个 `pub fn` 在此，命令层只做参数解包与异步复验。
pub mod snapshot {
    use super::*;

    pub fn snapshot_list_chain(root: &Path, offset: usize, limit: usize) -> SnapshotChain {
        super::do_list_chain(root, offset, limit)
    }

    pub fn snapshot_preview_point(root: &Path, snapshot_id: &str) -> SnapshotDiff {
        super::do_preview_point(root, snapshot_id)
    }

    pub fn snapshot_restore_atomic(
        root: &Path,
        snapshot_id: &str,
        confirm_token: &str,
    ) -> Result<RestoreOutcome, String> {
        super::do_restore_atomic(root, snapshot_id, confirm_token)
    }

    pub async fn verify_after_restore(root: &Path) -> CanonVerifyOutcome {
        super::verify_after_restore(root).await
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct TempTree {
            root: PathBuf,
        }

        impl TempTree {
            fn new(tag: &str) -> TempTree {
                let mut root = std::env::temp_dir();
                root.push(format!(
                    "nb-timemachine-{}-{}-{}",
                    tag,
                    std::process::id(),
                    mtime_ms(Path::new("."))
                ));
                std::fs::create_dir_all(root.join(".novel/snapshots")).expect("mkdir");
                TempTree { root }
            }

            fn write(&self, rel: &str, body: &str) {
                let p = abs(&self.root, rel);
                if let Some(parent) = p.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(p, body).expect("write");
            }
        }

        impl Drop for TempTree {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }

        fn fixture(tag: &str) -> TempTree {
            let t = TempTree::new(tag);
            let snap = ".novel/snapshots/ch-10-20";
            t.write(
                &format!("{}/status.json", snap),
                r#"{"currentChapter":10,"title":"旧标题"}"#,
            );
            t.write(
                &format!("{}/projection-status.json", snap),
                r#"{"projections":[{"id":"a","status":"ready"}]}"#,
            );
            t.write(
                &format!("{}/character-states.json", snap),
                r#"{"hero":{"mood":"平静"}}"#,
            );
            t.write(
                ".novel/status.json",
                r#"{"currentChapter":25,"title":"新标题"}"#,
            );
            t.write(
                ".novel/projection-status.json",
                r#"{"projections":[{"id":"a","status":"stale"}]}"#,
            );
            t.write(
                ".novel/character-states.json",
                r#"{"hero":{"mood":"焦躁"}}"#,
            );
            t
        }

        #[test]
        fn chain_lists_snapshots_and_pages() {
            let t = fixture("chain");
            let chain = snapshot_list_chain(&t.root, 0, 0);
            assert_eq!(chain.total, 1);
            assert_eq!(chain.points[0].id, "ch-10-20");
            assert_eq!(chain.points[0].chapter_span.as_deref(), Some("10-20"));
            assert!(chain.points[0].file_count >= 3);
            assert_eq!(chain.page_size, PAGE_SIZE);

            let empty = snapshot_list_chain(&t.root, 5, 0);
            assert!(empty.points.is_empty());
            assert_eq!(empty.total, 1);
        }

        #[test]
        fn preview_reports_field_level_diff() {
            let t = fixture("preview");
            let diff = snapshot_preview_point(&t.root, "ch-10-20");
            assert!(diff
                .status_diff
                .iter()
                .any(|d| d.path == "title" && d.before.contains("旧标题") && d.after.contains("新标题")));
            assert!(diff.projection_status_diff.iter().any(|d| d.path.contains("status")));
            assert_eq!(diff.world_state_diffs.len(), 1, "only characters exists");
            assert_eq!(diff.world_state_diffs[0].state, "characters");
            assert_ne!(
                diff.world_state_diffs[0].before_hash,
                diff.world_state_diffs[0].after_hash
            );
        }

        #[test]
        fn restore_is_atomic() {
            let t = fixture("restore");
            let out =
                snapshot_restore_atomic(&t.root, "ch-10-20", "user-confirmed").expect("restore");
            assert_eq!(out.gate_decision, "allowed");
            assert!(!out.rolled_back);
            assert_eq!(out.restored.len(), 3);

            let status = std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            assert!(status.contains("旧标题"), "truth surface must come from the snapshot");
            let chars = std::fs::read_to_string(abs(&t.root, ".novel/character-states.json"))
                .expect("characters");
            assert!(chars.contains("平静"));

            // 落盘必须收尾干净：不留 .tmp / .bak.tmp。
            let leftover: Vec<String> = std::fs::read_dir(abs(&t.root, ".novel"))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(TMP_SUFFIX))
                .collect();
            assert!(leftover.is_empty(), "temp files must be cleaned: {:?}", leftover);
        }

        #[test]
        fn restore_rolls_back_when_rename_fails() {
            let t = fixture("rollback");
            // 让其中一个目标无法被 rename 覆盖：把它变成目录。
            let poisoned = abs(&t.root, PROJECTION_STATUS_FILE);
            std::fs::remove_file(&poisoned).expect("remove file");
            std::fs::create_dir_all(&poisoned).expect("make dir");
            std::fs::write(poisoned.join("keep"), b"x").expect("write child");

            let original = std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            let err = snapshot_restore_atomic(&t.root, "ch-10-20", "user-confirmed")
                .expect_err("restore must abort");
            assert!(err.contains("rolled back"), "unexpected error: {}", err);

            let after = std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            assert_eq!(
                original, after,
                "a failed restore must leave the truth surface untouched"
            );
        }

        #[test]
        fn restore_requires_confirmation_token() {
            let t = fixture("token");
            let err = snapshot_restore_atomic(&t.root, "ch-10-20", "  ").expect_err("must refuse");
            assert!(err.contains("confirmation token"), "unexpected error: {}", err);
        }

        #[test]
        fn restore_calls_canon_verify() {
            let t = fixture("verify");
            // 放一个非法 zip，让既有 canon 校验命令**真实失败**，以此证明调用路径存在。
            t.write("backups/auto/broken.zip", "not a zip");
            let restored =
                snapshot_restore_atomic(&t.root, "ch-10-20", "user-confirmed").expect("restore");
            assert!(restored.verify.is_none(), "core restore stays sync");

            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let verify = rt.block_on(verify_after_restore(&t.root));
            assert!(
                !verify.verified,
                "an invalid container must not verify: {}",
                verify.detail
            );
            assert!(
                verify.detail.contains("canon verify"),
                "the existing canon verify command must be the one that ran: {}",
                verify.detail
            );
        }
    }
}
