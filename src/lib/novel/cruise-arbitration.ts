// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * cruise-arbitration.ts — G3 仲裁回路类型层（契约 + 纯函数）。
 *
 * 背景：campaign-runner 的 cruise-paused 目前死挂起 break，
 * “抛回主控 AI 改 task_brief 重发”的契约先在此定死。
 *
 * 本模块只定契约 + 纯函数，不碰 runner 主循环：
 * - buildArbitrationRequest：CampaignChapterResult → ArbitrationRequest（只读投影）
 * - applyArbitrationDirective：(request, directive) → 下一跳 { taskBrief, chapterNumber }
 *
 * 机械层：纯函数，零 IO / 零时钟 / 零模型调用。
 */

import type { CampaignChapterResult } from "./campaign-runner"
import type { DeepChapterDecisionGates } from "./deep-chapter-generation"

/** 抛回主控 AI 的仲裁请求（仅 blocked / partial / failed 需要仲裁）。 */
export interface ArbitrationRequest {
  chapterNumber: number
  status: "blocked" | "partial" | "failed"
  taskBrief: string
  draftContent?: string
  decisionGates?: DeepChapterDecisionGates
  error?: string
}

/** 主控 AI 回复的仲裁指令。 */
export interface ArbitrationDirective {
  action: "retry-rebrief" | "skip-chapter" | "abort-campaign"
  revisedBrief?: string
  reason: string
}

/**
 * 构造仲裁请求（纯函数）：只读投影，不突变入参。
 *
 * @throws status === "ready" 时抛错——全绿章节无需仲裁。
 */
export function buildArbitrationRequest(chapter: CampaignChapterResult): ArbitrationRequest {
  if (chapter.status === "ready") {
    throw new Error(`第 ${chapter.chapterNumber} 章已 ready，无需仲裁`)
  }
  const request: ArbitrationRequest = {
    chapterNumber: chapter.chapterNumber,
    status: chapter.status,
    taskBrief: chapter.taskBrief,
  }
  if (chapter.draftContent.length > 0) {
    request.draftContent = chapter.draftContent
  }
  if (chapter.decisionGates !== undefined) {
    request.decisionGates = chapter.decisionGates
  }
  if (chapter.error !== undefined) {
    request.error = chapter.error
  }
  return request
}

/**
 * 落子仲裁指令（纯函数）：
 * - retry-rebrief：用 directive.revisedBrief 替换 taskBrief；
 * - skip-chapter / abort-campaign：原样返回 request 的 taskBrief。
 *
 * @throws retry-rebrief 但 revisedBrief 缺失/空白时抛错——契约要求必须给新 brief。
 */
export function applyArbitrationDirective(
  request: ArbitrationRequest,
  directive: ArbitrationDirective,
): { taskBrief: string; chapterNumber: number } {
  if (directive.action === "retry-rebrief") {
    const raw = directive.revisedBrief ?? ""
    if (raw.trim().length === 0) {
      throw new Error(`第 ${request.chapterNumber} 章 retry-rebrief 缺少 revisedBrief`)
    }
    return { taskBrief: raw, chapterNumber: request.chapterNumber }
  }
  return { taskBrief: request.taskBrief, chapterNumber: request.chapterNumber }
}
