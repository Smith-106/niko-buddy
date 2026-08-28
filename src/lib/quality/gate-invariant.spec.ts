/**
 * gate-invariant.spec.ts — v2.7.2 门控不变量验收
 *
 * 覆盖：P0 失败阻断自动动作 / P2 不覆盖 P0
 */
import { describe, expect, it } from "vitest"
import { assertGateInvariant, type AutoAction } from "./gate-invariant"

const act = (id: string, p0: boolean, p1 = true, p2 = true, action: "rollback" | "closeout" | "intervene" | "none" = "none"): AutoAction => ({ id, gates: { P0: p0, P1: p1, P2: p2 }, action })

describe("门控不变量 — P0>P1>P2", () => {
  it("P0 失败 → 阻断一切自动动作（零违反）", () => {
    const r = assertGateInvariant([act("a1", true, true, true, "rollback"), act("a2", false, true, true, "none")])
    expect(r.p0Overridden).toBe(0)
    expect(r.passed).toBe(true)
  })

  it("P0 失败但执行回滚 → P0 被覆盖", () => {
    const r = assertGateInvariant([act("a1", false, true, true, "rollback")])
    expect(r.p0Overridden).toBe(1)
    expect(r.passed).toBe(false)
  })

  it("P0 失败 + P2 通过 + 结案 → Quality 覆盖尝试", () => {
    const r = assertGateInvariant([act("a1", false, false, true, "closeout")])
    expect(r.qualityOverride).toBe(1)
    expect(r.passed).toBe(false)
  })
})
