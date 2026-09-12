//! 事务式确定性批量替换（F-007）。
//!
//! 三条硬约束：
//! 1. **确定性**：只有字面量替换（可选大小写敏感），不做正则、不做语义替换，不调用任何模型；
//! 2. **先审后写**：每个目标先过 `agent_gate`；任一目标未放行则整批不动（零副作用）；
//! 3. **事务性**：drafts 先行（新内容先落 `.novel/drafts/`）→ 临时文件 + `fs::rename` 提交 →
//!    任一步失败即从备份逆序回滚，不留半成品。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_gate::{self, GateActor};

/// 草稿与事务备份根（Draft-first 落点）。
pub const DRAFTS_ROOT: &str = ".novel/drafts/batch-replace";
/// 提交成功后刷新的投影状态文件。
pub const PROJECTION_STATUS_FILE: &str = ".novel/projection-status.json";
/// 单批文件数上限（防止误操作把整本书一次改穿）。
pub const MAX_FILES_PER_BATCH: usize = 200;
/// 确认门里的操作名（`agent_gate::DESTRUCTIVE_OPS` 已有此项）。
pub const BATCH_REPLACE_OP: &str = "batchReplace";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceRule {
    /// 被替换的字面量；空串拒绝。
    pub find: String,
    /// 替换为的字面量（允许空串 = 删除）。
    pub replace: String,
    /// 是否大小写敏感（默认 false）。
    #[serde(default)]
    pub case_sensitive: bool,
}

impl ReplaceRule {
    fn validate(&self) -> Result<(), BatchReplaceError> {
        if self.find.is_empty() {
            return Err(BatchReplaceError::InvalidRule(
                "find must not be empty".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineChange {
    /// 1-based 行号。
    pub line: u32,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDiff {
    /// 项目相对路径（正斜杠）。
    pub path: String,
    /// 该文件命中次数。
    pub replacements: u32,
    pub changes: Vec<LineChange>,
}

impl FileDiff {
    pub fn is_unchanged(&self) -> bool {
        self.replacements == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyReport {
    /// 实际提交的文件（相对路径）。
    pub applied: Vec<String>,
    /// 落在 drafts 里的新内容副本。
    pub drafts: Vec<String>,
    /// 事务备份目录（相对路径）。
    pub backup_root: String,
    pub total_replacements: u32,
    pub projection_status_updated: bool,
    /// 是否发生过回滚（回滚成功的批不会有任何 canonical 变更）。
    pub rollback_performed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchReplaceError {
    InvalidRule(String),
    InvalidTarget(String),
    TooManyFiles(usize),
    Io(String),
    /// 确认门未放行（整批零副作用）。
    GateRejected(String),
    /// 提交中途失败并已回滚。
    RolledBack(String),
}

impl std::fmt::Display for BatchReplaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BatchReplaceError::InvalidRule(m) => write!(f, "BATCH_REPLACE_INVALID_RULE: {m}"),
            BatchReplaceError::InvalidTarget(m) => write!(f, "BATCH_REPLACE_INVALID_TARGET: {m}"),
            BatchReplaceError::TooManyFiles(n) => write!(
                f,
                "BATCH_REPLACE_TOO_MANY_FILES: {n} exceeds {MAX_FILES_PER_BATCH}"
            ),
            BatchReplaceError::Io(m) => write!(f, "BATCH_REPLACE_IO: {m}"),
            BatchReplaceError::GateRejected(m) => write!(f, "BATCH_REPLACE_GATE_REJECTED: {m}"),
            BatchReplaceError::RolledBack(m) => write!(f, "BATCH_REPLACE_ROLLED_BACK: {m}"),
        }
    }
}

impl std::error::Error for BatchReplaceError {}

fn relative_target(rel: &str) -> Result<String, BatchReplaceError> {
    let trimmed = rel.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(BatchReplaceError::InvalidTarget("empty path".to_string()));
    }
    if trimmed.starts_with('/') || trimmed.contains(':') || trimmed.contains("..") {
        return Err(BatchReplaceError::InvalidTarget(format!(
            "path must be project-relative without traversal: {rel}"
        )));
    }
    Ok(trimmed)
}

fn resolve(project_root: &Path, rel: &str) -> PathBuf {
    project_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn rel_of(project_root: &Path, path: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 单行字面量替换；大小写不敏感时按字节边界安全地沿线扫描。
fn replace_literal(haystack: &str, rule: &ReplaceRule) -> (String, u32) {
    if rule.case_sensitive {
        let hits = haystack.matches(&rule.find).count() as u32;
        return (haystack.replace(&rule.find, &rule.replace), hits);
    }
    let lower_needle = rule.find.to_lowercase();
    let lower_hay = haystack.to_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut hits = 0u32;
    let mut cursor = 0usize;
    while let Some(found) = lower_hay[cursor..].find(&lower_needle) {
        let start = cursor + found;
        let end = start + rule.find.len();
        if end > haystack.len()
            || !haystack.is_char_boundary(start)
            || !haystack.is_char_boundary(end)
        {
            break;
        }
        out.push_str(&haystack[cursor..start]);
        out.push_str(&rule.replace);
        cursor = end;
        hits += 1;
    }
    out.push_str(&haystack[cursor..]);
    (out, hits)
}

fn scan_file(
    project_root: &Path,
    rel: &str,
    rule: &ReplaceRule,
) -> Result<(FileDiff, String), BatchReplaceError> {
    let path = resolve(project_root, rel);
    let original = std::fs::read_to_string(&path)
        .map_err(|e| BatchReplaceError::Io(format!("read {rel} failed: {e}")))?;

    let mut changes = Vec::new();
    let mut rewritten = String::with_capacity(original.len());
    let mut total = 0u32;
    let ends_with_newline = original.ends_with('\n');
    let line_count = original.lines().count();
    for (idx, line) in original.lines().enumerate() {
        let (new_line, hits) = replace_literal(line, rule);
        if hits > 0 {
            total += hits;
            changes.push(LineChange {
                line: (idx + 1) as u32,
                before: line.to_string(),
                after: new_line.clone(),
            });
        }
        rewritten.push_str(&new_line);
        if idx + 1 < line_count || ends_with_newline {
            rewritten.push('\n');
        }
    }

    Ok((
        FileDiff {
            path: rel.to_string(),
            replacements: total,
            changes,
        },
        rewritten,
    ))
}

/// 只读预览：确定性、零副作用（不建目录、不写文件）。
pub fn batch_replace_preview(
    project_root: &Path,
    files: &[String],
    rule: &ReplaceRule,
) -> Result<Vec<FileDiff>, BatchReplaceError> {
    rule.validate()?;
    if files.len() > MAX_FILES_PER_BATCH {
        return Err(BatchReplaceError::TooManyFiles(files.len()));
    }
    let mut out = Vec::with_capacity(files.len());
    for rel in files {
        let rel = relative_target(rel)?;
        let (diff, _) = scan_file(project_root, &rel, rule)?;
        out.push(diff);
    }
    Ok(out)
}

/// 确认门签名：可注入，便于在单测里把「事务」与「全局门状态」解耦。
pub type GateCheck<'a> = &'a dyn Fn(&Path, GateActor) -> Result<(), BatchReplaceError>;

/// 生产用的真实门：任何未放行的裁决都折算成整批拒绝。
fn real_gate(target: &Path, actor: GateActor) -> Result<(), BatchReplaceError> {
    let outcome = agent_gate::gate_authorize(BATCH_REPLACE_OP, &target.to_string_lossy(), actor);
    if outcome.may_proceed() {
        Ok(())
    } else {
        Err(BatchReplaceError::GateRejected(agent_gate::gate_error(
            &outcome,
        )))
    }
}

/// 事务式提交。`actor` 决定确认门强度：`User` 直接放行，`Agent`/`Cli`/`External`
/// 走确认流程（未确认即 `GateRejected`，整批零副作用）。
pub fn batch_replace_apply(
    project_root: &Path,
    files: &[String],
    rule: &ReplaceRule,
    actor: GateActor,
) -> Result<ApplyReport, BatchReplaceError> {
    batch_replace_apply_with(project_root, files, rule, actor, &real_gate)
}

/// 事务实现本体（门可注入）。事务语义与 [`batch_replace_apply`] 完全一致。
pub fn batch_replace_apply_with(
    project_root: &Path,
    files: &[String],
    rule: &ReplaceRule,
    actor: GateActor,
    gate: GateCheck<'_>,
) -> Result<ApplyReport, BatchReplaceError> {
    let preview = batch_replace_preview(project_root, files, rule)?;
    let changed: Vec<FileDiff> = preview.into_iter().filter(|d| !d.is_unchanged()).collect();
    if changed.is_empty() {
        return Ok(ApplyReport {
            applied: Vec::new(),
            drafts: Vec::new(),
            backup_root: String::new(),
            total_replacements: 0,
            projection_status_updated: false,
            rollback_performed: false,
        });
    }

    // 1) 确认门预检：任一目标未放行 → 整批不动。
    for diff in &changed {
        let target = resolve(project_root, &diff.path);
        gate(&target, actor)?;
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let drafts_root = project_root.join(DRAFTS_ROOT.replace('/', std::path::MAIN_SEPARATOR_STR));
    let batch_dir = drafts_root.join(stamp.to_string());
    let backup_root = batch_dir.join("backup");
    std::fs::create_dir_all(&backup_root)
        .map_err(|e| BatchReplaceError::Io(format!("create drafts failed: {e}")))?;

    // 2) drafts 先行：备份原文 + 落新内容副本。
    let mut staged: Vec<(String, PathBuf, String)> = Vec::new();
    let mut drafts_written: Vec<String> = Vec::new();
    let mut total = 0u32;
    for diff in &changed {
        let (_, rewritten) = scan_file(project_root, &diff.path, rule)?;
        let canonical = resolve(project_root, &diff.path);
        let backup = backup_root.join(&diff.path);
        let draft = batch_dir.join("new").join(&diff.path);
        for path in [backup.clone(), draft.clone()] {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| BatchReplaceError::Io(format!("create dir failed: {e}")))?;
            }
        }
        let original = std::fs::read_to_string(&canonical)
            .map_err(|e| BatchReplaceError::Io(format!("read {} failed: {e}", diff.path)))?;
        std::fs::write(&backup, &original)
            .map_err(|e| BatchReplaceError::Io(format!("backup failed: {e}")))?;
        std::fs::write(&draft, &rewritten)
            .map_err(|e| BatchReplaceError::Io(format!("draft failed: {e}")))?;
        drafts_written.push(rel_of(project_root, &draft));
        total += diff.replacements;
        staged.push((diff.path.clone(), canonical, rewritten));
    }

    // 3) 提交：临时文件 + rename；失败即逆序回滚。
    let mut committed: Vec<(String, PathBuf)> = Vec::new();
    for (rel, canonical, rewritten) in &staged {
        let tmp = canonical.with_extension("batchtmp");
        let write_result = std::fs::write(&tmp, rewritten)
            .map_err(|e| e.to_string())
            .and_then(|_| std::fs::rename(&tmp, canonical).map_err(|e| e.to_string()));
        if let Err(err) = write_result {
            let _ = std::fs::remove_file(&tmp);
            let restored = rollback(&backup_root, &committed);
            return Err(BatchReplaceError::RolledBack(format!(
                "commit failed at {rel}: {err}; {restored} file(s) restored"
            )));
        }
        committed.push((rel.clone(), canonical.clone()));
    }

    // 4) 投影状态刷新（失败不回滚正文：正文已是完整状态，投影可重建）。
    let projection_status_updated = mark_projection_status(project_root, stamp, total).is_ok();

    Ok(ApplyReport {
        applied: committed.iter().map(|(rel, _)| rel.clone()).collect(),
        drafts: drafts_written,
        backup_root: rel_of(project_root, &backup_root),
        total_replacements: total,
        projection_status_updated,
        rollback_performed: false,
    })
}

/// 从备份逆序恢复已提交的文件，返回恢复成功的文件数。
fn rollback(backup_root: &Path, committed: &[(String, PathBuf)]) -> usize {
    let mut restored = 0usize;
    for (rel, canonical) in committed.iter().rev() {
        if let Ok(original) = std::fs::read(backup_root.join(rel)) {
            if std::fs::write(canonical, original).is_ok() {
                restored += 1;
            }
        }
    }
    restored
}

fn mark_projection_status(project_root: &Path, stamp: u128, replacements: u32) -> Result<(), String> {
    let path = project_root.join(PROJECTION_STATUS_FILE.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut value: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !value.is_object() {
        value = serde_json::json!({});
    }
    value["batch_replace"] = serde_json::json!({
        "at": stamp as u64,
        "replacements": replacements,
        "reason": "batch replace committed",
    });
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{body}\n")).map_err(|e| e.to_string())
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────

pub mod api {
    use super::*;

    #[tauri::command]
    pub async fn batch_replace_preview(
        project_path: String,
        files: Vec<String>,
        rule: ReplaceRule,
    ) -> Result<Vec<FileDiff>, String> {
        super::batch_replace_preview(Path::new(&project_path), &files, &rule)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn batch_replace_apply(
        project_path: String,
        files: Vec<String>,
        rule: ReplaceRule,
    ) -> Result<ApplyReport, String> {
        super::batch_replace_apply(Path::new(&project_path), &files, &rule, GateActor::Agent)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod batchreplace {
    use super::*;
    use crate::agent_gate::Decision;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nb-batch-replace-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(root.join("book")).expect("mkdir");
        root
    }

    fn seed(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir parent");
        }
        std::fs::write(path, body).expect("seed");
    }

    fn rule(find: &str, replace: &str) -> ReplaceRule {
        ReplaceRule {
            find: find.to_string(),
            replace: replace.to_string(),
            case_sensitive: false,
        }
    }

    /// 放行一切的替身门：只用于验证事务本身（草稿先行、回滚、投影刷新），
    /// 与「全局门状态（熔断/授权）」彻底解耦。
    fn allow_all(_target: &Path, _actor: GateActor) -> Result<(), BatchReplaceError> {
        Ok(())
    }

    #[test]
    fn preview_is_read_only_and_counts_hits() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("preview");
        seed(&root, "book/c1.md", "林舟走进屋。\n林舟看着窗外。\n");
        let before = std::fs::read_to_string(root.join("book/c1.md")).unwrap();

        let diffs =
            batch_replace_preview(&root, &["book/c1.md".to_string()], &rule("林舟", "林舟舟"))
                .expect("preview");
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].replacements, 2);
        assert_eq!(diffs[0].changes.len(), 2);
        assert_eq!(diffs[0].changes[0].line, 1);

        assert_eq!(
            std::fs::read_to_string(root.join("book/c1.md")).unwrap(),
            before,
            "预览不得改写正文"
        );
        assert!(!root.join(DRAFTS_ROOT).exists(), "预览不得建草稿目录");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_find_and_traversal_are_rejected() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("rule");
        seed(&root, "book/c1.md", "abc\n");
        assert!(matches!(
            batch_replace_preview(&root, &["book/c1.md".to_string()], &rule("", "x"))
                .expect_err("空 find 必须拒"),
            BatchReplaceError::InvalidRule(_)
        ));
        assert!(matches!(
            batch_replace_preview(&root, &["../escape.md".to_string()], &rule("a", "b"))
                .expect_err("越界路径必须拒"),
            BatchReplaceError::InvalidTarget(_)
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gate_reject_rolls_back_all() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("gate");
        seed(&root, "book/c1.md", "林舟走进屋。\n");
        seed(&root, "QM/raw/notes.md", "林舟在禁区里。\n");

        // 保护性真源对破坏性操作硬拒绝，任何 actor 都不可绕过 → 整批零副作用。
        let err = batch_replace_apply(
            &root,
            &["book/c1.md".to_string(), "QM/raw/notes.md".to_string()],
            &rule("林舟", "林舟舟"),
            GateActor::Agent,
        )
        .expect_err("门未放行必须整批拒绝");
        assert!(
            matches!(err, BatchReplaceError::GateRejected(_)),
            "got {err:?}"
        );

        let c1 = std::fs::read_to_string(root.join("book/c1.md")).unwrap();
        assert!(!c1.contains("林舟舟"), "被拒的批改写了 c1.md：{c1}");
        let qm = std::fs::read_to_string(root.join("QM/raw/notes.md")).unwrap();
        assert!(!qm.contains("林舟舟"), "被拒的批改写了保护区：{qm}");
        assert!(!root.join(DRAFTS_ROOT).exists(), "被拒的批不得留草稿");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unconfirmed_irreversible_target_needs_human() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("confirm");
        seed(&root, "book/c1.md", "林舟走进屋。
");
        let target = root.join("book/c1.md");
        let before = std::fs::read_to_string(&target).unwrap();

        // 门的熔断计数（LOOP_THRESHOLD = 3）按 (op,target) 指纹累加，
        // 因此本用例对同一指纹只问两次：一次问「要不要确认」，一次问「确认后能不能写」。
        let probe = agent_gate::gate_authorize(
            BATCH_REPLACE_OP,
            &target.to_string_lossy(),
            GateActor::Agent,
        );
        let request_id = probe.request_id.clone().unwrap_or_else(|| {
            panic!("门应产出确认请求（若为熔断态请清掉 .novel/audit/gate-halt.json）: {probe:?}")
        });
        assert!(!probe.may_proceed(), "确认前不得放行");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            before,
            "只问不写：未确认阶段正文不得变化"
        );
        assert!(!root.join(DRAFTS_ROOT).exists(), "未确认阶段不得留草稿");

        agent_gate::resolve_impl(&request_id, Decision::Allowed, "test confirm")
            .expect("确认应成功");
        let report = batch_replace_apply(
            &root,
            &["book/c1.md".to_string()],
            &rule("林舟", "林舟舟"),
            GateActor::Agent,
        )
        .expect("人类授权后同一调用必须提交");
        assert_eq!(report.applied, vec!["book/c1.md"]);
        assert!(std::fs::read_to_string(&target).unwrap().contains("林舟舟"));
        let _ = std::fs::remove_dir_all(&root);
    
    }

    #[test]
    fn apply_creates_drafts_first() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("drafts");
        seed(&root, "book/c1.md", "林舟走进屋。\n");
        seed(&root, "book/c2.md", "林舟看着窗外。\n");
        

        let report = batch_replace_apply_with(
            &root,
            &["book/c1.md".to_string(), "book/c2.md".to_string()],
            &rule("林舟", "林舟舟"),
            GateActor::Agent,
            &allow_all,
        )
        .expect("人类放行后应提交");

        assert_eq!(report.applied, vec!["book/c1.md", "book/c2.md"]);
        assert_eq!(report.drafts.len(), 2);
        assert_eq!(report.total_replacements, 2);
        assert!(!report.rollback_performed);

        for name in ["book/c1.md", "book/c2.md"] {
            let body = std::fs::read_to_string(root.join(name)).unwrap();
            assert!(body.contains("林舟舟"), "{name} 未提交：{body}");
        }
        // drafts 里有新内容副本，backup 里有原文。
        let draft = root.join(&report.drafts[0]);
        assert!(std::fs::read_to_string(&draft).unwrap().contains("林舟舟"));
        let backup = root.join(&report.backup_root).join("book/c1.md");
        assert!(std::fs::read_to_string(&backup)
            .unwrap()
            .contains("林舟走进屋"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_failure_restores_every_committed_file() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("rollback");
        seed(&root, "book/c1.md", "林舟走进屋。\n");
        seed(&root, "book/c2.md", "林舟看着窗外。\n");
        
        // 第二个目标设为只读 → 覆盖式 rename 必失败（Windows 拒绝替换只读文件）。
        let mut perms = std::fs::metadata(root.join("book/c2.md"))
            .unwrap()
            .permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(root.join("book/c2.md"), perms).expect("readonly");

        let err = batch_replace_apply_with(
            &root,
            &["book/c1.md".to_string(), "book/c2.md".to_string()],
            &rule("林舟", "林舟舟"),
            GateActor::Agent,
            &allow_all,
        )
        .expect_err("提交失败必须回滚");
        assert!(matches!(err, BatchReplaceError::RolledBack(_)), "got {err:?}");

        let restored = std::fs::read_to_string(root.join("book/c1.md")).unwrap();
        assert!(
            restored.contains("林舟走进屋"),
            "已提交文件未回滚：{restored}"
        );
        assert!(!restored.contains("林舟舟"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_marks_projection_status() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("projection");
        seed(&root, "book/c1.md", "林舟走进屋。\n");
        
        let report = batch_replace_apply_with(
            &root,
            &["book/c1.md".to_string()],
            &rule("林舟", "林舟舟"),
            GateActor::Agent,
            &allow_all,
        )
        .expect("apply");
        assert!(report.projection_status_updated);
        let raw = std::fs::read_to_string(root.join(PROJECTION_STATUS_FILE)).expect("status file");
        assert!(raw.contains("batch_replace"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unchanged_batch_is_a_no_op() {
        let _serial = crate::agent_gate::gate_test_serial();
        let root = temp_root("noop");
        seed(&root, "book/c1.md", "abc\n");
        let report = batch_replace_apply(
            &root,
            &["book/c1.md".to_string()],
            &rule("zzz", "yyy"),
            GateActor::Agent,
        )
        .expect("无命中不需要过确认门");
        assert!(report.applied.is_empty());
        assert_eq!(report.total_replacements, 0);
        assert!(!root.join(DRAFTS_ROOT).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
