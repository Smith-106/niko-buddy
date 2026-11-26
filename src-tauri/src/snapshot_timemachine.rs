//! 快照时间机器：只读时间线枚举 + 两点前后对照 + 原子恢复。
//!
//! 只消费既有的 `.novel/snapshots/` 与 `.novel/` 状态文件，**不新建任何历史存储**（C1）。
//! 恢复走 TASK-001 的确认门（`gate_authorize`，op = `restoreSnapshot`），
//! 落盘方式为「同目录 `.tmp` + `fs::rename` 覆盖」，任一 rename 失败即逆序还原。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

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
    (
        "foreshadowing",
        &["foreshadowing.json", "foreshadowing-tracker.json"],
    ),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
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

/// 预览签发的一次性恢复挑战令牌 TTL（300 秒）。
const RESTORE_CHALLENGE_TTL_MS: u64 = 300_000;
/// 进程内恢复挑战表容量上限；超限时淘汰最早过期的条目。
const MAX_RESTORE_CHALLENGES: usize = 64;
/// 目录遍历最大深度与条目数上限（防符号链接环路/深层目录炸弹）。
const MAX_TRAVERSAL_DEPTH: usize = 64;
const MAX_TRAVERSAL_ENTRIES: usize = 50_000;

struct RestoreChallenge {
    canonical_root: PathBuf,
    snapshot_id: String,
    expires_at_ms: u64,
}

static RESTORE_CHALLENGES: OnceLock<Mutex<BTreeMap<String, RestoreChallenge>>> = OnceLock::new();

fn restore_challenges() -> &'static Mutex<BTreeMap<String, RestoreChallenge>> {
    RESTORE_CHALLENGES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn issue_restore_challenge(canonical_root: &Path, snapshot_id: &str) -> String {
    let now = now_epoch_ms();
    let token = uuid::Uuid::new_v4().to_string();
    let mut map = restore_challenges()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.retain(|_, c| c.expires_at_ms > now);
    while map.len() >= MAX_RESTORE_CHALLENGES {
        let Some(oldest_key) = map
            .iter()
            .min_by_key(|(_, c)| c.expires_at_ms)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&oldest_key);
    }
    map.insert(
        token.clone(),
        RestoreChallenge {
            canonical_root: canonical_root.to_path_buf(),
            snapshot_id: snapshot_id.to_string(),
            expires_at_ms: now.saturating_add(RESTORE_CHALLENGE_TTL_MS),
        },
    );
    token
}

fn consume_restore_challenge(canonical_root: &Path, snapshot_id: &str, token: &str) -> bool {
    let now = now_epoch_ms();
    let mut map = restore_challenges()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.retain(|_, c| c.expires_at_ms > now);
    let matches = map.get(token).is_some_and(|c| {
        c.canonical_root == canonical_root && c.snapshot_id == snapshot_id && c.expires_at_ms > now
    });
    if matches {
        map.remove(token);
        true
    } else {
        false
    }
}

/// 严格解析并锚定快照目录：单段白名单 + 祖先与目标无符号链接/重解析点 + 规范路径落在快照根内。
fn resolve_safe_snapshot_dir(root: &Path, snapshot_id: &str) -> Result<(PathBuf, PathBuf), String> {
    crate::agent_gate_policy::validate_safe_single_segment(snapshot_id, "snapshot_id")?;
    let snap_root = snapshot_root(root);
    crate::agent_gate_policy::assert_no_symlink_in_ancestors(root, &snap_root)?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("failed to resolve project root '{}': {e}", root.display()))?;
    let canonical_snap_root = std::fs::canonicalize(&snap_root)
        .map_err(|_| format!("unknown snapshot: {snapshot_id}"))?;
    if !canonical_snap_root.starts_with(&canonical_root) {
        return Err(format!(
            "snapshot root escapes project root: {}",
            snap_root.display()
        ));
    }
    let snap = canonical_snap_root.join(snapshot_id);
    let meta =
        std::fs::symlink_metadata(&snap).map_err(|_| format!("unknown snapshot: {snapshot_id}"))?;
    if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
        return Err(format!(
            "snapshot symlink or reparse point rejected: {snapshot_id}"
        ));
    }
    if !meta.is_dir() {
        return Err(format!("unknown snapshot: {snapshot_id}"));
    }
    let canonical_snap = std::fs::canonicalize(&snap)
        .map_err(|e| format!("failed to resolve snapshot '{snapshot_id}': {e}"))?;
    if !canonical_snap.starts_with(&canonical_snap_root) || canonical_snap == canonical_snap_root {
        return Err(format!("snapshot escapes snapshot root: {snapshot_id}"));
    }
    Ok((canonical_root, canonical_snap))
}

fn is_safe_regular_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    !crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) && meta.is_file()
}

/// 时间线枚举；分页默认 `PAGE_SIZE`。不跟随任何符号链接或重解析点。
fn do_list_chain(root: &Path, offset: usize, limit: usize) -> SnapshotChain {
    let dir = snapshot_root(root);
    let mut points: Vec<SnapshotMeta> = Vec::new();
    if crate::agent_gate_policy::assert_no_symlink_in_ancestors(root, &dir).is_ok() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(meta) = std::fs::symlink_metadata(&path) else {
                    continue;
                };
                if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta)
                    || !meta.is_dir()
                {
                    continue;
                }
                let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                    continue;
                };
                if crate::agent_gate_policy::validate_safe_single_segment(&id, "snapshot_id")
                    .is_err()
                {
                    continue;
                }
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
    let mut visited = 0usize;
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        if depth >= MAX_TRAVERSAL_DEPTH || visited >= MAX_TRAVERSAL_ENTRIES {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            if visited >= MAX_TRAVERSAL_ENTRIES {
                break;
            }
            visited += 1;
            let p = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push((p, depth + 1));
            } else if meta.is_file() {
                count += 1;
                bytes = bytes.saturating_add(meta.len());
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
    if !is_safe_regular_file(path) {
        return out;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return out;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return out;
    };
    flatten(&value, "", &mut out);
    out
}

fn diff_maps(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Vec<FieldDiff> {
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

/// 某个世界状态在给定根下的实际文件（候选里第一个存在的普通非符号链接文件）。
fn world_state_path(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|name| abs(root, &format!(".novel/{}", name)))
        .find(|p| is_safe_regular_file(p))
}

/// 两点前后对照：快照点 = before，当前状态 = after。
/// 合法快照会签发单次有效、绑定 `(canonical_root, snapshot_id)` 的 UUID 恢复挑战令牌。
fn do_preview_point(root: &Path, snapshot_id: &str) -> SnapshotDiff {
    let Ok((canonical_root, snap)) = resolve_safe_snapshot_dir(root, snapshot_id) else {
        return SnapshotDiff {
            snapshot_id: snapshot_id.to_string(),
            status_diff: Vec::new(),
            world_state_diffs: Vec::new(),
            projection_status_diff: Vec::new(),
            confirm_token: None,
        };
    };

    let status_diff = diff_maps(
        &read_snapshot_json(&snap.join("status.json")),
        &read_snapshot_json(&abs(&canonical_root, STATUS_FILE)),
    );

    let projection_status_diff = diff_maps(
        &read_snapshot_json(&snap.join("projection-status.json")),
        &read_snapshot_json(&abs(&canonical_root, PROJECTION_STATUS_FILE)),
    );

    let mut world_state_diffs = Vec::new();
    for (state, candidates) in WORLD_STATE_FILES.iter() {
        let snapshot_file = candidates
            .iter()
            .map(|n| snap.join(n))
            .find(|p| is_safe_regular_file(p));
        let live_file = world_state_path(&canonical_root, candidates);
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

    let confirm_token = Some(issue_restore_challenge(&canonical_root, snapshot_id));

    SnapshotDiff {
        snapshot_id: snapshot_id.to_string(),
        status_diff,
        world_state_diffs,
        projection_status_diff,
        confirm_token,
    }
}

/// 恢复覆盖的目标清单：状态真源 + 存在着的世界状态文件 + 投影状态账本（跳过符号链接）。
fn restore_targets(root: &Path, snap: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut out: Vec<(PathBuf, PathBuf)> = Vec::new();
    let status_name = STATUS_FILE.rsplit('/').next().unwrap_or("status.json");
    if is_safe_regular_file(&snap.join(status_name)) {
        out.push((snap.join(status_name), abs(root, STATUS_FILE)));
    }
    let projection_name = PROJECTION_STATUS_FILE
        .rsplit('/')
        .next()
        .unwrap_or("projection-status.json");
    if is_safe_regular_file(&snap.join(projection_name)) {
        out.push((
            snap.join(projection_name),
            abs(root, PROJECTION_STATUS_FILE),
        ));
    }
    for (_, candidates) in WORLD_STATE_FILES.iter() {
        for name in candidates.iter() {
            let source = snap.join(name);
            if is_safe_regular_file(&source) {
                let target = abs(root, &format!(".novel/{}", name));
                out.push((source, target));
            }
        }
    }
    out
}

fn write_unique_file_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    crate::commands::file_sync::mark_app_write_path(path);
    let res = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    res
}

/// 原子恢复：持有 `FILE_MUTATION_LOCK`（T4 → T5），仅消费后端签发挑战时按 `GateActor::User` 放行，
/// 未命中 challenge 绝不伪造 `GateActor::User`，改以 `GateActor::Agent` 过确认门；
/// 落盘采用同目录唯一临时文件 + `sync_all` + `fs::rename`，任一失败即逆序还原。
fn do_restore_atomic(
    root: &Path,
    snapshot_id: &str,
    confirm_token: &str,
) -> Result<RestoreOutcome, String> {
    if confirm_token.trim().is_empty() {
        return Err("restore requires an explicit confirmation token".to_string());
    }
    let (canonical_root, snap) = resolve_safe_snapshot_dir(root, snapshot_id)?;

    // 全局锁序：先取 T4 FILE_MUTATION_LOCK，再进入 T5（RESTORE_CHALLENGES / GATE）。
    let _mutation = crate::commands::fs::lock_file_mutations()?;

    let actor = if consume_restore_challenge(&canonical_root, snapshot_id, confirm_token.trim()) {
        crate::agent_gate::GateActor::User
    } else {
        crate::agent_gate::GateActor::Agent
    };
    let gate = crate::agent_gate::gate_authorize(
        "restoreSnapshot",
        &abs(&canonical_root, STATUS_FILE).to_string_lossy(),
        actor,
    );
    if !gate.may_proceed() {
        return Err(crate::agent_gate::gate_error(&gate));
    }

    crate::agent_gate_policy::assert_no_symlink_in_ancestors(
        &canonical_root,
        &abs(&canonical_root, ".novel"),
    )?;

    let targets = restore_targets(&canonical_root, &snap);
    if targets.is_empty() {
        return Err(format!(
            "snapshot {} contains no restorable state file",
            snapshot_id
        ));
    }

    static SNAP_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let mut restored: Vec<String> = Vec::new();
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new(); // (path, backup)
    let mut created_targets: Vec<PathBuf> = Vec::new();
    let mut created_tmps: Vec<PathBuf> = Vec::new();
    let mut failure: Option<(PathBuf, String)> = None;

    for (source, target) in &targets {
        let Some(parent) = target.parent() else {
            failure = Some((target.clone(), "restore target has no parent".to_string()));
            break;
        };
        if let Err(e) = std::fs::create_dir_all(parent) {
            failure = Some((target.clone(), format!("create parent dir failed: {e}")));
            break;
        }
        if let Err(e) =
            crate::agent_gate_policy::assert_no_symlink_in_ancestors(&canonical_root, parent)
        {
            failure = Some((target.clone(), e));
            break;
        }
        let target_is_regular = match std::fs::symlink_metadata(target) {
            Ok(meta) => {
                if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
                    failure = Some((
                        target.clone(),
                        "restore target is a symlink or reparse point".to_string(),
                    ));
                    break;
                }
                meta.is_file()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => {
                failure = Some((target.clone(), format!("inspect target failed: {e}")));
                break;
            }
        };

        let seq = SNAP_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(".nb-snap-{pid}-{seq}.tmp"));
        let backup = parent.join(format!(".nb-snap-{pid}-{seq}.bak"));

        let body = match std::fs::read(source) {
            Ok(b) => b,
            Err(e) => {
                failure = Some((target.clone(), format!("read snapshot file failed: {}", e)));
                break;
            }
        };
        if target_is_regular {
            let existing_bytes = match std::fs::read(target) {
                Ok(b) => b,
                Err(e) => {
                    failure = Some((target.clone(), format!("read existing target failed: {e}")));
                    break;
                }
            };
            if let Err(e) = write_unique_file_synced(&backup, &existing_bytes) {
                let _ = std::fs::remove_file(&backup);
                failure = Some((target.clone(), format!("backup failed: {}", e)));
                break;
            }
            staged.push((target.clone(), backup.clone()));
        }
        if let Err(e) = write_unique_file_synced(&tmp, &body) {
            let _ = std::fs::remove_file(&tmp);
            failure = Some((target.clone(), format!("stage failed: {}", e)));
            break;
        }
        created_tmps.push(tmp.clone());

        crate::commands::file_sync::mark_app_write_path(target);
        if let Err(e) = std::fs::rename(&tmp, target) {
            failure = Some((target.clone(), format!("rename failed: {}", e)));
            break;
        }
        if !target_is_regular {
            created_targets.push(target.clone());
        }
        crate::commands::file_sync::mark_app_write_path(target);
        restored.push(
            target
                .strip_prefix(&canonical_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| target.to_string_lossy().to_string()),
        );
    }

    let rolled_back = failure.is_some();
    if let Some((failed_path, reason)) = failure {
        // 逆序还原已覆盖的文件，并逆序清理此前不存在而本次新建的目标文件。
        for (path, backup) in staged.iter().rev() {
            if is_safe_regular_file(backup) {
                crate::commands::file_sync::mark_app_write_path(path);
                let _ = std::fs::rename(backup, path);
                crate::commands::file_sync::mark_app_write_path(path);
            }
        }
        for path in created_targets.iter().rev() {
            crate::commands::file_sync::mark_app_write_path(path);
            let _ = std::fs::remove_file(path);
            crate::commands::file_sync::mark_app_write_path(path);
        }
        for tmp in &created_tmps {
            let _ = std::fs::remove_file(tmp);
        }
        for (_, backup) in &staged {
            let _ = std::fs::remove_file(backup);
        }
        return Err(format!(
            "restore aborted at {}: {} (rolled back)",
            failed_path.to_string_lossy(),
            reason
        ));
    }

    for (_, backup) in &staged {
        let _ = std::fs::remove_file(backup);
    }
    for tmp in &created_tmps {
        let _ = std::fs::remove_file(tmp);
    }

    Ok(RestoreOutcome {
        snapshot_id: snapshot_id.to_string(),
        restored,
        rolled_back,
        gate_decision: gate.decision.as_str().to_string(),
        verify: None,
        message: "restored atomically".to_string(),
    })
}

/// 回滚后强制复验：复用既有 canon 校验命令，不新建任何历史存储。
pub async fn verify_after_restore(root: &Path) -> CanonVerifyOutcome {
    let root_buf = root.to_path_buf();
    let zip = tokio::task::spawn_blocking(move || latest_canon_export(&root_buf))
        .await
        .ok()
        .flatten();
    let Some(zip) = zip else {
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
    if crate::agent_gate_policy::assert_no_symlink_in_ancestors(root, &dir).is_err() {
        return None;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut visited = 0usize;
    let mut stack = vec![(dir, 0usize)];
    while let Some((d, depth)) = stack.pop() {
        if depth >= 32 || visited >= MAX_TRAVERSAL_ENTRIES {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            if visited >= MAX_TRAVERSAL_ENTRIES {
                break;
            }
            visited += 1;
            let p = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&p) else {
                continue;
            };
            if crate::agent_gate_policy::metadata_is_symlink_or_reparse_point(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push((p, depth + 1));
            } else if meta.is_file() && p.extension().map(|e| e == "zip").unwrap_or(false) {
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
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("snapshot_list_chain", || {
            Ok(snapshot::snapshot_list_chain(
                Path::new(&project_path),
                offset.unwrap_or(0),
                limit.unwrap_or(PAGE_SIZE),
            ))
        })
    })
    .await
    .map_err(|e| format!("snapshot_list_chain blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn snapshot_preview_point(
    project_path: String,
    snapshot_id: String,
) -> Result<SnapshotDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("snapshot_preview_point", || {
            crate::agent_gate_policy::validate_safe_single_segment(&snapshot_id, "snapshot_id")?;
            Ok(snapshot::snapshot_preview_point(
                Path::new(&project_path),
                &snapshot_id,
            ))
        })
    })
    .await
    .map_err(|e| format!("snapshot_preview_point blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn snapshot_restore_atomic(
    project_path: String,
    snapshot_id: String,
    confirm_token: String,
) -> Result<RestoreOutcome, String> {
    let root = PathBuf::from(&project_path);
    let root_for_restore = root.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("snapshot_restore_atomic", || {
            snapshot::snapshot_restore_atomic(&root_for_restore, &snapshot_id, &confirm_token)
        })
    })
    .await
    .map_err(|e| format!("snapshot_restore_atomic blocking task join error: {e}"))??;
    // T4 FILE_MUTATION_LOCK 已在 spawn_blocking 闭包退出时释放，此处安全 .await。
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
            let _serial = crate::agent_gate::gate_test_serial();
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
            let _serial = crate::agent_gate::gate_test_serial();
            let t = fixture("preview");
            let diff = snapshot_preview_point(&t.root, "ch-10-20");
            assert!(diff.status_diff.iter().any(|d| d.path == "title"
                && d.before.contains("旧标题")
                && d.after.contains("新标题")));
            assert!(diff
                .projection_status_diff
                .iter()
                .any(|d| d.path.contains("status")));
            assert_eq!(diff.world_state_diffs.len(), 1, "only characters exists");
            assert_eq!(diff.world_state_diffs[0].state, "characters");
            assert_ne!(
                diff.world_state_diffs[0].before_hash,
                diff.world_state_diffs[0].after_hash
            );
        }

        #[test]
        fn restore_is_atomic() {
            let _serial = crate::agent_gate::gate_test_serial();
            let t = fixture("restore");
            let diff = snapshot_preview_point(&t.root, "ch-10-20");
            let token = diff
                .confirm_token
                .expect("preview must issue a single-use confirm_token");
            let out = snapshot_restore_atomic(&t.root, "ch-10-20", &token).expect("restore");
            assert_eq!(out.gate_decision, "allowed");
            assert!(!out.rolled_back);
            assert_eq!(out.restored.len(), 3);

            let status = std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            assert!(
                status.contains("旧标题"),
                "truth surface must come from the snapshot"
            );
            let chars = std::fs::read_to_string(abs(&t.root, ".novel/character-states.json"))
                .expect("characters");
            assert!(chars.contains("平静"));

            // 落盘必须收尾干净：不留 .tmp / .bak。
            let leftover: Vec<String> = std::fs::read_dir(abs(&t.root, ".novel"))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(TMP_SUFFIX) || n.ends_with(".bak"))
                .collect();
            assert!(
                leftover.is_empty(),
                "temp files must be cleaned: {:?}",
                leftover
            );
        }

        #[test]
        fn restore_rolls_back_when_rename_fails() {
            let _serial = crate::agent_gate::gate_test_serial();
            let t = fixture("rollback");
            let token = snapshot_preview_point(&t.root, "ch-10-20")
                .confirm_token
                .expect("preview token");
            // 让其中一个目标无法被 rename 覆盖：把它变成目录。
            let poisoned = abs(&t.root, PROJECTION_STATUS_FILE);
            std::fs::remove_file(&poisoned).expect("remove file");
            std::fs::create_dir_all(&poisoned).expect("make dir");
            std::fs::write(poisoned.join("keep"), b"x").expect("write child");

            let original = std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            let err = snapshot_restore_atomic(&t.root, "ch-10-20", &token)
                .expect_err("restore must abort");
            assert!(err.contains("rolled back"), "unexpected error: {}", err);

            let after = std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            assert_eq!(
                original, after,
                "a failed restore must leave the truth surface untouched"
            );

            // 若前置目标此前不存在、本次新建后因后续 rename 失败触发回滚，也必须清理新建文件。
            let t2 = fixture("rollback-created");
            let status_path = abs(&t2.root, STATUS_FILE);
            std::fs::remove_file(&status_path).expect("remove status");
            let token2 = snapshot_preview_point(&t2.root, "ch-10-20")
                .confirm_token
                .expect("preview token 2");
            let poisoned2 = abs(&t2.root, PROJECTION_STATUS_FILE);
            std::fs::remove_file(&poisoned2).expect("remove file");
            std::fs::create_dir_all(&poisoned2).expect("make dir");
            std::fs::write(poisoned2.join("keep"), b"x").expect("write child");
            let err2 = snapshot_restore_atomic(&t2.root, "ch-10-20", &token2)
                .expect_err("restore must abort");
            assert!(err2.contains("rolled back"), "unexpected error: {err2}");
            assert!(
                !status_path.exists(),
                "rollback must remove targets that did not exist before restore"
            );
        }

        #[test]
        fn restore_requires_confirmation_token() {
            let _serial = crate::agent_gate::gate_test_serial();
            let t = fixture("token");
            let err = snapshot_restore_atomic(&t.root, "ch-10-20", "  ").expect_err("must refuse");
            assert!(
                err.contains("confirmation token"),
                "unexpected error: {}",
                err
            );
        }

        #[test]
        fn restore_rejects_forged_replayed_and_traversal_inputs() {
            let _serial = crate::agent_gate::gate_test_serial();
            let t = fixture("forged-token");
            crate::agent_gate::set_gate_project_root(
                std::fs::canonicalize(&t.root).unwrap_or_else(|_| t.root.clone()),
            );
            crate::agent_gate::__reset_state_for_test();

            // 1. 伪造 token（未经 preview 签发）不得伪造 GateActor::User，必须触发 GATE_REQUIRE_CONFIRM。
            let forged_err = snapshot_restore_atomic(&t.root, "ch-10-20", "user-confirmed")
                .expect_err("forged token must require confirmation");
            assert!(
                forged_err.starts_with(crate::agent_gate::GATE_CONFIRM_PREFIX),
                "forged token must trigger GATE_REQUIRE_CONFIRM, got: {forged_err}"
            );
            let status_after_forged =
                std::fs::read_to_string(abs(&t.root, STATUS_FILE)).expect("status");
            assert!(
                status_after_forged.contains("新标题"),
                "forged token must not modify status.json"
            );

            // 2. 合法 token 消费一次后不可重放。
            let token = snapshot_preview_point(&t.root, "ch-10-20")
                .confirm_token
                .expect("preview token");
            snapshot_restore_atomic(&t.root, "ch-10-20", &token).expect("first restore succeeds");
            let replay_err = snapshot_restore_atomic(&t.root, "ch-10-20", &token)
                .expect_err("replayed token must not bypass gate");
            assert!(
                replay_err.starts_with(crate::agent_gate::GATE_CONFIRM_PREFIX),
                "replayed token must trigger GATE_REQUIRE_CONFIRM, got: {replay_err}"
            );

            // 3. 穿越 / 保留名 snapshot_id 拒绝。
            for bad_id in ["../evil", "a/b", "CON", "ch-10-20."] {
                assert!(snapshot_preview_point(&t.root, bad_id)
                    .confirm_token
                    .is_none());
                assert!(snapshot_restore_atomic(&t.root, bad_id, "tok").is_err());
            }
        }

        #[test]
        fn restore_calls_canon_verify() {
            let _serial = crate::agent_gate::gate_test_serial();
            let t = fixture("verify");
            // 放一个非法 zip，让既有 canon 校验命令**真实失败**，以此证明调用路径存在。
            t.write("backups/auto/broken.zip", "not a zip");
            let token = snapshot_preview_point(&t.root, "ch-10-20")
                .confirm_token
                .expect("preview token");
            let restored = snapshot_restore_atomic(&t.root, "ch-10-20", &token).expect("restore");
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
