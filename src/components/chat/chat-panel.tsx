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
import { useSourceFiles } from "./chat-shared"
import { ChatInput } from "./chat-input"
import { PlanningPanel } from "./planning-panel"
import { ChatModelSelector } from "./chat-model-selector"
import { useChatStore, chatMessagesToLLM, type DisplayMessage } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { chapterMarkdownHasBody, resolveChapterLengthSpec, routeTask, detectLastGeneratedChapterNumber, findChapterFileByNumber, getNextChapterNumber, invalidateChapterCache, readSelectedChapterNumberForFile, resolveTargetChapterNumberForChat, injectDeAiDirective, cleanGeneratedChapterContentWithTitle, resolveNovelModel, resolveReviewModel, detectGoldenThreeChapterRequest, isChatEditRequest, updateChapterStatus, decideChapterSaveStrategy, detectGeneratedTargetChapterNumber, commitAcceptedDeepChapterDraft, rejectDeepChapterDraft, resolveInterruptedSessionResumeCheckpoint, loadNovelSessionStatus, subscribeStatusJson } from "@/lib/novel"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { activeRustStreamIds } from "@/lib/claude-cli-transport"
import { executeIngestWrites } from "@/lib/ingest"
import { readFile, createDirectory, fileExists } from "@/commands/fs"
// C4 覆盖守卫：目标章节 Markdown 是否有正文的纯函数（chapter-save-strategy 模块）。
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectState } from "@/lib/project-refresh"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { saveAiChatModel } from "@/lib/project-store"
import { isTauri } from "@/lib/platform"
import { createStreamSessionGuard } from "./stream-session"
import { useChatAutoScroll } from "./use-chat-scroll"
import { resolveEffectiveChatLlmConfig } from "./chat-panel-llm-config"
import { useChatPlanning } from "./use-chat-planning"
import { useChatConfirmDialogs } from "./use-chat-confirm-dialogs"
import { runChatEditMode } from "./chat-panel-edit-mode"
import { runDeepChapterSend } from "./chat-panel-deep-chapter"
import { assembleChatContext } from "./chat-panel-context-assembly"
import { runContinueUnfinished } from "./chat-panel-continue-unfinished"
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
import { replaceManagedDeepChapterDraftMarker } from "./chat-message-markers"
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
        const interruptedResumeCheckpoint = await loadNovelSessionStatus(pp)
          .then((status) => resolveInterruptedSessionResumeCheckpoint(status, {
            conversationId: capturedConvId,
            userRequest: text,
          }))
          .catch(() => undefined)
        await runDeepChapterSend({
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
          interruptedResumeCheckpoint,
          autoResumedFromStatus: Boolean(interruptedResumeCheckpoint),
          resumeCheckpoint: interruptedResumeCheckpoint,
        })
        return
      }
      const systemMessages: LLMMessage[] = []
      let queryRefs: { title: string; path: string }[] = []
      let langReminder: string | undefined
      if (project) {
        const contextResult = await assembleChatContext({
          text,
          project,
          novelMode,
          effectiveTaskRoute,
          goldenThreeChapter,
          dismantlingDirective,
          llmConfig,
          requestSoulDialog,
          setReplayContextPack,
        })
        if (contextResult.cancelled) {
          streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
            finalizeStream(contextResult.message, undefined, capturedConvId)
            delete activeStreamSessionsRef.current[capturedConvId]
          })
          delete abortControllersRef.current[capturedConvId]
          return
        }
        systemMessages.push(...contextResult.systemMessages)
        queryRefs = contextResult.queryRefs
        langReminder = contextResult.langReminder
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
    const effectiveChatLlmConfig = resolveEffectiveChatLlmConfig({ aiChatModel, llmConfig, providerConfigs })
    await runContinueUnfinished({
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
    })
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
