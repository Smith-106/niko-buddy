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
 * 权威口径。权威判据的唯一实现在 `gate-run-authority.ts`
 * （意图解析 `readGateRunIntent` + 排除注册表 `NON_AUTHORITATIVE_GATE_RUN_INTENTS`
 * + 判据 `isAuthoritativeGateRun` + 账本视图 `toAuthoritativeLedger`），
 * **每一个**读账本算结论的消费方都必须经它过滤，不得自己写字符串比较。
 * 本模块只转出这些符号，保持既有公开面不破。
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
import { GATE_RUN_INTENT_REF_PREFIX, readGateRunIntent } from "./gate-run-authority"
import { toErrorMessage } from "@/lib/utils"

// 权威判据的唯一实现在 gate-run-authority.ts（账本层，单向依赖 run-event-ledger）。
// 此处转出以保证既有调用方（dashboard-evidence / main-control-gate-rerun / barrel）
// 与既有 spec 无需改 import 路径，同时保证「只有一个过滤器」不会分叉。
export {
  GATE_RUN_INTENT_REF_PREFIX,
  MAIN_CONTROL_RERUN_INTENT,
  NON_AUTHORITATIVE_GATE_RUN_INTENTS,
  isAuthoritativeGateRun,
  readGateRunIntent,
  selectAuthoritativeEvents,
  toAuthoritativeLedger,
} from "./gate-run-authority"
export type { GateRunAuthorityOptions } from "./gate-run-authority"

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
  /** 本次写入的 ts（同一批事件共享；undefined = 未落账）。供调用方回读对账「本次 vs 历史」。 */
  readonly ts?: string
}

/** gate-status → gate-run status：pending 是「未评估」，落 skipped 而非 pass（R-04）。 */
export function mapDecisionGateToRunStatus(status: "pending" | "passed" | "failed"): GateRunStatus {
  if (status === "failed") return "fail"
  if (status === "passed") return "pass"
  return "skipped"
}

// 意图/权威口径的实现与注册表见 gate-run-authority.ts（本模块顶部已转出）。
// 新增「非正式章」运行意图只需登记 NON_AUTHORITATIVE_GATE_RUN_INTENTS，消费方无需改动。

/** 由三门结果构造 gate-run 事件输入（纯函数，无 IO；三门各一条，顺序固定）。 */
export function buildChapterGateRunEvents(input: ChapterGateEvidenceInput): RunEventAppendInput[] {
  const evidenceRefs: string[] = []
  if (input.chapterNumber !== undefined) evidenceRefs.push(`chapter:${input.chapterNumber}`)
  if (input.intent) evidenceRefs.push(`${GATE_RUN_INTENT_REF_PREFIX}${input.intent}`)
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
    return { recorded, ts }
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
