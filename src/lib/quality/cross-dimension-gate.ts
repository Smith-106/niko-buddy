/**
 * cross-dimension-gate.ts — v2.6.11 D4: 跨维交叉门（矛盾矩阵——多信号一致才判 AI）
 *
 * 蓝图 `docs/p0/blueprint-v2611-20260828.md` D4：
 *   - 各维独立打分后查矛盾矩阵（规则表——零 LLM）
 *   - 多信号一致才判 AI；单维命中降级灰区（不杀）
 *   - 捕获率≥95%（跨维矛盾：单维 PASS 但跨维矛盾）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 跨维矛盾矩阵（规则表）
// ============================================================================

/** 矛盾规则（维度对 → 矛盾条件）。 */
export interface ContradictionRule {
  /** 维度 A。 */
  dimA: string
  /** 维度 B。 */
  dimB: string
  /** 矛盾判定（纯函数——输入两维分）。 */
  contradicts: (a: number, b: number) => boolean
}

/** 默认矛盾矩阵（规则表——thril 高但 pacing 低等）。 */
export const DEFAULT_CONTRADICTION_RULES: ContradictionRule[] = [
  {
    dimA: "thril",
    dimB: "pacing",
    contradicts: (a, b) => a >= 8.5 && b <= 6.5, // 高张力但节奏拖沓
  },
  {
    dimA: "consistency",
    dimB: "anti_ai",
    contradicts: (a, b) => a >= 9.0 && b <= 6.0, // 高一致但强 AI 痕迹
  },
  {
    dimA: "pull",
    dimB: "context",
    contradicts: (a, b) => a >= 8.5 && b <= 6.0, // 高牵引但上下文稀薄
  },
]

/** 交叉门结果。 */
export interface CrossDimensionResult {
  /** 跨维矛盾（捕获）。 */
  contradictions: string[]
  /** 判定：多信号一致才判 AI；单维命中降级灰区。 */
  verdict: "ai" | "gray" | "human"
}

/**
 * 跨维交叉门（纯函数——确定性）。
 * 输入：六维分 + 矛盾规则表；输出：矛盾捕获 + 判定。
 * 语义：多信号一致（≥2 矛盾）才判 AI；单维命中降级灰区（不杀）。
 */
export function evaluateCrossDimension(
  scores: Record<string, number>,
  rules: ContradictionRule[] = DEFAULT_CONTRADICTION_RULES,
): CrossDimensionResult {
  const contradictions: string[] = []
  for (const rule of rules) {
    const a = scores[rule.dimA] ?? 0
    const b = scores[rule.dimB] ?? 0
    if (rule.contradicts(a, b)) {
      contradictions.push(`${rule.dimA}×${rule.dimB}`)
    }
  }
  const verdict = contradictions.length >= 2 ? "ai" : contradictions.length === 1 ? "gray" : "human"
  return { contradictions, verdict }
}
