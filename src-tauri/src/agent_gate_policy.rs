// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! agent-gate 目标策略纯层——M9-2 自 `agent_gate.rs` 增量剥离（S4 单轮收敛，file_sync_watch 模式）。
//!
//! 收容：时间戳 [`now_ms`]、目标归一 [`normalize_target`]、保护区判定
//! （[`protected_prefix`] / [`prefix_match`] / [`relative_to_root`] /
//! [`is_protected_target`]）、破坏性判定 [`is_destructive_op`]、可重建分类
//! [`classify_rebuild_class`]、判据清单 [`hit_criteria`]、指纹 [`fingerprint`]、
//! 熔断标记路径 [`halt_path`]、审计落盘 [`append_audit`]、结果构造 [`outcome`]
//! 与决策表 [`effective_decision`]——全部无进程单例依赖。
//! `agent_gate.rs` 经 `pub` / `pub(crate) use` 回引，外部 import 面零变化
//! （外部引用与 4 个 Tauri 命令留守原文件）。

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_gate::{
    Decision, GateActor, GateAuditRecord, GateOutcome, RebuildClass, DESTRUCTIVE_OPS,
    GATE_AUDIT_DIR, GATE_AUDIT_FILE, GATE_HALT_FILE, PROTECTED_PREFIXES,
};

/// 判断路径单段是否命中 Windows 保留设备名（大小写不敏感，含扩展名前主干，如 `CON.txt`、`nul.zip`、`COM1`、`LPT9.md`）。
pub(crate) fn is_windows_reserved_device_name(seg: &str) -> bool {
    let trimmed = seg.trim_end_matches(['.', ' ']);
    let stem = trimmed.split('.').next().unwrap_or_default();
    if stem.eq_ignore_ascii_case("CON")
        || stem.eq_ignore_ascii_case("PRN")
        || stem.eq_ignore_ascii_case("AUX")
        || stem.eq_ignore_ascii_case("NUL")
    {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && (bytes[..3].eq_ignore_ascii_case(b"COM") || bytes[..3].eq_ignore_ascii_case(b"LPT"))
        && matches!(bytes[3], b'1'..=b'9')
}

/// 统一单段路径名守卫：确保输入只能作为单个安全目录/文件名段，不可穿越或触碰保留设备名。
pub(crate) fn validate_safe_single_segment<'a>(
    raw: &'a str,
    field_name: &str,
) -> Result<&'a str, String> {
    if raw.is_empty() || raw.trim().is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }
    if raw != raw.trim() {
        return Err(format!(
            "{field_name} must not have leading or trailing whitespace: '{raw}'"
        ));
    }
    if raw == "." || raw == ".." {
        return Err(format!("{field_name} must not be '.' or '..': '{raw}'"));
    }
    if raw.contains('/') || raw.contains('\\') {
        return Err(format!(
            "{field_name} must be a single path segment without separators: '{raw}'"
        ));
    }
    if raw.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(format!(
            "{field_name} must not contain control or NUL characters"
        ));
    }
    if raw.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err(format!(
            "{field_name} contains Windows-illegal filename characters: '{raw}'"
        ));
    }
    if raw.ends_with('.') {
        return Err(format!(
            "{field_name} must not end with a trailing dot: '{raw}'"
        ));
    }
    if is_windows_reserved_device_name(raw) {
        return Err(format!(
            "{field_name} uses a Windows reserved device name: '{raw}'"
        ));
    }
    Ok(raw)
}

/// 从已读取的 `symlink_metadata` 判定目标是否为符号链接或 Windows 名称代理重解析点（含目录联接 Junction / WSL symlink）。
///
/// Rust 标准库在 Windows 上按 Win32 `IsReparseTagNameSurrogate`（`(tag & 0x2000_0000) != 0`）实现
/// `FileType::is_symlink()`：拒绝 symlink、Directory Junction（`IO_REPARSE_TAG_MOUNT_POINT`）与 WSL symlink，
/// 同时放行非名称代理重解析点（如 OneDrive 云占位文件 `0x9000_*`、WOF `0x8000_0017`、Dedup `0x8000_0013`），
/// 避免对 `FILE_ATTRIBUTE_REPARSE_POINT` 一刀切误伤 OneDrive 等目录。
pub(crate) fn metadata_is_symlink_or_reparse_point(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// 判断路径本身是否为符号链接或 Windows 重解析点（不存在时返回 `false`）。
pub(crate) fn is_symlink_or_reparse_point(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata_is_symlink_or_reparse_point(&meta)
}

/// 校验 `root` 及 `root -> target` 链路中所有已存在祖先与目标本体均不含符号链接/重解析点，
/// 且不允许 `..` 等逃逸组件。
pub(crate) fn assert_no_symlink_in_ancestors(root: &Path, target: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if metadata_is_symlink_or_reparse_point(&meta) => {
            return Err(format!(
                "symlink or reparse point rejected at root: {}",
                root.display()
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!("failed to inspect root '{}': {e}", root.display()));
        }
    }

    let rel_buf: PathBuf = if !target.is_absolute() {
        target.to_path_buf()
    } else if let Ok(rel) = target.strip_prefix(root) {
        rel.to_path_buf()
    } else if let Ok(canon_root) = std::fs::canonicalize(root) {
        if let Ok(rel) = target.strip_prefix(&canon_root) {
            rel.to_path_buf()
        } else {
            #[cfg(windows)]
            {
                if let Some(rel) = strip_windows_root_prefix(root, &target.to_string_lossy())
                    .or_else(|| strip_windows_root_prefix(&canon_root, &target.to_string_lossy()))
                {
                    PathBuf::from(rel)
                } else {
                    return Err(format!(
                        "target '{}' is outside root '{}'",
                        target.display(),
                        root.display()
                    ));
                }
            }
            #[cfg(not(windows))]
            {
                return Err(format!(
                    "target '{}' is outside root '{}'",
                    target.display(),
                    root.display()
                ));
            }
        }
    } else {
        #[cfg(windows)]
        {
            if let Some(rel) = strip_windows_root_prefix(root, &target.to_string_lossy()) {
                PathBuf::from(rel)
            } else {
                return Err(format!(
                    "target '{}' is outside root '{}'",
                    target.display(),
                    root.display()
                ));
            }
        }
        #[cfg(not(windows))]
        {
            return Err(format!(
                "target '{}' is outside root '{}'",
                target.display(),
                root.display()
            ));
        }
    };

    let mut current = root.to_path_buf();
    let mut ancestor_missing = false;
    for comp in rel_buf.components() {
        match comp {
            Component::CurDir => continue,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "forbidden path traversal component in '{}'",
                    target.display()
                ));
            }
            Component::Normal(part) => {
                current.push(part);
                if ancestor_missing {
                    continue;
                }
                match std::fs::symlink_metadata(&current) {
                    Ok(meta) => {
                        if metadata_is_symlink_or_reparse_point(&meta) {
                            return Err(format!(
                                "symlink or reparse point rejected: {}",
                                current.display()
                            ));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        ancestor_missing = true;
                    }
                    Err(e) => {
                        return Err(format!(
                            "failed to inspect path '{}': {e}",
                            current.display()
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn normalize_target(target: &str) -> String {
    let t = target.replace('\\', "/");
    let t = t.trim_start_matches("./").to_string();
    // 折叠重复分隔符，避免 "QM//x" 绕过前缀判定。
    let mut out = String::with_capacity(t.len());
    let mut prev_slash = false;
    for ch in t.chars() {
        if ch == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(ch);
    }
    out
}

fn is_windows_drive_segment(seg: &str) -> bool {
    let bytes = seg.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// 路径段归一化（小写 + 分隔符统一 + Windows 尾部点/空格与 NTFS ADS 剥离）。
///
/// 返回 `(raw_segments, folded_segments)`：
/// - `raw_segments` 保留 `".."` 段，防止先触达真源面再借 `".."` 折出；
/// - `folded_segments` 折叠 `".."` 段，防止借 `".."` 折入真源面（如 `.novel/drafts/../status.json`）。
pub(crate) fn normalized_lower_segments(target: &str) -> (Vec<String>, Vec<String>) {
    let replaced = target.replace('\\', "/");
    let mut raw = Vec::new();
    for part in replaced.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            raw.push("..".to_string());
            continue;
        }
        let lower = part.to_ascii_lowercase();
        if is_windows_drive_segment(&lower) {
            raw.push(lower);
            continue;
        }
        let remainder = if raw.is_empty()
            && lower.len() > 2
            && lower.as_bytes()[0].is_ascii_alphabetic()
            && lower.as_bytes()[1] == b':'
        {
            raw.push(lower[..2].to_string());
            &lower[2..]
        } else {
            lower.as_str()
        };
        let without_ads = remainder.split(':').next().unwrap_or(remainder);
        if without_ads.trim_end_matches(' ') == ".." {
            raw.push("..".to_string());
            continue;
        }
        let cleaned = without_ads.trim_end_matches(['.', ' ']);
        if cleaned.is_empty() {
            continue;
        }
        raw.push(cleaned.to_string());
    }

    let mut folded: Vec<String> = Vec::with_capacity(raw.len());
    for seg in &raw {
        if seg == ".." {
            if folded
                .last()
                .is_some_and(|last| !is_windows_drive_segment(last))
            {
                folded.pop();
            }
        } else {
            folded.push(seg.clone());
        }
    }

    (raw, folded)
}

/// 判断归一化后的小写路径段是否命中真源面（与 `write_authority.rs` 口径对齐）。
pub(crate) fn segments_hit_protected(segs: &[String]) -> bool {
    for (idx, seg) in segs.iter().enumerate() {
        if seg == "qm" || seg == "canon" {
            return true;
        }
        if seg == ".novel"
            && matches!(
                segs.get(idx + 1).map(String::as_str),
                Some("status.json" | "schema.md")
            )
        {
            return true;
        }
    }
    false
}

pub(crate) fn prefix_match(t: &str) -> bool {
    let lower = normalize_target(t).to_ascii_lowercase();
    PROTECTED_PREFIXES.iter().any(|p| {
        let stem = p.trim_end_matches('/').to_ascii_lowercase();
        lower == stem
            || lower
                .strip_prefix(stem.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

#[cfg(windows)]
fn strip_windows_root_prefix(root: &Path, target: &str) -> Option<String> {
    fn strip_verbatim(s: &str) -> &str {
        s.strip_prefix("/?/").unwrap_or(s)
    }
    let root_norm = normalize_target(&root.to_string_lossy());
    let root_clean = strip_verbatim(&root_norm).trim_end_matches('/');
    if root_clean.is_empty() {
        return None;
    }
    let target_norm = normalize_target(target);
    let target_clean = strip_verbatim(&target_norm);
    if target_clean.len() < root_clean.len() || !target_clean.is_char_boundary(root_clean.len()) {
        return None;
    }
    let (prefix, rest) = target_clean.split_at(root_clean.len());
    if !prefix.eq_ignore_ascii_case(root_clean) {
        return None;
    }
    if rest.is_empty() {
        return Some(String::new());
    }
    rest.strip_prefix('/').map(normalize_target)
}

/// 项目相对归一：绝对路径先剥离项目根，避免绝对路径绕过前缀判定。
pub(crate) fn relative_to_root(root: Option<&Path>, target: &str) -> String {
    let p = Path::new(target);
    if p.is_absolute() {
        if let Some(root) = root {
            if let Ok(rel) = p.strip_prefix(root) {
                return normalize_target(&rel.to_string_lossy());
            }
            #[cfg(windows)]
            if let Some(rel) = strip_windows_root_prefix(root, target) {
                return rel;
            }
        }
    }
    normalize_target(target)
}

/// 受保护区判定：项目相对前缀，或路径任意位置的不可混淆真源面。
pub(crate) fn protected_prefix(target: &str) -> bool {
    let t = normalize_target(target);
    if prefix_match(&t) {
        return true;
    }
    let (raw, folded) = normalized_lower_segments(&t);
    segments_hit_protected(&raw) || segments_hit_protected(&folded)
}

pub fn is_protected_target(target: &str) -> bool {
    protected_prefix(&relative_to_root(None, target))
}

pub fn is_destructive_op(op: &str) -> bool {
    DESTRUCTIVE_OPS.iter().any(|d| d.eq_ignore_ascii_case(op))
}

/// 既有可重建投影目录根（与 TS 侧 `DERIVED_ROOTS` 镜像逐字对齐）。
const DERIVED_ROOTS: [&str; 3] = [".niko-buddy/", ".novel/", "backups/"];

fn segments_hit_pair(segs: &[String], first: &str, second: &str) -> bool {
    segs.windows(2)
        .any(|pair| pair[0] == first && pair[1] == second)
}

/// 审计日志与熔断标记面（`.novel/audit`）：禁止非人类主体以破坏性操作清除审计或解除熔断。
pub(crate) fn is_audit_surface(target: &str) -> bool {
    let t = normalize_target(target);
    let (raw, folded) = normalized_lower_segments(&t);
    segments_hit_pair(&raw, ".novel", "audit") || segments_hit_pair(&folded, ".novel", "audit")
}

/// 目标可重建性：审计与快照面一律不可重建，其余仅认既有可重建投影目录根。
pub fn classify_rebuild_class(target: &str) -> RebuildClass {
    let t = normalize_target(target);
    if protected_prefix(&t) {
        return RebuildClass::Irreversible;
    }
    let (raw, folded) = normalized_lower_segments(&t);
    if raw.iter().any(|seg| seg == "..") {
        return RebuildClass::Irreversible;
    }
    // R2-S07：先于 DERIVED_ROOTS 判定——审计面与快照面属取证/回滚安全面，一律归为不可重建。
    if segments_hit_pair(&raw, ".novel", "audit")
        || segments_hit_pair(&folded, ".novel", "audit")
        || segments_hit_pair(&raw, ".novel", "snapshots")
        || segments_hit_pair(&folded, ".novel", "snapshots")
    {
        return RebuildClass::Irreversible;
    }
    // 只认既有目录约定；不发明新的“可重建根”。目录本体（长度 < 2）不视为可重建。
    if folded.len() >= 2
        && DERIVED_ROOTS
            .iter()
            .any(|root| folded[0] == root.trim_end_matches('/'))
    {
        return RebuildClass::DerivedRebuildable;
    }
    RebuildClass::Irreversible
}

/// 四判据命中清单（写进审计与确认对话框）。
pub fn hit_criteria(op: &str, target: &str, actor: GateActor) -> Vec<String> {
    let mut hits = Vec::new();
    if protected_prefix(target) {
        hits.push("protected_prefix".to_string());
    }
    if is_destructive_op(op) {
        hits.push("destructive_op".to_string());
    }
    let class = classify_rebuild_class(target);
    if matches!(
        class,
        RebuildClass::Rebuildable | RebuildClass::DerivedRebuildable
    ) {
        hits.push("rebuildable".to_string());
    }
    if op.eq_ignore_ascii_case("runCommand") || actor == GateActor::Cli {
        hits.push("external_side_effect".to_string());
    }
    hits
}

pub(crate) fn fingerprint(op: &str, target: &str) -> String {
    let op_norm = op.to_ascii_lowercase();
    let (_, folded) = normalized_lower_segments(target);
    let target_key = if folded.is_empty() {
        normalize_target(target).to_ascii_lowercase()
    } else {
        folded.join("/")
    };
    format!("{}|{}", op_norm, target_key)
}

/// 逐段拼接相对路径，避免 Windows `\\?\` 规范化根路径因混入 `/` 而被 Win32 API 拒绝。
fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        if !seg.is_empty() {
            out.push(seg);
        }
    }
    out
}

pub(crate) fn audit_dir_path(root: &Path) -> PathBuf {
    join_rel(root, GATE_AUDIT_DIR)
}

pub(crate) fn halt_path(root: &Path) -> PathBuf {
    join_rel(root, GATE_HALT_FILE)
}

pub(crate) fn append_audit(root: Option<&Path>, rec: &GateAuditRecord) {
    let Some(root) = root else { return };
    let dir = audit_dir_path(root);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut line) = serde_json::to_string(rec) else {
        return;
    };
    line.push('\n');
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(join_rel(root, GATE_AUDIT_FILE))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

pub(crate) fn outcome(
    decision: Decision,
    class: RebuildClass,
    hits: Vec<String>,
    request_id: Option<String>,
    reason: &str,
) -> GateOutcome {
    GateOutcome {
        decision,
        class,
        hit_criteria: hits,
        request_id,
        reason: reason.to_string(),
    }
}

pub(crate) fn effective_decision(
    op: &str,
    target: &str,
    class: RebuildClass,
    actor: GateActor,
) -> (Decision, &'static str) {
    if protected_prefix(target) {
        if is_destructive_op(op) {
            // 受保护区对破坏性操作硬拒绝，任何 actor 都不能绕过。
            return (
                Decision::Denied,
                "target is a protected truth surface; not bypassable",
            );
        }
        if actor != GateActor::User {
            // 真源面的非破坏性写入：Agent/CLI/External 必须经人工确认，不得静默落地。
            return (
                Decision::RequireConfirm,
                "protected truth surface requires human confirmation",
            );
        }
        return (
            Decision::Allowed,
            "human actor may write a protected truth surface",
        );
    }
    if is_audit_surface(target) && actor != GateActor::User {
        return (
            Decision::Denied,
            "audit surface cannot be modified by non-human actors",
        );
    }
    if !is_destructive_op(op) {
        // 非破坏性操作不进入门的裁决面，门只拦真实副作用。
        return (Decision::Allowed, "op is not destructive; gate not engaged");
    }
    if actor == GateActor::Cli {
        // 外部进程的逐次写入不在本进程可见范围内，可强制的人工边界是“不得指向保护区”。
        return (
            Decision::Allowed,
            "external process target is outside protected prefixes; audited",
        );
    }
    match class {
        RebuildClass::Rebuildable | RebuildClass::DerivedRebuildable => (
            Decision::Allowed,
            "target is rebuildable from snapshots or projections",
        ),
        RebuildClass::Irreversible => (Decision::RequireConfirm, "target is irreversible"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_directory_junction_is_rejected_while_normal_entries_pass() {
        struct JunctionCleanup {
            junction: PathBuf,
            base: PathBuf,
        }
        impl Drop for JunctionCleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir(&self.junction);
                let _ = std::fs::remove_dir_all(&self.base);
            }
        }

        let base =
            std::env::temp_dir().join(format!("niko-agent-gate-junction-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        let real_dir = root.join("real_dir");
        let real_file = real_dir.join("note.md");
        let outside_dir = base.join("outside");
        let outside_file = outside_dir.join("secret.txt");
        let junction_dir = root.join("linked_dir");

        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::write(&real_file, "ok").unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(&outside_file, "secret").unwrap();

        let _cleanup = JunctionCleanup {
            junction: junction_dir.clone(),
            base: base.clone(),
        };

        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction_dir)
            .arg(&outside_dir)
            .status()
            .expect("spawn cmd mklink /J");
        assert!(status.success(), "mklink /J failed with status: {status}");

        let meta = std::fs::symlink_metadata(&junction_dir).expect("junction symlink_metadata");
        assert!(
            meta.file_type().is_symlink(),
            "Rust stdlib FileType::is_symlink() must report true for Windows directory junctions"
        );
        assert!(is_symlink_or_reparse_point(&junction_dir));
        assert!(!is_symlink_or_reparse_point(&root));
        assert!(!is_symlink_or_reparse_point(&real_dir));
        assert!(!is_symlink_or_reparse_point(&real_file));

        assert!(
            assert_no_symlink_in_ancestors(&root, &junction_dir).is_err(),
            "junction target itself must be rejected"
        );
        assert!(
            assert_no_symlink_in_ancestors(&root, &junction_dir.join("secret.txt")).is_err(),
            "file beneath a junction ancestor must be rejected"
        );
        assert!(
            assert_no_symlink_in_ancestors(&junction_dir, &junction_dir.join("secret.txt"))
                .is_err(),
            "junction root itself must be rejected"
        );
        assert!(
            assert_no_symlink_in_ancestors(&root, &real_file).is_ok(),
            "normal file inside normal dir must be allowed"
        );
        assert!(
            assert_no_symlink_in_ancestors(&root, &real_dir.join("future.md")).is_ok(),
            "non-existent child under normal dir must be allowed"
        );
    }
}
