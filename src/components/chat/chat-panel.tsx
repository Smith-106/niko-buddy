// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useEffect, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatOperationError } from "@/lib/format-operation-error"
import { logger, toErrorMessage, todayStamp } from "@/lib/utils"
import { useVirtualizer } from "@tanstack/react-virtual"
import { BookOpen, Brain, FileEdit, ArrowDown, ClipboardList } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ChatMessage, StreamingMessage } from "./chat-message"
import { ChatDockControls } from "./chat-dock-controls"
import { setLastQueryPages, useSourceFiles } from "./chat-shared"
import { ChatInput } from "./chat-input"
import { PlanningPanel } from "./planning-panel"
import { ChatModelSelector } from "./chat-model-selector"
import { useChatStore, chatMessagesToLLM, type DisplayMessage } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { chapterMarkdownHasBody, resolveChapterLengthSpec, routeTask, buildTaskDirective, detectLastGeneratedChapterNumber, findChapterFileByNumber, getNextChapterNumber, invalidateChapterCache, readSelectedChapterNumberForFile, resolveTargetChapterNumberForChat, buildQmQuaiSystemPrompt, injectDeAiDirective, cleanGeneratedChapterContentWithTitle, resolveNovelModel, resolveReviewModel, buildGoldenThreeChapterDirective, detectGoldenThreeChapterRequest, isChatEditRequest, updateChapterStatus, decideChapterSaveStrategy, detectGeneratedTargetChapterNumber, commitAcceptedDeepChapterDraft, blockDeepChapterSession, completeDeepChapterSession, createNovelSessionId, loadNovelSessionStatus, novelSessionStatusPath, pauseDeepChapterSession, persistDeepChapterCheckpoint, rejectDeepChapterDraft, resolveInterruptedSessionResumeCheckpoint, startDeepChapterSession, subscribeStatusJson, buildStageJournalRuntime } from "@/lib/novel"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { activeRustStreamIds } from "@/lib/claude-cli-transport"
import { executeIngestWrites } from "@/lib/ingest"
import { readFile, createDirectory, fileExists } from "@/commands/fs"
// C4 覆盖守卫：目标章节 Markdown 是否有正文的纯函数（chapter-save-strategy 模块）。
import { searchWiki, tokenizeQuery } from "@/lib/search"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { refreshProjectState } from "@/lib/project-refresh"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { createDeepThinkingStreamRenderer } from "@/lib/deep-thinking-stream"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { saveAiChatModel } from "@/lib/project-store"
import { isTauri } from "@/lib/platform"
import { createStreamSessionGuard } from "./stream-session"
import { useChatAutoScroll } from "./use-chat-scroll"
import { resolveEffectiveChatLlmConfig } from "./chat-panel-llm-config"
import { useChatPlanning } from "./use-chat-planning"
import { useChatConfirmDialogs } from "./use-chat-confirm-dialogs"
import { runChatEditMode } from "./chat-panel-edit-mode"
import {
  appendContinueUnfinishedDeepChapterContext,
  buildInterruptedResumeContextPayload,
  buildContinueUnfinishedDeepChapterPrompt,
  extractContinueUnfinishedDeepChapterContext,
  stripContinueUnfinishedDeepChapterContext,
} from "@/lib/chat/resume"
import { getCopyableAssistantContent } from "@/lib/chat-copy-content"
import { ContextPackReplayPanel } from "@/components/novel/context-pack-replay-panel"

import { ChatPanelEmptyState } from "./chat-panel-empty-state"
import {
  ConversationTabs, findPreviousUserRequest, loadEnabledDismantlingDirective,
} from "./chat-panel-widgets"
import { useExemplarState } from "./use-exemplar-state"
import { ExemplarMarkDialog } from "./chat-exemplar-dialog"


export function getDeepChapterToggleButtonClass(enabled: boolean): string {
  return enabled
    ? "border-primary bg-primary text-primary-foreground elevation-1 hover:bg-primary/90 hover:text-primary-foreground"
    : "text-muted-foreground hover:text-foreground"
}


// F4-3（Round-3 评估）：隐藏标记编解码纯函数已拆至 ./chat-message-markers
//（chat-panel 拆分第 1 步）。本地 import 供内部调用点使用，并 re-export
// 保持既有 import 面不变。
import {
  appendContextUsageMarker,
  appendHiddenNovelSessionDebug,
  appendManagedDeepChapterDraftMarker,
  replaceManagedDeepChapterDraftMarker,
} from "./chat-message-markers"
export {
  appendContextUsageMarker,
  appendHiddenNovelSessionDebug,
  appendManagedDeepChapterDraftMarker,
  replaceManagedDeepChapterDraftMarker,
  type DeepChapterDraftMarker,
} from "./chat-message-markers"
// ChatPanel can be mounted from multiple layout entry points. Share stream runtime
// state across instances so stop/finalize always targets the active generation session.
const sharedAbortControllersRef: { current: Record<string, AbortController> } = { current: {} }
const sharedStreamSessionGuardRef = { current: createStreamSessionGuard() }
const sharedActiveStreamSessionsRef = { current: {} as Record<string, number> }
const sharedNovelManagedStopRef = { current: {} as Record<string, boolean> }
const sharedDeepChapterEnabledRef = { current: false }
// ①-7 审计修复（已由 C2 去猴补替代）：活跃 Rust CLI stream id 改由 transport 第一方
// 注册表 activeRustStreamIds() 维护（stream-start/end 广播 + 注册表快照）；UI 不再拦截
// __TAURI_INTERNALS__，也不维护第二张影子表——强制停止直接消费 transport 注册表。


export function ChatPanel() {
  const { t } = useTranslation()
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const streamingContents = useChatStore((s) => s.streamingContents)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const startStreaming = useChatStore((s) => s.startStreaming)
  const setStreamingContent = useChatStore((s) => s.setStreamingContent)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const markLastAssistantDiscarded = useChatStore((s) => s.markLastAssistantDiscarded)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const isConversationStreaming = useChatStore((s) => s.isConversationStreaming)
  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  // 当前活跃会话的流式内容
  const streamingContent = activeConversationId ? streamingContents[activeConversationId] ?? "" : ""
  // 当前活跃会话是否正在流式生成
  const isStreaming = activeConversationId ? isConversationStreaming(activeConversationId) : false

  const project = useWikiStore((s) => s.project)
  const novelMode = useWikiStore((s) => s.novelMode)
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const aiChatModel = useWikiStore((s) => s.aiChatModel)
  const setAiChatModel = useWikiStore((s) => s.setAiChatModel)
  const chatEditModeEnabled = useWikiStore((s) => s.chatEditModeEnabled)
  const setChatEditModeEnabled = useWikiStore((s) => s.setChatEditModeEnabled)
  const selectedFile = useWikiStore((s) => s.selectedFile)

  const abortControllersRef = sharedAbortControllersRef
  const streamSessionGuardRef = sharedStreamSessionGuardRef
  const activeStreamSessionsRef = sharedActiveStreamSessionsRef
  const novelManagedStopRef = sharedNovelManagedStopRef
  // POLISH-02 (odyssey-ui): scroll-to-bottom FAB visibility + auto-scroll lock
  // 由 useChatAutoScroll 统一管理（单一状态机真源；内联副本已删除）。
  const { scrollContainerRef, bottomRef, showScrollToBottom, scrollToBottom } = useChatAutoScroll({
    activeMessages,
    streamingContent,
    isStreaming,
    activeConversationId,
  })

  // ISS-20260709-010 (EC-004): 虚拟列表只渲染可见消息,避免 1000+ 消息全量
  // 挂载 ChatMessage + ReactMarkdown 解析拖垮滚动。measureElement 动态测高
  // (markdown 每条高度不一),estimateSize 200 仅作初次渲染前的占位估算。
  // getItemKey 用 msg.id 稳定 key,滚动时 virtualizer 复用 DOM。
  const virtualizer = useVirtualizer({
    getScrollElement: () => scrollContainerRef.current,
    count: activeMessages.length,
    estimateSize: () => 200,
    overscan: 4,
    getItemKey: (index) => activeMessages[index]?.id ?? `msg-${index}`,
  })

  const [chapterSaveState, setChapterSaveState] = useState<{
    conversationId: string
    messageId: string
    status: string
    isSaving: boolean
  } | null>(null)
  // C4 覆盖守卫 + Soul 注入确认弹窗（chat-panel 拆分 T3：收敛至 use-chat-confirm-dialogs）。
  const {
    pendingSoulDialog, closeSoulDialog, requestSoulDialog,
    pendingChapterOverwrite, closeChapterOverwriteDialog, requestChapterOverwriteConfirm,
  } = useChatConfirmDialogs()
  // EPIC-001 / TASK-005 / ADR-29: exemplar 标记 UI 状态（M1-3 切片：内聚块迁至 use-exemplar-state + chat-exemplar-dialog）。
  // C-001 Draft-first 例外 — 用户主动标记非 AI 产出，直写正式层。
  const {
    exemplarDialog, setExemplarDialog,
    exemplarMarkType, setExemplarMarkType,
    exemplarNote, setExemplarNote,
    exemplarCount, exemplarFeedback,
    exemplarList, exemplarDeleteConfirmId, setExemplarDeleteConfirmId,
    openExemplarDialogFromSelection, submitExemplarMark, deleteExemplar, submitExemplarABScore,
  } = useExemplarState({ project, selectedFile, formatError: (err) => formatOperationError(t, err) })
  const [deepChapterEnabled, setDeepChapterEnabledState] = useState(sharedDeepChapterEnabledRef.current)
  // Wave C6: 最近一次 buildContextPack 装配结果 —— ContextPackReplayPanel 决策回放用（只读展示，零副作用）。
  const [replayContextPack, setReplayContextPack] = useState<React.ComponentProps<typeof ContextPackReplayPanel>["pack"]>(null)
  const setDeepChapterEnabled = useCallback((nextValue: boolean | ((prev: boolean) => boolean)) => {
    /* v8 ignore next */
    const resolvedValue = typeof nextValue === "function"
      ? nextValue(sharedDeepChapterEnabledRef.current)
      : nextValue
    sharedDeepChapterEnabledRef.current = resolvedValue
    setDeepChapterEnabledState(resolvedValue)
  }, [])
  // Wave 3 (v2.5.0): 计划模式状态（面板开合 + 数据 + one-shot 附加）
  // chat-panel 拆分 T2：整块迁至 use-chat-planning（状态/ref/两个回调）。
  const {
    planningOpen, setPlanningOpen,
    planningPlan, setPlanningPlan,
    planningLoading, planningError,
    planningChapterRef, loadPlanning, openPlanning,
  } = useChatPlanning({ project })
  // R4 共识（deepseek+glm）: 「写入 Wiki」失败原先只 console.error，用户无任何失败反馈。
  const [writeWikiError, setWriteWikiError] = useState<string | null>(null)
  const [writeWikiOk, setWriteWikiOk] = useState(false)

  const getLatestAssistantDraftContext = useCallback(() => {
    /* v8 ignore next */
    if (!activeConversationId) return null
    const assistantMessage = [...activeMessages].reverse().find(
      (message) => message.role === "assistant" && !message.discarded,
    )
    if (!assistantMessage) return null
    return {
      assistantMessage,
      conversationId: activeConversationId,
      userRequest: findPreviousUserRequest(activeMessages, assistantMessage.id)?.trim() || "",
    }
  }, [activeConversationId, activeMessages])

  const executeSaveDraftAsChapter = useCallback(async (content: string): Promise<{ success: boolean; chapterNumber: number; chapterPath: string } | null> => {
    if (!project) return null
    const latestDraftContext = getLatestAssistantDraftContext()
    if (!latestDraftContext) return null
    const pp = normalizePath(project.path)
    setChapterSaveState({
      conversationId: latestDraftContext.conversationId,
      messageId: latestDraftContext.assistantMessage.id,
      status: "",
      isSaving: true,
    })
    try {
      const { content: cleanedContent, title: extractedTitle } = cleanGeneratedChapterContentWithTitle(
        getCopyableAssistantContent(content),
      )
      const selectedChapterNumber = await readSelectedChapterNumberForFile(selectedFile)
      const generatedTargetChapterNumber = detectGeneratedTargetChapterNumber(cleanedContent)
      const explicitTargetPath = generatedTargetChapterNumber ? await findChapterFileByNumber(pp, generatedTargetChapterNumber) : null
      const strategy = decideChapterSaveStrategy({
        selectedChapterNumber: selectedChapterNumber ?? null,
        generatedTargetChapterNumber,
        generatedTargetExists: Boolean(explicitTargetPath),
      })

      const targetChapterNumber = strategy.action === "direct_explicit_target_new"
        ? strategy.targetChapterNumber
        : await getNextChapterNumber(pp)
      const chapterTitle = extractedTitle || `Chapter ${targetChapterNumber}`

      const buildDraftContent = (chapterNumber: number, title: string, bodyContent: string) => {
        const now = todayStamp()
        const frontmatter = [
          "---",
          "type: chapter",
          `chapter_number: ${chapterNumber}`,
          "chapter_status: draft",
          `title: \"${title}\"`,
          `created: ${now}`,
          "---",
          "",
        ].join("\n")
        return `${frontmatter}${bodyContent}\n`
      }

      const chapterDir = `${pp}/wiki/chapters`
      await createDirectory(chapterDir)
      const chapterPath = `${chapterDir}/chapter-${String(targetChapterNumber).padStart(3, "0")}.md`
      // C4 覆盖守卫（CORR-012 落地，方案 a）：目标章节文件已存在且已有正文时，
      // 必须先经用户显式确认才允许覆盖；确认前不调用 accept 通道、不落盘。
      // 降级纪律：存在性查询失败不阻断写作（写入层仍会拒绝覆盖已定稿章节）；
      // 「存在但读不出正文」保守视为有正文，仍需人工确认。
      let existingTargetHasBody = false
      try {
        if (await fileExists(chapterPath)) {
          try {
            existingTargetHasBody = chapterMarkdownHasBody(await readFile(chapterPath))
          } catch {
            existingTargetHasBody = true
          }
        }
      } catch {
        existingTargetHasBody = false
      }
      if (existingTargetHasBody) {
        const overwriteConfirmed = await requestChapterOverwriteConfirm(targetChapterNumber)
        if (!overwriteConfirmed) {
          setChapterSaveState({
            conversationId: latestDraftContext.conversationId,
            messageId: latestDraftContext.assistantMessage.id,
            status: t("chat.overwriteCancelled"),
            isSaving: false,
          })
          return { success: false, chapterNumber: targetChapterNumber, chapterPath }
        }
      }
      const finalChapterContent = updateChapterStatus(
        buildDraftContent(targetChapterNumber, chapterTitle, cleanedContent),
        "final",
      )
      await commitAcceptedDeepChapterDraft({
        projectPath: pp,
        conversationId: latestDraftContext.conversationId,
        userRequest: latestDraftContext.userRequest || cleanedContent.slice(0, 80),
        chapterNumber: targetChapterNumber,
        chapterPath,
        finalChapterContent,
      })
      invalidateChapterCache(pp)
      useChatStore.getState().setMessages(
        useChatStore.getState().messages.map((message) =>
          message.id !== latestDraftContext.assistantMessage.id
            ? message
            : {
                ...message,
                content: replaceManagedDeepChapterDraftMarker(message.content, {
                  conversationId: latestDraftContext.conversationId,
                  draftStatus: "accepted",
                }),
              }),
      )

      let nextStatus = `已接受草稿并保存为 ${chapterTitle}`
      if (novelConfig.autoIngestOnSave) {
        const runtimeLlmConfig = resolveNovelModel(useWikiStore.getState().llmConfig, novelConfig, "extract")
        if (hasUsableLlm(runtimeLlmConfig)) {
          const [{ ingestChapter }, { defaultCanonDualWriteDeps }] = await Promise.all([
            import("@/lib/novel/chapter-ingest"),
            import("@/lib/novel/canon-dual-write"),
          ])
          const ingestResult = await ingestChapter(project.path, chapterPath, resolveReviewModel(), undefined, {
            canonDualWriteDeps: defaultCanonDualWriteDeps(),
          })
          if (!ingestResult.snapshot) {
            nextStatus = `已接受草稿并保存为 ${chapterTitle}，但章节摄取未完成`
          }
        } else {
          nextStatus = `已接受草稿并保存为 ${chapterTitle}，但未配置可用 AI 模型`
        }
      }
      setChapterSaveState({
        conversationId: latestDraftContext.conversationId,
        messageId: latestDraftContext.assistantMessage.id,
        status: nextStatus,
        isSaving: false,
      })
      useWikiStore.getState().setSelectedFile(chapterPath)

      await refreshProjectState(pp)
      useWikiStore.getState().setActiveView("wiki")
      return { success: true, chapterNumber: targetChapterNumber, chapterPath }
    } catch (error) {
      const message = toErrorMessage(error)
      setChapterSaveState({
        conversationId: latestDraftContext.conversationId,
        messageId: latestDraftContext.assistantMessage.id,
        status: t("chat.saveFailed", { message }),
        isSaving: false,
      })
      return { success: false, chapterNumber: 0, chapterPath: "" }
    } finally {
      setChapterSaveState((prev) => {
        if (
          !prev ||
          prev.conversationId !== latestDraftContext.conversationId ||
          prev.messageId !== latestDraftContext.assistantMessage.id
        ) {
          return prev
        }
        return { ...prev, isSaving: false }
      })
    }
  }, [getLatestAssistantDraftContext, novelConfig, project, refreshProjectState, requestChapterOverwriteConfirm, selectedFile, t])

  const handleSaveAsChapter = useCallback(async (content: string) => {
    await executeSaveDraftAsChapter(content)
  }, [executeSaveDraftAsChapter])

  const handleDiscardDraft = useCallback(async () => {
    if (!project) return
    const latestDraftContext = getLatestAssistantDraftContext()
    if (!latestDraftContext) return
    const pp = normalizePath(project.path)
    setChapterSaveState({
      conversationId: latestDraftContext.conversationId,
      messageId: latestDraftContext.assistantMessage.id,
      status: "",
      isSaving: true,
    })
    try {
      const cleanedContent = getCopyableAssistantContent(latestDraftContext.assistantMessage.content)
      const generatedTargetChapterNumber = detectGeneratedTargetChapterNumber(cleanedContent) ?? undefined
      await rejectDeepChapterDraft({
        projectPath: pp,
        conversationId: latestDraftContext.conversationId,
        userRequest: latestDraftContext.userRequest || "draft rejected",
        chapterNumber: generatedTargetChapterNumber,
      })
      useChatStore.getState().setMessages(
        useChatStore.getState().messages.map((message) =>
          message.id !== latestDraftContext.assistantMessage.id
            ? message
            : {
                ...message,
                content: replaceManagedDeepChapterDraftMarker(message.content, {
                  conversationId: latestDraftContext.conversationId,
                  draftStatus: "rejected",
                }),
              }),
      )
      markLastAssistantDiscarded()
      setChapterSaveState({
        conversationId: latestDraftContext.conversationId,
        messageId: latestDraftContext.assistantMessage.id,
        status: "已拒绝草稿",
        isSaving: false,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      setChapterSaveState({
        conversationId: latestDraftContext.conversationId,
        messageId: latestDraftContext.assistantMessage.id,
        status: t("chat.saveFailed", { message }),
        isSaving: false,
      })
    } finally {
      setChapterSaveState((prev) => {
        /* v8 ignore next */
        if (
          !prev ||
          prev.conversationId !== latestDraftContext.conversationId ||
          prev.messageId !== latestDraftContext.assistantMessage.id
        ) {
          return prev
        }
        return { ...prev, isSaving: false }
      })
    }
  }, [getLatestAssistantDraftContext, markLastAssistantDiscarded, project, t])

  // 架构-1（30 号审计）：status.json 真源跨进程监听（novel-status-changed）。
  // 打开项目后注册；事件触发时重读 status.json 并增量刷新项目状态，保证
  // 「继续未完成」恢复上下文与真源一致（外部/跨进程写入无需重开项目）。
  useEffect(() => {
    const pp = project?.path ? normalizePath(project.path) : null
    if (!pp) return
    // 防御：旧测试/mock 未提供新导出时降级为不订阅（导出兼容护栏）
    if (typeof subscribeStatusJson !== "function") return
    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribeStatusJson(pp, async () => {
      if (disposed) return
      await refreshProjectState(pp)
    }).then((un) => {
      if (disposed) un?.()
      else unlisten = un
    }).catch((err) => {
      // R4 共识（deepseek+glm）: 原先只有 .then，订阅失败成为未处理 rejection。
      logger.warn("ChatPanel", "subscribeStatusJson failed", {
        error: toErrorMessage(err),
      })
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [project?.path])

  // 注意：组件卸载时不 abort 流式请求，允许 AI 在后台继续生成
  // 聊天数据存在全局 Zustand store 中，切回来时仍可看到生成结果
  // 删除会话时会单独 abort 该会话的请求（见 abortConversationStream）

  // 切换会话时不再中断后台生成——每个会话独立运行

  const handleSend = useCallback(
    async (text: string) => {
      if (novelMode && !hasUsableLlm(llmConfig)) {
        addMessage("user", text)
        addMessage(
          "assistant",
          "还不能开始写作：没有可用的模型服务。请先打开设置，填写模型名和 API 地址或密钥；本地模型则填写服务地址。配好后再发送这条内容。",
        )
        return
      }
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }
      // 捕获当前会话 ID，确保 finalizeStream 保存到正确的会话
      const capturedConvId = convId

      addMessage("user", text)
      startStreaming(capturedConvId)
      const sessionId = streamSessionGuardRef.current.start(capturedConvId)
      activeStreamSessionsRef.current[capturedConvId] = sessionId

      // Build system prompt with wiki context using graph-enhanced retrieval
      const systemMessages: LLMMessage[] = []
      let queryRefs: { title: string; path: string }[] = []
      let langReminder: string | undefined
      const taskRoute = novelMode ? routeTask(text) : null
      const pp = project ? normalizePath(project.path) : ""
      // 会话内上次生成的章节号：未保存到章节库时也能正确推进“下一章”
      const lastGeneratedChapterNumber = novelMode && project
        ? detectLastGeneratedChapterNumber(
          useChatStore.getState().getActiveMessages()
            .filter((m) => m.role === "assistant" && !m.discarded)
            .map((m) => m.content),
        )
        : undefined
      const targetChapterNumber = novelMode && project && taskRoute
        ? await resolveTargetChapterNumberForChat({
          projectPath: pp,
          userRequest: text,
          routeIntent: taskRoute.intent,
          routeChapterNumber: taskRoute.chapterNumber,
          selectedFile,
          lastGeneratedChapterNumber,
        })
        : undefined
      const effectiveTaskRoute = taskRoute && targetChapterNumber
        ? {
          ...taskRoute,
          chapterNumber: targetChapterNumber,
          extractedParams: {
            ...taskRoute.extractedParams,
            chapterNumber: String(targetChapterNumber),
          },
        }
        : taskRoute
      // Wave 3 (v2.5.0): 计划面板目标章跟随最近一次深度章节请求（未发送过 → 0 = 全书视图）
      if (effectiveTaskRoute?.chapterNumber !== undefined) {
        planningChapterRef.current = effectiveTaskRoute.chapterNumber
      }
      const effectiveChatLlmConfig = resolveEffectiveChatLlmConfig({ aiChatModel, llmConfig, providerConfigs })
      const shouldUseEditMode = novelMode && chatEditModeEnabled && isChatEditRequest(text)
      const goldenThreeChapter = novelMode
        ? detectGoldenThreeChapterRequest(text, effectiveTaskRoute?.chapterNumber)
        : undefined
      const dismantlingDirective = novelMode && project
        ? await loadEnabledDismantlingDirective(pp).catch(() => "")
        : ""
      if (shouldUseEditMode) {
        await runChatEditMode({
          text,
          capturedConvId,
          sessionId,
          pp,
          selectedFile,
          effectiveChatLlmConfig,
          finalizeStream,
          appendStreamToken,
          abortControllersRef,
          activeStreamSessionsRef,
          streamSessionGuardRef,
        })
        return
      }
      const deepChapterEnabledNow = sharedDeepChapterEnabledRef.current
      if (novelMode && project && deepChapterEnabledNow) {
        const { runDeepChapterGeneration } = await import("@/lib/novel/deep-chapter-generation")
        // 多模型共识旁路：开启且配置了写作模型组时才加载共识执行器（懒加载，关闭状态零额外模块加载）
        const consensusActive =
          novelConfig.consensusEnabled && novelConfig.consensusWritingModels.some((m) => m.trim())
        const runGenerationFirst = consensusActive
          ? (await import("@/lib/novel/consensus-writing")).runDeepChapterGenerationConsensus
          : runDeepChapterGeneration
        const controller = new AbortController()
        const interruptedResumeCheckpoint = await loadNovelSessionStatus(pp)
          .then((status) => resolveInterruptedSessionResumeCheckpoint(status, {
            conversationId: capturedConvId,
            userRequest: text,
          }))
          .catch(() => undefined)
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
      const shouldUseQmQuaiSkill = effectiveTaskRoute != null && (
        effectiveTaskRoute.intent === "write_chapter" ||
        effectiveTaskRoute.intent === "continue_chapter" ||
        effectiveTaskRoute.intent === "rewrite_chapter"
      )
      const qmQuaiSystemPrompt = shouldUseQmQuaiSkill ? buildQmQuaiSystemPrompt() : ""
      // Pure greetings ("hi", "你好", "嗨") don't warrant running the whole
      // retrieval pipeline — it's slow, costs context, and drags in random
      // wiki pages the user clearly didn't ask about. Short-circuit with a
      // minimal system prompt and let the model reply conversationally.
      const greetingOnly = isGreeting(text)
      if (project && greetingOnly) {
        const outLang = getOutputLanguage(text)
        systemMessages.push({
          role: "system",
          content: [
            `你是项目「${project.name}」的资料库问答助手。`,
            "用户只是打了一个招呼，请用一两句话自然简短地回应。",
            "不要编造资料库内容，也不要假装已经检索过页面。如果用户想查询资料，请引导用户提出一个具体问题。",
            "",
            `请使用 ${outLang} 回复。`,
          ].join("\n"),
        })
        // Skip retrieval; queryRefs stays empty so no "Sources" chip is shown.
      } else if (project) {
        const pp = normalizePath(project.path)
        const dataVersion = useWikiStore.getState().dataVersion

        // ── Budget allocation (see context-budget.ts) ─────────
        // Page budget scales with the LLM's context window; we now
        // also reserve ~15% as headroom for the response so the
        // model isn't truncated mid-sentence on a packed prompt.
        const {
          indexBudget: INDEX_BUDGET,
          pageBudget: PAGE_BUDGET,
          maxPageSize: MAX_PAGE_SIZE,
        } = computeContextBudget(llmConfig.maxContextSize)

        const [rawIndex, purpose] = await Promise.all([
          readFile(`${pp}/wiki/index.md`).catch(() => ""),
          readFile(`${pp}/purpose.md`).catch(() => ""),
        ])

        // ── Phase 1: Tokenized search → top 10 ────────────────
        const searchResults = await searchWiki(pp, text, {
          rerank: true,
          topK: 10,
          rerankPurpose: "用于聊天问答时挑选最值得注入上下文的知识页面。",
        })
        const topSearchResults = searchResults.slice(0, 10)

        // ── Trim index by relevance if over budget ─────────────
        let index = rawIndex
        if (rawIndex.length > INDEX_BUDGET) {
          const tokens = tokenizeQuery(text)
          const lines = rawIndex.split("\n")
          const keptLines: string[] = []
          let keptSize = 0

          for (const line of lines) {
            const isHeader = line.startsWith("##")
            const lower = line.toLowerCase()
            const isRelevant = tokens.some((t) => lower.includes(t))

            if (isHeader || isRelevant) {
              if (keptSize + line.length + 1 <= INDEX_BUDGET) {
                keptLines.push(line)
                keptSize += line.length + 1
              }
            }
          }
          index = keptLines.join("\n")
          /* v8 ignore next */
          if (index.length < rawIndex.length) {
            index += "\n\n[...index trimmed to relevant entries...]"
          }
        }

        // ── Phase 2: Graph 1-level expansion ───────────────────
        // Note: Vector search (if enabled) is already merged into searchResults
        // by searchWiki() in search.ts — no duplicate code needed here.
        const { buildRetrievalGraph, getRelatedNodes } = await import("@/lib/graph-relevance")
        const graph = await buildRetrievalGraph(pp, dataVersion)
        const expandedIds = new Set<string>()
        const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
        const graphExpansions: { title: string; path: string; relevance: number }[] = []

        for (const result of topSearchResults) {
          const fileName = getFileName(result.path)
          const nodeId = fileName.replace(/\.md$/, "")
          const related = getRelatedNodes(nodeId, graph, 3)
          for (const { node, relevance } of related) {
            if (relevance < 2.0) continue
            if (searchHitPaths.has(node.path)) continue
            if (expandedIds.has(node.id)) continue
            expandedIds.add(node.id)
            graphExpansions.push({ title: node.title, path: node.path, relevance })
          }
        }
        graphExpansions.sort((a, b) => b.relevance - a.relevance)

        // ── Phase 3 & 4: Page budget control ───────────────────
        let usedChars = 0
        type PageEntry = { title: string; path: string; content: string; priority: number }
        const relevantPages: PageEntry[] = []

        const tryAddPage = async (title: string, filePath: string, priority: number): Promise<boolean> => {
          if (usedChars >= PAGE_BUDGET) return false
          try {
            const raw = await readFile(filePath)
            const relativePath = getRelativePath(filePath, pp)
            const truncated = raw.length > MAX_PAGE_SIZE
              ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
              : raw
            if (usedChars + truncated.length > PAGE_BUDGET) return false
            usedChars += truncated.length
            relevantPages.push({ title, path: relativePath, content: truncated, priority })
            return true
          } catch { return false }
        }

        // P0: Title matches
        for (const r of topSearchResults.filter((r) => r.titleMatch)) {
          await tryAddPage(r.title, r.path, 0)
        }
        // P1: Content matches
        for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
          await tryAddPage(r.title, r.path, 1)
        }
        // P2: Graph expansions
        for (const exp of graphExpansions) {
          await tryAddPage(exp.title, exp.path, 2)
        }
        // P3: Overview fallback
        if (relevantPages.length === 0) {
          await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
        }

        const pagesContext = relevantPages.length > 0
          ? relevantPages.map((p, i) =>
              `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
            ).join("\n\n---\n\n")
          : "(No wiki pages found)"

        const pageList = relevantPages.map((p, i) =>
          `[${i + 1}] ${p.title} (${p.path})`
        ).join("\n")

        const outLang = getOutputLanguage(text)

        let novelContextPreamble = ""
        if (novelMode && project && effectiveTaskRoute) {
          try {
            const taskDirective = buildTaskDirective(effectiveTaskRoute)
            const goldenDirective = buildGoldenThreeChapterDirective(goldenThreeChapter)
            const { buildContextPack, contextPackToPrompt } = await import("@/lib/novel/context-engine")
            const contextPack = await buildContextPack(pp, text, effectiveTaskRoute.chapterNumber).catch(() => ({
              task: text,
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
            }))
            // Wave C6: 接入 ContextPackReplayPanel —— 捕获本次装配结果供回放面板只读展示。
            setReplayContextPack(contextPack)
            if (contextPack.characterAuras.trim()) {
            const confirmed = await requestSoulDialog(contextPack.characterAuras)
            if (!confirmed) {
              streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
                finalizeStream("已取消本次生成，角色灵魂上下文未发送给模型。", undefined, capturedConvId)
                delete activeStreamSessionsRef.current[capturedConvId]
              })
              delete abortControllersRef.current[capturedConvId]
              return
            }
            }
            const novelConfig = useWikiStore.getState().novelConfig
            const budget = novelConfig.contextTokenBudget > 0 ? novelConfig.contextTokenBudget : undefined
            novelContextPreamble = contextPackToPrompt(contextPack, budget, {
              layeredRecall: "default",
              sectionCharBudget: 4000,
              hardInjectEnabled: novelConfig.hardInjectEnabled,
            })
            if (goldenDirective) {
              novelContextPreamble = goldenDirective + "\n" + novelContextPreamble
            }
            if (taskDirective) {
              novelContextPreamble = taskDirective + "\n" + novelContextPreamble
            }
          } catch (err) {
            // R4 共识（deepseek+glm）: 原先空 catch —— 小说上下文装配完全失败时零诊断。
            // 行为不变（仍继续生成），但降级必须留痕。
            logger.warn("ChatPanel", "novel context preamble build failed, continuing without it", {
              error: toErrorMessage(err),
            })
          }
        }

        // 固定前缀：技能、角色定位、章节输出规则、规则、Markdown 格式要求。
        // 这部分在一次会话/配置下稳定，打 cacheControl 让 Anthropic 跨会话命中
        // prompt cache；OpenAI/Google 等其他 provider 会自动折叠成字符串，不受影响。
        const stablePrefixParts = [
          qmQuaiSystemPrompt ? `## QM-QUAI 技能\n${qmQuaiSystemPrompt}` : "",
          novelMode
            ? "你是一个专业的小说写作助手。请根据提供的小说上下文包和章节内容，协助用户进行小说创作。"
            : "你是一个专业的资料库问答助手。请基于下方提供的资料内容回答问题。",
          "",
          novelMode
            ? [
                "## 小说章节输出规则",
                "- 如果用户要求生成、续写或改写章节，只输出可直接放入章节库的小说正文。",
                "- 正文第一行必须是章节标题，格式为：# 第X章 标题名（标题4-12字，概括本章核心内容）。",
                "- 不要输出资料说明、创作说明、免责声明、后续建议、引用列表或隐藏 cited 注释。",
                "- 不要在小说正文里写 [[资料名]]、[1]、[2] 这类资料引用标记。",
                "- 资料只作为内部参考，不能把资料库缺失、基于现有资料等元信息写进章节。",
              ].filter(Boolean).join("\n")
            : "",
          "",
          novelMode
            ? [
                "## 规则",
                "- 只能基于下方小说资料、上下文包和用户要求创作，不要编写解释性回答。",
                "- 如果资料不足，也要根据已有小说上下文自然续写，不要把“资料不足”写进正文。",
              ].join("\n")
            : [
                "## 规则",
                "- 只能基于下方编号资料页面回答。",
                "- 如果资料不足，请直接说明资料不足。",
                "- 引用资料页面时使用 [[页面名]] 格式。",
                "- 引用具体信息时使用页码标记，例如 [1]、[2]。",
                "- 回复末尾必须添加隐藏注释，列出你使用过的资料页码：",
                "  <!-- cited: 1, 3, 5 -->",
              ].join("\n"),
          "",
          "请使用清晰的 Markdown 格式。",
        ].filter(Boolean)

        // 动态部分：资料库目标、索引、页面、上下文包、语言规则。
        // 每次检索结果不同，不缓存。
        const dynamicParts = [
          purpose ? `## 资料库目标\n${purpose}` : "",
          index ? `## 资料库索引\n${index}` : "",
          relevantPages.length > 0 ? `## 页面列表\n${pageList}` : "",
          `## 资料页面\n\n${pagesContext}`,
          novelContextPreamble ? `\n${novelContextPreamble}` : "",
          dismantlingDirective ? `\n${dismantlingDirective}` : "",
          "",
          "---",
          "",
          `## ⚠️ 强制输出语言：${outLang}`,
          "",
          `你的整段回复必须使用 **${outLang}**。`,
          "即使上方资料内容使用其他语言，也不能影响你的回复语言。",
          `请忽略资料原文语言，只使用 ${outLang} 回复。`,
          `必要时，专有名词也应使用 ${outLang} 的常见译法或音译。`,
          "不要使用任何其他语言。本规则优先于其他所有指令。",
        ].filter(Boolean)

        const systemBlocks: { type: "text"; text: string; cacheControl?: boolean }[] = []
        if (stablePrefixParts.length > 0) {
          systemBlocks.push({ type: "text", text: stablePrefixParts.join("\n"), cacheControl: true })
        }
        /* v8 ignore next */
        if (dynamicParts.length > 0) {
          systemBlocks.push({ type: "text", text: dynamicParts.join("\n") })
        }

        systemMessages.push({
          role: "system",
          content: systemBlocks,
        })

        // Reminder injected later, right before the user's current message
        // (after history so it's the last system instruction the LLM sees).
        langReminder = buildLanguageReminder(text)

        // ── Agent mode: append file edit instructions if user has edit intent ──
        if (novelMode && systemMessages.length > 0) {
          const { detectEditIntent, buildAgentSystemSuffix } = await import("@/lib/novel/agent-parser")
          if (detectEditIntent(text)) {
            const lastSys = systemMessages[systemMessages.length - 1]
            /* v8 ignore next */
            if (lastSys) {
              const { readScopeFileContents } = await import("@/lib/novel/agent-tools")
              const filesWithContent = await readScopeFileContents(pp, "chapters")
              const fileContentStr = filesWithContent.length > 0
                ? `\n\n## 当前章节文件内容（供修改定位）\n${filesWithContent.map(f => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}`
                : "\n\n## 当前章节文件列表\n(暂无章节文件)"
              const suffix = buildAgentSystemSuffix("chapters") + fileContentStr
              if (typeof lastSys.content === "string") {
                lastSys.content += suffix
              /* v8 ignore next */
              } else if (Array.isArray(lastSys.content)) {
                // content 为 ContentBlock[] 时，追加为新的 text block（不缓存，
                // 因为文件内容动态），避免破坏前面的 cacheControl 断点。
                lastSys.content.push({ type: "text", text: suffix })
              }
            }
          }
        }

        const nextQueryPages = relevantPages.map((p) => ({ title: p.title, path: p.path }))
        setLastQueryPages(nextQueryPages)
        queryRefs = [...nextQueryPages]
      }

      // ── Conversation history with count limit ────────────────
      // Only include messages from the active conversation, last N messages
      const activeConvMessages = useChatStore.getState().getActiveMessages()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-maxHistoryMessages)

      // Prepend the language reminder onto the final user turn rather than
      // inserting a second {role:"system"} between history and the final
      // user message. vLLM / llama.cpp / Ollama drive their chat templates
      // from HF Jinja, and Qwen3-family templates enforce "system only at
      // index 0" — a mid-conversation system message gets rejected with
      // "System message must be at the beginning." (HTTP 400). OpenAI and
      // Anthropic are more lenient, but keeping a single system at the top
      // is the safest shape across every OpenAI-compatible backend.
      const historyMessages = chatMessagesToLLM(activeConvMessages)
      let llmMessages: LLMMessage[] = [...systemMessages, ...historyMessages]
      if (langReminder && historyMessages.length > 0) {
        const lastIdx = llmMessages.length - 1
        const last = llmMessages[lastIdx]
        /* v8 ignore next */
        if (last && last.role === "user") {
          llmMessages = [
            ...llmMessages.slice(0, lastIdx),
            { role: "user", content: `[${langReminder}]\n\n${last.content}` },
          ]
        }
      }

      const conversations = useChatStore.getState().conversations
      // 使用 capturedConvId 而非闭包中的 activeConversationId，防止切换会话后取错会话
      const activeConv = conversations.find(c => c.id === capturedConvId)
      const deAiMode = activeConv?.deAiMode ?? false
      if (deAiMode && llmMessages.length > 0) {
        const lastIdx = llmMessages.length - 1
        const last = llmMessages[lastIdx]
        /* v8 ignore next */
        if (last && last.role === "user" && typeof last.content === "string") {
          llmMessages = [
            ...llmMessages.slice(0, lastIdx),
            { role: "user", content: injectDeAiDirective(last.content, deAiMode) },
          ]
        }
      }

      const controller = new AbortController()
      abortControllersRef.current[capturedConvId] = controller

      let accumulated = ""
      let thinkingOpen = false

      const appendReasoning = (token: string) => {
        if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
        if (!token) return
        if (!thinkingOpen) {
          thinkingOpen = true
          accumulated += "<think>"
          appendStreamToken("<think>", capturedConvId)
        }
        accumulated += token
        appendStreamToken(token, capturedConvId)
      }

      const closeReasoning = () => {
        if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
        if (!thinkingOpen) return
        thinkingOpen = false
        accumulated += "</think>"
        appendStreamToken("</think>", capturedConvId)
      }

      await streamChat(
        effectiveChatLlmConfig,
        llmMessages,
        {
          onToken: (token) => {
            if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
            closeReasoning()
            accumulated += token
            appendStreamToken(token, capturedConvId)
          },
          onReasoningToken: appendReasoning,
          onDone: () => {
            streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
              closeReasoning()
              finalizeStream(accumulated, queryRefs, capturedConvId)
              delete activeStreamSessionsRef.current[capturedConvId]
              delete abortControllersRef.current[capturedConvId]
            })
          },
          onError: (err) => {
            streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
              // F-16 (CWE-532 / PAT-DC1-MSG-UI): err.message from the LLM transport
              // may carry provider endpoint URL / auth header — strip before surfacing
              // in the user-visible chat stream. Raw message logged to console only.
              // (Twin of ingest.ts:1532/1622 startIngest/executeIngestWrites sites,
              // PAT-G2 16th recurrence — chat-panel main stream was the missed twin.)
              const raw = toErrorMessage(err)
              console.error("[chat] stream error:", raw)
              const safe = raw.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(Bearer|Authorization|api[-_]?key)\s*[:=]?\s*[^\s"']+/gi, "[redacted]")
              finalizeStream(`出错：${safe}`, undefined, capturedConvId)
              delete activeStreamSessionsRef.current[capturedConvId]
              delete abortControllersRef.current[capturedConvId]
            })
          },
        },
        controller.signal,
        { reasoning: resolveUserVisibleReasoning(effectiveChatLlmConfig.reasoning) },
      )
    },
    [aiChatModel, llmConfig, providerConfigs, chatEditModeEnabled, addMessage, startStreaming, setStreamingContent, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages, requestSoulDialog, project, novelMode, selectedFile, planningPlan],
  )

  const handleStop = useCallback(() => {
    const convId = useChatStore.getState().activeConversationId
    if (!convId) return
    const sessionId = activeStreamSessionsRef.current[convId]
    const currentStreamingContent = useChatStore.getState().getStreamingContent(convId)
    abortControllersRef.current[convId]?.abort()
    if (novelManagedStopRef.current[convId] === true) {
      return
    }
    delete abortControllersRef.current[convId]
    if (sessionId !== undefined) {
      streamSessionGuardRef.current.stop(convId, sessionId, () => {
        finalizeStream(`${currentStreamingContent ? `${currentStreamingContent}\n\n` : ""}已停止生成。`, [], convId)
        delete activeStreamSessionsRef.current[convId]
      })
    }
  }, [finalizeStream, planningPlan])

  // ①-7 审计修复：强制终止（SIGKILL）— 绕过优雅 grace 窗口直接 kill Rust CLI 进程。
  const handleForceStop = useCallback(() => {
    const convId = useChatStore.getState().activeConversationId
    if (!convId) return
    // 先 abort HTTP fetch（同 handleStop）
    abortControllersRef.current[convId]?.abort()
    // C2 去猴补：直接调 transport 第一方API（注册表快照），不再手写 invoke；
    // streamId 由 transport onStatus("claude-cli:stream-start:<id>"/"claude-cli:stream-end:<id>")
    // 广播维护，__TAURI_INTERNALS__ 拦截已删除。
    // DEBUG#3 修复：kill 失败不再静默吞掉——记录并上屏告警，否则流看似已停但底层 CLI 仍在跑。
    let killFailed = 0
    if (isTauri()) {
      const killPromises = activeRustStreamIds().map(async (streamId: string) => {
        try {
          const { gracefulAbortStream } = await import("@/lib/claude-cli-transport")
          await gracefulAbortStream(streamId, 0)
        } catch (err) {
          killFailed += 1
          console.error("[chat] claude_cli_kill failed for", streamId, err)
        }
      })
      void Promise.all(killPromises).then(() => {
        if (killFailed > 0) {
          // DEBUG#6 修复：告警写入前确认目标会话仍存在，避免给已删除会话产生孤儿消息
          const convStillExists = useChatStore.getState().conversations.some((c) => c.id === convId)
          if (convStillExists) {
            finalizeStream(`强制终止已发出，但 ${killFailed} 个流未能确认终止（进程可能仍在运行）。`, [], convId)
          }
        }
      })
    }
    if (novelManagedStopRef.current[convId] === true) {
      return
    }
    delete abortControllersRef.current[convId]
    const sessionId = activeStreamSessionsRef.current[convId]
    const currentStreamingContent = useChatStore.getState().getStreamingContent(convId)
    if (sessionId !== undefined) {
      streamSessionGuardRef.current.stop(convId, sessionId, () => {
        finalizeStream(`${currentStreamingContent ? `${currentStreamingContent}\n\n` : ""}已强制终止生成。`, [], convId)
        delete activeStreamSessionsRef.current[convId]
      })
    }
  }, [finalizeStream])

  const handleRegenerate = useCallback(async () => {
    // 直接从 store 获取最新状态，避免闭包旧值
    const storeState = useChatStore.getState()
    if (storeState.streamingContents[storeState.activeConversationId ?? ""] !== undefined) return
    // Find the last user message in active conversation
    const active = storeState.getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Zustand set 是同步的，无需延迟，直接读取最新状态
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    /* v8 ignore next */
    if (lastUser) {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== lastUser.id),
      }))
    }
    // R4 共识（deepseek+glm）: 先把末条用户消息从 store 移除、再浮空调用 handleSend，
    // 一旦失败消息永久丢失且成为未处理 rejection。改为捕获失败并恢复该消息。
    try {
      await handleSend(lastUserMsg.content)
    } catch (err) {
      useChatStore.setState((s) =>
        s.messages.some((m) => m.id === lastUserMsg.id) ? {} : { messages: [...s.messages, lastUserMsg] }
      )
      logger.warn("ChatPanel", "regenerate failed; restored the removed user message", {
        error: toErrorMessage(err),
      })
    }
  }, [removeLastAssistantMessage, handleSend])

  const handleContinueNextChapter = useCallback(() => {
    if (isStreaming) return
    // 按设置中的单章目标字数生成提示词（issue #8）
    const lengthSpec = resolveChapterLengthSpec(useWikiStore.getState().novelConfig?.chapterTargetChars)
    const target = lengthSpec.targetChars
    // 下一章继续生成必须绑定到全新的会话，否则会与上一章已 accepted
    // 的 managed draft marker / session truth 混线，导致新一轮 deep-chapter
    // 结果无法形成独立的 status/draft artifact。
    createConversation()
    handleSend(`请根据当前小说上下文、记忆库、最新章节结尾、下一章推进建议和章纲，继续生成下一章正文。只输出可直接保存到章节库的小说正文，不要解释，不要列提纲。正文必须是完整章节，目标约 ${target} 字，建议 ${target - 200}-${target + 300} 字，低于 ${target - 400} 字视为未完成。`)
  }, [createConversation, handleSend, isStreaming])

  const handleAcceptAndContinueNextChapter = useCallback(async (content: string) => {
    const res = await executeSaveDraftAsChapter(content)
    if (!res || !res.success) return
    const nextChapterNumber = res.chapterNumber + 1
    createConversation()
    const lengthSpec = resolveChapterLengthSpec(useWikiStore.getState().novelConfig?.chapterTargetChars)
    const target = lengthSpec.targetChars
    handleSend(
      `请根据前情线索、人物认知、时间线与世界观设定，直接撰写第 ${nextChapterNumber} 章正文。保持人物性格连贯与伏笔呼应，目标字数约 ${target} 字。`
    )
  }, [createConversation, executeSaveDraftAsChapter, handleSend])

  const handleContinueUnfinished = useCallback(async (assistantMessage: DisplayMessage) => {
    if (isStreaming) return

    const effectiveChatLlmConfig = resolveEffectiveChatLlmConfig({ aiChatModel, llmConfig, providerConfigs })

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
  }, [isStreaming, createConversation, addMessage, startStreaming, setStreamingContent, llmConfig, aiChatModel, providerConfigs, finalizeStream])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    setWriteWikiError(null)
    setWriteWikiOk(false)
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      setWriteWikiOk(true)
      try {
        await refreshProjectState(pp)
      } catch {
        // ignore
      }
    } catch (err) {
      // R4 共识（deepseek+glm）: 失败必须上屏（原先仅 console.error）。
      setWriteWikiError(formatOperationError(t, err))
    }
  }, [project, llmConfig, refreshProjectState, t])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  // 删除会话时 abort 该会话的流式请求
  const abortConversationStream = useCallback((convId: string) => {
    abortControllersRef.current[convId]?.abort()
    delete abortControllersRef.current[convId]
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <ConversationTabs onAbortStream={abortConversationStream} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!activeConversationId ? (
          <ChatPanelEmptyState onSuggest={handleSend} />
        ) : (
          <>
            <div className="relative flex-1 overflow-hidden">
            <div
              ref={scrollContainerRef}
              // ISS-20260709-011 (RESP-001): @container 让 chat 消息区按容器宽度
              // (docked 侧栏窄 / 全宽宽) 自适应, 而非 viewport (sm:/md: 对 docked 侧栏
              // 无效, 因 viewport 可能仍宽)。Tailwind v4 原生 @container variant, 子组件
              // chat-message 用 @sm:/@md: 感知此容器宽度调气泡宽度+操作按钮排列。
              className="@container h-full overflow-y-auto px-3 py-2"
            >
              {/* key 强制在切换会话时重新挂载消息列表，避免旧会话内容残留 */}
              <div key={activeConversationId} className="flex flex-col">
                {/* ISS-20260709-010: 虚拟列表。内层 absolute 容器撑起
                    virtualizer.getTotalSize() 高度,每条消息 translateY 定位。
                    measureElement 测真实高度后 virtualizer 重算,无需 flex gap
                    (gap 在虚拟 spacer 间无效,改用每条 padding-bottom)。 */}
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    position: "relative",
                  }}
                >
                  {virtualizer.getVirtualItems().map((virtualItem) => {
                    const msg = activeMessages[virtualItem.index]
                    if (!msg) return null
                    const isLastAssistant = msg.role === "assistant" &&
                      !activeMessages.slice(virtualItem.index + 1).some((m) => m.role === "assistant")
                    const messageSaveState =
                      chapterSaveState &&
                      chapterSaveState.conversationId === msg.conversationId &&
                      chapterSaveState.messageId === msg.id
                        ? chapterSaveState
                        : null
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                          paddingBottom: "0.75rem",
                        }}
                      >
                        <ChatMessage
                          message={msg}
                          isLastAssistant={isLastAssistant && !isStreaming}
                          onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                          novelMode={novelMode}
                          projectPath={project?.path ?? null}
                          onSaveAsChapter={handleSaveAsChapter}
                          onAcceptAndContinueNext={isLastAssistant ? handleAcceptAndContinueNextChapter : undefined}
                          onDiscardDraft={isLastAssistant ? handleDiscardDraft : undefined}
                          onContinueNextChapter={isLastAssistant ? handleContinueNextChapter : undefined}
                          onContinueUnfinished={isLastAssistant ? () => handleContinueUnfinished(msg) : undefined}
                          saveStatus={messageSaveState?.status}
                          isSaving={messageSaveState?.isSaving ?? false}
                        />
                      </div>
                    )
                  })}
                </div>
                {isStreaming && <StreamingMessage content={streamingContent} />}
                <div ref={bottomRef} />
              </div>
            </div>
            {showScrollToBottom && (
              // POLISH-02 (odyssey-ui): scroll-to-bottom FAB. While streaming,
              // users often scroll up to re-read earlier context; the auto-scroll
              // lock correctly stops yanking them back down, but left no way to
              // return. This button snaps back to bottom and re-enables auto-scroll.
              // animate-in fade/zoom matches the dialog motion vocabulary.
              <button
                type="button"
                onClick={scrollToBottom}
                aria-label={t("chat.scrollToLatest")}
                className="animate-in fade-in-0 zoom-in-95 absolute bottom-3 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground elevation-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowDown className="h-4 w-4 shrink-0" />
              </button>
            )}
            </div>

            {/* Wave C6：ContextPack 决策回放 —— 只读展示最近一次 buildContextPack 装配轨迹。
                原生 <details> 折叠（默认收起，不干扰聊天主 UX）；仅 novelMode 且已有装配结果时渲染。 */}
            {novelMode && replayContextPack && (
              <details
                className="mx-3 mb-2 shrink-0 overflow-hidden rounded-lg border bg-background text-sm"
                data-testid="context-pack-replay-collapsible"
              >
                <summary className="cursor-pointer select-none list-none px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/40" role="note">
                  <span className="flex items-center gap-2">
                    ContextPack 决策回放（最近一次装配）
                    <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5">{t("chat.expandHint")}</span>
                  </span>
                </summary>
                <div className="px-3 pb-3">
                  <ContextPackReplayPanel pack={replayContextPack} />
                </div>
              </details>
            )}

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4 shrink-0" />
                  {t(novelMode ? "novel.chat.writeToWiki" : "chat.writeToWiki")}
                </Button>
                {writeWikiError ? (
                  <p role="alert" data-testid="write-wiki-error" className="mt-1 text-xs text-destructive">
                    {writeWikiError}
                  </p>
                ) : writeWikiOk ? (
                  <p role="status" data-testid="write-wiki-ok" className="mt-1 text-xs text-muted-foreground">
                    {t("chat.writeToWikiDone")}
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}

        <div className="shrink-0 border-t bg-background">
          {/* Wave 3 (v2.5.0): 计划面板（生成前一次性动作；关闭=取消不触发生成） */}
          {planningOpen && (
            <div className="px-3 pt-2">
              <PlanningPanel
                plan={planningPlan}
                loading={planningLoading}
                error={planningError}
                onRefresh={() => void loadPlanning(planningChapterRef.current)}
                onStartWriting={() => {
                  // plan 已在 state（面板数据即 planningPlan）；仅关闭面板进入 one-shot 待发状态
                  setPlanningOpen(false)
                }}
                onClose={() => setPlanningOpen(false)}
              />
            </div>
          )}
          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            onForceStop={handleForceStop}
            isStreaming={isStreaming}
            mentionEnabled={novelMode}
            footerControls={
              <TooltipProvider delay={200}>
                <div className="flex items-center justify-between gap-2 flex-nowrap overflow-x-auto">
                  <div className="flex items-center gap-2 flex-nowrap">
                    <ChatDockControls />
                    {novelMode ? (
                      <>
                        {/* EPIC-001 / TASK-005: 标记 Style Exemplar（C-001 用户标记锚点非自动生成） */}
                        <Tooltip>
                          <TooltipTrigger
                            render={(
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="relative"
                                onClick={openExemplarDialogFromSelection}
                                title={t("chat.markExemplar")}
                                aria-label={t("chat.markExemplar")}
                              />
                            )}
                          >
                            {/* ③-6 审计修复：计数徽标 */}
                            {exemplarCount > 0 ? (
                              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold leading-none text-primary-foreground" aria-label={`已标记 ${exemplarCount} 条范例`}>{exemplarCount}</span>
                            ) : null}
                            <TooltipContent>{t("chat.markExemplarUserAnchor")}</TooltipContent>
                          </TooltipTrigger>
                        </Tooltip>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-pressed={deepChapterEnabled}
                          className={getDeepChapterToggleButtonClass(deepChapterEnabled)}
                          onClick={() => setDeepChapterEnabled(!deepChapterEnabled)}
                          title={
                            deepChapterEnabled
                              ? "深章模式已激活（自动三级门控自愈与事实双写，点击关闭）"
                              : "开启深章模式（开启三级门控自愈、大纲细纲约束与沙箱草稿管理）"
                          }
                          aria-label={deepChapterEnabled ? "关闭深度模式" : "开启深度模式"}
                        >
                          <Brain className="h-4 w-4 shrink-0" />
                        </Button>
                        {/* Wave 3 (v2.5.0): 计划模式入口（生成前一次性动作，与直接生成并列） */}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-pressed={planningOpen}
                          className={getDeepChapterToggleButtonClass(planningOpen)}
                          onClick={() => (planningOpen ? setPlanningOpen(false) : openPlanning())}
                          title={planningOpen ? "关闭计划面板" : "打开计划面板"}
                          aria-label={planningOpen ? "关闭计划面板" : "打开计划面板"}
                        >
                          <ClipboardList className="h-4 w-4 shrink-0" />
                        </Button>
                        <Tooltip>
                          <TooltipTrigger
                            render={(
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-pressed={chatEditModeEnabled}
                                // VH-003 (odyssey-ui): edit-mode active was
                                // hardcoded amber-* with no dark/deep-blue
                                // variant — clashing with the adjacent
                                // deep-chapter toggle which uses primary tokens.
                                // Route through the same token-based helper so
                                // all "enabled mode" toggles share one visual
                                // language across the 3 themes.
                                className={getDeepChapterToggleButtonClass(chatEditModeEnabled)}
                                onClick={() => setChatEditModeEnabled(!chatEditModeEnabled)}
                                title={t("chat.editChapter", "编辑章节")}
                                aria-label={t("chat.editChapter", "编辑章节")}
                              />
                            )}
                          >
                            <FileEdit className="h-4 w-4 shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs leading-5">
                            {t("chat.editChapterTooltip")}
                          </TooltipContent>
                        </Tooltip>
                      </>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 flex-nowrap">
                    <ChatModelSelector
                      value={aiChatModel}
                      onChange={(model) => {
                        setAiChatModel(model)
                        void saveAiChatModel(model)
                      }}
                    />
                  </div>
                </div>
              </TooltipProvider>
            }
            placeholder={
              mode === "ingest"
                ? t(novelMode ? "novel.chat.ingestPlaceholder" : "chat.ingestPlaceholder")
                : novelMode && deepChapterEnabled
                  ? "输入章节写作指令（深章模式已激活，全自动门控自愈与沙箱管理）..."
                  : t(novelMode ? "novel.chat.typeAMessage" : "chat.typeAMessage")
            }
          />
        </div>
        <Dialog open={pendingSoulDialog.open} onOpenChange={/* v8 ignore next */ (open) => { if (!open) closeSoulDialog(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("chat.soulInjectTitle")}</DialogTitle>
              <DialogDescription>
                下列内容会进入本次写作上下文包。角色灵魂会增强人物气质、语言倾向和判断方式，但仍服从大纲、人物小传与当前剧情。
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-72 overflow-y-auto rounded-md border bg-muted/20 p-3 text-xs leading-6 text-muted-foreground whitespace-pre-wrap">
              {pendingSoulDialog.summary}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => closeSoulDialog(false)}>{t("chat.cancelThisGeneration")}</Button>
              <Button onClick={() => closeSoulDialog(true)}>{t("chat.continueGeneration")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* C4 覆盖守卫：目标章节已有正文 → 覆盖前必须显式确认（确认前不落盘） */}
        <Dialog open={pendingChapterOverwrite.open} onOpenChange={/* v8 ignore next */ (open) => { if (!open) closeChapterOverwriteDialog(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("chat.overwriteConfirmTitle")}</DialogTitle>
              <DialogDescription>
                {t("chat.overwriteConfirmBody", { chapter: pendingChapterOverwrite.chapterNumber })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" data-testid="chapter-overwrite-cancel" onClick={() => closeChapterOverwriteDialog(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" data-testid="chapter-overwrite-accept" onClick={() => closeChapterOverwriteDialog(true)}>
                {t("chat.overwriteConfirmAction")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <ExemplarMarkDialog
          dialog={exemplarDialog}
          markType={exemplarMarkType}
          note={exemplarNote}
          count={exemplarCount}
          feedback={exemplarFeedback}
          list={exemplarList}
          deleteConfirmId={exemplarDeleteConfirmId}
          t={t}
          onClose={() => setExemplarDialog({ open: false, text: "", chapterId: "" })}
          onMarkTypeChange={setExemplarMarkType}
          onNoteChange={setExemplarNote}
          onDeleteRequest={setExemplarDeleteConfirmId}
          onDeleteCancel={() => setExemplarDeleteConfirmId(null)}
          onDeleteConfirm={(id) => void deleteExemplar(id)}
          onABScore={(s, v) => void submitExemplarABScore(s, v)}
          onSubmit={() => void submitExemplarMark()}
        />
      </div>
    </div>
  )
}
