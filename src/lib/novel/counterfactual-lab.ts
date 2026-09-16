/**
 * counterfactual-lab.ts — 波3-A：反事实重放通用化（任意门）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波3 + 模块 13 深化）：
 *   - GLM/DS P1 缺口「反事实重放通用化」：对任意门/工件可配置反事实剔除并
 *     自动判定 verdict 翻转（波1 retrieval-trace 的 counterfactualReplay 仅
 *     固定 P0 verdict 基线，不满足「任意门」）。
 *
 * 通用化口径（与 retrieval-trace.counterfactualReplay 正交，不改既有 API）：
 *   - 输入：任意门（GateKey）+ 基线裁定（pass/fail/skipped）+ 候选剔除集
 *     （每个候选携带剔除后的裁定——由调用方以冻结快照/重放求值）；
 *   - 判定：剔除后裁定 ≠ 基线 → 决定性（decisive）；= 基线 → 非决定性；
 *   - 结果事件 kind=stage（payload.counterfactual 显式标记 + evidenceRefs
 *     逐候选可点开）——反事实重放是分析证据，非三门运行（不用 gate-run）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © QMAI
 */

import type { GateKey } from "./audit-taxonomy"
import type { RunEventAppendInput } from "./run-event-ledger-store"

/** 反事实重放输入（任意门）。 */
export interface CounterfactualGateReplayInput {
  readonly gate: GateKey
  /** 基线裁定（未剔除任何证据时的门裁定）。 */
  readonly baselineVerdict: "pass" | "fail" | "skipped"
  /** 候选剔除集：剔除 removedSourceId 后调用方求得的裁定。 */
  readonly candidates: readonly { readonly removedSourceId: string; readonly verdictAfterRemoval: "pass" | "fail" | "skipped" }[]
}

/** 反事实重放结果（决定性证据集）。 */
export interface CounterfactualGateReplayResult {
  readonly gate: GateKey
  readonly baselineVerdict: "pass" | "fail" | "skipped"
  /** 剔除后裁定翻转 → 决定性（该证据对门裁定有决定性影响）。 */
  readonly decisiveSourceIds: readonly string[]
  /** 剔除后裁定不变 → 非决定性。 */
  readonly nonDecisiveSourceIds: readonly string[]
}

/**
 * 通用反事实重放（任意门；纯函数）：与 retrieval-trace 的 P0 专用版同法，
 * 但 gate/verdict 参数化。
 */
export function replayCounterfactual(input: CounterfactualGateReplayInput): CounterfactualGateReplayResult {
  const decisive: string[] = []
  const nonDecisive: string[] = []
  for (const candidate of input.candidates) {
    if (candidate.verdictAfterRemoval !== input.baselineVerdict) decisive.push(candidate.removedSourceId)
    else nonDecisive.push(candidate.removedSourceId)
  }
  return { gate: input.gate, baselineVerdict: input.baselineVerdict, decisiveSourceIds: decisive, nonDecisiveSourceIds: nonDecisive }
}

/**
 * 反事实重放结果事件输入（kind=stage + payload.counterfactual；逐候选
 * evidenceRefs 可点开）。
 */
export function counterfactualGateEvents(input: {
  readonly result: CounterfactualGateReplayResult
  readonly ts: string
  readonly replayId: string
  readonly bookId?: string
  readonly chapterId?: number
}): RunEventAppendInput[] {
  if (input.ts.length === 0) throw new CounterfactualLabError("ts 为空：事件落账前必须注入时间戳（零时钟纪律）")
  if (input.replayId.length === 0) throw new CounterfactualLabError("replayId 为空：反事实重放必须携带重放标识（可追溯）")
  const evidenceRefs = [
    ...input.result.decisiveSourceIds.map((id) => `counterfactual:${input.result.gate}:decisive:${id}`),
    ...input.result.nonDecisiveSourceIds.map((id) => `counterfactual:${input.result.gate}:non-decisive:${id}`),
  ]
  return [
    {
      ts: input.ts,
      kind: "stage" as const,
      actor: "system" as const,
      replayId: input.replayId,
      bookId: input.bookId,
      chapterId: input.chapterId,
      evidenceRefs,
      payload: {
        counterfactual: {
          gate: input.result.gate,
          baselineVerdict: input.result.baselineVerdict,
          decisiveSourceIds: input.result.decisiveSourceIds,
          nonDecisiveSourceIds: input.result.nonDecisiveSourceIds,
        },
      },
    },
  ]
}

/** 反事实实验台错误。 */
export class CounterfactualLabError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CounterfactualLabError"
  }
}