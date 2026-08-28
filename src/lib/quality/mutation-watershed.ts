/**
 * mutation-watershed.ts — v2.6.12 测试 W3: 变异分水岭（影子分支 kill score）
 *
 * 蓝图 `docs/p0/blueprint-v2612-20260828.md` 测试 W3：
 *   - 影子分支内容变异（语义余弦 <0.85 记有效变异）
 *   - kill score ≥80% 硬门（风格变异仅辅助观测不计门）
 *   - 主链零污染（影子分支独立跑）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 变异分水岭（测试 W3）
// ============================================================================

/** 变异分硬门（共识定死）。 */
export const MUTATION_SCORE = 0.8

/** 有效变异语义阈值（共识定死——余弦 <0.85 记有效变异）。 */
export const MUTATION_SIMILARITY = 0.85

/** 变异体结果。 */
export interface MutantResult {
  /** 变异体 id。 */
  id: string
  /** 与基线语义余弦相似度。 */
  similarity: number
  /** 是否被测试杀灭（kill）。 */
  killed: boolean
}

/**
 * 变异分计算（纯函数——确定性）。
 * 输入：变异体列表；输出：kill score + 是否达标（≥80% 硬门）。
 * 语义：有效变异（相似度 <0.85）中被杀灭占比；风格变异仅记录不计门。
 */
export function mutationKillScore(mutants: MutantResult[]): { score: number; pass: boolean } {
  const effective = mutants.filter((m) => m.similarity < MUTATION_SIMILARITY)
  if (effective.length === 0) return { score: 0, pass: false }
  const killed = effective.filter((m) => m.killed).length
  const score = killed / effective.length
  return { score, pass: score >= MUTATION_SCORE }
}
