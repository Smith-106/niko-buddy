/**
 * d3-probe.spec.ts — v2.7.1 D3 探针验收
 *
 * 覆盖：三票融合 / 灰区分类 / 检出≥90% 误报≤5% 双门同报
 */
import { describe, expect, it } from "vitest"
import { classifyConfidence, evaluateProbe, fuseSignals, GRAY_ZONE_HIGH, GRAY_ZONE_LOW } from "./d3-probe"

const res = (id: string, confidence: number) => ({ id, ...classifyConfidence(confidence) })

describe("D3 探针 — 三票融合", () => {
  it("规则 0.3 + 嵌入 0.4 + 一致性 0.3 加权", () => {
    expect(fuseSignals({ rule: 1, embedding: 1, consistency: 1 })).toBe(1)
    expect(fuseSignals({ rule: 0, embedding: 0, consistency: 0 })).toBe(0)
    expect(fuseSignals({ rule: 1, embedding: 0, consistency: 0 })).toBe(0.3)
  })
})

describe("D3 探针 — 灰区分类", () => {
  it("[0.4,0.7] 区间 → 灰区需人工复审", () => {
    expect(GRAY_ZONE_LOW).toBe(0.4)
    expect(GRAY_ZONE_HIGH).toBe(0.7)
    expect(classifyConfidence(0.55).verdict).toBe("gray")
    expect(classifyConfidence(0.55).needsReview).toBe(true)
  })

  it("区间外 → 直接判定", () => {
    expect(classifyConfidence(0.8).verdict).toBe("detected")
    expect(classifyConfidence(0.3).verdict).toBe("clean")
  })
})

describe("D3 探针 — 双门同报", () => {
  it("检出 ≥90% 且误报 ≤5% → 达标", () => {
    const adversarial = Array.from({ length: 100 }, (_, i) => res(`a${i}`, 0.9))
    const clean = Array.from({ length: 100 }, (_, i) => res(`c${i}`, 0.1))
    const r = evaluateProbe(adversarial, clean)
    expect(r.detectRate).toBe(1)
    expect(r.falsePositiveRate).toBe(0)
    expect(r.passed).toBe(true)
  })

  it("检出不足 → 不达标（同报告同门控）", () => {
    const adversarial = [
      ...Array.from({ length: 80 }, (_, i) => res(`a${i}`, 0.9)),
      ...Array.from({ length: 20 }, (_, i) => res(`a${80 + i}`, 0.3)),
    ]
    const r = evaluateProbe(adversarial, [])
    expect(r.detectRate).toBe(0.8)
    expect(r.passed).toBe(false)
  })
})
