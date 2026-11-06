/**
 * gray-zone-review.spec.ts — v2.7.1 灰区复审验收
 *
 * 覆盖：全量人工复审 / 边界稳定性（误判率 ≤1.5×）
 */
import { describe, expect, it } from "vitest"
import { GRAY_MISJUDGE_RATIO_CAP, evaluateGrayZone, kappaAgreement } from "./gray-zone-review"

describe("灰区复审 — 全量人工 + 边界稳定", () => {
  it("灰区全量复审（100%）", () => {
    const r = evaluateGrayZone(50, 5, 0.1)
    expect(r.reviewed).toBe(50)
    expect(r.total).toBe(50)
  })

  it("灰区误判率 ≤ 区间外 1.5× → 边界稳定", () => {
    expect(GRAY_MISJUDGE_RATIO_CAP).toBe(1.5)
    const r = evaluateGrayZone(100, 10, 0.1) // 0.1 vs 0.1 → 1.0×
    expect(r.grayMisjudgeRate).toBe(0.1)
    expect(r.boundaryStable).toBe(true)
  })

  it("灰区误判率超 1.5× → 边界不稳", () => {
    const r = evaluateGrayZone(100, 50, 0.1) // 0.5 vs 0.1 → 5×
    expect(r.boundaryStable).toBe(false)
  })
})

describe("kappaAgreement — 两评审一致性（Cohen's κ）", () => {
  it("空向量（n=0）→ 0（无样本不做一致性推断）", () => {
    expect(kappaAgreement([], [])).toBe(0)
  })

  it("完全一致且全部为真 → pe=1 → 返回 1（不除以 0）", () => {
    expect(kappaAgreement([true, true, true], [true, true, true])).toBe(1)
    expect(kappaAgreement([false, false], [false, false])).toBe(1)
  })

  it("部分一致 → (Po-Pe)/(1-Pe)", () => {
    // Po=0.75（3/4 一致），Pe=(3*2 + 1*2)/16=0.5 → κ=0.5
    expect(kappaAgreement([true, true, true, false], [true, true, false, false])).toBe(0.5)
    // 完全方向相反的平衡样本：Po=0.5, Pe=0.5 → κ=0
    expect(kappaAgreement([true, false, true, false], [true, false, false, true])).toBe(0)
  })

  it("长度不等时按较短向量对齐（不越界、不补零）", () => {
    // 截断到 n=2：两评审同真 → Pe=1 → 1
    expect(kappaAgreement([true, true, true, false], [true, true])).toBe(1)
  })
})
