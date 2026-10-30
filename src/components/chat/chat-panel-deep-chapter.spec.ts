/**
 * runDeepChapterSend — 深度章节生成分支直接契约（chat-panel 拆分 T5）。
 * mock novel 模块与深度流式渲染，覆盖：成功、checkpoint 失败、pause/abort、review-required。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { runDeepChapterSend, type ChatDeepChapterContext } from "./chat-panel-deep-chapter"

const mocks = vi.hoisted(() => ({
  loadNovelSessionStatus: vi.fn(),
  resolveInterruptedSessionResumeCheckpoint: vi.fn(),
  startDeepChapterSession: vi.fn(),
  persistDeepChapterCheckpoint: vi.fn(),
  blockDeepChapterSession: vi.fn(),
  pauseDeepChapterSession: vi.fn(),
  completeDeepChapterSession: vi.fn(),
  runDeepChapterGeneration: vi.fn(),
  buildStageJournalRuntime: vi.fn(),
  novelSessionStatusPath: vi.fn((pp: string) => `${pp}/.novel/status.json`),
  createNovelSessionId: vi.fn(() => "mock-sess-id"),
}))

vi.mock("@/lib/novel", () => ({
  loadNovelSessionStatus: mocks.loadNovelSessionStatus,
  resolveInterruptedSessionResumeCheckpoint: mocks.resolveInterruptedSessionResumeCheckpoint,
  startDeepChapterSession: mocks.startDeepChapterSession,
  persistDeepChapterCheckpoint: mocks.persistDeepChapterCheckpoint,
  blockDeepChapterSession: mocks.blockDeepChapterSession,
  pauseDeepChapterSession: mocks.pauseDeepChapterSession,
  completeDeepChapterSession: mocks.completeDeepChapterSession,
  buildStageJournalRuntime: mocks.buildStageJournalRuntime,
  novelSessionStatusPath: mocks.novelSessionStatusPath,
  createNovelSessionId: mocks.createNovelSessionId,
}))

vi.mock("@/lib/novel/deep-chapter-generation", () => ({
  runDeepChapterGeneration: mocks.runDeepChapterGeneration,
}))

vi.mock("@/lib/novel/residual-campaign", () => ({
  resolveResidualCampaignFields: vi.fn(() => null),
}))

const LLM_CONFIG: LlmConfig = {
  provider: "custom",
  model: "deepseek-v3",
  customEndpoint: "https://api.deepseek.com",
  ollamaUrl: "",
  maxContextSize: 120000,
  apiKey: "key",
  apiMode: "chat_completions",
}

const NOVEL_CONFIG = {
  consensusEnabled: false,
  consensusWritingModels: [],
  stageJournalEnabled: false,
  journalTtlMs: 3600_000,
  genre: "都市",
  chapterTargetChars: 3000,
} as unknown as NovelConfig

function makeCtx(overrides: Partial<ChatDeepChapterContext> = {}): {
  ctx: ChatDeepChapterContext
  finalizeStream: ReturnType<typeof vi.fn>
  setStreamingContent: ReturnType<typeof vi.fn>
  setPlanningPlan: ReturnType<typeof vi.fn>
  abortControllersRef: { current: Record<string, AbortController> }
  activeStreamSessionsRef: { current: Record<string, number> }
  novelManagedStopRef: { current: Record<string, boolean> }
} {
  const finalizeStream = vi.fn()
  const setStreamingContent = vi.fn()
  const setPlanningPlan = vi.fn()
  const abortControllersRef = { current: {} as Record<string, AbortController> }
  const activeStreamSessionsRef = { current: { "conv-deep": 9 } as Record<string, number> }
  const novelManagedStopRef = { current: {} as Record<string, boolean> }
  const ctx: ChatDeepChapterContext = {
    text: "写第5章",
    capturedConvId: "conv-deep",
    sessionId: 9,
    pp: "D:/novel",
    effectiveTaskRoute: { chapterNumber: 5, intent: "write_chapter" },
    effectiveChatLlmConfig: LLM_CONFIG,
    goldenThreeChapter: undefined,
    dismantlingDirective: "",
    novelConfig: NOVEL_CONFIG,
    planningPlan: { chapterNumber: 5, scenes: [] } as never,
    setPlanningPlan,
    setStreamingContent,
    finalizeStream,
    abortControllersRef,
    activeStreamSessionsRef,
    streamSessionGuardRef: {
      current: {
        start: vi.fn(),
        isActive: () => true,
        runIfActive: (_c, _s, cb) => cb(),
        finish: (_c, _s, cb) => cb(),
        stop: (_c, _s, cb) => cb(),
      },
    },
    novelManagedStopRef,
    ...overrides,
  }
  return { ctx, finalizeStream, setStreamingContent, setPlanningPlan, abortControllersRef, activeStreamSessionsRef, novelManagedStopRef }
}

describe("runDeepChapterSend", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadNovelSessionStatus.mockRejectedValue(new Error("no status"))
    mocks.startDeepChapterSession.mockResolvedValue({
      session_id: "sess-1",
      status: "in_progress",
      active_step_index: 0,
      updated_at: 1000,
    })
    mocks.completeDeepChapterSession.mockResolvedValue({
      status: "completed",
      active_step_index: 3,
      draft: { draft_status: "ready" },
      updated_at: 2000,
    })
    mocks.pauseDeepChapterSession.mockResolvedValue({
      status: "paused",
      active_step_index: 1,
      draft: { draft_status: "pending" },
      updated_at: 1500,
      current_task: {},
    })
    mocks.blockDeepChapterSession.mockResolvedValue({
      status: "blocked",
      active_step_index: 2,
      draft: { draft_status: "pending" },
      updated_at: 1800,
    })
    mocks.buildStageJournalRuntime.mockReturnValue(null)
  })

  it("正常完成路径：调用 start → runGeneration → complete，清除 planningPlan 并 finalizeStream", async () => {
    mocks.runDeepChapterGeneration.mockImplementation(async (_params, handlers) => {
      handlers.onFinalContent("第5章完整正文")
      return {
        finalContent: "第5章完整正文",
        reviewResults: [],
        manualReviewRequired: false,
        partial: false,
      }
    })

    const { ctx, finalizeStream, setPlanningPlan, novelManagedStopRef, activeStreamSessionsRef } = makeCtx()
    await runDeepChapterSend(ctx)

    expect(mocks.startDeepChapterSession).toHaveBeenCalledTimes(1)
    expect(mocks.completeDeepChapterSession).toHaveBeenCalledTimes(1)
    expect(setPlanningPlan).toHaveBeenCalledWith(null)
    expect(finalizeStream).toHaveBeenCalledTimes(1)
    const [finalized] = finalizeStream.mock.calls[0]
    expect(finalized).toContain("第5章完整正文")
    expect(novelManagedStopRef.current["conv-deep"]).toBeUndefined()
    expect(activeStreamSessionsRef.current["conv-deep"]).toBeUndefined()
  })

  it("人工审查分支（manualReviewRequired）：调用 blockDeepChapterSession，draftStatus 为 pending", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValue({
      manualReviewRequired: true,
      retryCount: 3,
    })
    const { ctx, finalizeStream } = makeCtx()
    await runDeepChapterSend(ctx)

    expect(mocks.blockDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        errorMessage: "MANUAL_REVIEW_REQUIRED: retry_count=3",
      }),
    )
    expect(finalizeStream).toHaveBeenCalledTimes(1)
  })

  it("部分内容中断分支（partial）：调用 pauseDeepChapterSession，留存待继续正文", async () => {
    mocks.runDeepChapterGeneration.mockResolvedValue({
      partial: true,
      manualReviewRequired: false,
    })
    const { ctx, finalizeStream } = makeCtx()
    await runDeepChapterSend(ctx)

    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        errorMessage: "写到一半的正文已留下，可以用「继续未完成」接着写。",
      }),
    )
    expect(finalizeStream).toHaveBeenCalledTimes(1)
  })

  it("用户中止（已停止生成）：落盘 paused 状态并输出已停止生成", async () => {
    mocks.runDeepChapterGeneration.mockRejectedValue(new Error("已停止生成"))
    const { ctx, finalizeStream, novelManagedStopRef } = makeCtx()
    await runDeepChapterSend(ctx)

    expect(mocks.pauseDeepChapterSession).toHaveBeenCalledTimes(1)
    expect(finalizeStream).toHaveBeenCalledTimes(1)
    const [msg] = finalizeStream.mock.calls[0]
    expect(msg).toContain("已停止生成")
    expect(novelManagedStopRef.current["conv-deep"]).toBeUndefined()
  })

  it("checkpoint 失败：抛出 CHECKPOINT_PERSIST_FAILED 并在 catch 中包含提示", async () => {
    mocks.persistDeepChapterCheckpoint.mockRejectedValue(new Error("disk full"))
    mocks.runDeepChapterGeneration.mockImplementation(async (_params, handlers) => {
      await handlers.onCheckpoint({ stage: "draft", progress: 0.5 })
    })

    const { ctx, finalizeStream } = makeCtx()
    await runDeepChapterSend(ctx)

    expect(finalizeStream).toHaveBeenCalledTimes(1)
    const [msg] = finalizeStream.mock.calls[0]
    expect(msg).toContain("CHECKPOINT_PERSIST_FAILED")
    expect(msg).toContain("进度点没能保存：disk full")
  })
})
