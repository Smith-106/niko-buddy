/**
 * conformal-gate.ts — v2.6.9 D2: 保角门（split conformal + FDR≤0.05）
 *
 * 蓝图 `docs/p0/blueprint-v269-20260828.md` D2：
 *   - split conformal（校准集固定 split——防 DoD 不可复现）
 *   - 残差式 nonconformity score（检测分 − 同窗人类基线分位——对漂移鲁棒）
 *   - 边际 FDR≤0.05 + BH 校正（marginal 非 per-chapter）
 *   - 最小窗 N≥200 兜底（小窗下 FDR 保证形同虚设）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 保角门（split conformal）
// ============================================================================

/** FDR 预算（锁定——与 Track A 一致）。 */
export const FDR_BUDGET = 0.05

/** 最小窗（N≥200——兜底）。 */
export const CONFORMAL_MIN_WINDOW = 200

/** 校准集 split 版本（固定——防不可复现）。 */
export const CALIBRATION_SPLIT_VERSION = "calib-split-v1-20260828"

/** 校准集 hash（固定 split 的指纹——DoD 断言 4）。 */
export function calibrationSplitHash(calibrationScores: number[]): string {
  let h = 0x811c9dc5
  for (const s of calibrationScores) {
    h ^= Math.round(s * 1000)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * 残差式 nonconformity score（纯函数——确定性）。
 * score = |检测分 − 同窗人类基线分位|（对分布漂移鲁棒——非单调阈值）。
 */
export function nonconformityScore(detectorScore: number, humanBaselineQuantile: number): number {
  return Math.abs(detectorScore - humanBaselineQuantile)
}

/**
 * split conformal 阈值（纯函数——确定性）。
 * 输入：校准集 nonconformity 分（排序后）+ α；输出：1−α 分位阈值。
 */
export function conformalThreshold(calibrationScores: number[], alpha = FDR_BUDGET): number {
  if (calibrationScores.length === 0) return 0
  const sorted = [...calibrationScores].sort((a, b) => a - b)
  const idx = Math.ceil((1 - alpha) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

/**
 * BH 校正（Benjamini-Hochberg——纯函数——确定性）。
 * 输入：p 值数组；输出：拒绝集（FDR≤预算）。
 */
export function benjaminiHochberg(pValues: number[], fdrBudget = FDR_BUDGET): boolean[] {
  const n = pValues.length
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const rejected = new Array<boolean>(n).fill(false)
  let k = 0
  for (let j = 0; j < n; j++) {
    const threshold = ((j + 1) / n) * fdrBudget
    if (order[j].p <= threshold) k = j + 1
  }
  for (let j = 0; j < k; j++) {
    rejected[order[j].i] = true
  }
  return rejected
}

/** 保角门结果。 */
export interface ConformalGateResult {
  /** 是否通过（未超 FDR 预算）。 */
  pass: boolean
  /** 经验 FDR（实测——非 nominal）。 */
  empiricalFdr: number
  /** 是否触发最小窗兜底。 */
  windowFallback: boolean
}

/**
 * 保角门判定（纯函数——确定性）。
 * 输入：校准集 + 测试集（带真值标签）+ 窗大小；输出：经验 FDR 实测。
 * 纪律：FDR 是 marginal 非 per-chapter；窗 <N≥200 触发兜底。
 */
export function evaluateConformalGate(
  calibrationScores: number[],
  testScores: number[],
  testLabels: boolean[], // true = 真 AI（正类）
  windowSize: number,
): ConformalGateResult {
  const windowFallback = windowSize < CONFORMAL_MIN_WINDOW
  const threshold = conformalThreshold(calibrationScores)
  // 经验 FDR = FP / (FP + TP)（实测——非 nominal）
  let fp = 0
  let tp = 0
  for (let i = 0; i < testScores.length; i++) {
    const flagged = testScores[i] > threshold
    if (flagged && !testLabels[i]) fp++
    if (flagged && testLabels[i]) tp++
  }
  const empiricalFdr = fp + tp === 0 ? 0 : fp / (fp + tp)
  return { pass: empiricalFdr <= FDR_BUDGET, empiricalFdr, windowFallback }
}
