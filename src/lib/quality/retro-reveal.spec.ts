/**
 * retro-reveal.spec.ts — v2.7.3 回溯显影验收
 *
 * 覆盖：命中 ≥90% / 误报 ≤10% / 低置信折叠 / 一键忽略
 */
import { describe, expect, it } from "vitest"
import { REVEAL_FP_RATE, REVEAL_HIT_RATE, REVEAL_LOW_CONFIDENCE, evaluateReveal, type RevealItem } from "./retro-reveal"

const item = (id: string, confidence: number, isTrue: boolean, ignored = false): RevealItem => ({ id, confidence, isTrue, ignored })

describe("回溯显影 — 命中/误报双门", () => {
  it("标注集命中 ≥90% 且误报 ≤10% → 达标", () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item(`t${i}`, 0.8, true)),
      ...Array.from({ length: 20 }, (_, i) => item(`f${i}`, 0.2, false)),
    ]
    const r = evaluateReveal(items)
    expect(r.hitRate).toBe(1)
    expect(r.falsePositiveRate).toBe(0)
    expect(r.passed).toBe(true)
    expect(REVEAL_HIT_RATE).toBe(0.9)
    expect(REVEAL_FP_RATE).toBe(0.1)
  })

  it("误报超 10% → 不达标", () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item(`t${i}`, 0.8, true)),
      ...Array.from({ length: 10 }, (_, i) => item(`f${i}`, 0.8, false)), // 高置信误报
    ]
    const r = evaluateReveal(items)
    expect(r.falsePositiveRate).toBe(10 / 30)
    expect(r.passed).toBe(false)
  })

  it("低置信 <0.5 折叠不推送", () => {
    const items = [item("t1", 0.4, true), item("t2", 0.8, true)]
    const r = evaluateReveal(items)
    expect(r.lowConfidenceCount).toBe(1)
    expect(REVEAL_LOW_CONFIDENCE).toBe(0.5)
  })

  it("一键忽略可撤销（忽略条目不推送但可恢复）", () => {
    const items = [item("t1", 0.8, true, true)]
    const r = evaluateReveal(items)
    expect(r.ignoreRevertible).toBe(true)
    expect(r.hitRate).toBe(0) // 忽略后不计命中
  })
})
