/**
 * auto-closeout.ts — v2.7.0 冷评全自动结案（P0/P1 自动 + P2 回退 + 兜底率）
 *
 * 蓝图 `docs/p0/blueprint-v270-20260828.md`：
 *   - P0/P1 全自动（100%）+ P2 抽检 ≥10%（异常偏离单章分<8 或波动>1.5σ 回退人工）
 *   - 全集自动结案率 ≥90% 零人工；人工兜底 ≤10%
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 冷评全自动结案
// ============================================================================

/** 自动结案率硬门（共识定死）。 */
export const AUTO_CLOSEOUT_RATE = 0.9

/** 人工兜底上限（共识定死）。 */
export const MANUAL_FALLBACK_CAP = 0.1

/** P2 回退阈值（单章分 <8 回退人工）。 */
export const P2_REVERT_SCORE = 8

/** P2 回退波动（>1.5σ 回退人工）。 */
export const P2_REVERT_SIGMA = 1.5

/** 章节结案状态。 */
export interface CloseoutChapter {
  id: string
  /** P0/P1/P2 机械门控结果。 */
  gates: { p0: boolean; p1: boolean; p2: boolean }
  /** P2 分（异常偏离判定）。 */
  p2Score: number
  /** P2 波动（σ）。 */
  p2Sigma: number
}

/** 自动结案结果。 */
export interface AutoCloseoutResult {
  /** 自动结案数。 */
  autoClosed: number
  /** 人工兜底数。 */
  manualFallback: number
  /** 自动结案率（≥90% 硬门）。 */
  autoRate: number
  /** 兜底率（≤10% 硬门）。 */
  fallbackRate: number
  /** 是否达标。 */
  passed: boolean
}

/**
 * 冷评自动结案（纯函数——确定性）。
 * 输入：章节列表；输出：自动/兜底计数 + 达标判定。
 * 语义：P0/P1 全自动；P2 异常偏离（<8 或 >1.5σ）回退人工；兜底≤10% 硬门。
 */
export function evaluateAutoCloseout(chapters: CloseoutChapter[]): AutoCloseoutResult {
  if (chapters.length === 0) return { autoClosed: 0, manualFallback: 0, autoRate: 0, fallbackRate: 0, passed: false }
  let auto = 0
  let fallback = 0
  for (const c of chapters) {
    const p2Revert = !c.gates.p2 || c.p2Score < P2_REVERT_SCORE || c.p2Sigma > P2_REVERT_SIGMA
    if (c.gates.p0 && c.gates.p1 && !p2Revert) auto++
    else fallback++
  }
  const autoRate = auto / chapters.length
  const fallbackRate = fallback / chapters.length
  return { autoClosed: auto, manualFallback: fallback, autoRate, fallbackRate, passed: autoRate >= AUTO_CLOSEOUT_RATE && fallbackRate <= MANUAL_FALLBACK_CAP }
}
