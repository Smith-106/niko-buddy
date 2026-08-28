/**
 * gray-zone-review.ts — v2.7.1 灰区 [0.4,0.7] 全量人工复审路由
 *
 * 蓝图 `docs/p0/blueprint-v271-20260828.md`：
 *   - 灰区置信 [0.4,0.7] 全量人工复审（不只抽样）
 *   - 灰区误判率 ≤ 区间外误判率 1.5×（否则判定边界不稳）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 灰区人工复审
// ============================================================================

/** 灰区误判率对区间外的最大倍数（共识定死）。 */
export const GRAY_MISJUDGE_RATIO_CAP = 1.5

/** 灰区复审结果。 */
export interface GrayZoneReviewResult {
  /** 灰区样本总数。 */
  total: number
  /** 全量进入人工复审数（=total——100%）。 */
  reviewed: number
  /** 灰区误判率。 */
  grayMisjudgeRate: number
  /** 区间外误判率。 */
  outsideMisjudgeRate: number
  /** 边界稳定判定（灰区误判率 ≤ 区间外 1.5×）。 */
  boundaryStable: boolean
}

/**
 * 灰区复审（纯函数——确定性）。
 * 输入：灰区样本（全部人工复审）+ 区间外样本误判；输出：边界稳定性判定。
 * 语义：灰区 [0.4,0.7] 全量人工复审；误判率比值 ≤1.5× 边界稳定。
 */
export function evaluateGrayZone(
  grayTotal: number,
  grayMisjudged: number,
  outsideMisjudgeRate: number,
): GrayZoneReviewResult {
  const reviewed = grayTotal // 全量人工复审（100%）
  const grayMisjudgeRate = grayTotal === 0 ? 0 : grayMisjudged / grayTotal
  const ratio = outsideMisjudgeRate === 0 ? (grayMisjudgeRate > 0 ? Infinity : 0) : grayMisjudgeRate / outsideMisjudgeRate
  return {
    total: grayTotal,
    reviewed,
    grayMisjudgeRate,
    outsideMisjudgeRate,
    boundaryStable: ratio <= GRAY_MISJUDGE_RATIO_CAP,
  }
}
