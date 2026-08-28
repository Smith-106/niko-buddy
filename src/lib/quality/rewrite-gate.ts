/**
 * rewrite-gate.ts — v2.7.3 Draft-first 闸门（零直写断言 + 渗透测试）
 *
 * 蓝图 `docs/p0/blueprint-v273-20260828.md`：
 *   - 任何直写正式正文均阻断（闸门渗透测试 0 成功）
 *   - 风格套用产出 → pending；回溯显影 → 只读清单；记忆改写 → pending→ready→accept
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// Draft-first 闸门
// ============================================================================

/** 落盘目标。 */
export type WriteTarget = "pending" | "ready" | "formal"

/** 渗透尝试。 */
export interface PenetrationAttempt {
  id: string
  /** 尝试写入目标。 */
  target: WriteTarget
  /** 是否被闸门拦截。 */
  blocked: boolean
}

/** 闸门结果。 */
export interface RewriteGateResult {
  /** 直写正式层成功数（必须=0）。 */
  formalWrites: number
  /** 渗透拦截率（100% 硬门）。 */
  blockRate: number
  /** 达标判定。 */
  passed: boolean
}

/**
 * 闸门渗透测试（纯函数——确定性）。
 * 输入：渗透尝试序列；输出：拦截率。
 * 语义：formal 目标必须 100% 拦截；pending/ready 放行。
 */
export function evaluateRewriteGate(attempts: PenetrationAttempt[]): RewriteGateResult {
  const formalAttempts = attempts.filter((a) => a.target === "formal")
  const formalWrites = formalAttempts.filter((a) => !a.blocked).length
  const blockRate = formalAttempts.length === 0 ? 1 : formalAttempts.filter((a) => a.blocked).length / formalAttempts.length
  return { formalWrites, blockRate, passed: formalWrites === 0 && blockRate === 1 }
}
