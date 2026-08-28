/**
 * dual-gate-certify.ts — v2.6.13 双门认证（四项 AND + 分章口径）
 *
 * 蓝图 `docs/p0/blueprint-v2613-20260828.md` 双门：
 *   - 四项 AND：中位≥9.5 ∧ σ<0.3（分章）∧ Δ<0.15（分章）∧ 独立复现≥9.0
 *   - 分章口径：σ=各章中位标准差；Δ=章级中位对基线差；任一章不过即整书不过
 *   - 机械硬门（Track A）：Consistency(P0) 不可被文学分覆盖
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 双门认证
// ============================================================================

/** 中位阈值（共识定死）。 */
export const CERTIFY_MEDIAN = 9.5

/** σ 阈值（共识定死）。 */
export const CERTIFY_SIGMA = 0.3

/** Δ 阈值（共识定死）。 */
export const CERTIFY_DELTA = 0.15

/** 最小章评测样本（共识定死）。 */
export const CERTIFY_MIN_N_PER_CHAPTER = 5

/** 分章认证结果。 */
export interface ChapterGateResult {
  chapter: number
  median: number
  sigma: number
  delta: number
  pass: boolean
}

/**
 * 分章双门认证（纯函数——确定性）。
 * 输入：每章评分 + 基线中位；输出：逐章结果 + 整书判定。
 * 语义：σ=章内中位标准差；Δ=章级中位对基线差；任一章不过即整书不过（AND）。
 */
export function certifyDualGate(
  chapters: Array<{ chapter: number; scores: number[]; baselineMedian: number }>,
): { chapters: ChapterGateResult[]; certified: boolean } {
  const results = chapters.map((c) => {
    if (c.scores.length < CERTIFY_MIN_N_PER_CHAPTER) {
      return { chapter: c.chapter, median: 0, sigma: 1, delta: 1, pass: false }
    }
    const sorted = [...c.scores].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    const sigma = Math.sqrt(c.scores.reduce((a, s) => a + (s - median) ** 2, 0) / c.scores.length)
    const delta = Math.abs(median - c.baselineMedian)
    return { chapter: c.chapter, median, sigma, delta, pass: median >= CERTIFY_MEDIAN && sigma < CERTIFY_SIGMA && delta < CERTIFY_DELTA }
  })
  return { chapters: results, certified: results.every((r) => r.pass) }
}
