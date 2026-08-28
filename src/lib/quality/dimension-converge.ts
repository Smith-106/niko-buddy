/**
 * dimension-converge.ts — v2.7.4 维度收敛（聚合层裁剪非删维）
 *
 * 蓝图 `docs/p0/blueprint-v274-20260828.md`：
 *   - 核心维 ≤3（仅聚合/展示层），Track B 六维全量保留
 *   - 门控中位方差降 ≥15%（同协议同章窗 N≥5，跨版本对比）
 *   - 维度数归一化对照（防裁剪伪影）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 常量（共识定死）
// ============================================================================

/** 中位方差降幅硬门。 */
export const VARIANCE_REDUCTION = 0.15
/** 核心维上限。 */
export const CORE_DIM_MAX = 3
/** 同窗最小样本数。 */
export const MIN_SAMPLES = 5

/** Track B 六维（保留清单）。 */
export const TRACK_B_DIMS = ["thril", "pacing", "pull", "consistency", "antiAi", "quality"] as const

// ============================================================================
// 维度收敛
// ============================================================================

/** 单章六维评分。 */
export interface ChapterScores {
  chapterId: string
  scores: Record<string, number>
}

/** 收敛结果。 */
export interface ConvergeResult {
  /** 核心维（≤3）。 */
  coreDims: string[]
  /** Track B 保留维数（必须=6）。 */
  trackBDims: number
  /** 中位方差降幅（vs 基线）。 */
  varianceReduction: number
  /** 维度数归一化降幅（方差/维数，防裁剪伪影）。 */
  normalizedReduction: number
  /** 基线版本（锁定）。 */
  baselineVersion: string
  /** 达标判定。 */
  passed: boolean
}

/** 中位数。 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 每章六维 overall 中位。 */
function chapterMedians(chapters: ChapterScores[]): number[] {
  return chapters.map((c) => median(Object.values(c.scores)))
}

/** 中位方差（同窗 N≥5）。 */
function medianVariance(chapters: ChapterScores[]): number {
  const meds = chapterMedians(chapters)
  const m = median(meds)
  return meds.reduce((acc, v) => acc + (v - m) ** 2, 0) / meds.length
}

/**
 * 维度收敛评估（纯函数——确定性）。
 * 输入：基线章窗 + 当前章窗（同协议同窗 N≥5）；输出：核心维 + 方差降幅。
 * 语义：核心维=贡献方差前 ≤3 维；Track B 六维保留；方差降 ≥15% 且归一化降幅 ≥15%。
 */
export function evaluateConvergence(baseline: ChapterScores[], current: ChapterScores[], baselineVersion = ""): ConvergeResult {
  if (baseline.length < MIN_SAMPLES || current.length < MIN_SAMPLES) {
    return { coreDims: [], trackBDims: TRACK_B_DIMS.length, varianceReduction: 0, normalizedReduction: 0, baselineVersion, passed: false }
  }
  // 核心维=各维跨章方差贡献前 ≤3
  const dims = Object.keys(current[0].scores)
  const dimVariance = dims.map((d) => {
    const vals = current.map((c) => c.scores[d] ?? 0)
    const m = median(vals)
    return { dim: d, v: vals.reduce((acc, x) => acc + (x - m) ** 2, 0) / vals.length }
  })
  const coreDims = dimVariance.sort((a, b) => b.v - a.v).slice(0, CORE_DIM_MAX).map((x) => x.dim)
  const baseVar = medianVariance(baseline)
  const curVar = medianVariance(current)
  const varianceReduction = baseVar === 0 ? 0 : (baseVar - curVar) / baseVar
  // 维度数归一化对照（方差/维数）
  const baseNorm = baseVar / dims.length
  const curNorm = curVar / coreDims.length
  const normalizedReduction = baseNorm === 0 ? 0 : (baseNorm - curNorm) / baseNorm
  return {
    coreDims,
    trackBDims: TRACK_B_DIMS.length,
    varianceReduction,
    normalizedReduction,
    baselineVersion,
    passed: varianceReduction >= VARIANCE_REDUCTION && normalizedReduction >= VARIANCE_REDUCTION && coreDims.length <= CORE_DIM_MAX && baselineVersion.length > 0,
  }
}
