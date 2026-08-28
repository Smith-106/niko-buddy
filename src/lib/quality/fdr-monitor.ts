/**
 * fdr-monitor.ts — v2.6.11 D2: FDR 持续监控（观测——EWMA 控制图）
 *
 * 蓝图 `docs/p0/blueprint-v2611-20260828.md` D2：
 *   - EWMA 控制图（滚动窗口 FDR 监控）
 *   - 观测通道（非硬门——与 D4 重叠计数防重复）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// FDR 监控（EWMA 控制图——观测）
// ============================================================================

/** FDR 预算（与 Track A 一致）。 */
export const FDR_BUDGET = 0.05

/** EWMA 平滑系数。 */
export const EWMA_LAMBDA = 0.3

/** 监控结果。 */
export interface FdrMonitorResult {
  /** EWMA 平滑 FDR。 */
  ewmaFdr: number
  /** 是否超限告警。 */
  alert: boolean
  /** 观测通道标记（非硬门）。 */
  observationOnly: true
}

/**
 * EWMA FDR 监控（纯函数——确定性）。
 * 输入：逐批 FDR 序列；输出：EWMA 平滑值 + 告警。
 */
export function monitorFdr(batchFdrs: number[]): FdrMonitorResult {
  if (batchFdrs.length === 0) return { ewmaFdr: 0, alert: false, observationOnly: true }
  let ewma = batchFdrs[0]
  for (let i = 1; i < batchFdrs.length; i++) {
    ewma = EWMA_LAMBDA * batchFdrs[i] + (1 - EWMA_LAMBDA) * ewma
  }
  return { ewmaFdr: ewma, alert: ewma > FDR_BUDGET, observationOnly: true }
}
