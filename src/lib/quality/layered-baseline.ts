/**
 * layered-baseline.ts — v2.6.9 D1: 分层人类基线（N≥200/层 + 漂移阈值锁定）
 *
 * 蓝图 `docs/p0/blueprint-v269-20260828.md` D1：
 *   - AI 风格真人子群 N≥200/层（不可退化为合并）
 *   - 基线漂移阈值锁定（漂移超阈即 fail）
 *   - 新增门控不回溯重判既有章节
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 分层基线（AI 风格真人子群）
// ============================================================================

/** 分层维度（风格特征分层——困惑度/突发度/句长分布）。 */
export const BASELINE_LAYERS = ["perplexity", "burstiness", "sentence_length"] as const

export type BaselineLayer = (typeof BASELINE_LAYERS)[number]

/** 每层最小样本数（N≥200——不可退化为合并）。 */
export const LAYER_MIN_N = 200

/** 漂移阈值（锁定——超阈即 fail）。 */
export const DRIFT_THRESHOLD = 0.05

/** 分层基线（AI 风格真人子群分布）。 */
export interface LayeredBaseline {
  /** 层 → 样本分分布（排序后）。 */
  layers: Record<BaselineLayer, number[]>
  /** 层 → 分位（P50 锚点）。 */
  anchors: Record<BaselineLayer, number>
}

/**
 * 构建分层基线（纯函数——确定性）。
 * 输入：每层样本分（N≥200/层校验——不足拒绝），输出基线。
 */
export function buildLayeredBaseline(
  samples: Record<BaselineLayer, number[]>,
): LayeredBaseline {
  for (const layer of BASELINE_LAYERS) {
    if (samples[layer].length < LAYER_MIN_N) {
      throw new Error(`分层样本不足: ${layer} N=${samples[layer].length}（要求 N≥${LAYER_MIN_N}/层——不可退化为合并）`)
    }
  }
  const anchors = {} as Record<BaselineLayer, number>
  for (const layer of BASELINE_LAYERS) {
    const sorted = [...samples[layer]].sort((a, b) => a - b)
    anchors[layer] = sorted[Math.floor(sorted.length / 2)]
  }
  return { layers: samples, anchors }
}

/**
 * 漂移探针（纯函数——确定性）。
 * 输入：基线 + 当前层分布；输出：漂移量（超阈即 fail）。
 * 漂移 = 当前 P50 与锚点 P50 的相对偏差。
 */
export function probeBaselineDrift(
  baseline: LayeredBaseline,
  current: Record<BaselineLayer, number[]>,
): { drifted: boolean; driftByLayer: Record<BaselineLayer, number> } {
  const driftByLayer = {} as Record<BaselineLayer, number>
  let maxDrift = 0
  for (const layer of BASELINE_LAYERS) {
    const sorted = [...current[layer]].sort((a, b) => a - b)
    const p50 = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
    const anchor = baseline.anchors[layer]
    const drift = anchor === 0 ? 0 : Math.abs(p50 - anchor) / anchor
    driftByLayer[layer] = drift
    maxDrift = Math.max(maxDrift, drift)
  }
  return { drifted: maxDrift > DRIFT_THRESHOLD, driftByLayer }
}

/**
 * 不回溯重判校验（纯函数——确定性）。
 * 输入：已 commit 章节 ID 集 + 待判章节 ID；输出：是否重判既有章节。
 */
export function verifyNoRetroactive(committedChapterIds: string[], pendingChapterId: string): boolean {
  return !committedChapterIds.includes(pendingChapterId)
}
