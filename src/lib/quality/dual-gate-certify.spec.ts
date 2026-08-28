/**
 * dual-gate-certify.spec.ts — v2.6.13 双门验收
 *
 * 覆盖：四项 AND / 分章口径 / 任一章不过整书不过
 */
import { describe, expect, it } from "vitest"
import { CERTIFY_DELTA, CERTIFY_MEDIAN, CERTIFY_SIGMA, certifyDualGate } from "./dual-gate-certify"

describe("双门认证 — 分章四项 AND", () => {
  it("全部章过 → 认证", () => {
    const r = certifyDualGate([
      { chapter: 1, scores: [9.5, 9.6, 9.5, 9.7, 9.5], baselineMedian: 9.5 },
      { chapter: 2, scores: [9.5, 9.5, 9.6, 9.5, 9.5], baselineMedian: 9.5 },
    ])
    expect(r.certified).toBe(true)
  })

  it("任一章 σ≥0.3 → 整书不过（AND）", () => {
    const r = certifyDualGate([
      { chapter: 1, scores: [9.5, 9.6, 9.5, 9.7, 9.5], baselineMedian: 9.5 },
      { chapter: 2, scores: [9.0, 9.9, 9.0, 9.9, 9.0], baselineMedian: 9.5 }, // σ 大
    ])
    expect(r.chapters[1].pass).toBe(false)
    expect(r.certified).toBe(false)
  })

  it("样本不足（每章<5）不判", () => {
    const r = certifyDualGate([{ chapter: 1, scores: [9.5, 9.5], baselineMedian: 9.5 }])
    expect(r.certified).toBe(false)
  })

  it("阈值冻结", () => {
    expect(CERTIFY_MEDIAN).toBe(9.5)
    expect(CERTIFY_SIGMA).toBe(0.3)
    expect(CERTIFY_DELTA).toBe(0.15)
  })
})
