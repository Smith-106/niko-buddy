// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 章节门控重跑（薄编排）：审稿 → 契约校验 → 三门。
 *
 * 与管线内唯一编排形状（deep-chapter-review-repair.ts:210-213）逐字一致：
 * `runFullReviewWithSixDim` → `applyChapterContractCheck` → `buildDecisionGates`。
 *
 * 纪律：
 * - 三门判定的唯一真源是 `buildDecisionGates`（deep-chapter-decision-gates.ts:106）——
 *   本模块**只编排不判定**，不得出现任何 severity/verdict/status 分支；
 * - 依赖用 deep-chapter-generation 的同一份默认 deps（DEFAULT_DEEP_CHAPTER_DEPS），
 *   不另拼第二份，避免注入漂移；
 * - D4=C：调用方持有本次运行的 contextPack 时直接复用；缺失才现场 `buildContextPack`
 *   （该函数有互斥串行队列，可能排队，UI 必须提示耗时）。
 *
 * ## 输入必须由调用方给全（否则会出现「假通过」）
 *
 * `taskBrief` 与 `retryCount` 都是可选参数，但**默认值刻意不代表「已评估」**：
 * - `taskBrief` 缺省空串 ⇒ `parseChapterContractSection("")` 返回 null ⇒
 *   `applyChapterContractCheck` 原样返回 reviewResults
 *   （deep-chapter-runtime-support.ts:260-261），即「无任务书 ⇒ 不做章节契约核对」。
 *   此时结果里 `contractEvaluated=false` 且 `unassessedDimensions` 含
 *   `chapter_contract`，调用方必须按「未评估」呈现，不得渲染成通过。
 * - `retryCount` 缺省 0 只对首审/重跑成立；阶段 4 之后的复审必须传真实轮次。
 *
 * 未评估一律落 skipped 不落 pass（与 deep-chapter-gate-evidence.ts:17-21 既有约定
 * `mapDecisionGateToRunStatus` 同源）：AI 审稿被设置关闭、或审稿输出不可解析时，
 * 三门返回 `emptyDecisionGates()`（status=pending ⇒ skipped），绝不返回「全通过」。
 */

import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { buildContextPack, type ContextPack } from "./context-engine"
import { DEFAULT_DEEP_CHAPTER_DEPS } from "./deep-chapter-generation"
import { runFullReviewWithSixDim } from "./deep-chapter-review"
import { applyChapterContractCheck } from "./deep-chapter-runtime-support"
import {
  buildDecisionGates,
  emptyDecisionGates,
  type DeepChapterDecisionGateKey,
  type DeepChapterDecisionGates,
} from "./deep-chapter-decision-gates"
import { parseChapterContractSection } from "./deep-chapter-task-brief"
import { resolveDeAiGenre } from "./genre-codes"
import type { NovelReviewResult } from "./review-adapter"

/** 三门顺序固定（Consistency P0 > Anti-AI P1 > Quality P2）。 */
const GATE_KEYS: readonly DeepChapterDecisionGateKey[] = ["consistency", "anti_ai", "quality"]

/** 契约维度未参与判定时的维度标签（渲染/证据层按「未评估」呈现）。 */
export const UNASSESSED_DIMENSION_CHAPTER_CONTRACT = "chapter_contract"
/** AI 审稿未参与判定（设置关闭或输出不可解析）时的维度标签。 */
export const UNASSESSED_DIMENSION_AI_REVIEW = "ai_review"

export interface EvaluateChapterGatesInput {
  projectPath: string
  chapterContent: string
  chapterNumber?: number
  genre?: string
  llmConfig?: LlmConfig
  novelConfig?: NovelConfig
  /** 本次运行已持有的 contextPack（D4=C：优先复用，缺失才现场构建）。 */
  contextPack?: ContextPack
  /**
   * 任务书原文（阶段 2 产出）。**只有含 `【章节契约】` 段才做章节契约核对**；
   * 缺省空串 = 不做（结果里 contractEvaluated=false，不得当成通过）。
   */
  taskBrief?: string
  /** 修复轮次（阶段 4 之后的复审传真实轮次；首审/重跑缺省 0）。 */
  retryCount?: number
  signal?: AbortSignal
  onThinking?: (text: string) => void
}

export interface EvaluateChapterGatesResult {
  reviewResults: NovelReviewResult[]
  decisionGates: DeepChapterDecisionGates
  reviewParseFailed?: boolean
  /** AI 审稿是否真的参与（novelConfig.deepChapterReview === false 时为 false）。 */
  llmMediated: boolean
  /** 章节契约维度是否真的参与判定（taskBrief 含契约段才 true）。 */
  contractEvaluated: boolean
  /**
   * 未参与判定的门（空数组 = 三门都已评估）。这些门在 decisionGates 里是
   * `pending`，按 `mapDecisionGateToRunStatus` 落 skipped，绝不落 pass。
   */
  unassessedGates: DeepChapterDecisionGateKey[]
  /** 未参与判定的维度（比门更细：契约维度、AI 审稿维度）。 */
  unassessedDimensions: string[]
}

/**
 * 重跑一次章节门控（零判定，纯编排）。
 *
 * 返回的 decisionGates 与该 fixture 手工调用 `buildDecisionGates` 逐字段相同（R-05）。
 */
export async function evaluateChapterGates(
  input: EvaluateChapterGatesInput,
): Promise<EvaluateChapterGatesResult> {
  const chapterNumber = input.chapterNumber
  const taskBrief = input.taskBrief ?? ""
  const retryCount = input.retryCount ?? 0
  const contractEvaluated = parseChapterContractSection(taskBrief) !== null
  const unassessedDimensions: string[] = contractEvaluated ? [] : [UNASSESSED_DIMENSION_CHAPTER_CONTRACT]
  const llmMediated = input.novelConfig?.deepChapterReview !== false

  // 与管线同形（deep-chapter-review-repair.ts:196）：AI 审稿关闭时三门保持未评估，
  // 绝不把「没审」渲染成「通过」。
  if (!llmMediated) {
    return {
      reviewResults: [],
      decisionGates: emptyDecisionGates(),
      llmMediated: false,
      contractEvaluated,
      unassessedGates: [...GATE_KEYS],
      unassessedDimensions: [...unassessedDimensions, UNASSESSED_DIMENSION_AI_REVIEW],
    }
  }

  const contextPack =
    input.contextPack ?? (await buildContextPack(input.projectPath, input.chapterContent.slice(0, 80), chapterNumber))

  const stage = await runFullReviewWithSixDim(
    input.chapterContent,
    chapterNumber,
    input.projectPath,
    DEFAULT_DEEP_CHAPTER_DEPS,
    input.signal,
    contextPack,
    { onThinking: input.onThinking },
  )

  // 审稿输出不可解析 ⇒ 三门没有任何依据（48 号报告 §六-⑥ 同一降级语义）：
  // 落空门（pending → skipped），不落 pass。
  if (stage.reviewParseFailed === true) {
    return {
      reviewResults: stage.reviewResults,
      decisionGates: emptyDecisionGates(),
      reviewParseFailed: true,
      llmMediated: true,
      contractEvaluated,
      unassessedGates: [...GATE_KEYS],
      unassessedDimensions: [...unassessedDimensions, UNASSESSED_DIMENSION_AI_REVIEW],
    }
  }

  const reviewResults = applyChapterContractCheck(taskBrief, input.chapterContent, stage.reviewResults)
  const decisionGates = buildDecisionGates(reviewResults, retryCount, undefined, resolveDeAiGenre(input.genre))

  return {
    reviewResults,
    decisionGates,
    reviewParseFailed: stage.reviewParseFailed,
    llmMediated,
    contractEvaluated,
    unassessedGates: [],
    unassessedDimensions,
  }
}
