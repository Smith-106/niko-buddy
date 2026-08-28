/**
 * informed-accept.ts — v2.6.12 W1: 知情接受理由一键（可回溯锚点 + 接受率统计）
 *
 * 蓝图 `docs/p0/blueprint-v2612-20260828.md` W1：
 *   - accept 时展示可核验理由卡（来源/锚点/一致性证据），单点确认
 *   - 理由可回溯（防虚假归因）
 *   - 知情接受率 = 展示理由后 accept / 总 accept（N≥50；分母剔除未展示理由的灰盒事件）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 知情接受理由一键（W1）
// ============================================================================

/** 知情接受率硬门（共识定死）。 */
export const INFORMED_ACCEPT_RATE = 0.9

/** 最小样本（共识定死）。 */
export const INFORMED_ACCEPT_MIN_N = 50

/** 理由卡（可回溯锚点——防虚假归因）。 */
export interface ReasonCard {
  /** 理由条目（来源/锚点/一致性证据）。 */
  reasons: Array<{ source: string; anchor: string; evidence: string }>
  /** 可回溯性（每条理由都有锚点）。 */
  traceable: boolean
}

/**
 * 理由卡生成（纯函数——确定性）。
 * 输入：门控通过项 + 证据锚点；输出：理由卡（可回溯）。
 */
export function buildReasonCard(
  gatePasses: Array<{ gate: string; anchor: string; evidence: string }>,
): ReasonCard {
  const reasons = gatePasses.map((g) => ({ source: g.gate, anchor: g.anchor, evidence: g.evidence }))
  return { reasons, traceable: reasons.every((r) => r.anchor.length > 0) }
}

/**
 * 知情接受率统计（纯函数——确定性）。
 * 输入：展示理由后 accept 数 + 总 accept 数；输出：接受率 + 是否达标（≥90% 硬门）。
 */
export function informedAcceptRate(acceptedWithReason: number, totalAccepts: number): { rate: number; pass: boolean } {
  if (totalAccepts < INFORMED_ACCEPT_MIN_N) return { rate: 0, pass: false } // 样本不足不判
  const rate = acceptedWithReason / totalAccepts
  return { rate, pass: rate >= INFORMED_ACCEPT_RATE }
}
