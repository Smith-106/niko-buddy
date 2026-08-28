/**
 * foreshadow-feedback.ts — v2.6.10 D3: 伏笔回灌（观测——dry-run 试点）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D3：
 *   - 回收时回灌上下文（只带锚点摘要禁灌旧全文——守 Draft-first）
 *   - dry-run 试点（不污染正式正文——观测通道）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 回灌（观测——dry-run）
// ============================================================================

/** 回灌内容（只带锚点摘要——禁灌旧全文）。 */
export interface FeedbackPayload {
  /** 伏笔 key。 */
  key: string
  /** 锚点摘要（≤200 字——防挤占窗口）。 */
  anchorSummary: string
  /** 埋设位置。 */
  plantedAt: { chapter: number; sentence: number }
}

/** 锚点摘要最大长度（冻结——防旧上下文挤占窗口）。 */
export const ANCHOR_SUMMARY_MAX = 200

/** 回灌结果。 */
export interface FeedbackResult {
  /** 是否 dry-run（观测——不写正式正文）。 */
  dryRun: true
  /** 摘要是否合规（≤200 字）。 */
  valid: boolean
}

/**
 * 回灌 payload 构建（纯函数——确定性）。
 * 只带锚点摘要（≤200 字）——禁灌旧全文。
 */
export function buildFeedbackPayload(
  key: string,
  anchorSummary: string,
  plantedAt: { chapter: number; sentence: number },
): FeedbackResult {
  // key/plantedAt 由调用方用于构造 payload（观测通道——此处仅校验摘要合规）
  void key
  void plantedAt
  return {
    dryRun: true,
    valid: anchorSummary.length <= ANCHOR_SUMMARY_MAX,
  }
}

/**
 * 回灌合规校验（纯函数——确定性）。
 * 输入：payload；输出：是否合规（dry-run + 摘要限长——守 Draft-first）。
 */
export function validateFeedback(payload: FeedbackPayload): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (payload.anchorSummary.length > ANCHOR_SUMMARY_MAX) {
    reasons.push(`锚点摘要超限 ${ANCHOR_SUMMARY_MAX} 字（禁灌旧全文）`)
  }
  return { ok: reasons.length === 0, reasons }
}
