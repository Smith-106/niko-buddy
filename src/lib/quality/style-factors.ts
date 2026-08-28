/**
 * style-factors.ts — v2.7.3 风格因子提取（句长/标点/限定词频/视角）
 *
 * 蓝图 `docs/p0/blueprint-v273-20260828.md`：
 *   - 一致率口径=可量化风格因子 4 维（句长分布/标点密度/限定词频/视角一致）
 *   - 不评文学质量（避免覆盖 P0 一致性）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 风格因子
// ============================================================================

/** 4 维风格因子。 */
export interface StyleFactors {
  /** 句长分布（中位句长）。 */
  sentenceLength: number
  /** 标点密度（每千字标点数）。 */
  punctuationDensity: number
  /** 限定词频（每千字限定词数）。 */
  qualifierFrequency: number
  /** 视角一致（POV 漂移次数——0 为一致）。 */
  povDrift: number
}

/** 因子维度名。 */
export type StyleDim = "sentenceLength" | "punctuationDensity" | "qualifierFrequency" | "povDrift"

/** 因子容差（共识定案：句长 ±15%，标点/限定词 ±20%，POV 漂移=0）。 */
export const STYLE_TOLERANCE: Record<StyleDim, number> = {
  sentenceLength: 0.15,
  punctuationDensity: 0.2,
  qualifierFrequency: 0.2,
  povDrift: 0,
}

/** 单维判定。 */
export function dimMatches(dim: StyleDim, actual: number, baseline: number): boolean {
  if (dim === "povDrift") return actual === 0
  const tol = STYLE_TOLERANCE[dim]
  return Math.abs(actual - baseline) / Math.max(1, baseline) <= tol
}

/** 4 维一致率（达标维数/4）。 */
export function factorAgreement(actual: StyleFactors, baseline: StyleFactors): number {
  const dims: StyleDim[] = ["sentenceLength", "punctuationDensity", "qualifierFrequency", "povDrift"]
  const passed = dims.filter((d) => dimMatches(d, actual[d], baseline[d])).length
  return passed / dims.length
}
