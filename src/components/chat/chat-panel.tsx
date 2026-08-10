// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useRef, useEffect, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { BookOpen, Brain, Plus, Trash2, FileEdit, Sparkles, ArrowDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ChatMessage, StreamingMessage } from "./chat-message"
import { ChatDockControls } from "./chat-dock-controls"
import { setLastQueryPages, useSourceFiles } from "./chat-shared"
import { ChatInput } from "./chat-input"
import { ChatModelSelector } from "./chat-model-selector"
import { useChatStore, chatMessagesToLLM, type DisplayMessage } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { resolveChapterLengthSpec } from "@/lib/novel/deep-chapter-prompts"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { executeIngestWrites } from "@/lib/ingest"
import { routeTask, buildTaskDirective } from "@/lib/novel/task-router"
import { readFile, writeFile, createDirectory, deleteFile } from "@/commands/fs"
import {
  markStyleExemplarViaRust,
  loadStyleExemplarsViaRust,
  type StyleExemplarMarkType,
} from "@/commands/exemplar"
import { appendExemplarABSample, exemplarABStats, loadCognitionState } from "@/lib/novel/character-cognition"
import { searchWiki, tokenizeQuery } from "@/lib/search"
import { detectLastGeneratedChapterNumber, findChapterFileByNumber, getNextChapterNumber, invalidateChapterCache, readSelectedChapterNumberForFile, resolveTargetChapterNumberForChat } from "@/lib/novel/chapter-utils"
import { buildQmQuaiSystemPrompt, injectDeAiDirective } from "@/lib/novel/de-ai-adapter"
import { cleanGeneratedChapterContentWithTitle } from "@/lib/novel/chapter-content-cleanup"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { refreshProjectState } from "@/lib/project-refresh"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"
import { getConversationTabTitle, sortConversationsByUpdatedAt } from "@/lib/workspace-layout"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { createDeepThinkingStreamRenderer } from "@/lib/deep-thinking-stream"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { resolveNovelModel } from "@/lib/novel/model-resolver"
import { resolveReviewModel } from "@/lib/novel/review-model"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { LLM_PRESETS } from "@/components/settings/llm-presets"
import { saveAiChatModel } from "@/lib/project-store"
import {
  buildGoldenThreeChapterDirective,
  detectGoldenThreeChapterRequest,
} from "@/lib/novel/golden-three-chapters"
import { createStreamSessionGuard } from "./stream-session"
import {
  appendContinueUnfinishedDeepChapterContext,
  buildInterruptedResumeContextPayload,
  buildContinueUnfinishedDeepChapterPrompt,
  extractContinueUnfinishedDeepChapterContext,
  stripContinueUnfinishedDeepChapterContext,
} from "./chat-resume"
import { getCopyableAssistantContent } from "@/lib/chat-copy-content"
import { isChatEditRequest, resolveChatEditTarget, validateStructuredChapterEditResult } from "@/lib/novel/chat-edit-mode"
import { backupChapterFile } from "@/lib/novel/chapter-backup"
import { updateChapterStatus } from "@/lib/novel/chapter-meta"
import { decideChapterSaveStrategy, detectGeneratedTargetChapterNumber } from "@/lib/novel/chapter-save-strategy"
import { normalizeChapterEditFile } from "@/lib/novel/chapter-edit-file"
import { commitAcceptedDeepChapterDraft } from "@/lib/novel/formal-writeback"
import {
  blockDeepChapterSession,
  completeDeepChapterSession,
  createNovelSessionId,
  loadNovelSessionStatus,
  novelSessionStatusPath,
  pauseDeepChapterSession,
  persistDeepChapterCheckpoint,
  rejectDeepChapterDraft,
  resolveInterruptedSessionResumeCheckpoint,
  startDeepChapterSession,
} from "@/lib/novel/novel-session-status"

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function getDeepChapterToggleButtonClass(enabled: boolean): string {
  return enabled
    ? "border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground"
    : "text-muted-foreground hover:text-foreground"
}

function findPreviousUserRequest(messages: DisplayMessage[], assistantMessageId: string): string | undefined {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId)
  const searchRange = assistantIndex >= 0 ? messages.slice(0, assistantIndex) : messages
  const userMessages = [...searchRange].reverse().filter((message) => message.role === "user")
  return userMessages.find((message) => message.content.trim() !== "继续未完成")?.content ?? userMessages[0]?.content
}

async function loadEnabledDismantlingDirective(projectPath: string): Promise<string> {
  void projectPath
  return ""
}
function appendHiddenNovelSessionDebug(content: string, debug: Record<string, unknown>): string {
  try {
    return `${content}\n<!-- qmai-novel-session-debug:${encodeURIComponent(JSON.stringify(debug))} -->`
  } catch {
    return content
  }
}

function appendManagedDeepChapterDraftMarker(content: string, marker: {
  conversationId: string
  sessionId?: string
  draftStatus: "ready" | "accepted" | "rejected" | "pending" | "superseded"
}): string {
  try {
    return `${content}\n<!-- qmai-deep-chapter-draft:${encodeURIComponent(JSON.stringify(marker))} -->`
  } catch {
    return content
  }
}

function replaceManagedDeepChapterDraftMarker(content: string, marker: {
  conversationId: string
  sessionId?: string
  draftStatus: "ready" | "accepted" | "rejected" | "pending" | "superseded"
}): string {
  const withoutExisting = content.replace(/<!--\s*qmai-deep-chapter-draft:[\s\S]*?\s*-->/gi, "").trimEnd()
  return appendManagedDeepChapterDraftMarker(withoutExisting, marker)
}
// ChatPanel can be mounted from multiple layout entry points. Share stream runtime
// state across instances so stop/finalize always targets the active generation session.
const sharedAbortControllersRef = { current: {} as Record<string, AbortController> }
const sharedStreamSessionGuardRef = { current: createStreamSessionGuard() }
const sharedActiveStreamSessionsRef = { current: {} as Record<string, number> }
const sharedNovelManagedStopRef = { current: {} as Record<string, boolean> }
const sharedDeepChapterEnabledRef = { current: false }

function ConversationTabs({ onAbortStream }: { onAbortStream: (convId: string) => void }) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const streamingContents = useChatStore((s) => s.streamingContents)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // MI-009 (odyssey-ui): delete is destructive — two-step confirm so a stray
  // click (or a touch tap meant to switch tabs) can't silently wipe a
  // conversation. Single shared state keyed by conv id keeps the map flat.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const sorted = sortConversationsByUpdatedAt(conversations)

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  function handleDeleteConversation(convId: string, onAbortStream: (convId: string) => void) {
    onAbortStream(convId)
    deleteConversation(convId)
    const proj = useWikiStore.getState().project
    if (proj) {
      deleteFile(`${proj.path}/.qmai/chats/${convId}.json`).catch(() => {})
    }
    setConfirmDeleteId(null)
  }

  return (
    <div className="@container shrink-0 border-b bg-muted/20 px-2 py-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-2 rounded-full"
          onClick={() => createConversation()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t(novelMode ? "novel.chat.newChat" : "chat.newChat")}
        </Button>

        {sorted.length === 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(novelMode ? "novel.chat.noConversationsYet" : "chat.noConversationsYet")}
          </span>
        ) : (
          sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const isThisStreaming = conv.id in streamingContents
            const msgCount = getMessageCount(conv.id)
            return (
              <div
                key={conv.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                // IS-006/A11Y-008 (odyssey-ui): outer was a <button> with a
                // nested <span onClick> delete — nested interactive elements
                // are invalid HTML and the delete was keyboard-unreachable.
                // Switched to a div[role=tab] so the delete can be a real
                // focusable <button>. Enter/Space activates the tab (W3C ARIA
                // Pattern for tabs). focus-visible ring restored.
                className={`group flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  isActive
                    ? "border-primary/40 bg-background text-foreground shadow-sm"
                    : "border-border bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                onClick={() => setActiveConversation(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setActiveConversation(conv.id)
                  }
                }}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
                title={conv.title}
              >
                {isThisStreaming && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
                <span className="max-w-[140px] truncate font-medium">
                  {getConversationTabTitle(conv.title, 10)}
                </span>
                <span className="hidden text-[10px] tabular-nums text-muted-foreground @md:inline">{msgCount}</span>
                <span className="hidden text-[10px] tabular-nums text-muted-foreground @md:inline">{formatDate(conv.updatedAt)}</span>
                {/*
                 * MI-002/MI-009 (odyssey-ui): delete button.
                 * - Real <button> with aria-label (was <span onClick> — AT + keyboard blind).
                 * - Visible on hover AND focus-within AND when active, so touch users
                 *   who can't hover still get it on the active tab (touch fallback).
                 * - Two-step confirm: first click arms (icon → "确认?" text), second
                 *   click within the same tab deletes. Leaving the tab resets.
                 */}
                {(() => {
                  const armed = confirmDeleteId === conv.id
                  const visible = hoveredId === conv.id || isActive || armed
                  if (!visible) return null
                  return (
                    <button
                      type="button"
                      aria-label={armed ? "确认删除该会话" : "删除该会话"}
                      title={armed ? "再次点击确认删除" : "删除该会话"}
                      className={`shrink-0 rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                        armed
                          ? "bg-destructive/10 px-1.5 text-destructive"
                          : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (armed) {
                          handleDeleteConversation(conv.id, onAbortStream)
                        } else {
                          setConfirmDeleteId(conv.id)
                        }
                      }}
                      onBlur={() => setConfirmDeleteId((cur) => (cur === conv.id ? null : cur))}
                    >
                      {armed ? (
                        <span className="text-[10px] font-medium">确认?</span>
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </button>
                  )
                })()}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

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
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const soulDialogResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const userScrolledUpRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  // POLISH-02 (odyssey-ui): scroll-to-bottom FAB visibility. The ref tracks
  // auto-scroll lock for the streaming effect; this state mirrors it so the
  // FAB can reactively appear/disappear. Kept separate from the ref so the
  // streaming effect (which only reads the ref) doesn't re-render on every
  // scroll tick.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

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
  const [pendingSoulDialog, setPendingSoulDialog] = useState({ open: false, summary: "" })
  // EPIC-001 / TASK-005 / ADR-29: exemplar 标记 UI 状态。
  // C-001 Draft-first 例外 — 用户主动标记非 AI 产出，直写正式层。
  const [exemplarDialog, setExemplarDialog] = useState<{
    open: boolean
    text: string
    chapterId: string
  }>({ open: false, text: "", chapterId: "" })
  const [exemplarMarkType, setExemplarMarkType] = useState<StyleExemplarMarkType>("style")
  const [exemplarNote, setExemplarNote] = useState("")
  const [exemplarCount, setExemplarCount] = useState<number>(0)
  const [exemplarFeedback, setExemplarFeedback] = useState<string>("")
  const [deepChapterEnabled, setDeepChapterEnabledState] = useState(sharedDeepChapterEnabledRef.current)
  const setDeepChapterEnabled = useCallback((nextValue: boolean | ((prev: boolean) => boolean)) => {
    const resolvedValue = typeof nextValue === "function"
      ? nextValue(sharedDeepChapterEnabledRef.current)
      : nextValue
    sharedDeepChapterEnabledRef.current = resolvedValue
    setDeepChapterEnabledState(resolvedValue)
  }, [])
  const closeSoulDialog = useCallback((confirmed: boolean) => {
    const resolver = soulDialogResolverRef.current
    soulDialogResolverRef.current = null
    setPendingSoulDialog({ open: false, summary: "" })
    resolver?.(confirmed)
  }, [])

  const requestSoulDialog = useCallback((summary: string) => {
    setPendingSoulDialog({ open: true, summary })
    return new Promise<boolean>((resolve) => {
      soulDialogResolverRef.current = resolve
    })
  }, [])

  // EPIC-001 / TASK-005 / ADR-29: 从当前选段打开 exemplar 标记 Dialog。
  // 用 window.getSelection() 取选段文本（最小侵入 — 不改消息渲染结构）。
  // C-001 措辞：UI 明确标注「用户标记锚点」非自动生成。
  const openExemplarDialogFromSelection = useCallback(async () => {
    if (!project) return
    const selection = window.getSelection?.()
    const text = selection?.toString().trim() ?? ""
    if (!text) {
      setExemplarFeedback("请先在消息中选中一段文本")
      return
    }
    const pp = normalizePath(project.path)
    const chapterId = selectedFile ? getFileName(selectedFile) : "chat-selection"
    setExemplarDialog({ open: true, text, chapterId })
    setExemplarMarkType("style")
    setExemplarNote("")
    setExemplarFeedback("")
    // 刷新计数（标记前基线）
    try {
      const list = await loadStyleExemplarsViaRust(pp)
      setExemplarCount(list.length)
    } catch {
      // non-fatal — 计数失败不阻断标记
    }
  }, [project, selectedFile])

  // EPIC-001 / TASK-005: 提交 exemplar 标记 → Rust command 写 .novel/style-exemplars.json
  // （Draft-first 例外 C-001，直写正式层）+ 刷新计数。
  const submitExemplarMark = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await markStyleExemplarViaRust(pp, {
        chapterId: exemplarDialog.chapterId,
        text: exemplarDialog.text,
        markType: exemplarMarkType,
        note: exemplarNote.trim() || undefined,
      })
      const list = await loadStyleExemplarsViaRust(pp)
      setExemplarCount(list.length)
      setExemplarFeedback("已标记为用户锚点（非自动生成）")
      setExemplarDialog({ open: false, text: "", chapterId: "" })
    } catch (e) {
      setExemplarFeedback(`标记失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [project, exemplarDialog, exemplarMarkType, exemplarNote])

  // EPIC-001 / TASK-005: 提交文风主观评分（1-5 星）→ cognition-state.json A/B 埋点。
  // G-002 UI 埋点驱动 PM-03 文风一致性 ROI 可量化。
  const submitExemplarABScore = useCallback(async (score: number, variant: "enabled" | "disabled") => {
    if (!project) return
    const pp = normalizePath(project.path)
    await appendExemplarABSample(pp, {
      variant,
      score,
      chapterId: selectedFile ? getFileName(selectedFile) : "chat",
      timestamp: new Date().toISOString(),
    })
    const state = await loadCognitionState(pp)
    const stats = exemplarABStats(state)
    const enabledStr = stats.enabledAvg !== null ? stats.enabledAvg.toFixed(2) : "N/A"
    const disabledStr = stats.disabledAvg !== null ? stats.disabledAvg.toFixed(2) : "N/A"
    setExemplarFeedback(`已记录评分 ${score}★（${variant}）— enabled 均分 ${enabledStr} vs disabled ${disabledStr}`)
  }, [project, selectedFile])

  const getLatestAssistantDraftContext = useCallback(() => {
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

  const handleSaveAsChapter = useCallback(async (content: string) => {
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
      const { content: cleanedContent, title: extractedTitle } = cleanGeneratedChapterContentWithTitle(
        getCopyableAssistantContent(content),
      )
      const selectedChapterNumber = await readSelectedChapterNumberForFile(selectedFile)
      const generatedTargetChapterNumber = detectGeneratedTargetChapterNumber(cleanedContent)
      const explicitTargetPath = generatedTargetChapterNumber ? await findChapterFileByNumber(pp, generatedTargetChapterNumber) : null
      const strategy = decideChapterSaveStrategy({
        selectedChapterNumber: selectedChapterNumber ?? null,
        selectedChapterHasBody: false,
        generatedTargetChapterNumber,
        generatedTargetExists: Boolean(explicitTargetPath),
      })

      const targetChapterNumber = strategy.action === "direct_explicit_target_new"
        ? strategy.targetChapterNumber
        : await getNextChapterNumber(pp)
      const chapterTitle = extractedTitle || `Chapter ${targetChapterNumber}`

      const buildDraftContent = (chapterNumber: number, title: string, bodyContent: string) => {
        const now = new Date().toISOString().slice(0, 10)
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
          const { ingestChapter } = await import("@/lib/novel/chapter-ingest")
          const ingestResult = await ingestChapter(project.path, chapterPath, resolveReviewModel())
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setChapterSaveState({
        conversationId: latestDraftContext.conversationId,
        messageId: latestDraftContext.assistantMessage.id,
        status: t("chat.saveFailed", { message }),
        isSaving: false,
      })
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
  }, [getLatestAssistantDraftContext, novelConfig, project, selectedFile, t])

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
      const message = error instanceof Error ? error.message : String(error)
      setChapterSaveState({
        conversationId: latestDraftContext.conversationId,
        messageId: latestDraftContext.assistantMessage.id,
        status: t("chat.saveFailed", { message }),
        isSaving: false,
      })
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
  }, [getLatestAssistantDraftContext, markLastAssistantDiscarded, project, t])

  // 注意：组件卸载时不 abort 流式请求，允许 AI 在后台继续生成
  // 聊天数据存在全局 Zustand store 中，切回来时仍可看到生成结果
  // 删除会话时会单独 abort 该会话的请求（见 abortConversationStream）

  // Auto-scroll to bottom when messages change or streaming content updates
  // But stop if user manually scrolled up
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    if (!userScrolledUpRef.current) {
      container.scrollTop = container.scrollHeight
      lastScrollTopRef.current = container.scrollTop
    }
  }, [activeMessages, streamingContent])

  // Detect user scroll: if user scrolls up, stop auto-scroll; if at bottom, resume
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    lastScrollTopRef.current = container.scrollTop
    const handleScroll = () => {
      const threshold = 50
      const currentScrollTop = container.scrollTop
      const atBottom = container.scrollHeight - currentScrollTop - container.clientHeight < threshold
      if (currentScrollTop < lastScrollTopRef.current - 1) {
        userScrolledUpRef.current = true
      } else if (atBottom) {
        userScrolledUpRef.current = false
      }
      lastScrollTopRef.current = currentScrollTop
      setShowScrollToBottom(userScrolledUpRef.current)
    }
    container.addEventListener("scroll", handleScroll)
    return () => container.removeEventListener("scroll", handleScroll)
  }, [activeConversationId])

  // Reset scroll lock when streaming ends or conversation changes
  useEffect(() => {
    if (!isStreaming) {
      userScrolledUpRef.current = false
      setShowScrollToBottom(false)
    }
  }, [isStreaming])

  useEffect(() => {
    userScrolledUpRef.current = false
    setShowScrollToBottom(false)
  }, [activeConversationId])

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
    lastScrollTopRef.current = container.scrollTop
    userScrolledUpRef.current = false
    setShowScrollToBottom(false)
  }, [])

  // 切换会话时不再中断后台生成——每个会话独立运行

  const handleSend = useCallback(
    async (text: string) => {
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
      // AI 会话选中的 model 名（如 "deepseek-v3"）需要找到它所属的 provider
      // 重新计算 baseUrl/apiKey/apiMode，否则会沿用 activePresetId 的配置
      // 导致跨 provider 调用失败
      let effectiveChatLlmConfig = llmConfig
      if (aiChatModel.trim()) {
        const targetModel = aiChatModel.trim()
        // 优先按 "providerId/modelId" 格式精确匹配
        const slashIdx = targetModel.indexOf("/")
        if (slashIdx > 0) {
          const providerId = targetModel.slice(0, slashIdx)
          const modelId = targetModel.slice(slashIdx + 1)
          const override = providerConfigs[providerId]
          if (override?.savedModels?.some((m) => m.model === modelId)) {
            const template =
              LLM_PRESETS.find((p) => p.id === providerId) ??
              LLM_PRESETS.find((p) => p.id === "custom")
            if (template) {
              effectiveChatLlmConfig = {
                ...resolveConfig(template, override, llmConfig),
                model: modelId,
              }
            }
          } else {
            effectiveChatLlmConfig = { ...llmConfig, model: modelId }
          }
        } else {
          // 回退：按纯模型名匹配（兼容旧数据）
          let matched = false
          for (const [providerId, override] of Object.entries(providerConfigs)) {
            if (override.savedModels?.some((m) => m.model === targetModel)) {
              const template =
                LLM_PRESETS.find((p) => p.id === providerId) ??
                LLM_PRESETS.find((p) => p.id === "custom")
              if (template) {
                effectiveChatLlmConfig = {
                  ...resolveConfig(template, override, llmConfig),
                  model: targetModel,
                }
              }
              matched = true
              break
            }
          }
          if (!matched) {
            effectiveChatLlmConfig = { ...llmConfig, model: targetModel }
          }
        }
      }
      const shouldUseEditMode = novelMode && chatEditModeEnabled && isChatEditRequest(text)
      const goldenThreeChapter = novelMode
        ? detectGoldenThreeChapterRequest(text, effectiveTaskRoute?.chapterNumber)
        : undefined
      const dismantlingDirective = novelMode && project
        ? await loadEnabledDismantlingDirective(pp).catch(() => "")
        : ""
      if (shouldUseEditMode) {
        const resolvedTarget = resolveChatEditTarget({
          userRequest: text,
          selectedChapterNumber: await readSelectedChapterNumberForFile(selectedFile) ?? null,
        })
        if (!resolvedTarget.ok) {
          finalizeStream(resolvedTarget.message, [], capturedConvId)
          delete activeStreamSessionsRef.current[capturedConvId]
          return
        }

        const chapterPayloads = await Promise.all(
          resolvedTarget.target.chapterNumbers.map(async (chapterNumber) => {
            const chapterPath = await findChapterFileByNumber(pp, chapterNumber)
            if (!chapterPath) {
              return { chapterNumber, chapterPath: null, content: "" }
            }
            const original = await readFile(chapterPath).catch(() => "")
            return { chapterNumber, chapterPath, content: original }
          }),
        )

        if (chapterPayloads.some((item) => !item.chapterPath)) {
          const missing = chapterPayloads.filter((item) => !item.chapterPath).map((item) => item.chapterNumber).join("、")
          finalizeStream(`未找到以下章节，暂时无法执行修改：第${missing}章`, [], capturedConvId)
          delete activeStreamSessionsRef.current[capturedConvId]
          return
        }

        const editPrompt = [
          "你正在执行小说章节修改任务。",
          "请严格按照用户要求修改指定章节内容。",
          "如果是多章修改，必须逐章返回完整修改稿。",
          "输出格式必须严格如下：",
          "【第11章】",
          "修改后的完整正文",
          "",
          "【第12章】",
          "修改后的完整正文",
          "",
          "不要解释，不要补充说明。",
          "",
          `用户要求：${text}`,
          "",
          "待修改章节如下：",
          ...chapterPayloads.map((item) => `【第${item.chapterNumber}章原文】\n${item.content}`),
        ].join("\n")

        const controller = new AbortController()
        abortControllersRef.current[capturedConvId] = controller
        let editResult = ""
        let editError: Error | null = null

        await streamChat(
          effectiveChatLlmConfig,
          [{ role: "user", content: editPrompt }],
          {
            onToken: (token) => {
              if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
              editResult += token
              appendStreamToken(token, capturedConvId)
            },
            onDone: () => {},
            onError: (error) => {
              editError = error
            },
          },
          controller.signal,
          { reasoning: resolveUserVisibleReasoning(effectiveChatLlmConfig.reasoning) },
        )

        if (editError) {
          const editErrorMessage = String(editError)
          finalizeStream(`修改失败：${editErrorMessage}`, [], capturedConvId)
          delete activeStreamSessionsRef.current[capturedConvId]
          delete abortControllersRef.current[capturedConvId]
          return
        }

        const validatedEdits = resolvedTarget.target.mode === "single"
          ? {
            ok: true as const,
            files: [{
              chapterNumber: resolvedTarget.target.chapterNumbers[0],
              content: editResult,
            }],
          }
          : validateStructuredChapterEditResult({
            content: editResult,
            targetChapterNumbers: resolvedTarget.target.chapterNumbers,
          })

        if (!validatedEdits.ok) {
          finalizeStream(validatedEdits.message, [], capturedConvId)
          delete activeStreamSessionsRef.current[capturedConvId]
          delete abortControllersRef.current[capturedConvId]
          return
        }

        for (const chapter of chapterPayloads) {
          if (!chapter.chapterPath) continue
          const rawResult = validatedEdits.files.find((item) => item.chapterNumber === chapter.chapterNumber)?.content
          if (!rawResult) {
            finalizeStream(`第${chapter.chapterNumber}章缺少修改结果，已停止写回。`, [], capturedConvId)
            delete activeStreamSessionsRef.current[capturedConvId]
            delete abortControllersRef.current[capturedConvId]
            return
          }
          const normalizedResult = normalizeChapterEditFile({
            targetChapterNumber: chapter.chapterNumber,
            content: rawResult,
            originalContent: chapter.content,
          })
          if (!normalizedResult.ok) {
            finalizeStream(normalizedResult.message, [], capturedConvId)
            delete activeStreamSessionsRef.current[capturedConvId]
            delete abortControllersRef.current[capturedConvId]
            return
          }
          await backupChapterFile({
            projectPath: pp,
            chapterPath: chapter.chapterPath,
            chapterNumber: chapter.chapterNumber,
            content: chapter.content,
          })
          await writeFile(chapter.chapterPath, normalizedResult.content)
        }
        invalidateChapterCache(pp)

        await refreshProjectState(pp)
        if (chapterPayloads[0]?.chapterPath) {
          useWikiStore.getState().setSelectedFile(chapterPayloads[0].chapterPath)
        }
        finalizeStream(
          resolvedTarget.target.mode === "single"
            ? `已完成第${resolvedTarget.target.chapterNumbers[0]}章修改，并已自动备份原内容。`
            : `已完成 ${resolvedTarget.target.chapterNumbers.length} 个章节的批量修改，并已分别备份原内容。`,
          [],
          capturedConvId,
        )
        delete activeStreamSessionsRef.current[capturedConvId]
        delete abortControllersRef.current[capturedConvId]
        return
      }
      const deepChapterEnabledNow = sharedDeepChapterEnabledRef.current
      if (novelMode && project && deepChapterEnabledNow) {
        const { runDeepChapterGeneration } = await import("@/lib/novel/deep-chapter-generation")
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
          const generationResult = await runDeepChapterGeneration(
            {
              projectPath: pp,
              userRequest: text,
              chapterNumber: effectiveTaskRoute?.chapterNumber,
              goldenThreeChapter: goldenThreeChapter?.enabled ? goldenThreeChapter : undefined,
              dismantlingReferenceDirective: dismantlingDirective,
              llmConfig: effectiveChatLlmConfig,
              novelConfig,
              resumeCheckpoint: interruptedResumeCheckpoint,
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
                  checkpointPersistError = error instanceof Error ? error.message : String(error)
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
              errorMessage: `PARTIAL_DRAFT_PRESERVED: ${generationResult.partialReason ?? "transport inactivity timeout"} — 已保留部分正文，可用“继续未完成”恢复。`,
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
              appendManagedDeepChapterDraftMarker(accumulated, {
                conversationId: capturedConvId,
                sessionId: novelSessionId,
                draftStatus: generationResult.manualReviewRequired
                  ? "pending"
                  : generationResult.partial
                    ? "pending"
                    : "ready",
              }),
              [],
              capturedConvId,
            )
            delete activeStreamSessionsRef.current[capturedConvId]
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          sessionDebug.errorMessage = message
          sessionDebug.abortRequested = controller.signal.aborted
          const existing = deepStream.getContent()
          let pausePersistError: string | null = null
          if (!novelSessionId) {
            novelSessionId = createNovelSessionId()
            sessionDebug.syntheticSessionId = novelSessionId
          }
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
              pausePersistError = persistError instanceof Error ? persistError.message : String(persistError)
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
                checkpointPersistError ? `checkpoint 落盘失败：${checkpointPersistError}` : "",
                pausePersistError ? `pause 落盘失败：${pausePersistError}` : "",
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
            })
            if (goldenDirective) {
              novelContextPreamble = goldenDirective + "\n" + novelContextPreamble
            }
            if (taskDirective) {
              novelContextPreamble = taskDirective + "\n" + novelContextPreamble
            }
          } catch {}
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
            if (lastSys) {
              const { readScopeFileContents } = await import("@/lib/novel/agent-tools")
              const filesWithContent = await readScopeFileContents(pp, "chapters")
              const fileContentStr = filesWithContent.length > 0
                ? `\n\n## 当前章节文件内容（供修改定位）\n${filesWithContent.map(f => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}`
                : "\n\n## 当前章节文件列表\n(暂无章节文件)"
              const suffix = buildAgentSystemSuffix("chapters") + fileContentStr
              if (typeof lastSys.content === "string") {
                lastSys.content += suffix
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
              const raw = err instanceof Error ? err.message : String(err)
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
    [aiChatModel, llmConfig, providerConfigs, chatEditModeEnabled, addMessage, startStreaming, setStreamingContent, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages, requestSoulDialog, project, novelMode, selectedFile],
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
    if (lastUser) {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== lastUser.id),
      }))
    }
    handleSend(lastUserMsg.content)
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

  const handleContinueUnfinished = useCallback(async (assistantMessage: DisplayMessage) => {
    if (isStreaming) return

    // AI 会话选中的 model 名（如 "deepseek-v3"）需要找到它所属的 provider
    // 重新计算 baseUrl/apiKey/apiMode，否则会沿用 activePresetId 的配置
    // 导致跨 provider 调用失败
    let effectiveChatLlmConfig = llmConfig
    if (aiChatModel.trim()) {
      const targetModel = aiChatModel.trim()
      // 优先按 "providerId/modelId" 格式精确匹配
      const slashIdx = targetModel.indexOf("/")
      if (slashIdx > 0) {
        const providerId = targetModel.slice(0, slashIdx)
        const modelId = targetModel.slice(slashIdx + 1)
        const override = providerConfigs[providerId]
        if (override?.savedModels?.some((m) => m.model === modelId)) {
          const template =
            LLM_PRESETS.find((p) => p.id === providerId) ??
            LLM_PRESETS.find((p) => p.id === "custom")
          if (template) {
            effectiveChatLlmConfig = {
              ...resolveConfig(template, override, llmConfig),
              model: modelId,
            }
          }
        } else {
          effectiveChatLlmConfig = { ...llmConfig, model: modelId }
        }
      } else {
        // 回退：按纯模型名匹配（兼容旧数据）
        let matched = false
        for (const [providerId, override] of Object.entries(providerConfigs)) {
          if (override.savedModels?.some((m) => m.model === targetModel)) {
            const template =
              LLM_PRESETS.find((p) => p.id === providerId) ??
              LLM_PRESETS.find((p) => p.id === "custom")
            if (template) {
              effectiveChatLlmConfig = {
                ...resolveConfig(template, override, llmConfig),
                model: targetModel,
              }
            }
            matched = true
            break
          }
        }
        if (!matched) {
          effectiveChatLlmConfig = { ...llmConfig, model: targetModel }
        }
      }
    }

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

        const generationResult = await runDeepChapterGeneration(
          {
            projectPath: pp,
            userRequest: originalRequest,
            chapterNumber: resumeRoute?.chapterNumber,
            goldenThreeChapter: goldenResume?.enabled ? goldenResume : undefined,
            dismantlingReferenceDirective: dismantlingDirective,
            llmConfig: effectiveChatLlmConfig,
            novelConfig,
            resumeCheckpoint,
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
                checkpointPersistError = error instanceof Error ? error.message : String(error)
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
            errorMessage: `PARTIAL_DRAFT_PRESERVED: ${generationResult.partialReason ?? "transport inactivity timeout"} — 已保留部分正文，可再次“继续未完成”恢复。`,
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
           }))
           const budget = novelConfig.contextTokenBudget > 0 ? novelConfig.contextTokenBudget : undefined
           const dismantlingDirective = await loadEnabledDismantlingDirective(pp).catch(() => "")
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
          appendManagedDeepChapterDraftMarker(
            accumulated || "继续未完成失败：模型没有返回内容。",
            {
              conversationId: convId,
              sessionId: novelSessionId,
              draftStatus: "ready",
            },
          ),
          [],
          convId,
        )
        delete activeStreamSessionsRef.current[convId]
        delete abortControllersRef.current[convId]
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      let pausePersistError: string | null = null
      if (project && originalRequest?.trim()) {
        if (!novelSessionId) {
          novelSessionId = createNovelSessionId()
          if (continueSessionDebug) {
            continueSessionDebug.syntheticSessionId = novelSessionId
          }
        }
      }
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
          pausePersistError = persistError instanceof Error ? persistError.message : String(persistError)
          if (continueSessionDebug) {
            continueSessionDebug.pauseWrite = { error: pausePersistError }
          }
          console.warn("继续未完成暂停状态落盘失败:", persistError)
        }
      }
      streamSessionGuardRef.current.finish(convId, sessionId, () => {
        const persistenceDetails = pausePersistError ? `\n\n状态写回异常：pause 落盘失败：${pausePersistError}` : ""
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
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      try {
        await refreshProjectState(pp)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("写入 wiki 失败:", err instanceof Error ? err.message : String(err))
    }
  }, [project, llmConfig])

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
          // POLISH-08/D2 (odyssey-ui): empty state was a passive icon + two
          // muted lines with opacity-stacked text (A11Y-002 contrast hit).
          // Replaced with an actionable hero: token-colored icon, readable
          // copy, and suggestion chips that one-click create+a conversation
          // (handleSend auto-creates the conversation). Turns a dead-end into
          // an on-ramp — especially important for first-run users who don't
          // yet know what the chat can do.
          <div className="flex flex-1 items-center justify-center bg-muted/20 p-6">
            <div className="w-full max-w-md text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <h3 className="text-base font-medium text-foreground">
                {t(novelMode ? "novel.chat.startNewConversation" : "chat.startNewConversation")}
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t(novelMode ? "novel.chat.clickNewChatToBegin" : "chat.clickNewChatToBegin")}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {(novelMode
                  ? [
                      "帮我梳理当前小说的世界观和主要矛盾",
                      "根据上一章结尾，构思下一章的冲突推进",
                      "分析主角当前的性格弧线和发展空间",
                    ]
                  : [
                      "总结一下当前项目的知识结构",
                      "这个概念和哪些实体有关联？",
                      "帮我对比这两个来源的观点差异",
                    ]
                ).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSend(suggestion)}
                    className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
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
                aria-label="滚动到最新消息"
                className="animate-in fade-in-0 zoom-in-95 absolute bottom-3 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            )}
            </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4" />
                  {t(novelMode ? "novel.chat.writeToWiki" : "chat.writeToWiki")}
                </Button>
              </div>
            )}
          </>
        )}

        <div className="shrink-0 border-t bg-background">
          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
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
                                onClick={openExemplarDialogFromSelection}
                                title="标记为 Style Exemplar"
                                aria-label="标记为 Style Exemplar"
                              />
                            )}
                          >
                            <TooltipContent>标记为 Style Exemplar（用户锚点）</TooltipContent>
                          </TooltipTrigger>
                        </Tooltip>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-pressed={deepChapterEnabled}
                          className={getDeepChapterToggleButtonClass(deepChapterEnabled)}
                          onClick={() => setDeepChapterEnabled(!deepChapterEnabled)}
                          title={deepChapterEnabled ? "关闭深度模式" : "开启深度模式"}
                          aria-label={deepChapterEnabled ? "关闭深度模式" : "开启深度模式"}
                        >
                          <Brain className="h-4 w-4" />
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
                                title="编辑章节"
                                aria-label="编辑章节"
                              />
                            )}
                          >
                            <FileEdit className="h-4 w-4" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs leading-5">
                            开启后，AI会话会读取当前章节或识别到的章节范围进行修改，并在写回前自动备份原内容。
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
                : t(novelMode ? "novel.chat.typeAMessage" : "chat.typeAMessage")
            }
          />
        </div>
        <Dialog open={pendingSoulDialog.open} onOpenChange={(open) => { if (!open) closeSoulDialog(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>本次写作将注入角色灵魂上下文</DialogTitle>
              <DialogDescription>
                下列内容会进入本次写作上下文包。角色灵魂会增强人物气质、语言倾向和判断方式，但仍服从大纲、人物小传与当前剧情。
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-72 overflow-y-auto rounded-md border bg-muted/20 p-3 text-xs leading-6 text-muted-foreground whitespace-pre-wrap">
              {pendingSoulDialog.summary}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => closeSoulDialog(false)}>取消本次生成</Button>
              <Button onClick={() => closeSoulDialog(true)}>继续生成</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* EPIC-001 / TASK-005 / ADR-29: exemplar 标记 UI（C-001 Draft-first 例外，用户标记锚点非自动生成） */}
        <Dialog open={exemplarDialog.open} onOpenChange={(open) => { if (!open) setExemplarDialog({ open: false, text: "", chapterId: "" }) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>标记为 Style Exemplar</DialogTitle>
              <DialogDescription>
                用户标记锚点（非自动生成）— 作为 de-AI 正向锚点经 contextPack 注入，Draft-first 例外直写正式层。
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/20 p-3 text-xs leading-6 text-foreground whitespace-pre-wrap">
              {exemplarDialog.text}
            </div>
            <div className="flex flex-col gap-2 text-xs">
              <label className="flex items-center gap-2">
                <span className="w-16 text-muted-foreground">markType</span>
                <select
                  className="rounded border bg-background px-2 py-1 text-xs"
                  value={exemplarMarkType}
                  onChange={(e) => setExemplarMarkType(e.target.value as StyleExemplarMarkType)}
                >
                  <option value="style">style — 整体文风</option>
                  <option value="voice">voice — 角色声线</option>
                  <option value="pacing">pacing — 叙事节奏</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">note（可选）</span>
                <textarea
                  className="rounded border bg-background px-2 py-1 text-xs"
                  rows={2}
                  value={exemplarNote}
                  onChange={(e) => setExemplarNote(e.target.value)}
                  placeholder="为什么这段是好文风锚点？"
                />
              </label>
              <div className="text-muted-foreground">
                当前项目已标记 exemplar：<span className="font-mono">{exemplarCount}</span> 条
              </div>
              {exemplarFeedback && (
                <div className="rounded bg-muted/40 px-2 py-1 text-xs text-foreground">{exemplarFeedback}</div>
              )}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
              <div className="flex gap-1">
                <span className="self-center text-xs text-muted-foreground">A/B 评分：</span>
                {[1, 2, 3, 4, 5].map((s) => (
                  <Button
                    key={`en-${s}`}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => submitExemplarABScore(s, "enabled")}
                    title="exemplar+slop 评分"
                  >
                    {s}★E
                  </Button>
                ))}
                {[1, 2, 3, 4, 5].map((s) => (
                  <Button
                    key={`dis-${s}`}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => submitExemplarABScore(s, "disabled")}
                    title="slop-only 评分"
                  >
                    {s}★D
                  </Button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setExemplarDialog({ open: false, text: "", chapterId: "" })}>取消</Button>
                <Button onClick={submitExemplarMark}>标记锚点</Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
