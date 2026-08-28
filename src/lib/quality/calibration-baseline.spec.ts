/**
 * calibration-baseline.spec.ts — v2.6.8 D1 验收
 *
 * 覆盖：六维分维分布 / rubric 冻结 / 确定性 / N≥5 校验
 */
import { describe, expect, it } from "vitest"
import {
  RUBRIC_VERSION,
  SIX_DIMENSIONS,
  buildCalibrationBaseline,
  computeDimensionStats,
  percentile,
  verifyDeterminism,
  type ChapterScores,
} from "./calibration-baseline"

const mkChapter = (id: string, base: number): ChapterScores => ({
  chapterId: id,
  scores: {
    thril: base,
    pacing: base + 0.5,
    pull: base + 1,
    context: base + 0.5,
    consistency: base + 1.5,
    anti_ai: base + 1,
  },
})

const fiveChapters = [mkChapter("c1", 8.0), mkChapter("c2", 8.2), mkChapter("c3", 8.4), mkChapter("c4", 8.6), mkChapter("c5", 8.8)]

describe("D1 校准基线 — 分维统计", () => {
  it("分位计算（线性插值）", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentile([1, 2, 3], 0)).toBe(1)
    expect(percentile([], 50)).toBe(0)
  })

  it("标准差计算", () => {
    expect(computeDimensionStats([1, 1, 1]).std).toBe(0)
    expect(computeDimensionStats([1, 3]).std).toBe(1)
  })

  it("六维齐全", () => {
    expect(SIX_DIMENSIONS).toEqual(["thril", "pacing", "pull", "context", "consistency", "anti_ai"])
  })
})

describe("D1 校准基线 — 构建 + 冻结", () => {
  it("N≥5 构建成功（rubric 版本冻结）", () => {
    const b = buildCalibrationBaseline(fiveChapters)
    expect(b.rubricVersion).toBe(RUBRIC_VERSION)
    expect(b.sampleCount).toBe(5)
    expect(b.dimensions.consistency.mean).toBeGreaterThan(9)
  })

  it("N<5 拒绝（样本不足）", () => {
    expect(() => buildCalibrationBaseline(fiveChapters.slice(0, 4))).toThrow("样本不足")
  })

  it("确定性：同输入同输出", () => {
    const a = buildCalibrationBaseline(fiveChapters)
    const b = buildCalibrationBaseline(fiveChapters)
    expect(verifyDeterminism(a, b)).toBe(true)
  })
})
