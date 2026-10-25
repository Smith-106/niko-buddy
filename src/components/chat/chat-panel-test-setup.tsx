// @vitest-environment jsdom
/**
 * W4 / CP-100: chat-panel.tsx 全口径覆盖 spec（目标 statements/branches/functions/lines 100%）。
 *
 * 策略（与 App.spec.tsx 同模式）：
 * - vi.hoisted 提供全部可写 mock state（chat/wiki 双 store 用可调用函数 + getState/setState）。
 * - 子组件（ChatMessage/StreamingMessage/ChatInput/ChatDockControls/ChatModelSelector）与
 *   UI 原语（Button/Dialog/Tooltip）全部轻量 mock，仅保留 props 布线，便于断言面板自身逻辑。
 * - lib 层全部 mock，动态 import（deep-chapter-generation / context-engine / graph-relevance /
 *   agent-parser / agent-tools / residual-campaign / chapter-ingest）同样被 vi.mock 覆盖。
 * - store 状态非响应式：测试在 act() 内改 state 后手动 rerender(<ChatPanel/>) 取最新快照。
 */

import { useState } from "react"
import { afterEach, beforeEach, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { ChatPanel } from "./chat-panel"

// ── 真实签名类型（仅类型导入，运行时被擦除；vi.mock 不受影响）──────────────
import type { ChatMessage, RequestOverrides, StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig, ProviderOverride, ReasoningConfig } from "@/stores/wiki-store"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"
import type { SearchResult, SearchWikiOptions } from "@/lib/search"
import type { RetrievalGraph, RetrievalNode } from "@/lib/graph-relevance"
import type { TaskRouteResult, CognitionState, ExemplarABSample, CleanedChapterContent, GoldenThreeChapterRequest, ChatEditTarget, ParsedChapterEditFile, ChapterSaveStrategy, NovelSessionStatus, DeepChapterGenerationCallbacks, DeepChapterGenerationDeps, DeepChapterGenerationInput, DeepChapterGenerationResumeCheckpoint, DeepChapterGenerationResult, DeepChapterDecisionGates, ResidualCampaignNovelConfigSlice, ResidualCampaignResolvedFields, BuildContextOptions, ContextPack, ContextPackToPromptOptions, IngestChapterOptions, IngestResult, ChapterLengthSpec, ResolveTargetChapterNumberForChatInput, NovelReviewResult, ModelResolverStoreSnapshot, NovelTaskType, ChapterStatus, CommitAcceptedDeepChapterDraftInput } from "@/lib/novel"
import type { MarkStyleExemplarInput, StyleExemplarRecord } from "@/commands/exemplar"
import type { ContinueUnfinishedDeepChapterContext } from "@/lib/chat/resume"
import type { QueryPageReference } from "./chat-shared"
import type { DeepThinkingStreamRenderer } from "@/lib/deep-thinking-stream"
import type { StreamSessionGuard } from "./stream-session"
import type { ContextBudget } from "@/lib/context-budget"
import type { LlmPreset } from "@/lib/llm-config/llm-presets"
import zhLocaleChatPanel from "@/i18n/zh.json"

export function lookupZhChatPanel(key: string): string | undefined {
  let o: unknown = zhLocaleChatPanel
  for (const p of key.split(".")) {
    if (o == null || typeof o !== "object") return undefined
    o = (o as Record<string, unknown>)[p]
  }
  return typeof o === "string" ? o : undefined
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 四-17：hoisted mock 仓不可直接 export（vitest 限制）——经 getter 暴露。 */
export function getChatPanelMocks() {
  return mocks
}

export interface ProjectLike {
  id: string
  name: string
  path: string
}

const mocks = vi.hoisted(() => {
  // ── 共享默认值（真实类型）───────────────────────────────────────────────────
  const emptyDecisionGates: DeepChapterDecisionGates = {
    consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    overall: "pass",
  }

  const sessionStatusBase: NovelSessionStatus = {
    schema_version: "1",
    session_id: "session-1",
    source: "deep_chapter_generation",
    created_at: "t",
    updated_at: "t",
    status: "paused",
    active_step_index: 1,
    current_task: {
      task_id: "tsk-conv-1",
      conversation_id: "conv-1",
      user_request: "需求",
      checkpoint_stage: "started",
      status: "paused",
    },
    draft: {
      draft_id: "draft-1",
      file_path: "/p/mybook/.novel/drafts/draft-1.md",
      draft_status: "pending",
      updated_at: "t",
    },
    decision_gates: emptyDecisionGates,
    evidence_refs: [],
  }

  const emptyDeepResult: DeepChapterGenerationResult = {
    finalContent: "FINAL",
    taskBrief: "",
    draftContent: "",
    reviewResults: [],
    revised: false,
    decisionGates: emptyDecisionGates,
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
  }

  const emptyResidualFields: ResidualCampaignResolvedFields = {
    residualOverallMedian: 9.0,
    residualRewriteMode: "structure_thril_pacing",
    residualLengthPreserving: true,
    chapterStructurePlan: {
      schemaVersion: "chapter-structure-plan/1.0",
      beats: [],
      thrilCheckpointCoverage: [],
      fix1NonSpoiler: true,
      source: "campaign",
    },
    chapterNumber: 3,
    residualBand: "residual_high",
    frozen: false,
    keepGate: "seal_stretch",
    l9Disposition: "seal_pass_below_test_control",
    sealMedian: 9,
    testControlMedian: 9.5,
    productHardGate: false,
  }

  const emptyContextBudget: ContextBudget = {
    strategy: "full",
    maxCtx: 204800,
    responseReserve: 30720,
    indexBudget: 5000,
    pageBudget: 2000,
    maxPageSize: 800,
    activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 }, hardInjectionBudget: { capChars: 3072, baselineChars: 3072 },
  }

  // ── chat store（可写、可调用）───────────────────────────────────────────────
  const chatState: Record<string, any> = {
    conversations: [],
    activeConversationId: null,
    messages: [],
    streamingContents: {},
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 20,
    createConversation: vi.fn(() => {
      chatState.activeConversationId = "conv-auto"
      return "conv-auto"
    }),
    deleteConversation: vi.fn((id: string) => {
      chatState.conversations = chatState.conversations.filter((c: any) => c.id !== id)
      chatState.messages = chatState.messages.filter((m: any) => m.conversationId !== id)
      const rest: Record<string, string> = { ...chatState.streamingContents }
      delete rest[id]
      chatState.streamingContents = rest
      if (chatState.activeConversationId === id) {
        chatState.activeConversationId = chatState.conversations[0]?.id ?? null
      }
    }),
    setActiveConversation: vi.fn((id: string | null) => {
      chatState.activeConversationId = id
    }),
    renameConversation: vi.fn(),
    setConversationDeAiMode: vi.fn(),
    setConversationInputDraft: vi.fn(),
    addMessage: vi.fn((role: string, content: string) => {
      const convId = chatState.activeConversationId ?? "conv-auto"
      chatState.messages = [
        ...chatState.messages,
        { id: `msg-${chatState.messages.length + 1}`, role, content, timestamp: Date.now(), conversationId: convId },
      ]
    }),
    setMessages: vi.fn((messages: any[]) => {
      chatState.messages = messages
    }),
    setConversations: vi.fn((conversations: any[]) => {
      chatState.conversations = conversations
    }),
    startStreaming: vi.fn((conversationId: string) => {
      chatState.streamingContents = { ...chatState.streamingContents, [conversationId]: "" }
    }),
    appendStreamToken: vi.fn((token: string, conversationId: string) => {
      chatState.streamingContents = {
        ...chatState.streamingContents,
        [conversationId]: (chatState.streamingContents[conversationId] ?? "") + token,
      }
    }),
    setStreamingContent: vi.fn((content: string, conversationId: string) => {
      chatState.streamingContents = { ...chatState.streamingContents, [conversationId]: content }
    }),
    finalizeStream: vi.fn((content: string, references: any, targetConvId?: string) => {
      const convId = targetConvId ?? chatState.activeConversationId
      if (!convId) return
      chatState.messages = [
        ...chatState.messages,
        {
          id: `msg-final-${chatState.messages.length + 1}`,
          role: "assistant",
          content,
          timestamp: Date.now(),
          conversationId: convId,
          references,
        },
      ]
      const rest: Record<string, string> = { ...chatState.streamingContents }
      delete rest[convId]
      chatState.streamingContents = rest
    }),
    clearStreaming: vi.fn((conversationId: string) => {
      const rest: Record<string, string> = { ...chatState.streamingContents }
      delete rest[conversationId]
      chatState.streamingContents = rest
    }),
    setMode: vi.fn((mode: string) => {
      chatState.mode = mode
    }),
    setIngestSource: vi.fn((source: string | null) => {
      chatState.ingestSource = source
    }),
    clearMessages: vi.fn(),
    setMaxHistoryMessages: vi.fn((n: number) => {
      chatState.maxHistoryMessages = n
    }),
    removeLastAssistantMessage: vi.fn(() => {
      const activeId = chatState.activeConversationId
      if (!activeId) return
      const convMsgs = chatState.messages.filter((m: any) => m.conversationId === activeId)
      const lastIdx = [...convMsgs].reverse().findIndex((m: any) => m.role === "assistant")
      if (lastIdx === -1) return
      const target = convMsgs[convMsgs.length - 1 - lastIdx]
      chatState.messages = chatState.messages.filter((m: any) => m.id !== target.id)
    }),
    markLastAssistantDiscarded: vi.fn(() => {
      const activeId = chatState.activeConversationId
      if (!activeId) return
      const convMsgs = chatState.messages.filter((m: any) => m.conversationId === activeId)
      const lastIdx = [...convMsgs].reverse().findIndex((m: any) => m.role === "assistant")
      if (lastIdx === -1) return
      const target = convMsgs[convMsgs.length - 1 - lastIdx]
      chatState.messages = chatState.messages.map((m: any) =>
        m.id === target.id ? { ...m, discarded: true, content: "" } : m,
      )
    }),
    getActiveMessages: vi.fn(() =>
      chatState.messages.filter((m: any) => m.conversationId === chatState.activeConversationId),
    ),
    isConversationStreaming: vi.fn((conversationId: string) => conversationId in chatState.streamingContents),
    getStreamingContent: vi.fn((conversationId: string) => chatState.streamingContents[conversationId] ?? ""),
    isAnyStreaming: vi.fn(() => Object.keys(chatState.streamingContents).length > 0),
  }

  // ── wiki store（可写、可调用）───────────────────────────────────────────────
  const wikiState: Record<string, any> = {
    project: null,
    novelMode: false,
    novelConfig: {
      autoIngestOnSave: false,
      residualCampaignEnabled: false,
      contextTokenBudget: 0,
      chapterTargetChars: 3000,
    },
    llmConfig: {
      provider: "openai",
      apiKey: "",
      model: "gpt-test",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
      reasoning: { mode: "auto" },
    },
    providerConfigs: {},
    aiChatModel: "",
    setAiChatModel: vi.fn((model: string) => {
      wikiState.aiChatModel = model
    }),
    chatEditModeEnabled: false,
    setChatEditModeEnabled: vi.fn((enabled: boolean) => {
      wikiState.chatEditModeEnabled = enabled
    }),
    selectedFile: null,
    dataVersion: 0,
    setSelectedFile: vi.fn(),
    setActiveView: vi.fn(),
  }

  const useChatStore = (selector: (s: any) => any) => selector(chatState)
  Object.assign(useChatStore, {
    getState: () => chatState,
    setState: (updater: any) => {
      const next = typeof updater === "function" ? updater(chatState) : updater
      Object.assign(chatState, next)
    },
  })

  const useWikiStore = (selector: (s: any) => any) => selector(wikiState)
  Object.assign(useWikiStore, { getState: () => wikiState })

  // ── 流式会话守卫（可翻转 isActive）─────────────────────────────────────────
  const streamGuard = {
    start: vi.fn<(conversationId: string) => number>(() => 1),
    isActive: vi.fn<(conversationId: string, sessionId: number) => boolean>(() => true),
    runIfActive: vi.fn<(conversationId: string, sessionId: number, callback: () => void) => void>(
      (_c: string, s: number, cb: () => void) => {
        if (streamGuard.isActive(_c, s)) cb()
      },
    ),
    finish: vi.fn<(conversationId: string, sessionId: number, callback: () => void) => void>(
      (_c: string, s: number, cb: () => void) => {
        if (streamGuard.isActive(_c, s)) cb()
      },
    ),
    stop: vi.fn<(conversationId: string, sessionId: number, callback: () => void) => void>(
      (_c: string, s: number, cb: () => void) => {
        if (streamGuard.isActive(_c, s)) cb()
      },
    ),
  }

  // ── 深度思考渲染器（可配置返回值）───────────────────────────────────────────
  const deepStreamRenderer = {
    updateThinking: vi.fn((content: string) => content),
    appendFinal: vi.fn((content: string) => content),
    getContent: vi.fn(() => ""),
  }

  // ── 虚拟列表 mock ────────────────────────────────────────────────────────────
  // 忠实模拟 @tanstack/react-virtual 的调用面：getScrollElement() 在初始化时调用、
  // estimateSize(index) 在估算每项高度时调用，否则 chat-panel 中对应闭包不会被执行。
  const useVirtualizer = vi.fn((opts: any) => {
    opts.getScrollElement?.()
    const count = opts.count
    const items = Array.from({ length: count }, (_v, i) => ({
      index: i,
      key: opts.getItemKey(i),
      start: i * 200,
      size: opts.estimateSize?.(i) ?? 200,
    }))
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * 200,
      measureElement: () => {},
    }
  })

  const t = vi.fn((key: string, opts?: { message?: string }) => {
    const base = lookupZhChatPanel(key) ?? key
    return opts?.message ? `${base}::${opts.message}` : base
  })

  return {
    chatState,
    wikiState,
    useChatStore,
    useWikiStore,
    streamGuard,
    deepStreamRenderer,
    useVirtualizer,
    t,

    // lib mocks（默认实现，可在测试内覆写；泛型签名与真实 export 对齐）
    streamChat: vi.fn<
      (
        config: LlmConfig,
        messages: ChatMessage[],
        callbacks: StreamCallbacks,
        signal?: AbortSignal,
        requestOverrides?: RequestOverrides,
      ) => Promise<void>
    >(async (_config: any, _messages: any, handlers: any) => {
      handlers?.onDone?.()
    }),
    chatMessagesToLLM: vi.fn<(messages: DisplayMessage[]) => ChatMessage[]>((messages: any[]) =>
      messages.map((m) => ({ role: m.role, content: m.content })),
    ),
    executeIngestWrites: vi.fn<
      (projectPath: string, llmConfig: LlmConfig, userGuidance?: string, signal?: AbortSignal) => Promise<string[]>
    >(async () => []),
    routeTask: vi.fn<(userInput: string) => TaskRouteResult>(() => ({
      intent: "general_chat",
      confidence: 1,
      chapterNumber: undefined,
      extractedParams: {},
    })),
    buildTaskDirective: vi.fn<(route: TaskRouteResult) => string>(() => ""),
    readFile: vi.fn<(path: string) => Promise<string>>(async () => ""),
    // C4 覆盖守卫：默认目标文件不存在（不弹确认，直接保存）。
    fileExists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
    writeFileAtomic: vi.fn<(path: string, contents: string) => Promise<void>>(async () => {}),
    createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
    deleteFile: vi.fn<(path: string) => Promise<void>>(async () => {}),
    markStyleExemplarViaRust: vi.fn<(projectPath: string, mark: MarkStyleExemplarInput) => Promise<void>>(
      async () => {},
    ),
    loadStyleExemplarsViaRust: vi.fn<(projectPath: string) => Promise<StyleExemplarRecord[]>>(async () => []),
    appendExemplarABSample: vi.fn<(projectPath: string, sample: ExemplarABSample) => Promise<void>>(
      async () => {},
    ),
    exemplarABStats: vi.fn<
      (state: CognitionState | null) => { enabledAvg: number | null; disabledAvg: number | null }
    >(() => ({ enabledAvg: null, disabledAvg: null })),
    loadCognitionState: vi.fn<(projectPath: string) => Promise<CognitionState | null>>(async () => null),
    searchWiki: vi.fn<
      (projectPath: string, query: string, options?: SearchWikiOptions) => Promise<SearchResult[]>
    >(async () => []),
    tokenizeQuery: vi.fn<(query: string) => string[]>((q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)),
    detectLastGeneratedChapterNumber: vi.fn<(assistantContents: string[]) => number | undefined>(() => undefined),
    findChapterFileByNumber: vi.fn<(projectPath: string, chapterNumber: number) => Promise<string | null>>(
      async () => null,
    ),
    getNextChapterNumber: vi.fn<(projectPath: string) => Promise<number>>(async () => 7),
    invalidateChapterCache: vi.fn<(projectPath?: string) => void>(() => {}),
    readSelectedChapterNumberForFile: vi.fn<(selectedFile?: string | null) => Promise<number | undefined>>(
      async () => undefined,
    ),
    resolveTargetChapterNumberForChat: vi.fn<
      (input: ResolveTargetChapterNumberForChatInput) => Promise<number | undefined>
    >(async () => 5),
    buildQmQuaiSystemPrompt: vi.fn<(customSkill?: string) => string>(() => ""),
    injectDeAiDirective: vi.fn<(content: string, enabled: boolean) => string>(
      (content: string) => `DEAI:${content}`,
    ),
    cleanGeneratedChapterContentWithTitle: vi.fn<(content: string) => CleanedChapterContent>(
      (content: string) => ({
        content,
        title: "测试章",
      }),
    ),
    normalizePath: vi.fn<(p: string) => string>((p: string) => p),
    getFileName: vi.fn<(p: string) => string>((p: string) => String(p).split("/").pop() ?? ""),
    getRelativePath: vi.fn<(fullPath: string, basePath: string) => string>((p: string) => p),
    refreshProjectState: vi.fn<(projectPath: string | undefined | null) => Promise<void>>(async () => {}),
    getOutputLanguage: vi.fn<(fallbackText?: string) => string>(() => "中文"),
    buildLanguageReminder: vi.fn<(fallbackText?: string) => string>(() => "请使用中文回复"),
    isGreeting: vi.fn<(text: string) => boolean>(() => false),
    computeContextBudget: vi.fn<(maxContextSize: number | undefined, chapterNumber?: number) => ContextBudget>(
      () => ({ ...emptyContextBudget }),
    ),
    getConversationTabTitle: vi.fn<(title: string, maxLength?: number) => string>((title: string) => title),
    sortConversationsByUpdatedAt: vi.fn<(conversations: Conversation[]) => Conversation[]>(
      (conversations: any[]) => conversations,
    ),
    resolveUserVisibleReasoning: vi.fn<(reasoning?: ReasoningConfig) => ReasoningConfig>((r: any) => r),
    createDeepThinkingStreamRenderer: vi.fn<() => DeepThinkingStreamRenderer>(() => deepStreamRenderer),
    hasUsableLlm: vi.fn<
      (
        cfg: Pick<LlmConfig, "provider" | "apiKey" | "model">
          & Partial<Pick<LlmConfig, "customEndpoint" | "ollamaUrl">>,
      ) => boolean
    >(() => true),
    resolveNovelModel: vi.fn<
      (
        llmConfig: LlmConfig,
        novelConfig: NovelConfig,
        taskType: NovelTaskType,
        storeSnapshot?: ModelResolverStoreSnapshot,
      ) => LlmConfig
    >((llmConfig: any) => llmConfig),
    resolveReviewModel: vi.fn<(novelConfig?: NovelConfig) => string>(() => ""),
    resolveConfig: vi.fn<
      (preset: LlmPreset, override: ProviderOverride | undefined, fallback: LlmConfig) => LlmConfig
    >((template: any, override: any, base: any) => ({
      ...base,
      ...template,
      ...override,
    })),
    saveAiChatModel: vi.fn<(model: string) => Promise<void>>(async () => {}),
    buildGoldenThreeChapterDirective: vi.fn<(result: GoldenThreeChapterRequest | undefined) => string>(
      () => "",
    ),
    detectGoldenThreeChapterRequest: vi.fn<
      (text: string, chapterNumber?: number) => GoldenThreeChapterRequest
    >(() => ({ enabled: false, requestedFirstThree: false })),
    createStreamSessionGuard: vi.fn<() => StreamSessionGuard>(() => streamGuard),
    getCopyableAssistantContent: vi.fn<(content: string) => string>((content: string) => content),
    isChatEditRequest: vi.fn<(userRequest: string) => boolean>(() => false),
    resolveChatEditTarget: vi.fn<
      (input: { userRequest: string; selectedChapterNumber: number | null })
        => { ok: true; target: ChatEditTarget } | { ok: false; message: string }
    >(() => ({ ok: false as const, message: "无法解析目标章节" })),
    validateStructuredChapterEditResult: vi.fn<
      (input: { content: string; targetChapterNumbers: number[] })
        => { ok: true; files: ParsedChapterEditFile[] } | { ok: false; message: string }
    >(() => ({ ok: false as const, message: "解析失败" })),
    backupChapterFile: vi.fn<
      (input: {
        projectPath: string
        chapterPath: string
        chapterNumber: number | null
        content: string
        now?: Date
      }) => Promise<string>
    >(async () => ""),
    updateChapterStatus: vi.fn<(content: string, status: ChapterStatus) => string>(
      (content: string) => content,
    ),
    decideChapterSaveStrategy: vi.fn<
      (input: {
        selectedChapterNumber: number | null
        generatedTargetChapterNumber: number | null
        generatedTargetExists: boolean
      }) => ChapterSaveStrategy
    >(() => ({ action: "direct_next_chapter" })),
    detectGeneratedTargetChapterNumber: vi.fn<(content: string) => number | null>(() => null),
    normalizeChapterEditFile: vi.fn<
      (input: { content: string; targetChapterNumber: number; originalContent?: string })
        => { ok: true; content: string } | { ok: false; message: string }
    >(() => ({ ok: true as const, content: "NORMALIZED" })),
    commitAcceptedDeepChapterDraft: vi.fn<(input: CommitAcceptedDeepChapterDraftInput) => Promise<void>>(
      async () => {},
    ),
    rejectDeepChapterDraft: vi.fn<
      (input: {
        projectPath: string
        conversationId: string
        userRequest: string
        chapterNumber?: number
        resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
        sessionId?: string
        formalChapterPath?: string
      }) => Promise<NovelSessionStatus>
    >(async () => ({ ...sessionStatusBase })),
    blockDeepChapterSession: vi.fn<
      (input: {
        projectPath: string
        conversationId: string
        userRequest: string
        chapterNumber?: number
        resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
        sessionId: string
        checkpoint?: DeepChapterGenerationResumeCheckpoint
        errorMessage: string
      }) => Promise<NovelSessionStatus>
    >(async () => ({ ...sessionStatusBase, status: "blocked", active_step_index: 2 })),
    completeDeepChapterSession: vi.fn<
      (input: {
        projectPath: string
        conversationId: string
        userRequest: string
        chapterNumber?: number
        resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
        sessionId: string
        checkpoint?: DeepChapterGenerationResumeCheckpoint
        finalContent: string
        reviewResults?: NovelReviewResult[]
      }) => Promise<NovelSessionStatus>
    >(async () => ({
      ...sessionStatusBase,
      status: "completed",
      active_step_index: 3,
      draft: { ...sessionStatusBase.draft, draft_status: "ready" },
    })),
    createNovelSessionId: vi.fn<(now?: Date) => string>(() => "synthetic-session"),
    loadNovelSessionStatus: vi.fn<(projectPath: string) => Promise<NovelSessionStatus | null>>(async () => {
      throw new Error("no status")
    }),
    novelSessionStatusPath: vi.fn<(projectPath: string) => string>(() => "/status.json"),
    pauseDeepChapterSession: vi.fn<
      (input: {
        projectPath: string
        conversationId: string
        userRequest: string
        chapterNumber?: number
        resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
        sessionId: string
        checkpoint?: DeepChapterGenerationResumeCheckpoint
        errorMessage: string
      }) => Promise<NovelSessionStatus>
    >(async () => ({
      ...sessionStatusBase,
      status: "paused",
      active_step_index: 1,
      current_task: { ...sessionStatusBase.current_task, last_error: undefined },
    })),
    persistDeepChapterCheckpoint: vi.fn<
      (input: {
        projectPath: string
        conversationId: string
        userRequest: string
        chapterNumber?: number
        resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
        sessionId: string
        checkpoint: DeepChapterGenerationResumeCheckpoint
      }) => Promise<NovelSessionStatus>
    >(async () => ({ ...sessionStatusBase, status: "running", active_step_index: 1 })),
    resolveInterruptedSessionResumeCheckpoint: vi.fn<
      (status: NovelSessionStatus | null, input: { conversationId: string; userRequest: string })
        => DeepChapterGenerationResumeCheckpoint | undefined
    >(() => undefined),
    startDeepChapterSession: vi.fn<
      (input: {
        projectPath: string
        conversationId: string
        userRequest: string
        chapterNumber?: number
        resumeCheckpoint?: DeepChapterGenerationResumeCheckpoint
      }) => Promise<NovelSessionStatus>
    >(async () => ({ ...sessionStatusBase, status: "running", active_step_index: 1 })),
    subscribeStatusJson: vi.fn(async () => () => {}),
    appendContinueUnfinishedDeepChapterContext: vi.fn<
      (content: string, context: ContinueUnfinishedDeepChapterContext) => string
    >((content: string) => content),
    buildInterruptedResumeContextPayload: vi.fn<
      (status: NovelSessionStatus | null, conversationId: string) => ContinueUnfinishedDeepChapterContext | null
    >(() => null),
    buildContinueUnfinishedDeepChapterPrompt: vi.fn<
      (input: {
        originalRequest?: string
        failedAssistantContent: string
        persistedOriginalRequest?: string
        resumeContext?: string
        rootResumeContext?: string
      }) => string
    >(() => "RESUME_PROMPT"),
    extractContinueUnfinishedDeepChapterContext: vi.fn<
      (content: string) => ContinueUnfinishedDeepChapterContext | null
    >(() => null),
    stripContinueUnfinishedDeepChapterContext: vi.fn<(content: string) => string>(
      (content: string) => content,
    ),
    runDeepChapterGeneration: vi.fn<
      (
        input: DeepChapterGenerationInput,
        callbacks?: DeepChapterGenerationCallbacks,
        deps?: DeepChapterGenerationDeps,
        signal?: AbortSignal,
      ) => Promise<DeepChapterGenerationResult>
    >(async () => ({ ...emptyDeepResult })),
    buildChapterPlan: vi.fn(async () => ({
      chapterNumber: 3,
      generatedAt: "2026-08-18T00:00:00.000Z",
      foreshadowing: { status: "ok", report: { debtScore: 0, items: [] }, overdueFindings: [] },
      characters: { status: "ok", items: [] },
      threads: { status: "ok", items: [], openCount: 0 },
      summary: { debtScore: 0, criticalForeshadowing: 0, openThreads: 0, charactersDue: 0 },
    })),
    resolveResidualCampaignFields: vi.fn<
      (args: { enabled: boolean; chapterNumber?: number | null; config?: ResidualCampaignNovelConfigSlice | null })
        => ResidualCampaignResolvedFields | null
    >((input: any) => (input.enabled ? { ...emptyResidualFields } : null)),
    buildContextPack: vi.fn<
      (projectPath: string, task: string, chapterNumber?: number, options?: BuildContextOptions) => Promise<ContextPack>
    >(async () => ({
      task: "",
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
    })),
    contextPackToPrompt: vi.fn<
      (pack: ContextPack, tokenBudget?: number, options?: ContextPackToPromptOptions) => string
    >(() => "CONTEXT_PROMPT"),
    buildRetrievalGraph: vi.fn<(projectPath: string, dataVersion?: number) => Promise<RetrievalGraph>>(
      async () => ({ nodes: new Map(), dataVersion: 0 }),
    ),
    getRelatedNodes: vi.fn<
      (nodeId: string, graph: RetrievalGraph, limit?: number)
        => ReadonlyArray<{ node: RetrievalNode; relevance: number }>
    >(() => []),
    detectEditIntent: vi.fn<(text: string) => boolean>(() => false),
    buildAgentSystemSuffix: vi.fn<(scope: "chapters" | "outlines") => string>(() => "AGENT_SUFFIX"),
    readScopeFileContents: vi.fn<
      (projectPath: string, scope: "chapters" | "outlines", maxFiles?: number)
        => Promise<{ name: string; path: string; content: string }[]>
    >(async () => []),
    ingestChapter: vi.fn<
      (
        projectPath: string,
        chapterPath: string,
        _reviewModel?: string,
        signal?: AbortSignal,
        options?: IngestChapterOptions,
      ) => Promise<IngestResult>
    >(async () => ({ snapshot: null })),
    resolveChapterLengthSpec: vi.fn<(targetChars?: number) => ChapterLengthSpec>(() => ({
      targetChars: 3000,
      minChars: 1500,
      draftMaxChars: 6000,
      maxOutputTokens: 4000,
    })),
    setLastQueryPages: vi.fn<(pages: QueryPageReference[]) => void>(() => {}),
    getLastQueryPages: vi.fn<() => QueryPageReference[]>(() => []),
  }
})

// ── 测试侧构造器（真实类型）───────────────────────────────────────────────────
export const EMPTY_DECISION_GATES: DeepChapterDecisionGates = {
  consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  overall: "pass",
}

export function deepGenResult(over: Partial<DeepChapterGenerationResult> = {}): DeepChapterGenerationResult {
  return {
    finalContent: "F",
    taskBrief: "",
    draftContent: "",
    reviewResults: [],
    revised: false,
    decisionGates: EMPTY_DECISION_GATES,
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
    // Wave 5 (v2.5.0): 上下文用量快照（additive，缺省 undefined）
    contextUsage: {
      memoryChars: 80,
      retrievalChars: 5120,
      graphChars: 2048,
      bodyChars: 51200,
      otherChars: 25600,
      maxCtx: 100000,
    },
    ...over,
  }
}

export function reviewResult(over: Partial<NovelReviewResult> = {}): NovelReviewResult {
  return {
    severity: "error",
    type: "consistency",
    message: "review finding",
    evidence: "",
    relatedMemory: "",
    suggestion: "",
    ...over,
  }
}

export const SESSION_STATUS_BASE: NovelSessionStatus = {
  schema_version: "1",
  session_id: "session-1",
  source: "deep_chapter_generation",
  created_at: "t",
  updated_at: "t",
  status: "paused",
  active_step_index: 1,
  current_task: {
    task_id: "tsk-conv-1",
    conversation_id: "conv-1",
    user_request: "需求",
    checkpoint_stage: "started",
    status: "paused",
  },
  draft: {
    draft_id: "draft-1",
    file_path: "/p/mybook/.novel/drafts/draft-1.md",
    draft_status: "pending",
    updated_at: "t",
  },
  decision_gates: EMPTY_DECISION_GATES,
  evidence_refs: [],
}

export type SessionStatusOverrides = Partial<Omit<NovelSessionStatus, "current_task" | "draft">> & {
  current_task?: Partial<NovelSessionStatus["current_task"]>
  draft?: Partial<NovelSessionStatus["draft"]>
}

export function sessionStatus(over: SessionStatusOverrides = {}): NovelSessionStatus {
  return {
    ...SESSION_STATUS_BASE,
    ...over,
    current_task: { ...SESSION_STATUS_BASE.current_task, ...(over.current_task ?? {}) },
    draft: { ...SESSION_STATUS_BASE.draft, ...(over.draft ?? {}) },
  }
}

// ── UI 原语 mock ───────────────────────────────────────────────────────────────
vi.mock("@/components/ui/button", () => ({
  Button: (props: any) => <button type="button" data-slot="button" {...props} />,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: any) => (
    open ? (
      <div data-testid="dialog">
        {children}
        {onOpenChange && (
          <button type="button" data-testid="dialog-close" onClick={() => onOpenChange(false)}>
            close-dialog
          </button>
        )}
      </div>
    ) : null
  ),
  DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: any) => <div data-testid="dialog-description">{children}</div>,
  DialogFooter: ({ children }: any) => <div data-testid="dialog-footer">{children}</div>,
  DialogHeader: ({ children }: any) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: any) => <div data-testid="dialog-title">{children}</div>,
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div data-testid="tooltip">{children}</div>,
  TooltipContent: ({ children }: any) => <div data-testid="tooltip-content">{children}</div>,
  TooltipProvider: ({ children }: any) => <div data-testid="tooltip-provider">{children}</div>,
  TooltipTrigger: ({ render, children, ...props }: any) => {
    if (render != null) {
      // Base UI render-prop 模式：重建目标元素并合并 props。
      const El = render.type
      return <El {...render.props} {...props} {...(children != null ? { children } : {})} />
    }
    return (
      <button type="button" {...props}>
        {children}
      </button>
    )
  },
}))

// ── 子组件 mock ────────────────────────────────────────────────────────────────
vi.mock("./chat-message", () => ({
  ChatMessage: ({
    message,
    isLastAssistant,
    onRegenerate,
    onSaveAsChapter,
    onDiscardDraft,
    onContinueNextChapter,
    onContinueUnfinished,
    saveStatus,
    isSaving,
  }: any) => (
    <div
      data-testid="chat-message"
      data-role={message.role}
      data-discarded={String(!!message.discarded)}
      data-last={String(!!isLastAssistant)}
    >
      <div data-testid="chat-message-content">{message.content}</div>
      {onRegenerate && (
        <button data-testid="regenerate" onClick={onRegenerate}>
          regenerate
        </button>
      )}
      {onSaveAsChapter && (
        <button data-testid="save-as-chapter" onClick={() => onSaveAsChapter(message.content)}>
          save-as-chapter
        </button>
      )}
      {onDiscardDraft && (
        <button data-testid="discard-draft" onClick={onDiscardDraft}>
          discard-draft
        </button>
      )}
      {onContinueNextChapter && (
        <button data-testid="continue-next-chapter" onClick={onContinueNextChapter}>
          continue-next-chapter
        </button>
      )}
      {onContinueUnfinished && (
        <button data-testid="continue-unfinished" onClick={onContinueUnfinished}>
          continue-unfinished
        </button>
      )}
      {saveStatus ? <div data-testid="save-status">{saveStatus}</div> : null}
      {isSaving ? <div data-testid="saving">saving</div> : null}
    </div>
  ),
  StreamingMessage: ({ content }: any) => <div data-testid="streaming-message">{content}</div>,
}))

vi.mock("./chat-input", () => ({
  ChatInput: ({ onSend, onStop, placeholder, footerControls }: any) => {
    const InputHarness = () => {
      const [value, setValue] = useState("")
      return (
        <div data-testid="chat-input">
          <textarea
            data-testid="chat-input-textarea"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
          />
          <button data-testid="chat-send" onClick={() => onSend(value)}>
            send
          </button>
          <button data-testid="chat-stop" onClick={onStop}>
            stop
          </button>
          <div data-testid="chat-input-footer">{footerControls}</div>
        </div>
      )
    }
    return <InputHarness />
  },
}))

vi.mock("./chat-dock-controls", () => ({
  ChatDockControls: () => <div data-testid="chat-dock-controls" />,
}))

vi.mock("./chat-model-selector", () => ({
  ChatModelSelector: ({ value, onChange }: any) => (
    <select data-testid="chat-model-select" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">default</option>
      <option value="providerA/modelX">providerA/modelX</option>
      <option value="providerZ/ghost">providerZ/ghost</option>
      <option value="plain-model">plain-model</option>
    </select>
  ),
}))

// ── lib 层 mock ────────────────────────────────────────────────────────────────
vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))

vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: mocks.useVirtualizer }))

vi.mock("@/stores/chat-store", () => ({
  useChatStore: mocks.useChatStore,
  chatMessagesToLLM: mocks.chatMessagesToLLM,
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual, useWikiStore: mocks.useWikiStore 
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual, streamChat: mocks.streamChat 
  }
})

vi.mock("@/lib/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest")>()
  return {
    ...actual, executeIngestWrites: mocks.executeIngestWrites 
  }
})

vi.mock("@/lib/novel/task-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/task-router")>()
  return {
    ...actual,
      routeTask: mocks.routeTask,
      buildTaskDirective: mocks.buildTaskDirective,
    
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: mocks.readFile,
      fileExists: mocks.fileExists,
      writeFileAtomic: mocks.writeFileAtomic,
      createDirectory: mocks.createDirectory,
      deleteFile: mocks.deleteFile,
    
  }
})

vi.mock("@/commands/exemplar", () => ({
  markStyleExemplarViaRust: mocks.markStyleExemplarViaRust,
  loadStyleExemplarsViaRust: mocks.loadStyleExemplarsViaRust,
}))

vi.mock("@/lib/novel/character-cognition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/character-cognition")>()
  return {
    ...actual,
      appendExemplarABSample: mocks.appendExemplarABSample,
      exemplarABStats: mocks.exemplarABStats,
      loadCognitionState: mocks.loadCognitionState,
    
  }
})

vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>()
  return {
    ...actual, searchWiki: mocks.searchWiki, tokenizeQuery: mocks.tokenizeQuery 
  }
})

vi.mock("@/lib/novel/chapter-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-utils")>()
  return {
    ...actual,
      detectLastGeneratedChapterNumber: mocks.detectLastGeneratedChapterNumber,
      findChapterFileByNumber: mocks.findChapterFileByNumber,
      getNextChapterNumber: mocks.getNextChapterNumber,
      invalidateChapterCache: mocks.invalidateChapterCache,
      readSelectedChapterNumberForFile: mocks.readSelectedChapterNumberForFile,
      resolveTargetChapterNumberForChat: mocks.resolveTargetChapterNumberForChat,
    
  }
})

vi.mock("@/lib/novel/de-ai-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/de-ai-adapter")>()
  return {
    ...actual,
      buildQmQuaiSystemPrompt: mocks.buildQmQuaiSystemPrompt,
      injectDeAiDirective: mocks.injectDeAiDirective,
    
  }
})

vi.mock("@/lib/novel/chapter-content-cleanup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-content-cleanup")>()
  return {
    ...actual,
      cleanGeneratedChapterContentWithTitle: mocks.cleanGeneratedChapterContentWithTitle,
    
  }
})

vi.mock("@/lib/path-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/path-utils")>()
  return {
    ...actual,
      normalizePath: mocks.normalizePath,
      getFileName: mocks.getFileName,
      getRelativePath: mocks.getRelativePath,
    
  }
})

vi.mock("@/lib/project-refresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-refresh")>()
  return {
    ...actual, refreshProjectState: mocks.refreshProjectState 
  }
})

vi.mock("@/lib/output-language", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/output-language")>()
  return {
    ...actual,
      getOutputLanguage: mocks.getOutputLanguage,
      buildLanguageReminder: mocks.buildLanguageReminder,
    
  }
})

vi.mock("@/lib/greeting-detector", () => ({ isGreeting: mocks.isGreeting }))

vi.mock("@/lib/context-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/context-budget")>()
  return {
    ...actual, computeContextBudget: mocks.computeContextBudget 
  }
})

vi.mock("@/lib/workspace-layout", () => ({
  getConversationTabTitle: mocks.getConversationTabTitle,
  sortConversationsByUpdatedAt: mocks.sortConversationsByUpdatedAt,
}))

vi.mock("@/lib/user-visible-reasoning", () => ({ resolveUserVisibleReasoning: mocks.resolveUserVisibleReasoning }))

vi.mock("@/lib/deep-thinking-stream", () => ({
  createDeepThinkingStreamRenderer: mocks.createDeepThinkingStreamRenderer,
}))

vi.mock("@/lib/has-usable-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/has-usable-llm")>()
  return {
    ...actual, hasUsableLlm: mocks.hasUsableLlm 
  }
})

vi.mock("@/lib/novel/model-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/model-resolver")>()
  return {
    ...actual, resolveNovelModel: mocks.resolveNovelModel 
  }
})

vi.mock("@/lib/novel/review-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/review-model")>()
  return {
    ...actual, resolveReviewModel: mocks.resolveReviewModel 
  }
})

vi.mock("@/lib/llm-config/preset-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-config/preset-resolver")>()
  return {
    ...actual, resolveConfig: mocks.resolveConfig 
  }
})

vi.mock("@/lib/llm-config/llm-presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-config/llm-presets")>()
  return {
    ...actual,
      LLM_PRESETS: [
        { id: "providerA", name: "A", baseUrl: "https://a.example" },
        { id: "custom", name: "Custom", baseUrl: "" },
      ],
    
  }
})

vi.mock("@/lib/project-store", () => ({ saveAiChatModel: mocks.saveAiChatModel }))

vi.mock("@/lib/novel/golden-three-chapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/golden-three-chapters")>()
  return {
    ...actual,
      buildGoldenThreeChapterDirective: mocks.buildGoldenThreeChapterDirective,
      detectGoldenThreeChapterRequest: mocks.detectGoldenThreeChapterRequest,
    
  }
})

vi.mock("./stream-session", () => ({ createStreamSessionGuard: mocks.createStreamSessionGuard }))

vi.mock("@/lib/chat/resume", () => ({
  appendContinueUnfinishedDeepChapterContext: mocks.appendContinueUnfinishedDeepChapterContext,
  buildInterruptedResumeContextPayload: mocks.buildInterruptedResumeContextPayload,
  buildContinueUnfinishedDeepChapterPrompt: mocks.buildContinueUnfinishedDeepChapterPrompt,
  extractContinueUnfinishedDeepChapterContext: mocks.extractContinueUnfinishedDeepChapterContext,
  stripContinueUnfinishedDeepChapterContext: mocks.stripContinueUnfinishedDeepChapterContext,
}))

vi.mock("./chat-shared", () => ({
  useSourceFiles: () => {},
  setLastQueryPages: mocks.setLastQueryPages,
  getLastQueryPages: mocks.getLastQueryPages,
}))

vi.mock("@/lib/chat-copy-content", () => ({ getCopyableAssistantContent: mocks.getCopyableAssistantContent }))

vi.mock("@/lib/novel/chat-edit-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chat-edit-mode")>()
  return {
    ...actual,
      isChatEditRequest: mocks.isChatEditRequest,
      resolveChatEditTarget: mocks.resolveChatEditTarget,
      validateStructuredChapterEditResult: mocks.validateStructuredChapterEditResult,
    
  }
})

vi.mock("@/lib/novel/chapter-backup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-backup")>()
  return {
    ...actual, backupChapterFile: mocks.backupChapterFile 
  }
})

vi.mock("@/lib/novel/chapter-meta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-meta")>()
  return {
    ...actual, updateChapterStatus: mocks.updateChapterStatus 
  }
})

vi.mock("@/lib/novel/chapter-save-strategy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-save-strategy")>()
  return {
    ...actual,
      decideChapterSaveStrategy: mocks.decideChapterSaveStrategy,
      detectGeneratedTargetChapterNumber: mocks.detectGeneratedTargetChapterNumber,
    
  }
})

vi.mock("@/lib/novel/chapter-edit-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-edit-file")>()
  return {
    ...actual, normalizeChapterEditFile: mocks.normalizeChapterEditFile 
  }
})

vi.mock("@/lib/novel/formal-writeback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/formal-writeback")>()
  return {
    ...actual, commitAcceptedDeepChapterDraft: mocks.commitAcceptedDeepChapterDraft 
  }
})

vi.mock("@/lib/novel/novel-session-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/novel-session-status")>()
  return {
    ...actual,
      blockDeepChapterSession: mocks.blockDeepChapterSession,
      completeDeepChapterSession: mocks.completeDeepChapterSession,
      createNovelSessionId: mocks.createNovelSessionId,
      loadNovelSessionStatus: mocks.loadNovelSessionStatus,
      novelSessionStatusPath: mocks.novelSessionStatusPath,
      pauseDeepChapterSession: mocks.pauseDeepChapterSession,
      persistDeepChapterCheckpoint: mocks.persistDeepChapterCheckpoint,
      rejectDeepChapterDraft: mocks.rejectDeepChapterDraft,
      resolveInterruptedSessionResumeCheckpoint: mocks.resolveInterruptedSessionResumeCheckpoint,
      startDeepChapterSession: mocks.startDeepChapterSession,
      subscribeStatusJson: mocks.subscribeStatusJson,
    
  }
})

// 动态 import 模块
vi.mock("@/lib/novel/deep-chapter-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/deep-chapter-generation")>()
  return {
    ...actual, runDeepChapterGeneration: mocks.runDeepChapterGeneration 
  }
})
vi.mock("@/lib/novel/planning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/planning")>()
  return {
    ...actual, buildChapterPlan: mocks.buildChapterPlan 
  }
})
vi.mock("@/lib/novel/residual-campaign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/residual-campaign")>()
  return {
    ...actual, resolveResidualCampaignFields: mocks.resolveResidualCampaignFields 
  }
})
vi.mock("@/lib/novel/context-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/context-engine")>()
  return {
    ...actual,
      buildContextPack: mocks.buildContextPack,
      contextPackToPrompt: mocks.contextPackToPrompt,
    
  }
})
vi.mock("@/lib/graph-relevance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph-relevance")>()
  return {
    ...actual,
      buildRetrievalGraph: mocks.buildRetrievalGraph,
      getRelatedNodes: mocks.getRelatedNodes,
    
  }
})
vi.mock("@/lib/novel/agent-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/agent-parser")>()
  return {
    ...actual,
      detectEditIntent: mocks.detectEditIntent,
      buildAgentSystemSuffix: mocks.buildAgentSystemSuffix,
    
  }
})
vi.mock("@/lib/novel/agent-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/agent-tools")>()
  return {
    ...actual, readScopeFileContents: mocks.readScopeFileContents 
  }
})
vi.mock("@/lib/novel/chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/chapter-ingest")>()
  return {
    ...actual, ingestChapter: mocks.ingestChapter 
  }
})
vi.mock("@/lib/novel/deep-chapter-prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/deep-chapter-prompts")>()
  return {
    ...actual, resolveChapterLengthSpec: mocks.resolveChapterLengthSpec 
  }
})

/* eslint-enable @typescript-eslint/no-explicit-any */

export const PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

export function setConversation(id: string, extra?: Record<string, any>): void {
  mocks.chatState.activeConversationId = id
  mocks.chatState.conversations = [
    {
      id,
      title: `标题-${id}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deAiMode: false,
      inputDraft: "",
      ...extra,
    },
  ]
}

export function setMessages(messages: any[]): void {
  mocks.chatState.messages = messages
}

export function msg(over: Partial<Record<string, any>>): Record<string, any> {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: "hi",
    timestamp: Date.now(),
    conversationId: mocks.chatState.activeConversationId ?? "conv-1",
    ...over,
  }
}

export function resetStates(): void {
  Object.assign(mocks.chatState, {
    conversations: [],
    activeConversationId: null,
    messages: [],
    streamingContents: {},
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 20,
  })
  Object.assign(mocks.wikiState, {
    project: null,
    novelMode: false,
    novelConfig: {
      autoIngestOnSave: false,
      residualCampaignEnabled: false,
      contextTokenBudget: 0,
      chapterTargetChars: 3000,
    },
    llmConfig: {
      provider: "openai",
      apiKey: "",
      model: "gpt-test",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
      reasoning: { mode: "auto" },
    },
    providerConfigs: {},
    aiChatModel: "",
    chatEditModeEnabled: false,
    selectedFile: null,
    dataVersion: 0,
  })
}

export function resetMockDefaults(): void {
  mocks.t.mockImplementation((key: string, opts?: { message?: string }) => {
    const base = lookupZhChatPanel(key) ?? key
    return opts?.message ? `${base}::${opts.message}` : base
  })
  mocks.streamChat.mockImplementation(async (_config: any, _messages: any, handlers: any) => {
    handlers?.onDone?.()
  })
  mocks.routeTask.mockImplementation(() => ({
    intent: "general_chat",
    confidence: 1,
    chapterNumber: undefined,
    extractedParams: {},
  }))
  mocks.streamGuard.isActive.mockReturnValue(true)
  mocks.streamGuard.start.mockReturnValue(1)
  mocks.readFile.mockImplementation(async () => "")
  mocks.fileExists.mockImplementation(async () => false)
  mocks.searchWiki.mockImplementation(async () => [])
  mocks.isGreeting.mockReturnValue(false)
  mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: false, requestedFirstThree: false })
  mocks.buildGoldenThreeChapterDirective.mockReturnValue("")
  mocks.buildTaskDirective.mockReturnValue("")
  mocks.buildQmQuaiSystemPrompt.mockReturnValue("")
  mocks.isChatEditRequest.mockReturnValue(false)
  mocks.resolveChatEditTarget.mockReturnValue({ ok: false as const, message: "无法解析目标章节" })
  mocks.validateStructuredChapterEditResult.mockReturnValue({ ok: false as const, message: "解析失败" })
  mocks.normalizeChapterEditFile.mockReturnValue({ ok: true as const, content: "NORMALIZED" })
  mocks.findChapterFileByNumber.mockImplementation(async () => null)
  mocks.decideChapterSaveStrategy.mockReturnValue({ action: "direct_next_chapter" })
  mocks.detectGeneratedTargetChapterNumber.mockReturnValue(null)
  mocks.readSelectedChapterNumberForFile.mockImplementation(async () => undefined)
  mocks.getNextChapterNumber.mockImplementation(async () => 7)
  mocks.detectLastGeneratedChapterNumber.mockReturnValue(undefined)
  mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => 5)
  mocks.loadNovelSessionStatus.mockImplementation(async () => {
    throw new Error("no status")
  })
  mocks.resolveInterruptedSessionResumeCheckpoint.mockReturnValue(undefined)
  mocks.startDeepChapterSession.mockImplementation(async () => sessionStatus({ status: "running" }))
  mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "FINAL" }))
  mocks.pauseDeepChapterSession.mockImplementation(async () =>
    sessionStatus({ current_task: { last_error: undefined } }),
  )
  mocks.persistDeepChapterCheckpoint.mockImplementation(async () => sessionStatus({ status: "running" }))
  mocks.buildContextPack.mockImplementation(async () => ({
    task: "",
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
  mocks.contextPackToPrompt.mockReturnValue("CONTEXT_PROMPT")
  mocks.detectEditIntent.mockReturnValue(false)
  mocks.readScopeFileContents.mockImplementation(async () => [])
  mocks.buildAgentSystemSuffix.mockReturnValue("AGENT_SUFFIX")
  mocks.buildRetrievalGraph.mockImplementation(async () => ({ nodes: new Map(), dataVersion: 0 }))
  mocks.getRelatedNodes.mockReturnValue([])
  mocks.deepStreamRenderer.updateThinking.mockImplementation((c: string) => c)
  mocks.deepStreamRenderer.appendFinal.mockImplementation((c: string) => c)
  mocks.deepStreamRenderer.getContent.mockReturnValue("")
  mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue(null)
  mocks.buildInterruptedResumeContextPayload.mockReturnValue(null)
  mocks.buildContinueUnfinishedDeepChapterPrompt.mockReturnValue("RESUME_PROMPT")
  mocks.appendContinueUnfinishedDeepChapterContext.mockImplementation((content: string) => content)
  mocks.cleanGeneratedChapterContentWithTitle.mockImplementation((content: string) => ({
    content,
    title: "测试章",
  }))
  mocks.ingestChapter.mockImplementation(async () => ({ snapshot: null }))
  mocks.exemplarABStats.mockReturnValue({ enabledAvg: null, disabledAvg: null })
  mocks.loadStyleExemplarsViaRust.mockImplementation(async () => [])
  mocks.markStyleExemplarViaRust.mockImplementation(async () => {})
  mocks.refreshProjectState.mockImplementation(async () => {})
  mocks.executeIngestWrites.mockImplementation(async () => [])
  mocks.resolveChapterLengthSpec.mockReturnValue({
    targetChars: 3000,
    minChars: 1500,
    draftMaxChars: 6000,
    maxOutputTokens: 4000,
  })
  mocks.createNovelSessionId.mockReturnValue("synthetic-session")
  mocks.hasUsableLlm.mockReturnValue(true)
}

let view: ReturnType<typeof render> | null = null

export function renderPanel(): ReturnType<typeof render> {
  view = render(<ChatPanel />)
  return view
}

export function rerenderPanel(): void {
  view?.rerender(<ChatPanel />)
}

export function unmountPanel(): void {
  view?.unmount()
  view = null
}

export async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export async function sendText(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId("chat-input-textarea"), { target: { value: text } })
    fireEvent.click(screen.getByTestId("chat-send"))
  })
  await flushAsync()
  rerenderPanel()
}

export function lastStreamChatCall(): any[] {
  const calls = mocks.streamChat.mock.calls
  return calls[calls.length - 1]
}

export function lastFinalize(): any[] {
  const calls = mocks.chatState.finalizeStream.mock.calls
  return calls[calls.length - 1]
}

/** 深度章节开关（module 级 shared ref 跨测试持久，需显式设置） */
export function setDeepMode(enabled: boolean): void {
  for (let i = 0; i < 4; i++) {
    rerenderPanel()
    const on = screen.queryByLabelText("开启深度模式")
    const off = screen.queryByLabelText("关闭深度模式")
    if (enabled && !on) return
    if (!enabled && !off) return
    act(() => {
      fireEvent.click(enabled ? (on as HTMLElement) : (off as HTMLElement))
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStates()
  resetMockDefaults()
  setupDomGlobals()
  window.getSelection = (() => ({ toString: () => "" })) as any
})

afterEach(() => {
  vi.restoreAllMocks()
  unmountPanel()
  cleanup()
})
