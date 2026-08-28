/**
 * decision-points.ts — v2.6.8 D4: 不可逆决策点（append-only 日志 + hash 链）
 *
 * 蓝图 `docs/p0/blueprint-v268-20260828.md` D4：
 *   - append-only 事件日志 + 前置 hash 链校验
 *   - 写前拒非追加（数据层强制——非 UI disabled）
 *   - 锚件 Anti-AI 白名单（防机械提示词误判）
 *   - 漏标比错标危险（因果枢纽默认标不可逆）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 不可逆决策点日志（append-only + hash 链）
// ============================================================================

/** 决策点事件。 */
export interface DecisionPointEvent {
  /** 事件序号（append-only 单调递增）。 */
  seq: number
  /** 章节 ID。 */
  chapterId: string
  /** 决策点描述。 */
  description: string
  /** 前置 hash（链校验——首事件为 genesis）。 */
  prevHash: string
  /** 是否因果枢纽（漏标比错标危险——默认标不可逆）。 */
  isCausalHub: boolean
  /** 时间戳（由调用方注入——纯函数不生成）。 */
  ts: string
}

/** 事件 hash（确定性——纯函数）。 */
export function hashEvent(event: Omit<DecisionPointEvent, "prevHash">): string {
  const payload = `${event.seq}|${event.chapterId}|${event.description}|${event.isCausalHub}|${event.ts}`
  // 轻量确定性 hash（FNV-1a——零依赖）
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** 链校验结果。 */
export interface ChainValidationResult {
  valid: boolean
  /** 断链位置（首个不匹配事件序号）。 */
  brokenAt: number | null
}

/**
 * 前置 hash 链校验（纯函数——确定性）。
 * 输入：事件序列；输出：链是否完整（每事件 prevHash 必须等于前一事件 hash）。
 */
export function validateChain(events: DecisionPointEvent[]): ChainValidationResult {
  for (let i = 0; i < events.length; i++) {
    const expectedPrev = i === 0 ? "genesis" : hashEvent({ ...events[i - 1], prevHash: undefined } as never)
    if (events[i].prevHash !== expectedPrev) {
      return { valid: false, brokenAt: events[i].seq }
    }
  }
  return { valid: true, brokenAt: null }
}

/**
 * 追加事件（写前拒非追加——数据层强制）。
 * 纯函数：输入现有链 + 新事件（无 prevHash——自动计算），输出新链。
 * 非追加（seq 不连续/重复）即拒绝。
 */
export function appendEvent(
  events: DecisionPointEvent[],
  next: Omit<DecisionPointEvent, "seq" | "prevHash"> & { seq?: number },
): { ok: boolean; chain: DecisionPointEvent[]; reason?: string } {
  const expectedSeq = events.length === 0 ? 1 : events[events.length - 1].seq + 1
  if (next.seq !== undefined && next.seq !== expectedSeq) {
    return { ok: false, chain: events, reason: `非追加写入拒绝: seq=${next.seq}（期望 ${expectedSeq}）` }
  }
  const prevHash = events.length === 0 ? "genesis" : hashEvent({ ...events[events.length - 1], prevHash: undefined } as never)
  const event: DecisionPointEvent = {
    seq: expectedSeq,
    chapterId: next.chapterId,
    description: next.description,
    prevHash,
    isCausalHub: next.isCausalHub,
    ts: next.ts,
  }
  return { ok: true, chain: [...events, event] }
}

// ============================================================================
// 锚件 Anti-AI 白名单（防机械提示词误判）
// ============================================================================

/** 锚件白名单（合法锚定短语——过 Anti-AI 回归防误判）。 */
export const ANCHOR_WHITELIST = [
  "不可逆决策点",
  "因果枢纽",
  "叙事锚点",
  "决策锚",
] as const

/** 锚件白名单校验（纯函数——白名单外锚件标记需复核）。 */
export function isWhitelistedAnchor(phrase: string): boolean {
  return (ANCHOR_WHITELIST as readonly string[]).includes(phrase)
}
