/**
 * gray-zone-review.spec.ts — v2.7.1 灰区复审验收
 *
 * 覆盖：全量人工复审 / 边界稳定性（误判率 ≤1.5×）
 */
import { describe, expect, it } from "vitest"
import { GRAY_MISJUDGE_RATIO_CAP, evaluateGrayZone } from "./gray-zone-review"

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
