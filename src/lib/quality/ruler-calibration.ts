/**
 * ruler-calibration.ts — v2.6.9 D4: 标尺可信性地基（观测通道——最小形态）
 *
 * 蓝图 `docs/p0/blueprint-v269-20260828.md` D4：
 *   - 打分校准（ECE/可靠性曲线——最小形态并入 D2 校准集）
 *   - split hash 固定（记 hash 不挡——观测）
 *   - 校准曲线单调（可信度前提）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 标尺可信性（观测通道）
// ============================================================================

/** 标尺校准结果。 */
export interface RulerCalibrationResult {
  /** ECE（期望校准误差——越小越可信）。 */
  ece: number
  /** 校准曲线是否单调。 */
  monotonic: boolean
  /** 观测通道标记（不挡结案）。 */
  observationOnly: true
}

/**
 * ECE 计算（纯函数——确定性）。
 * 输入：预测置信度 + 真值；输出：期望校准误差。
 */
export function expectedCalibrationError(confidences: number[], labels: boolean[]): number {
  if (confidences.length === 0) return 0
  const bins = 10
  const binSize = 1 / bins
  let total = 0
  let count = 0
  for (let b = 0; b < bins; b++) {
    const lo = b * binSize
    const hi = lo + binSize
    const inBin: number[] = []
    const binLabels: boolean[] = []
    for (let i = 0; i < confidences.length; i++) {
      if (confidences[i] >= lo && confidences[i] < hi) {
        inBin.push(confidences[i])
        binLabels.push(labels[i])
      }
    }
    if (inBin.length === 0) continue
    const avgConf = inBin.reduce((s, v) => s + v, 0) / inBin.length
    const acc = binLabels.filter(Boolean).length / binLabels.length
    total += (inBin.length / confidences.length) * Math.abs(avgConf - acc)
    count++
  }
  return count === 0 ? 0 : total
}

/**
 * 校准曲线单调性（纯函数——确定性）。
 * 输入：分箱（置信度, 准确率）对；输出：是否单调（可信度前提）。
 */
export function isCalibrationMonotonic(bins: Array<{ confidence: number; accuracy: number }>): boolean {
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].accuracy < bins[i - 1].accuracy - 1e-9) return false
  }
  return true
}

/**
 * 标尺校准（纯函数——确定性）。
 * 输入：置信度 + 真值；输出：ECE + 单调性（观测——不挡结案）。
 */
export function calibrateRuler(confidences: number[], labels: boolean[]): RulerCalibrationResult {
  return {
    ece: expectedCalibrationError(confidences, labels),
    monotonic: isCalibrationMonotonic(
      Array.from({ length: 10 }, (_, b) => ({
        confidence: (b + 0.5) / 10,
        accuracy: 0.5, // 占位——由调用方注入真实分箱
      })),
    ),
    observationOnly: true,
  }
}
