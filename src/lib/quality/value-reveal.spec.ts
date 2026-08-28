/**
 * value-reveal.spec.ts — v2.6.13 W3 验收
 *
 * 覆盖：三态闭环 / 回写成功率 / 熔断降级
 */
import { describe, expect, it } from "vitest"
import { evaluateValueReveal } from "./value-reveal"

describe("W3 显影闭环 — 曝光→感知→采纳", () => {
  it("链路完整（单调不增）+ 回写≥99%", () => {
    const r = evaluateValueReveal(100, 80, 60, 60)
    expect(r.coverageComplete).toBe(true)
    expect(r.writeRate).toBe(1)
  })

  it("感知>曝光 → 链路断裂（埋点不完整）", () => {
    const r = evaluateValueReveal(80, 100, 60, 60)
    expect(r.coverageComplete).toBe(false)
  })

  it("熔断降级标记（双门返工不阻塞发版）", () => {
    const r = evaluateValueReveal(100, 80, 60, 60, true)
    expect(r.degraded).toBe(true)
  })
})
