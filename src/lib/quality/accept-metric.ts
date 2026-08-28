/**
 * accept-metric.ts — v2.7.3 编辑真实 accept 率（双标注 + P0 一票否决）
 *
 * 蓝图 `docs/p0/blueprint-v273-20260828.md`：
 *   - accept=编辑真实 accept 率（人工双标注+仲裁，处级）≥80%
 *   - P0 失败一票否决（不计入 accept 统计）；系统提交率仅过程监控
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 编辑真实 accept 率
// ============================================================================

/** accept 率硬门（共识定死）。 */
export const ACCEPT_RATE = 0.8

/** 标注样本。 */
export interface AcceptSample {
  id: string
  /** 标注者 A 判定。 */
  annotatorA: boolean
  /** 标注者 B 判定。 */
  annotatorB: boolean
  /** 仲裁判定（双标注不一致时）。 */
  arbitrated: boolean
  /** P0 门控是否失败（一票否决）。 */
  p0Failed: boolean
}

/** accept 结果。 */
export interface AcceptResult {
  /** 编辑真实 accept 率（P0 失败样本剔除）。 */
  acceptRate: number
  /** P0 失败样本数（一票否决不计入）。 */
  p0Excluded: number
  /** 达标判定（≥80%）。 */
  passed: boolean
}

/**
 * accept 率评估（纯函数——确定性）。
 * 输入：标注样本；输出：编辑真实 accept 率。
 * 语义：accept=仲裁通过；P0 失败一票否决（剔除不计入分母）。
 */
export function evaluateAccept(samples: AcceptSample[]): AcceptResult {
  const usable = samples.filter((s) => !s.p0Failed)
  const accepted = usable.filter((s) => s.arbitrated).length
  const acceptRate = usable.length === 0 ? 0 : accepted / usable.length
  const p0Excluded = samples.filter((s) => s.p0Failed).length
  return { acceptRate, p0Excluded, passed: acceptRate >= ACCEPT_RATE }
}
