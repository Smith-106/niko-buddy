/**
 * accept-metric.spec.ts — v2.7.3 编辑真实 accept 率验收
 *
 * 覆盖：双标注仲裁 / P0 一票否决
 */
import { describe, expect, it } from "vitest"
import { ACCEPT_RATE, evaluateAccept, type AcceptSample } from "./accept-metric"

const s = (id: string, arbitrated: boolean, p0Failed = false): AcceptSample => ({ id, annotatorA: arbitrated, annotatorB: arbitrated, arbitrated, p0Failed })

describe("编辑真实 accept 率 — 双标注 + P0 否决", () => {
  it("仲裁 accept ≥80% → 达标", () => {
    const samples = Array.from({ length: 20 }, (_, i) => s(`s${i}`, i < 18))
    const r = evaluateAccept(samples)
    expect(r.acceptRate).toBe(0.9)
    expect(r.passed).toBe(true)
    expect(ACCEPT_RATE).toBe(0.8)
  })

  it("P0 失败一票否决（剔除不计入分母）", () => {
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => s(`s${i}`, true)),
      s("p0-1", true, true),
      s("p0-2", false, true),
    ]
    const r = evaluateAccept(samples)
    expect(r.p0Excluded).toBe(2)
    expect(r.acceptRate).toBe(1) // 10/10（P0 失败剔除）
    expect(r.passed).toBe(true)
  })

  it("accept 不足 80% → 不达标", () => {
    const samples = Array.from({ length: 20 }, (_, i) => s(`s${i}`, i < 10))
    const r = evaluateAccept(samples)
    expect(r.acceptRate).toBe(0.5)
    expect(r.passed).toBe(false)
  })
})
