/**
 * variance-gate.spec.ts — v2.6.9 D5 验收
 *
 * 覆盖：σ 冻结分维动态 / 只判不稳不判无效 / N≥5 / 缺元数据回退
 */
import { describe, expect, it } from "vitest"
import { FALLBACK_SIGMA, evaluateVarianceGate, verifySigmaFrozen } from "./variance-gate"

describe("D5 方差门 — σ 冻结分维动态", () => {
  it("σ 阈值表冻结（软维放宽/硬维收紧）", () => {
    expect(verifySigmaFrozen()).toBe(true)
  })

  it("软维高方差不判不稳（有意高方差维放宽）", () => {
    // thril 有意高方差（σ≈1.5 < 2.2 放宽阈值）
    const r = evaluateVarianceGate({
      dimensionScores: { thril: [7, 8, 9, 10, 8, 9, 7, 8, 10, 9] },
      hasMetadata: true,
    })
    expect(r.unstable).not.toContain("thril")
  })

  it("硬维高方差判不稳（consistency 收紧）", () => {
    const r = evaluateVarianceGate({
      dimensionScores: { consistency: [7, 8, 9, 10, 8, 9, 7, 8, 10, 9] },
      hasMetadata: true,
    })
    expect(r.unstable).toContain("consistency")
  })
})

describe("D5 方差门 — 只判不稳不判无效（真实低分须穿过门）", () => {
  it("永不否决（vetoed 恒 false）", () => {
    const r = evaluateVarianceGate({
      dimensionScores: { consistency: [7, 8, 9, 10, 8, 9, 7, 8, 10, 9] },
      hasMetadata: true,
    })
    expect(r.vetoed).toBe(false)
    expect(r.unstable).toContain("consistency")
  })
})

describe("D5 方差门 — N≥5 + 缺元数据回退", () => {
  it("N<5 不计入（防小样本伪稳）", () => {
    const r = evaluateVarianceGate({
      dimensionScores: { consistency: [7, 8, 9] },
      hasMetadata: true,
    })
    expect(r.skipped).toContain("consistency")
  })

  it("缺元数据回退最宽松（防激进默认误报）", () => {
    const r = evaluateVarianceGate({
      dimensionScores: { consistency: [7, 8, 9, 10, 8, 9, 7, 8, 10, 9] },
      hasMetadata: false,
    })
    expect(r.unstable).not.toContain("consistency") // 回退 FALLBACK_SIGMA=2.2
    expect(FALLBACK_SIGMA).toBe(2.2)
  })
})
