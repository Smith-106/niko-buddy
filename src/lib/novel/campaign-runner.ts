// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 预演式批量战役调度器 (Autonomous Draft Campaign Runner)
 *
 * 核心设计目标：
 * 1. 自动化跨章推进：支持长程批量自主写作任务（如连写第 N 到第 N+K 章），
 *    自动串联上下文装配、分章计划、正文起草与三级门控自愈回路。
 * 2. 严格守卫 Draft-first 安全边界：
 *    - 战役运行期间所有产出物皆保存在内存沙箱与独立草稿态（pending/ready）中，
 *      未经作者明确 Accept 前禁止向正式目录（wiki/chapters/*.md）覆盖写入 final 态，
 *      禁止向底层的正式 Canon 事实库直接落盘，杜绝级联幻觉与知识库污染。
 * 3. 动态前情传递：
 *    - 当连续生成第 M+1 章时，自动将前序在沙箱中生成的第 M 章作为连续性参考输入，
 *      保证多章批量生成时的叙事、人物性格与情节因果高度连贯。
 * 4. 批量验收晋升：
 *    - 提供 batchAcceptCampaignDrafts 事务化批量提交接口，经作者统一审阅后一键
 *      落盘正式正文，并顺序触发章节摄取与事实双写。
 */

import type { LlmConfig } from "@/stores/wiki-store"
import { DEFAULT_NOVEL_CONFIG, type NovelConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { createDirectory, writeFileAtomic } from "@/commands/fs"

function countWords(text: string): number {
  return text.replace(/\s/g, "").length
}
import {
  runDeepChapterGeneration,
  type DeepChapterDecisionGates,
} from "./deep-chapter-generation"
import type { NovelReviewResult } from "./review-adapter"
import { updateChapterStatus } from "./chapter-meta"

export interface CampaignChapterResult {
  chapterNumber: number
  title?: string
  content: string
  taskBrief: string
  draftContent: string
  decisionGates?: DeepChapterDecisionGates
  reviewResults: NovelReviewResult[]
  revised: boolean
  wordCount: number
  status: "ready" | "failed" | "blocked" | "partial"
  error?: string
  /** 全自动巡航模式下是否已自动提交晋升正式章节 */
  autoAccepted?: boolean
}

export interface CampaignRunOptions {
  projectPath: string
  /** 起始章节号 (1-based) */
  startChapter: number
  /** 本次战役连续生成章数 */
  chapterCount: number
  llmConfig: LlmConfig
  novelConfig?: NovelConfig
  /**
   * 全自动巡航推进模式 (Autonomous Cruise Mode)
   * 当为 true 时，单章经过三级门控自愈全绿通过（status === "ready" 且无阻断缺陷）后，
   * 系统将自动原地正式提交该章并执行事实库摄取与双写，
   * 随后无缝读取最新事实库继续推进下一章；
   * 若某章发生阻断（blocked 或 failed），巡航自动安全挂起待人工介入。
   */
  cruiseMode?: boolean
  /** 自定义每章任务指令生成器，若未提供则根据默认模式自动生成任务请求 */
  buildChapterRequest?: (chapterNumber: number) => string | Promise<string>
  /** 每章开始时的回调 */
  onChapterStart?: (chapterNumber: number, current: number, total: number) => void
  /** 每章完成时的回调 */
  onChapterComplete?: (chapterNumber: number, result: CampaignChapterResult) => void
  /** 整体进度或状态更新回调 */
  onProgress?: (info: { stage: string; current: number; total: number; message: string }) => void
  signal?: AbortSignal
}

export interface CampaignReport {
  projectPath: string
  startChapter: number
  endChapter: number
  totalChapters: number
  completedChapters: number
  totalWords: number
  startTime: string
  endTime: string
  results: CampaignChapterResult[]
  summary: {
    allPassed: boolean
    readyCount: number
    failedCount: number
  }
}

export interface BatchAcceptResult {
  acceptedCount: number
  chapterPaths: string[]
  ingestedCount: number
}

/**
 * 启动预演式批量战役调度
 */
export async function runAutonomousDraftCampaign(
  options: CampaignRunOptions,
): Promise<CampaignReport> {
  const {
    projectPath,
    startChapter,
    chapterCount,
    llmConfig,
    novelConfig = DEFAULT_NOVEL_CONFIG,
    cruiseMode = false,
    buildChapterRequest,
    onChapterStart,
    onChapterComplete,
    onProgress,
    signal,
  } = options

  const pp = normalizePath(projectPath)
  const startTime = new Date().toISOString()
  const results: CampaignChapterResult[] = []
  let totalWords = 0
  let previousDraftSummary = ""

  const total = Math.max(1, chapterCount)
  const endChapter = startChapter + total - 1

  for (let idx = 0; idx < total; idx++) {
    if (signal?.aborted) {
      throw new Error("批量战役已被用户取消")
    }

    const currentChapterNum = startChapter + idx
    onChapterStart?.(currentChapterNum, idx + 1, total)
    onProgress?.({
      stage: "generating",
      current: idx + 1,
      total,
      message: `正在调度生成第 ${currentChapterNum} 章 (${idx + 1}/${total})...`,
    })

    // 构建该章节的用户提示词
    let userRequest: string
    if (buildChapterRequest) {
      userRequest = await buildChapterRequest(currentChapterNum)
    } else {
      userRequest = `请撰写第 ${currentChapterNum} 章正文。`
    }

    // 若有前序沙箱草稿，注入连续性承接指令
    let dismantlingDirective: string | undefined
    if (previousDraftSummary) {
      dismantlingDirective = `【前序连贯性前情承接】上一章正文概要/选段：\n${previousDraftSummary.slice(0, 1500)}`
    }

    try {
      const genResult = await runDeepChapterGeneration(
        {
          projectPath: pp,
          userRequest,
          chapterNumber: currentChapterNum,
          llmConfig,
          novelConfig,
          dismantlingReferenceDirective: dismantlingDirective,
        },
        {
          onThinking: (thinking) => {
            onProgress?.({
              stage: "thinking",
              current: idx + 1,
              total,
              message: `[第 ${currentChapterNum} 章] ${thinking.slice(0, 80)}`,
            })
          },
        },
        undefined,
        signal,
      )

      const finalTxt = genResult.finalContent.trim()
      const words = countWords(finalTxt)
      totalWords += words

      const status: "ready" | "failed" | "blocked" | "partial" = genResult.manualReviewRequired
        ? "blocked"
        : genResult.partial
          ? "partial"
          : "ready"

      let isAutoAccepted = false
      // 全自动巡航推进：门控全绿时自动原地提交晋升正式章节，并自动摄取事实库
      if (cruiseMode && status === "ready" && finalTxt.length > 0) {
        onProgress?.({
          stage: "auto-accepting",
          current: idx + 1,
          total,
          message: `[第 ${currentChapterNum} 章] 门控全绿，全自动巡航正在提交晋升并摄取事实库...`,
        })
        try {
          const acceptRes = await batchAcceptCampaignDrafts(
            pp,
            [
              {
                chapterNumber: currentChapterNum,
                content: finalTxt,
                taskBrief: genResult.taskBrief,
                draftContent: genResult.draftContent,
                reviewResults: genResult.reviewResults,
                revised: genResult.revised,
                wordCount: words,
                status: "ready",
              },
            ],
            {
              autoIngest: true,
              llmConfig,
            },
          )
          isAutoAccepted = acceptRes.acceptedCount > 0
        } catch (acceptErr) {
          console.warn(`[campaign-runner] 第 ${currentChapterNum} 章全自动巡航晋升失败:`, acceptErr)
        }
      }

      const chapterResult: CampaignChapterResult = {
        chapterNumber: currentChapterNum,
        content: finalTxt,
        taskBrief: genResult.taskBrief,
        draftContent: genResult.draftContent,
        decisionGates: genResult.decisionGates,
        reviewResults: genResult.reviewResults,
        revised: genResult.revised,
        wordCount: words,
        status,
        autoAccepted: isAutoAccepted,
      }

      results.push(chapterResult)
      onChapterComplete?.(currentChapterNum, chapterResult)

      // 巡航安全守护：若在全自动巡航模式下遇到未通过（blocked / partial），立即安全挂起后续推进
      if (cruiseMode && status !== "ready") {
        onProgress?.({
          stage: "cruise-paused",
          current: idx + 1,
          total,
          message: `[第 ${currentChapterNum} 章] 门控未通过(${status})，全自动巡航已安全挂起并等待人工审阅。`,
        })
        break
      }

      // 更新前情记忆给下一章沙箱消费
      previousDraftSummary = finalTxt.slice(-2000)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const failedResult: CampaignChapterResult = {
        chapterNumber: currentChapterNum,
        content: "",
        taskBrief: "",
        draftContent: "",
        reviewResults: [],
        revised: false,
        wordCount: 0,
        status: "failed",
        error: errorMsg,
      }
      results.push(failedResult)
      onChapterComplete?.(currentChapterNum, failedResult)
      // 若出现不可恢复的异常（例如用户手动中断或巡航遇到系统错误），跳出
      if (signal?.aborted || cruiseMode) break
    }
  }

  const endTime = new Date().toISOString()
  const readyCount = results.filter((r) => r.status === "ready").length
  const failedCount = results.filter((r) => r.status === "failed" || r.status === "blocked").length

  return {
    projectPath: pp,
    startChapter,
    endChapter,
    totalChapters: total,
    completedChapters: results.length,
    totalWords,
    startTime,
    endTime,
    results,
    summary: {
      allPassed: failedCount === 0 && readyCount === total,
      readyCount,
      failedCount,
    },
  }
}

/**
 * 批量验收晋升：将通过的战役草稿一键提交为正式章节
 */
export async function batchAcceptCampaignDrafts(
  projectPath: string,
  chapterResults: CampaignChapterResult[],
  options?: {
    /** 自动执行章节事实摄取 */
    autoIngest?: boolean
    llmConfig?: LlmConfig
    onProgress?: (current: number, total: number, path: string) => void
  },
): Promise<BatchAcceptResult> {
  const pp = normalizePath(projectPath)
  const chapterDir = `${pp}/wiki/chapters`
  await createDirectory(chapterDir)

  const chapterPaths: string[] = []
  let ingestedCount = 0

  // 仅提交非空且未失败的章节草稿
  const validChapters = chapterResults.filter((c) => c.status === "ready" && c.content.trim().length > 0)
  const total = validChapters.length

  for (let i = 0; i < total; i++) {
    const ch = validChapters[i]
    const chapterNum = ch.chapterNumber
    const fileName = `chapter-${String(chapterNum).padStart(3, "0")}.md`
    const filePath = `${chapterDir}/${fileName}`

    options?.onProgress?.(i + 1, total, filePath)

    const dateStr = new Date().toISOString().split("T")[0]
    const title = ch.title || `第${chapterNum}章`

    const rawChapterContent = [
      "---",
      "type: chapter",
      `chapter_number: ${chapterNum}`,
      "chapter_status: draft",
      `title: "${title.replace(/"/g, '\\"')}"`,
      "source: autonomous-campaign",
      `created: ${dateStr}`,
      "---",
      "",
      `# ${title}`,
      "",
      ch.content,
      "",
    ].join("\n")

    // 晋升为 final 正式章节态
    const finalContent = updateChapterStatus(rawChapterContent, "final")
    await writeFileAtomic(filePath, finalContent)
    chapterPaths.push(filePath)
  }

  // 顺序执行事实摄取与双写
  if (options?.autoIngest && options?.llmConfig && chapterPaths.length > 0) {
    try {
      const [{ ingestChapter }, { defaultCanonDualWriteDeps }] = await Promise.all([
        import("./chapter-ingest"),
        import("./canon-dual-write"),
      ])
      for (const chPath of chapterPaths) {
        try {
          await ingestChapter(pp, chPath, options.llmConfig?.model ?? "default", undefined, {
            canonDualWriteDeps: defaultCanonDualWriteDeps(),
          })
          ingestedCount++
        } catch (e) {
          console.warn(`[campaign-batch-accept] 摄取 ${chPath} 异常:`, e)
        }
      }
    } catch (e) {
      console.warn("[campaign-batch-accept] 加载摄取模块失败:", e)
    }
  }

  return {
    acceptedCount: validChapters.length,
    chapterPaths,
    ingestedCount,
  }
}
