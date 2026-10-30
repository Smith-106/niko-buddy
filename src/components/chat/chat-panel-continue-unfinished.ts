// Copyright (c) 2024 Niko-hub contributors. MIT License.
import {
  blockDeepChapterSession,
  buildGoldenThreeChapterDirective,
  buildQmQuaiSystemPrompt,
  buildStageJournalRuntime,
  buildTaskDirective,
  completeDeepChapterSession,
  createNovelSessionId,
  detectGoldenThreeChapterRequest,
  loadNovelSessionStatus,
  novelSessionStatusPath,
  pauseDeepChapterSession,
  persistDeepChapterCheckpoint,
  resolveNovelModel,
  routeTask,
  startDeepChapterSession,
} from "@/lib/novel"
import {
  appendContinueUnfinishedDeepChapterContext,
  buildContinueUnfinishedDeepChapterPrompt,
  buildInterruptedResumeContextPayload,
  extractContinueUnfinishedDeepChapterContext,
  stripContinueUnfinishedDeepChapterContext,
} from "@/lib/chat/resume"
import { createDeepThinkingStreamRenderer } from "@/lib/deep-thinking-stream"
import { streamChat } from "@/lib/llm-client"
import { normalizePath } from "@/lib/path-utils"
import { toErrorMessage } from "@/lib/utils"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { useChatStore, type DisplayMessage, type MessageReference } from "@/stores/chat-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import {
  appendContextUsageMarker,
  appendHiddenNovelSessionDebug,
  appendManagedDeepChapterDraftMarker,
} from "./chat-message-markers"
import type { ContextPackReplayPanel } from "@/components/novel/context-pack-replay-panel"
import { findPreviousUserRequest, loadEnabledDismantlingDirective } from "./chat-panel-widgets"
import type { StreamSessionGuard } from "./stream-session"

export interface ChatContinueUnfinishedContext {
  /** 被点击「继续未完成」的助手消息（提供 conversationId 与隐藏恢复上下文）。 */
  assistantMessage: DisplayMessage
  /** 全局流式状态（同 useCallback 依赖数组里的 isStreaming）。 */
  isStreaming: boolean
  /** chat store 动作（逐字沿用原 useCallback 闭包里的引用）。 */
  createConversation: () => string
  addMessage: (role: DisplayMessage["role"], content: string) => void
  startStreaming: (conversationId: string) => void
  setStreamingContent: (content: string, conversationId: string) => void
  finalizeStream: (content: string, references?: MessageReference[] | undefined, targetConvId?: string) => void
  /** 当前项目（无项目时走非项目续写路径）。 */
  project: WikiProject | null
  /** ContextPack 回放面板的写入点（Wave C6）。 */
  setReplayContextPack: (pack: React.ComponentProps<typeof ContextPackReplayPanel>["pack"]) => void
  /** 生效 LLM 配置（已由调用方用 resolveEffectiveChatLlmConfig 解析）。 */
  effectiveChatLlmConfig: LlmConfig
  /** 流运行时 ref（module 级 shared ref 由调用方传入）。 */
  streamSessionGuardRef: { current: StreamSessionGuard }
  activeStreamSessionsRef: { current: Record<string, number> }
  abortControllersRef: { current: Record<string, AbortController> }
  novelManagedStopRef: { current: Record<string, boolean> }
}

/**
 * 「继续未完成」分支（chat-panel 拆分 T7）。
 *
 * 逐字保留自 handleContinueUnfinished 的整个函数体（含 catch / finally）：
 * - accumulated / latestCheckpoint / novelSessionId / continueSessionDebug 等可变局部量
 *   仍留在本函数内 —— 它们被 onThinking / onCheckpoint 等回调闭包改写、又被 catch 读取，
 *   外提会变成逻辑改写。
 * - 动态 import（deep-chapter-generation / consensus-writing / residual-campaign /
 *   context-engine）保持动态（lint boundaries 禁止静态深引用 @/lib/novel/*）。
 * - 所有 store 读（useChatStore.getState / useWikiStore.getState）、错误文案、marker 注入、
 *   ref 清理顺序逐字不变。
 */
export async function runContinueUnfinished(ctx: ChatContinueUnfinishedContext): Promise<void> {
  const {
    assistantMessage,
    isStreaming,
    createConversation,
    addMessage,
    startStreaming,
    setStreamingContent,
    finalizeStream,
    project,
    setReplayContextPack,
    effectiveChatLlmConfig,
    streamSessionGuardRef,
    activeStreamSessionsRef,
    abortControllersRef,
    novelManagedStopRef,
  } = ctx

  if (isStreaming) return


  const storeState = useChatStore.getState()
  let convId = assistantMessage.conversationId?.trim()
  if (!convId) {
    convId = storeState.activeConversationId ?? createConversation()
  }
  if (storeState.activeConversationId !== convId) {
    storeState.setActiveConversation(convId)
  }

  const active = useChatStore.getState().messages.filter((message) => message.conversationId === convId)
  const persistedResume = extractContinueUnfinishedDeepChapterContext(assistantMessage.content)
  const visibleAssistantContent = stripContinueUnfinishedDeepChapterContext(assistantMessage.content)
  const statusResume = project
    ? await loadNovelSessionStatus(normalizePath(project.path)).catch(() => null)
    : null
  const statusResumePayload = buildInterruptedResumeContextPayload(statusResume, convId)
  const statusResumeCheckpoint = statusResumePayload?.checkpoint
  const resumeCheckpoint = statusResumeCheckpoint ?? persistedResume?.checkpoint
  const originalRequest =
    statusResumePayload?.originalRequest ||
    persistedResume?.originalRequest ||
    (statusResume?.current_task.conversation_id === convId ? statusResume.current_task.user_request : undefined) ||
    findPreviousUserRequest(active, assistantMessage.id)
  const resumeContext = statusResumePayload?.resumeContext || persistedResume?.resumeContext || visibleAssistantContent
  const rootResumeContext = statusResumePayload?.rootResumeContext || persistedResume?.rootResumeContext || resumeContext
  const prompt = buildContinueUnfinishedDeepChapterPrompt({
    originalRequest,
    persistedOriginalRequest: statusResumePayload?.originalRequest ?? persistedResume?.originalRequest,
    failedAssistantContent: visibleAssistantContent,
    resumeContext,
    rootResumeContext,
  })

  addMessage("user", "继续未完成")
  startStreaming(convId)

  const sessionId = streamSessionGuardRef.current.start(convId)
  activeStreamSessionsRef.current[convId] = sessionId
  const controller = new AbortController()
  abortControllersRef.current[convId] = controller

  const deepStream = createDeepThinkingStreamRenderer()
  let accumulated = deepStream.updateThinking("## 继续未完成\n正在基于上一轮已完成阶段继续生成，避免从头重新思考。")
  let resumeThinking = ""
  let latestCheckpoint = resumeCheckpoint
  let novelSessionId: string | undefined
  let continueSessionDebug: Record<string, unknown> | null = null
  setStreamingContent(accumulated, convId)

  try {
    const novelConfig = useWikiStore.getState().novelConfig
    const writingConfig = resolveNovelModel(effectiveChatLlmConfig, novelConfig, "writing")

    if (project && originalRequest?.trim() && resumeCheckpoint) {
      const pp = normalizePath(project.path)
      const sessionDebug: Record<string, unknown> = {
        flow: "continue-unfinished-deep-chapter",
        projectPath: pp,
        statusPath: novelSessionStatusPath(pp),
        conversationId: convId,
        chapterNumber: resumeCheckpoint.chapterNumber ?? null,
        originalRequest,
      }
      continueSessionDebug = sessionDebug
      novelManagedStopRef.current[convId] = true
      const resumeRoute = routeTask(originalRequest)
      const goldenResume = detectGoldenThreeChapterRequest(originalRequest, resumeRoute?.chapterNumber)
      const dismantlingDirective = await loadEnabledDismantlingDirective(pp).catch(() => "")
      const { runDeepChapterGeneration } = await import("@/lib/novel/deep-chapter-generation")
      // 多模型共识旁路（同首次生成）：恢复续写懒加载共识执行器
      const consensusActiveResume =
        novelConfig.consensusEnabled && novelConfig.consensusWritingModels.some((m) => m.trim())
      const runGenerationResume = consensusActiveResume
        ? (await import("@/lib/novel/consensus-writing")).runDeepChapterGenerationConsensus
        : runDeepChapterGeneration
      let checkpointPersistError: string | null = null
      const sessionState = await startDeepChapterSession({
        projectPath: pp,
        conversationId: convId,
        userRequest: originalRequest,
        chapterNumber: resumeRoute?.chapterNumber,
        resumeCheckpoint,
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
        chapterNumber: resumeRoute?.chapterNumber,
        config: novelConfig,
      })
      // F10-2：续跑路径与首次生成同 helper 装配（开关+TTL 只此一处）。
      const stageJournalRuntimeResume = buildStageJournalRuntime(pp, novelConfig.stageJournalEnabled, novelConfig.journalTtlMs)
      const generationResult = await runGenerationResume(
        {
          projectPath: pp,
          userRequest: originalRequest,
          chapterNumber: resumeRoute?.chapterNumber,
          goldenThreeChapter: goldenResume?.enabled ? goldenResume : undefined,
          dismantlingReferenceDirective: dismantlingDirective,
          llmConfig: effectiveChatLlmConfig,
          novelConfig,
          // 55 号设计 W1-1 (54⑧ 收尾): 题材透传 (undefined → 生成链零行为变更)。
          genre: novelConfig.genre,
          resumeCheckpoint,
          // R9（Round-9 用户可感知开关）+ F10-2：续跑路径与首次生成同 helper 装配。
          ...(stageJournalRuntimeResume ? { stageJournal: stageJournalRuntimeResume } : {}),
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
          onThinking: (content) => {
            if (!streamSessionGuardRef.current.isActive(convId, sessionId)) return
            accumulated = deepStream.updateThinking(content)
            setStreamingContent(accumulated, convId)
          },
          onFinalContent: (content) => {
            if (!streamSessionGuardRef.current.isActive(convId, sessionId)) return
            accumulated = deepStream.appendFinal(content)
            setStreamingContent(accumulated, convId)
          },
          onCheckpoint: async (checkpoint) => {
            latestCheckpoint = checkpoint
            sessionDebug.lastCheckpointStage = checkpoint.stage
            try {
              const checkpointState = await persistDeepChapterCheckpoint({
                projectPath: pp,
                conversationId: convId,
                userRequest: originalRequest,
                chapterNumber: resumeRoute?.chapterNumber,
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
      if (generationResult.manualReviewRequired) {
        const blockedState = await blockDeepChapterSession({
          projectPath: pp,
          conversationId: convId,
          userRequest: originalRequest,
          chapterNumber: resumeRoute?.chapterNumber,
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
        // Continue-unfinished itself stalled mid-generation and preserved a
        // partial. Re-pause (draft_status "pending") so the user can retry
        // continue-unfinished again, rather than persisting a still-truncated
        // chapter as completed/ready. See DeepChapterGenerationResult.partial.
        const pausedState = await pauseDeepChapterSession({
          projectPath: pp,
          conversationId: convId,
          userRequest: originalRequest,
          chapterNumber: resumeRoute?.chapterNumber,
          sessionId: novelSessionId,
          checkpoint: latestCheckpoint,
          errorMessage: `写到一半的正文已留下，可以再次用「继续未完成」接着写。`,
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
          conversationId: convId,
          userRequest: originalRequest,
          chapterNumber: resumeRoute?.chapterNumber,
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

      if (!streamSessionGuardRef.current.isActive(convId, sessionId)) return
      streamSessionGuardRef.current.finish(convId, sessionId, () => {
        finalizeStream(
          appendManagedDeepChapterDraftMarker(
            accumulated || "继续未完成失败：模型没有返回内容。",
            {
              conversationId: convId,
              sessionId: novelSessionId,
              draftStatus: generationResult.manualReviewRequired
                ? "pending"
                : generationResult.partial
                  ? "pending"
                  : "ready",
            },
          ),
          [],
          convId,
        )
        delete activeStreamSessionsRef.current[convId]
        delete abortControllersRef.current[convId]
      })
      return
    }

    let continuationSystemPrompt = [
      "你是专业小说写作助手。用户正在继续一次已中断的深度章节生成，请严格基于已有思考和阶段内容往后完成，不要从头重跑已完成阶段。",
      "如果上方恢复上下文里没有正文草稿，就从正文生成阶段继续；如果已经有正文草稿，就继续审查、返修、简单审查、去AI味或补全正文。",
      "不要把“继续未完成”当作原始章节需求；原始章节需求必须以恢复上下文中的原始用户请求为准。",
    ].join("\n")
    // Wave 5 (v2.5.0): continue-unfinished 路径无 generationResult，用量快照
    // 从本路径自建的 contextPack 承接（additive，构建失败时 undefined 不渲染）。
    let continueContextUsage: import("@/lib/context-usage").ContextUsage | undefined

    if (project && originalRequest?.trim()) {
      try {
        const pp = normalizePath(project.path)
        const resumeRoute = routeTask(originalRequest)
        const goldenResume = detectGoldenThreeChapterRequest(originalRequest, resumeRoute?.chapterNumber)
        const taskDirective = resumeRoute ? buildTaskDirective(resumeRoute) : ""
        const goldenDirective = buildGoldenThreeChapterDirective(goldenResume)
        const { buildContextPack, contextPackToPrompt } = await import("@/lib/novel/context-engine")
         const contextPack = await buildContextPack(pp, originalRequest, resumeRoute?.chapterNumber).catch(() => ({
           task: originalRequest,
           chapterGoal: "",
           outline: "",
           recentSummaries: [],
           previousChapterEnding: "",
           characterStates: "",
           soulDoc: "",
           characterAuras: "",
           cognitionStates: "",
           foreshadowingStates: "",
           timeline: "",
           relatedSettings: "",
           canonRules: "",
           writingStyle: "",
           searchResults: "",
           graphSearchResults: "",
           mustDo: "",
           mustAvoid: "",
           nextChapterAdvice: "",
           revisionDirectives: "",
           contextUsage: undefined,
         }))
         // Wave C6: 接入 ContextPackReplayPanel —— 捕获 continue-unfinished 路径的装配结果供回放面板只读展示。
         setReplayContextPack(contextPack)
         const budget = novelConfig.contextTokenBudget > 0 ? novelConfig.contextTokenBudget : undefined
         const dismantlingDirective = await loadEnabledDismantlingDirective(pp).catch(() => "")
         continueContextUsage = contextPack.contextUsage
         continuationSystemPrompt = [
           continuationSystemPrompt,
           "",
          "## QM-QUAI 技能",
          buildQmQuaiSystemPrompt(),
          "",
          taskDirective,
          goldenDirective,
           "",
           "## 原始深度章节上下文包",
           contextPackToPrompt(contextPack, budget, {
             layeredRecall: "default",
             sectionCharBudget: 4000,
             hardInjectEnabled: novelConfig.hardInjectEnabled,
           }),
           dismantlingDirective,
         ].filter(Boolean).join("\n")
      } catch (err) {
        console.warn("构建继续未完成上下文包失败:", err)
      }
    }

    let streamError: Error | null = null

    await streamChat(
      writingConfig,
      [
        {
          role: "system",
          content: continuationSystemPrompt,
        },
        { role: "user", content: prompt },
      ],
      {
        onToken: (token) => {
          if (!streamSessionGuardRef.current.isActive(convId, sessionId)) return
          accumulated = deepStream.appendFinal(token)
          setStreamingContent(accumulated, convId)
        },
        onReasoningToken: (token) => {
          if (!streamSessionGuardRef.current.isActive(convId, sessionId)) return
          resumeThinking += token
          accumulated = deepStream.updateThinking(
            `## 继续未完成\n正在基于上一轮已完成阶段继续生成，避免从头重新思考。\n\n${resumeThinking}`,
          )
          setStreamingContent(accumulated, convId)
        },
        onDone: () => {},
        onError: (err) => {
          streamError = err
        },
      },
      controller.signal,
      { reasoning: resolveUserVisibleReasoning(writingConfig.reasoning) },
    )

    if (!streamSessionGuardRef.current.isActive(convId, sessionId)) return
    if (streamError) throw streamError

    streamSessionGuardRef.current.finish(convId, sessionId, () => {
      finalizeStream(
        appendContextUsageMarker(
          appendManagedDeepChapterDraftMarker(
            accumulated || "继续未完成失败：模型没有返回内容。",
            {
              conversationId: convId,
              sessionId: novelSessionId,
              draftStatus: "ready",
            },
          ),
          continueContextUsage,
        ),
        [],
        convId,
      )
      delete activeStreamSessionsRef.current[convId]
      delete abortControllersRef.current[convId]
    })
  } catch (err) {
    const message = toErrorMessage(err)
    let pausePersistError: string | null = null
    /* v8 ignore next */
    if (project && originalRequest?.trim()) {
      if (!novelSessionId) {
        novelSessionId = createNovelSessionId()
        if (continueSessionDebug) {
          continueSessionDebug.syntheticSessionId = novelSessionId
        }
      }
    }
    /* v8 ignore next */
    if (project && originalRequest?.trim() && novelSessionId) {
      try {
        const pausedState = await pauseDeepChapterSession({
          projectPath: normalizePath(project.path),
          conversationId: convId,
          userRequest: originalRequest,
          chapterNumber: routeTask(originalRequest)?.chapterNumber,
          sessionId: novelSessionId,
          checkpoint: latestCheckpoint,
          errorMessage: controller.signal.aborted || message === "已停止生成" ? "已停止生成" : message,
        })
        if (continueSessionDebug) {
          continueSessionDebug.pauseWrite = {
            status: pausedState.status,
            activeStepIndex: pausedState.active_step_index,
            draftStatus: pausedState.draft.draft_status,
            updatedAt: pausedState.updated_at,
            lastError: pausedState.current_task.last_error ?? null,
          }
        }
      } catch (persistError) {
        pausePersistError = toErrorMessage(persistError)
        /* v8 ignore next */
        if (continueSessionDebug) {
          continueSessionDebug.pauseWrite = { error: pausePersistError }
        }
        console.warn("继续未完成暂停状态落盘失败:", persistError)
      }
    }
    streamSessionGuardRef.current.finish(convId, sessionId, () => {
      const persistenceDetails = pausePersistError ? `\n\n状态写回异常：暂停状态没能保存：${pausePersistError}` : ""
      const visibleFailure = `${accumulated ? `${accumulated}\n\n` : ""}出错：继续未完成失败：${message}${persistenceDetails}`
      const inheritedResumeContext = [
        rootResumeContext,
        "",
        "## 最近一次继续未完成失败时的输出",
        stripContinueUnfinishedDeepChapterContext(visibleFailure),
      ].join("\n")
      const continueFailureContent = appendContinueUnfinishedDeepChapterContext(visibleFailure, {
        originalRequest,
        resumeContext: inheritedResumeContext,
        rootResumeContext,
        checkpoint: latestCheckpoint,
      })
      finalizeStream(
        continueSessionDebug
          ? appendHiddenNovelSessionDebug(
            continueFailureContent,
            {
              ...continueSessionDebug,
              errorMessage: message,
              abortRequested: controller.signal.aborted,
            },
          )
          : continueFailureContent,
        undefined,
        convId,
      )
      delete activeStreamSessionsRef.current[convId]
      delete abortControllersRef.current[convId]
    })
  } finally {
    delete novelManagedStopRef.current[convId]
    if (activeStreamSessionsRef.current[convId] === sessionId) {
      delete activeStreamSessionsRef.current[convId]
    }
    if (abortControllersRef.current[convId] === controller) {
      delete abortControllersRef.current[convId]
    }
  }
}
