/**
 * 确认门判据的 TS 镜像。
 *
 * 真源是 `src-tauri/src/agent_gate.rs`；本文件只做**判定镜像**，不含任何裁决权。
 * 常量与判定顺序必须与 Rust 侧逐字一致，`gate-classify.spec.ts` 会读 Rust 源码做漂移探测。
 */

export const GATE_TIMEOUT_MS = 120_000;
export const LOOP_WINDOW_MS = 60_000;
export const LOOP_THRESHOLD = 3;

export const PROTECTED_PREFIXES = [
  ".novel/status.json",
  ".novel/schema.md",
  "QM/",
  "canon",
] as const;

export const DESTRUCTIVE_OPS = [
  "deleteFile",
  "deleteFolder",
  "batchReplace",
  "runCommand",
] as const;

/** 只认既有目录约定；不发明新的「可重建根」。 */
export const DERIVED_ROOTS = [".qmai/", ".novel/", "backups/"] as const;

export const GATE_CONFIRM_PREFIX = "GATE_REQUIRE_CONFIRM:";
export const GATE_DENIED_PREFIX = "GATE_DENIED:";

export type RebuildClass = "rebuildable" | "derived_rebuildable" | "irreversible";
export type GateDecision = "allowed" | "require_confirm" | "denied" | "resume_after_halt";
export type GateActor = "user" | "agent" | "cli" | "external";

export interface PendingGate {
  request_id: string;
  op: string;
  target: string;
  class: RebuildClass;
  hit_criteria: string[];
  actor: GateActor;
  created_at_ms: number;
  deadline_ms: number;
  diff_summary: string;
}

export interface LoopState {
  halted: boolean;
  fingerprint: string | null;
  halt_request_id: string | null;
  count: number;
  window_ms: number;
  threshold: number;
  since_ms: number | null;
  reason: string | null;
}

export interface GateOutcome {
  decision: GateDecision;
  class: RebuildClass;
  hit_criteria: string[];
  request_id: string | null;
  reason: string;
}

/** 反斜杠归一 + 折叠重复分隔符，避免 `QM//x` 或 `QM\` 绕过前缀判定。 */
export function normalizeGateTarget(target: string): string {
  const slashed = target.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  let prevSlash = false;
  for (const ch of slashed) {
    if (ch === "/") {
      if (prevSlash) continue;
      prevSlash = true;
    } else {
      prevSlash = false;
    }
    out += ch;
  }
  return out;
}

export function isDestructiveOp(op: string): boolean {
  return DESTRUCTIVE_OPS.some((d) => d.toLowerCase() === op.toLowerCase());
}

function prefixMatch(t: string): boolean {
  return PROTECTED_PREFIXES.some((p) =>
    p.endsWith("/") ? t.startsWith(p) : t === p || t.startsWith(`${p}/`),
  );
}

/** 受保护区判定：项目相对前缀，或路径任意位置的不可混淆真源面。 */
export function isProtectedTarget(target: string): boolean {
  const t = normalizeGateTarget(target);
  if (prefixMatch(t)) return true;
  const wrapped = `/${t}`;
  return (
    wrapped.endsWith("/.novel/status.json") ||
    wrapped.endsWith("/.novel/schema.md") ||
    wrapped.includes("/QM/") ||
    wrapped.includes("/canon/")
  );
}

export function classifyRebuildClass(target: string): RebuildClass {
  const t = normalizeGateTarget(target);
  if (isProtectedTarget(t)) return "irreversible";
  if (t.includes(".novel/snapshots/")) return "rebuildable";
  if (DERIVED_ROOTS.some((r) => t.startsWith(r))) return "derived_rebuildable";
  return "irreversible";
}

export function hitCriteria(op: string, target: string, actor: GateActor): string[] {
  const hits: string[] = [];
  if (isProtectedTarget(target)) hits.push("protected_prefix");
  if (isDestructiveOp(op)) hits.push("destructive_op");
  const cls = classifyRebuildClass(target);
  if (cls === "rebuildable" || cls === "derived_rebuildable") hits.push("rebuildable");
  if (op.toLowerCase() === "runcommand" || actor === "cli") hits.push("external_side_effect");
  return hits;
}

/** 与 Rust `effective_decision` 同序：受保护区硬拒 > 非破坏性不裁决 > 可重建放行 > 不可重建要确认。 */
export function effectiveDecision(
  op: string,
  target: string,
  cls: RebuildClass,
  actor: GateActor,
): { decision: GateDecision; reason: string } {
  if (!isDestructiveOp(op)) {
    return { decision: "allowed", reason: "op is not destructive; gate not engaged" };
  }
  if (isProtectedTarget(target)) {
    return {
      decision: "denied",
      reason: "target is a protected truth surface; not bypassable",
    };
  }
  if (op.toLowerCase() === "runcommand" || actor === "cli") {
    return {
      decision: "allowed",
      reason: "external process target is outside protected prefixes; audited",
    };
  }
  if (cls === "rebuildable" || cls === "derived_rebuildable") {
    return { decision: "allowed", reason: "target is rebuildable from snapshots or projections" };
  }
  return { decision: "require_confirm", reason: "target is irreversible" };
}

export interface ParsedGateError {
  code: "require_confirm" | "denied";
  requestId: string | null;
  reason: string;
}

/** 解析 Rust 侧 `gate_error` 抬上来的错误串；非门错误返回 null。 */
export function parseGateError(message: string): ParsedGateError | null {
  if (message.startsWith(GATE_CONFIRM_PREFIX)) {
    const rest = message.slice(GATE_CONFIRM_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep < 0) return { code: "require_confirm", requestId: rest || null, reason: "" };
    return { code: "require_confirm", requestId: rest.slice(0, sep) || null, reason: rest.slice(sep + 1) };
  }
  if (message.startsWith(GATE_DENIED_PREFIX)) {
    const rest = message.slice(GATE_DENIED_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep < 0) return { code: "denied", requestId: null, reason: rest };
    return { code: "denied", requestId: null, reason: rest.slice(sep + 1) };
  }
  return null;
}

export const DEFAULT_GATE_RESOLUTION = "reject" as const;
