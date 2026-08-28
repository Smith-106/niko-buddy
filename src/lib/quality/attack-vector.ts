/**
 * attack-vector.ts — v2.7.1 新攻击向量（语义改写/越狱五段闭环）
 *
 * 蓝图 `docs/p0/blueprint-v271-20260828.md`：
 *   - 语义改写（归一化→回译一致性双向检测）+ 越狱（指令覆盖+角色边界）
 *   - 五段闭环（复现→检中→归因→补丁→回归）100%；各 ≥10 用例
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 新攻击向量闭环
// ============================================================================

/** 每向量最小闭环用例（共识定死）。 */
export const VECTOR_MIN_CASES = 10

/** 闭环五段（定死）。 */
export const CLOSED_LOOP_STAGES = ["reproduce", "detected", "attributed", "patched", "regressed"] as const
export type ClosedLoopStage = (typeof CLOSED_LOOP_STAGES)[number]

/** 攻击向量。 */
export type AttackVector = "semantic-rephrase" | "jailbreak"

/** 单用例闭环状态。 */
export interface VectorCase {
  id: string
  vector: AttackVector
  /** 已完成的闭环段。 */
  stages: ClosedLoopStage[]
}

/** 闭环结果。 */
export interface VectorResult {
  vector: AttackVector
  /** 用例数（≥10 硬门）。 */
  total: number
  /** 完全闭环用例数。 */
  closed: number
  /** 闭环率（100% 硬门）。 */
  closedRate: number
  /** 是否达标。 */
  passed: boolean
}

/**
 * 向量闭环校验（纯函数——确定性）。
 * 输入：某向量全部用例；输出：闭环率。
 * 语义：五段（复现→检中→归因→补丁→回归）全完成才算闭环；≥10 用例且闭环率 100%。
 */
export function evaluateVector(cases: VectorCase[], vector: AttackVector): VectorResult {
  const mine = cases.filter((c) => c.vector === vector)
  const closed = mine.filter((c) => CLOSED_LOOP_STAGES.every((s) => c.stages.includes(s))).length
  const total = mine.length
  const closedRate = total === 0 ? 0 : closed / total
  return { vector, total, closed, closedRate, passed: total >= VECTOR_MIN_CASES && closedRate === 1 }
}
