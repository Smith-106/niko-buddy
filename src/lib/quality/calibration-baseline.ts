/**
 * calibration-baseline.ts — v2.6.8 D1: 编辑校准基线（六维分维分布 + rubric 冻结）
 *
 * 蓝图 `docs/p0/blueprint-v268-20260828.md` D1：
 *   - 六维分维分布（mean/std/min，N≥5 盲评）
 *   - rubric 版本冻结（后续评分强制引用该版本号）
 *   - 确定性（同输入同输出——纯函数禁隐式依赖）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 六维（Track L9 评分维度）
// ============================================================================

/** 六维评分维度。 */
export const SIX_DIMENSIONS = ["thril", "pacing", "pull", "context", "consistency", "anti_ai"] as const

export type Dimension = (typeof SIX_DIMENSIONS)[number]

/** 单章六维评分。 */
export interface ChapterScores {
  chapterId: string
  scores: Record<Dimension, number>
}

/** 分维分布统计。 */
export interface DimensionStats {
  mean: number
  std: number
  min: number
  /** 分位（P15-P20 选地板用）。 */
  p15: number
  p20: number
  p50: number
}

/** 校准基线（rubric 冻结快照）。 */
export interface CalibrationBaseline {
  /** rubric 版本号（冻结——后续评分强制引用）。 */
  rubricVersion: string
  /** 样本数（N≥5）。 */
  sampleCount: number
  /** 六维分维分布。 */
  dimensions: Record<Dimension, DimensionStats>
  /** 整体中位。 */
  overallMedian: number
}

/** 当前 rubric 版本（冻结）。 */
export const RUBRIC_VERSION = "rubric-v1-20260828"

// ============================================================================
// 分维统计（纯函数——确定性）
// ============================================================================

/** 分位计算（线性插值——纯函数）。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** 标准差（纯函数）。 */
export function stddev(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * 计算单维分布统计（纯函数——确定性）。
 * 输入：该维所有样本分（N≥5 由调用方保证）。
 */
export function computeDimensionStats(values: number[]): DimensionStats {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    std: stddev(values),
    min: sorted[0] ?? 0,
    p15: percentile(sorted, 15),
    p20: percentile(sorted, 20),
    p50: percentile(sorted, 50),
  }
}

/**
 * 构建校准基线（纯函数——确定性）。
 * 输入：N 章六维评分（N≥5 校验），输出冻结基线。
 */
export function buildCalibrationBaseline(chapters: ChapterScores[], rubricVersion = RUBRIC_VERSION): CalibrationBaseline {
  if (chapters.length < 5) {
    throw new Error(`校准基线样本不足: N=${chapters.length}（要求 N≥5）`)
  }
  const dimensions = {} as Record<Dimension, DimensionStats>
  for (const dim of SIX_DIMENSIONS) {
    dimensions[dim] = computeDimensionStats(chapters.map((c) => c.scores[dim]))
  }
  const overalls = chapters.map((c) => {
    const vals = SIX_DIMENSIONS.map((d) => c.scores[d])
    const sorted = [...vals].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  })
  return {
    rubricVersion,
    sampleCount: chapters.length,
    dimensions,
    overallMedian: percentile([...overalls].sort((a, b) => a - b), 50),
  }
}

/**
 * 确定性校验：同输入同输出（纯函数——禁隐式依赖）。
 * 输入：同一批章节两次构建，输出是否一致。
 */
export function verifyDeterminism(a: CalibrationBaseline, b: CalibrationBaseline): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
