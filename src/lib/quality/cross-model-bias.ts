/**
 * cross-model-bias.ts — v2.7.4 跨模型泛化（同文同窗 pairwise Δ中位）
 *
 * 蓝图 `docs/p0/blueprint-v274-20260828.md`：
 *   - 跨模型偏差 ≤0.5（同文同窗 pairwise Δ中位，N≥5）
 *   - 分维度报告（无单维 >0.7）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 常量（共识定死）
// ============================================================================

/** 跨模型偏差硬门。 */
export const CROSS_MODEL_BIAS = 0.5
/** 单维偏差上限。 */
export const CROSS_MODEL_DIM_CAP = 0.7
/** 同窗最小样本数。 */
export const MIN_SAMPLES = 5

// ============================================================================
// 跨模型偏差
// ============================================================================

/** 单模型评分。 */
export interface ModelScores {
  modelId: string
  scores: Record<string, number>
}

/** 跨模型偏差结果。 */
export interface CrossModelResult {
  /** pairwise Δ中位。 */
  medianDelta: number
  /** 单维最大偏差。 */
  maxDimDelta: number
  /** 样本数。 */
  sampleCount: number
  /** 达标判定（中位 ≤0.5 且单维 ≤0.7）。 */
  passed: boolean
}

/** 中位数。 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 跨模型偏差评估（纯函数——确定性）。
 * 输入：同文同窗多模型评分（N≥5）；输出：pairwise Δ中位 + 单维上限。
 * 语义：所有模型两两组合逐维绝对差，取中位；单维最大偏差 ≤0.7。
 */
export function evaluateCrossModel(models: ModelScores[]): CrossModelResult {
  if (models.length < 2 || models.length < MIN_SAMPLES) {
    return { medianDelta: 0, maxDimDelta: 0, sampleCount: models.length, passed: false }
  }
  const deltas: number[] = []
  const dimDeltas: Record<string, number[]> = {}
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i].scores
      const b = models[j].scores
      for (const dim of Object.keys(a)) {
        const d = Math.abs((a[dim] ?? 0) - (b[dim] ?? 0))
        deltas.push(d)
        ;(dimDeltas[dim] ??= []).push(d)
      }
    }
  }
  const maxDimDelta = Math.max(0, ...Object.values(dimDeltas).flat())
  return {
    medianDelta: median(deltas),
    maxDimDelta,
    sampleCount: models.length,
    passed: median(deltas) <= CROSS_MODEL_BIAS && maxDimDelta <= CROSS_MODEL_DIM_CAP,
  }
}
