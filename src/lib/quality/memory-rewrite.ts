/**
 * memory-rewrite.ts — v2.7.3 记忆自动改写（pending/ready→accept 闸门 + diff=0 铁证）
 *
 * 蓝图 `docs/p0/blueprint-v273-20260828.md`：
 *   - pending/ready→accept 闸门（零直写正式正文/正式记忆）
 *   - diff=0=字符级纯替换（替换点外零增删，diff 算法 empty 为铁证）
 *   - 拒绝后记忆不降级不删除可复判
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 记忆自动改写
// ============================================================================

/** 改写状态机。 */
export type RewriteState = "pending" | "ready" | "accepted" | "rejected"

/** 改写记录。 */
export interface RewriteRecord {
  id: string
  /** 声明替换映射（位置→替换文本）。 */
  replacements: Array<{ pos: number; len: number; text: string }>
  /** 实际输出文本。 */
  output: string
  /** 原文。 */
  original: string
  /** 状态。 */
  state: RewriteState
}

/** 改写结果。 */
export interface RewriteResult {
  /** diff=0 通过数（字符级纯替换——替换点外零增删）。 */
  diffZeroCount: number
  /** 直写正式层数（必须=0）。 */
  formalWrites: number
  /** 拒绝后记忆保留数（不降级不删除）。 */
  rejectedPreserved: number
  /** 达标判定。 */
  passed: boolean
}

/**
 * diff=0 校验（纯函数——确定性）。
 * 语义：按声明替换映射重建期望文本，与输出逐字符比对（替换点外零增删）。
 */
export function diffZero(record: RewriteRecord): boolean {
  // 重建期望文本：按替换映射（位置升序）应用
  const parts: string[] = []
  let cursor = 0
  const sorted = [...record.replacements].sort((a, b) => a.pos - b.pos)
  for (const r of sorted) {
    if (r.pos < cursor) return false // 重叠替换 → 非法
    parts.push(record.original.slice(cursor, r.pos))
    parts.push(r.text)
    cursor = r.pos + r.len
  }
  parts.push(record.original.slice(cursor))
  const expected = parts.join("")
  return expected === record.output
}

/**
 * 改写流评估（纯函数——确定性）。
 * 输入：改写记录；输出：diff=0 计数/直写计数/拒绝保留。
 * 语义：accepted 必须 diff=0；任何状态不得直写正式层；rejected 保留记忆。
 */
export function evaluateRewrite(records: RewriteRecord[]): RewriteResult {
  const accepted = records.filter((r) => r.state === "accepted")
  const diffZeroCount = accepted.filter(diffZero).length
  const formalWrites = records.filter((r) => r.state === "accepted" && !diffZero(r)).length
  const rejectedPreserved = records.filter((r) => r.state === "rejected").length
  return { diffZeroCount, formalWrites, rejectedPreserved, passed: diffZeroCount === accepted.length && formalWrites === 0 }
}
