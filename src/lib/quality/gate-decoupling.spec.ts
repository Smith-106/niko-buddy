/**
 * gate-decoupling.spec.ts — v2.7.0 解耦证明验收
 *
 * 覆盖：决策级一致率 / CI 下限 / 翻转红线 / 最小样本
 */
import { describe, expect, it } from "vitest"
import { DECOUPLING_MIN_N, DECOUPLING_RATE, evaluateDecoupling } from "./gate-decoupling"

const trio = (v: "pass" | "fail") => [
  { model: "m1", verdict: v },
  { model: "m2", verdict: v },
  { model: "m3", verdict: v },
]

describe("解耦证明 — 决策级一致率", () => {
  it("≥95% 且 CI 下限 ≥90% 且零翻转 → 证明通过", () => {
    const decisions = Array.from({ length: 40 }, () => trio("pass"))
    const r = evaluateDecoupling(decisions)
    expect(r.rate).toBe(1)
    expect(r.flips).toBe(0)
    expect(r.proven).toBe(true)
  })

  it("存在结论翻转 → 红线触发（证明失败）", () => {
    const decisions = Array.from({ length: 39 }, () => trio("pass"))
    decisions.push([
      { model: "m1", verdict: "pass" },
      { model: "m2", verdict: "fail" },
      { model: "m3", verdict: "pass" },
    ])
    const r = evaluateDecoupling(decisions)
    expect(r.flips).toBe(1)
    expect(r.proven).toBe(false)
  })

  it("样本不足（N<30）不判", () => {
    expect(evaluateDecoupling(Array.from({ length: 10 }, () => trio("pass"))).proven).toBe(false)
    expect(DECOUPLING_MIN_N).toBe(30)
  })

  it("阈值冻结", () => {
    expect(DECOUPLING_RATE).toBe(0.95)
  })
})
