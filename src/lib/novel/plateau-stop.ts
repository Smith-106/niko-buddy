/**
 * 51 号报告 G6: plateau 停止准则（autonovel PLATEAU_DELTA 式收敛即停）.
 *
 * 语义: 返修循环中若相邻 N 轮 slop 分 delta < epsilon（平台期），继续返修只会噪声
 * 波动 → 提前接受当前稿（不置 manualReviewRequired）。与 MAX_GATE_RETRY 硬上限共存
 * （plateau window=2 < MAX_GATE_RETRY=3，只可能在其前触发）；与 detectRegression
 * 职责正交（regression 防退化回退前版，plateau 防无效空转早停）。
 *
 * 纯函数、零 LLM、零 IO（守 ADR-19/29）。epsilon=0 时退化为纯 retry 上限（字节级等价旧行为）。
 */

export interface PlateauConfig {
  /** 滑窗轮数（相邻差比较窗口）。 */
  window: number
  /** 相邻差绝对值阈值：max < epsilon → plateau。 */
  epsilon: number
}

export const DEFAULT_PLATEAU_CONFIG: PlateauConfig = { window: 2, epsilon: 0.5 }

export interface PlateauResult {
  plateau: boolean
  /** 末 window 个值相邻差绝对值最大值。 */
  delta: number
  window: number
}

/**
 * 纯函数判定：history 末 window 个值相邻差绝对值 max < epsilon → plateau=true。
 * history 长度 < window+1 → 不触发（防早停）。
 * epsilon=0 → 永不触发（显式退化为纯 retry 上限，兼容旧行为）。
 */
export function detectPlateau(history: readonly number[], config?: PlateauConfig): PlateauResult {
  const { window, epsilon } = config ?? DEFAULT_PLATEAU_CONFIG
  if (epsilon <= 0) return { plateau: false, delta: 0, window }
  if (history.length < window + 1) return { plateau: false, delta: 0, window }
  const tail = history.slice(-window - 1)
  let maxDelta = 0
  for (let i = 1; i < tail.length; i += 1) {
    const d = Math.abs(tail[i] - tail[i - 1])
    if (d > maxDelta) maxDelta = d
  }
  return { plateau: maxDelta < epsilon, delta: maxDelta, window }
}

/**
 * 滑窗记账器：每轮 push 返修后 slop 分，evaluate 判定是否平台期。
 * 与 prevCandidate 同源但独立记账（不干扰退化检测滑动窗口）。
 */
export class SlopHistoryTracker {
  private history: number[] = []

  push(slop: number): void {
    this.history.push(slop)
  }

  evaluate(config?: PlateauConfig): PlateauResult {
    return detectPlateau(this.history, config)
  }

  get size(): number {
    return this.history.length
  }
}
