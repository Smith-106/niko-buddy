/**
 * independent-reproduce.ts — v2.6.13 双门: 独立复现（跨种子硬门 ≥9.0）
 *
 * 蓝图 `docs/p0/blueprint-v2613-20260828.md` 双门：
 *   - 独立复现 = 跨种子硬门：≥3 独立种子各轮中位 ≥9.0
 *   - 换模型 ≥9.0 作泛化补证（下波转硬）
 *   - 隔离模型实例（防上下文泄漏虚高分）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 独立复现
// ============================================================================

/** 复现阈值（共识定死）。 */
export const REPRODUCE_SCORE = 9.0

/** 最小种子数（共识定死）。 */
export const REPRODUCE_MIN_SEEDS = 3

/** 复现结果。 */
export interface ReproduceResult {
  /** 各种子中位分。 */
  seedMedians: number[]
  /** 是否硬门通过（≥3 seed 各 ≥9.0）。 */
  hardPass: boolean
  /** 换模型泛化补证（非硬门）。 */
  crossModelMedian: number | null
}

/**
 * 跨种子独立复现（纯函数——确定性）。
 * 输入：各种子评分序列 + 换模型复现中位（可空）；输出：硬门判定 + 泛化补证。
 * 语义：≥3 seed 各轮中位 ≥9.0 为硬门；换模型仅记录不作阻断。
 */
export function evaluateIndependentReproduce(
  seedScores: number[][],
  crossModelMedian: number | null,
): ReproduceResult {
  const seedMedians = seedScores.map((scores) => {
    const sorted = [...scores].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  })
  const hardPass = seedScores.length >= REPRODUCE_MIN_SEEDS && seedMedians.every((m) => m >= REPRODUCE_SCORE)
  return { seedMedians, hardPass, crossModelMedian }
}
