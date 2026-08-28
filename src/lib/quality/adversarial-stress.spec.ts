/**
 * adversarial-stress.spec.ts — v2.6.13 W4 验收
 *
 * 覆盖：三路压测 / 通过率显著下降 / 零交集约束
 */
import { describe, expect, it } from "vitest"
import { ATTACK_DROP_RATE, ATTACK_MIN_N, evaluateStress } from "./adversarial-stress"

describe("W4 对抗压测 — 通过率显著下降", () => {
  it("降幅≥30% 且绝对≥5pp → 显著下降", () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      id: `a${i}`,
      attack: "rewrite" as const,
      overlapsValidation: false,
      passed: i < 15, // 通过率 50%（基线 90%——降幅 44%）
    }))
    const r = evaluateStress(samples, 0.9)
    expect(r.passRate).toBe(0.5)
    expect(r.drop).toBeCloseTo(0.444)
    expect(r.significant).toBe(true)
  })

  it("样本不足（N<30）不判", () => {
    const samples = Array.from({ length: 5 }, () => ({
      id: "a",
      attack: "rewrite" as const,
      overlapsValidation: false,
      passed: false,
    }))
    expect(evaluateStress(samples, 0.9).valid).toBe(false)
    expect(ATTACK_MIN_N).toBe(30)
  })

  it("与验收集交集 → 无效（防泄漏）", () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      id: `a${i}`,
      attack: "rewrite" as const,
      overlapsValidation: i === 0, // 1 个交集
      passed: false,
    }))
    expect(evaluateStress(samples, 0.9).valid).toBe(false)
  })

  it("阈值冻结", () => {
    expect(ATTACK_DROP_RATE).toBe(0.3)
  })
})
