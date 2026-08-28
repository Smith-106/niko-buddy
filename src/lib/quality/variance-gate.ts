/**
 * variance-gate.ts — v2.6.9 D5: 单维方差门（σ 冻结分维动态 + 只判不稳不判无效）
 *
 * 蓝图 `docs/p0/blueprint-v269-20260828.md` D5：
 *   - σ 冻结（分维动态阈值：软维放宽 1.8-2.2；硬维收紧 0.8-1.0）
 *   - 只判「不稳」不判「无效」（真实低分章节须穿过门）
 *   - N≥5 才计入（防小样本伪稳/伪不稳）
 *   - 缺元数据章节回退「最宽松」
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// σ 阈值表（冻结——分维动态）
// ============================================================================

/** σ 阈值表（维度 → 上限——软维放宽防拍平有意高方差）。 */
export const SIGMA_THRESHOLDS = {
  thril: 2.2, // 软维——有意高方差（放宽）
  pacing: 2.0,
  pull: 2.2,
  context: 1.5,
  consistency: 1.0, // 硬维——收紧
  anti_ai: 0.8, // 硬维——最紧
} as const

/** 最小计入样本数（N≥5——防小样本伪稳/伪不稳）。 */
export const VARIANCE_MIN_N = 5

/** 缺元数据回退（最宽松——防激进默认误报）。 */
export const FALLBACK_SIGMA = 2.2

// ============================================================================
// 方差门判定（纯函数）
// ============================================================================

/** 方差门输入。 */
export interface VarianceGateInput {
  /** 维度 → 该维跨章评分序列。 */
  dimensionScores: Record<string, number[]>
  /** 是否有元数据（缺元数据回退最宽松）。 */
  hasMetadata: boolean
}

/** 方差门结果。 */
export interface VarianceGateResult {
  /** 不稳维度（σ 越界——仅标记不否决）。 */
  unstable: string[]
  /** 是否否决（方差门永不否决——只判不稳不判无效）。 */
  vetoed: false
  /** 未计入维度（N<5）。 */
  skipped: string[]
}

/**
 * 单维方差门（纯函数——确定性）。
 * 语义：σ 越界 → 标「不稳」（评估信号）；永不否决（真实低分须穿过门）。
 */
export function evaluateVarianceGate(input: VarianceGateInput): VarianceGateResult {
  const unstable: string[] = []
  const skipped: string[] = []
  for (const [dim, scores] of Object.entries(input.dimensionScores)) {
    if (scores.length < VARIANCE_MIN_N) {
      skipped.push(dim)
      continue
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length
    const sigma = Math.sqrt(variance)
    const threshold = input.hasMetadata ? (SIGMA_THRESHOLDS as Record<string, number>)[dim] ?? FALLBACK_SIGMA : FALLBACK_SIGMA
    if (sigma > threshold) unstable.push(dim)
  }
  return { unstable, vetoed: false, skipped }
}

/** σ 冻结校验（纯函数——阈值表不可变）。 */
export function verifySigmaFrozen(): boolean {
  return (
    SIGMA_THRESHOLDS.consistency === 1.0 &&
    SIGMA_THRESHOLDS.anti_ai === 0.8 &&
    SIGMA_THRESHOLDS.thril === 2.2 &&
    SIGMA_THRESHOLDS.pacing === 2.0 &&
    SIGMA_THRESHOLDS.pull === 2.2
  )
}
