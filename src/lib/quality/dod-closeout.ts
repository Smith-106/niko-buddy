/**
 * dod-closeout.ts — v2.6.13: DoD 收口 + 集成验收判定
 *
 * 蓝图 `docs/p0/blueprint-v2613-20260828.md`：
 *   - DoD 清单 100% 勾选；DEFER 项登记 owner+日期
 *   - 集成验收：typecheck 0 + vitest 全绿 + 无 P0/P1 阻断
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// DoD 收口
// ============================================================================

/** DoD 收口结果。 */
export interface DodCloseoutResult {
  /** 勾选完成率。 */
  checkedRate: number
  /** 是否 100% 勾选。 */
  complete: boolean
  /** DEFER 项登记（owner+date 非空）。 */
  deferRegistered: boolean
  /** 集成验收（无 P0/P1 阻断）。 */
  integrationClean: boolean
}

/**
 * DoD 收口判定（纯函数——确定性）。
 * 输入：勾选数/总数 + DEFER 项登记 + 集成状态；输出：收口判定。
 * 语义：100% 勾选 ∧ DEFER 登记 ∧ 无 P0/P1 阻断——三者全过才收口。
 */
export function evaluateDodCloseout(
  checked: number,
  total: number,
  deferRegistered: boolean,
  integrationClean: boolean,
): DodCloseoutResult {
  const checkedRate = total === 0 ? 0 : checked / total
  return {
    checkedRate,
    complete: checkedRate >= 1 && deferRegistered && integrationClean,
    deferRegistered,
    integrationClean,
  }
}
