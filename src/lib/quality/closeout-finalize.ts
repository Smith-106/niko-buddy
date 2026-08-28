/**
 * closeout-finalize.ts — v2.7.2 冷评收口（误结案 <2% 独立复核 + L9 排除）
 *
 * 蓝图 `docs/p0/blueprint-v272-20260828.md`：
 *   - 仅 Track A 机械门控维度（L9 文学分永不自动收口）
 *   - 误结案率 <2%（独立复核分层抽样 N≥200，95%CI 单侧上界 <2%）
 *   - 人工二次确认闸口 + 低置信强制转人工
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 冷评收口
// ============================================================================

/** 误结案率上限（共识定死）。 */
export const MISCLOSEOUT_RATE = 0.02

/** 最小独立复核样本（共识定死）。 */
export const AUDIT_MIN_N = 200

/** 复核样本。 */
export interface AuditSample {
  id: string
  /** 自动结案判定。 */
  autoClosed: boolean
  /** 独立复核金标（人工）。 */
  gold: boolean
  /** 是否 L9 文学分维度（永不自动收口）。 */
  isLiterary: boolean
}

/** 收口结果。 */
export interface CloseoutFinalResult {
  /** 误结案率（独立复核口径）。 */
  miscloseoutRate: number
  /** 95%CI 单侧上界（Wilson 近似）。 */
  ciUpper: number
  /** L9 文学分自动收口数（必须=0）。 */
  literaryAutoClosed: number
  /** 达标判定（<2% ∧ CI 上界 <2% ∧ 无 L9 收口）。 */
  passed: boolean
}

/**
 * 冷评收口评估（纯函数——确定性）。
 * 输入：独立复核样本（N≥200 分层抽样）；输出：误结案率 + CI 上界。
 * 语义：误结案=自动结案但金标拒绝；L9 文学分永不自动收口。
 */
export function evaluateCloseoutFinal(samples: AuditSample[]): CloseoutFinalResult {
  const usable = samples.filter((s) => !s.isLiterary)
  const n = usable.length
  const mis = usable.filter((s) => s.autoClosed && !s.gold).length
  const literaryAutoClosed = samples.filter((s) => s.isLiterary && s.autoClosed).length
  const rate = n === 0 ? 0 : mis / n
  // Wilson 95% CI 单侧上界（近似——零 LLM）
  const z = 1.645
  const denom = 1 + z * z / n
  const center = (rate + z * z / (2 * n)) / denom
  const margin = (z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n))) / denom
  const ciUpper = n === 0 ? 1 : center + margin
  return {
    miscloseoutRate: rate,
    ciUpper,
    literaryAutoClosed,
    passed: n >= AUDIT_MIN_N && rate < MISCLOSEOUT_RATE && ciUpper < MISCLOSEOUT_RATE && literaryAutoClosed === 0,
  }
}
