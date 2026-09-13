import { beforeEach, describe, expect, it, vi } from "vitest"

const { reviewChapterDimensionMock, streamChatMock, buildPromptMock } = vi.hoisted(() => ({
  reviewChapterDimensionMock: vi.fn(),
  streamChatMock: vi.fn(),
  buildPromptMock: vi.fn(),
}))

// reviewChapterDimension/buildDimensionReviewPrompt mock；parseDimensionReviewResult 保持真实实现
vi.mock("./dimension-review-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dimension-review-adapter")>()
  return {
    ...actual,
    reviewChapterDimension: reviewChapterDimensionMock,
    buildDimensionReviewPrompt: buildPromptMock.mockReturnValue("BASE-PROMPT"),
  }
})
vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
  combineAbortSignals: (...signals: (AbortSignal | undefined)[]) => {
    const list = signals.filter((s): s is AbortSignal => Boolean(s))
    if (list.length === 0) return undefined
    const controller = new AbortController()
    for (const s of list) s.addEventListener("abort", () => controller.abort(), { once: true })
    return controller.signal
  },
}))

import { runDimensionConsensus } from "./consensus-review"
import { SIX_REVIEW_DIMENSIONS } from "./dimension-review-adapter"
import type { LlmConfig } from "@/stores/wiki-store"

function cfg(model: string): LlmConfig {
  return {
    provider: "claude-code",
    apiKey: "",
    model,
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 100000,
  } as LlmConfig
}

const dimension = SIX_REVIEW_DIMENSIONS.thrill

function chapterJson(score: number, summary: string): string {
  return JSON.stringify({ score, status: "pass", summary, issues: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  reviewChapterDimensionMock.mockImplementation(async ({ llmConfig }) => {
    const score = Number(llmConfig.model.replace(/[^\d.]/g, "")) || 5
    return {
      dimensionKey: "thrill",
      score,
      status: "pass",
      summary: `initial-${llmConfig.model}`,
      thinking: "",
      issues: [],
    }
  })
})

describe("runDimensionConsensus", () => {
  it("runs N parallel first-round reviews then debate per seat", async () => {
    // streamChat 真实契约：经 callbacks.onToken 流式输出（debateCall 靠 onToken 累积）
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken?.(chapterJson(7.5, "debated"))
    })
    const out = await runDimensionConsensus({
      models: [cfg("m6"), cfg("m8"), cfg("m9")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
    })
    expect(reviewChapterDimensionMock).toHaveBeenCalledTimes(3)
    // 每席位一次辩论调用 = 3 次 streamChat
    expect(streamChatMock).toHaveBeenCalledTimes(3)
    // 辩论后全部 7.5 → 中位 7.5，无分歧
    expect(out.result.score).toBe(7.5)
    expect(out.result.summary).toContain("debated")
    expect(out.disputed).toBe(false)
  })

  it("single model degrades to pass-through with no debate calls", async () => {
    const out = await runDimensionConsensus({
      models: [cfg("m8.5")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 2,
    })
    expect(reviewChapterDimensionMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(out.result.score).toBe(8.5)
  })

  it("debate parse failure keeps the seat's previous ballot", async () => {
    reviewChapterDimensionMock.mockImplementation(async ({ llmConfig }) => ({
      dimensionKey: "thrill",
      score: llmConfig.model === "mA" ? 6 : 9,
      status: "pass",
      summary: `init-${llmConfig.model}`,
      thinking: "",
      issues: [],
    }))
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken?.("这不是 JSON") // 辩论轮全部解析失败
    })
    const out = await runDimensionConsensus({
      models: [cfg("mA"), cfg("mB")],
      dimension,
      contextPack: {} as never,
      chapterContent: "章",
      debateRounds: 1,
    })
    // 席位沿用第一轮票 [6,9]
    expect(out.result.score).toBe(7.5)
    expect(out.disputed).toBe(true)
  })

  it("throws when no model is usable", async () => {
    await expect(
      runDimensionConsensus({
        models: [],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 1,
      }),
    ).rejects.toThrow("共识模型均不可用")
    expect(reviewChapterDimensionMock).not.toHaveBeenCalled()
  })

  it("propagates first-round review failure (dimension fails as a whole)", async () => {
    reviewChapterDimensionMock.mockRejectedValueOnce(new Error("stream down"))
    await expect(
      runDimensionConsensus({
        models: [cfg("m1"), cfg("m2")],
        dimension,
        contextPack: {} as never,
        chapterContent: "章",
        debateRounds: 1,
      }),
    ).rejects.toThrow("stream down")
  })
})
