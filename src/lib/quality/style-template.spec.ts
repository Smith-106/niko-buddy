/**
 * style-template.spec.ts — v2.7.3 风格模板套用验收
 *
 * 覆盖：一致率 ≥90% / P95<2s / 内容保真回退
 */
import { describe, expect, it } from "vitest"
import { CONTENT_FIDELITY_CAP, STYLE_AGREEMENT, STYLE_P95_MS, evaluateStyleBatch, type StyleApplyResult } from "./style-template"

const r = (id: string, agreement: number, durationMs: number, contentDrift = 0): StyleApplyResult => ({ chapterId: id, agreement, durationMs, contentDrift, applied: agreement >= 0.9 && contentDrift <= 0.1 })

describe("风格模板 — 一致率/性能双条件", () => {
  it("30 章一致率 ≥90% 且 P95<2s → 达标", () => {
    const results = Array.from({ length: 30 }, (_, i) => r(`c${i}`, 0.95, 800 + (i % 5) * 100))
    const res = evaluateStyleBatch(results)
    expect(res.agreementRate).toBe(1)
    expect(res.p95Ms).toBeLessThan(STYLE_P95_MS)
    expect(res.passed).toBe(true)
    expect(STYLE_AGREEMENT).toBe(0.9)
  })

  it("一致率不足 → 不达标", () => {
    const results = Array.from({ length: 30 }, (_, i) => r(`c${i}`, i < 15 ? 0.5 : 0.95, 800))
    const res = evaluateStyleBatch(results)
    expect(res.agreementRate).toBe(0.5)
    expect(res.passed).toBe(false)
  })

  it("内容保真失败（contentDrift>10%）→ 回退", () => {
    const results = [r("c1", 0.95, 800, 0.3)]
    const res = evaluateStyleBatch(results)
    expect(res.fidelityFails).toBe(1)
    expect(res.agreementRate).toBe(0)
    expect(CONTENT_FIDELITY_CAP).toBe(0.1)
  })
})
