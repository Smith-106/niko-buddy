/**
 * style-factors.spec.ts — v2.7.3 风格因子验收
 *
 * 覆盖：4 维因子判定 / 一致率计算
 */
import { describe, expect, it } from "vitest"
import { dimMatches, factorAgreement } from "./style-factors"

const base = { sentenceLength: 20, punctuationDensity: 30, qualifierFrequency: 10, povDrift: 0 }

describe("风格因子 — 4 维判定", () => {
  it("容差内 → 各维匹配", () => {
    expect(dimMatches("sentenceLength", 22, base.sentenceLength)).toBe(true) // +10% ≤15%
    expect(dimMatches("punctuationDensity", 35, base.punctuationDensity)).toBe(true) // +16.7% ≤20%
    expect(dimMatches("qualifierFrequency", 8, base.qualifierFrequency)).toBe(true)
    expect(dimMatches("povDrift", 0, base.povDrift)).toBe(true)
  })

  it("超容差 → 不匹配", () => {
    expect(dimMatches("sentenceLength", 30, base.sentenceLength)).toBe(false) // +50%
    expect(dimMatches("povDrift", 1, base.povDrift)).toBe(false) // POV 漂移=0 硬约束
  })

  it("4 维一致率计算", () => {
    const actual = { sentenceLength: 22, punctuationDensity: 35, qualifierFrequency: 8, povDrift: 0 }
    expect(factorAgreement(actual, base)).toBe(1)
    const drift = { ...actual, povDrift: 2 }
    expect(factorAgreement(drift, base)).toBe(0.75)
  })
})
