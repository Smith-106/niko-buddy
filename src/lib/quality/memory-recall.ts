/**
 * memory-recall.ts — v2.6.12 W2: 记忆固化主动召回（accept 口径 + 成功率统计）
 *
 * 蓝图 `docs/p0/blueprint-v2612-20260828.md` W2：
 *   - 草稿 accept 后主动召回相关固化记忆（非打断式侧边提醒）
 *   - 召回→被 accept 为硬口径（防刷量：展示不计数，reject 计负分）
 *   - 主动召回成功率 = 召回→被 accept / 召回总数（N≥30）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 记忆固化主动召回（W2）
// ============================================================================

/** 主动召回成功率硬门（共识定死）。 */
export const RECALL_SUCCESS_RATE = 0.7

/** 最小样本（共识定死）。 */
export const RECALL_MIN_N = 30

/** 召回条目（非打断式侧边提醒）。 */
export interface RecallItem {
  /** 记忆条目 id。 */
  id: string
  /** 相关性置信度。 */
  confidence: number
  /** 召回状态（accept/reject/pending——展示不计数）。 */
  status: "accepted" | "rejected" | "pending"
}

/**
 * 主动召回成功率统计（纯函数——确定性）。
 * 输入：召回条目列表；输出：成功率 + 是否达标（≥70% 硬门）。
 * 语义：分子=召回→被 accept；分母=召回总数（展示不计数，reject 计负分）。
 */
export function recallSuccessRate(items: RecallItem[]): { rate: number; pass: boolean } {
  if (items.length < RECALL_MIN_N) return { rate: 0, pass: false } // 样本不足不判
  const accepted = items.filter((i) => i.status === "accepted").length
  const rate = accepted / items.length
  return { rate, pass: rate >= RECALL_SUCCESS_RATE }
}

/**
 * 召回过滤（纯函数——确定性）。
 * 输入：候选记忆 + 置信度阈值；输出：可召回条目（低置信度不打扰）。
 */
export function filterRecallCandidates(
  candidates: Array<{ id: string; confidence: number }>,
  threshold: number,
): RecallItem[] {
  return candidates
    .filter((c) => c.confidence >= threshold)
    .map((c) => ({ id: c.id, confidence: c.confidence, status: "pending" as const }))
}
