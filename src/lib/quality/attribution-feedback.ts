/**
 * attribution-feedback.ts — v2.6.10 D7: 归因反哺（观测——评审归因回写）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D7：
 *   - 评审归因回写（可追溯至具体编辑与评审编号）
 *   - 观测闭环（不挡结案）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 归因反哺（观测）
// ============================================================================

/** 归因记录。 */
export interface AttributionRecord {
  /** 评审编号。 */
  reviewId: string
  /** 编辑 ID。 */
  editorId: string
  /** 归因类型（结构/声口/连续性）。 */
  attributionType: string
  /** 归因摘要。 */
  summary: string
}

/** 归因反哺结果。 */
export interface AttributionFeedbackResult {
  /** 回写率（已回写/应回写——100% 目标）。 */
  writebackRate: number
  /** 观测通道标记（不挡结案）。 */
  observationOnly: true
}

/**
 * 归因回写率（纯函数——确定性）。
 * 输入：应回写记录 + 已回写记录；输出：回写率。
 */
export function writebackRate(expected: AttributionRecord[], written: AttributionRecord[]): number {
  if (expected.length === 0) return 1
  const writtenKeys = new Set(written.map((w) => `${w.reviewId}:${w.editorId}`))
  const covered = expected.filter((e) => writtenKeys.has(`${e.reviewId}:${e.editorId}`)).length
  return covered / expected.length
}

/**
 * 归因反哺（纯函数——确定性）。
 * 输入：应回写 + 已回写；输出：回写率 + 观测标记。
 */
export function evaluateAttributionFeedback(
  expected: AttributionRecord[],
  written: AttributionRecord[],
): AttributionFeedbackResult {
  return { writebackRate: writebackRate(expected, written), observationOnly: true }
}
