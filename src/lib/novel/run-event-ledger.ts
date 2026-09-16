/**
 * run-event-ledger.ts — 波1 EB-4 全局运行事件账本（append-only 事件流）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 模块 18，全项目第 1 位，
 * GLM/DeepSeek/Qwen 三路共识）：
 *   - 数据归口三分类之「事件」归口：过程事件一律落本账本（append-only），
 *     不写 status.json（状态归口）也不写 kb 产物（资产归口）。
 *   - 全局约束 R-04（三态强制）：门结果未落 gate-run 事件 = 未发生，
 *     显示层映射 NOT_EVALUATED，**绝不显示为 pass**。
 *   - 四维切片 + replay 链 + budgetCost 归因：gate-run / retrieval / generate /
 *     quota（+ accept / retry / kb-rebuild / error / stage）；
 *     `sliceRunEvents` + `eventsByReplayId` + `aggregateBudgetCost`。
 *
 * EB-4 账本分层：本账本只记账，不裁决 accept；Draft-first 红线由上层契约
 * （novel-session-status.ts 草稿五态）承担，账本只忠实地记录 accept 事件。
 *
 * 不变式（spec 钉死）：
 *   1. append-only：不存在任何 mutation API；append 返回**新**账本，原账本不变；
 *   2. seq 严格单调 = 数组下标（0 起，逐条 +1）；
 *   3. eventId 全账本唯一；
 *   4. 产物（账本与事件）深度冻结；
 *   5. 零 IO / 零时钟（ts 由调用方注入）/ 零模型调用（ADR-19 机械层）。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import type { GateKey } from "./audit-taxonomy"
import type { GateRunStatus } from "./rule-stack"

// ============================================================================
// 事件类别（共识四维切片 + 辅助类别）
// ============================================================================

/** 运行事件类别（append-only 事件流；键序 = 账本切片四维优先序）。 */
export const RUN_EVENT_KINDS = [
  "gate-run",
  "retrieval",
  "generate",
  "accept",
  "retry",
  "quota",
  "kb-rebuild",
  "error",
  "stage",
] as const

/** 运行事件类别。 */
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number]

/** 事件 actor（与 T33 WritingRole 五角色对齐 + system/user）。 */
export const RUN_EVENT_ACTORS = ["system", "writer", "critic", "reviser", "arbiter", "judge", "user"] as const

/** 事件 actor。 */
export type RunEventActor = (typeof RUN_EVENT_ACTORS)[number]

// ============================================================================
// zod 契约
// ============================================================================

/** budgetCost 归因字段（事件粒度资源用量；缺省字段不参与聚合）。 */
export const BUDGET_COST_SCHEMA = z
  .object({
    tokens: z.number().int().nonnegative().optional(),
    wallclockMs: z.number().int().nonnegative().optional(),
    calls: z.number().int().nonnegative().optional(),
  })
  .strict()

/** budgetCost。 */
export type BudgetCost = z.infer<typeof BUDGET_COST_SCHEMA>

/**
 * 运行事件 zod 契约（strict：schema 外字段视为契约违反，spec 钉死）。
 * ts 为调用方注入的 ISO-8601 字符串（零时钟约束）；payload 为有界自由记录。
 */
export const RUN_EVENT_SCHEMA = z
  .object({
    /** 严格单调序号（= 数组下标）。 */
    seq: z.number().int().nonnegative(),
    /** 全账本唯一事件 id（调用方派生；推荐 `${kind}:${seq}:${domain}`）。 */
    eventId: z.string().min(1).max(128),
    /** ISO-8601 时间戳（调用方注入，零时钟）。 */
    ts: z.string().min(1).max(64),
    /** 事件类别。 */
    kind: z.enum(RUN_EVENT_KINDS),
    /** 触发者。 */
    actor: z.enum(RUN_EVENT_ACTORS),
    bookId: z.string().min(1).max(128).optional(),
    chapterId: z.number().int().nonnegative().optional(),
    sessionId: z.string().min(1).max(128).optional(),
    /** 本次调用模型（路由证据；与 model-resolver 路由结果一致）。 */
    modelId: z.string().min(1).max(128).optional(),
    /** ContextPack digest（T25b 冻结不变量证据锚）。 */
    contextPackHash: z.string().min(1).max(128).optional(),
    /** 门-提示词血缘（prompt-artifacts.ts 工件 id@version）。 */
    promptArtifactId: z.string().min(1).max(128).optional(),
    promptArtifactVersion: z.string().min(1).max(32).optional(),
    /** 证据引用（文件路径 / fixture id / finding 锚）。 */
    evidenceRefs: z.array(z.string().min(1).max(256)).max(64).default([]),
    /** 可重放链 id（replay 分组键）。 */
    replayId: z.string().min(1).max(128).optional(),
    budgetCost: BUDGET_COST_SCHEMA.optional(),
    /** 有界自由负载（如 gate-run 的 gate/status/llmMediated）。 */
    payload: z.record(z.unknown()).optional(),
  })
  .strict()

/** 运行事件（schema 校验后）。 */
export type RunEvent = z.infer<typeof RUN_EVENT_SCHEMA>

/** 运行事件输入（evidenceRefs 可省略，走 schema 默认空数组）。 */
export type RunEventInput = z.input<typeof RUN_EVENT_SCHEMA>

// ============================================================================
// 账本数据结构
// ============================================================================

/** 账本 schema 版本。 */
export const RUN_EVENT_LEDGER_SCHEMA_VERSION = "run-event-ledger/1.0"

/** 全局运行事件账本（append-only；无任何 mutation API）。 */
export interface RunEventLedger {
  readonly schemaVersion: typeof RUN_EVENT_LEDGER_SCHEMA_VERSION
  readonly events: readonly RunEvent[]
}

/** 创建空账本（深度冻结零事件起点）。 */
export function createRunEventLedger(): RunEventLedger {
  return deepFreeze({ schemaVersion: RUN_EVENT_LEDGER_SCHEMA_VERSION, events: [] })
}

// ============================================================================
// 错误类型
// ============================================================================

/** run-event-ledger 错误基类。 */
export class RunEventLedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunEventLedgerError"
  }
}

/** 账本完整性错误（schema 违反 / seq 非单调 / eventId 重复）。 */
export class RunEventIntegrityError extends RunEventLedgerError {
  constructor(message: string) {
    super(message)
    this.name = "RunEventIntegrityError"
  }
}

// ============================================================================
// 追加（append-only 唯一写入口）
// ============================================================================

/** 校验并规范化单条事件输入（schema 违反 → RunEventIntegrityError）。 */
function normalizeEvent(raw: unknown, expectedSeq: number): RunEvent {
  let parsed: RunEvent
  try {
    parsed = RUN_EVENT_SCHEMA.parse(raw)
  } catch (err) {
    throw new RunEventIntegrityError(`run-event 契约违反: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (parsed.seq !== expectedSeq) {
    throw new RunEventIntegrityError(
      `run-event seq 必须严格单调（期望 ${expectedSeq}，收到 ${parsed.seq}）`,
    )
  }
  return parsed
}

/**
 * 追加单条事件（append-only）：返回**新**账本，原账本不变（不可变追加）。
 * 校验：schema + seq 单调 + eventId 唯一；产物深度冻结。
 */
export function appendRunEvent(ledger: RunEventLedger, event: RunEventInput): RunEventLedger {
  const expectedSeq = ledger.events.length
  const normalized = normalizeEvent(event, expectedSeq)
  for (const existing of ledger.events) {
    if (existing.eventId === normalized.eventId) {
      throw new RunEventIntegrityError(`重复的 eventId: "${normalized.eventId}"`)
    }
  }
  return deepFreeze({
    schemaVersion: RUN_EVENT_LEDGER_SCHEMA_VERSION,
    events: [...ledger.events, normalized],
  })
}

/** 批量追加（逐条 seq 单调 + eventId 唯一校验；任一违反整体拒绝，不产生半提交）。 */
export function appendRunEvents(
  ledger: RunEventLedger,
  events: readonly RunEventInput[],
): RunEventLedger {
  let next = ledger
  for (const event of events) {
    next = appendRunEvent(next, event)
  }
  return next
}

// ============================================================================
// 门控事件（gate-run）与覆盖不变量
// ============================================================================

/** gate-run 事件 payload 契约（自由 record 的类型化视图）。 */
export interface GateRunEventPayload {
  readonly gate: GateKey
  readonly status: GateRunStatus
  readonly findingsCount?: number
  readonly escalatedCount?: number
  /** LLM 中介门（true → 门-提示词血缘必填，见 prompt-artifacts.checkPromptLineageCoverage）。 */
  readonly llmMediated?: boolean
  readonly score?: number | null
}

/** 门运行事件输入（不含 payload 细节外的公共字段复用 base）。 */
export interface GateRunEventBase {
  readonly ts: string
  readonly actor?: RunEventActor
  readonly bookId?: string
  readonly chapterId?: number
  readonly sessionId?: string
  readonly modelId?: string
  readonly contextPackHash?: string
  readonly promptArtifactId?: string
  readonly promptArtifactVersion?: string
  readonly replayId?: string
  readonly budgetCost?: BudgetCost
  readonly evidenceRefs?: readonly string[]
  readonly llmMediated?: boolean
}

/**
 * 由一次门控运行产出门事件序列（每门一条，含 skipped——跳过本身也是可审计事件；
 * skipped 门显示层为 NOT_EVALUATED，绝不显示 pass，R-04）。
 * eventId 确定性派生：`gate-run:${seq}:${gate}`。
 */
export function recordGateRunEvents(
  ledger: RunEventLedger,
  outcomes: readonly { readonly gate: GateKey; readonly status: GateRunStatus; readonly findingsCount?: number; readonly escalatedCount?: number; readonly score?: number | null }[],
  base: GateRunEventBase,
): RunEventLedger {
  let next = ledger
  for (const outcome of outcomes) {
    const seq = next.events.length
    const payload: GateRunEventPayload = {
      gate: outcome.gate,
      status: outcome.status,
      findingsCount: outcome.findingsCount,
      escalatedCount: outcome.escalatedCount,
      score: outcome.score,
      llmMediated: base.llmMediated,
    }
    const event: RunEventInput = {
      seq,
      eventId: `gate-run:${seq}:${outcome.gate}`,
      ts: base.ts,
      kind: "gate-run",
      actor: base.actor ?? "system",
      bookId: base.bookId,
      chapterId: base.chapterId,
      sessionId: base.sessionId,
      modelId: base.modelId,
      contextPackHash: base.contextPackHash,
      promptArtifactId: base.promptArtifactId,
      promptArtifactVersion: base.promptArtifactVersion,
      evidenceRefs: base.evidenceRefs === undefined ? [] : [...base.evidenceRefs],
      replayId: base.replayId,
      budgetCost: base.budgetCost,
      payload: payload as unknown as Record<string, unknown>,
    }
    next = appendRunEvent(next, event)
  }
  return next
}

/** 门事件覆盖检查结果（G1：rate 必须 = 1.0）。 */
export interface GateEventCoverage {
  readonly totalGates: number
  readonly covered: number
  /** 有裁定但无对应 gate-run 事件的门（违反「未落 = 未发生」）。 */
  readonly uncoveredGates: readonly GateKey[]
  /** covered / total；total=0 时恒 1（空运行平凡覆盖）。 */
  readonly rate: number
}

/**
 * 门事件覆盖检查：outcomes 中每个门（含 skipped）都必须在账本（可选按
 * replayId 过滤）中存在同 gate 的 gate-run 事件——「门结果未落事件 = 未发生」。
 */
export function checkGateEventCoverage(
  outcomes: readonly { readonly gate: GateKey }[],
  ledger: RunEventLedger,
  match?: { readonly replayId?: string },
): GateEventCoverage {
  const relevant =
    match?.replayId !== undefined ? eventsByReplayId(ledger, match.replayId) : ledger.events
  const recorded = new Set<GateKey>()
  for (const event of relevant) {
    if (event.kind !== "gate-run") continue
    const payload = readGateRunPayload(event)
    if (payload) recorded.add(payload.gate)
  }
  const uncoveredGates = outcomes.map((o) => o.gate).filter((gate) => !recorded.has(gate))
  const total = outcomes.length
  const covered = total - uncoveredGates.length
  return {
    totalGates: total,
    covered,
    uncoveredGates,
    rate: total === 0 ? 1 : covered / total,
  }
}

/** 读取事件上的 gate-run payload（非 gate-run / 形状不符 → null）。 */
export function readGateRunPayload(event: RunEvent): GateRunEventPayload | null {
  if (event.kind !== "gate-run" || !event.payload) return null
  const p = event.payload as Partial<GateRunEventPayload>
  if (typeof p.gate !== "string" || typeof p.status !== "string") return null
  return p as GateRunEventPayload
}

// ============================================================================
// 显示层三态（R-04：未评估 ≠ 通过）
// ============================================================================

/** 门显示三态（共识计划全局约束：PASS / FAIL / NOT_EVALUATED）。 */
export type GateDisplayStatus = "pass" | "fail" | "not_evaluated"

/** 三态取值注册表。 */
export const GATE_DISPLAY_STATUSES: readonly GateDisplayStatus[] = ["pass", "fail", "not_evaluated"]

/**
 * 运行期门状态 → 显示三态：
 *   - pass / fail 原样；
 *   - skipped（被短路跳过）与 undefined/null（从未运行、无事件）→ not_evaluated。
 * 不变量：仅 status === "pass" 才映射 pass——「未评估」永不显示为通过（R-04）。
 */
export function gateDisplayStatus(status: GateRunStatus | undefined | null): GateDisplayStatus {
  if (status === "pass") return "pass"
  if (status === "fail") return "fail"
  return "not_evaluated"
}

/** 显示标签（UI 消费；未评估 =「未评估」，绝不渲染「通过」）。 */
export function gateDisplayLabel(status: GateDisplayStatus): string {
  switch (status) {
    case "pass":
      return "通过"
    case "fail":
      return "未通过"
    case "not_evaluated":
      return "未评估"
  }
}

// ============================================================================
// 切片 / 重放链 / 成本归因
// ============================================================================

/** 切片过滤器（字段与关系 AND；未提供的字段不参与过滤）。 */
export interface RunEventFilter {
  kind?: RunEventKind
  kinds?: readonly RunEventKind[]
  bookId?: string
  chapterId?: number
  sessionId?: string
  modelId?: string
  replayId?: string
  /** ISO-8601 字典序区间（含端点；调用方保证同格式）。 */
  sinceTs?: string
  untilTs?: string
}

/**
 * 切片（四维：gate-run / retrieval / generate / quota 为一等过滤键）。
 * 结果保持 seq 升序（append-only 账本天然全序），确定性可重放。
 */
export function sliceRunEvents(
  ledger: RunEventLedger,
  filter: RunEventFilter = {},
): readonly RunEvent[] {
  return ledger.events.filter((event) => {
    if (filter.kind !== undefined && event.kind !== filter.kind) return false
    if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false
    if (filter.bookId !== undefined && event.bookId !== filter.bookId) return false
    if (filter.chapterId !== undefined && event.chapterId !== filter.chapterId) return false
    if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false
    if (filter.modelId !== undefined && event.modelId !== filter.modelId) return false
    if (filter.replayId !== undefined && event.replayId !== filter.replayId) return false
    if (filter.sinceTs !== undefined && event.ts < filter.sinceTs) return false
    if (filter.untilTs !== undefined && event.ts > filter.untilTs) return false
    return true
  })
}

/** 按 replayId 串接可重放链（seq 升序）。 */
export function eventsByReplayId(ledger: RunEventLedger, replayId: string): readonly RunEvent[] {
  return sliceRunEvents(ledger, { replayId })
}

/** 全账本去重 replay id（首见序）。 */
export function listReplayIds(ledger: RunEventLedger): readonly string[] {
  const seen: string[] = []
  for (const event of ledger.events) {
    if (event.replayId !== undefined && !seen.includes(event.replayId)) seen.push(event.replayId)
  }
  return seen
}

/** 成本归因聚合（budgetCost 逐事件求和；未携带字段的 event 不计入该项）。 */
export interface BudgetCostSummary {
  readonly tokens: number
  readonly wallclockMs: number
  readonly calls: number
  /** 参与聚合的事件数（携带 budgetCost 的事件）。 */
  readonly eventsCounted: number
}

/** 聚合事件流的 budgetCost（纯函数；供「本书花多少 token / 几轮重试」归因查询）。 */
export function aggregateBudgetCost(events: readonly RunEvent[]): BudgetCostSummary {
  let tokens = 0
  let wallclockMs = 0
  let calls = 0
  let eventsCounted = 0
  for (const event of events) {
    const cost = event.budgetCost
    if (!cost) continue
    eventsCounted += 1
    tokens += cost.tokens ?? 0
    wallclockMs += cost.wallclockMs ?? 0
    calls += cost.calls ?? 0
  }
  return { tokens, wallclockMs, calls, eventsCounted }
}

/** 最近一条指定类别事件（无 → null；同 ts 按 seq 最大）。 */
export function latestEventOf(ledger: RunEventLedger, kind: RunEventKind): RunEvent | null {
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const event = ledger.events[i]
    if (event.kind === kind) return event
  }
  return null
}

// ============================================================================
// 内部工具
// ============================================================================

/** 深度冻结（与 rule-stack.ts deepFreeze 同型；函数值跳过）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      Object.freeze(value)
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}