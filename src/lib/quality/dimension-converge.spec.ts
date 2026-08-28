/**
 * dimension-converge.spec.ts — v2.7.4 维度收敛验收
 *
 * 覆盖：核心维 ≤3 / Track B 保留 / 中位方差降 ≥15% / 归一化对照
 */
import { describe, expect, it } from "vitest"
import { CORE_DIM_MAX, TRACK_B_DIMS, VARIANCE_REDUCTION, evaluateConvergence, type ChapterScores } from "./dimension-converge"

const ch = (id: string, scores: Record<string, number>): ChapterScores => ({ chapterId: id, scores })

const dims = ["thril", "pacing", "pull", "consistency", "antiAi", "quality"]
const base = (spread: number) => Array.from({ length: 6 }, (_, i) => ch(`b${i}`, Object.fromEntries(dims.map((d, j) => [d, 5 + spread * (i % 3) + (j % 2)]))))
const tight = (spread: number) => Array.from({ length: 6 }, (_, i) => ch(`c${i}`, Object.fromEntries(dims.map((d, j) => [d, 5 + spread * (i % 3) + (j % 2)]))))

describe("维度收敛 — 核心维/方差降/归一化", () => {
  it("方差降 ≥15% 且核心维 ≤3 → 达标", () => {
    const r = evaluateConvergence(base(3), tight(1), "v2.7.3-7006868f")
    expect(r.varianceReduction).toBeGreaterThanOrEqual(VARIANCE_REDUCTION)
    expect(r.normalizedReduction).toBeGreaterThanOrEqual(VARIANCE_REDUCTION)
    expect(r.coreDims.length).toBeLessThanOrEqual(CORE_DIM_MAX)
    expect(r.trackBDims).toBe(TRACK_B_DIMS.length)
    expect(r.passed).toBe(true)
  })

  it("方差未降 → 不达标", () => {
    const r = evaluateConvergence(base(1), tight(3), "v2.7.3-7006868f")
    expect(r.passed).toBe(false)
  })

  it("N<5 → 不达标（样本不足）", () => {
    const r = evaluateConvergence(base(3).slice(0, 3), tight(1).slice(0, 3), "v2.7.3-7006868f")
    expect(r.passed).toBe(false)
  })
})
