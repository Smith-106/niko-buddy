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

/** 灰区人工复核的 Kappa 达标线（与 T01b 黄金集 κ≥0.7 对齐，Landis-Koch substantial）。 */
export const GRAY_KAPPA_QUALIFIED = 0.7

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

/**
 * 两评审二元判定向量的 Cohen's κ 一致性（纯函数——确定性）。
 * 输入：评审 A 与评审 B 对同批样本的 accept/reject 向量；输出：κ ∈ [-1,1]。
 * 语义：κ = (Po - Pe) / (1 - Pe)；完美一致 = 1；κ ≥ 0.7 substantial。
 * 注：数学与 novel 域 corpus-kappa.ts 同族（Cohen 1960），quality 域内联实现避免跨域反向依赖。
 */
export function kappaAgreement(raterA: boolean[], raterB: boolean[]): number {
  const n = Math.min(raterA.length, raterB.length)
  if (n === 0) return 0
  // 混淆矩阵：n11=同真 n00=同假 n10/n01=分歧
  let n11 = 0
  let n00 = 0
  let aTrue = 0
  let bTrue = 0
  for (let i = 0; i < n; i++) {
    if (raterA[i]) aTrue++
    if (raterB[i]) bTrue++
    if (raterA[i] && raterB[i]) n11++
    else if (!raterA[i] && !raterB[i]) n00++
  }
  const po = (n11 + n00) / n
  const pe = (aTrue * bTrue + (n - aTrue) * (n - bTrue)) / (n * n)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}
