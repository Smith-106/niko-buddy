/**
 * variance-regression.ts — v2.7.4 负向集召回双门（不掩检测退化）
 *
 * 蓝图 `docs/p0/blueprint-v274-20260828.md`：
 *   - 方差降达标但负向集召回跌破基线−2% 即 FAIL（收敛不得掩盖检测退化）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 常量（共识定死）
// ============================================================================

/** 负向集召回下限（相对基线）。 */
export const NEGATIVE_RECALL_FLOOR = 0.02

// ============================================================================
// 负向召回双门
// ============================================================================

/** 负向集召回结果。 */
export interface RecallResult {
  /** 基线召回率。 */
  baselineRecall: number
  /** 当前召回率。 */
  currentRecall: number
  /** 召回回退量（基线−当前）。 */
  regression: number
  /** 基线版本（锁定）。 */
  baselineVersion: string
  /** 双门判定（回退 ≤2%）。 */
  passed: boolean
}

/**
 * 负向集召回双门（纯函数——确定性）。
 * 输入：基线/当前负向集命中数+总数；输出：回退量 + 判定。
 * 语义：currentRecall ≥ baselineRecall − 2% 才通过（与方差降互锁）。
 */
export function evaluateRecallRegression(baselineHits: number, baselineTotal: number, currentHits: number, currentTotal: number, baselineVersion = ""): RecallResult {
  const baselineRecall = baselineTotal === 0 ? 0 : baselineHits / baselineTotal
  const currentRecall = currentTotal === 0 ? 0 : currentHits / currentTotal
  const regression = baselineRecall - currentRecall
  return { baselineRecall, currentRecall, regression, baselineVersion, passed: regression <= NEGATIVE_RECALL_FLOOR && baselineVersion.length > 0 }
}
