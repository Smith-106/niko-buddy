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
 *    - DF-1: 战役路径不经过聊天会话生命周期，验收前必须先注册（复用）受管草稿
 *      （ready），accept 的 Draft-first 校验才成立；晋升失败必须如实失败
 *      （不降级直写正式正文、不计入 acceptedCount），acceptedCount 只统计
 *      真源落接受态的章节。
 */

import type { LlmConfig } from "@/stores/wiki-store"
import { DEFAULT_NOVEL_CONFIG, type NovelConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { createDirectory, writeFileAtomic } from "@/commands/fs"

function countWords(text: string): number {
  return text.replace(/\s/g, "").length
}
import { buildCarryoverContext } from "./campaign-memory"
// B2 弧结算可观测（P1-6）：纯函数 import，失败不阻断（模块无 IO）。
import { shouldTriggerArcSettlement } from "./arc-settlement"
import {
  assembleChapterRequest,
  buildBaseRequest,
  buildCharacterConstraint,
  buildInterviewAnchor,
  buildPovConstraint,
  buildStageHint,
  enrichWithEventPool,
} from "./chapter-request-builder"
import { listBindableNovelCharacters } from "./bindable-characters"
import { loadBinding } from "./story-simulation/framework-binding"
import {
  runDeepChapterGeneration,
  type DeepChapterDecisionGates,
} from "./deep-chapter-generation"
import type { NovelReviewResult } from "./review-adapter"
import {
  buildArbitrationRequest,
  type ArbitrationDirective,
  type ArbitrationRequest,
} from "./cruise-arbitration"
import { decidePausedChapter, type PausedChapterDecision } from "./cruise-wiring"
import { updateChapterStatus } from "./chapter-meta"
import { commitAcceptedDeepChapterDraft } from "./formal-writeback"

/**
 * M2 巡航满血预设：缺省 novelConfig 时默认开启场景拆解（sceneBreakdownEnabled），
 * 群戏/多线结构密度提升；显式传入的 novelConfig 仍优先，零破坏。
 * 大纲多智能体编排接线位：见 autonomous-incubator 大纲阶段 TODO（重型一次性任务，暂不自动触发）。
 */
export const CRUISE_FULL_CONFIG: NovelConfig = {
  ...DEFAULT_NOVEL_CONFIG,
  sceneBreakdownEnabled: true,
}

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
  /**
   * F3 仲裁跳章标记：经 arbitrationProvider 返回 skip-chapter 指令后置 true，
   * 原 blocked/partial 现场保留备查，战役继续推进下一章。缺省 undefined。
   */
  skipped?: boolean
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
  /**
   * F3 仲裁执行闭环：cruise-paused 分支的仲裁指令提供者。
   * 缺省 undefined → 保持现有 paused 行为（安全挂起待人工介入）；
   * 返回 null 亦视为无指令，走现有 paused 行为。
   */
  arbitrationProvider?: (req: ArbitrationRequest) => Promise<ArbitrationDirective | null>
  /** 自定义每章任务指令生成器，若未提供则根据默认模式自动生成任务请求 */
  buildChapterRequest?: (chapterNumber: number) => string | Promise<string>
  /**
   * 事件池动态注入开关（E2 成本闸）：默认关闭零成本；开启后默认分支每章多 1 次
   * LLM 调用生成事件候选，失败自动直通不断巡航。
   */
  enableEventPool?: boolean
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
 * H1 晋升收拢：可验收过滤纯函数。
 * 仅保留门控全绿（status === "ready"）且正文非空的章节草稿，其余（failed/blocked/partial/空白）一律跳过。
 */
export function filterAcceptableChapters(
  chapterResults: CampaignChapterResult[],
): CampaignChapterResult[] {
  return chapterResults.filter((c) => c.status === "ready" && c.content.trim().length > 0)
}

/**
 * F2 零成本视点提取（尽力而为纯读）：从框架绑定对象上探测视点人物声明。
 * FrameworkBinding 标准形态无视点字段，未声明时返回 null（绝不臆造 POV）。
 */
function extractBindingPovName(binding: unknown): string | null {
  if (typeof binding !== "object" || binding === null) return null
  const rec = binding as unknown as Record<string, unknown>
  const candidates: unknown[] = [
    rec["povCharacter"],
    rec["pov"],
    rec["povName"],
    rec["viewpointCharacter"],
    rec["viewpoint"],
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim()
  }
  return null
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
    novelConfig = CRUISE_FULL_CONFIG,
    cruiseMode = false,
    arbitrationProvider,
    buildChapterRequest,
    enableEventPool = false,
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

    // 构建该章节的用户提示词（显式 buildChapterRequest 优先；缺省走 S2 默认装配）
    let userRequest: string
    if (buildChapterRequest) {
      userRequest = await buildChapterRequest(currentChapterNum)
    } else {
      let characterNames: string[] = []
      try {
        characterNames = await listBindableNovelCharacters(pp)
      } catch {
        characterNames = []
      }
      // F2 零成本约束注入：视点约束（binding 尽力而为读取，取不到传 null；零 LLM 成本）
      let povName: string | null = null
      try {
        povName = extractBindingPovName(await loadBinding(pp))
      } catch {
        povName = null
      }
      // F2 零成本约束注入：访谈锚点（interview-store 经 grep 确认无 loadRecentSnippets
      // 导出，仅有 save/load/delete + loadInterviews，故 snippets 传 [] 零成本跳过）
      const interviewSnippets: string[] = []
      const povOthers = povName ? characterNames.filter((n) => n !== povName) : characterNames
      userRequest = assembleChapterRequest({
        base: buildBaseRequest(currentChapterNum),
        character: buildCharacterConstraint(characterNames),
        pov: buildPovConstraint(povName, povOthers),
        interview: buildInterviewAnchor(interviewSnippets),
        stage: buildStageHint(currentChapterNum, endChapter),
        carryover: previousDraftSummary,
      })
      // E2 事件池动态注入：成本闸默认关闭；开启后失败自动直通不断巡航。
      if (enableEventPool) {
        userRequest = await enrichWithEventPool({
          request: userRequest,
          projectPath: pp,
          llmConfig,
          characters: characterNames,
          chapterNumber: currentChapterNum,
          totalChapters: endChapter,
        })
      }
    }

    // 若有前序沙箱草稿，注入连续性承接指令
    let dismantlingDirective: string | undefined
    if (previousDraftSummary) {
      dismantlingDirective = `【前序连贯性前情承接】上一章正文概要/选段：\n${previousDraftSummary.slice(0, 1500)}`
    }

    // F3：本章是否已用仲裁 revisedBrief 重跑过（单章最多重跑一次，第二次仍失败则 paused）
    let retriedOnce = false

    // F3：单章生成尝试（含门控映射与巡航自动晋升），首跑与仲裁 retry 重跑共用。
    const attemptChapter = async (requestText: string): Promise<CampaignChapterResult> => {
      const genResult = await runDeepChapterGeneration(
        {
          projectPath: pp,
          userRequest: requestText,
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

      const attemptStatus: CampaignChapterResult["status"] = genResult.manualReviewRequired
        ? "blocked"
        : genResult.partial
          ? "partial"
          : "ready"

      let isAutoAccepted = false
      // 全自动巡航推进：门控全绿时自动原地提交晋升正式章节，并自动摄取事实库
      if (cruiseMode && attemptStatus === "ready" && finalTxt.length > 0) {
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
              novelConfig,
            },
          )
          isAutoAccepted = acceptRes.acceptedCount > 0
        } catch (acceptErr) {
          console.warn(`[campaign-runner] 第 ${currentChapterNum} 章全自动巡航晋升失败:`, acceptErr)
        }
      }

      return {
        chapterNumber: currentChapterNum,
        content: finalTxt,
        taskBrief: genResult.taskBrief,
        draftContent: genResult.draftContent,
        decisionGates: genResult.decisionGates,
        reviewResults: genResult.reviewResults,
        revised: genResult.revised,
        wordCount: words,
        status: attemptStatus,
        autoAccepted: isAutoAccepted,
      }
    }

    try {
      const chapterResult = await attemptChapter(userRequest)

      results.push(chapterResult)
      onChapterComplete?.(currentChapterNum, chapterResult)

      // 巡航安全守护：若在全自动巡航模式下遇到未通过（blocked / partial），走 F3 仲裁闭环；
      // 无 provider 或无有效指令时保持现有 paused 行为（安全挂起待人工介入）。
      if (cruiseMode && chapterResult.status !== "ready") {
        const arbitrationRequest = buildArbitrationRequest(chapterResult)
        const arbitrationJson = JSON.stringify(arbitrationRequest)
        onProgress?.({ stage: "arbitration-pending", current: idx + 1, total, message: arbitrationJson })

        if (arbitrationProvider) {
          let directive: ArbitrationDirective | null = null
          try {
            directive = await arbitrationProvider(arbitrationRequest)
          } catch (providerErr) {
            console.warn(
              `[campaign-runner] 第 ${currentChapterNum} 章仲裁指令获取失败，保持安全挂起:`,
              providerErr,
            )
          }
          let decision: PausedChapterDecision | null = null
          try {
            decision = decidePausedChapter(arbitrationRequest, directive)
          } catch (decisionErr) {
            console.warn(
              `[campaign-runner] 第 ${currentChapterNum} 章仲裁指令非法，保持安全挂起:`,
              decisionErr,
            )
          }

          // retry：本章用 revisedBrief 重跑一次；成功则继续下一章，仍失败则 paused
          if (
            decision?.disposition === "retry" &&
            decision.taskBrief !== undefined &&
            !retriedOnce
          ) {
            retriedOnce = true
            onProgress?.({
              stage: "arbitration-retry",
              current: idx + 1,
              total,
              message: `[第 ${currentChapterNum} 章] 仲裁指令 retry，正在用修订任务书重跑本章...`,
            })
            const retryResult = await attemptChapter(decision.taskBrief)
            // 以重跑结局覆盖首跑记录（单章在报告中只保留最终处置）
            results[results.length - 1] = retryResult
            onChapterComplete?.(currentChapterNum, retryResult)
            if (retryResult.status === "ready") {
              previousDraftSummary = buildCarryoverContext({
                chapterNumber: currentChapterNum,
                content: retryResult.content,
              })
              continue
            }
            onProgress?.({
              stage: "cruise-paused",
              current: idx + 1,
              total,
              message: `[第 ${currentChapterNum} 章] 重跑后仍未通过(${retryResult.status})，全自动巡航已安全挂起并等待人工审阅。`,
            })
            break
          }

          // skip：标记跳过并继续下一章（跳过章不污染后章前情承接）
          if (decision?.disposition === "skip") {
            const skippedResult: CampaignChapterResult = {
              ...chapterResult,
              skipped: true,
              autoAccepted: false,
            }
            results[results.length - 1] = skippedResult
            onChapterComplete?.(currentChapterNum, skippedResult)
            onProgress?.({
              stage: "arbitration-skip",
              current: idx + 1,
              total,
              message: `[第 ${currentChapterNum} 章] 仲裁指令 skip，本章已标记跳过，全自动巡航继续推进下一章。`,
            })
            continue
          }
        } else {
          // B1 可观测性（零风险 additive）：arbitrationProvider 缺省 → warn + arbitration-no-provider 事件。
          // 默认行为不变：仍落到下方 cruise-paused 安全挂起（人工介入），不自动重试/跳章，不碰晋升通道。
          console.warn(
            `[campaign-runner] 第 ${currentChapterNum} 章门控未通过(${chapterResult.status})，未配置 arbitrationProvider，保持安全挂起待人工审阅。`,
          )
          onProgress?.({
            stage: "arbitration-no-provider",
            current: idx + 1,
            total,
            message: `[第 ${currentChapterNum} 章] 未配置仲裁指令提供者，保持安全挂起待人工审阅。`,
          })
        }

        onProgress?.({
          stage: "cruise-paused",
          current: idx + 1,
          total,
          message: `[第 ${currentChapterNum} 章] 门控未通过(${chapterResult.status})，全自动巡航已安全挂起并等待人工审阅。`,
        })
        break
      }

      // 更新前情记忆给下一章沙箱消费（结构化承接：承接章号 + 末段收束 + 开端锚点）
      previousDraftSummary = buildCarryoverContext({
        chapterNumber: currentChapterNum,
        content: chapterResult.content,
      })
      // B2 弧结算可观测（P1-6：只发事件，不自动结算）。
      // arcEndChapter 暂无生产来源（传入 null）故默认不触发，仅保留事件形状供后续接线。
      // TODO(B2-arc)：arcEndChapter 来源 + 结算执行。
      if (shouldTriggerArcSettlement(currentChapterNum, null)) {
        onProgress?.({
          stage: "arc-settlement",
          current: idx + 1,
          total,
          message: `[第 ${currentChapterNum} 章] 弧边界到达，待结算（当前仅可观测，不自动执行）。`,
        })
      }
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
    novelConfig?: NovelConfig
    onProgress?: (current: number, total: number, path: string) => void
  },
): Promise<BatchAcceptResult> {
  const pp = normalizePath(projectPath)
  const chapterDir = `${pp}/wiki/chapters`
  await createDirectory(chapterDir)

  const chapterPaths: string[] = []
  let ingestedCount = 0

  // 仅提交非空且未失败的章节草稿（纯过滤逻辑见 filterAcceptableChapters，便于单测）
  const validChapters = filterAcceptableChapters(chapterResults)
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
    const userRequest =
      (ch.taskBrief || "").trim().length > 0
        ? ch.taskBrief
        : `请撰写第 ${chapterNum} 章正文。`
    try {
      // H1 晋升收拢：经正式晋升通道落盘（状态晋升 + 情绪账本 + promotion 登记）；
      // 通道失败（如 status.json 不可用）时降级直写，保证批跑不断。
      await commitAcceptedDeepChapterDraft({
        projectPath: pp,
        conversationId: "autonomous-campaign",
        userRequest,
        chapterNumber: chapterNum,
        chapterPath: filePath,
        finalChapterContent: finalContent,
        overwriteExisting: true,
      })
      chapterPaths.push(filePath)
    } catch (commitErr) {
      console.warn(`[campaign-batch-accept] 正式晋升通道失败，降级直写 ${filePath}:`, commitErr)
      await writeFileAtomic(filePath, finalContent)
      chapterPaths.push(filePath)
    }
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
            llmConfig: options.llmConfig,
            novelConfig: options.novelConfig,
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
