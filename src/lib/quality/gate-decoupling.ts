/**
 * gate-decoupling.ts — v2.7.0 解耦证明（决策级一致率 + CI 下限 + 翻转红线）
 *
 * 蓝图 `docs/p0/blueprint-v270-20260828.md`：
 *   - 同稿 3 模型决策级三元一致率 ≥95%（95%CI 下限 ≥90%，N≥30）
 *   - 结论翻转（pass↔fail）=0 红线；逐维 5% 容差仅辅助诊断
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 门控解耦证明
// ============================================================================

/** 一致率硬门（共识定死）。 */
export const DECOUPLING_RATE = 0.95

/** CI 下限（共识定死）。 */
export const DECOUPLING_CI_LOWER = 0.9

/** 最小样本（共识定死）。 */
export const DECOUPLING_MIN_N = 30

/** 逐维容差（仅辅助诊断）。 */
export const DECOUPLING_TOLERANCE = 0.05

/** 单模型决策。 */
export interface ModelDecision {
  model: string
  verdict: "pass" | "fail"
}

/** 解耦证明结果。 */
export interface DecouplingResult {
  /** 决策级三元一致率。 */
  rate: number
  /** 95%CI 下限（Wilson 近似）。 */
  ciLower: number
  /** 结论翻转数（pass↔fail——红线）。 */
  flips: number
  /** 是否解耦证明通过（≥95% ∧ CI≥90% ∧ flip=0 ∧ N≥30）。 */
  proven: boolean
}

/**
 * 解耦证明（纯函数——确定性）。
 * 输入：同稿 3 模型决策；输出：一致率 + CI 下限 + 翻转红线判定。
 */
export function evaluateDecoupling(decisions: ModelDecision[][]): DecouplingResult {
  const n = decisions.length
  if (n < DECOUPLING_MIN_N) return { rate: 0, ciLower: 0, flips: 0, proven: false }
  let agree = 0
  let flips = 0
  for (const trio of decisions) {
    if (trio.length < 3) continue
    const verdicts = new Set(trio.map((d) => d.verdict))
    if (verdicts.size === 1) agree++
    else {
      // 结论翻转：至少一个模型 pass↔fail 与多数相反
      const passCount = trio.filter((d) => d.verdict === "pass").length
      if (passCount === 1 || passCount === 2) flips++
    }
  }
  const rate = n === 0 ? 0 : agree / n
  // Wilson 95% CI 下限（近似——零 LLM）
  const z = 1.96
  const denom = 1 + z * z / n
  const center = (rate + z * z / (2 * n)) / denom
  const margin = (z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n))) / denom
  const ciLower = Math.max(0, center - margin)
  return { rate, ciLower, flips, proven: rate >= DECOUPLING_RATE && ciLower >= DECOUPLING_CI_LOWER && flips === 0 }
}
