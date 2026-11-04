/**
 * deep-chapter-gate-evidence.ts — 章节生成三门证据落账（write / continue /
 * rewrite / polish / resume 共用同一写入口）。
 *
 * ## 为什么需要这一层
 * 内核 `runDeepChapterGeneration` 每章都会算 `decisionGates`（Consistency P0 >
 * Anti-AI P1 > Quality P2），但结果只留在返回值里、没有落 `.novel/run-events.jsonl`
 * 的 `gate-run` 事件——首页证据看板（`dashboard-evidence` 只读派生）因此恒显示
 * 「未评估」，而「续写」与「从头写」是否真的过了同一套门也无从审计。
 *
 * 本模块把 `DeepChapterDecisionGates` 翻译成 `gate-run` 事件（每门一条），
 * 由内核在返回前统一调用——**续写与从头写走同一条留证路径**，不存在只有其中
 * 一方写证据的分支。
 *
 * ## 纪律
 *   - 未评估门（`pending`）落 `skipped`，不落 `pass`（R-04：未落 gate-run 的门
 *     永不渲染为通过；skipped 显示层仍是 NOT_EVALUATED）；
 *   - 单一真源：不新建事件文件，只追加既有账本（`run-event-ledger-store`）；
 *   - 非致命：任何 IO 失败都不得影响正文交付（写作优先，证据可重放）；
 *   - 纯映射 + 注入式 IO（单测不碰磁盘）。
 *
 * ## 意图与权威口径（防污染）
 * 账本里的 `gate-run` 有两种来源：正式章运行与「草稿复核」类动作（主控重跑门控，
 * `intent:main-control-rerun`）。两者都落账本（可审计、可回读），但只有前者是
 * 首页证据看板的权威口径。权威判据统一在 `isAuthoritativeGateRun`
 * （意图解析 `readGateRunIntent` + 排除注册表 `NON_AUTHORITATIVE_GATE_RUN_INTENTS`），
 * 消费方不得自己写字符串比较。
 *
 * @license MIT © Niko Buddy
 */

import type { DeepChapterDecisionGates, DeepChapterDecisionGateKey } from "./deep-chapter-decision-gates"
import { readGateRunPayload, type RunEvent, type RunEventLedger } from "./run-event-ledger"
import {
  appendRunEventsToStore,
  createFsRunEventLedgerStoreDeps,
  type RunEventAppendInput,
  type RunEventLedgerStoreDeps,
} from "./run-event-ledger-store"
import type { GateRunStatus } from "./rule-stack"
import { toErrorMessage } from "@/lib/utils"

/** 三门顺序固定（Consistency P0 > Anti-AI P1 > Quality P2）。 */
const GATE_ORDER: readonly DeepChapterDecisionGateKey[] = ["consistency", "anti_ai", "quality"]

export interface ChapterGateEvidenceInput {
  readonly projectPath: string
  readonly decisionGates: DeepChapterDecisionGates
  readonly retryCount?: number
  readonly chapterNumber?: number
  readonly bookId?: string
  readonly sessionId?: string
  readonly modelId?: string
  /** 本次是否走过 LLM 审稿（deepChapterReview 关闭时为 false → 仍在 payload 里可审计）。 */
  readonly llmMediated?: boolean
  /** 生成来源（resume = 断点续写），只进 evidenceRefs 便于审计区分。 */
  readonly intent?: string
}

export interface ChapterGateEvidenceDeps {
  /** 账本追加（默认生产 fs store；测试注入内存实现）。 */
  readonly appendEvents?: typeof appendRunEventsToStore
  /** 账本 store deps（默认生产 Tauri fs）。 */
  readonly storeDeps?: RunEventLedgerStoreDeps
  /** 时间源（默认 new Date）。 */
  readonly now?: () => Date
}

export interface ChapterGateEvidenceResult {
  /** 实际落账的门（顺序 = GATE_ORDER）。 */
  readonly recorded: readonly DeepChapterDecisionGateKey[]
  /** 落账失败原因（非致命；undefined = 成功或无事件）。 */
  readonly error?: string
}

/** gate-status → gate-run status：pending 是「未评估」，落 skipped 而非 pass（R-04）。 */
export function mapDecisionGateToRunStatus(status: "pending" | "passed" | "failed"): GateRunStatus {
  if (status === "failed") return "fail"
  if (status === "passed") return "pass"
  return "skipped"
}

// ============================================================================
// 意图（intent）与权威口径（防污染）
// ============================================================================
//
// 账本里 gate-run 不止一种来源：正式章运行（写/续写/重写/润色/断点续写）与
// 「草稿复核」类动作（主控重跑门控）。两者都落同一批 gate-run 事件（可审计、
// 可回读），但只有前者是首页证据看板的**权威口径**——草稿复核若被当成最近一条，
// 首页三门会被未采纳草稿的结论覆盖（「结论丢失」换成「结论污染」）。
//
// 因此意图不写成散落的字符串比较：一处解析（readGateRunIntent）、一份排除注册表
// （NON_AUTHORITATIVE_GATE_RUN_INTENTS）、一个判据（isAuthoritativeGateRun）。
// 新增「非正式章」运行意图只需登记进注册表，消费方无需改动。

/** evidenceRefs 中的意图 ref 前缀（写入见 buildChapterGateRunEvents；`intent:<name>`）。 */
export const GATE_RUN_INTENT_REF_PREFIX = "intent:"

/** 主控「重跑门控」意图：草稿复核，不是正式章运行，不参与权威口径。 */
export const MAIN_CONTROL_RERUN_INTENT = "main-control-rerun"

/**
 * 非权威 gate-run 意图注册表（扩展点）：命中的事件仍留在账本（可审计/可回读），
 * 但不参与首页三门权威口径与列表健康列派生。
 */
export const NON_AUTHORITATIVE_GATE_RUN_INTENTS: readonly string[] = [MAIN_CONTROL_RERUN_INTENT]

/** 读事件 evidenceRefs 携带的意图（`intent:xxx` → "xxx"；无 → undefined）。 */
export function readGateRunIntent(event: RunEvent): string | undefined {
  for (const ref of event.evidenceRefs ?? []) {
    if (!ref.startsWith(GATE_RUN_INTENT_REF_PREFIX)) continue
    const intent = ref.slice(GATE_RUN_INTENT_REF_PREFIX.length).trim()
    if (intent.length > 0) return intent
  }
  return undefined
}

/**
 * 该事件是否属于「权威」正式章门运行：
 *   - 非 gate-run → false（kind 谓词，stage 系事件结构性收容）；
 *   - 无 intent ref → true（正式章运行不带意图；历史账本兼容）；
 *   - 意图命中排除表（默认 NON_AUTHORITATIVE_GATE_RUN_INTENTS）→ false。
 */
export function isAuthoritativeGateRun(
  event: RunEvent,
  excludedIntents: readonly string[] = NON_AUTHORITATIVE_GATE_RUN_INTENTS,
): boolean {
  if (event.kind !== "gate-run") return false
  const intent = readGateRunIntent(event)
  if (intent === undefined) return true
  return !excludedIntents.includes(intent)
}

/** 由三门结果构造 gate-run 事件输入（纯函数，无 IO；三门各一条，顺序固定）。 */
export function buildChapterGateRunEvents(input: ChapterGateEvidenceInput): RunEventAppendInput[] {
  const evidenceRefs: string[] = []
  if (input.chapterNumber !== undefined) evidenceRefs.push(`chapter:${input.chapterNumber}`)
  if (input.intent) evidenceRefs.push(`intent:${input.intent}`)
  if (input.retryCount !== undefined) evidenceRefs.push(`retry:${input.retryCount}`)
  return GATE_ORDER.map((gateKey) => {
    const gate = input.decisionGates[gateKey]
    const findings = gate.findings ?? []
    return {
      ts: "",
      kind: "gate-run",
      actor: "system" as const,
      bookId: input.bookId,
      chapterId: input.chapterNumber,
      sessionId: input.sessionId,
      modelId: input.modelId,
      evidenceRefs: [...evidenceRefs],
      payload: {
        gate: gateKey,
        status: mapDecisionGateToRunStatus(gate.status),
        findingsCount: findings.length,
        escalatedCount: findings.filter((item) => item.severity === "error").length,
        score: null,
        llmMediated: input.llmMediated,
      } as unknown as Record<string, unknown>,
    } satisfies RunEventAppendInput
  })
}

/**
 * 落三门证据（非致命）。返回实际落账的门，供调用方诊断；失败只回 error 不抛。
 */
export async function recordChapterGateEvidence(
  input: ChapterGateEvidenceInput,
  deps: ChapterGateEvidenceDeps = {},
): Promise<ChapterGateEvidenceResult> {
  if (!input.projectPath) return { recorded: [] }
  const append = deps.appendEvents ?? appendRunEventsToStore
  const storeDeps = deps.storeDeps ?? createFsRunEventLedgerStoreDeps()
  const now = deps.now ?? (() => new Date())
  const ts = now().toISOString()
  const events = buildChapterGateRunEvents(input).map((event) => ({ ...event, ts }))
  const recorded = GATE_ORDER.filter((gateKey) => input.decisionGates[gateKey] !== undefined)
  try {
    await append(storeDeps, input.projectPath, events)
    return { recorded }
  } catch (error) {
    return { recorded, error: toErrorMessage(error) }
  }
}

// ============================================================================
// 账本回读（只读；供 UI 恢复历史结论）
// ============================================================================

/** 单门回读行（账本 → 展示单元）。 */
export interface GateRunEvidenceRow {
  readonly gate: DeepChapterDecisionGateKey
  /** pass / fail / skipped —— skipped = 未评估，绝不呈现为通过。 */
  readonly status: GateRunStatus
  readonly findingsCount: number
  readonly llmMediated?: boolean
}

/** 一次门控运行的账本回读结果（同一次写入 = 同一 ts 的多门事件）。 */
export interface GateRunEvidenceGroup {
  readonly ts: string
  readonly intent: string | undefined
  readonly chapterId: number | null
  readonly bookId: string | null
  /** 按 GATE_ORDER 排列；组内每门取最后一条。 */
  readonly rows: readonly GateRunEvidenceRow[]
}

/**
 * 回读账本中最近一次 gate-run 运行（`filter.intent` 缺省 = 不区分意图）。
 *
 * 分组口径：一次 `recordChapterGateEvidence` 写入的多门事件共享同一 ts，故按
 * ts（+ 同 intent）归组，每门取组内最后一条。纯函数、零 IO。
 */
export function readLatestGateRunGroup(
  ledger: RunEventLedger,
  filter: { readonly intent?: string } = {},
): GateRunEvidenceGroup | null {
  let anchor: { readonly ts: string; readonly intent: string | undefined } | null = null
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const event = ledger.events[i] as RunEvent
    if (readGateRunPayload(event) === null) continue
    const intent = readGateRunIntent(event)
    if (filter.intent !== undefined && intent !== filter.intent) continue
    anchor = { ts: event.ts, intent }
    break
  }
  if (anchor === null) return null

  const byGate = new Map<DeepChapterDecisionGateKey, GateRunEvidenceRow>()
  let chapterId: number | null = null
  let bookId: string | null = null
  for (const event of ledger.events) {
    if (event.ts !== anchor.ts) continue
    if (readGateRunIntent(event) !== anchor.intent) continue
    const payload = readGateRunPayload(event)
    if (payload === null) continue
    if (!GATE_ORDER.includes(payload.gate)) continue
    byGate.set(payload.gate, {
      gate: payload.gate,
      status: payload.status,
      findingsCount: payload.findingsCount ?? 0,
      llmMediated: payload.llmMediated,
    })
    chapterId = event.chapterId ?? chapterId
    bookId = event.bookId ?? bookId
  }
  return {
    ts: anchor.ts,
    intent: anchor.intent,
    chapterId,
    bookId,
    rows: GATE_ORDER.filter((gate) => byGate.has(gate)).map((gate) => byGate.get(gate) as GateRunEvidenceRow),
  }
}
