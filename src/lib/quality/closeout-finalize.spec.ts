/**
 * closeout-finalize.spec.ts — v2.7.2 冷评收口验收
 *
 * 覆盖：误结案 <2% / 95%CI 单侧上界 / L9 文学分永不自动收口
 */
import { describe, expect, it } from "vitest"
import { AUDIT_MIN_N, MISCLOSEOUT_RATE, evaluateCloseoutFinal, type AuditSample } from "./closeout-finalize"

const s = (id: string, autoClosed: boolean, gold: boolean, isLiterary = false): AuditSample => ({ id, autoClosed, gold, isLiterary })

describe("冷评收口 — 误结案 <2%", () => {
  it("独立复核 N=200 零误结 → 达标（CI 上界 <2%）", () => {
    const samples = Array.from({ length: 200 }, (_, i) => s(`s${i}`, true, true))
    const r = evaluateCloseoutFinal(samples)
    expect(r.miscloseoutRate).toBe(0)
    expect(r.ciUpper).toBeLessThan(MISCLOSEOUT_RATE)
    expect(r.passed).toBe(true)
    expect(AUDIT_MIN_N).toBe(200)
  })

  it("误结案超 2% → 不达标", () => {
    const samples = Array.from({ length: 200 }, (_, i) => s(`s${i}`, true, i < 190))
    const r = evaluateCloseoutFinal(samples)
    expect(r.miscloseoutRate).toBe(0.05)
    expect(r.passed).toBe(false)
  })

  it("L9 文学分永不自动收口（=0）", () => {
    const samples = Array.from({ length: 200 }, (_, i) => s(`s${i}`, true, true, i < 10))
    const r = evaluateCloseoutFinal(samples)
    expect(r.literaryAutoClosed).toBe(10)
    expect(r.passed).toBe(false)
  })

  it("样本不足 N<200 → 不判", () => {
    const samples = Array.from({ length: 100 }, (_, i) => s(`s${i}`, true, true))
    expect(evaluateCloseoutFinal(samples).passed).toBe(false)
  })
})
