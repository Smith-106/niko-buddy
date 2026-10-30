/**
 * runContinueUnfinished — 「继续未完成」分支直接契约（chat-panel 拆分 T7）。
 *
 * mock novel 桶 / resume helper / llm-client，聚焦：
 * - 流式进行中早退（不 addMessage、不 streamChat）
 * - 深度续写 manualReviewRequired → blockDeepChapterSession + pending marker
 * - 深度续写 partial → pauseDeepChapterSession（留待继续正文）
 * - 无项目回退路径：addMessage("user", "继续未完成") + streamChat + finalizeStream
 * - catch 路径：finalizeStream 输出「出错：继续未完成失败」并清理 ref
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createStreamSessionGuard, type StreamSessionGuard } from "./stream-session"
import { runContinueUnfinished, type ChatContinueUnfinishedContext } from "./chat-panel-continue-unfinished"
import type { DisplayMessage, MessageReference } from "@/stores/chat-store"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  // @/lib/novel 桶
  loadNovelSessionStatus: vi.fn(),
  routeTask: vi.fn(),
  detectGoldenThreeChapterRequest: vi.fn(),
  buildGoldenThreeChapterDirective: vi.fn(),
  buildQmQuaiSystemPrompt: vi.fn(),
  buildTaskDirective: vi.fn(),
  resolveNovelModel: vi.fn(),
  buildStageJournalRuntime: vi.fn(),
  novelSessionStatusPath: vi.fn(),
  startDeepChapterSession: vi.fn(),
  persistDeepChapterCheckpoint: vi.fn(),
  completeDeepChapterSession: vi.fn(),
  blockDeepChapterSession: vi.fn(),
  pauseDeepChapterSession: vi.fn(),
  createNovelSessionId: vi.fn(),
  // @/lib/chat/resume
  appendContinueUnfinishedDeepChapterContext: vi.fn(),
  buildInterruptedResumeContextPayload: vi.fn(),
  buildContinueUnfinishedDeepChapterPrompt: vi.fn(),
  extractContinueUnfinishedDeepChapterContext: vi.fn(),
  stripContinueUnfinishedDeepChapterContext: vi.fn(),
  // @/lib/novel/deep-chapter-generation（动态 import）
  runDeepChapterGeneration: vi.fn(),
  // @/lib/novel/residual-campaign（动态 import）
  resolveResidualCampaignFields: vi.fn(),
  // @/lib/llm-client（回退路径）
  streamChat: vi.fn(),
  // stores
  chatState: {
    activeConversationId: "conv-1",
    messages: [] as DisplayMessage[],
    setActiveConversation: vi.fn(),
  },
  wikiNovelConfig: {
    consensusEnabled: false,
    consensusWritingModels: [],
    stageJournalEnabled: false,
    journalTtlMs: 3600_000,
    genre: "都市",
    contextTokenBudget: 0,
    hardInjectEnabled: false,
    residualCampaignEnabled: false,
  } as unknown as NovelConfig,
}))

vi.mock("@/lib/novel", () => ({
  loadNovelSessionStatus: mocks.loadNovelSessionStatus,
  routeTask: mocks.routeTask,
  detectGoldenThreeChapterRequest: mocks.detectGoldenThreeChapterRequest,
  buildGoldenThreeChapterDirective: mocks.buildGoldenThreeChapterDirective,
  buildQmQuaiSystemPrompt: mocks.buildQmQuaiSystemPrompt,
  buildTaskDirective: mocks.buildTaskDirective,
  resolveNovelModel: mocks.resolveNovelModel,
  buildStageJournalRuntime: mocks.buildStageJournalRuntime,
  novelSessionStatusPath: mocks.novelSessionStatusPath,
  startDeepChapterSession: mocks.startDeepChapterSession,
  persistDeepChapterCheckpoint: mocks.persistDeepChapterCheckpoint,
  completeDeepChapterSession: mocks.completeDeepChapterSession,
  blockDeepChapterSession: mocks.blockDeepChapterSession,
  pauseDeepChapterSession: mocks.pauseDeepChapterSession,
  createNovelSessionId: mocks.createNovelSessionId,
}))

vi.mock("@/lib/chat/resume", () => ({
  appendContinueUnfinishedDeepChapterContext: mocks.appendContinueUnfinishedDeepChapterContext,
  buildInterruptedResumeContextPayload: mocks.buildInterruptedResumeContextPayload,
  buildContinueUnfinishedDeepChapterPrompt: mocks.buildContinueUnfinishedDeepChapterPrompt,
  extractContinueUnfinishedDeepChapterContext: mocks.extractContinueUnfinishedDeepChapterContext,
  stripContinueUnfinishedDeepChapterContext: mocks.stripContinueUnfinishedDeepChapterContext,
}))

vi.mock("@/lib/novel/deep-chapter-generation", () => ({
  runDeepChapterGeneration: mocks.runDeepChapterGeneration,
}))

vi.mock("@/lib/novel/residual-campaign", () => ({
  resolveResidualCampaignFields: mocks.resolveResidualCampaignFields,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: () => mocks.chatState },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ novelConfig: mocks.wikiNovelConfig }) },
}))

const PROJECT: WikiProject = { id: "p1", name: "Book", path: "/p" }

const LLM_CONFIG: LlmConfig = {
  provider: "custom",
  model: "deepseek-v3",
  customEndpoint: "https://api.deepseek.com",
  ollamaUrl: "",
  maxContextSize: 120000,
  apiKey: "key",
  apiMode: "chat_completions",
}

const ASSISTANT_MESSAGE: DisplayMessage = {
  id: "a1",
  role: "assistant",
  content: "<!-- 续写占位 -->",
  timestamp: 1,
  conversationId: "conv-1",
}

interface Harness {
  ctx: ChatContinueUnfinishedContext
  addMessage: ReturnType<typeof vi.fn>
  startStreaming: ReturnType<typeof vi.fn>
  setStreamingContent: ReturnType<typeof vi.fn>
  finalizeStream: ReturnType<typeof vi.fn>
  setActiveConversation: ReturnType<typeof vi.fn>
  setReplayContextPack: ReturnType<typeof vi.fn>
  createConversation: ReturnType<typeof vi.fn>
  abortControllersRef: { current: Record<string, AbortController> }
  activeStreamSessionsRef: { current: Record<string, number> }
  novelManagedStopRef: { current: Record<string, boolean> }
  streamSessionGuardRef: { current: StreamSessionGuard }
}

function makeHarness(overrides: Partial<ChatContinueUnfinishedContext> = {}): Harness {
  const addMessage = vi.fn()
  const startStreaming = vi.fn()
  const setStreamingContent = vi.fn()
  const finalizeStream = vi.fn()
  const setReplayContextPack = vi.fn()
  const createConversation = vi.fn(() => "conv-1")
  const abortControllersRef = { current: {} as Record<string, AbortController> }
  const activeStreamSessionsRef = { current: {} as Record<string, number> }
  const novelManagedStopRef = { current: {} as Record<string, boolean> }
  const streamSessionGuardRef = { current: createStreamSessionGuard() }
  const ctx: ChatContinueUnfinishedContext = {
    assistantMessage: ASSISTANT_MESSAGE,
    isStreaming: false,
    createConversation,
    addMessage,
    startStreaming,
    setStreamingContent,
    finalizeStream,
    project: null,
    setReplayContextPack,
    effectiveChatLlmConfig: LLM_CONFIG,
    streamSessionGuardRef,
    activeStreamSessionsRef,
    abortControllersRef,
    novelManagedStopRef,
    ...overrides,
  }
  return {
    ctx,
    addMessage,
    startStreaming,
    setStreamingContent,
    finalizeStream,
    setActiveConversation: mocks.chatState.setActiveConversation,
    setReplayContextPack,
    createConversation,
    abortControllersRef,
    activeStreamSessionsRef,
    novelManagedStopRef,
    streamSessionGuardRef,
  }
}

function mockDeepSessionState(): void {
  mocks.startDeepChapterSession.mockResolvedValue({
    session_id: "sess-1",
    status: "in_progress",
    active_step_index: 0,
    updated_at: 1000,
  })
  mocks.blockDeepChapterSession.mockResolvedValue({
    status: "blocked",
    active_step_index: 2,
    draft: { draft_status: "pending" },
    updated_at: 1800,
  })
  mocks.pauseDeepChapterSession.mockResolvedValue({
    status: "paused",
    active_step_index: 1,
    draft: { draft_status: "pending" },
    updated_at: 1500,
    current_task: {},
  })
}

/** 让本次续写进入深度分支：项目 + 原始请求 + 恢复 checkpoint 三者齐备。 */
function enableDeepResume(originalRequest: string): void {
  mocks.loadNovelSessionStatus.mockResolvedValue(null)
  mocks.buildInterruptedResumeContextPayload.mockReturnValue(null)
  mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue({
    originalRequest,
    checkpoint: { version: 1, originalRequest, chapterNumber: 2, stage: "after_draft" },
    resumeContext: "已有上下文",
    rootResumeContext: "根上下文",
  })
  mocks.buildContinueUnfinishedDeepChapterPrompt.mockReturnValue("RESUME-PROMPT")
  mocks.stripContinueUnfinishedDeepChapterContext.mockImplementation((content: string) => content)
  mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
  mocks.detectGoldenThreeChapterRequest.mockReturnValue(null)
  mocks.buildGoldenThreeChapterDirective.mockReturnValue("")
  mocks.buildTaskDirective.mockReturnValue("")
  mocks.buildQmQuaiSystemPrompt.mockReturnValue("QM-QUAI")
  mocks.novelSessionStatusPath.mockReturnValue("/p/.novel/status.json")
  mocks.buildStageJournalRuntime.mockReturnValue(null)
  mocks.resolveResidualCampaignFields.mockReturnValue(null)
  mocks.resolveNovelModel.mockReturnValue(LLM_CONFIG)
  mockDeepSessionState()
}

describe("runContinueUnfinished", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [
      { id: "u1", role: "user", content: "原始章节需求", timestamp: 0, conversationId: "conv-1" },
      ASSISTANT_MESSAGE,
    ]
    mocks.chatState.setActiveConversation.mockClear()
    mocks.appendContinueUnfinishedDeepChapterContext.mockImplementation((content: string) => `CTX(${content})`)
  })

  it("流式进行中 → 早退：不 addMessage、不 streamChat、不起会话", async () => {
    const h = makeHarness({ isStreaming: true })

    await runContinueUnfinished(h.ctx)

    expect(h.addMessage).not.toHaveBeenCalled()
    expect(h.startStreaming).not.toHaveBeenCalled()
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(mocks.startDeepChapterSession).not.toHaveBeenCalled()
    expect(h.finalizeStream).not.toHaveBeenCalled()
  })

  it("深度续写 manualReviewRequired → blockDeepChapterSession 且落盘 pending marker", async () => {
    enableDeepResume("原始章节需求")
    mocks.runDeepChapterGeneration.mockResolvedValue({ manualReviewRequired: true, retryCount: 2 })
    const h = makeHarness({ project: PROJECT })

    await runContinueUnfinished(h.ctx)

    expect(h.addMessage).toHaveBeenCalledWith("user", "继续未完成")
    expect(h.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(mocks.startDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p",
        conversationId: "conv-1",
        resumeCheckpoint: expect.objectContaining({ chapterNumber: 2, stage: "after_draft" }),
      }),
    )
    expect(mocks.blockDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", errorMessage: "MANUAL_REVIEW_REQUIRED: retry_count=2" }),
    )
    expect(mocks.pauseDeepChapterSession).not.toHaveBeenCalled()
    expect(h.finalizeStream).toHaveBeenCalledTimes(1)
    expect(decodeURIComponent(h.finalizeStream.mock.calls[0]![0] as string)).toContain('"draftStatus":"pending"')
    expect(h.novelManagedStopRef.current["conv-1"]).toBeUndefined()
    expect(h.activeStreamSessionsRef.current["conv-1"]).toBeUndefined()
    expect(h.abortControllersRef.current["conv-1"]).toBeUndefined()
  })

  it("深度续写 partial → pauseDeepChapterSession 留存待继续正文", async () => {
    enableDeepResume("原始章节需求")
    mocks.runDeepChapterGeneration.mockResolvedValue({ partial: true, manualReviewRequired: false, finalContent: "半章正文" })
    const h = makeHarness({ project: PROJECT })

    await runContinueUnfinished(h.ctx)

    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        errorMessage: "写到一半的正文已留下，可以再次用「继续未完成」接着写。",
      }),
    )
    expect(mocks.blockDeepChapterSession).not.toHaveBeenCalled()
    expect(h.finalizeStream).toHaveBeenCalledTimes(1)
    expect(decodeURIComponent(h.finalizeStream.mock.calls[0]![0] as string)).toContain('"draftStatus":"pending"')
  })

  it("无项目回退：addMessage(user, 继续未完成) → streamChat → finalizeStream 收尾", async () => {
    mocks.buildInterruptedResumeContextPayload.mockReturnValue(null)
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue(null)
    mocks.buildContinueUnfinishedDeepChapterPrompt.mockReturnValue("RESUME-PROMPT")
    mocks.stripContinueUnfinishedDeepChapterContext.mockImplementation((content: string) => content)
    mocks.routeTask.mockReturnValue(null)
    mocks.detectGoldenThreeChapterRequest.mockReturnValue(null)
    mocks.resolveNovelModel.mockReturnValue(LLM_CONFIG)
    mocks.streamChat.mockImplementation(async (_config, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("续写正文")
      callbacks.onDone?.()
    })
    const h = makeHarness({ project: null })

    await runContinueUnfinished(h.ctx)

    expect(h.addMessage).toHaveBeenCalledWith("user", "继续未完成")
    expect(h.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    const [, messages] = mocks.streamChat.mock.calls[0]! as unknown as [unknown, { role: string; content: string }[]]
    expect(messages.map((m) => m.role)).toEqual(["system", "user"])
    expect(messages[1]!.content).toBe("RESUME-PROMPT")
    expect(h.setStreamingContent).toHaveBeenCalled()
    expect(h.finalizeStream).toHaveBeenCalledTimes(1)
    const finalized = decodeURIComponent(h.finalizeStream.mock.calls[0]![0] as string)
    expect(finalized).toContain("续写正文")
    expect(finalized).toContain('"draftStatus":"ready"')
    expect(h.abortControllersRef.current["conv-1"]).toBeUndefined()
  })

  it("catch 路径：流式失败 → finalizeStream 输出「出错：继续未完成失败」并附上一步输出", async () => {
    mocks.buildInterruptedResumeContextPayload.mockReturnValue(null)
    mocks.extractContinueUnfinishedDeepChapterContext.mockReturnValue(null)
    mocks.buildContinueUnfinishedDeepChapterPrompt.mockReturnValue("RESUME-PROMPT")
    mocks.stripContinueUnfinishedDeepChapterContext.mockImplementation((content: string) => content)
    mocks.routeTask.mockReturnValue(null)
    mocks.detectGoldenThreeChapterRequest.mockReturnValue(null)
    mocks.resolveNovelModel.mockReturnValue(LLM_CONFIG)
    mocks.streamChat.mockImplementation(async (_config, _messages, callbacks: { onToken?: (t: string) => void; onError?: (e: Error) => void }) => {
      callbacks.onToken?.("已生成的正文")
      callbacks.onError?.(new Error("模型挂了"))
    })
    const h = makeHarness({ project: null })

    await runContinueUnfinished(h.ctx)

    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(h.finalizeStream).toHaveBeenCalledTimes(1)
    const [content, references] = h.finalizeStream.mock.calls[0]! as unknown as [string, MessageReference[] | undefined]
    expect(content).toContain("已生成的正文")
    expect(content).toContain("出错：继续未完成失败：模型挂了")
    expect(references).toBeUndefined()
    expect(mocks.appendContinueUnfinishedDeepChapterContext).toHaveBeenCalledTimes(1)
    expect(h.abortControllersRef.current["conv-1"]).toBeUndefined()
  })

  it("catch 路径（深度分支，已停止生成）：pauseDeepChapterSession 记录已停止生成", async () => {
    enableDeepResume("原始章节需求")
    mocks.runDeepChapterGeneration.mockRejectedValue(new Error("已停止生成"))
    const h = makeHarness({ project: PROJECT })

    await runContinueUnfinished(h.ctx)

    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", errorMessage: "已停止生成" }),
    )
    expect(h.finalizeStream).toHaveBeenCalledTimes(1)
    expect(h.finalizeStream.mock.calls[0]![0] as string).toContain("出错：继续未完成失败：已停止生成")
  })
})
