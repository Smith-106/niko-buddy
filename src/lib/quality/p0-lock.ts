/**
 * p0-lock.ts — v2.6.11 D7: P0 失败锁死（状态机 LOCKED + D8 归并）
 *
 * 蓝图 `docs/p0/blueprint-v2611-20260828.md` D7：
 *   - 状态机「任一 P0 开→LOCKED」
 *   - 锁触发输出集 = P0 项 ∪ D8 未清 Q0 项（禁止静默清零）
 *   - 仅显式逐项 close 才缩减（不得隐式清零）
 *   - 严格限定 P0（误扩 P1/P2 瘫痪产出）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// P0 锁死状态机
// ============================================================================

/** 锁状态。 */
export type LockState = "UNLOCKED" | "LOCKED"

/** 锁死上下文（P0 项 ∪ D8 未清 Q0 项）。 */
export interface LockContext {
  /** P0 失败项。 */
  p0Failures: string[]
  /** D8 未清 Q0 项（不得隐式清零）。 */
  q0Pending: string[]
}

/** 锁死结果。 */
export interface LockResult {
  state: LockState
  /** 锁触发输出集（P0 ∪ D8 未清——禁止静默清零）。 */
  lockedItems: string[]
  /** 是否 BLOCK（回填被拒）。 */
  blocked: boolean
}

/**
 * P0 锁死判定（纯函数——确定性）。
 * 输入：P0 失败项 + D8 未清 Q0 项；输出：锁状态 + 锁定项集。
 * 语义：任一 P0 开→LOCKED；输出集=P0 ∪ D8 未清（禁止静默清零）。
 */
export function evaluateP0Lock(p0Failures: string[], q0Pending: string[]): LockResult {
  const lockedItems = [...new Set([...p0Failures, ...q0Pending])]
  const state: LockState = p0Failures.length > 0 ? "LOCKED" : "UNLOCKED"
  return { state, lockedItems, blocked: state === "LOCKED" }
}

/**
 * 显式 close（纯函数——确定性）。
 * 输入：锁上下文 + 待 close 项；输出：缩减后的上下文。
 * 语义：仅显式逐项 close 才缩减——未列名项不得隐式清零。
 */
export function closeLockedItem(context: LockContext, item: string): LockContext {
  return {
    p0Failures: context.p0Failures.filter((f) => f !== item),
    q0Pending: context.q0Pending.filter((f) => f !== item),
  }
}

/**
 * 锁死范围校验（纯函数——确定性）。
 * 输入：锁死项；输出：是否严格限定 P0（未扩至 P1/P2）。
 */
export function verifyLockScope(lockedItems: string[], p0Scope: string[]): boolean {
  return lockedItems.every((item) => p0Scope.includes(item))
}

/**
 * 对抗性负向校验（纯函数——确定性）。
 * 输入：锁死结果 + Quality 覆盖尝试；输出：是否拒绝覆盖（逃生通道测试）。
 * 语义：P0 失败时 Quality 高分不得解锁——锁死不可被绕过。
 */
export function verifyNoQualityOverride(lock: LockResult, qualityScore: number): boolean {
  if (lock.state === "LOCKED" && qualityScore >= 9.0) {
    return lock.blocked === true // 即使 Quality 高分——锁死仍 BLOCK
  }
  return true
}
