/**
 * weekly-cold-review.ts — v2.6.12 测试 W2: 周度冷评（盲评流水线 + 9.0 出关判定）
 *
 * 蓝图 `docs/p0/blueprint-v2612-20260828.md` 测试 W2：
 *   - 盲评流水线（评者非作者——不与改写链路耦合）
 *   - 六维 overall 中位 ≥9.0 出关（N≥5 同协议）
 *   - Consistency(P0) 恒为硬门（冷评不得覆盖其失败）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 周度冷评（测试 W2）
// ============================================================================

/** 冷评出关阈值（共识定死）。 */
export const COLD_REVIEW_EXIT = 9.0

/** 最小样本（共识定死）。 */
export const COLD_REVIEW_MIN_N = 5

/** 冷评结果。 */
export interface ColdReviewResult {
  /** 六维 overall 中位。 */
  median: number
  /** 是否出关（≥9.0 且 N≥5）。 */
  passed: boolean
  /** Consistency(P0) 独立 PASS（冷评不得覆盖其失败）。 */
  consistencyPass: boolean
}

/**
 * 冷评出关判定（纯函数——确定性）。
 * 输入：六维 overall 分序列 + Consistency(P0) 状态；输出：出关判定。
 * 语义：中位 ≥9.0 且 N≥5 且 Consistency(P0) PASS——三者缺一不出关。
 */
export function evaluateColdReview(scores: number[], consistencyPass: boolean): ColdReviewResult {
  if (scores.length < COLD_REVIEW_MIN_N) return { median: 0, passed: false, consistencyPass }
  const sorted = [...scores].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return { median, passed: median >= COLD_REVIEW_EXIT && consistencyPass, consistencyPass }
}
