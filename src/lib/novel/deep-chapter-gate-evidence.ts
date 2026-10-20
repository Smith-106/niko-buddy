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
 * @license MIT © Niko Buddy
 */

import type { DeepChapterDecisionGates, DeepChapterDecisionGateKey } from "./deep-chapter-decision-gates"
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
