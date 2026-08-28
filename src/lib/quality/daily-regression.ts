/**
 * daily-regression.ts — v2.7.1 在线持续回归（金标快照 + 0 回退门禁）
 *
 * 蓝图 `docs/p0/blueprint-v271-20260828.md`：
 *   - 日级 CI 门禁；金标=已 accept 稿件；连续 ≥3 日 0 回退
 *   - 回退定义=检出<90% 或误报>5% 任一触发即阻断
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 在线持续回归
// ============================================================================

/** 0 回退连续天数硬门（共识定死）。 */
export const REGRESSION_MIN_DAYS = 3

/** 检出下限（与 d3-probe 一致）。 */
export const REGRESSION_DETECT_LOWER = 0.9

/** 误报上限（与 d3-probe 一致）。 */
export const REGRESSION_FP_UPPER = 0.05

/** 单日回归结果。 */
export interface DailyRegression {
  day: number
  detectRate: number
  falsePositiveRate: number
  /** 是否回退（检出<90% 或误报>5%）。 */
  regressed: boolean
}

/** 回归门禁结果。 */
export interface RegressionResult {
  /** 连续 0 回退天数。 */
  cleanDays: number
  /** 0 回退判定（≥3 日）。 */
  zeroRegression: boolean
  /** 是否阻断（任一日回退即阻断）。 */
  blocked: boolean
}

/**
 * 日级回归门禁（纯函数——确定性）。
 * 输入：近 N 日回归序列；输出：连续 0 回退天数 + 阻断判定。
 * 语义：回退=检出<90% 或误报>5% 任一触发；连续 ≥3 日 0 回退达标。
 */
export function evaluateRegression(days: DailyRegression[]): RegressionResult {
  let cleanDays = 0
  let blocked = false
  for (const d of days) {
    const regressed = d.regressed || d.detectRate < REGRESSION_DETECT_LOWER || d.falsePositiveRate > REGRESSION_FP_UPPER
    if (regressed) {
      cleanDays = 0
      blocked = true // 窗口性 0 回退：任一日回退即阻断（重新达标需新窗口）
    } else {
      cleanDays++
    }
  }
  return { cleanDays, zeroRegression: cleanDays >= REGRESSION_MIN_DAYS && !blocked, blocked }
}
