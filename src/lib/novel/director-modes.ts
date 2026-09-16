/**
 * director-modes.ts — 波1 模块 10 推进模式库 + 阶段显式化 + draft-autoarm。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md`，三路共识）：
 *   - 「模式即门控程序」：AdvanceMode.phases 的 entryGates/exitGates **只能引用
 *     既有三门注册表**（audit-taxonomy GATE_PRIORITY_ORDER），schema 层 zod enum
 *     硬约束——模式库无法新增可覆盖前序门的门（门序 P0>P1>P2 不可逆的结构性保证）；
 *   - 阶段显式化（GLM/DeepSeek 多数共识）：卷战略卡 + 节奏板的调度面骨架——
 *     阶段进出以「既有门裁定」为唯一开关，无隐性阶段（与 draft-autoarm 同批落地，
 *     共识波次硬约束：阶段显式化与 autoarm 不得拆波交付）；
 *   - draft-autoarm（哲学共识：不吸收自动 accept）：机械门全 PASS → 草稿自动
 *     **升 ready**（armTo 类型层只有 "ready" 单字面量——"accepted" 不在枚举里，
 *     accept 永远是人的动作）；未评估/被短路门 → 不 arm（R-04 未评估 ≠ 通过）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import type { GateKey } from "./audit-taxonomy"
import { gateDisplayStatus, type GateDisplayStatus } from "./run-event-ledger"
import type { GateRunStatus } from "./rule-stack"

// ============================================================================
// 阶段与模式 zod 契约
// ============================================================================

/** 门键枚举（= audit-taxonomy 三门真源；阶段机无法引用注册表之外的门）。 */
const DIRECTOR_GATE_ENUM = z.enum(["consistency", "anti_ai", "quality"])

/** 阶段定义（entryGates/exitGates 仅引用既有门——「模式即门控程序」硬约束）。 */
export const ADVANCE_PHASE_SCHEMA = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    /** 进入阶段前必须 pass 的既有门（缺省 []）。 */
    entryGates: z.array(DIRECTOR_GATE_ENUM).max(3).default([]),
    /** 离开阶段必须 pass 的既有门（缺省 []）。 */
    exitGates: z.array(DIRECTOR_GATE_ENUM).max(3).default([]),
    /** 阶段产物清单（如 volume-strategy-card / beat-board）。 */
    artifacts: z.array(z.string().min(1).max(64)).max(8).default([]),
  })
  .strict()

export type AdvancePhase = z.infer<typeof ADVANCE_PHASE_SCHEMA>

/** 推进模式（阶段显式化载体；阶段线性排列，禁止跳阶段）。 */
export const ADVANCE_MODE_SCHEMA = z
  .object({
    modeId: z.string().min(1).max(64),
    displayName: z.string().min(1).max(128),
    phases: z.array(ADVANCE_PHASE_SCHEMA).min(1).max(12),
  })
  .strict()

export type AdvanceMode = z.infer<typeof ADVANCE_MODE_SCHEMA>

/** 规范化模式定义（schema 违反 → DirectorModeError；重复 phase key 拒绝）。 */
export class DirectorModeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DirectorModeError"
  }
}

export function normalizeAdvanceMode(raw: unknown): AdvanceMode {
  let mode: AdvanceMode
  try {
    mode = ADVANCE_MODE_SCHEMA.parse(raw)
  } catch (err) {
    throw new DirectorModeError(
      `AdvanceMode 契约违反: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const seen = new Set<string>()
  for (const phase of mode.phases) {
    if (seen.has(phase.key)) {
      throw new DirectorModeError(`重复的 phase key: "${phase.key}"`)
    }
    seen.add(phase.key)
  }
  return mode
}

// ============================================================================
// 阶段状态机（线性推进，非法跳变拒绝）
// ============================================================================

/** 阶段运行态。 */
export type AdvancePhaseRunStatus = "not_started" | "in_progress" | "exited"

/** 阶段推进裁定（非法跳变拒绝）。 */
export interface AdvanceTransitionVerdict {
  readonly allowed: boolean
  readonly reason: string
}

/**
 * 阶段转移校验（线性状态机）：
 *   - 只允许推进到**相邻下一阶段**（index+1）或重申当前阶段；
 *   - 跳过中间阶段 / 回退到已完成阶段（非重放语义）→ 拒绝；
 *   - 已是最后阶段 → 无下一阶段（completed）。
 */
export function validateAdvanceTransition(
  mode: AdvanceMode,
  currentPhaseKey: string,
  targetPhaseKey: string,
): AdvanceTransitionVerdict {
  const currentIndex = mode.phases.findIndex((p) => p.key === currentPhaseKey)
  if (currentIndex === -1) {
    return { allowed: false, reason: `未知阶段: "${currentPhaseKey}"` }
  }
  const targetIndex = mode.phases.findIndex((p) => p.key === targetPhaseKey)
  if (targetIndex === -1) {
    return { allowed: false, reason: `未知阶段: "${targetPhaseKey}"` }
  }
  if (targetIndex === currentIndex) {
    return { allowed: true, reason: "same_phase" }
  }
  if (targetIndex === currentIndex + 1) {
    return { allowed: true, reason: "next_phase" }
  }
  if (targetIndex < currentIndex) {
    return { allowed: false, reason: "backward_transition_forbidden" }
  }
  return { allowed: false, reason: "phase_skip_forbidden" }
}

/**
 * 阶段出口判定：exitGates 全部 pass → 可离开（含 skipped 处理——skipped 按
 * R-04 显示语义视为未评估，不得视为通过）。返回未达出门与原因。
 */
export function evaluatePhaseExit(
  mode: AdvanceMode,
  phaseKey: string,
  gateStatuses: Readonly<Record<GateKey, GateRunStatus | undefined>>,
): { canExit: boolean; unmetGates: readonly GateKey[]; reasons: readonly string[] } {
  const phase = mode.phases.find((p) => p.key === phaseKey)
  if (!phase) {
    return { canExit: false, unmetGates: [], reasons: [`未知阶段: "${phaseKey}"`] }
  }
  const unmetGates: GateKey[] = []
  const reasons: string[] = []
  for (const gate of phase.exitGates) {
    const display = gateDisplayStatus(gateStatuses[gate])
    if (display !== "pass") {
      unmetGates.push(gate)
      reasons.push(`${gate}=${display === "not_evaluated" ? "未评估（未落事件=未发生）" : "fail"}`)
    }
  }
  return { canExit: unmetGates.length === 0, unmetGates, reasons }
}

// ============================================================================
// draft-autoarm（机械门全 PASS → 升 ready；绝不 accept）
// ============================================================================

/** autoarm 目标（类型层单字面量："accepted" 不在枚举——accept 永远是人的动作）。 */
export type DraftAutoArmTarget = "ready"

/** autoarm 策略（requiredGates 缺省 = 机械门 P0+P1；P2 quality 永不挡）。 */
export interface DraftAutoArmPolicy {
  readonly enabled: boolean
  readonly requiredGates: readonly GateKey[]
}

/** 缺省策略：机械门（consistency+anti_ai）全 pass 才 arm；quality 不参与（永不挡）。 */
export const DEFAULT_DRAFT_AUTO_ARM_POLICY: DraftAutoArmPolicy = {
  enabled: false,
  requiredGates: ["consistency", "anti_ai"],
}

/** autoarm 裁定。 */
export interface DraftAutoArmDecision {
  /** true → 调用方可将草稿升 ready（不是 accept）。 */
  readonly armed: boolean
  /** armed 时恒 "ready"；未 arm 为 null。 */
  readonly target: DraftAutoArmTarget | null
  /** 机器可读原因（policy_disabled / gate_not_evaluated:<gate> / gate_failed:<gate> / armed / not_gated）。 */
  readonly reason: string
  /** 门显示三态快照（UI 证据链渲染输入，R-04）。 */
  readonly gateSnapshot: Readonly<Record<GateKey, GateDisplayStatus>>
}

/**
 * draft-autoarm 裁定（幂等纯函数）：
 *   1. policy.enabled=false → 不 arm（manual 路径）；
 *   2. requiredGates 任一 display ≠ pass → 不 arm（未评估/fail 逐门可读）；
 *   3. 全过 → armed=true，target 恒 "ready"（armTo 枚举无 accepted）。
 * 幂等：同一输入恒同输出；arm 两次同草稿无副作用（无状态）。
 */
export function evaluateDraftAutoArm(input: {
  readonly policy: DraftAutoArmPolicy
  readonly gateStatuses: Readonly<Record<GateKey, GateRunStatus | undefined>>
}): DraftAutoArmDecision {
  const gateSnapshot: Record<GateKey, GateDisplayStatus> = {
    consistency: gateDisplayStatus(input.gateStatuses.consistency),
    anti_ai: gateDisplayStatus(input.gateStatuses.anti_ai),
    quality: gateDisplayStatus(input.gateStatuses.quality),
  }
  if (!input.policy.enabled) {
    return { armed: false, target: null, reason: "policy_disabled", gateSnapshot }
  }
  for (const gate of input.policy.requiredGates) {
    const display = gateDisplayStatus(input.gateStatuses[gate])
    if (display === "not_evaluated") {
      return { armed: false, target: null, reason: `gate_not_evaluated:${gate}`, gateSnapshot }
    }
    if (display === "fail") {
      return { armed: false, target: null, reason: `gate_failed:${gate}`, gateSnapshot }
    }
  }
  return { armed: true, target: "ready", reason: "all_required_gates_pass", gateSnapshot }
}

/**
 * 运行时兜底断言（供编排层复核任意字符串目标）：
 * autoarm 目标只能是 "ready"；"accepted"（或任何 accept 语义）即抛错。
 */
export function assertAutoArmNeverAccepts(target: string): void {
  if (target === "accepted" || target.startsWith("accept")) {
    throw new DirectorModeError(
      `draft-autoarm 语义违反：autoarm 目标不得为 accept 语义（收到 "${target}"）——accept 永远是人的动作`,
    )
  }
}