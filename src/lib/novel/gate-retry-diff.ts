/**
 * gate-retry-diff.ts — 波2-C：同门两 run EB-1 差分（含换模型轨迹）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 7 深化）：
 *   - GLM P1 缺口「gate-retry-diff」：UI 可展示同一门重试前后两份 EB-1 卡片
 *     差分（含换模型轨迹与 replayId）；
 *   - DS 验收：门重试差分按 verdict/score/evidence 并列展示并链 replayId。
 *
 * 机械口径：差分对象 = 账本中同门两次 gate-run 事件（显式事件对，或自动取
 * 最近两次）——verdict/score/evidence/modelId 逐项对照；modelTrajectory =
 * [before, after] 换模型轨迹（routing 证据，与 model-resolver 路由一致）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © QMAI
 */

import type { GateKey } from "./audit-taxonomy"
import { readGateRunPayload, sliceRunEvents, type RunEvent, type RunEventLedger } from "./run-event-ledger"

/** 单 run 对照面（EB-1 卡片可展示字段的最小集）。 */
export interface GateRunSide {
  /** 门运行事件 id（gate-run:<seq>:<gate>）。 */
  readonly eventId: string
  readonly replayId: string | null
  readonly modelId: string | null
  readonly status: string | null
  readonly score: number | null
  readonly ts: string
  readonly evidenceCount: number
  readonly findingsCount: number | null
}

/** 同门两 run 差分（verdict/score/evidence/modelId 并列 + 换模型轨迹）。 */
export interface GateRetryDiff {
  readonly gate: GateKey
  readonly before: GateRunSide
  readonly after: GateRunSide
  /** verdict 是否翻转（fail↔pass；skipped 对 skipped = 未翻转）。 */
  readonly verdictChanged: boolean
  /** after.score - before.score（任一 null → null）。 */
  readonly scoreDelta: number | null
  /** 换模型（modelId 变化）。 */
  readonly modelSwapped: boolean
  /** 换模型轨迹 [before, after]（routing 证据）。 */
  readonly modelTrajectory: readonly (string | null)[]
  /** 证据数变化 after - before。 */
  readonly evidenceDelta: number
}

/** 事件 → 差分侧（只读投影）。 */
function sideOf(event: RunEvent): GateRunSide {
  const payload = readGateRunPayload(event)
  return {
    eventId: event.eventId,
    replayId: event.replayId ?? null,
    modelId: event.modelId ?? null,
    status: payload?.status ?? null,
    score: payload?.score ?? null,
    ts: event.ts,
    evidenceCount: event.evidenceRefs.length,
    findingsCount: payload?.findingsCount ?? null,
  }
}

/**
 * 显式事件对差分（纯函数）：before/after 必须同门（payload.gate 一致）且
 * after.seq > before.seq（账本全序——同门两次运行）。
 */
export function diffGateRunPair(before: RunEvent, after: RunEvent): GateRetryDiff {
  const beforePayload = readGateRunPayload(before)
  const afterPayload = readGateRunPayload(after)
  const gate = beforePayload?.gate
  if (gate === undefined || afterPayload?.gate !== gate) {
    throw new GateRetryDiffError("差分对象必须是同门两次门运行事件")
  }
  if (after.seq <= before.seq) {
    throw new GateRetryDiffError("差分顺序违反账本全序：after.seq 必须 > before.seq")
  }
  const beforeSide = sideOf(before)
  const afterSide = sideOf(after)
  const scoreDelta =
    beforeSide.score !== null && afterSide.score !== null ? afterSide.score - beforeSide.score : null
  return {
    gate,
    before: beforeSide,
    after: afterSide,
    verdictChanged: beforeSide.status !== afterSide.status,
    scoreDelta,
    modelSwapped: beforeSide.modelId !== afterSide.modelId,
    modelTrajectory: [beforeSide.modelId, afterSide.modelId],
    evidenceDelta: afterSide.evidenceCount - beforeSide.evidenceCount,
  }
}

/**
 * 同门最近两 run 自动差分：取账本中该门（可选 scope 过滤）最近两条 gate-run
 * 事件（seq 升序取末两条）；不足两条 → null（无可差分）。
 */
export function diffLatestGateRetries(
  ledger: RunEventLedger,
  gate: GateKey,
  scope?: { readonly bookId?: string; readonly chapterId?: number },
): GateRetryDiff | null {
  const runs = sliceRunEvents(ledger, { kind: "gate-run", bookId: scope?.bookId, chapterId: scope?.chapterId })
    .filter((event) => readGateRunPayload(event)?.gate === gate)
  if (runs.length < 2) return null
  const before = runs[runs.length - 2] as RunEvent
  const after = runs[runs.length - 1] as RunEvent
  return diffGateRunPair(before, after)
}

/** gate-retry-diff 错误。 */
export class GateRetryDiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GateRetryDiffError"
  }
}