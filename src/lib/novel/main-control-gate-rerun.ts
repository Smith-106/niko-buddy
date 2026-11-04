// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 主控「重跑门控」动作（F1b）：把一份待采纳草稿重新过一遍三门。
 *
 * ## 只编排，不判定
 * 判定唯一真源是 `buildDecisionGates`（deep-chapter-decision-gates.ts:106），编排唯一
 * 入口是 `evaluateChapterGates`（chapter-gate-evaluation.ts）。本模块**不含任何
 * severity/verdict/status 分支**，只做三件机械事：
 * 1. 读草稿正文（`listChapterDrafts`，与采纳路径同一份草稿真源）；
 * 2. 备料：contextPack（D4=C 复用）→ 确定性 fallback 任务书（`buildFallbackTaskBrief`，
 *    自带 `【章节契约】` 段，使契约维度真的参与判定，而不是空串短路）；
 * 3. 把 `DeepChapterDecisionGates` 翻译成渲染行（门 → pass/fail/skipped），
 *    pending 走 `mapDecisionGateToRunStatus` 落 skipped（与 gate-run 证据同源）。
 *
 * ## 为什么任务书用 fallback 构造
 * 主控没有阶段 2 的任务书；空串会让契约核对整段短路，用户就会看到「门控通过」而
 * 实际少了契约维度（假通过）。`buildFallbackTaskBrief` 是深章流水线自己用的确定性
 * 兜底（deep-chapter-context-assembly.ts:452），此处复用同一函数，不另写一份任务书。
 *
 * ## 结论落账（F1b 收口）+ 回读（B9）
 * 重跑结论不能只活在组件 useState（页签一切就蒸发），必须与深章 gate evidence
 * 同一本账：本模块在算完 `decisionGates` 后调 `recordChapterGateEvidence`（带
 * `intent:main-control-rerun`）。写入是**非致命**的（证据可重放，不阻断复核）。
 * 返回的 `evidenceRecorded` / `evidenceError` / `evidenceTs` 供渲染层报「已落账 /
 * 落账失败」并区分「本次运行」与账本回读的「历史记录」；回读本身由组件挂载时调
 * `readLatestGateRunGroup(ledger, { intent: MAIN_CONTROL_RERUN_INTENT })`（页签切回来仍有结论）。
 * 但草稿复核不得污染首页三门权威口径——所有读账本算结论的消费方
 * 经 `isAuthoritativeGateRun` 排除该意图（见 gate-run-authority.ts）。
 */

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { buildContextPack, type ContextPack } from "./context-engine"
import { extractChapterNumber } from "./chapter-utils"
import { resolveChapterLengthSpec } from "./deep-chapter-prompts"
import { buildFallbackTaskBrief } from "./deep-chapter-task-brief"
import {
  MAIN_CONTROL_RERUN_INTENT,
  mapDecisionGateToRunStatus,
  recordChapterGateEvidence,
} from "./deep-chapter-gate-evidence"
import type { DeepChapterDecisionGateKey, DeepChapterGateVerdict } from "./deep-chapter-decision-gates"
import type { GateRunStatus } from "./rule-stack"
import { listChapterDrafts } from "./draft-manager"
import {
  evaluateChapterGates,
  type EvaluateChapterGatesInput,
  type EvaluateChapterGatesResult,
} from "./chapter-gate-evaluation"

/** 三门顺序固定（Consistency P0 > Anti-AI P1 > Quality P2）。 */
const GATE_KEYS: readonly DeepChapterDecisionGateKey[] = ["consistency", "anti_ai", "quality"]

export interface MainControlGateRow {
  key: DeepChapterDecisionGateKey
  /** pass / fail / skipped —— skipped = 未评估，绝不呈现为通过。 */
  status: GateRunStatus
  verdict: DeepChapterGateVerdict
  findings: number
}

export interface RerunMainControlGatesInput {
  projectPath: string
  /** 待复核的草稿 ID（草稿真源 = `<project>/.drafts/<id>.md`）。 */
  draftId: string
  /** 用户目标（只用于 fallback 任务书的「原始请求对齐」行，不参与判定）。 */
  goal?: string
  genre?: string
  novelConfig: NovelConfig
  llmConfig?: LlmConfig
  signal?: AbortSignal
}

export interface RerunMainControlGatesResult {
  draftId: string
  chapterNumber?: number
  rows: MainControlGateRow[]
  overall: DeepChapterGateVerdict
  /** 契约维度是否真的参与（false ⇒ 渲染「未评估」，不得渲染通过）。 */
  contractEvaluated: boolean
  llmMediated: boolean
  reviewParseFailed?: boolean
  unassessedDimensions: string[]
  /** 已落账的门（非致命：失败时仍返回结论，只是不可回读）。 */
  evidenceRecorded?: readonly DeepChapterDecisionGateKey[]
  /** 落账失败原因（非致命；undefined = 成功）。 */
  evidenceError?: string
  /** 落账批次的 ts（与账本回读的 history.ts 对账即可判定「本次 vs 历史」）。 */
  evidenceTs?: string
}

export interface RerunMainControlGatesDeps {
  /** 测试注入点；生产恒为 `listChapterDrafts`。 */
  listDrafts?: typeof listChapterDrafts
  /** 测试注入点；生产恒为 `evaluateChapterGates`。 */
  evaluateGates?: typeof evaluateChapterGates
  /** 测试注入点；生产恒为 `buildContextPack`。 */
  buildPack?: typeof buildContextPack
  /** 测试注入点；生产恒为 `buildFallbackTaskBrief`。 */
  buildTaskBrief?: typeof buildFallbackTaskBrief
  /** 测试注入点；生产恒为 `recordChapterGateEvidence`（结论落账，防「页签一切就蒸发」）。 */
  recordEvidence?: typeof recordChapterGateEvidence
}

/** 把门控结果翻译成渲染行（pending → skipped，与 gate-run 证据同一映射）。 */
export function buildMainControlGateRows(
  evaluation: Pick<EvaluateChapterGatesResult, "decisionGates">,
): MainControlGateRow[] {
  return GATE_KEYS.map((key) => {
    const gate = evaluation.decisionGates[key]
    return {
      key,
      status: mapDecisionGateToRunStatus(gate.status),
      verdict: gate.verdict,
      findings: gate.findings.length,
    }
  })
}

/**
 * 重跑一份草稿的门控。
 *
 * 草稿不存在/读不出时抛错（调用方按「门控重跑失败」呈现，不静默显示「通过」）。
 */
export async function rerunMainControlGates(
  input: RerunMainControlGatesInput,
  deps: RerunMainControlGatesDeps = {},
): Promise<RerunMainControlGatesResult> {
  const listDrafts = deps.listDrafts ?? listChapterDrafts
  const evaluateGates = deps.evaluateGates ?? evaluateChapterGates
  const buildPack = deps.buildPack ?? buildContextPack
  const buildTaskBrief = deps.buildTaskBrief ?? buildFallbackTaskBrief
  const recordEvidence = deps.recordEvidence ?? recordChapterGateEvidence

  const drafts = await listDrafts(input.projectPath)
  const draft = drafts.find((item) => item.id === input.draftId)
  if (!draft) throw new Error("找不到草稿")
  const chapterContent = draft.content
  if (!chapterContent.trim()) throw new Error("草稿没有正文")

  const chapterNumber = extractChapterNumber(draft.chapterName) ?? undefined
  // D4=C：本动作自己构建 contextPack（任务书备料需要它），因此交给 evaluateChapterGates 复用，
  // 不再二次排队构建。
  const contextPack: ContextPack = await buildPack(
    input.projectPath,
    chapterContent.slice(0, 80),
    chapterNumber,
  )
  const taskBrief = buildTaskBrief(
    contextPack,
    input.goal?.trim() || draft.chapterName,
    chapterNumber,
    resolveChapterLengthSpec(input.novelConfig.chapterTargetChars),
  )

  const evaluationInput: EvaluateChapterGatesInput = {
    projectPath: input.projectPath,
    chapterContent,
    chapterNumber,
    genre: input.genre ?? input.novelConfig.genre,
    llmConfig: input.llmConfig,
    novelConfig: input.novelConfig,
    contextPack,
    taskBrief,
    retryCount: 0,
    signal: input.signal,
  }
  const evaluation = await evaluateGates(evaluationInput)
  const rows = buildMainControlGateRows(evaluation)

  // 结论落账：与深章 gate-run 同一账本，带 `intent:main-control-rerun` 标记。
  // 非致命：落账失败不影响复核结论（正文与判定都不依赖账本）。
  const evidence = await recordEvidence({
    projectPath: input.projectPath,
    decisionGates: evaluation.decisionGates,
    chapterNumber,
    llmMediated: evaluation.llmMediated,
    retryCount: 0,
    intent: MAIN_CONTROL_RERUN_INTENT,
  })

  return {
    draftId: input.draftId,
    chapterNumber,
    rows,
    overall: evaluation.decisionGates.overall,
    contractEvaluated: evaluation.contractEvaluated,
    llmMediated: evaluation.llmMediated,
    reviewParseFailed: evaluation.reviewParseFailed,
    unassessedDimensions: evaluation.unassessedDimensions,
    evidenceRecorded: evidence.recorded,
    evidenceError: evidence.error,
    evidenceTs: evidence.ts,
  }
}
