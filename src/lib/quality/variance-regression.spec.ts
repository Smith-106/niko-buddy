/**
 * variance-regression.spec.ts — v2.7.4 负向集召回双门验收
 *
 * 覆盖：召回回退 ≤2% / 超限 FAIL
 */
import { describe, expect, it } from "vitest"
import { NEGATIVE_RECALL_FLOOR, evaluateRecallRegression } from "./variance-regression"

describe("负向集召回双门 — 不掩检测退化", () => {
  it("召回持平 → 通过", () => {
    const r = evaluateRecallRegression(18, 20, 18, 20, "v2.7.3-7006868f")
    expect(r.baselineRecall).toBe(0.9)
    expect(r.currentRecall).toBe(0.9)
    expect(r.regression).toBe(0)
    expect(r.passed).toBe(true)
  })

  it("召回回退 ≤2% → 通过", () => {
    const r = evaluateRecallRegression(20, 20, 18, 20, "v2.7.3-7006868f") // 1.0 → 0.9
    expect(r.regression).toBeCloseTo(0.1, 5)
    expect(r.passed).toBe(false)
    const r2 = evaluateRecallRegression(20, 20, 19, 20, "v2.7.3-7006868f") // 1.0 → 0.95
    expect(r2.regression).toBeCloseTo(0.05, 5)
    expect(r2.passed).toBe(false)
    expect(NEGATIVE_RECALL_FLOOR).toBe(0.02)
  })

  it("召回提升 → 通过", () => {
    const r = evaluateRecallRegression(16, 20, 19, 20, "v2.7.3-7006868f")
    expect(r.regression).toBeLessThan(0)
    expect(r.passed).toBe(true)
  })
})
