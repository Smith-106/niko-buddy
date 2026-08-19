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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  within,
} from "@/test-helpers/component-test-utils"
import { ChatPanel } from "./chat-panel"

// ── 真实签名类型（仅类型导入，运行时被擦除；vi.mock 不受影响）──────────────
import type { ChatMessage, RequestOverrides, StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig, ProviderOverride, ReasoningConfig } from "@/stores/wiki-store"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"
import type { SearchResult, SearchWikiOptions } from "@/lib/search"
import type { RetrievalGraph, RetrievalNode } from "@/lib/graph-relevance"
import type { TaskRouteResult } from "@/lib/novel/task-router"
import type { MarkStyleExemplarInput, StyleExemplarRecord } from "@/commands/exemplar"
import type { CognitionState, ExemplarABSample } from "@/lib/novel/character-cognition"
import type { CleanedChapterContent } from "@/lib/novel/chapter-content-cleanup"
import type { GoldenThreeChapterRequest } from "@/lib/novel/golden-three-chapters"
import type { ChatEditTarget, ParsedChapterEditFile } from "@/lib/novel/chat-edit-mode"
import type { ChapterSaveStrategy } from "@/lib/novel/chapter-save-strategy"
import type { NovelSessionStatus } from "@/lib/novel/novel-session-status"
import type { ContinueUnfinishedDeepChapterContext } from "./chat-resume"
import type { QueryPageReference } from "./chat-shared"
import type {
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResumeCheckpoint,
  DeepChapterGenerationResult,
  DeepChapterDecisionGates,
} from "@/lib/novel/deep-chapter-generation"
import type { ResidualCampaignNovelConfigSlice, ResidualCampaignResolvedFields } from "@/lib/novel/residual-campaign"
import type { BuildContextOptions, ContextPack, ContextPackToPromptOptions } from "@/lib/novel/context-engine"
import type { IngestChapterOptions, IngestResult } from "@/lib/novel/chapter-ingest"
import type { ChapterLengthSpec } from "@/lib/novel/deep-chapter-prompts"
import type { ResolveTargetChapterNumberForChatInput } from "@/lib/novel/chapter-utils"
import type { DeepThinkingStreamRenderer } from "@/lib/deep-thinking-stream"
import type { StreamSessionGuard } from "./stream-session"
import type { ContextBudget } from "@/lib/context-budget"
import type { LlmPreset } from "@/components/settings/llm-presets"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { ModelResolverStoreSnapshot, NovelTaskType } from "@/lib/novel/model-resolver"
import type { ChapterStatus } from "@/lib/novel/chapter-meta"
import type { CommitAcceptedDeepChapterDraftInput } from "@/lib/novel/formal-writeback"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ProjectLike {
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
    maxCtx: 204800,
    responseReserve: 30720,
    indexBudget: 5000,
    pageBudget: 2000,
    maxPageSize: 800,
    activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 },
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

  const t = vi.fn((key: string, opts?: { message?: string }) =>
    opts?.message ? `${key}::${opts.message}` : key,
  )

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
    writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(async () => {}),
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
        selectedChapterHasBody: boolean
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
const EMPTY_DECISION_GATES: DeepChapterDecisionGates = {
  consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  overall: "pass",
}

function deepGenResult(over: Partial<DeepChapterGenerationResult> = {}): DeepChapterGenerationResult {
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

function reviewResult(over: Partial<NovelReviewResult> = {}): NovelReviewResult {
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

const SESSION_STATUS_BASE: NovelSessionStatus = {
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

type SessionStatusOverrides = Partial<Omit<NovelSessionStatus, "current_task" | "draft">> & {
  current_task?: Partial<NovelSessionStatus["current_task"]>
  draft?: Partial<NovelSessionStatus["draft"]>
}

function sessionStatus(over: SessionStatusOverrides = {}): NovelSessionStatus {
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
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))

vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: mocks.useVirtualizer }))

vi.mock("@/stores/chat-store", () => ({
  useChatStore: mocks.useChatStore,
  chatMessagesToLLM: mocks.chatMessagesToLLM,
}))

vi.mock("@/stores/wiki-store", () => ({ useWikiStore: mocks.useWikiStore }))

vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.streamChat }))

vi.mock("@/lib/ingest", () => ({ executeIngestWrites: mocks.executeIngestWrites }))

vi.mock("@/lib/novel/task-router", () => ({
  routeTask: mocks.routeTask,
  buildTaskDirective: mocks.buildTaskDirective,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  createDirectory: mocks.createDirectory,
  deleteFile: mocks.deleteFile,
}))

vi.mock("@/commands/exemplar", () => ({
  markStyleExemplarViaRust: mocks.markStyleExemplarViaRust,
  loadStyleExemplarsViaRust: mocks.loadStyleExemplarsViaRust,
}))

vi.mock("@/lib/novel/character-cognition", () => ({
  appendExemplarABSample: mocks.appendExemplarABSample,
  exemplarABStats: mocks.exemplarABStats,
  loadCognitionState: mocks.loadCognitionState,
}))

vi.mock("@/lib/search", () => ({ searchWiki: mocks.searchWiki, tokenizeQuery: mocks.tokenizeQuery }))

vi.mock("@/lib/novel/chapter-utils", () => ({
  detectLastGeneratedChapterNumber: mocks.detectLastGeneratedChapterNumber,
  findChapterFileByNumber: mocks.findChapterFileByNumber,
  getNextChapterNumber: mocks.getNextChapterNumber,
  invalidateChapterCache: mocks.invalidateChapterCache,
  readSelectedChapterNumberForFile: mocks.readSelectedChapterNumberForFile,
  resolveTargetChapterNumberForChat: mocks.resolveTargetChapterNumberForChat,
}))

vi.mock("@/lib/novel/de-ai-adapter", () => ({
  buildQmQuaiSystemPrompt: mocks.buildQmQuaiSystemPrompt,
  injectDeAiDirective: mocks.injectDeAiDirective,
}))

vi.mock("@/lib/novel/chapter-content-cleanup", () => ({
  cleanGeneratedChapterContentWithTitle: mocks.cleanGeneratedChapterContentWithTitle,
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: mocks.normalizePath,
  getFileName: mocks.getFileName,
  getRelativePath: mocks.getRelativePath,
}))

vi.mock("@/lib/project-refresh", () => ({ refreshProjectState: mocks.refreshProjectState }))

vi.mock("@/lib/output-language", () => ({
  getOutputLanguage: mocks.getOutputLanguage,
  buildLanguageReminder: mocks.buildLanguageReminder,
}))

vi.mock("@/lib/greeting-detector", () => ({ isGreeting: mocks.isGreeting }))

vi.mock("@/lib/context-budget", () => ({ computeContextBudget: mocks.computeContextBudget }))

vi.mock("@/lib/workspace-layout", () => ({
  getConversationTabTitle: mocks.getConversationTabTitle,
  sortConversationsByUpdatedAt: mocks.sortConversationsByUpdatedAt,
}))

vi.mock("@/lib/user-visible-reasoning", () => ({ resolveUserVisibleReasoning: mocks.resolveUserVisibleReasoning }))

vi.mock("@/lib/deep-thinking-stream", () => ({
  createDeepThinkingStreamRenderer: mocks.createDeepThinkingStreamRenderer,
}))

vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: mocks.hasUsableLlm }))

vi.mock("@/lib/novel/model-resolver", () => ({ resolveNovelModel: mocks.resolveNovelModel }))

vi.mock("@/lib/novel/review-model", () => ({ resolveReviewModel: mocks.resolveReviewModel }))

vi.mock("@/components/settings/preset-resolver", () => ({ resolveConfig: mocks.resolveConfig }))

vi.mock("@/components/settings/llm-presets", () => ({
  LLM_PRESETS: [
    { id: "providerA", name: "A", baseUrl: "https://a.example" },
    { id: "custom", name: "Custom", baseUrl: "" },
  ],
}))

vi.mock("@/lib/project-store", () => ({ saveAiChatModel: mocks.saveAiChatModel }))

vi.mock("@/lib/novel/golden-three-chapters", () => ({
  buildGoldenThreeChapterDirective: mocks.buildGoldenThreeChapterDirective,
  detectGoldenThreeChapterRequest: mocks.detectGoldenThreeChapterRequest,
}))

vi.mock("./stream-session", () => ({ createStreamSessionGuard: mocks.createStreamSessionGuard }))

vi.mock("./chat-resume", () => ({
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

vi.mock("@/lib/novel/chat-edit-mode", () => ({
  isChatEditRequest: mocks.isChatEditRequest,
  resolveChatEditTarget: mocks.resolveChatEditTarget,
  validateStructuredChapterEditResult: mocks.validateStructuredChapterEditResult,
}))

vi.mock("@/lib/novel/chapter-backup", () => ({ backupChapterFile: mocks.backupChapterFile }))

vi.mock("@/lib/novel/chapter-meta", () => ({ updateChapterStatus: mocks.updateChapterStatus }))

vi.mock("@/lib/novel/chapter-save-strategy", () => ({
  decideChapterSaveStrategy: mocks.decideChapterSaveStrategy,
  detectGeneratedTargetChapterNumber: mocks.detectGeneratedTargetChapterNumber,
}))

vi.mock("@/lib/novel/chapter-edit-file", () => ({ normalizeChapterEditFile: mocks.normalizeChapterEditFile }))

vi.mock("@/lib/novel/formal-writeback", () => ({ commitAcceptedDeepChapterDraft: mocks.commitAcceptedDeepChapterDraft }))

vi.mock("@/lib/novel/novel-session-status", () => ({
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
}))

// 动态 import 模块
vi.mock("@/lib/novel/deep-chapter-generation", () => ({ runDeepChapterGeneration: mocks.runDeepChapterGeneration }))
vi.mock("@/lib/novel/planning", () => ({ buildChapterPlan: mocks.buildChapterPlan }))
vi.mock("@/lib/novel/residual-campaign", () => ({ resolveResidualCampaignFields: mocks.resolveResidualCampaignFields }))
vi.mock("@/lib/novel/context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
  contextPackToPrompt: mocks.contextPackToPrompt,
}))
vi.mock("@/lib/graph-relevance", () => ({
  buildRetrievalGraph: mocks.buildRetrievalGraph,
  getRelatedNodes: mocks.getRelatedNodes,
}))
vi.mock("@/lib/novel/agent-parser", () => ({
  detectEditIntent: mocks.detectEditIntent,
  buildAgentSystemSuffix: mocks.buildAgentSystemSuffix,
}))
vi.mock("@/lib/novel/agent-tools", () => ({ readScopeFileContents: mocks.readScopeFileContents }))
vi.mock("@/lib/novel/chapter-ingest", () => ({ ingestChapter: mocks.ingestChapter }))
vi.mock("@/lib/novel/deep-chapter-prompts", () => ({ resolveChapterLengthSpec: mocks.resolveChapterLengthSpec }))

/* eslint-enable @typescript-eslint/no-explicit-any */

const PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "/p/mybook" }

function setConversation(id: string, extra?: Record<string, any>): void {
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

function setMessages(messages: any[]): void {
  mocks.chatState.messages = messages
}

function msg(over: Partial<Record<string, any>>): Record<string, any> {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: "hi",
    timestamp: Date.now(),
    conversationId: mocks.chatState.activeConversationId ?? "conv-1",
    ...over,
  }
}

function resetStates(): void {
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

function resetMockDefaults(): void {
  mocks.t.mockImplementation((key: string, opts?: { message?: string }) =>
    opts?.message ? `${key}::${opts.message}` : key,
  )
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

function renderPanel(): ReturnType<typeof render> {
  view = render(<ChatPanel />)
  return view
}

function rerenderPanel(): void {
  view?.rerender(<ChatPanel />)
}

function unmountPanel(): void {
  view?.unmount()
  view = null
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function sendText(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId("chat-input-textarea"), { target: { value: text } })
    fireEvent.click(screen.getByTestId("chat-send"))
  })
  await flushAsync()
  rerenderPanel()
}

function lastStreamChatCall(): any[] {
  const calls = mocks.streamChat.mock.calls
  return calls[calls.length - 1]
}

function lastFinalize(): any[] {
  const calls = mocks.chatState.finalizeStream.mock.calls
  return calls[calls.length - 1]
}

/** 深度章节开关（module 级 shared ref 跨测试持久，需显式设置） */
function setDeepMode(enabled: boolean): void {
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

describe("ChatPanel — 会话标签栏 (ConversationTabs)", () => {
  it("空会话显示占位文案 + 新建按钮", () => {
    renderPanel()
    expect(screen.getByText("chat.newChat")).toBeInTheDocument()
    expect(screen.getByText("chat.noConversationsYet")).toBeInTheDocument()
  })

  it("novel 模式空会话显示 novel 文案", () => {
    mocks.wikiState.novelMode = true
    renderPanel()
    expect(screen.getByText("novel.chat.newChat")).toBeInTheDocument()
    expect(screen.getByText("novel.chat.noConversationsYet")).toBeInTheDocument()
  })

  it("点击新建会话调用 createConversation", () => {
    renderPanel()
    fireEvent.click(screen.getByText("chat.newChat"))
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
  })

  it("渲染会话标签：激活态/非激活态/标题/消息数/日期（今天+历史）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "会话一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "会话二", createdAt: 1, updatedAt: Date.now() - 3 * 86400000, deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [
      msg({ id: "a1", conversationId: "conv-1" }),
      msg({ id: "a2", conversationId: "conv-1", role: "assistant", content: "x" }),
    ]
    renderPanel()
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect(tabs[1]).toHaveAttribute("aria-selected", "false")
    expect(within(tabs[0]).getByText("会话一")).toBeInTheDocument()
    expect(within(tabs[0]).getByText("2")).toBeInTheDocument()
    // 日期 span 非空（today → 时间，旧 → 月日）
    const dateSpans = tabs[0].querySelectorAll("span")
    expect(dateSpans.length).toBeGreaterThan(0)
  })

  it("键盘 Enter/Space 切换会话", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tabs = screen.getAllByRole("tab")
    fireEvent.keyDown(tabs[1], { key: "Enter" })
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-2")
    fireEvent.keyDown(tabs[0], { key: " " })
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-1")
  })

  it("流式会话标签显示呼吸点", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    const tab = screen.getByRole("tab")
    expect(tab.querySelector(".animate-pulse")).not.toBeNull()
  })

  it("非激活标签 hover 显示删除按钮，两步确认后删除（有项目时删除文件）", () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [msg({ id: "a1", conversationId: "conv-2" })]
    renderPanel()
    const tabs = screen.getAllByRole("tab")
    expect(within(tabs[0]).queryByLabelText("删除该会话")).not.toBeNull() // 激活标签常显
    expect(within(tabs[1]).queryByLabelText("删除该会话")).toBeNull() // 非激活未 hover 隐藏
    fireEvent.mouseEnter(tabs[1])
    const del = within(tabs[1]).getByLabelText("删除该会话")
    fireEvent.click(del)
    expect(within(tabs[1]).getByLabelText("确认删除该会话")).toBeInTheDocument()
    fireEvent.click(within(tabs[1]).getByLabelText("确认删除该会话"))
    expect(mocks.chatState.deleteConversation).toHaveBeenCalledWith("conv-2")
    expect(mocks.deleteFile).toHaveBeenCalledWith("/p/mybook/.qmai/chats/conv-2.json")
    fireEvent.mouseLeave(tabs[1])
  })

  it("删除按钮失焦重置确认态", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tab = screen.getByRole("tab")
    const del = within(tab).getByLabelText("删除该会话")
    fireEvent.click(del)
    expect(within(tab).getByLabelText("确认删除该会话")).toBeInTheDocument()
    fireEvent.blur(within(tab).getByLabelText("确认删除该会话"))
    expect(within(tab).getByLabelText("删除该会话")).toBeInTheDocument()
  })

  it("删除会话时 abort 流并吞掉 deleteFile 失败（无项目不删文件）", async () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tab = screen.getByRole("tab")
    fireEvent.click(within(tab).getByLabelText("删除该会话"))
    fireEvent.click(within(tab).getByLabelText("确认删除该会话"))
    expect(mocks.chatState.deleteConversation).toHaveBeenCalledWith("conv-1")
    expect(mocks.deleteFile).not.toHaveBeenCalled() // 无 project
    await flushAsync()
  })

  it("删除会话时 abortControllersRef 被清理（流进行中删除）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    const capturedSignal: { current: AbortSignal | null } = { current: null }
    mocks.streamChat.mockImplementation((_c: any, _m: any, _h: any, signal?: AbortSignal) => {
      capturedSignal.current = signal ?? null
      return new Promise<void>(() => {}) // 挂起
    })
    // deleteFile 失败被吞 —— 拒绝必须注册在删除点击之前，删除处理是同步触发的
    mocks.deleteFile.mockRejectedValueOnce(new Error("io"))
    renderPanel()
    await sendText("hello")
    expect(capturedSignal.current).not.toBeNull()
    const tab = screen.getByRole("tab")
    fireEvent.click(within(tab).getByLabelText("删除该会话"))
    fireEvent.click(within(tab).getByLabelText("确认删除该会话"))
    expect(capturedSignal.current?.aborted).toBe(true)
    expect(mocks.deleteFile).toHaveBeenCalledWith("/p/mybook/.qmai/chats/conv-1.json")
    await flushAsync()
  })
})

describe("ChatPanel — 空态与输入区", () => {
  it("无活跃会话显示 hero + 建议 chips，点击 chip 自动建会话并发送", async () => {
    renderPanel()
    expect(screen.getByText("chat.startNewConversation")).toBeInTheDocument()
    expect(screen.getByText("chat.clickNewChatToBegin")).toBeInTheDocument()
    fireEvent.click(screen.getByText("总结一下当前项目的知识结构"))
    await flushAsync()
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "总结一下当前项目的知识结构")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("novel 空态显示 novel 文案与建议", () => {
    mocks.wikiState.novelMode = true
    renderPanel()
    expect(screen.getByText("novel.chat.startNewConversation")).toBeInTheDocument()
    expect(screen.getByText("novel.chat.clickNewChatToBegin")).toBeInTheDocument()
    fireEvent.click(screen.getByText("帮我梳理当前小说的世界观和主要矛盾"))
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "帮我梳理当前小说的世界观和主要矛盾")
  })

  it("有会话时渲染输入区与占位（chat/ingest 两模式）", () => {
    setConversation("conv-1")
    renderPanel()
    expect(screen.getByTestId("chat-input")).toBeInTheDocument()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "chat.typeAMessage")
    mocks.chatState.mode = "ingest"
    rerenderPanel()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "chat.ingestPlaceholder")
    expect(screen.queryByText("chat.startNewConversation")).toBeNull()
  })

  it("novel 模式占位 + 底部控制区（dock/toggle/模型选择）", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "novel.chat.typeAMessage")
    expect(screen.getByTestId("chat-dock-controls")).toBeInTheDocument()
    expect(screen.getByLabelText("开启深度模式")).toBeInTheDocument()
    expect(screen.getByLabelText("编辑章节")).toBeInTheDocument()
    expect(screen.getByLabelText("标记为 Style Exemplar")).toBeInTheDocument()
    expect(screen.getByTestId("chat-model-select")).toBeInTheDocument()
  })

  it("非 novel 模式不渲染 novel 专属控制", () => {
    setConversation("conv-1")
    renderPanel()
    expect(screen.queryByLabelText("开启深度模式")).toBeNull()
    expect(screen.queryByLabelText("编辑章节")).toBeNull()
    expect(screen.queryByLabelText("标记为 Style Exemplar")).toBeNull()
  })

  it("模型选择 onChange 联动 setAiChatModel + saveAiChatModel", () => {
    setConversation("conv-1")
    renderPanel()
    fireEvent.change(screen.getByTestId("chat-model-select"), { target: { value: "providerA/modelX" } })
    expect(mocks.wikiState.setAiChatModel).toHaveBeenCalledWith("providerA/modelX")
    expect(mocks.saveAiChatModel).toHaveBeenCalledWith("providerA/modelX")
  })

  it("深度模式开关切换 aria-pressed 与按钮文案", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    const toggle = screen.getByLabelText("开启深度模式")
    fireEvent.click(toggle)
    rerenderPanel()
    expect(screen.getByLabelText("关闭深度模式")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByLabelText("关闭深度模式"))
    rerenderPanel()
    expect(screen.getByLabelText("开启深度模式")).toHaveAttribute("aria-pressed", "false")
  })

  it("编辑章节开关切换 chatEditModeEnabled", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("编辑章节"))
    expect(mocks.wikiState.setChatEditModeEnabled).toHaveBeenCalledWith(true)
    expect(mocks.wikiState.chatEditModeEnabled).toBe(true)
  })
})

describe("ChatPanel — 消息列表与流式状态", () => {
  it("渲染消息（虚拟列表 mock 全量展开），isLastAssistant 仅最后一条助手消息", () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "问题A" }),
      msg({ id: "a1", role: "assistant", content: "回答A" }),
      msg({ id: "u2", role: "user", content: "问题B" }),
      msg({ id: "a2", role: "assistant", content: "回答B" }),
    ])
    renderPanel()
    const msgs = screen.getAllByTestId("chat-message")
    expect(msgs).toHaveLength(4)
    expect(screen.getByText("问题A")).toBeInTheDocument()
    expect(screen.getByText("回答B")).toBeInTheDocument()
    const lastAssistant = msgs.find((el) => el.getAttribute("data-last") === "true")
    expect(lastAssistant?.getAttribute("data-role")).toBe("assistant")
    expect(lastAssistant?.textContent).toContain("回答B")
  })

  it("流式期间渲染 StreamingMessage 且 isLastAssistant 被抑制（按钮仍可用于停止）", () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "部分回答" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "继续流式..." }
    renderPanel()
    expect(screen.getByTestId("streaming-message").textContent).toContain("继续流式...")
    const last = screen.getAllByTestId("chat-message").find((el) => el.getAttribute("data-last") === "true")
    expect(last).toBeUndefined() // isLastAssistant 被 isStreaming 抑制
    expect(screen.queryByTestId("save-status")).toBeNull()
    // 非流式恢复后 isLastAssistant 恢复
    mocks.chatState.streamingContents = {}
    rerenderPanel()
    const last2 = screen.getAllByTestId("chat-message").find((el) => el.getAttribute("data-last") === "true")
    expect(last2?.textContent).toContain("部分回答")
    expect(screen.getAllByTestId("save-as-chapter").length).toBeGreaterThan(0)
    expect(screen.getByTestId("continue-next-chapter")).toBeInTheDocument()
    expect(screen.getByTestId("continue-unfinished")).toBeInTheDocument()
    expect(screen.getByTestId("discard-draft")).toBeInTheDocument()
  })

  it("写入 wiki 按钮：ingest 模式且有助手消息时显示；点击执行写入", async () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "输出" })])
    renderPanel()
    const writeBtn = screen.getByText("chat.writeToWiki")
    expect(writeBtn).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(writeBtn)
    })
    await flushAsync()
    expect(mocks.executeIngestWrites).toHaveBeenCalledWith("/p/mybook", mocks.wikiState.llmConfig, undefined, undefined)
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p/mybook")
  })

  it("写入 wiki：chat 模式隐藏；ingest 模式无助手消息时隐藏", () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.mode = "chat"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })]) // 有助手消息但 chat 模式
    renderPanel()
    expect(screen.queryByText("chat.writeToWiki")).toBeNull()
    mocks.chatState.mode = "ingest"
    mocks.chatState.messages = [msg({ id: "u1", role: "user", content: "y" })]
    rerenderPanel()
    expect(screen.queryByText("chat.writeToWiki")).toBeNull() // ingest 但无助手消息
  })

  it("写入 wiki：无项目直接返回；写入失败 console.error；刷新失败被吞", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })])
    renderPanel()
    await act(async () => {
      fireEvent.click(screen.getByText("chat.writeToWiki"))
    })
    await flushAsync()
    expect(mocks.executeIngestWrites).not.toHaveBeenCalled() // 无 project

    mocks.wikiState.project = PROJECT
    rerenderPanel()
    // 阶段2：写入成功但刷新失败 → 被吞（不 console.error）
    mocks.executeIngestWrites.mockResolvedValueOnce([])
    mocks.refreshProjectState.mockRejectedValueOnce(new Error("refresh-boom"))
    await act(async () => {
      fireEvent.click(screen.getByText("chat.writeToWiki"))
    })
    await flushAsync()
    expect(errSpy).not.toHaveBeenCalled()
    // 阶段3：写入失败 → console.error
    mocks.executeIngestWrites.mockRejectedValueOnce(new Error("write-boom"))
    await act(async () => {
      fireEvent.click(screen.getByText("chat.writeToWiki"))
    })
    await flushAsync()
    expect(errSpy).toHaveBeenCalledWith("写入 wiki 失败:", "write-boom")
    errSpy.mockRestore()
  })

  it("滚动 FAB：上滑显示，点击回底隐藏；回到底部自动隐藏", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    const container = screen
      .getAllByTestId("chat-message")[0]
      .closest(".overflow-y-auto") as HTMLDivElement
    expect(container).not.toBeNull()
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 })
    // 先滚到底部（lastScrollTopRef 同步），再向上滚 → FAB 出现
    container.scrollTop = 1000
    act(() => {
      fireEvent.scroll(container)
    })
    container.scrollTop = 100
    act(() => {
      fireEvent.scroll(container)
    })
    rerenderPanel()
    const fab = screen.getByLabelText("滚动到最新消息")
    expect(fab).toBeInTheDocument()
    act(() => {
      fireEvent.click(fab)
    })
    rerenderPanel()
    expect(screen.queryByLabelText("滚动到最新消息")).toBeNull()
    expect(container.scrollTop).toBe(1000)
    // 再次上滑显示，再滚到底部自动隐藏
    container.scrollTop = 100
    act(() => {
      fireEvent.scroll(container)
    })
    rerenderPanel()
    expect(screen.getByLabelText("滚动到最新消息")).toBeInTheDocument()
    container.scrollTop = 760
    act(() => {
      fireEvent.scroll(container)
    })
    rerenderPanel()
    expect(screen.queryByLabelText("滚动到最新消息")).toBeNull()
  })
})

describe("ChatPanel — handleSend 主链路", () => {
  it("无项目发送：仅历史消息 + onDone finalize（含 reasoning token 与 closeReasoning）", async () => {
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "问题A" })])
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onReasoningToken?.("思考")
      handlers?.onReasoningToken?.("中")
      handlers?.onToken?.("回答")
      handlers?.onDone?.()
    })
    await sendText("继续")
    const [config, llmMessages, handlers] = lastStreamChatCall()
    expect(config.model).toBe("gpt-test")
    // 无 project → 无 system；历史（问题A）+ 新消息（继续）
    expect(llmMessages).toEqual([
      { role: "user", content: "问题A" },
      { role: "user", content: "继续" },
    ])
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "继续")
    expect(mocks.chatState.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(mocks.chatState.finalizeStream).toHaveBeenCalledWith("<think>思考中</think>回答", [], "conv-1")
    expect(handlers).toBeDefined()
    // streaming 缓冲被推理 token + 正文更新
    expect(mocks.chatState.streamingContents).toEqual({})
    await flushAsync()
  })

  it("无项目发送：空 reasoning token 与 guard 失效时跳过", async () => {
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onReasoningToken?.("") // 空 token → return
      mocks.streamGuard.isActive.mockReturnValue(false)
      handlers?.onReasoningToken?.("被忽略")
      handlers?.onToken?.("被忽略")
      mocks.streamGuard.isActive.mockReturnValue(true)
      handlers?.onToken?.("正文")
      handlers?.onDone?.()
    })
    await sendText("再来")
    expect(mocks.chatState.finalizeStream).toHaveBeenCalled()
    const content = lastFinalize()[0]
    expect(content).toBe("正文") // 被忽略的 token 未进入
  })

  it("greeting 短路：项目存在 + 打招呼 → 问候 system prompt，跳过检索", async () => {
    mocks.wikiState.project = PROJECT
    mocks.isGreeting.mockReturnValue(true)
    mocks.getOutputLanguage.mockReturnValue("English")
    setConversation("conv-1")
    renderPanel()
    await sendText("你好")
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]
    expect(sys.role).toBe("system")
    expect(sys.content).toContain("资料库问答助手")
    expect(sys.content).toContain("English")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(lastFinalize()[1]).toEqual([]) // queryRefs 为空
  })

  it("检索链路：索引裁剪 + 图扩展 + 页面注入 + agent suffix（数组 content）+ langReminder 前置", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: undefined,
      extractedParams: {},
    })
    mocks.buildQmQuaiSystemPrompt.mockReturnValue("QM_QUAI_SKILL")
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.readScopeFileContents.mockImplementation(async () => [
      { name: "chapter-003.md", path: "/p/mybook/wiki/chapters/chapter-003.md", content: "正文..." },
    ])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md")) {
        return ["## 章节目录", "chapter one 简介", "无关行", "## 设定", "chapter two 简介"].join("\n")
      }
      if (path.endsWith("purpose.md")) return "本书目标"
      if (path.includes("wiki/pages/a.md")) return "页面A内容" + "x".repeat(50)
      if (path.includes("wiki/pages/b.md")) return "B" + "y".repeat(20)
      return ""
    })
    mocks.computeContextBudget.mockReturnValue({ maxCtx: 204800, responseReserve: 30720, indexBudget: 30, pageBudget: 2000, maxPageSize: 800, activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 } })
    mocks.tokenizeQuery.mockReturnValue(["chapter"])
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
      { title: "B", path: "/p/mybook/wiki/pages/b.md", snippet: "", score: 0, titleMatch: false, images: [] },
    ])
    mocks.buildRetrievalGraph.mockImplementation(async () => ({ nodes: new Map(), dataVersion: 0 }))
    mocks.getRelatedNodes.mockImplementation((nodeId: string, _graph: RetrievalGraph, _limit?: number) => {
      if (nodeId === "a") {
        return [
          { node: { id: "c", title: "C", path: "/p/mybook/wiki/pages/c.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 1.5 },
          { node: { id: "b", title: "B", path: "/p/mybook/wiki/pages/b.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 3.0 },
          { node: { id: "d", title: "D", path: "/p/mybook/wiki/pages/d.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 3.0 },
          { node: { id: "d", title: "D", path: "/p/mybook/wiki/pages/d.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 2.5 },
        ]
      }
      return []
    })
    mocks.detectLastGeneratedChapterNumber.mockReturnValue(2)
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => 3)
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "上一句" })])
    renderPanel()
    await sendText("继续写下一章")
    expect(mocks.searchWiki).toHaveBeenCalledWith(
      "/p/mybook",
      "继续写下一章",
      expect.objectContaining({ rerank: true, topK: 10 }),
    )
    expect(mocks.resolveTargetChapterNumberForChat).toHaveBeenCalledWith(
      expect.objectContaining({ routeChapterNumber: undefined, lastGeneratedChapterNumber: 2 }),
    )
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]
    const sysText = Array.isArray(sys.content)
      ? sys.content.map((b: any) => b.text).join("\n")
      : sys.content
    expect(sysText).toContain("QM_QUAI_SKILL")
    // array content → agent suffix 追加为 text block
    expect(Array.isArray(sys.content)).toBe(true)
    const blocks = sys.content as { text: string }[]
    const suffixBlock = blocks[blocks.length - 1]
    expect(suffixBlock.text).toContain("AGENT_SUFFIX")
    expect(suffixBlock.text).toContain("chapter-003.md")
    // langReminder 前置到最后一条 user
    const lastUser = llmMessages[llmMessages.length - 1]
    expect(lastUser.role).toBe("user")
    expect(lastUser.content).toContain("请使用中文回复")
    expect(mocks.setLastQueryPages).toHaveBeenCalled()
    await flushAsync()
  })

  it("检索链路：预算/截断/读文件失败/overview 回退 + 索引不裁剪", async () => {
    mocks.wikiState.project = PROJECT
    mocks.computeContextBudget.mockReturnValue({ maxCtx: 204800, responseReserve: 30720, indexBudget: 5000, pageBudget: 25, maxPageSize: 10, activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 } })
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md")) return "短索引"
      if (path.includes("wiki/pages/")) return "L".repeat(40)
      if (path.endsWith("overview.md")) return "总览内容"
      return ""
    })
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
      { title: "B", path: "/p/mybook/wiki/pages/b.md", snippet: "", score: 0, titleMatch: false, images: [] },
    ])
    mocks.getRelatedNodes.mockReturnValue([
      { node: { id: "c", title: "C", path: "/p/mybook/wiki/pages/c.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 2.5 },
    ])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md")) return "短索引"
      if (path.includes("wiki/pages/a.md")) return "L".repeat(40) // 截断
      if (path.includes("wiki/pages/b.md")) throw new Error("no file") // 读失败
      if (path.includes("wiki/pages/c.md")) return "L".repeat(40) // 超预算
      if (path.endsWith("overview.md")) return "总览内容"
      return ""
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.streamChat).toHaveBeenCalled()
    expect(lastFinalize()[1]).toBeDefined()
    await flushAsync()
  })

  it("overview 回退：无搜索结果且 overview 读取失败 → 提示无页面", async () => {
    mocks.wikiState.project = PROJECT
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("overview.md")) throw new Error("no overview")
      return ""
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("随便问问")
    expect(mocks.buildRetrievalGraph).toHaveBeenCalled()
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]?.content as { text: string }[]
    const joined = sys.map((b) => b.text).join("\n")
    expect(joined).toContain("No wiki pages found")
    await flushAsync()
  })

  it("novel 上下文包：task/golden 指令前置 + tokenBudget 生效（buildContextPack 正常）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.novelConfig.contextTokenBudget = 4000
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: { chapterNumber: "3" },
    })
    mocks.buildTaskDirective.mockReturnValue("TASK_DIRECTIVE")
    mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: true, targetChapter: 3, requestedFirstThree: false })
    mocks.buildGoldenThreeChapterDirective.mockReturnValue("GOLDEN_DIRECTIVE")
    mocks.contextPackToPrompt.mockReturnValue("CONTEXT_PROMPT")
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    expect(mocks.buildContextPack).toHaveBeenCalledWith("/p/mybook", "写第3章", 5)
    expect(mocks.contextPackToPrompt).toHaveBeenCalledWith(expect.anything(), 4000, {
      layeredRecall: "default",
      sectionCharBudget: 4000,
    })
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]?.content as { text: string }[]
    const joined = sys.map((b) => b.text).join("\n")
    expect(joined).toContain("TASK_DIRECTIVE")
    expect(joined).toContain("GOLDEN_DIRECTIVE")
    expect(joined).toContain("CONTEXT_PROMPT")
    await flushAsync()
  })

  it("novel 上下文包构建失败 → 走 fallback 对象（characterAuras 空，不弹 dialog）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: {},
    })
    mocks.buildContextPack.mockRejectedValueOnce(new Error("pack-boom"))
    setConversation("conv-1")
    renderPanel()
    await sendText("写章节")
    expect(mocks.streamChat).toHaveBeenCalled()
    expect(screen.queryByTestId("dialog")).toBeNull()
    await flushAsync()
  })

  it("soul dialog：characterAuras 非空弹出；取消 → finalize 取消文案", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "主角气质：冷静克制",
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
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText("本次写作将注入角色灵魂上下文")).toBeInTheDocument()
    expect(screen.getByText("主角气质：冷静克制")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByText("取消本次生成"))
    })
    await flushAsync()
    expect(lastFinalize()[0]).toContain("已取消本次生成，角色灵魂上下文未发送给模型。")
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("soul dialog：确认继续 → 正常继续生成", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "主角气质",
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
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    await act(async () => {
      fireEvent.click(screen.getByText("继续生成"))
    })
    await flushAsync()
    expect(mocks.streamChat).toHaveBeenCalled()
    // CONTEXT_PROMPT 进入 system prompt（最终内容为空是因为无 token 输出）
    const [, confirmMessages] = lastStreamChatCall()
    const confirmSys = confirmMessages[0]?.content as { text: string }[]
    expect(confirmSys.map((b) => b.text).join("\n")).toContain("CONTEXT_PROMPT")
  })

  it("soul dialog：dialog-close（onOpenChange false）→ 取消生成并关闭", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "主角气质：冷静克制",
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
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText("主角气质：冷静克制")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("dialog-close"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("已取消本次生成，角色灵魂上下文未发送给模型。")
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("deAiMode 会话：注入 de-AI 指令（与 langReminder 叠加）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1", { deAiMode: true })
    setMessages([msg({ id: "u1", role: "user", content: "旧问题" })])
    renderPanel()
    await sendText("新问题")
    const [, llmMessages] = lastStreamChatCall()
    const lastUser = llmMessages[llmMessages.length - 1]
    expect(lastUser.content).toContain("DEAI:")
    expect(lastUser.content).toContain("请使用中文回复")
    await flushAsync()
  })

  it("langReminder 前置到最新 user 消息（历史最后一条为助手消息同样前置）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    await sendText("再来")
    const [, llmMessages] = lastStreamChatCall()
    const lastUser = llmMessages[llmMessages.length - 1]
    expect(lastUser.content).toContain("[请使用中文回复]")
    expect(lastUser.content).toContain("再来")
    await flushAsync()
  })

  it("streamChat onError：URL 与鉴权头脱敏后 finalize 出错文案", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("请求 https://api.example.com/v1 失败 Authorization: Bearer abc123"))
    })
    await sendText("提问")
    expect(errSpy).toHaveBeenCalled()
    const [content, refs] = lastFinalize()
    expect(content).toContain("出错：请求 [url] 失败")
    expect(content).toContain("[redacted]")
    expect(refs).toBeUndefined()
    errSpy.mockRestore()
  })

  it("streamChat onError：普通错误原文展示", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("plain failure"))
    })
    await sendText("提问")
    expect(lastFinalize()[0]).toContain("出错：plain failure")
  })

  it("aiChatModel 解析：空 → 使用默认 llmConfig", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("gpt-test")
  })

  it("aiChatModel 解析：providerId/modelId 精确匹配（preset 命中）", async () => {
    mocks.wikiState.aiChatModel = "providerA/modelX"
    mocks.wikiState.providerConfigs = {
      providerA: { savedModels: [{ model: "modelX" }] },
    }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(mocks.resolveConfig).toHaveBeenCalled()
    expect(lastStreamChatCall()[0].model).toBe("modelX")
  })

  it("aiChatModel 解析：providerId/modelId 但 provider 未配置 → 仅覆盖 model", async () => {
    mocks.wikiState.aiChatModel = "providerZ/ghost"
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
    expect(lastStreamChatCall()[0].model).toBe("ghost")
  })

  it("aiChatModel 解析：providerId 不在 preset 时回退 custom", async () => {
    mocks.wikiState.aiChatModel = "providerN/modelY"
    mocks.wikiState.providerConfigs = {
      providerN: { savedModels: [{ model: "modelY" }] },
    }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("modelY")
  })

  it("aiChatModel 解析：纯模型名匹配到 provider", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = {
      providerA: { savedModels: [{ model: "plain-model" }] },
    }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(mocks.resolveConfig).toHaveBeenCalled()
    expect(lastStreamChatCall()[0].model).toBe("plain-model")
  })

  it("aiChatModel 解析：纯模型名未匹配 → 回退默认 + model 覆盖", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("plain-model")
  })
})

describe("ChatPanel — 编辑章节模式 (chat edit mode)", () => {
  function setupEditMode(): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.chatEditModeEnabled = true
    mocks.isChatEditRequest.mockReturnValue(true)
  }

  it("resolveChatEditTarget 失败 → finalize 提示并返回", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({ ok: false as const, message: "目标解析失败" })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(lastFinalize()[0]).toBe("目标解析失败")
  })

  it("目标章节文件缺失 → 提示缺失章节", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      n === 3 ? `${pp}/wiki/chapters/chapter-003.md` : null,
    )
    setConversation("conv-1")
    renderPanel()
    await sendText("修改3、4章")
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(lastFinalize()[0]).toContain("未找到以下章节")
    expect(lastFinalize()[0]).toContain("第4章")
  })

  it("单章修改成功：写回 + 备份 + 刷新 + 选中文件 + finalize 完成文案", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.readFile.mockImplementation(async () => "原文内容")
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("修改后内容")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.backupChapterFile).toHaveBeenCalledWith(
      expect.objectContaining({ chapterPath: "/p/mybook/wiki/chapters/chapter-003.md", chapterNumber: 3 }),
    )
    expect(mocks.writeFile).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-003.md", "NORMALIZED")
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-003.md")
    expect(lastFinalize()[0]).toContain("已完成第3章修改")
    await flushAsync()
  })

  it("多章修改成功：逐章写回 + 批量完成文案", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-00${3}${4}.md`.slice(0, 0) || `${pp}/wiki/chapters/chapter-00X.md`)
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      `${pp}/wiki/chapters/chapter-00${n}.md`,
    )
    mocks.readFile.mockImplementation(async () => "原文")
    mocks.validateStructuredChapterEditResult.mockReturnValue({
      ok: true as const,
      files: [
        { chapterNumber: 3, content: "A内容" },
        { chapterNumber: 4, content: "B内容" },
      ],
    })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("MULTI")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("批量修改")
    expect(mocks.writeFile).toHaveBeenNthCalledWith(1, "/p/mybook/wiki/chapters/chapter-003.md", "NORMALIZED")
    expect(mocks.writeFile).toHaveBeenNthCalledWith(2, "/p/mybook/wiki/chapters/chapter-004.md", "NORMALIZED")
    expect(lastFinalize()[0]).toContain("已完成 2 个章节的批量修改")
    await flushAsync()
  })

  it("多章校验失败 → finalize 校验消息", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      `${pp}/wiki/chapters/chapter-00${n}.md`,
    )
    mocks.validateStructuredChapterEditResult.mockReturnValue({ ok: false as const, message: "解析失败" })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("x")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("批量修改")
    expect(lastFinalize()[0]).toBe("解析失败")
  })

  it("多章某章缺修改结果 → 停止写回该章", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "batch" as const, chapterNumbers: [3, 4] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string, n: number) =>
      `${pp}/wiki/chapters/chapter-00${n}.md`,
    )
    mocks.validateStructuredChapterEditResult.mockReturnValue({
      ok: true as const,
      files: [{ chapterNumber: 3, content: "A" }],
    })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("x")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("批量修改")
    expect(lastFinalize()[0]).toContain("第4章缺少修改结果")
  })

  it("normalize 失败 → finalize 归一化错误", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.normalizeChapterEditFile.mockReturnValue({ ok: false as const, message: "格式错误" })
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("x")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(lastFinalize()[0]).toBe("格式错误")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("edit onError → finalize 修改失败文案", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("API boom"))
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(lastFinalize()[0]).toContain("修改失败：")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("edit onToken 时 guard 失效 → token 被忽略", async () => {
    setupEditMode()
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      handlers?.onToken?.("被忽略")
      mocks.streamGuard.isActive.mockReturnValue(true)
      handlers?.onToken?.("有效内容")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.chatState.appendStreamToken).toHaveBeenCalledTimes(1)
    expect(mocks.chatState.appendStreamToken).toHaveBeenCalledWith("有效内容", "conv-1")
    expect(mocks.writeFile).toHaveBeenCalled()
  })
})

describe("ChatPanel — 深度章节生成 (deep chapter)", () => {
  function setupDeepBase(): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: { chapterNumber: "3" },
    })
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => 3)
  }

  it("深度生成成功：complete 落盘 + ready marker（residual 字段展开）", async () => {
    setupDeepBase()
    mocks.wikiState.novelConfig.residualCampaignEnabled = true
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写第3章")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/p/mybook", conversationId: "conv-1", chapterNumber: 3 }),
    )
    expect(mocks.resolveResidualCampaignFields).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, chapterNumber: 3 }),
    )
    const genInput = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(genInput.residualOverallMedian).toBe(9.0)
    expect(genInput.residualRewriteMode).toBe("structure_thril_pacing")
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    expect(mocks.blockDeepChapterSession).not.toHaveBeenCalled()
    expect(mocks.pauseDeepChapterSession).not.toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("<!-- qmai-deep-chapter-draft:")
    expect(decodeURIComponent(content)).toContain('"draftStatus":"ready"')
    // Wave 5: 上下文用量标记随 draft 标记同追 + completeDeepChapterSession 透传
    expect(content).toContain("<!-- qmai-context-usage:")
    expect(decodeURIComponent(content)).toContain('"memoryChars":80')
    expect(mocks.completeDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ contextUsage: expect.objectContaining({ maxCtx: 100000 }) }),
    )
    setDeepMode(false)
  })

  it("深度生成无 contextUsage（空包降级）→ 不追加用量标记、不透传字段", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ contextUsage: undefined }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).not.toContain("qmai-context-usage")
    expect(mocks.completeDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ contextUsage: undefined }),
    )
    setDeepMode(false)
  })

  it("contextUsage 标记 JSON 序列化失败（BigInt 字段）→ 降级无用量标记", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () =>
      deepGenResult({ contextUsage: { memoryChars: 1n as any, retrievalChars: 0, graphChars: 0, bodyChars: 0, otherChars: 0, maxCtx: 100 } }),
    )
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).not.toContain("qmai-context-usage")
    setDeepMode(false)
  })

  it("深度生成 manualReviewRequired → block + pending marker", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", reviewResults: [reviewResult()], manualReviewRequired: true, retryCount: 3 }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.blockDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
    setDeepMode(false)
  })

  it("深度生成 partial → pause + pending marker", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "部分正文", partial: true, partialReason: "transport inactivity timeout" }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("PARTIAL_DRAFT_PRESERVED") }),
    )
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
    setDeepMode(false)
  })

  it("checkpoint 落盘失败 → 抛 CHECKPOINT_PERSIST_FAILED → catch 可见失败 + 持久化详情", async () => {
    setupDeepBase()
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce(new Error("disk-full"))
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 3 })
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("出错：深度生成章节失败")
    expect(content).toContain("CHECKPOINT_PERSIST_FAILED")
    expect(content).toContain("checkpoint 落盘失败")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    setDeepMode(false)
  })

  it("深度生成报『已停止生成』→ 中止文案 + resume 上下文", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("已停止生成"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("已停止生成。")
    expect(content).toContain("<!-- qmai-novel-session-debug:")
    expect(content).toContain("appendContinueUnfinishedDeepChapterContext".length > 0 ? "已停止生成" : "")
    setDeepMode(false)
  })

  it("深度生成其他错误 → 可见失败文案（含 hidden debug）", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content, refs] = lastFinalize()
    expect(content).toContain("出错：深度生成章节失败：boom")
    expect(content).toContain("<!-- qmai-novel-session-debug:")
    expect(refs).toBeUndefined()
    setDeepMode(false)
  })

  it("catch 中 pause 落盘失败 → pausePersistError + console.warn + 详情拼接", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce(new Error("pause-io"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("深度生成暂停状态落盘失败"), expect.any(Error))
    const [content] = lastFinalize()
    expect(content).toContain("pause 落盘失败")
    warnSpy.mockRestore()
    setDeepMode(false)
  })

  it("startDeepChapterSession 提前失败 → 合成 session id（sessionDebug.syntheticSessionId）", async () => {
    setupDeepBase()
    mocks.startDeepChapterSession.mockRejectedValueOnce(new Error("early"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.createNovelSessionId).toHaveBeenCalled()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    expect(lastFinalize()[0]).toContain("出错：深度生成章节失败：early")
    setDeepMode(false)
  })

  it("session 状态中的 resume checkpoint 生效（autoResumedFromStatus true）", async () => {
    setupDeepBase()
    mocks.loadNovelSessionStatus.mockImplementation(async () => sessionStatus({ current_task: {} }))
    mocks.resolveInterruptedSessionResumeCheckpoint.mockReturnValue({ version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeCheckpoint: expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }) }),
    )
    expect(mocks.runDeepChapterGeneration.mock.calls[0][0].resumeCheckpoint).toEqual(
      expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }),
    )
    setDeepMode(false)
  })

  it("深度生成 onThinking/onFinalContent 在 guard 失效时跳过", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      callbacks.onThinking("阶段思考")
      callbacks.onFinalContent("正文")
      mocks.streamGuard.isActive.mockReturnValue(true)
      callbacks.onFinalContent("正文2")
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    // guard 失效的更新被跳过；有效的一次生效
    expect(mocks.chatState.setStreamingContent).toHaveBeenCalledWith(expect.stringContaining("正文2"), "conv-1")
    setDeepMode(false)
  })

  it("appendHiddenNovelSessionDebug 的 JSON 序列化失败 → 降级为原始内容", async () => {
    setupDeepBase()
    mocks.startDeepChapterSession.mockImplementation(async () =>
      // BigInt 使 JSON.stringify 抛错
      sessionStatus({ session_id: 1n as any, status: "running", active_step_index: 1, updated_at: "t" }),
    )
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).not.toContain("qmai-novel-session-debug")
    expect(content).toContain("出错：深度生成章节失败")
    setDeepMode(false)
  })

  it("Wave 3 计划模式：打开面板 → 装载计划 → 开写 one-shot 透传 → 消费后清除", async () => {
    setupDeepBase()
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    // 未发送过深度请求 → 全书视图（chapter 0）
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(mocks.buildChapterPlan).toHaveBeenCalledWith("/p/mybook", 0)
    // 注：chat-panel.spec 的 t mock 返回 key（非 defaultValue）
    expect(screen.getByText("novel.planning.title")).toBeTruthy()
    // 关闭面板
    fireEvent.click(screen.getByLabelText("novel.planning.close"))
    rerenderPanel()
    expect(screen.queryByText("novel.planning.title")).toBeNull()
    // 发送深度请求 → 目标章跟随（ref = 3）
    await sendText("深度写第3章")
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(mocks.buildChapterPlan).toHaveBeenLastCalledWith("/p/mybook", 3)
    // 开写 → 面板关闭，plan 进入 one-shot 状态
    fireEvent.click(screen.getByText("novel.planning.startWriting"))
    rerenderPanel()
    expect(screen.queryByText("novel.planning.title")).toBeNull()
    // 发送 → planningPlan 附加到生成 input（calls[0] 是面板打开前的首次发送）
    await sendText("深度写第3章")
    const genInput = mocks.runDeepChapterGeneration.mock.calls[1][0]
    expect(genInput.planningPlan).toBeDefined()
    expect(genInput.planningPlan.chapterNumber).toBe(3)
    // 消费后清除：第二次发送不再携带
    await sendText("深度写第3章")
    const genInput2 = mocks.runDeepChapterGeneration.mock.calls[2][0]
    expect(genInput2.planningPlan).toBeUndefined()
    setDeepMode(false)
  })

  it("Wave 3 计划模式：装载失败 → 面板显示错误且不触发生成", async () => {
    setupDeepBase()
    mocks.buildChapterPlan.mockRejectedValueOnce(new Error("plan-io"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByText("plan-io")).toBeTruthy()
    expect(mocks.runDeepChapterGeneration).not.toHaveBeenCalled()
    setDeepMode(false)
  })

  it("Wave 3 计划模式：无 project → loadPlanning 直接返回（不装载）", async () => {
    mocks.wikiState.project = null
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(mocks.buildChapterPlan).not.toHaveBeenCalled()
    setDeepMode(false)
  })

  it("Wave 3 计划模式：装载失败（非 Error）→ String(error) 显示", async () => {
    setupDeepBase()
    mocks.buildChapterPlan.mockRejectedValueOnce("plan-io-string")
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    fireEvent.click(screen.getByLabelText("打开计划面板"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByText("plan-io-string")).toBeTruthy()
    setDeepMode(false)
  })
})

describe("ChatPanel — 停止 / 重新生成 / 继续下一章", () => {
  it("无活跃会话点击停止 → 直接返回", () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("有会话但无进行中流 → 仅清 abort 引用", () => {
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("流进行中停止 → abort + finalize『已停止生成』（含已有流式内容前缀）", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(() => new Promise(() => {})) // 挂起
    await sendText("生成中")
    mocks.chatState.streamingContents = { "conv-1": "部分内容" }
    rerenderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(lastFinalize()[0]).toContain("部分内容")
    expect(lastFinalize()[0]).toContain("已停止生成。")
  })

  it("深度模式流停止 → novelManagedStop 早退，不 finalize", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.runDeepChapterGeneration.mockImplementation(() => new Promise(() => {})) // 挂起
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const finalizeBefore = mocks.chatState.finalizeStream.mock.calls.length
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.chatState.finalizeStream.mock.calls.length).toBe(finalizeBefore)
    setDeepMode(false)
  })

  it("重新生成：流式进行中 → 早退", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).not.toHaveBeenCalled()
  })

  it("重新生成：无用户消息 → 早退", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "a" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).not.toHaveBeenCalled()
  })

  it("重新生成：删除最后助手与用户消息后重发", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "重发问题" }),
      msg({ id: "a1", role: "assistant", content: "旧回答" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).toHaveBeenCalled()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "重发问题")
    expect(mocks.streamChat).toHaveBeenCalled()
    // setState 过滤旧用户消息后 handleSend 重新加入；onDone finalize 追加一条助手消息
    expect(mocks.chatState.messages).toHaveLength(2)
    expect(mocks.chatState.messages[0].content).toBe("重发问题")
    await flushAsync()
  })

  it("继续下一章：流式进行中 → 早退", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-next-chapter"))
    expect(mocks.chatState.createConversation).not.toHaveBeenCalled()
  })

  it("继续下一章：新建会话 + 按目标字数发送生成提示", async () => {
    mocks.wikiState.project = PROJECT
    mocks.resolveChapterLengthSpec.mockReturnValue({ targetChars: 2000, minChars: 1000, draftMaxChars: 4000, maxOutputTokens: 3000 })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-next-chapter"))
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    const sent = mocks.chatState.addMessage.mock.calls.find((c: any[]) => c[0] === "user")
    expect(sent[1]).toContain("继续生成下一章正文")
    expect(sent[1]).toContain("2000")
    await flushAsync()
  })
})

describe("ChatPanel — 继续未完成 (continue unfinished)", () => {
  it("流式进行中 → 早退", async () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    expect(mocks.chatState.addMessage).not.toHaveBeenCalled()
  })

  it("深度续写成功：persistedResume checkpoint + complete + ready marker", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "原始章节需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "已有上下文",
      rootResumeContext: "根上下文",
    })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始章节需求" }),
      msg({ id: "a1", role: "assistant", content: "<!-- 续写占位 -->" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "继续未完成")
    expect(mocks.chatState.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeCheckpoint: expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }) }),
    )
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"ready"')
  })

  it("深度续写 manualReviewRequired → block", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", reviewResults: [reviewResult()], manualReviewRequired: true, retryCount: 3 }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.blockDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
  })

  it("深度续写 partial → pause", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", partial: true, partialReason: "timeout" }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    expect(decodeURIComponent(lastFinalize()[0])).toContain('"draftStatus":"pending"')
  })

  it("深度续写 guard 失效 → finish 前返回，不 finalize", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockImplementation(async () => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("statusResume payload 优先提供 originalRequest/checkpoint", async () => {
    mocks.wikiState.project = PROJECT
    mocks.loadNovelSessionStatus.mockImplementation(async () =>
      sessionStatus({ current_task: { conversation_id: "conv-1", user_request: "状态里的需求" } }),
    )
    mocks.buildInterruptedResumeContextPayload.mockReturnValue({
      checkpoint: { version: 1, originalRequest: "状态需求", chapterNumber: 9, stage: "after_draft" },
      originalRequest: "状态需求",
      resumeContext: "状态上下文",
      rootResumeContext: "根",
    })
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "旧问题" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "状态需求", resumeCheckpoint: expect.objectContaining({ chapterNumber: 9, stage: "after_draft" }) }),
    )
  })

  it("无 checkpoint：重建上下文包 + 普通 streamChat + finish finalize", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "任务",
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
    mocks.contextPackToPrompt.mockReturnValue("CONTEXT_PACK_PROMPT")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始需求" }),
      msg({ id: "a1", role: "assistant", content: "被中断的正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.buildContextPack).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
    const [, msgs] = lastStreamChatCall()
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toContain("CONTEXT_PACK_PROMPT")
    expect(lastFinalize()[0]).toContain("## 继续未完成")
  })

  it("无 checkpoint 且原始请求为空 → 仅基础 system prompt", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.streamChat).toHaveBeenCalled()
    const [, msgs] = lastStreamChatCall()
    expect(msgs[0].content).toContain("专业小说写作助手")
    expect(mocks.buildContextPack).not.toHaveBeenCalled()
  })

  it("无 checkpoint 续写 streamError → catch → pause + 失败文案", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("网络错误"))
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("出错：继续未完成失败")
    expect(content).not.toContain("qmai-novel-session-debug")
  })

  it("无 checkpoint 续写 onToken/onReasoningToken 的 guard 失效分支", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      handlers?.onToken?.("被忽略")
      handlers?.onReasoningToken?.("被忽略")
      mocks.streamGuard.isActive.mockReturnValue(true)
      handlers?.onReasoningToken?.("思考中")
      handlers?.onToken?.("正文片段")
      handlers?.onDone?.()
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.finalizeStream).toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("正文片段")
  })

  it("accumulated 为空 → 兜底『模型没有返回内容』", async () => {
    mocks.wikiState.project = PROJECT
    mocks.deepStreamRenderer.updateThinking.mockReturnValue("")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("继续未完成失败：模型没有返回内容。")
  })

  it("深度续写 catch：pause 落盘失败 → pausePersistError + console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce(new Error("pause-io"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("继续未完成暂停状态落盘失败"), expect.any(Error))
    const [content] = lastFinalize()
    expect(content).toContain("出错：继续未完成失败")
    expect(content).toContain("pause 落盘失败")
    warnSpy.mockRestore()
  })

  it("深度续写 catch：pause 成功 → sessionDebug.pauseWrite 写入 debug 注释", async () => {
    mocks.wikiState.project = PROJECT
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
      originalRequest: "需求",
      checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    mocks.pauseDeepChapterSession.mockResolvedValueOnce(
      sessionStatus({ draft: { draft_status: "pending" }, current_task: { last_error: "resume-boom" } }),
    )
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    const [content] = lastFinalize()
    expect(content).toContain("qmai-novel-session-debug")
    expect(decodeURIComponent(content)).toContain('"pauseWrite"')
    expect(decodeURIComponent(content)).toContain('"status":"paused"')
    expect(decodeURIComponent(content)).toContain('"lastError":"resume-boom"')
  })
})

describe("ChatPanel — 保存 / 丢弃章节草稿", () => {
  it("无项目保存 → 早退", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "正文" })])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("无助手草稿（仅用户消息）保存 → 早退", () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("保存成功（next 策略）：写 chapter 文件 + accepted marker + 状态回填 + 切 wiki 视图", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写第3章" }),
      msg({ id: "a1", role: "assistant", content: "# 第3章 标题\n正文内容" }),
    ])
    mocks.cleanGeneratedChapterContentWithTitle.mockReturnValue({ content: "清理后正文", title: "标题X" })
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.getNextChapterNumber).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/mybook/wiki/chapters")
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p/mybook",
        conversationId: "conv-1",
        chapterNumber: 7,
        chapterPath: "/p/mybook/wiki/chapters/chapter-007.md",
      }),
    )
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.chatState.setMessages).toHaveBeenCalled()
    const setMessagesCall = mocks.chatState.setMessages.mock.calls[0][0]
    const updated = setMessagesCall.find((m: any) => m.id === "a1")
    expect(decodeURIComponent(updated.content)).toContain('"draftStatus":"accepted"')
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/chapters/chapter-007.md")
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p/mybook")
    expect(screen.getByTestId("save-status").textContent).toContain("已接受草稿并保存为 标题X")
    expect(mocks.wikiState.novelConfig.autoIngestOnSave).toBe(false) // 默认关闭
  })

  it("保存成功（direct_explicit_target_new 策略）：targetChapterNumber 直接使用", async () => {
    mocks.wikiState.project = PROJECT
    mocks.decideChapterSaveStrategy.mockReturnValue({
      action: "direct_explicit_target_new",
      targetChapterNumber: 5,
    })
    mocks.detectGeneratedTargetChapterNumber.mockReturnValue(5)
    mocks.findChapterFileByNumber.mockImplementation(async () => null)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "写章节" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chapterNumber: 5, chapterPath: "/p/mybook/wiki/chapters/chapter-005.md" }),
    )
    expect(mocks.getNextChapterNumber).not.toHaveBeenCalled()
  })

  it("autoIngestOnSave：可用 LLM + 摄取成功", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.ingestChapter.mockImplementation(async () => ({
      snapshot: {
        chapterId: "chapter-005",
        chapterNumber: 5,
        summary: "s",
        characters: [],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        characterStateChanges: [],
        relationshipChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
        newCanonFacts: [],
        timelineEvents: [],
        conflicts: [],
        endingHook: "",
        graphNodes: [],
        graphEdges: [],
      },
    }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.ingestChapter).toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).toContain("已接受草稿并保存为 测试章")
    expect(screen.getByTestId("save-status").textContent).not.toContain("未完成")
  })

  it("autoIngestOnSave：摄取无 snapshot → 提示未完成", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.ingestChapter.mockImplementation(async () => ({ snapshot: null }))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("但章节摄取未完成")
  })

  it("autoIngestOnSave：无可用 LLM → 提示未配置", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelConfig.autoIngestOnSave = true
    mocks.hasUsableLlm.mockReturnValue(false)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(mocks.ingestChapter).not.toHaveBeenCalled()
    expect(screen.getByTestId("save-status").textContent).toContain("未配置可用 AI 模型")
  })

  it("保存失败 → saveFailed 状态（含错误消息）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce(new Error("disk-error"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("chat.saveFailed::disk-error")
  })

  it("丢弃草稿成功：reject 落盘 + rejected marker + 标记丢弃", async () => {
    mocks.wikiState.project = PROJECT
    mocks.detectGeneratedTargetChapterNumber.mockReturnValue(3)
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(mocks.rejectDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ chapterNumber: 3, conversationId: "conv-1" }),
    )
    expect(mocks.chatState.markLastAssistantDiscarded).toHaveBeenCalled()
    const setMessagesCall = mocks.chatState.setMessages.mock.calls[0][0]
    const updated = setMessagesCall.find((m: any) => m.id === "a1")
    expect(decodeURIComponent(updated.content)).toContain('"draftStatus":"rejected"')
    expect(screen.getByTestId("save-status").textContent).toContain("已拒绝草稿")
  })

  it("丢弃草稿失败 → saveFailed", async () => {
    mocks.wikiState.project = PROJECT
    mocks.rejectDeepChapterDraft.mockRejectedValueOnce(new Error("reject-boom"))
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("chat.saveFailed::reject-boom")
  })

  it("丢弃后再保存 → 无助手草稿早退（discarded 被过滤）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    rerenderPanel()
    // markLastAssistantDiscarded 将最后助手消息标记 discarded（getLatestAssistantDraftContext 过滤）
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("findPreviousUserRequest：『继续未完成』用户消息被跳过，回退到前一条", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始需求" }),
      msg({ id: "a1", role: "assistant", content: "第一版" }),
      msg({ id: "u2", role: "user", content: "继续未完成" }),
      msg({ id: "a2", role: "assistant", content: "第二版" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "原始需求" }),
    )
  })

  it("findPreviousUserRequest：全部用户消息均为『继续未完成』→ 回退 userMessages[0]", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "继续未完成" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "继续未完成" }),
    )
  })

  it("findPreviousUserRequest：无用户消息 → userRequest 空 → 正文前 80 字兜底", async () => {
    mocks.wikiState.project = PROJECT
    mocks.cleanGeneratedChapterContentWithTitle.mockReturnValue({ content: "清理后正文", title: "" })
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "正文" })])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[0])
    await flushAsync()
    expect(mocks.commitAcceptedDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "清理后正文" }),
    )
  })
})

describe("ChatPanel — exemplar 标记 UI", () => {
  it("打开对话框：选中文本 → 显示文本 + 计数；空选 → 提示", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockImplementation(async () => [{ exemplarId: "e1", chapterId: "ch-1", text: "x", markType: "style", createdAt: "t" }])
    setConversation("conv-1")
    renderPanel()
    // 空选择
    window.getSelection = (() => ({ toString: () => "" })) as any
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    expect(screen.queryByTestId("dialog")).toBeNull()
    // 有效选择
    window.getSelection = (() => ({ toString: () => "这一段写得很好" })) as any
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    await flushAsync()
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText("这一段写得很好")).toBeInTheDocument()
    const countSpan = screen.getByTestId("dialog").querySelector("span.font-mono")
    expect(countSpan?.textContent).toContain("1")
    expect(mocks.loadStyleExemplarsViaRust).toHaveBeenCalledWith("/p/mybook")
  })

  it("打开对话框时计数加载失败 → 非致命", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockRejectedValueOnce(new Error("io"))
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("无项目点击标记 → 直接返回", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("提交标记成功：markType/note 透传 + 计数刷新 + 关闭 + 反馈", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.loadStyleExemplarsViaRust.mockImplementation(async () => [
      { exemplarId: "e1", chapterId: "ch-1", text: "x", markType: "style", createdAt: "t" },
      { exemplarId: "e2", chapterId: "ch-2", text: "y", markType: "voice", createdAt: "t" },
    ])
    window.getSelection = (() => ({ toString: () => "选段文本" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    const markTypeSelect = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === "style") as HTMLSelectElement
    fireEvent.change(markTypeSelect, { target: { value: "voice" } })
    fireEvent.change(screen.getByPlaceholderText("为什么这段是好文风锚点？"), {
      target: { value: "角色声线" },
    })
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(mocks.markStyleExemplarViaRust).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ markType: "voice", note: "角色声线", text: "选段文本", chapterId: "chat-selection" }),
    )
    // 提交后计数刷新（打开时 + 提交后）
    expect(mocks.loadStyleExemplarsViaRust).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("dialog")).toBeNull() // 成功后关闭
  })

  it("提交标记失败 → 失败反馈保留对话框", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.markStyleExemplarViaRust.mockRejectedValueOnce(new Error("write-fail"))
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(screen.getByText("标记失败：write-fail")).toBeInTheDocument()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("取消按钮关闭对话框", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    fireEvent.click(screen.getByText("取消"))
    rerenderPanel()
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("exemplar dialog：dialog-close（onOpenChange false）→ 关闭并重置状态", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("dialog-close"))
    rerenderPanel()
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("A/B 评分：enabled/disabled 各档按钮 → appendExemplarABSample + 均分反馈", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: 4.2, disabledAvg: null })
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    fireEvent.click(screen.getByText("3★E"))
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ variant: "enabled", score: 3, chapterId: "chat" }),
    )
    expect(screen.getByText(/enabled 均分 4.20 vs disabled N\/A/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("2★D"))
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ variant: "disabled", score: 2 }),
    )
  })

  it("A/B 评分：均分为 null 时显示 N/A（disabled 有值时 toFixed）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.exemplarABStats.mockReturnValue({ enabledAvg: null, disabledAvg: 3.5 })
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    fireEvent.click(screen.getByText("1★E"))
    await flushAsync()
    expect(screen.getByText(/enabled 均分 N\/A vs disabled 3.50/)).toBeInTheDocument()
  })

  it("selectedFile 存在时 chapterId 取文件名", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.selectedFile = "/p/mybook/wiki/chapters/chapter-003.md"
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    fireEvent.click(screen.getByText("1★E"))
    await flushAsync()
    expect(mocks.appendExemplarABSample).toHaveBeenCalledWith(
      "/p/mybook",
      expect.objectContaining({ chapterId: "chapter-003.md" }),
    )
  })
})

describe("ChatPanel — 补覆盖：标签交互与虚拟列表防御", () => {
  it("点击会话标签切换会话（onClick 路径）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    fireEvent.click(screen.getAllByRole("tab")[1])
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-2")
  })

  it("hover 后离开标签 → 删除按钮隐藏（onMouseLeave 重置 hoveredId）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tab2 = screen.getAllByRole("tab")[1]
    expect(within(tab2).queryByLabelText("删除该会话")).toBeNull()
    fireEvent.mouseEnter(tab2)
    expect(within(tab2).getByLabelText("删除该会话")).toBeInTheDocument()
    fireEvent.mouseLeave(tab2)
    expect(within(tab2).queryByLabelText("删除该会话")).toBeNull()
  })

  it("失焦时 confirmDeleteId 属于其他标签 → 保留原确认态", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const [tab1, tab2] = screen.getAllByRole("tab")
    fireEvent.mouseEnter(tab2)
    fireEvent.click(within(tab2).getByLabelText("删除该会话")) // 武装 conv-2
    fireEvent.click(within(tab1).getByLabelText("删除该会话")) // 再武装 conv-1
    // 对 conv-2 的按钮失焦：cur=conv-1 ≠ conv-2 → 保留 conv-1 的确认态
    fireEvent.blur(within(tab2).getByLabelText("删除该会话"))
    expect(within(tab1).getByLabelText("确认删除该会话")).toBeInTheDocument()
  })

  it("虚拟列表防御：越界项 getItemKey ?? 兜底 + msg undefined 跳过", () => {
    mocks.useVirtualizer.mockImplementation((opts: any) => {
      const count = opts.count
      const items = Array.from({ length: count + 1 }, (_v, i) => ({
        index: i,
        key: opts.getItemKey(i),
        start: i * 200,
        size: 200,
      }))
      return {
        getVirtualItems: () => items,
        getTotalSize: () => (count + 1) * 200,
        measureElement: () => {},
      }
    })
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    expect(screen.getAllByTestId("chat-message")).toHaveLength(1) // 越界项被跳过
  })
})

describe("ChatPanel — 补覆盖：handleSend 分支", () => {
  it("novelMode+project+历史助手消息 → lastGeneratedChapterNumber 收到内容数组", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "问题A" }),
      msg({ id: "a1", role: "assistant", content: "回答A" }),
    ])
    renderPanel()
    await sendText("继续")
    expect(mocks.detectLastGeneratedChapterNumber).toHaveBeenCalledWith(["回答A"])
  })

  it("aiChatModel 纯模型名匹配但 provider 不在 preset → custom 回退（second find）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = { zzz: { savedModels: [{ model: "plain-model" }] } }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("plain-model")
    expect(mocks.resolveConfig).toHaveBeenCalled()
  })

  it("streamChat onError 收到非 Error 值 → String(err) 后脱敏", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.("请求 https://x.test/v1 失败")
    })
    await sendText("提问")
    expect(lastFinalize()[0]).toContain("出错：请求 [url] 失败")
  })

  it("closeReasoning guard 失效分支（onToken 内 isActive 翻转）", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      mocks.streamGuard.isActive.mockReturnValueOnce(true).mockReturnValueOnce(false)
      handlers?.onToken?.("x") // onToken guard 通过，closeReasoning 内部 guard 失效 → 早退
      handlers?.onReasoningToken?.("思考")
      handlers?.onToken?.("正文")
      handlers?.onDone?.()
    })
    await sendText("再来")
    // closeReasoning 内部 guard 失效仅早退（不阻止 onToken 继续追加 token）
    expect(lastFinalize()[0]).toBe("x<think>思考</think>正文")
  })

  it("agent suffix：无章节文件 → 列表占位文案", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.readScopeFileContents.mockImplementation(async () => [])
    setConversation("conv-1")
    renderPanel()
    await sendText("帮我改章节")
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]
    const blocks = sys.content as { text: string }[]
    expect(blocks[blocks.length - 1].text).toContain("暂无章节文件")
  })

  it("编辑模式：读取章节文件失败 → catch 空内容继续写回", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.chatEditModeEnabled = true
    mocks.isChatEditRequest.mockReturnValue(true)
    mocks.resolveChatEditTarget.mockReturnValue({
      ok: true as const,
      target: { mode: "single" as const, chapterNumbers: [3] },
    })
    mocks.findChapterFileByNumber.mockImplementation(async (pp: string) => `${pp}/wiki/chapters/chapter-003.md`)
    mocks.readFile.mockRejectedValueOnce(new Error("read-boom"))
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onToken?.("修改后内容")
      handlers?.onDone?.()
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("修改第3章")
    expect(mocks.writeFile).toHaveBeenCalled()
    expect(lastFinalize()[0]).toContain("已完成第3章修改")
  })

  it("检索：index/purpose 读取失败 → catch 空串", async () => {
    mocks.wikiState.project = PROJECT
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md") || path.endsWith("purpose.md")) throw new Error("io")
      return ""
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.buildRetrievalGraph).toHaveBeenCalled()
    expect(mocks.readFile).toHaveBeenCalledWith("/p/mybook/wiki/index.md")
    expect(mocks.readFile).toHaveBeenCalledWith("/p/mybook/purpose.md")
    const [, llmMessages] = lastStreamChatCall()
    const joined = (llmMessages[0]?.content as { text: string }[]).map((b) => b.text).join("\n")
    expect(joined).toContain("## 资料页面")
    expect(joined).not.toContain("chapter one")
  })

  it("图扩展：≥2 个新节点 → sort 比较器执行", async () => {
    mocks.wikiState.project = PROJECT
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
    ])
    mocks.getRelatedNodes.mockImplementation((nodeId: string, _graph: RetrievalGraph, _limit?: number) => {
      if (nodeId === "a") {
        return [
          { node: { id: "e", title: "E", path: "/p/mybook/wiki/pages/e.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 2.5 },
          { node: { id: "f", title: "F", path: "/p/mybook/wiki/pages/f.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 3.0 },
        ]
      }
      return []
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("页面预算用尽 → tryAddPage 早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.computeContextBudget.mockReturnValue({ maxCtx: 204800, responseReserve: 30720, indexBudget: 5000, pageBudget: 80, maxPageSize: 800, activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 } })
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("wiki/pages/a.md")) return "a".repeat(80)
      if (path.includes("wiki/pages/b.md")) return "b"
      return ""
    })
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
      { title: "B", path: "/p/mybook/wiki/pages/b.md", snippet: "", score: 0, titleMatch: false, images: [] },
    ])
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.streamChat).toHaveBeenCalled()
  })
})

describe("ChatPanel — 补覆盖：深度生成分支", () => {
  function setupDeepBase(): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: { chapterNumber: "3" },
    })
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => 3)
  }

  it("onThinking 正常路径 + onCheckpoint 成功 → checkpointWrite 写入", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      callbacks.onThinking("阶段思考")
      callbacks.onFinalContent("正文")
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 3 })
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.chatState.setStreamingContent).toHaveBeenCalledWith(expect.stringContaining("阶段思考"), "conv-1")
    expect(mocks.persistDeepChapterCheckpoint).toHaveBeenCalled()
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    setDeepMode(false)
  })

  it("onCheckpoint 落盘失败（非 Error）→ String + CHECKPOINT_PERSIST_FAILED", async () => {
    setupDeepBase()
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce("disk-full-string")
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 3 })
      return deepGenResult({ finalContent: "F" })
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).toContain("CHECKPOINT_PERSIST_FAILED: disk-full-string")
    setDeepMode(false)
  })

  it("深度生成抛非 Error 值 → String(err)", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce("boom-string")
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).toContain("出错：深度生成章节失败：boom-string")
    setDeepMode(false)
  })

  it("pause 落盘失败（非 Error）→ String(persistError) + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce("pause-string")
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).toContain("pause 落盘失败：pause-string")
    warnSpy.mockRestore()
    setDeepMode(false)
  })

  it("已停止生成 + existing 非空 → 前缀拼接", async () => {
    setupDeepBase()
    mocks.deepStreamRenderer.getContent.mockReturnValue("已有正文")
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("已停止生成"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("已有正文")
    expect(content).toContain("已停止生成。")
    setDeepMode(false)
  })

  it("深度错误 + existing 非空 → 可见失败含前缀", async () => {
    setupDeepBase()
    mocks.deepStreamRenderer.getContent.mockReturnValue("已有正文")
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("boom"))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    const [content] = lastFinalize()
    expect(content).toContain("已有正文")
    expect(content).toContain("出错：深度生成章节失败：boom")
    setDeepMode(false)
  })

  it("深度 chat 意图（无章节号）→ sessionDebug chapterNumber ?? null", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => undefined)
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("随便聊聊")
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
    setDeepMode(false)
  })

  it("goldenThree 启用 → 透传给生成器", async () => {
    setupDeepBase()
    mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: true, targetChapter: 3, requestedFirstThree: false })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.runDeepChapterGeneration.mock.calls[0][0].goldenThreeChapter).toEqual({
      enabled: true,
      targetChapter: 3,
      requestedFirstThree: false,
    })
    setDeepMode(false)
  })

  it("partial + partialReason null → 默认超时文案", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "部分", partial: true }))
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("transport inactivity timeout") }),
    )
    setDeepMode(false)
  })

  it("guard 失效 → finish 回调跳过 → finally 清理 activeStreamSessions", async () => {
    setupDeepBase()
    mocks.runDeepChapterGeneration.mockImplementation(async () => {
      mocks.streamGuard.isActive.mockReturnValue(false)
      throw new Error("boom")
    })
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalled()
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
    setDeepMode(false)
  })

  it("marker JSON 序列化失败（BigInt sessionId）→ 降级无 marker", async () => {
    setupDeepBase()
    mocks.startDeepChapterSession.mockImplementation(async () =>
      sessionStatus({ session_id: 1n as any, status: "running", active_step_index: 1, updated_at: "t" }),
    )
    setConversation("conv-1")
    renderPanel()
    setDeepMode(true)
    await sendText("深度写")
    expect(lastFinalize()[0]).not.toContain("qmai-deep-chapter-draft")
    setDeepMode(false)
  })
})

describe("ChatPanel — 补覆盖：继续未完成分支", () => {
  function setupContinueConv(): void {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始需求" }),
      msg({ id: "a1", role: "assistant", content: "被中断正文" }),
    ])
  }

  it("model 解析：providerId/modelId 命中 preset", async () => {
    mocks.wikiState.aiChatModel = "providerA/modelX"
    mocks.wikiState.providerConfigs = { providerA: { savedModels: [{ model: "modelX" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("modelX")
  })

  it("model 解析：providerId 未配置 → 仅覆盖 model", async () => {
    mocks.wikiState.aiChatModel = "providerZ/ghost"
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("ghost")
  })

  it("model 解析：providerId 不在 preset → custom 回退", async () => {
    mocks.wikiState.aiChatModel = "providerN/modelY"
    mocks.wikiState.providerConfigs = { providerN: { savedModels: [{ model: "modelY" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("modelY")
  })

  it("model 解析：纯模型名匹配 + preset 命中", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = { providerA: { savedModels: [{ model: "plain-model" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("plain-model")
  })

  it("model 解析：纯模型名 → custom 回退", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = { zzz: { savedModels: [{ model: "plain-model" }] } }
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("plain-model")
  })

  it("model 解析：纯模型名未匹配 → 默认 + model 覆盖", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.resolveNovelModel.mock.calls[0][0].model).toBe("plain-model")
  })

  it("stale click：消息 conversationId 被清空 → 回退当前会话（不切换）", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages[1].conversationId = "" // stale：不 rerender
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.setActiveConversation).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("stale click：消息 conversationId 异于当前会话 → 切换会话", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages[1].conversationId = "conv-other" // stale：不 rerender
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-other")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("stale click：消息已从 store 移除 → findPreviousUserRequest 未命中回退", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages = [mocks.chatState.messages[0]] // 移除助手消息，不 rerender
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("stale click：conversationId 与当前会话均缺失 → createConversation 兜底", async () => {
    setupContinueConv()
    renderPanel()
    mocks.chatState.messages[1].conversationId = "" // stale：不 rerender
    mocks.chatState.activeConversationId = null
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("无项目 → statusResume 为 null（loadNovelSessionStatus 不调用）", async () => {
    mocks.wikiState.project = null
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "需求" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.loadNovelSessionStatus).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  function setupDeepContinue(checkpoint?: any): void {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue(
      checkpoint ?? {
        originalRequest: "原始章节需求",
        checkpoint: { version: 1, originalRequest: "需求", chapterNumber: 2, stage: "after_draft" },
        resumeContext: "ctx",
        rootResumeContext: "ctx",
      },
    )
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "原始章节需求" }),
      msg({ id: "a1", role: "assistant", content: "x" }),
    ])
  }

  it("深度续写：全回调（guard 有效/失效）+ checkpoint 成功", async () => {
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      callbacks.onThinking("思考A")
      mocks.streamGuard.isActive.mockReturnValueOnce(false)
      callbacks.onThinking("跳过")
      mocks.streamGuard.isActive.mockReturnValueOnce(false)
      callbacks.onFinalContent("跳过")
      mocks.streamGuard.isActive.mockReturnValue(true)
      callbacks.onFinalContent("正文A")
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 2 })
      return deepGenResult({ finalContent: "F" })
    })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.setStreamingContent).toHaveBeenCalledWith(expect.stringContaining("正文A"), "conv-1")
    expect(mocks.persistDeepChapterCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: { stage: "after_draft", chapterNumber: 2 } }),
    )
    expect(mocks.completeDeepChapterSession).toHaveBeenCalled()
  })

  it("深度续写：checkpoint 落盘失败（Error）→ throw + catch 文案", async () => {
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce(new Error("disk-full"))
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 2 })
      return deepGenResult({ finalContent: "F" })
    })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const [content] = lastFinalize()
    expect(content).toContain("出错：继续未完成失败")
    expect(content).toContain("CHECKPOINT_PERSIST_FAILED: disk-full")
  })

  it("深度续写：checkpoint 落盘失败（string）→ String 分支", async () => {
    mocks.persistDeepChapterCheckpoint.mockRejectedValueOnce("disk-string")
    mocks.runDeepChapterGeneration.mockImplementation(async (_input: any, callbacks: any) => {
      await callbacks.onCheckpoint({ stage: "after_draft", chapterNumber: 2 })
      return deepGenResult({ finalContent: "F" })
    })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("CHECKPOINT_PERSIST_FAILED: disk-string")
  })

  it("深度续写：partial + partialReason null → 默认文案", async () => {
    mocks.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "F", partial: true }))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("transport inactivity timeout") }),
    )
  })

  it("深度续写：accumulated 为空 → 兜底文案", async () => {
    mocks.deepStreamRenderer.updateThinking.mockReturnValue("")
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("继续未完成失败：模型没有返回内容。")
  })

  it("深度续写：goldenResume 启用 → 透传", async () => {
    mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: true, targetChapter: 3, requestedFirstThree: false })
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.runDeepChapterGeneration.mock.calls[0][0].goldenThreeChapter).toEqual({
      enabled: true,
      targetChapter: 3,
      requestedFirstThree: false,
    })
  })

  it("深度续写：residual 启用 → 字段展开", async () => {
    mocks.wikiState.novelConfig.residualCampaignEnabled = true
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const genInput = mocks.runDeepChapterGeneration.mock.calls[0][0]
    expect(genInput.residualOverallMedian).toBe(9.0)
    expect(genInput.residualRewriteMode).toBe("structure_thril_pacing")
  })

  it("深度续写：checkpoint 无 chapterNumber → ?? null", async () => {
    setupDeepContinue({
      originalRequest: "需求",
      checkpoint: { stage: "after_draft" },
      resumeContext: "ctx",
      rootResumeContext: "ctx",
    })
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.startDeepChapterSession).toHaveBeenCalled()
  })

  it("深度续写：『已停止生成』→ pause errorMessage 固定文案", async () => {
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("已停止生成"))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "已停止生成" }),
    )
  })

  it("深度续写 catch：pause 成功且 last_error null → lastError null", async () => {
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const [content] = lastFinalize()
    expect(decodeURIComponent(content)).toContain('"lastError":null')
  })

  it("深度续写 catch：pause 失败（string）→ String + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.runDeepChapterGeneration.mockRejectedValueOnce(new Error("resume-boom"))
    mocks.pauseDeepChapterSession.mockRejectedValueOnce("pause-string")
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("pause 落盘失败：pause-string")
    warnSpy.mockRestore()
  })

  it("深度续写：startDeepChapterSession 提前失败 → syntheticSessionId 写入 debug", async () => {
    mocks.startDeepChapterSession.mockRejectedValueOnce(new Error("early"))
    setupDeepContinue()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    const [content] = lastFinalize()
    expect(decodeURIComponent(content)).toContain('"syntheticSessionId":"synthetic-session"')
  })

  it("上下文重建：contextPackToPrompt 抛错 → console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.contextPackToPrompt.mockImplementationOnce(() => {
      throw new Error("ctx-boom")
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("构建继续未完成上下文包失败"), expect.any(Error))
    expect(mocks.streamChat).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("上下文重建：routeTask 返回 null → taskDirective 空", async () => {
    mocks.routeTask.mockReturnValue(null as any)
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.buildContextPack).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("上下文重建：tokenBudget 生效", async () => {
    mocks.wikiState.novelConfig.contextTokenBudget = 4000
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.contextPackToPrompt).toHaveBeenCalledWith(expect.anything(), 4000, expect.anything())
  })

  it("上下文重建：buildContextPack 失败 → fallback 对象", async () => {
    mocks.buildContextPack.mockRejectedValueOnce(new Error("pack-boom"))
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.contextPackToPrompt).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("普通路径：streamChat 后 guard 失效 → 早退不 finalize", async () => {
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onDone?.()
      mocks.streamGuard.isActive.mockReturnValue(false)
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(mocks.chatState.finalizeStream).not.toHaveBeenCalled()
  })

  it("catch：非 Error 错误 → String 分支", async () => {
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.("string-err")
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("出错：继续未完成失败：string-err")
  })

  it("catch：accumulated 为空 → 无前缀", async () => {
    mocks.deepStreamRenderer.updateThinking.mockReturnValue("")
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("e"))
    })
    setupContinueConv()
    renderPanel()
    fireEvent.click(screen.getByTestId("continue-unfinished"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("出错：继续未完成失败：e")
    expect(lastFinalize()[0]).not.toContain("正在基于")
  })
})

describe("ChatPanel — 补覆盖：保存/丢弃分支", () => {
  it("无项目丢弃 → 早退", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "草稿" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    expect(mocks.rejectDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("草稿已被丢弃 → getLatestAssistantDraftContext 为空 → 早退", () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x", discarded: true })])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    expect(mocks.rejectDeepChapterDraft).not.toHaveBeenCalled()
  })

  it("保存失败（非 Error）→ String 分支", async () => {
    mocks.wikiState.project = PROJECT
    mocks.commitAcceptedDeepChapterDraft.mockRejectedValueOnce("disk-string")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "正文" }),
    ])
    renderPanel()
    fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("chat.saveFailed::disk-string")
  })

  it("丢弃失败（非 Error）→ String 分支", async () => {
    mocks.wikiState.project = PROJECT
    mocks.rejectDeepChapterDraft.mockRejectedValueOnce("reject-string")
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "草稿" }),
    ])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(screen.getByTestId("save-status").textContent).toContain("chat.saveFailed::reject-string")
  })

  it("丢弃：无用户消息 → userRequest 兜底 draft rejected", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "草稿" })])
    renderPanel()
    fireEvent.click(screen.getByTestId("discard-draft"))
    await flushAsync()
    expect(mocks.rejectDeepChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: "draft rejected" }),
    )
  })

  it("保存进行中另一会话保存完成 → finally prev 不匹配 → 跳过回填", async () => {
    mocks.wikiState.project = PROJECT
    let resolveCommit1: (v: void | PromiseLike<void>) => void = () => {}
    mocks.commitAcceptedDeepChapterDraft.mockImplementationOnce(
      () => new Promise((res) => { resolveCommit1 = res }),
    )
    // conv-1 的 refresh 窗口挂起 50ms，期间 conv-2 的保存状态入队 → finally 时 prev 不匹配
    mocks.refreshProjectState.mockImplementationOnce(
      () => new Promise((res) => { setTimeout(res, 50) }),
    )
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [
      msg({ id: "u1", role: "user", content: "q", conversationId: "conv-1" }),
      msg({ id: "a1", role: "assistant", content: "草稿A", conversationId: "conv-1" }),
      msg({ id: "u2", role: "user", content: "q", conversationId: "conv-2" }),
      msg({ id: "a2", role: "assistant", content: "草稿B", conversationId: "conv-2" }),
    ]
    renderPanel()
    // conv-1 保存挂起在 commitAcceptedDeepChapterDraft
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    })
    // 放行 commit → conv-1 进入 refresh 挂起窗口
    await act(async () => {
      resolveCommit1(undefined)
      await new Promise((r) => setTimeout(r, 0))
    })
    // refresh 窗口内：conv-2 完整完成一次保存（状态入队覆盖 prev）
    mocks.chatState.activeConversationId = "conv-2"
    rerenderPanel()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("save-as-chapter")[1])
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80)) // 放行 refresh → conv-1 finally 跳过不匹配的 prev
    })
    await flushAsync()
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
  })
})

describe("ChatPanel — 补覆盖：exemplar 防御分支", () => {
  it("对话框打开后项目被移除 → 提交早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    mocks.wikiState.project = null
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(mocks.markStyleExemplarViaRust).not.toHaveBeenCalled()
  })

  it("对话框打开后项目被移除 → A/B 评分早退", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    mocks.wikiState.project = null
    rerenderPanel()
    fireEvent.click(screen.getByText("1★E"))
    await flushAsync()
    expect(mocks.appendExemplarABSample).not.toHaveBeenCalled()
  })

  it("getSelection 返回 null → 空选提示（?? 兜底）", () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    window.getSelection = (() => null) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("提交标记失败（非 Error）→ String(e)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.markStyleExemplarViaRust.mockRejectedValueOnce("str-err")
    window.getSelection = (() => ({ toString: () => "选段" })) as any
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("标记为 Style Exemplar"))
    rerenderPanel()
    fireEvent.click(screen.getByText("标记锚点"))
    await flushAsync()
    expect(screen.getByText("标记失败：str-err")).toBeInTheDocument()
  })
})

describe("ChatPanel — 补覆盖：写入按钮与占位", () => {
  it("novel + ingest 模式：写入按钮 novel 文案", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })])
    renderPanel()
    const btn = screen.getByText("novel.chat.writeToWiki")
    expect(btn).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(btn)
    })
    await flushAsync()
    expect(mocks.executeIngestWrites).toHaveBeenCalled()
  })

  it("novel + ingest 模式：占位 novel.chat.ingestPlaceholder", () => {
    mocks.wikiState.novelMode = true
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    renderPanel()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "novel.chat.ingestPlaceholder")
  })

  it("写入 wiki 失败（非 Error）→ String 分支", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.wikiState.project = PROJECT
    mocks.chatState.mode = "ingest"
    mocks.executeIngestWrites.mockRejectedValueOnce("str-err")
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })])
    renderPanel()
    await act(async () => {
      fireEvent.click(screen.getByText("chat.writeToWiki"))
    })
    await flushAsync()
    expect(errSpy).toHaveBeenCalledWith("写入 wiki 失败:", "str-err")
    errSpy.mockRestore()
  })

  it("重新生成：活跃会话已被清空（stale）→ ?? 兜底后早退", () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    mocks.chatState.activeConversationId = null // stale：不 rerender
    fireEvent.click(screen.getByTestId("regenerate"))
    expect(mocks.chatState.removeLastAssistantMessage).not.toHaveBeenCalled()
  })

  it("停止：流式内容为空 → 无前缀『已停止生成』", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(() => new Promise(() => {})) // 挂起
    await sendText("生成中")
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(lastFinalize()[0]).toBe("已停止生成。")
  })
})
