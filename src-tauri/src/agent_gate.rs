//! Agent 写入确认门与循环熔断：Rust 派发层的唯一强制拦截点。
//!
//! 四个文件系统/进程类破坏性操作（删除、批量替换、命令执行）在进入真实副作用前
//! 必须经过 [`gate_authorize`]。受保护区（状态真源、schema、QM、canon）对破坏性操作
//! 一律硬拒绝，任何 actor 都无法绕过；不可重建的目标改为强制人工确认；
//! 同一目标指纹在窗口内重复触发即熔断停机，只有人工 `ResumeAfterHalt` 能解除。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 单个确认请求的人工响应窗口；到期未响应即视为拒绝，且不重试。
pub const GATE_TIMEOUT_MS: u64 = 120_000;
/// 循环检测的滑动窗口。
pub const LOOP_WINDOW_MS: u64 = 60_000;
/// 窗口内同指纹重复达到该次数即熔断。
pub const LOOP_THRESHOLD: u32 = 3;

pub const GATE_AUDIT_DIR: &str = ".novel/audit";
/// 仅审计用途的追加日志，不构成第二真源。
pub const GATE_AUDIT_FILE: &str = ".novel/audit/gate-audit.jsonl";
/// 熔断标记；进程重启后据此恢复停机态，不自动放行。
pub const GATE_HALT_FILE: &str = ".novel/audit/gate-halt.json";

/// 状态真源与规范层；破坏性操作命中即硬拒绝。
pub const PROTECTED_PREFIXES: [&str; 4] = [".novel/status.json", ".novel/schema.md", "QM/", "canon"];

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
        Decision::Denied => format!("{}{}:{}", GATE_DENIED_PREFIX, out.decision.as_str(), out.reason),
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

struct GateState {
    root: Option<PathBuf>,
    pending: BTreeMap<String, PendingGate>,
    grants: BTreeMap<String, u64>,
    events: Vec<(String, u64)>,
    timed_out: Vec<String>,
    halt: Option<HaltRecord>,
    counter: u64,
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
        }
    }
}

static GATE: OnceLock<Mutex<GateState>> = OnceLock::new();

fn state() -> &'static Mutex<GateState> {
    GATE.get_or_init(|| Mutex::new(GateState::empty()))
}

/// 项目根；审计与熔断标记都相对于它落盘（与 `fs::set_resource_dir_hint` 同惯例）。
pub fn set_gate_project_root(dir: PathBuf) {
    let mut g = state().lock().unwrap_or_else(|e| e.into_inner());
    g.root = Some(dir);
    hydrate_halt_from_disk(&mut g);
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_target(target: &str) -> String {
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

fn prefix_match(t: &str) -> bool {
    PROTECTED_PREFIXES.iter().any(|p| {
        if p.ends_with('/') {
            t.starts_with(*p)
        } else {
            t == *p || t.starts_with(&format!("{}/", p))
        }
    })
}

/// 项目相对归一：绝对路径先剥离项目根，避免绝对路径绕过前缀判定。
fn relative_to_root(root: Option<&Path>, target: &str) -> String {
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
fn protected_prefix(target: &str) -> bool {
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
    const DERIVED_ROOTS: [&str; 3] = [".qmai/", ".novel/", "backups/"];
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
    if matches!(class, RebuildClass::Rebuildable | RebuildClass::DerivedRebuildable) {
        hits.push("rebuildable".to_string());
    }
    if op.eq_ignore_ascii_case("runCommand") || actor == GateActor::Cli {
        hits.push("external_side_effect".to_string());
    }
    hits
}

fn fingerprint(op: &str, target: &str) -> String {
    format!("{}|{}", op, normalize_target(target))
}

fn halt_path(root: &Path) -> PathBuf {
    root.join(GATE_HALT_FILE)
}

fn hydrate_halt_from_disk(g: &mut GateState) {
    if g.halt.is_some() {
        return;
    }
    let Some(root) = g.root.clone() else { return };
    let path = halt_path(&root);
    let Ok(raw) = std::fs::read_to_string(&path) else { return };
    if let Ok(rec) = serde_json::from_str::<HaltRecord>(raw.trim()) {
        g.halt = Some(rec);
    }
}

/// 记录一次同指纹调用；窗口内达到阈值即熔断并落盘标记。
fn record_event(g: &mut GateState, key: &str, now: u64) -> bool {
    g.events.retain(|(_, ts)| now.saturating_sub(*ts) <= LOOP_WINDOW_MS);
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
            let _ = std::fs::create_dir_all(root.join(GATE_AUDIT_DIR));
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

fn append_audit(root: Option<&Path>, rec: &GateAuditRecord) {
    let Some(root) = root else { return };
    let dir = root.join(GATE_AUDIT_DIR);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut line) = serde_json::to_string(rec) else { return };
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

fn outcome(
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

fn effective_decision(op: &str, target: &str, class: RebuildClass, actor: GateActor) -> (Decision, &'static str) {
    if !is_destructive_op(op) {
        // 非破坏性操作不进入门的裁决面，门只拦真实副作用。
        return (Decision::Allowed, "op is not destructive; gate not engaged");
    }
    if protected_prefix(target) {
        // 受保护区对破坏性操作硬拒绝，任何 actor 都不能绕过。
        return (Decision::Denied, "target is a protected truth surface; not bypassable");
    }
    if op.eq_ignore_ascii_case("runCommand") || actor == GateActor::Cli {
        // 外部进程的逐次写入不在本进程可见范围内，可强制的人工边界是“不得指向保护区”。
        return (Decision::Allowed, "external process target is outside protected prefixes; audited");
    }
    match class {
        RebuildClass::Rebuildable | RebuildClass::DerivedRebuildable => {
            (Decision::Allowed, "target is rebuildable from snapshots or projections")
        }
        RebuildClass::Irreversible => (Decision::RequireConfirm, "target is irreversible"),
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

    // 非破坏性操作不进门的裁决面，也不参与循环计数（否则正常写入会被误判为循环）。
    if !is_destructive_op(op) {
        audit(&g, op, target, class, &hits, Decision::Allowed, actor);
        return outcome(
            Decision::Allowed,
            class,
            hits,
            None,
            "op is not destructive; gate not engaged",
        );
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

    let (decision, reason) = effective_decision(op, target, class, actor);
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
    let (decision, reason) = effective_decision(op, target, class, actor);
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
pub fn resolve_impl(request_id: &str, decision: Decision, note: &str) -> Result<GateOutcome, String> {
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

    // 门的运行时状态是进程级单例，测试必须串行，否则彼此会看到对方的熔断态。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> TempTree {
            let mut root = std::env::temp_dir();
            let uniq = format!(
                "nb-gate-{}-{}-{}",
                tag,
                std::process::id(),
                now_ms()
            );
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
        assert!(!first.may_proceed(), "a bracket must not authorize the side effect");

        // 把请求推到窗口之外，模拟 120s 无响应。
        {
            let mut g = state().lock().unwrap();
            let p = g.pending.get_mut(&request_id).expect("pending");
            p.deadline_ms = now_ms().saturating_sub(1);
        }

        let late = resolve_impl(&request_id, Decision::Allowed, "too late");
        assert!(late.is_ok());
        assert_eq!(late.unwrap().decision, Decision::Denied);
        assert!(pending_impl().is_empty(), "timed-out bracket must be dropped");
        assert_eq!(
            sweep_timeouts_impl(now_ms()).len(),
            0,
            "timeout must not be re-armed or retried"
        );
    }

    #[test]
    fn cli_path_cannot_bypass() {
        let _serial = serial();
        for target in [".novel/status.json", "QM/raw/notes.md", "canon/entities.json"] {
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
        assert!(normal.may_proceed(), "ordinary CLI execution must not regress");
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
        let resumed = resolve_impl(&halt_id, Decision::ResumeAfterHalt, "reviewed").expect("resume");
        assert_eq!(resumed.decision, Decision::ResumeAfterHalt);
        assert!(!loop_state_impl().halted);
        assert!(!t.path(GATE_HALT_FILE).exists(), "resume must clear the marker");

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
        let snap = gate_authorize("deleteFile", ".novel/snapshots/ch1/body.md", GateActor::Agent);
        assert_eq!(snap.decision, Decision::Allowed);
        assert_eq!(snap.class, RebuildClass::Rebuildable);

        let derived = gate_authorize("deleteFolder", ".qmai/lancedb", GateActor::Agent);
        assert_eq!(derived.decision, Decision::Allowed);
        assert_eq!(derived.class, RebuildClass::DerivedRebuildable);

        let log = std::fs::read_to_string(t.path(GATE_AUDIT_FILE)).expect("audit log");
        assert!(log.lines().count() >= 2, "allowed decisions must be audited");
        assert!(log.contains("rebuildable"));
    }

    #[test]
    fn non_destructive_ops_are_not_gated() {
        let _serial = serial();
        let _t = use_tree("nondestructive");
        let out = gate_authorize("writeFile", "book/chapter-1.md", GateActor::Agent);
        assert_eq!(out.decision, Decision::Allowed);
        assert!(out.hit_criteria.is_empty() || !out.hit_criteria.iter().any(|c| c == "destructive_op"));
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
}
