// Copyright (c) 2024 Niko-hub contributors. MIT License.
import {
  blockDeepChapterSession,
  buildStageJournalRuntime,
  completeDeepChapterSession,
  createNovelSessionId,
  novelSessionStatusPath,
  pauseDeepChapterSession,
  persistDeepChapterCheckpoint,
  startDeepChapterSession,
  type GoldenThreeChapterRequest,
} from "@/lib/novel"
import {
  appendContinueUnfinishedDeepChapterContext,
} from "@/lib/chat/resume"
import { createDeepThinkingStreamRenderer } from "@/lib/deep-thinking-stream"
import { toErrorMessage } from "@/lib/utils"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { MessageReference } from "@/stores/chat-store"
import {
  appendContextUsageMarker,
  appendHiddenNovelSessionDebug,
  appendManagedDeepChapterDraftMarker,
} from "./chat-message-markers"
import type { StreamSessionGuard } from "./stream-session"

export interface ChatDeepChapterContext {
  text: string
  capturedConvId: string
  sessionId: number
  pp: string
  effectiveTaskRoute: { chapterNumber?: number; intent?: string; extractedParams?: Record<string, string> } | null
  effectiveChatLlmConfig: LlmConfig
  goldenThreeChapter: GoldenThreeChapterRequest | undefined
  dismantlingDirective: string
  novelConfig: NovelConfig
  planningPlan: import("@/lib/novel/planning").ChapterPlanView | null
  setPlanningPlan: React.Dispatch<React.SetStateAction<import("@/lib/novel/planning").ChapterPlanView | null>>
  setStreamingContent: (content: string, conversationId: string) => void
  finalizeStream: (content: string, references?: MessageReference[] | undefined, targetConvId?: string) => void
  abortControllersRef: { current: Record<string, AbortController> }
  activeStreamSessionsRef: { current: Record<string, number> }
  streamSessionGuardRef: { current: StreamSessionGuard }
  novelManagedStopRef: { current: Record<string, boolean> }
  interruptedResumeCheckpoint?: import("@/lib/novel/deep-chapter-generation").DeepChapterGenerationResumeCheckpoint
  autoResumedFromStatus?: boolean
  resumeCheckpoint?: import("@/lib/novel/deep-chapter-generation").DeepChapterGenerationResumeCheckpoint
}

/**
 * 深度章节生成分支（chat-panel 拆分 T5）。
 *
 * 逐字保留自 handleSend 内的 if (novelMode && project && deepChapterEnabledNow) 分支：
 * - 动态加载 deep-chapter-generation / consensus-writing / residual-campaign 保持动态
 * - sessionState 初始化、stageJournalRuntime 装配、runGenerationFirst 调用契约不变
 * - onThinking / onFinalContent / onCheckpoint 顺序与错误抛出 CHECKPOINT_PERSIST_FAILED 逐字保留
 * - manualReviewRequired / partial / completed / abort / error 状态分支落盘与 marker 注入逐字保留
 * - setPlanningPlan(null) 的 one-shot 清除语义逐字保留
 * - finally 清理 novelManagedStopRef / activeStreamSessionsRef / abortControllersRef 逐字保留
 */
export async function runDeepChapterSend(ctx: ChatDeepChapterContext): Promise<void> {
  const {
    text,
    capturedConvId,
    sessionId,
    pp,
    effectiveTaskRoute,
    effectiveChatLlmConfig,
    goldenThreeChapter,
    dismantlingDirective,
    novelConfig,
    planningPlan,
    setPlanningPlan,
    setStreamingContent,
    finalizeStream,
    abortControllersRef,
    activeStreamSessionsRef,
    streamSessionGuardRef,
    novelManagedStopRef,
  } = ctx

  const { runDeepChapterGeneration } = await import("@/lib/novel/deep-chapter-generation")
  // 多模型共识旁路：开启且配置了写作模型组时才加载共识执行器（懒加载，关闭状态零额外模块加载）
  const consensusActive =
    novelConfig.consensusEnabled && novelConfig.consensusWritingModels.some((m) => m.trim())
  const runGenerationFirst = consensusActive
    ? (await import("@/lib/novel/consensus-writing")).runDeepChapterGenerationConsensus
    : runDeepChapterGeneration
  const controller = new AbortController()
  const interruptedResumeCheckpoint = ctx.interruptedResumeCheckpoint
  const sessionDebug: Record<string, unknown> = {
    flow: "deep-chapter",
    projectPath: pp,
    statusPath: novelSessionStatusPath(pp),
    conversationId: capturedConvId,
    chapterNumber: effectiveTaskRoute?.chapterNumber ?? null,
    userRequest: text,
    autoResumedFromStatus: Boolean(interruptedResumeCheckpoint),
  }
  novelManagedStopRef.current[capturedConvId] = true
  abortControllersRef.current[capturedConvId] = controller
  const deepStream = createDeepThinkingStreamRenderer()
  let accumulated = ""
  let latestCheckpoint: import("@/lib/novel/deep-chapter-generation").DeepChapterGenerationResumeCheckpoint | undefined
  let novelSessionId: string | undefined
  let checkpointPersistError: string | null = null
  const appendThinkingBlock = (content: string) => {
    if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
    accumulated = deepStream.updateThinking(content)
    setStreamingContent(accumulated, capturedConvId)
  }

  try {
    const sessionState = await startDeepChapterSession({
      projectPath: pp,
      conversationId: capturedConvId,
      userRequest: text,
      chapterNumber: effectiveTaskRoute?.chapterNumber,
      resumeCheckpoint: interruptedResumeCheckpoint,
    })
    novelSessionId = sessionState.session_id
    sessionDebug.start = {
      sessionId: sessionState.session_id,
      status: sessionState.status,
      activeStepIndex: sessionState.active_step_index,
      updatedAt: sessionState.updated_at,
    }
    const { resolveResidualCampaignFields } = await import("@/lib/novel/residual-campaign")
    const residualCampaignFields = resolveResidualCampaignFields({
      enabled: !!novelConfig.residualCampaignEnabled,
      chapterNumber: effectiveTaskRoute?.chapterNumber,
      config: novelConfig,
    })
    // F10-2：stageJournal 装配收敛到共享 helper（双调用点同语义，开关+TTL 只此一处）。
    const stageJournalRuntime = buildStageJournalRuntime(pp, novelConfig.stageJournalEnabled, novelConfig.journalTtlMs)
    const generationResult = await runGenerationFirst(
      {
        projectPath: pp,
        userRequest: text,
        chapterNumber: effectiveTaskRoute?.chapterNumber,
        goldenThreeChapter: goldenThreeChapter?.enabled ? goldenThreeChapter : undefined,
        dismantlingReferenceDirective: dismantlingDirective,
        llmConfig: effectiveChatLlmConfig,
        novelConfig,
        // 55 号设计 W1-1 (54⑧ 收尾): 题材透传 (undefined → 生成链零行为变更)。
        genre: novelConfig.genre,
        resumeCheckpoint: interruptedResumeCheckpoint,
        // R9（Round-9 用户可感知开关）+ F10-2（装配收敛到 buildStageJournalRuntime，
        // 开关语义/TTL 显式装配只此一处；开=默认启用任务书缓存，关=直调 LLM）。
        // TTL 缺省走 journal 默认 T+1h；单测因 deep-gen 被 mock 不触 FS。
        ...(stageJournalRuntime ? { stageJournal: stageJournalRuntime } : {}),
        // Wave 3 (v2.5.0): 计划模式 one-shot 附加（send 后清除；缺省 → 零行为变化）
        ...(planningPlan ? { planningPlan } : {}),
        ...(residualCampaignFields
          ? {
              residualOverallMedian: residualCampaignFields.residualOverallMedian,
              residualRewriteMode: residualCampaignFields.residualRewriteMode,
              residualLengthPreserving: residualCampaignFields.residualLengthPreserving,
              chapterStructurePlan: residualCampaignFields.chapterStructurePlan,
            }
          : {}),
      },
      {
        onThinking: appendThinkingBlock,
        onFinalContent: (content) => {
          if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
          accumulated = deepStream.appendFinal(content)
          setStreamingContent(accumulated, capturedConvId)
        },
        onCheckpoint: async (checkpoint) => {
          latestCheckpoint = checkpoint
          sessionDebug.lastCheckpointStage = checkpoint.stage
          try {
            const checkpointState = await persistDeepChapterCheckpoint({
              projectPath: pp,
              conversationId: capturedConvId,
              userRequest: text,
              chapterNumber: effectiveTaskRoute?.chapterNumber,
              sessionId: novelSessionId!,
              checkpoint,
            })
            sessionDebug.checkpointWrite = {
              status: checkpointState.status,
              activeStepIndex: checkpointState.active_step_index,
              draftStatus: checkpointState.draft.draft_status,
              updatedAt: checkpointState.updated_at,
            }
            checkpointPersistError = null
          } catch (error) {
            checkpointPersistError = toErrorMessage(error)
            sessionDebug.checkpointWrite = { error: checkpointPersistError }
            throw new Error(`CHECKPOINT_PERSIST_FAILED: ${checkpointPersistError}`)
          }
        },
      },
      undefined,
      controller.signal,
    )
    // Wave 3 (v2.5.0): one-shot 语义 — 计划快照消费后立即清除（不跨次发送残留）
    setPlanningPlan(null)
    if (generationResult.manualReviewRequired) {
      const blockedState = await blockDeepChapterSession({
        projectPath: pp,
        conversationId: capturedConvId,
        userRequest: text,
        chapterNumber: effectiveTaskRoute?.chapterNumber,
        sessionId: novelSessionId,
        checkpoint: latestCheckpoint,
        errorMessage: `MANUAL_REVIEW_REQUIRED: retry_count=${generationResult.retryCount}`,
      })
      sessionDebug.finalWrite = {
        status: blockedState.status,
        activeStepIndex: blockedState.active_step_index,
        draftStatus: blockedState.draft.draft_status,
        updatedAt: blockedState.updated_at,
      }
    } else if (generationResult.partial) {
      // The transport timed out mid-generation and collectModelText
      // preserved a partial draft. Route to pause (draft_status "pending")
      // so continue-unfinished resumes from the partial via the
      // after_draft checkpoint, instead of persisting a truncated chapter
      // as completed/ready (Draft-first boundary). See
      // DeepChapterGenerationResult.partial + collectModelText partial-
      // preserve branch.
      const pausedState = await pauseDeepChapterSession({
        projectPath: pp,
        conversationId: capturedConvId,
        userRequest: text,
        chapterNumber: effectiveTaskRoute?.chapterNumber,
        sessionId: novelSessionId,
        checkpoint: latestCheckpoint,
        errorMessage: `写到一半的正文已留下，可以用「继续未完成」接着写。`,
      })
      sessionDebug.finalWrite = {
        status: pausedState.status,
        activeStepIndex: pausedState.active_step_index,
        draftStatus: pausedState.draft.draft_status,
        updatedAt: pausedState.updated_at,
      }
    } else {
      const completedState = await completeDeepChapterSession({
        projectPath: pp,
        conversationId: capturedConvId,
        userRequest: text,
        chapterNumber: effectiveTaskRoute?.chapterNumber,
        sessionId: novelSessionId,
        checkpoint: latestCheckpoint,
        finalContent: generationResult.finalContent,
        reviewResults: generationResult.reviewResults,
        // Wave 5 (v2.5.0): 上下文用量快照落盘（additive，缺省不落盘）。
        contextUsage: generationResult.contextUsage,
      })
      sessionDebug.finalWrite = {
        status: completedState.status,
        activeStepIndex: completedState.active_step_index,
        draftStatus: completedState.draft.draft_status,
        updatedAt: completedState.updated_at,
      }
    }
    streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
      finalizeStream(
        appendContextUsageMarker(
          appendManagedDeepChapterDraftMarker(accumulated, {
            conversationId: capturedConvId,
            sessionId: novelSessionId,
            draftStatus: generationResult.manualReviewRequired
              ? "pending"
              : generationResult.partial
                ? "pending"
                : "ready",
          }),
          generationResult.contextUsage,
        ),
        [],
        capturedConvId,
      )
      delete activeStreamSessionsRef.current[capturedConvId]
    })
  } catch (err) {
    const message = toErrorMessage(err)
    sessionDebug.errorMessage = message
    sessionDebug.abortRequested = controller.signal.aborted
    const existing = deepStream.getContent()
    let pausePersistError: string | null = null
    if (!novelSessionId) {
      novelSessionId = createNovelSessionId()
      sessionDebug.syntheticSessionId = novelSessionId
    }
    /* v8 ignore next */
    if (novelSessionId) {
      try {
        const pausedState = await pauseDeepChapterSession({
          projectPath: pp,
          conversationId: capturedConvId,
          userRequest: text,
          chapterNumber: effectiveTaskRoute?.chapterNumber,
          sessionId: novelSessionId,
          checkpoint: latestCheckpoint,
          errorMessage: controller.signal.aborted || message === "已停止生成" ? "已停止生成" : message,
        })
        sessionDebug.pauseWrite = {
          status: pausedState.status,
          activeStepIndex: pausedState.active_step_index,
          draftStatus: pausedState.draft.draft_status,
          updatedAt: pausedState.updated_at,
          lastError: pausedState.current_task.last_error ?? null,
        }
      } catch (persistError) {
        pausePersistError = toErrorMessage(persistError)
        sessionDebug.pauseWrite = { error: pausePersistError }
        console.warn("深度生成暂停状态落盘失败:", persistError)
      }
    }
    if (controller.signal.aborted || message === "已停止生成") {
      streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
        finalizeStream(
          appendHiddenNovelSessionDebug(
            appendContinueUnfinishedDeepChapterContext(
              `${existing ? `${existing}\n\n` : ""}已停止生成。`,
              {
                originalRequest: text,
                resumeContext: existing || "已停止生成。",
                rootResumeContext: existing || "已停止生成。",
                checkpoint: latestCheckpoint,
              },
            ),
            sessionDebug,
          ),
          [],
          capturedConvId,
        )
        delete activeStreamSessionsRef.current[capturedConvId]
      })
    } else {
      streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
        const persistenceDetails = [
          checkpointPersistError ? `进度点没能保存：${checkpointPersistError}` : "",
          pausePersistError ? `暂停状态没能保存：${pausePersistError}` : "",
        ].filter(Boolean).join("；")
        const visibleFailure = `${existing ? `${existing}

` : ""}出错：深度生成章节失败：${message}${persistenceDetails ? `

状态写回异常：${persistenceDetails}` : ""}`
        finalizeStream(
          appendHiddenNovelSessionDebug(
            appendContinueUnfinishedDeepChapterContext(visibleFailure, {
              originalRequest: text,
              resumeContext: visibleFailure,
              rootResumeContext: visibleFailure,
              checkpoint: latestCheckpoint,
            }),
            sessionDebug,
          ),
          undefined,
          capturedConvId,
        )
        delete activeStreamSessionsRef.current[capturedConvId]
      })
    }
  } finally {
    delete novelManagedStopRef.current[capturedConvId]
    if (activeStreamSessionsRef.current[capturedConvId] === sessionId) {
      delete activeStreamSessionsRef.current[capturedConvId]
    }
    /* v8 ignore next */
    if (abortControllersRef.current[capturedConvId] === controller) {
      delete abortControllersRef.current[capturedConvId]
    }
  }
  return
}
