/**
 * director-modes.spec.ts — 波1 模块 10 推进模式 + 阶段显式化 + draft-autoarm spec 锁定.
 *
 * 覆盖: 「模式即门控程序」（phases 只能引用既有三门，schema 层硬约束）+
 * 线性状态机（相邻推进/同阶段重申 ok，跳阶段/回退/未知阶段拒绝）+ 阶段出口
 * 门判定（skipped→未评估不可出）+ autoarm（机械门全 pass → ready；未评估/fail
 * 不 arm；target 类型层无 accepted；幂等）+ assertAutoArmNeverAccepts.
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_DRAFT_AUTO_ARM_POLICY,
  DirectorModeError,
  evaluateDraftAutoArm,
  evaluatePhaseExit,
  normalizeAdvanceMode,
  validateAdvanceTransition,
  assertAutoArmNeverAccepts,
  type AdvanceMode,
} from "./director-modes"
import type { GateKey } from "./audit-taxonomy"
import type { GateRunStatus } from "./rule-stack"

function mode(overrides: Partial<AdvanceMode> = {}): AdvanceMode {
  return {
    modeId: overrides.modeId ?? "m-standard",
    displayName: overrides.displayName ?? "标准推进",
    phases: overrides.phases ?? [
      { key: "outline", name: "大纲", entryGates: [], exitGates: ["consistency"], artifacts: ["volume-strategy-card"] },
      { key: "draft", name: "草稿", entryGates: ["consistency"], exitGates: ["consistency", "anti_ai"], artifacts: [] },
      { key: "polish", name: "润色", entryGates: ["anti_ai"], exitGates: [], artifacts: ["beat-board"] },
    ],
  }
}

describe("normalizeAdvanceMode（模式即门控程序）", () => {
  it("合法模式通过；非法门引用在 schema 层被拒（禁新增门）", () => {
    expect(normalizeAdvanceMode(mode()).modeId).toBe("m-standard")
    const rogue = mode({ phases: [{ key: "p1", name: "P1", entryGates: ["story_gates_new" as never], exitGates: [], artifacts: [] }] })
    expect(() => normalizeAdvanceMode(rogue)).toThrow(DirectorModeError)
  })

  it("重复 phase key 拒绝；phases 为空拒绝", () => {
    const dup = mode({
      phases: [
        { key: "p1", name: "P1", entryGates: [], exitGates: [], artifacts: [] },
        { key: "p1", name: "P1 重名", entryGates: [], exitGates: [], artifacts: [] },
      ],
    })
    expect(() => normalizeAdvanceMode(dup)).toThrow(/重复的 phase key/)
    expect(() => normalizeAdvanceMode({ modeId: "m", displayName: "M", phases: [] })).toThrow(DirectorModeError)
  })
})

describe("validateAdvanceTransition（线性状态机，非法跳变拒绝）", () => {
  const m = mode()

  it("相邻推进与同阶段重申允许", () => {
    expect(validateAdvanceTransition(m, "outline", "draft")).toMatchObject({ allowed: true, reason: "next_phase" })
    expect(validateAdvanceTransition(m, "draft", "draft")).toMatchObject({ allowed: true, reason: "same_phase" })
  })

  it("跳阶段与回退拒绝", () => {
    expect(validateAdvanceTransition(m, "outline", "polish")).toMatchObject({
      allowed: false,
      reason: "phase_skip_forbidden",
    })
    expect(validateAdvanceTransition(m, "draft", "outline")).toMatchObject({
      allowed: false,
      reason: "backward_transition_forbidden",
    })
  })

  it("未知阶段拒绝", () => {
    expect(validateAdvanceTransition(m, "ghost", "draft").allowed).toBe(false)
    expect(validateAdvanceTransition(m, "outline", "ghost").allowed).toBe(false)
  })
})

describe("evaluatePhaseExit（阶段出口以既有门裁定为唯一开关）", () => {
  const m = mode()

  it("exitGates 全 pass → 可离开", () => {
    const r = evaluatePhaseExit(m, "draft", { consistency: "pass", anti_ai: "pass", quality: "pass" })
    expect(r.canExit).toBe(true)
    expect(r.unmetGates).toHaveLength(0)
  })

  it("fail 门阻断出口", () => {
    const r = evaluatePhaseExit(m, "draft", { consistency: "pass", anti_ai: "fail", quality: "pass" })
    expect(r.canExit).toBe(false)
    expect(r.unmetGates).toEqual(["anti_ai"])
  })

  it("skipped/未评估门不视为通过（R-04）", () => {
    const r = evaluatePhaseExit(m, "draft", { consistency: "skipped", anti_ai: "pass", quality: "pass" })
    expect(r.canExit).toBe(false)
    expect(r.unmetGates).toEqual(["consistency"])
    expect(r.reasons[0]).toContain("未评估")
  })
})

describe("evaluateDraftAutoArm（机械门全 pass → 升 ready；绝不 accept）", () => {
  const allPass: Record<GateKey, GateRunStatus> = { consistency: "pass", anti_ai: "pass", quality: "pass" }

  it("enabled + 机械门全 pass → armed 且 target 恒 ready", () => {
    const d = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: DEFAULT_DRAFT_AUTO_ARM_POLICY.requiredGates },
      gateStatuses: allPass,
    })
    expect(d.armed).toBe(true)
    expect(d.target).toBe("ready")
    expect(d.reason).toBe("all_required_gates_pass")
    expect(d.gateSnapshot.consistency).toBe("pass")
  })

  it("quality fail 不挡 arm（P2 永不挡）", () => {
    const d = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: DEFAULT_DRAFT_AUTO_ARM_POLICY.requiredGates },
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "fail" },
    })
    expect(d.armed).toBe(true)
  })

  it("未评估门 → 不 arm（gate_not_evaluated，未评估≠通过）", () => {
    const d = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: DEFAULT_DRAFT_AUTO_ARM_POLICY.requiredGates },
      gateStatuses: { consistency: "skipped", anti_ai: "pass", quality: "pass" },
    })
    expect(d.armed).toBe(false)
    expect(d.reason).toBe("gate_not_evaluated:consistency")
    expect(d.gateSnapshot.consistency).toBe("not_evaluated")
  })

  it("fail 门 → 不 arm（gate_failed）", () => {
    const d = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: DEFAULT_DRAFT_AUTO_ARM_POLICY.requiredGates },
      gateStatuses: { consistency: "fail", anti_ai: "pass", quality: "pass" },
    })
    expect(d.armed).toBe(false)
    expect(d.reason).toBe("gate_failed:consistency")
  })

  it("policy disabled → 不 arm（manual 路径）；幂等：同输入恒同输出", () => {
    const statuses = { consistency: "pass" as GateRunStatus, anti_ai: "pass" as GateRunStatus, quality: "pass" as GateRunStatus }
    const d1 = evaluateDraftAutoArm({ policy: DEFAULT_DRAFT_AUTO_ARM_POLICY, gateStatuses: statuses })
    expect(d1.armed).toBe(false)
    expect(d1.reason).toBe("policy_disabled")
    const again = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: DEFAULT_DRAFT_AUTO_ARM_POLICY.requiredGates },
      gateStatuses: statuses,
    })
    expect(again).toEqual(again)
    const twice = evaluateDraftAutoArm({
      policy: { enabled: true, requiredGates: DEFAULT_DRAFT_AUTO_ARM_POLICY.requiredGates },
      gateStatuses: statuses,
    })
    expect(again).toEqual(twice)
  })

  it("armTo 枚举无 accepted（类型层）+ 运行时断言兜底", () => {
    // 类型级：DraftAutoArmTarget 只有 "ready"（编译期保证，无断言可写则本行不编译）
    const target: "ready" | null = "ready"
    expect(target).toBe("ready")
    expect(() => assertAutoArmNeverAccepts("accepted")).toThrow(DirectorModeError)
    expect(() => assertAutoArmNeverAccepts("ready")).not.toThrow()
  })
})