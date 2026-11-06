/**
 * cross-model-bias.spec.ts — v2.7.4 跨模型泛化验收
 *
 * 覆盖：pairwise Δ中位 ≤0.5 / 单维 ≤0.7 / N≥5
 */
import { describe, expect, it } from "vitest"
import { CROSS_MODEL_BIAS, CROSS_MODEL_DIM_CAP, evaluateCrossModel, type ModelScores } from "./cross-model-bias"

const m = (id: string, scores: Record<string, number>): ModelScores => ({ modelId: id, scores })

describe("跨模型偏差 — 同文同窗 pairwise Δ中位", () => {
  it("偏差 ≤0.5 且单维 ≤0.7 → 达标", () => {
    const models = [
      m("a", { thril: 8, pacing: 7, pull: 8 }),
      m("b", { thril: 8.3, pacing: 7.2, pull: 8.1 }),
      m("c", { thril: 7.8, pacing: 7.1, pull: 8.2 }),
      m("d", { thril: 8.1, pacing: 6.9, pull: 7.9 }),
      m("e", { thril: 8.2, pacing: 7.0, pull: 8.0 }),
    ]
    const r = evaluateCrossModel(models)
    expect(r.medianDelta).toBeLessThanOrEqual(CROSS_MODEL_BIAS)
    expect(r.maxDimDelta).toBeLessThanOrEqual(CROSS_MODEL_DIM_CAP)
    expect(r.passed).toBe(true)
  })

  it("单维偏差超 0.7 → 不达标", () => {
    const models = [
      m("a", { thril: 8, pacing: 7, pull: 8 }),
      m("b", { thril: 8, pacing: 7, pull: 8 }),
      m("c", { thril: 8, pacing: 7, pull: 8 }),
      m("d", { thril: 8, pacing: 7, pull: 8 }),
      m("e", { thril: 8, pacing: 7, pull: 5 }), // pull 偏差 3
    ]
    const r = evaluateCrossModel(models)
    expect(r.maxDimDelta).toBeGreaterThan(CROSS_MODEL_DIM_CAP)
    expect(r.passed).toBe(false)
  })

  it("N<5 → 不达标", () => {
    const r = evaluateCrossModel([m("a", { thril: 8 }), m("b", { thril: 8 })])
    expect(r.passed).toBe(false)
  })

  it("样本数达标但全维度缺分（Δ 序列为空）→ 中位按 0 处理而非 NaN", () => {
    // 5 个模型都只带空 scores：pairwise 循环里 Object.keys(a) 为空 → 一条 Δ 也不产生。
    // 中位数取空序列时必须落到显式的 0（否则 NaN 会让「中位 ≤0.5」静默变成 false
    // 而误判不达标，或反之被下游当作达标）。
    const r = evaluateCrossModel([
      m("a", {}),
      m("b", {}),
      m("c", {}),
      m("d", {}),
      m("e", {}),
    ])
    expect(r.sampleCount).toBe(5)
    expect(r.medianDelta).toBe(0)
    expect(r.maxDimDelta).toBe(0)
    expect(r.passed).toBe(true)
  })
})
