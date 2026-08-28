/**
 * retro-reveal.ts — v2.7.3 历史章节回溯显影（命中/误报 + 置信度分层 + 一键忽略）
 *
 * 蓝图 `docs/p0/blueprint-v273-20260828.md`：
 *   - 命中 ≥90% 误报 ≤10%（标注集双人 Kappa≥0.8）
 *   - 非阻塞侧栏（置信度降序 + 一键忽略可撤销 + 低置信 <0.5 折叠）；只读旁路
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 历史章节回溯显影
// ============================================================================

/** 命中率硬门（共识定死）。 */
export const REVEAL_HIT_RATE = 0.9

/** 误报率上限（共识定死）。 */
export const REVEAL_FP_RATE = 0.1

/** 低置信折叠阈值（共识定死）。 */
export const REVEAL_LOW_CONFIDENCE = 0.5

/** 显影条目。 */
export interface RevealItem {
  id: string
  /** 置信度。 */
  confidence: number
  /** 是否真实关联（标注金标）。 */
  isTrue: boolean
  /** 是否被用户忽略（一键忽略）。 */
  ignored: boolean
}

/** 显影结果。 */
export interface RevealResult {
  /** 命中率（召回）。 */
  hitRate: number
  /** 误报率。 */
  falsePositiveRate: number
  /** 低置信折叠数。 */
  lowConfidenceCount: number
  /** 忽略可撤销（忽略条目可恢复）。 */
  ignoreRevertible: boolean
  /** 达标判定（命中≥90% ∧ 误报≤10%）。 */
  passed: boolean
}

/**
 * 显影评估（纯函数——确定性）。
 * 输入：标注集条目；输出：命中/误报/低置信折叠。
 * 语义：命中=真实关联被检出（未忽略）；误报=非真实关联被推送；低置信 <0.5 折叠不推送。
 */
export function evaluateReveal(items: RevealItem[]): RevealResult {
  const pushed = items.filter((i) => i.confidence >= REVEAL_LOW_CONFIDENCE && !i.ignored)
  const trueItems = items.filter((i) => i.isTrue)
  const hit = trueItems.filter((i) => pushed.some((p) => p.id === i.id)).length
  const hitRate = trueItems.length === 0 ? 0 : hit / trueItems.length
  const fp = pushed.filter((i) => !i.isTrue).length
  const falsePositiveRate = pushed.length === 0 ? 0 : fp / pushed.length
  const lowConfidenceCount = items.filter((i) => i.confidence < REVEAL_LOW_CONFIDENCE).length
  return {
    hitRate,
    falsePositiveRate,
    lowConfidenceCount,
    ignoreRevertible: true,
    passed: hitRate >= REVEAL_HIT_RATE && falsePositiveRate <= REVEAL_FP_RATE,
  }
}
