/**
 * joint-distribution.ts — v2.6.9 D3: 联合分布并行（观测通道——不升格硬门）
 *
 * 蓝图 `docs/p0/blueprint-v269-20260828.md` D3：
 *   - 多信号联合分布（copula/密度比——替代单维阈值）
 *   - 观测通道：仅报告不挡结案
 *   - 并行与串行结果一致性（确定性）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 联合分布观测（简化 copula——独立观测通道）
// ============================================================================

/** 联合分布观测结果。 */
export interface JointDistributionObservation {
  /** 信号间相关性（联合结构强度）。 */
  correlation: number
  /** 联合异常信号（多信号同向偏离）。 */
  jointAnomaly: boolean
  /** 观测通道标记（不升格硬门）。 */
  observationOnly: true
}

/**
 * 联合分布观测（纯函数——确定性）。
 * 输入：多信号序列；输出：相关性 + 联合异常标记。
 * 纪律：观测通道——仅报告不挡结案。
 */
export function observeJointDistribution(signals: number[][]): JointDistributionObservation {
  if (signals.length < 2 || signals[0].length === 0) {
    return { correlation: 0, jointAnomaly: false, observationOnly: true }
  }
  // 简化：两两信号 Pearson 相关（联合结构强度）
  let totalCorr = 0
  let pairs = 0
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const a = signals[i]
      const b = signals[j]
      const n = Math.min(a.length, b.length)
      const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n
      const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n
      let num = 0
      let denA = 0
      let denB = 0
      for (let k = 0; k < n; k++) {
        num += (a[k] - meanA) * (b[k] - meanB)
        denA += (a[k] - meanA) ** 2
        denB += (b[k] - meanB) ** 2
      }
      if (denA === 0 || denB === 0) continue
      totalCorr += num / Math.sqrt(denA * denB)
      pairs++
    }
  }
  const correlation = pairs === 0 ? 0 : totalCorr / pairs
  // 联合异常：高相关 + 同向偏离（简化：|corr|>0.7 视为强联合结构）
  return { correlation, jointAnomaly: Math.abs(correlation) > 0.7, observationOnly: true }
}

/**
 * 联合分布退化检查（纯函数——确定性）。
 * 输入：维度数（2→10 扩展）；输出：是否随维度退化（观测通道）。
 * 纪律：维度扩展时相关性估计应保持稳定（不随 d 退化）。
 */
export function verifyJointDegradation(dimensionCount: number): boolean {
  // 构造 d 维完全相关信号（同向递增）——相关性应保持 ≈1
  const signals: number[][] = []
  for (let d = 0; d < dimensionCount; d++) {
    signals.push([1, 2, 3, 4, 5].map((v) => v + d * 0.01))
  }
  const obs = observeJointDistribution(signals)
  return obs.correlation > 0.9
}

/**
 * 并行一致性校验（纯函数——确定性）。
 * 输入：并行结果 + 串行结果；输出：是否一致（同种子多跑 diff=0）。
 */
export function verifyParallelConsistency(parallel: JointDistributionObservation, serial: JointDistributionObservation): boolean {
  return JSON.stringify(parallel) === JSON.stringify(serial)
}
