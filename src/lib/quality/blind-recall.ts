/**
 * blind-recall.ts — v2.6.10 D1: 盲测一句话复述（≥95% 命中率）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D1：
 *   - 盲测：模型不看原文盲述关键事实（检测代理）
 *   - 命中率 ≥95%（口径冻结：「命中」= 要点召回率≥70% 记命中）
 *   - 距离衰减曲线（跨 5/10/30 章——验证不是只记住最近 N 章）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 盲测复述（口径冻结）
// ============================================================================

/** 命中率阈值（冻结——≥95%）。 */
export const RECALL_HIT_RATE = 0.95

/** 单条命中判定：要点召回率≥70% 记命中（口径冻结）。 */
export const RECALL_POINT_THRESHOLD = 0.7

/** 盲测样本最小数（N≥50——统计可复算）。 */
export const BLIND_SAMPLE_MIN_N = 50

/** 盲测结果。 */
export interface BlindRecallResult {
  /** 命中率（实测）。 */
  hitRate: number
  /** 是否达标（≥95%）。 */
  pass: boolean
  /** 距离衰减（跨章距离 → 命中率——验证长程记忆）。 */
  distanceDecay: Array<{ distance: number; hitRate: number }>
}

/**
 * 单条复述命中判定（纯函数——确定性）。
 * 输入：复述要点命中数 + 标注要点总数；输出：是否命中（召回率≥70%）。
 */
export function isRecallHit(hitPoints: number, totalPoints: number): boolean {
  if (totalPoints === 0) return false
  return hitPoints / totalPoints >= RECALL_POINT_THRESHOLD
}

/**
 * 盲测命中率计算（纯函数——确定性）。
 * 输入：每条样本的（命中要点数, 总要点数）；输出：命中率 + 达标判定。
 */
export function computeRecallHitRate(samples: Array<{ hit: number; total: number }>): { hitRate: number; pass: boolean } {
  if (samples.length === 0) return { hitRate: 0, pass: false }
  const hits = samples.filter((s) => isRecallHit(s.hit, s.total)).length
  const hitRate = hits / samples.length
  return { hitRate, pass: hitRate >= RECALL_HIT_RATE }
}

/**
 * 距离衰减曲线（纯函数——确定性）。
 * 输入：跨章距离 → 样本（命中/总数）；输出：每距离命中率。
 * 验证：长程记忆（不是只记住最近 N 章）。
 */
export function computeDistanceDecay(
  byDistance: Array<{ distance: number; samples: Array<{ hit: number; total: number }> }>,
): Array<{ distance: number; hitRate: number }> {
  return byDistance.map((d) => {
    const { hitRate } = computeRecallHitRate(d.samples)
    return { distance: d.distance, hitRate }
  })
}
