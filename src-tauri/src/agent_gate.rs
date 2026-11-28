//! Agent 写入确认门与循环熔断：Rust 派发层的唯一强制拦截点。
//!
//! 四个文件系统/进程类破坏性操作（删除、批量替换、命令执行）在进入真实副作用前
//! 必须经过 [`gate_authorize`]。受保护区（状态真源、schema、QM、canon）对破坏性操作
//! 一律硬拒绝，任何 actor 都无法绕过；不可重建的目标改为强制人工确认；
//! 同一目标指纹在窗口内重复触发即熔断停机，只有人工 `ResumeAfterHalt` 能解除。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

// M9-2：目标策略纯层已剥离至 `agent_gate_policy.rs`——file_sync_watch 模式：新文件 + 原文件回引，外部 import 面零变化。
pub(crate) use crate::agent_gate_policy::{
    append_audit, audit_dir_path, effective_decision, fingerprint, halt_path, is_audit_surface,
    normalize_target, outcome, protected_prefix, relative_to_root,
};
pub use crate::agent_gate_policy::{
    classify_rebuild_class, hit_criteria, is_destructive_op, is_protected_target, now_ms,
};

/// 单个确认请求的人工响应窗口；到期未响应即视为拒绝，且不重试。
pub const GATE_TIMEOUT_MS: u64 = 120_000;
/// 循环检测的滑动窗口。
pub const LOOP_WINDOW_MS: u64 = 60_000;
/// 循环检测窗口内同指纹重复达到该次数即熔断。
pub const LOOP_THRESHOLD: u32 = 3;
/// 批量原子新建后的单次内容锁定回滚凭据有效期（仅用于失败补偿，防止误删既有内容）。
pub const ROLLBACK_TICKET_TTL_MS: u64 = 60_000;
/// 内存回滚凭据容量上限；超限时淘汰最早过期的条目。
pub const MAX_ROLLBACK_TICKETS: usize = 64;

pub const GATE_AUDIT_DIR: &str = ".novel/audit";

/// 门的运行时状态是**进程级单例**（授权/待确认/熔断/计数），而 `#[cfg(test)]` 用例会
/// 重置它。任何读写门状态或依赖「授权必须存活到下一次调用」的用例，都必须持这把**跨模块共享**的锁，
/// 否则会表现为「别的模块的用例随机失败」——这类串扰极易被误判成被测代码的缺陷。
#[cfg(test)]
pub(crate) static GATE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
pub(crate) fn gate_test_serial() -> tokio::sync::MutexGuard<'static, ()> {
    GATE_TEST_LOCK.blocking_lock()
}

#[cfg(test)]
pub(crate) async fn gate_test_serial_async() -> tokio::sync::MutexGuard<'static, ()> {
    GATE_TEST_LOCK.lock().await
}
/// 仅审计用途的追加日志，不构成第二真源。
pub const GATE_AUDIT_FILE: &str = ".novel/audit/gate-audit.jsonl";
/// 熔断标记；进程重启后据此恢复停机态，不自动放行。
pub const GATE_HALT_FILE: &str = ".novel/audit/gate-halt.json";

/// 状态真源与规范层；破坏性操作命中即硬拒绝。
pub const PROTECTED_PREFIXES: [&str; 4] =
    [".novel/status.json", ".novel/schema.md", "QM/", "canon"];

/// 需要经过门的破坏性操作。
pub const DESTRUCTIVE_OPS: [&str; 4] = ["deleteFile", "deleteFolder", "batchReplace", "runCommand"];

/// 可重建性三分类（门的策略依据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebuildClass {
    /// 快照内产物，可从 `.novel/snapshots/` 直接还原。
    Rebuildable,
    /// 投影产物，可由既有投影管线重算。
    DerivedRebuildable,
    /// 无法重建：受保护区、未知路径、或外部进程副作用。
    Irreversible,
}

impl RebuildClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            RebuildClass::Rebuildable => "rebuildable",
            RebuildClass::DerivedRebuildable => "derived_rebuildable",
            RebuildClass::Irreversible => "irreversible",
        }
    }
}

/// 请求发起方的信任层级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateActor {
    User,
    Agent,
    Cli,
    External,
}

impl GateActor {
    pub fn as_str(&self) -> &'static str {
        match self {
            GateActor::User => "user",
            GateActor::Agent => "agent",
            GateActor::Cli => "cli",
            GateActor::External => "external",
        }
    }

    /// 别名，供 TS 侧镜像与命令参数直接使用。
    pub fn parse(raw: &str) -> GateActor {
        match raw {
            "user" => GateActor::User,
            "cli" => GateActor::Cli,
            "external" => GateActor::External,
            _ => GateActor::Agent,
        }
    }
}

/// 门的裁决结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allowed,
    RequireConfirm,
    Denied,
    /// 仅用于人工解除熔断。
    ResumeAfterHalt,
}

impl Decision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Decision::Allowed => "allowed",
            Decision::RequireConfirm => "require_confirm",
            Decision::Denied => "denied",
            Decision::ResumeAfterHalt => "resume_after_halt",
        }
    }
}

/// 前端据此区分「弹确认框」与「直接拒绝」。
pub const GATE_CONFIRM_PREFIX: &str = "GATE_REQUIRE_CONFIRM:";
pub const GATE_DENIED_PREFIX: &str = "GATE_DENIED:";

/// 把门的裁决转成调用方可直接向上返回的错误串。
pub fn gate_error(out: &GateOutcome) -> String {
    match out.decision {
        Decision::RequireConfirm => format!(
            "{}{}:{}",
            GATE_CONFIRM_PREFIX,
            out.request_id.clone().unwrap_or_default(),
            out.reason
        ),
        Decision::Denied => format!(
            "{}{}:{}",
            GATE_DENIED_PREFIX,
            out.decision.as_str(),
            out.reason
        ),
        _ => String::new(),
    }
}

/// `Decision` 的别名，保持卡片里两种拼写都能编译。
pub type GateDecision = Decision;

/// 单个待确认请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingGate {
    pub request_id: String,
    pub op: String,
    pub target: String,
    pub class: RebuildClass,
    pub hit_criteria: Vec<String>,
    pub actor: GateActor,
    pub created_at_ms: u64,
    pub deadline_ms: u64,
    pub diff_summary: String,
}

/// 熔断状态（对前端可见）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopState {
    pub halted: bool,
    pub fingerprint: Option<String>,
    pub halt_request_id: Option<String>,
    pub count: u32,
    pub window_ms: u64,
    pub threshold: u32,
    pub since_ms: Option<u64>,
    pub reason: Option<String>,
}

impl LoopState {
    fn running() -> LoopState {
        LoopState {
            halted: false,
            fingerprint: None,
            halt_request_id: None,
            count: 0,
            window_ms: LOOP_WINDOW_MS,
            threshold: LOOP_THRESHOLD,
            since_ms: None,
            reason: None,
        }
    }
}

/// 门的返回载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateOutcome {
    pub decision: Decision,
    pub class: RebuildClass,
    pub hit_criteria: Vec<String>,
    pub request_id: Option<String>,
    pub reason: String,
}

impl GateOutcome {
    /// 调用方据此决定是否继续真实副作用。
    pub fn may_proceed(&self) -> bool {
        matches!(self.decision, Decision::Allowed)
    }
}

/// 审计记录；`GATE_AUDIT_FILE` 每行一条。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateAuditRecord {
    pub ts: u64,
    pub op: String,
    pub target: String,
    pub class: RebuildClass,
    pub hit_criteria: Vec<String>,
    pub decision: Decision,
    pub actor: GateActor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HaltRecord {
    fingerprint: String,
    request_id: String,
    count: u32,
    ts: u64,
    reason: String,
}

#[derive(Debug, Clone)]
struct RollbackTicket {
    content_sha256: [u8; 32],
    expires_at_ms: u64,
}

struct GateState {
    root: Option<PathBuf>,
    pending: BTreeMap<String, PendingGate>,
    grants: BTreeMap<String, u64>,
    events: Vec<(String, u64)>,
    timed_out: Vec<String>,
    halt: Option<HaltRecord>,
    counter: u64,
    rollback_tickets: BTreeMap<String, RollbackTicket>,
}

impl GateState {
    fn empty() -> GateState {
        GateState {
            root: None,
            pending: BTreeMap::new(),
            grants: BTreeMap::new(),
            events: Vec::new(),
            timed_out: Vec::new(),
            halt: None,
            counter: 0,
            rollback_tickets: BTreeMap::new(),
        }
    }
}

static GATE: OnceLock<Mutex<GateState>> = OnceLock::new();

fn state() -> &'static Mutex<GateState> {
    GATE.get_or_init(|| Mutex::new(GateState::empty()))
}

/// 项目根；审计与熔断标记都相对于它落盘（由项目创建/打开入口绑定）。
pub fn set_gate_project_root(dir: PathBuf) {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    if g.root.as_deref() != Some(dir.as_path()) {
        g.root = Some(dir);
        g.halt = None;
        g.grants.clear();
        g.pending.clear();
        g.events.clear();
        g.timed_out.clear();
        g.rollback_tickets.clear();
    }
    hydrate_halt_from_disk(&mut g);
}

fn hydrate_halt_from_disk(g: &mut GateState) {
    if g.halt.is_some() {
        return;
    }
    let Some(root) = g.root.clone() else { return };
    let path = halt_path(&root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    if let Ok(rec) = serde_json::from_str::<HaltRecord>(raw.trim()) {
        g.halt = Some(rec);
    }
}

/// 记录一次同指纹调用；窗口内达到阈值即熔断并落盘标记。
fn record_event(g: &mut GateState, key: &str, now: u64) -> bool {
    g.events
        .retain(|(_, ts)| now.saturating_sub(*ts) <= LOOP_WINDOW_MS);
    g.events.push((key.to_string(), now));
    let count = g.events.iter().filter(|(k, _)| k == key).count() as u32;
    if count >= LOOP_THRESHOLD {
        let request_id = format!("halt-{}-{}", now, g.counter);
        g.counter += 1;
        let rec = HaltRecord {
            fingerprint: key.to_string(),
            request_id,
            count,
            ts: now,
            reason: format!(
                "same target fingerprint repeated {} times within {}ms",
                count, LOOP_WINDOW_MS
            ),
        };
        if let Some(root) = g.root.clone() {
            let _ = std::fs::create_dir_all(audit_dir_path(&root));
            if let Ok(body) = serde_json::to_string(&rec) {
                let _ = std::fs::write(halt_path(&root), body);
            }
        }
        g.halt = Some(rec);
        return true;
    }
    false
}

/// C13 循环检测入口；返回是否已处于熔断态。
pub fn detect_tool_loop(key: &str, now_ms: u64) -> bool {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    if g.halt.is_some() {
        return true;
    }
    record_event(&mut g, key, now_ms)
}

fn audit(
    g: &GateState,
    op: &str,
    target: &str,
    class: RebuildClass,
    hits: &[String],
    decision: Decision,
    actor: GateActor,
) {
    append_audit(
        g.root.as_deref(),
        &GateAuditRecord {
            ts: now_ms(),
            op: op.to_string(),
            target: target.to_string(),
            class,
            hit_criteria: hits.to_vec(),
            decision,
            actor,
        },
    );
}

/// 到期未响应的请求一律判为拒绝；返回本次被拒的请求 id。
pub fn sweep_timeouts_impl(now: u64) -> Vec<String> {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    let expired: Vec<String> = g
        .pending
        .iter()
        .filter(|(_, p)| p.deadline_ms <= now)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &expired {
        if let Some(p) = g.pending.remove(id) {
            audit(
                &g,
                &p.op,
                &p.target,
                p.class,
                &p.hit_criteria,
                Decision::Denied,
                p.actor,
            );
            g.timed_out.push(p.request_id);
        }
    }
    expired
}

fn sweep_timeouts(g: &mut GateState, now: u64) {
    let expired: Vec<String> = g
        .pending
        .iter()
        .filter(|(_, p)| p.deadline_ms <= now)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &expired {
        if let Some(p) = g.pending.remove(id) {
            audit(
                g,
                &p.op,
                &p.target,
                p.class,
                &p.hit_criteria,
                Decision::Denied,
                p.actor,
            );
            g.timed_out.push(p.request_id);
        }
    }
}

/// 唯一强制拦截入口；调用方必须在真实副作用之前检查 [`GateOutcome::may_proceed`]。
pub fn gate_authorize(op: &str, target: &str, actor: GateActor) -> GateOutcome {
    let now = now_ms();
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    hydrate_halt_from_disk(&mut g);
    sweep_timeouts(&mut g, now);

    let root = g.root.clone();
    let effective = relative_to_root(root.as_deref(), target);
    let hits = hit_criteria(op, &effective, actor);
    let class = classify_rebuild_class(&effective);
    let key = fingerprint(op, &effective);

    // 熔断态优先级最高：必须人工解除，不因重复调用或进程重启而恢复。
    if let Some(halt) = g.halt.clone() {
        audit(&g, op, target, class, &hits, Decision::Denied, actor);
        return outcome(
            Decision::Denied,
            class,
            hits,
            Some(halt.request_id),
            "loop halted; waiting for human ResumeAfterHalt",
        );
    }

    if protected_prefix(&effective) && is_destructive_op(op) {
        audit(&g, op, target, class, &hits, Decision::Denied, actor);
        return outcome(
            Decision::Denied,
            class,
            hits,
            None,
            "target is a protected truth surface; not bypassable",
        );
    }

    if is_audit_surface(&effective) && actor != GateActor::User {
        audit(&g, op, target, class, &hits, Decision::Denied, actor);
        return outcome(
            Decision::Denied,
            class,
            hits,
            None,
            "audit surface cannot be modified by non-human actors",
        );
    }

    // 非破坏性操作不进门裁决面，也不参与循环计数（否则正常写入会被误判为循环）。
    // **例外**：非人类主体写受保护区——真源面绝不允许被 Agent/CLI/External 静默写入，
    // 这类请求必须落到人工确认（见 `effective_decision`），并参与循环计数。
    let protected_needs_human = protected_prefix(&effective) && actor != GateActor::User;
    if !is_destructive_op(op) && !protected_needs_human {
        audit(&g, op, target, class, &hits, Decision::Allowed, actor);
        return outcome(
            Decision::Allowed,
            class,
            hits,
            None,
            "op is not destructive; gate not engaged",
        );
    }

    // 人工已授权的重试**不**计入循环信号（必须在计数之前判定）。
    //
    // 否则「多文件批量逐个确认」会被熔断误伤：每次重试都会从第一个文件重新探测，
    // 于是第一个文件的指纹在第 3 次重试时达阈 → 整个批永久拒绝（而人刚刚逐个确认过）。
    // 循环计数的语义是「**未获授权**的反复尝试」，不是「已授权后的重试」。
    if let Some(exp) = g.grants.get(&key).copied() {
        if exp > now {
            audit(&g, op, target, class, &hits, Decision::Allowed, actor);
            return outcome(
                Decision::Allowed,
                class,
                hits,
                None,
                "allowed by an unexpired human grant",
            );
        }
        g.grants.remove(&key);
    }

    if record_event(&mut g, &key, now) {
        let request_id = g
            .halt
            .as_ref()
            .map(|h| h.request_id.clone())
            .unwrap_or_default();
        audit(&g, op, target, class, &hits, Decision::Denied, actor);
        return outcome(
            Decision::Denied,
            class,
            hits,
            Some(request_id),
            "loop threshold reached; halted",
        );
    }

    let (decision, reason) = effective_decision(op, &effective, class, actor);
    if decision == Decision::RequireConfirm {
        let request_id = format!("gate-{}-{}", now, g.counter);
        g.counter += 1;
        g.pending.insert(
            request_id.clone(),
            PendingGate {
                request_id: request_id.clone(),
                op: op.to_string(),
                target: effective.clone(),
                class,
                hit_criteria: hits.clone(),
                actor,
                created_at_ms: now,
                deadline_ms: now + GATE_TIMEOUT_MS,
                diff_summary: format!(
                    "{} -> {} ({}, criteria: {})",
                    op,
                    normalize_target(target),
                    class.as_str(),
                    hits.join(",")
                ),
            },
        );
        audit(&g, op, target, class, &hits, decision, actor);
        return outcome(decision, class, hits, Some(request_id), reason);
    }

    audit(&g, op, target, class, &hits, decision, actor);
    outcome(decision, class, hits, None, reason)
}

fn ct_eq_sha256(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 为 `write_files_atomic` 刚新建的文件登记单次内容锁定回滚凭据（R-2）。
/// 超出 [`MAX_ROLLBACK_TICKETS`] 时淘汰最早过期的条目。
pub(crate) fn register_creation_rollback_ticket(canonical_key: &str, content_sha256: [u8; 32]) {
    let now = now_ms();
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    g.rollback_tickets.retain(|_, t| t.expires_at_ms > now);
    g.rollback_tickets.remove(canonical_key);
    while g.rollback_tickets.len() >= MAX_ROLLBACK_TICKETS {
        let Some(oldest_key) = g
            .rollback_tickets
            .iter()
            .min_by_key(|(_, t)| t.expires_at_ms)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        g.rollback_tickets.remove(&oldest_key);
    }
    g.rollback_tickets.insert(
        canonical_key.to_string(),
        RollbackTicket {
            content_sha256,
            expires_at_ms: now.saturating_add(ROLLBACK_TICKET_TTL_MS),
        },
    );
}

/// 后续写入覆盖同一物理文件时立即吊销其新建回滚凭据。
pub(crate) fn invalidate_rollback_ticket(canonical_key: &str) {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    g.rollback_tickets.remove(canonical_key);
}

/// 内容锁定回滚删除的门控入口（R-2）：
/// - 熔断态优先级最高，仍硬拒 `Decision::Denied`；
/// - 凭据未过期且定长 SHA-256 比对一致时单次消耗并放行，落 `rollbackDeleteFile` 审计；
/// - 未命中则释放锁后回落标准 `gate_authorize("deleteFile", ...)`（受保护区仍 100% 硬拒）。
pub(crate) fn gate_authorize_rollback_delete(
    target: &str,
    canonical_key: &str,
    expected_sha256: &[u8; 32],
) -> GateOutcome {
    let now = now_ms();
    {
        let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
        hydrate_halt_from_disk(&mut g);
        sweep_timeouts(&mut g, now);
        g.rollback_tickets.retain(|_, t| t.expires_at_ms > now);

        let root = g.root.clone();
        let effective = relative_to_root(root.as_deref(), target);
        let class = classify_rebuild_class(&effective);

        // 熔断态优先级最高：即使持有效回滚凭据也必须硬拒。
        if let Some(halt) = g.halt.clone() {
            let hits = hit_criteria("deleteFile", &effective, GateActor::Agent);
            audit(
                &g,
                "deleteFile",
                target,
                class,
                &hits,
                Decision::Denied,
                GateActor::Agent,
            );
            return outcome(
                Decision::Denied,
                class,
                hits,
                Some(halt.request_id),
                "loop halted; waiting for human ResumeAfterHalt",
            );
        }

        if let Some(ticket) = g.rollback_tickets.get(canonical_key) {
            if ct_eq_sha256(&ticket.content_sha256, expected_sha256) {
                g.rollback_tickets.remove(canonical_key);
                let mut hits = hit_criteria("deleteFile", &effective, GateActor::Agent);
                hits.push("rollback_ticket_verified".to_string());
                audit(
                    &g,
                    "rollbackDeleteFile",
                    target,
                    class,
                    &hits,
                    Decision::Allowed,
                    GateActor::Agent,
                );
                return outcome(
                    Decision::Allowed,
                    class,
                    hits,
                    None,
                    "allowed by single-use creation rollback ticket",
                );
            }
        }
    }
    gate_authorize("deleteFile", target, GateActor::Agent)
}

pub fn classify_impl(op: &str, target: &str, actor: GateActor) -> GateOutcome {
    let now = now_ms();
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    hydrate_halt_from_disk(&mut g);
    sweep_timeouts(&mut g, now);
    let root = g.root.clone();
    let effective = relative_to_root(root.as_deref(), target);
    let hits = hit_criteria(op, &effective, actor);
    let class = classify_rebuild_class(&effective);
    if let Some(halt) = g.halt.clone() {
        return outcome(
            Decision::Denied,
            class,
            hits,
            Some(halt.request_id),
            "loop halted; waiting for human ResumeAfterHalt",
        );
    }
    let (decision, reason) = effective_decision(op, &effective, class, actor);
    outcome(decision, class, hits, None, reason)
}

pub fn pending_impl() -> Vec<PendingGate> {
    let now = now_ms();
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    sweep_timeouts(&mut g, now);
    g.pending.values().cloned().collect()
}

pub fn loop_state_impl() -> LoopState {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    hydrate_halt_from_disk(&mut g);
    match g.halt.clone() {
        Some(h) => LoopState {
            halted: true,
            fingerprint: Some(h.fingerprint),
            halt_request_id: Some(h.request_id),
            count: h.count,
            window_ms: LOOP_WINDOW_MS,
            threshold: LOOP_THRESHOLD,
            since_ms: Some(h.ts),
            reason: Some(h.reason),
        },
        None => LoopState::running(),
    }
}

/// 人工裁决：确认放行、拒绝、或解除熔断。
pub fn resolve_impl(
    request_id: &str,
    decision: Decision,
    note: &str,
) -> Result<GateOutcome, String> {
    let now = now_ms();
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    hydrate_halt_from_disk(&mut g);
    sweep_timeouts(&mut g, now);

    if decision == Decision::ResumeAfterHalt {
        let Some(halt) = g.halt.clone() else {
            return Err("no halted loop to resume".to_string());
        };
        if halt.request_id != request_id {
            return Err(format!(
                "halt request id mismatch: expected {}",
                halt.request_id
            ));
        }
        if let Some(root) = g.root.clone() {
            let _ = std::fs::remove_file(halt_path(&root));
        }
        g.halt = None;
        g.events.clear();
        let rec = GateAuditRecord {
            ts: now,
            op: "resumeAfterHalt".to_string(),
            target: halt.fingerprint.clone(),
            class: RebuildClass::Irreversible,
            hit_criteria: vec!["loop_halted".to_string()],
            decision: Decision::ResumeAfterHalt,
            actor: GateActor::User,
        };
        append_audit(g.root.as_deref(), &rec);
        let _ = note;
        return Ok(outcome(
            Decision::ResumeAfterHalt,
            RebuildClass::Irreversible,
            vec!["loop_halted".to_string()],
            Some(halt.request_id),
            "halt cleared by human",
        ));
    }

    if g.timed_out.iter().any(|id| id == request_id) {
        return Ok(outcome(
            Decision::Denied,
            RebuildClass::Irreversible,
            vec!["timeout".to_string()],
            Some(request_id.to_string()),
            "request timed out; denied and not retried",
        ));
    }

    let Some(p) = g.pending.remove(request_id) else {
        return Err(format!("unknown gate request: {}", request_id));
    };
    match decision {
        Decision::Allowed => {
            let key = fingerprint(&p.op, &p.target);
            g.grants.insert(key, now + GATE_TIMEOUT_MS);
            audit(
                &g,
                &p.op,
                &p.target,
                p.class,
                &p.hit_criteria,
                Decision::Allowed,
                GateActor::User,
            );
            Ok(outcome(
                Decision::Allowed,
                p.class,
                p.hit_criteria,
                Some(p.request_id),
                "confirmed by human",
            ))
        }
        Decision::Denied => {
            audit(
                &g,
                &p.op,
                &p.target,
                p.class,
                &p.hit_criteria,
                Decision::Denied,
                GateActor::User,
            );
            Ok(outcome(
                Decision::Denied,
                p.class,
                p.hit_criteria,
                Some(p.request_id),
                "rejected by human",
            ))
        }
        Decision::RequireConfirm | Decision::ResumeAfterHalt => {
            Err("resolve accepts only human confirm or reject".to_string())
        }
    }
}

#[cfg(test)]
pub fn __reset_state_for_test() {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    let root = g.root.clone();
    *g = GateState::empty();
    g.root = root;
    hydrate_halt_from_disk(&mut g);
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn confirm_gate_classify(
    op: String,
    target: String,
    actor: Option<String>,
) -> Result<GateDecision, String> {
    let actor = actor
        .as_deref()
        .map(GateActor::parse)
        .unwrap_or(GateActor::Agent);
    Ok(classify_impl(&op, &target, actor).decision)
}

#[tauri::command]
pub async fn confirm_gate_pending() -> Result<Vec<PendingGate>, String> {
    Ok(pending_impl())
}

#[tauri::command]
pub async fn confirm_gate_resolve(
    request_id: String,
    decision: Decision,
    note: Option<String>,
) -> Result<GateOutcome, String> {
    resolve_impl(&request_id, decision, &note.unwrap_or_default())
}

#[tauri::command]
pub async fn confirm_gate_loop_state() -> Result<LoopState, String> {
    Ok(loop_state_impl())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serial() -> tokio::sync::MutexGuard<'static, ()> {
        gate_test_serial()
    }

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> TempTree {
            let mut root = std::env::temp_dir();
            let uniq = format!("nb-gate-{}-{}-{}", tag, std::process::id(), now_ms());
            root.push(uniq);
            std::fs::create_dir_all(root.join(".novel/audit")).expect("mkdir");
            TempTree { root }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn use_tree(tag: &str) -> TempTree {
        let t = TempTree::new(tag);
        set_gate_project_root(t.root.clone());
        __reset_state_for_test();
        t
    }

    #[test]
    fn bracket_timeout_is_denied() {
        let _serial = serial();
        let _t = use_tree("timeout");
        let target = "output/irreversible-draft.bin";
        assert_eq!(
            classify_rebuild_class(target),
            RebuildClass::Irreversible,
            "fixture must be irreversible so the gate opens a bracket"
        );

        let first = gate_authorize("deleteFile", target, GateActor::Agent);
        assert_eq!(first.decision, Decision::RequireConfirm);
        let request_id = first.request_id.clone().expect("bracket request id");
        assert!(
            !first.may_proceed(),
            "a bracket must not authorize the side effect"
        );

        // 把请求推到窗口之外，模拟 120s 无响应。
        {
            let mut g = state().lock().unwrap();
            let p = g.pending.get_mut(&request_id).expect("pending");
            p.deadline_ms = now_ms().saturating_sub(1);
        }

        let late = resolve_impl(&request_id, Decision::Allowed, "too late");
        assert!(late.is_ok());
        assert_eq!(late.unwrap().decision, Decision::Denied);
        assert!(
            pending_impl().is_empty(),
            "timed-out bracket must be dropped"
        );
        assert_eq!(
            sweep_timeouts_impl(now_ms()).len(),
            0,
            "timeout must not be re-armed or retried"
        );
    }

    #[test]
    fn cli_path_cannot_bypass() {
        let _serial = serial();
        for target in [
            ".novel/status.json",
            "QM/raw/notes.md",
            "canon/entities.json",
        ] {
            let out = gate_authorize("deleteFile", target, GateActor::Cli);
            assert_eq!(
                out.decision,
                Decision::Denied,
                "CLI must not bypass protected target {}",
                target
            );
            assert!(!out.may_proceed());
        }
        // 反斜杠与重复分隔符不得成为绕过路径。
        let sneaky = gate_authorize("deleteFile", "QM\\..\\QM/raw/notes.md", GateActor::Cli);
        assert_eq!(sneaky.decision, Decision::Denied);

        // 非保护区的 CLI 执行仍被记录为外部副作用，但不拦普通使用。
        let normal = gate_authorize("runCommand", "book/chapter-1.md", GateActor::Cli);
        assert!(
            normal.may_proceed(),
            "ordinary CLI execution must not regress"
        );
        assert!(normal
            .hit_criteria
            .iter()
            .any(|c| c == "external_side_effect"));
    }

    #[test]
    fn loop_halts_without_auto_resume() {
        let _serial = serial();
        let t = use_tree("loop");
        let target = "output/tmp-draft.bin";

        for _ in 0..(LOOP_THRESHOLD - 1) {
            let out = gate_authorize("deleteFile", target, GateActor::Agent);
            assert_eq!(out.decision, Decision::RequireConfirm);
            let id = out.request_id.expect("request id");
            // 人工拒绝，避免 grant 掩盖循环信号。
            let _ = resolve_impl(&id, Decision::Denied, "no");
        }

        let halting = gate_authorize("deleteFile", target, GateActor::Agent);
        assert_eq!(halting.decision, Decision::Denied, "threshold must halt");
        assert!(loop_state_impl().halted);
        assert!(t.path(GATE_HALT_FILE).exists(), "halt must be persisted");

        // 熔断后连普通操作都被拒，且不会自我恢复。
        let after = gate_authorize("deleteFile", "book/ok.md", GateActor::Agent);
        assert_eq!(after.decision, Decision::Denied);

        // 进程重启（状态重建 + 从盘上恢复）不得自动放行。
        __reset_state_for_test();
        assert!(loop_state_impl().halted, "restart must not auto-resume");
        let post_restart = gate_authorize("deleteFile", "book/ok.md", GateActor::Agent);
        assert_eq!(post_restart.decision, Decision::Denied);

        // 仅人工 ResumeAfterHalt 解除。
        let halt_id = loop_state_impl().halt_request_id.expect("halt id");
        let resumed =
            resolve_impl(&halt_id, Decision::ResumeAfterHalt, "reviewed").expect("resume");
        assert_eq!(resumed.decision, Decision::ResumeAfterHalt);
        assert!(!loop_state_impl().halted);
        assert!(
            !t.path(GATE_HALT_FILE).exists(),
            "resume must clear the marker"
        );

        let cleared = gate_authorize("deleteFile", "book/ok.md", GateActor::Agent);
        assert_ne!(
            cleared.decision,
            Decision::Denied,
            "after a human resume the gate must evaluate normally"
        );
    }

    #[test]
    fn rebuildable_targets_pass_and_are_audited() {
        let _serial = serial();
        let t = use_tree("rebuildable");
        let draft = gate_authorize(
            "deleteFile",
            ".novel/drafts/ch1/draft.json",
            GateActor::Agent,
        );
        assert_eq!(draft.decision, Decision::Allowed);
        assert_eq!(draft.class, RebuildClass::DerivedRebuildable);

        let derived = gate_authorize("deleteFolder", ".niko-buddy/lancedb", GateActor::Agent);
        assert_eq!(derived.decision, Decision::Allowed);
        assert_eq!(derived.class, RebuildClass::DerivedRebuildable);

        let log = std::fs::read_to_string(t.path(GATE_AUDIT_FILE)).expect("audit log");
        assert!(
            log.lines().count() >= 2,
            "allowed decisions must be audited"
        );
        assert!(log.contains("rebuildable"));
    }

    #[test]
    fn non_destructive_write_to_truth_surface_needs_human() {
        let _serial = serial();
        let _t = use_tree("protected-write");

        // 真源面的**非破坏性**写入：Agent/CLI/External 必须人工确认，不得静默落地。
        // （每个 actor 用不同目标，避开同指纹的循环计数互扰。）
        for (i, actor) in [GateActor::Agent, GateActor::Cli, GateActor::External]
            .into_iter()
            .enumerate()
        {
            let target = format!("QM/memory/remote-{i}.md");
            let out = gate_authorize("writeFile", &target, actor);
            assert_eq!(
                out.decision,
                Decision::RequireConfirm,
                "{actor:?} 写真源面必须人工确认，实际 {:?}（{}）",
                out.decision,
                out.reason
            );
            assert!(!out.may_proceed(), "确认前不得放行副作用");
            let id = out.request_id.expect("应产出确认请求");
            let resolved = resolve_impl(&id, Decision::Denied, "no").expect("resolve");
            assert_eq!(resolved.decision, Decision::Denied);
        }

        // 人类主体写同一面：允许（用户显式编辑 canon/QM 是正当路径）。
        let human = gate_authorize("writeFile", "QM/memory/human.md", GateActor::User);
        assert_eq!(human.decision, Decision::Allowed, "人类编辑真源面不得被拦");

        // 非保护区写入不得回归。
        let normal = gate_authorize("writeFile", "book/chapter-2.md", GateActor::Agent);
        assert_eq!(normal.decision, Decision::Allowed);

        // 保护区的破坏性操作仍是硬拒（任何 actor）。
        let destructive = gate_authorize("deleteFile", "QM/memory/remote-0.md", GateActor::User);
        assert_eq!(destructive.decision, Decision::Denied);

        // 反复尝试静默写真源面属循环信号：同指纹达阈值即熔断。
        // 门的熔断态是**进程级单例**且会落盘，所以本用例结束前必须由人工解除，
        // 否则会污染同进程其他用例（同 `loop_halts_without_auto_resume` 的收尾纪律）。
        let loop_target = "QM/memory/loop.md";
        let mut halted = false;
        for _ in 0..LOOP_THRESHOLD {
            let out = gate_authorize("writeFile", loop_target, GateActor::External);
            if out.decision == Decision::Denied {
                assert!(
                    out.reason.contains("loop"),
                    "阈值内应为确认请求，超出后应为熔断：{}",
                    out.reason
                );
                halted = true;
                break;
            }
            let id = out.request_id.expect("request id");
            let _ = resolve_impl(&id, Decision::Denied, "no");
        }
        assert!(halted, "重复静默写真源面必须在阈值内触发熔断");
        assert!(loop_state_impl().halted);

        let halt_id = loop_state_impl().halt_request_id.expect("halt id");
        assert_eq!(
            resolve_impl(&halt_id, Decision::ResumeAfterHalt, "test cleanup")
                .expect("resume")
                .decision,
            Decision::ResumeAfterHalt
        );
        assert!(
            !loop_state_impl().halted,
            "本用例必须清理熔断态，避免污染同进程其他用例"
        );
    }

    #[test]
    fn granted_retries_do_not_trip_the_loop_breaker() {
        let _serial = serial();
        let _t = use_tree("grant-loop");
        let target = "output/irreversible-draft.bin";

        let first = gate_authorize("deleteFile", target, GateActor::Agent);
        assert_eq!(first.decision, Decision::RequireConfirm);
        let id = first.request_id.clone().expect("request id");
        assert_eq!(
            resolve_impl(&id, Decision::Allowed, "user confirmed")
                .expect("resolve")
                .decision,
            Decision::Allowed
        );

        // 已授权的重试反复发生不得触发熔断——多文件批量会逐个确认并反复重跑整批。
        for round in 0..(LOOP_THRESHOLD + 2) {
            let retry = gate_authorize("deleteFile", target, GateActor::Agent);
            assert_eq!(
                retry.decision,
                Decision::Allowed,
                "第 {round} 次已授权重试被拦：{}",
                retry.reason
            );
            assert!(retry.reason.contains("grant"));
            assert!(!loop_state_impl().halted, "已授权重试不得把门停在熔断态");
        }

        // 但“未获授权”的反复尝试仍必须熔断（安全检查未被削弱）。
        let other = "output/irreversible-draft-2.bin";
        for _ in 0..(LOOP_THRESHOLD - 1) {
            let out = gate_authorize("deleteFile", other, GateActor::Agent);
            assert_eq!(out.decision, Decision::RequireConfirm);
            let id = out.request_id.expect("request id");
            let _ = resolve_impl(&id, Decision::Denied, "no");
        }
        let halting = gate_authorize("deleteFile", other, GateActor::Agent);
        assert_eq!(halting.decision, Decision::Denied, "未授权反复尝试仍须熔断");
        assert!(loop_state_impl().halted);

        // 收尾：解除熔断，避免污染同进程其他用例。
        let halt_id = loop_state_impl().halt_request_id.expect("halt id");
        assert_eq!(
            resolve_impl(&halt_id, Decision::ResumeAfterHalt, "test cleanup")
                .expect("resume")
                .decision,
            Decision::ResumeAfterHalt
        );
        assert!(!loop_state_impl().halted);
    }

    #[test]
    fn non_destructive_ops_are_not_gated() {
        let _serial = serial();
        let _t = use_tree("nondestructive");
        let out = gate_authorize("writeFile", "book/chapter-1.md", GateActor::Agent);
        assert_eq!(out.decision, Decision::Allowed);
        assert!(
            out.hit_criteria.is_empty() || !out.hit_criteria.iter().any(|c| c == "destructive_op")
        );
    }

    #[test]
    fn confirm_grant_lets_the_retry_through_once() {
        let _serial = serial();
        let _t = use_tree("grant");
        let target = "output/irreversible-draft.bin";
        let first = gate_authorize("deleteFile", target, GateActor::Agent);
        assert_eq!(first.decision, Decision::RequireConfirm);

        let id = first.request_id.clone().expect("request id");
        let resolved = resolve_impl(&id, Decision::Allowed, "user confirmed").expect("resolve");
        assert_eq!(resolved.decision, Decision::Allowed);

        let retry = gate_authorize("deleteFile", target, GateActor::Agent);
        assert_eq!(retry.decision, Decision::Allowed);
        assert!(retry.reason.contains("grant"));
    }

    /// ISS-20261029-005：本地 CLI 的门控键按请求区分。连续的不同请求不得触发熔断，
    /// 也不得连带拒绝无关写入；完全相同的请求重复仍按原阈值熔断。
    #[test]
    fn distinct_cli_requests_do_not_trip_loop_breaker() {
        use crate::commands::local_cli_config::cli_gate_target;
        let _serial = serial();
        let _t = use_tree("cli-req");
        // 目标是固定标签，不含带用户名的绝对路径，不会命中受保护区子串判定。
        let probe = cli_gate_target("claude", "m", &[b"x"]);
        assert!(!protected_prefix(&probe), "{probe}");
        assert!(!is_protected_target(&probe), "{probe}");

        for i in 0..(LOOP_THRESHOLD * 2) {
            let prompt = format!("chapter review dimension {i}");
            let target = cli_gate_target("claude", "m", &[prompt.as_bytes()]);
            let out = gate_authorize("runCommand", &target, GateActor::Cli);
            assert!(
                out.may_proceed(),
                "distinct request {i} must proceed: {}",
                out.reason
            );
        }
        let write = gate_authorize("writeFile", "book/chapter-9.md", GateActor::User);
        assert!(
            write.may_proceed(),
            "unrelated user write must stay allowed"
        );

        let same = cli_gate_target("claude", "m", &[b"same prompt"]);
        for _ in 0..(LOOP_THRESHOLD - 1) {
            assert!(gate_authorize("runCommand", &same, GateActor::Cli).may_proceed());
        }
        let halting = gate_authorize("runCommand", &same, GateActor::Cli);
        assert_eq!(halting.decision, Decision::Denied);
        assert!(
            halting.reason.contains("loop threshold"),
            "{}",
            halting.reason
        );

        // 熔断态是进程级全局状态；不清理会让同进程后续用例（batch_replace、
        // snapshot_timemachine、mcp_remote 等）随执行顺序偶发失败。
        let halt_id = loop_state_impl().halt_request_id.expect("halt id");
        resolve_impl(&halt_id, Decision::ResumeAfterHalt, "test cleanup").expect("resume");
        assert!(
            !loop_state_impl().halted,
            "本用例必须清理熔断态，避免污染同进程其他用例"
        );
    }

    #[test]
    fn protected_targets_are_case_insensitive_and_match_truth_surface() {
        let _serial = serial();
        let _t = use_tree("case-insensitive");

        for target in [
            ".novel/STATUS.JSON",
            ".NOVEL/Schema.MD",
            "qm/raw/a.md",
            "qm",
            "QM",
            "CANON",
            "Canon/entities.json",
            r"C:\proj\.NOVEL\STATUS.JSON",
            r"C:\proj\qm\raw\a.md",
            r"C:\proj\CANON\ch-01.md",
        ] {
            assert!(
                is_protected_target(target),
                "保护路径变体必须命中保护判定：{target}"
            );
            assert_eq!(
                classify_rebuild_class(target),
                RebuildClass::Irreversible,
                "保护路径变体必须为 Irreversible：{target}"
            );
            let del = gate_authorize("deleteFile", target, GateActor::Agent);
            assert_eq!(
                del.decision,
                Decision::Denied,
                "保护路径变体的破坏性操作必须硬拒绝：{target}"
            );
            let write_classified = classify_impl("writeFile", target, GateActor::Agent);
            assert_eq!(
                write_classified.decision,
                Decision::RequireConfirm,
                "非人类写保护路径变体必须要求人工确认：{target}"
            );
        }

        // 不得误报包含相似子串的非保护路径。
        for safe in [
            "book/my-canon-notes.md",
            ".novel/drafts/status.json",
            "book/qm-notes/chapter-1.md",
            "book/schema.md",
        ] {
            assert!(
                !is_protected_target(safe),
                "非保护路径不应误报受保护：{safe}"
            );
            let write_classified = classify_impl("writeFile", safe, GateActor::Agent);
            assert_eq!(
                write_classified.decision,
                Decision::Allowed,
                "非保护路径的常规写入不应被误拦：{safe}"
            );
        }
        assert_eq!(
            classify_rebuild_class(".novel/drafts/status.json"),
            RebuildClass::DerivedRebuildable
        );
    }

    #[test]
    fn protected_targets_catch_traversal_and_keep_parent_dir_conservative() {
        let _serial = serial();
        let _t = use_tree("traversal");

        for sneaky in [
            ".novel/drafts/../status.json",
            r".novel\drafts\..\STATUS.JSON",
            "book/../qm/raw/a.md",
            "QM/../book/ok.md",
            "foo/bar/../../CANON/ch.md",
            ".novel/./SCHEMA.MD",
        ] {
            assert!(
                is_protected_target(sneaky),
                "穿越变体必须命中保护判定：{sneaky}"
            );
            assert_eq!(
                classify_rebuild_class(sneaky),
                RebuildClass::Irreversible,
                "穿越变体必须判为 Irreversible：{sneaky}"
            );
            let del = gate_authorize("deleteFile", sneaky, GateActor::Cli);
            assert_eq!(
                del.decision,
                Decision::Denied,
                "穿越变体的删除操作必须硬拒绝：{sneaky}"
            );
        }

        // 含 `..` 的非保护路径仍保守判为 Irreversible，禁止被归类为可重建而跳过确认。
        assert_eq!(
            classify_rebuild_class(".novel/snapshots/../other.md"),
            RebuildClass::Irreversible
        );
        assert_eq!(
            classify_rebuild_class("backups/../book/chapter-1.md"),
            RebuildClass::Irreversible
        );
        // 目录本体 `.novel` 包含 status.json/schema.md，不得归类为可重建。
        assert_eq!(classify_rebuild_class(".novel"), RebuildClass::Irreversible);
    }

    #[test]
    fn fingerprint_normalizes_op_case_and_windows_target_case() {
        assert_eq!(
            fingerprint("deleteFile", "output/a.bin"),
            fingerprint("DELETEFILE", "output/a.bin")
        );
        #[cfg(windows)]
        {
            assert_eq!(
                fingerprint("deleteFile", r"C:\Proj\Output\A.BIN"),
                fingerprint("DELETEFILE", "c:/proj/output/a.bin")
            );
            assert_eq!(
                relative_to_root(Some(std::path::Path::new(r"C:\Proj")), r"c:\proj\book\a.md"),
                "book/a.md"
            );
            assert!(is_protected_target(r"C:\proj\.novel\status.json::$DATA"));
            assert!(is_protected_target(r".novel\STATUS.JSON."));
            assert!(is_protected_target(r"qm \raw\notes.md"));
        }
    }

    #[test]
    fn resource_dir_hint_does_not_overwrite_gate_project_root() {
        let _serial = serial();
        let project = use_tree("resource-hint-proj");
        let resource = TempTree::new("resource-hint-res");

        crate::commands::fs_pdf::set_resource_dir_hint(resource.root.clone());

        {
            let g = state().lock().unwrap();
            assert_eq!(
                g.root.as_deref(),
                Some(project.root.as_path()),
                "set_resource_dir_hint 不得改写确认门的项目根"
            );
        }

        let out = gate_authorize("writeFile", "book/ch-1.md", GateActor::Agent);
        assert_eq!(out.decision, Decision::Allowed);
        assert!(
            project.path(GATE_AUDIT_FILE).is_file(),
            "审计日志仍应写入真实项目根"
        );
        assert!(
            !resource.path(GATE_AUDIT_FILE).exists(),
            "审计日志不得落盘到资源目录"
        );
    }

    #[test]
    fn create_project_impl_binds_real_project_root() {
        let _serial = serial();
        let _old = use_tree("before-create-proj");
        let parent = TempTree::new("create-proj-parent");

        let created = crate::commands::project::create_project_impl(
            "bound-novel".to_string(),
            parent.root.to_string_lossy().to_string(),
        )
        .expect("create_project_impl 应成功");
        assert_eq!(created.name, "bound-novel");

        let created_root = parent.root.join("bound-novel");
        let expected_root =
            std::fs::canonicalize(&created_root).unwrap_or_else(|_| created_root.clone());
        {
            let g = state().lock().unwrap();
            assert_eq!(
                g.root.as_deref(),
                Some(expected_root.as_path()),
                "create_project_impl 必须将确认门绑定到新建项目的规范化根路径"
            );
        }

        let draft_abs = expected_root
            .join(".novel")
            .join("drafts")
            .join("ch1")
            .join("draft.json");
        let out = gate_authorize("deleteFile", &draft_abs.to_string_lossy(), GateActor::Agent);
        assert_eq!(out.class, RebuildClass::DerivedRebuildable);
        assert_eq!(out.decision, Decision::Allowed);
        assert!(
            created_root
                .join(".novel")
                .join("audit")
                .join("gate-audit.jsonl")
                .is_file(),
            "绑定后的审计日志应落盘到新建项目根下"
        );
    }

    #[test]
    fn switching_project_root_clears_stale_grants_and_hydrates_new_disk_halt() {
        let _serial = serial();
        let _tree_a = use_tree("switch-root-a");

        // 项目 A：建立人工 grant、挂起 pending，并触发熔断。
        let grant_target = "output/secret-a.bin";
        let first = gate_authorize("deleteFile", grant_target, GateActor::Agent);
        assert_eq!(first.decision, Decision::RequireConfirm);
        let grant_req_id = first.request_id.expect("grant request id");
        assert_eq!(
            resolve_impl(&grant_req_id, Decision::Allowed, "ok")
                .expect("resolve grant")
                .decision,
            Decision::Allowed
        );
        let granted = gate_authorize("deleteFile", grant_target, GateActor::Agent);
        assert_eq!(granted.decision, Decision::Allowed);
        assert!(granted.reason.contains("grant"));

        let pending_req = gate_authorize("deleteFile", "output/pending-a.bin", GateActor::Agent);
        assert_eq!(pending_req.decision, Decision::RequireConfirm);
        assert!(!pending_impl().is_empty());

        let loop_target = "output/loop-a.bin";
        for _ in 0..(LOOP_THRESHOLD - 1) {
            let out = gate_authorize("deleteFile", loop_target, GateActor::Agent);
            assert_eq!(out.decision, Decision::RequireConfirm);
            let id = out.request_id.expect("loop req id");
            let _ = resolve_impl(&id, Decision::Denied, "no");
        }
        let halted = gate_authorize("deleteFile", loop_target, GateActor::Agent);
        assert_eq!(halted.decision, Decision::Denied);
        assert!(loop_state_impl().halted);

        // 切到干净项目 B：旧 grant / pending / halt 必须全部清空，不得跨项目泄漏。
        let tree_b = TempTree::new("switch-root-b");
        set_gate_project_root(tree_b.root.clone());
        assert!(!loop_state_impl().halted, "切根后旧项目熔断态不得残留");
        assert!(pending_impl().is_empty(), "切根后旧项目待确认队列必须清空");
        let after_switch = gate_authorize("deleteFile", grant_target, GateActor::Agent);
        assert_eq!(
            after_switch.decision,
            Decision::RequireConfirm,
            "项目 A 的 grant 不得泄漏到项目 B"
        );

        // 切到盘上已有熔断标记的项目 C：必须立即加载项目 C 的盘上 halt。
        let tree_c = TempTree::new("switch-root-c");
        let disk_halt = HaltRecord {
            fingerprint: "deletefile|output/c-loop.bin".to_string(),
            request_id: "halt-disk-c".to_string(),
            count: LOOP_THRESHOLD,
            ts: now_ms(),
            reason: "persisted halt on project C".to_string(),
        };
        std::fs::write(
            halt_path(&tree_c.root),
            serde_json::to_string(&disk_halt).expect("serialize halt"),
        )
        .expect("write project C halt");

        set_gate_project_root(tree_c.root.clone());
        let state_c = loop_state_impl();
        assert!(state_c.halted, "切到项目 C 后应立即加载其盘上熔断态");
        assert_eq!(state_c.halt_request_id.as_deref(), Some("halt-disk-c"));
        let blocked = gate_authorize("deleteFile", "book/ok.md", GateActor::Agent);
        assert_eq!(blocked.decision, Decision::Denied);

        // 收尾清理熔断态，避免影响同进程后续用例。
        resolve_impl("halt-disk-c", Decision::ResumeAfterHalt, "test cleanup").expect("resume C");
        assert!(!loop_state_impl().halted);
    }

    #[test]
    fn bare_protected_roots_denied_and_agent_run_command_requires_confirm() {
        let _serial = serial();
        let _t = use_tree("bare-protected-roots");

        for target in ["QM", "qm", "Qm", "canon", "CANON", "Canon"] {
            for op in ["deleteFolder", "deleteFile", "runCommand"] {
                for actor in [
                    GateActor::Agent,
                    GateActor::Cli,
                    GateActor::User,
                    GateActor::External,
                ] {
                    let out = gate_authorize(op, target, actor);
                    assert_eq!(
                        out.decision,
                        Decision::Denied,
                        "无尾斜杠保护根与大小写变体必须硬拒绝：op={op} target={target} actor={actor:?}"
                    );
                    assert!(!out.may_proceed());
                }
            }
        }

        // 收紧策略：非 CLI actor 发起 runCommand 指向不可重建目标须走人工确认，CLI 仍放行。
        let agent_cmd = gate_authorize("runCommand", "book/chapter-1.md", GateActor::Agent);
        assert_eq!(agent_cmd.decision, Decision::RequireConfirm);
        let cli_cmd = gate_authorize("runCommand", "book/chapter-2.md", GateActor::Cli);
        assert_eq!(cli_cmd.decision, Decision::Allowed);
    }

    #[test]
    fn rollback_tickets_evict_earliest_expire_and_clear_on_root_switch() {
        let _serial = serial();
        let _tree_a = use_tree("rollback-tickets-a");
        let digest = [0x42u8; 32];

        // 装满容量上限，并人为将 k-000 设为最早过期项。
        for i in 0..MAX_ROLLBACK_TICKETS {
            register_creation_rollback_ticket(&format!("k-{i:03}"), digest);
        }
        {
            let mut g = state().lock().unwrap();
            assert_eq!(g.rollback_tickets.len(), MAX_ROLLBACK_TICKETS);
            let oldest = g.rollback_tickets.get_mut("k-000").expect("k-000 present");
            oldest.expires_at_ms = now_ms().saturating_add(1_000);
        }

        // 第 65 条写入必须淘汰最早过期的 k-000。
        register_creation_rollback_ticket("k-extra", digest);
        {
            let g = state().lock().unwrap();
            assert_eq!(g.rollback_tickets.len(), MAX_ROLLBACK_TICKETS);
            assert!(!g.rollback_tickets.contains_key("k-000"));
            assert!(g.rollback_tickets.contains_key("k-extra"));
        }

        // 过期票据不得放行，必须回落至标准硬拒。
        {
            let mut g = state().lock().unwrap();
            let extra = g
                .rollback_tickets
                .get_mut("k-extra")
                .expect("k-extra present");
            extra.expires_at_ms = now_ms().saturating_sub(1);
        }
        let expired = gate_authorize_rollback_delete("QM/chapters/ch.md", "k-extra", &digest);
        assert_eq!(expired.decision, Decision::Denied);

        // 切根必须清空所有未消费回滚票据。
        register_creation_rollback_ticket("k-switch", digest);
        let tree_b = TempTree::new("rollback-tickets-b");
        set_gate_project_root(tree_b.root.clone());
        let after_switch = gate_authorize_rollback_delete("QM/chapters/ch.md", "k-switch", &digest);
        assert_eq!(after_switch.decision, Decision::Denied);
    }

    #[test]
    fn snapshots_and_audit_surfaces_are_irreversible_and_audit_is_denied_for_non_human() {
        let _serial = serial();
        let _t = use_tree("r2-s07-audit-snapshots");

        // .novel/snapshots/* 归为 Irreversible，破坏性操作须人工确认，不得静默放行。
        for snap_target in [
            ".novel/snapshots/ch1/body.md",
            r".NOVEL\SNAPSHOTS\s1\status.json",
            ".novel/drafts/../snapshots/s1/body.md",
        ] {
            assert_eq!(
                classify_rebuild_class(snap_target),
                RebuildClass::Irreversible,
                "快照目录必须判为不可重建：{snap_target}"
            );
            let out = gate_authorize("deleteFile", snap_target, GateActor::Agent);
            assert_eq!(
                out.decision,
                Decision::RequireConfirm,
                "Agent 删除快照必须要求确认：{snap_target}"
            );
            assert!(!out.may_proceed());
        }

        // .novel/audit/* 归为 Irreversible，且对非 User 的任何写入或删除操作一律硬拒绝。
        for audit_target in [
            ".novel/audit/gate-halt.json",
            ".novel/audit/gate-audit.jsonl",
            ".novel/drafts/../audit/gate-halt.json",
            ".novel/AUDIT/gate-halt.json.",
            ".novel/audit/gate-halt.json::$DATA",
        ] {
            assert_eq!(
                classify_rebuild_class(audit_target),
                RebuildClass::Irreversible,
                "审计目录必须判为不可重建：{audit_target}"
            );
            for actor in [GateActor::Agent, GateActor::Cli, GateActor::External] {
                for op in ["deleteFile", "writeFile"] {
                    let classified = classify_impl(op, audit_target, actor);
                    assert_eq!(
                        classified.decision,
                        Decision::Denied,
                        "非人类对审计面的 {op} 分类必须硬拒绝：actor={actor:?} target={audit_target}"
                    );
                    let out = gate_authorize(op, audit_target, actor);
                    assert_eq!(
                        out.decision,
                        Decision::Denied,
                        "非人类对审计面的 {op} 必须硬拒绝：actor={actor:?} target={audit_target}"
                    );
                    assert!(!out.may_proceed());
                }
            }
        }
    }

    #[test]
    fn fingerprint_folds_traversal_dots_and_ads_to_prevent_loop_bypass() {
        let _serial = serial();
        let _t = use_tree("r2-s07-fingerprint");

        let base = fingerprint("deleteFile", "book/c1.md");
        for variant in [
            "book/./c1.md",
            "book/sub/../c1.md",
            "book/c1.md.",
            "book/c1.md::$DATA",
            r"BOOK\sub\..\c1.md",
            "book//./c1.md ",
        ] {
            assert_eq!(
                fingerprint("deleteFile", variant),
                base,
                "路径变体应折叠为同一指纹：{variant}"
            );
        }

        // 交替使用等价路径变体仍必须在第 3 次触发循环熔断。
        let first = gate_authorize("deleteFile", "book/./c1.md", GateActor::Agent);
        assert_eq!(first.decision, Decision::RequireConfirm);
        let second = gate_authorize("deleteFile", "book/sub/../c1.md", GateActor::Agent);
        assert_eq!(second.decision, Decision::RequireConfirm);
        let third = gate_authorize("deleteFile", "book/c1.md::$DATA", GateActor::Agent);
        assert_eq!(third.decision, Decision::Denied);
        assert!(
            loop_state_impl().halted,
            "等价路径变体不得绕过 3 次循环熔断"
        );

        // 清理全局熔断态，避免影响同进程其他测试。
        let halt_id = loop_state_impl().halt_request_id.expect("halt id");
        resolve_impl(&halt_id, Decision::ResumeAfterHalt, "test cleanup").expect("resume");
        assert!(!loop_state_impl().halted);
    }

    #[test]
    fn path_guard_primitives_validate_segments_and_reject_symlinks() {
        use crate::agent_gate_policy::{
            assert_no_symlink_in_ancestors, validate_safe_single_segment,
        };

        assert_eq!(
            validate_safe_single_segment("chapter-01_v2.md", "id").unwrap(),
            "chapter-01_v2.md"
        );
        assert_eq!(
            validate_safe_single_segment("1.2.3", "version").unwrap(),
            "1.2.3"
        );
        for bad in [
            "",
            "   ",
            " lead",
            "trail ",
            ".",
            "..",
            "a/b",
            r"a\b",
            "bad\0name",
            "bad\nname",
            "a<b",
            "a:b",
            "a|b",
            "a?b",
            "a*b",
            "trailing.",
            "CON",
            "con.txt",
            "PRN.md",
            "aux",
            "NUL.zip",
            "COM1",
            "com9.json",
            "LPT1",
            "lpt9.md",
        ] {
            assert!(
                validate_safe_single_segment(bad, "seg").is_err(),
                "非法单段名必须拒绝：{bad:?}"
            );
        }

        let tree = TempTree::new("guard-ancestors");
        let sub = tree.root.join("safe").join("nested.txt");
        assert!(assert_no_symlink_in_ancestors(&tree.root, &sub).is_ok());
        assert!(assert_no_symlink_in_ancestors(&tree.root, &tree.root.join("../escape")).is_err());
    }

    #[test]
    fn gate_test_serial_sync_and_async_are_mutually_exclusive() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        // 方向 1：同步锁持有期间，异步 gate_test_serial_async().await 必须阻塞且零重叠。
        let in_critical = Arc::new(AtomicBool::new(false));
        let async_entered = Arc::new(AtomicBool::new(false));
        let overlap = Arc::new(AtomicBool::new(false));

        let sync_guard = gate_test_serial();
        in_critical.store(true, Ordering::SeqCst);

        let in_c = Arc::clone(&in_critical);
        let entered_c = Arc::clone(&async_entered);
        let overlap_c = Arc::clone(&overlap);
        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build current_thread runtime");
            rt.block_on(async move {
                let _async_guard = gate_test_serial_async().await;
                if in_c.swap(true, Ordering::SeqCst) {
                    overlap_c.store(true, Ordering::SeqCst);
                }
                entered_c.store(true, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(15)).await;
                in_c.store(false, Ordering::SeqCst);
            });
        });

        std::thread::sleep(Duration::from_millis(30));
        assert!(
            !async_entered.load(Ordering::SeqCst),
            "async waiter must stay blocked while sync gate_test_serial guard is held"
        );
        in_critical.store(false, Ordering::SeqCst);
        drop(sync_guard);

        handle.join().expect("async thread should finish");
        assert!(async_entered.load(Ordering::SeqCst));
        assert!(
            !overlap.load(Ordering::SeqCst),
            "sync and async gate_test_serial guards must never overlap"
        );

        // 方向 2：异步锁跨 .await 持有期间，同步 gate_test_serial() 必须阻塞直至释放。
        let async_active = Arc::new(AtomicBool::new(false));
        let async_started = Arc::new(AtomicBool::new(false));
        let active_c = Arc::clone(&async_active);
        let started_c = Arc::clone(&async_started);
        let handle2 = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build current_thread runtime");
            rt.block_on(async move {
                let _async_guard = gate_test_serial_async().await;
                active_c.store(true, Ordering::SeqCst);
                started_c.store(true, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(35)).await;
                active_c.store(false, Ordering::SeqCst);
            });
        });

        while !async_started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        let sync_guard2 = gate_test_serial();
        assert!(
            !async_active.load(Ordering::SeqCst),
            "sync gate_test_serial must not acquire lock while async guard is still active"
        );
        drop(sync_guard2);
        handle2.join().expect("second async thread should finish");
    }
}
