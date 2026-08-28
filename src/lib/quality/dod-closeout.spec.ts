/**
 * dod-closeout.spec.ts — v2.6.13 DoD 收口验收
 *
 * 覆盖：100% 勾选 / DEFER 登记 / 集成无 P0/P1 阻断
 */
import { describe, expect, it } from "vitest"
import { evaluateDodCloseout } from "./dod-closeout"

describe("DoD 收口 — 三条件 AND", () => {
  it("100% 勾选 + DEFER 登记 + 集成干净 → 收口", () => {
    const r = evaluateDodCloseout(10, 10, true, true)
    expect(r.complete).toBe(true)
    expect(r.checkedRate).toBe(1)
  })

  it("未 100% 勾选 → 不收口", () => {
    expect(evaluateDodCloseout(9, 10, true, true).complete).toBe(false)
  })

  it("DEFER 未登记 → 不收口", () => {
    expect(evaluateDodCloseout(10, 10, false, true).complete).toBe(false)
  })

  it("集成有 P0/P1 阻断 → 不收口", () => {
    expect(evaluateDodCloseout(10, 10, true, false).complete).toBe(false)
  })
})
