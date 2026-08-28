/**
 * weekly-cold-review.spec.ts — v2.6.12 测试 W2 验收
 *
 * 覆盖：盲评出关判定 / Consistency(P0) 独立 PASS
 */
import { describe, expect, it } from "vitest"
import { COLD_REVIEW_EXIT, COLD_REVIEW_MIN_N, evaluateColdReview } from "./weekly-cold-review"

describe("测试 W2 周度冷评 — 出关判定", () => {
  it("中位 ≥9.0 且 N≥5 且 Consistency PASS → 出关", () => {
    const r = evaluateColdReview([9.2, 9.0, 9.1, 9.3, 9.0], true)
    expect(r.median).toBe(9.1)
    expect(r.passed).toBe(true)
    expect(COLD_REVIEW_EXIT).toBe(9.0)
  })

  it("Consistency(P0) 失败 → 不出关（冷评不得覆盖）", () => {
    const r = evaluateColdReview([9.2, 9.0, 9.1, 9.3, 9.0], false)
    expect(r.passed).toBe(false)
  })

  it("样本不足不判（N<5）", () => {
    expect(evaluateColdReview([9.0, 9.0], true).passed).toBe(false)
    expect(COLD_REVIEW_MIN_N).toBe(5)
  })

  it("中位 <9.0 不出关", () => {
    expect(evaluateColdReview([8.5, 8.6, 8.7, 8.8, 8.9], true).passed).toBe(false)
  })
})
