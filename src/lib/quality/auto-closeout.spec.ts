/**
 * auto-closeout.spec.ts — v2.7.0 冷评自动结案验收
 *
 * 覆盖：P0/P1 全自动 / P2 回退 / 兜底率上限
 */
import { describe, expect, it } from "vitest"
import { AUTO_CLOSEOUT_RATE, MANUAL_FALLBACK_CAP, evaluateAutoCloseout } from "./auto-closeout"

const ch = (id: string, p0 = true, p1 = true, p2 = true, p2Score = 9, p2Sigma = 0.5) => ({
  id,
  gates: { p0, p1, p2 },
  p2Score,
  p2Sigma,
})

describe("冷评自动结案 — P0/P1 全自动 + P2 回退", () => {
  it("全达标章 → 自动结案率 ≥90%", () => {
    const chapters = Array.from({ length: 20 }, (_, i) => ch(`c${i}`))
    const r = evaluateAutoCloseout(chapters)
    expect(r.autoClosed).toBe(20)
    expect(r.autoRate).toBe(1)
    expect(r.passed).toBe(true)
    expect(AUTO_CLOSEOUT_RATE).toBe(0.9)
  })

  it("P2 异常偏离（分<8）→ 回退人工", () => {
    const chapters = Array.from({ length: 10 }, (_, i) => ch(`c${i}`, true, true, true, i === 0 ? 7.5 : 9))
    const r = evaluateAutoCloseout(chapters)
    expect(r.manualFallback).toBe(1)
    expect(r.fallbackRate).toBe(0.1) // ≤10% 达标
    expect(r.passed).toBe(true)
  })

  it("P0 失败 → 回退人工（门控优先级）", () => {
    const chapters = [ch("c0", false, true, true)]
    const r = evaluateAutoCloseout(chapters)
    expect(r.manualFallback).toBe(1)
    expect(r.passed).toBe(false) // 100% 兜底 >10%
  })

  it("兜底超 10% → 不达标", () => {
    const chapters = Array.from({ length: 10 }, (_, i) => ch(`c${i}`, i % 2 === 0, true, true))
    const r = evaluateAutoCloseout(chapters)
    expect(r.fallbackRate).toBe(0.5)
    expect(r.passed).toBe(false)
    expect(MANUAL_FALLBACK_CAP).toBe(0.1)
  })
})
