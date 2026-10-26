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

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_gate::{
    Decision, GateActor, GateAuditRecord, GateOutcome, RebuildClass, DESTRUCTIVE_OPS,
    GATE_AUDIT_DIR, GATE_AUDIT_FILE, GATE_HALT_FILE, PROTECTED_PREFIXES,
};

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

pub(crate) fn prefix_match(t: &str) -> bool {
    PROTECTED_PREFIXES.iter().any(|p| {
        if p.ends_with('/') {
            t.starts_with(*p)
        } else {
            t == *p || t.starts_with(&format!("{}/", p))
        }
    })
}

/// 项目相对归一：绝对路径先剥离项目根，避免绝对路径绕过前缀判定。
pub(crate) fn relative_to_root(root: Option<&Path>, target: &str) -> String {
    let p = Path::new(target);
    if p.is_absolute() {
        if let Some(root) = root {
            if let Ok(rel) = p.strip_prefix(root) {
                return normalize_target(&rel.to_string_lossy());
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
    let wrapped = format!("/{}", t);
    wrapped.ends_with("/.novel/status.json")
        || wrapped.ends_with("/.novel/schema.md")
        || wrapped.contains("/QM/")
        || wrapped.contains("/canon/")
}

pub fn is_protected_target(target: &str) -> bool {
    protected_prefix(&relative_to_root(None, target))
}

pub fn is_destructive_op(op: &str) -> bool {
    DESTRUCTIVE_OPS.iter().any(|d| d.eq_ignore_ascii_case(op))
}

/// 目标可重建性：只认快照目录与既有投影目录，其余一律按不可重建处理。
pub fn classify_rebuild_class(target: &str) -> RebuildClass {
    let t = normalize_target(target);
    if protected_prefix(&t) {
        return RebuildClass::Irreversible;
    }
    if t.contains(".novel/snapshots/") || t.starts_with(".novel/snapshots/") {
        return RebuildClass::Rebuildable;
    }
    // 只认既有目录约定；不发明新的“可重建根”。
    const DERIVED_ROOTS: [&str; 3] = [".niko-buddy/", ".novel/", "backups/"];
    if DERIVED_ROOTS.iter().any(|r| t.starts_with(*r)) {
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
    format!("{}|{}", op, normalize_target(target))
}

pub(crate) fn halt_path(root: &Path) -> PathBuf {
    root.join(GATE_HALT_FILE)
}

pub(crate) fn append_audit(root: Option<&Path>, rec: &GateAuditRecord) {
    let Some(root) = root else { return };
    let dir = root.join(GATE_AUDIT_DIR);
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
        .open(root.join(GATE_AUDIT_FILE))
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
    if !is_destructive_op(op) {
        // 非破坏性操作不进入门的裁决面，门只拦真实副作用。
        return (Decision::Allowed, "op is not destructive; gate not engaged");
    }
    if op.eq_ignore_ascii_case("runCommand") || actor == GateActor::Cli {
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
