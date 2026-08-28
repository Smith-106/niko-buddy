/**
 * full-window-drift-gate.ts — v2.6.11 D5: 全文窗漂移门（滑窗序列——整章重检）
 *
 * 蓝图 `docs/p0/blueprint-v2611-20260828.md` D5：
 *   - 滑窗检测分序列（章/节滑窗）
 *   - 窗间漂移超阈 → 整章重检
 *   - AUC≥0.9 且 L9 门槛零误杀（不达标降级辅助信号）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 全文窗漂移门（滑窗）
// ============================================================================

/** 窗间漂移阈值（冻结——超阈整章重检）。 */
export const WINDOW_DRIFT_THRESHOLD = 0.15

/** 滑窗大小（章数）。 */
export const WINDOW_SIZE = 3

/** 漂移门结果。 */
export interface FullWindowDriftResult {
  /** 漂移窗位置（超阈的窗）。 */
  driftedWindows: Array<{ start: number; drift: number }>
  /** 需整章重检的章。 */
  chaptersToRecheck: number[]
  /** 是否触发重检。 */
  triggered: boolean
}

/**
 * 全文窗漂移门（纯函数——确定性）。
 * 输入：每章检测分序列；输出：漂移窗 + 需重检章。
 * 语义：滑窗均值序列——窗间漂移超阈 → 整章重检。
 */
export function evaluateFullWindowDrift(scores: number[]): FullWindowDriftResult {
  const driftedWindows: Array<{ start: number; drift: number }> = []
  const chaptersToRecheck: number[] = []
  if (scores.length < WINDOW_SIZE) return { driftedWindows, chaptersToRecheck, triggered: false }

  const windowMeans: number[] = []
  for (let i = 0; i + WINDOW_SIZE <= scores.length; i++) {
    const win = scores.slice(i, i + WINDOW_SIZE)
    windowMeans.push(win.reduce((a, b) => a + b, 0) / WINDOW_SIZE)
  }
  for (let i = 1; i < windowMeans.length; i++) {
    const drift = Math.abs(windowMeans[i] - windowMeans[i - 1])
    if (drift > WINDOW_DRIFT_THRESHOLD) {
      driftedWindows.push({ start: i, drift })
      // 整章重检：漂移窗覆盖的章
      for (let c = i; c < i + WINDOW_SIZE; c++) {
        if (!chaptersToRecheck.includes(c)) chaptersToRecheck.push(c)
      }
    }
  }
  return { driftedWindows, chaptersToRecheck, triggered: chaptersToRecheck.length > 0 }
}

/**
 * 零误杀校验（纯函数——确定性）。
 * 输入：合法手法样本（闪回/POV 切换/时间跳跃/梦境）+ 漂移门结果；输出：是否零误杀。
 */
export function verifyZeroFalseKill(legalSamples: number[][], gate: (s: number[]) => FullWindowDriftResult): boolean {
  for (const sample of legalSamples) {
    if (gate(sample).triggered) return false
  }
  return true
}
