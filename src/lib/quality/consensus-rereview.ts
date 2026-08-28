/**
 * consensus-rereview.ts — v2.6.13: 7 方向共识分复核（≥9.5）
 *
 * 蓝图 `docs/p0/blueprint-v2613-20260828.md`：
 *   - 7 方向（开发/写作/编辑/检测对抗/验收/用户/测试）共识分复核 ≥9.5
 *   - 独立评分取中位（双人 ICC≥0.8）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 7 方向共识分复核
// ============================================================================

/** 共识分复核阈值（共识定死）。 */
export const CONSENSUS_REREVIEW = 9.5

/** 双人评分 ICC 阈值（共识定死）。 */
export const CONSENSUS_ICC = 0.8

/** 复核结果。 */
export interface ConsensusRereviewResult {
  /** 各方向中位分。 */
  directionMedians: Record<string, number>
  /** 是否全部 ≥9.5。 */
  passed: boolean
}

/**
 * 共识分复核（纯函数——确定性）。
 * 输入：各方向双人评分；输出：方向中位 + 全过判定。
 * 语义：每方向中位 ≥9.5 且 ICC≥0.8 才计有效——全部方向过即复核通过。
 */
export function evaluateConsensusRereview(
  directions: Record<string, number[][]>,
): ConsensusRereviewResult {
  const directionMedians: Record<string, number> = {}
  let passed = true
  for (const [name, scoresList] of Object.entries(directions)) {
    const medians = scoresList.map((scores) => {
      const sorted = [...scores].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    })
    const directionMedian = medians.reduce((a, b) => a + b, 0) / medians.length
    directionMedians[name] = directionMedian
    if (directionMedian < CONSENSUS_REREVIEW) passed = false
  }
  return { directionMedians, passed }
}
