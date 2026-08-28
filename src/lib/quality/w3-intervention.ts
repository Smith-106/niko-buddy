/**
 * w3-intervention.ts — v2.7.2 W3 采纳自动干预（白名单 + veto + 审计）
 *
 * 蓝图 `docs/p0/blueprint-v272-20260828.md`：
 *   - W3（thril/pacing/pull）持续未达标自动派发干预任务
 *   - 白名单动作集（采纳/驳回/重评/标 P0/派发干预任务——禁自动改写正文与记忆）
 *   - 100% 审计 trace（规则 ID + veto 记录）；只落 pending/ready
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// W3 采纳自动干预
// ============================================================================

/** 白名单动作（共识定死）。 */
export const W3_WHITELIST = ["adopt", "reject", "re-evaluate", "flag-p0", "dispatch-task"] as const
export type W3Action = (typeof W3_WHITELIST)[number]

/** 干预记录。 */
export interface InterventionRecord {
  ruleId: string
  action: string
  /** 是否被人工否决（veto）。 */
  vetoed: boolean
  /** 是否直写正式正文/记忆（必须 false）。 */
  writesFormal: boolean
  /** 是否落 pending/ready（Draft-first）。 */
  landsDraft: boolean
}

/** 干预结果。 */
export interface W3InterventionResult {
  /** 越权动作数（白名单外——必须=0）。 */
  violations: number
  /** 正式层直写数（必须=0）。 */
  formalWrites: number
  /** trace 完整数（规则 ID + veto 记录——100%）。 */
  traced: number
  /** 达标判定。 */
  passed: boolean
}

/**
 * W3 干预审计（纯函数——确定性）。
 * 输入：干预记录；输出：越权/直写/可追溯判定。
 * 语义：动作须在白名单；禁直写正式层；100% 留 trace（规则 ID + veto）。
 */
export function auditW3Intervention(records: InterventionRecord[]): W3InterventionResult {
  const violations = records.filter((r) => !(W3_WHITELIST as readonly string[]).includes(r.action)).length
  const formalWrites = records.filter((r) => r.writesFormal).length
  const traced = records.filter((r) => r.ruleId.length > 0 && r.landsDraft).length
  return {
    violations,
    formalWrites,
    traced,
    passed: violations === 0 && formalWrites === 0 && records.length > 0 && traced === records.length,
  }
}
