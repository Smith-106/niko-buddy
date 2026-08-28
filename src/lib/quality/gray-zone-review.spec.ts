/**
 * gray-zone-review.spec.ts — v2.6.11 D6 验收（观测）
 *
 * 覆盖：进/出阈值 / pending 复核条目 / Kappa
 */
import { describe, expect, it } from "vitest"
import { GRAY_ENTER, GRAY_EXIT, KAPPA_THRESHOLD, evaluateGrayZone, kappaAgreement } from "./gray-zone-review"

describe("D6 灰区复核 — 进/出阈值（0.45/0.55）", () => {
  it("0.45≤分<0.55 → 灰区 + pending 复核条目", () => {
    const r = evaluateGrayZone(0.5)
    expect(r.inGrayZone).toBe(true)
    expect(r.reviewEntry).toEqual({ status: "pending", source: "drift" })
    expect(r.blocksWriting).toBe(true) // 强制闭环：阻断继续写作
  })

  it("分<0.45 → 非灰区", () => {
    expect(evaluateGrayZone(0.4).inGrayZone).toBe(false)
  })

  it("分≥0.55 → 非灰区（出阈值）", () => {
    expect(evaluateGrayZone(0.55).inGrayZone).toBe(false)
  })

  it("阈值冻结", () => {
    expect(GRAY_ENTER).toBe(0.45)
    expect(GRAY_EXIT).toBe(0.55)
  })
})

describe("D6 灰区复核 — Kappa 一致性（≥0.7）", () => {
  it("高一致通过", () => {
    expect(kappaAgreement([true, true, false], [true, true, false])).toBe(1)
    expect(KAPPA_THRESHOLD).toBe(0.7)
  })

  it("低一致不达标（升第三人仲裁）", () => {
    expect(kappaAgreement([true, true, true], [false, false, false])).toBe(0)
  })
})
