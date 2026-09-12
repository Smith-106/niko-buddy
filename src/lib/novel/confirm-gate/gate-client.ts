import { invoke } from "@tauri-apps/api/core";

import {
  GATE_TIMEOUT_MS,
  type GateActor,
  type GateDecision,
  type GateOutcome,
  type LoopState,
  type PendingGate,
} from "./gate-classify";

/** 门的四个 IPC 入口；与 Rust 侧命令一一对应。 */
export async function classifyGate(
  op: string,
  target: string,
  actor: GateActor = "agent",
): Promise<GateDecision> {
  return invoke<GateDecision>("confirm_gate_classify", { op, target, actor });
}

export async function listPendingGates(): Promise<PendingGate[]> {
  return invoke<PendingGate[]>("confirm_gate_pending");
}

export async function resolveGate(
  requestId: string,
  decision: GateDecision,
  note = "",
): Promise<GateOutcome> {
  return invoke<GateOutcome>("confirm_gate_resolve", { requestId, decision, note });
}

export async function fetchLoopState(): Promise<LoopState> {
  return invoke<LoopState>("confirm_gate_loop_state");
}

/** 人工确认；语义等价于 `resolveGate(id, "allowed")`。 */
export async function confirmGate(requestId: string, note = ""): Promise<GateOutcome> {
  return resolveGate(requestId, "allowed", note);
}

/** 人工拒绝，也是无响应超时的等价结果。 */
export async function rejectGate(requestId: string, note = ""): Promise<GateOutcome> {
  return resolveGate(requestId, "denied", note);
}

/** 仅用于解除熔断；其余任何入口都无法恢复被熔断的循环。 */
export async function resumeAfterHalt(requestId: string, note = ""): Promise<GateOutcome> {
  return resolveGate(requestId, "resume_after_halt", note);
}

/** 剩余响应窗口（毫秒）；已过期返回 0。 */
export function remainingWindowMs(pending: PendingGate, nowMs: number): number {
  return Math.max(0, pending.deadline_ms - nowMs);
}

export function isExpired(pending: PendingGate, nowMs: number): boolean {
  return remainingWindowMs(pending, nowMs) <= 0;
}

/** 超时文案用；数值来自镜像常量，避免 UI 与 Rust 漂移。 */
export function timeoutSeconds(): number {
  return Math.round(GATE_TIMEOUT_MS / 1000);
}
