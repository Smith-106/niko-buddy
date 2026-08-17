import { beforeEach, describe, expect, it, vi } from "vitest"

const streamChatMock = vi.fn()
vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
}))

const resolveNovelModelMock = vi.fn()
vi.mock("./model-resolver", () => ({
  resolveNovelModel: (...args: unknown[]) => resolveNovelModelMock(...args),
}))

import { testNovelModel } from "./novel-model-test"
import type { NovelConfig } from "@/stores/wiki-store"

const llmConfig = { apiKey: "k", model: "m", baseUrl: "http://x" } as never

function novelConfig(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return {
    reviewModel: "review-m",
    summaryModel: "summary-m",
    extractModel: "extract-m",
    ...overrides,
  } as NovelConfig
}

describe("novel-model-test testNovelModel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveNovelModelMock.mockImplementation(
      (_cfg: unknown, _novel: unknown, task: string) => ({
        ...llmConfig,
        model: `${task}-resolved`,
      }),
    )
  })

  function streamWith(tokens: string[]) {
    streamChatMock.mockImplementationOnce(async (
      _cfg: unknown,
      _msgs: unknown,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      for (const t of tokens) callbacks.onToken(t)
      callbacks.onDone()
    })
  }

  it("returns content and model for a successful stream", async () => {
    streamWith(["写作模型测试成功"])
    const result = await testNovelModel(llmConfig, novelConfig(), "writing")
    expect(result.content).toBe("写作模型测试成功")
    expect(result.model).toBe("writing-resolved")
    expect(result.usedFallbackModel).toBe(true) // writing always fallback
    expect(streamChatMock.mock.calls[0][3]).toBeInstanceOf(AbortSignal)
  })

  it("throws when resolved model is blank", async () => {
    resolveNovelModelMock.mockReturnValue({ ...llmConfig, model: "   " })
    await expect(
      testNovelModel(llmConfig, novelConfig(), "writing"),
    ).rejects.toThrow("请先配置主模型")
  })

  it("throws when stream reports error", async () => {
    streamChatMock.mockImplementationOnce(async (
      _cfg: unknown,
      _msgs: unknown,
      callbacks: { onError: (e: Error) => void },
    ) => {
      callbacks.onError(new Error("connection refused"))
    })
    await expect(
      testNovelModel(llmConfig, novelConfig(), "review"),
    ).rejects.toThrow("connection refused")
  })

  it("throws when stream yields no content", async () => {
    streamWith(["   "])
    await expect(
      testNovelModel(llmConfig, novelConfig(), "review"),
    ).rejects.toThrow("没有返回可用内容")
  })

  it("usedFallbackModel true for review when novel reviewModel blank", async () => {
    streamWith(["审稿模型测试成功"])
    const result = await testNovelModel(llmConfig, novelConfig({ reviewModel: "" }), "review")
    expect(result.usedFallbackModel).toBe(true)
  })

  it("usedFallbackModel false for review when novel reviewModel configured", async () => {
    streamWith(["审稿模型测试成功"])
    const result = await testNovelModel(llmConfig, novelConfig({ reviewModel: "r1" }), "review")
    expect(result.usedFallbackModel).toBe(false)
  })

  it("works for summary and extract tasks with their prompts", async () => {
    streamWith(["ok"])
    const summary = await testNovelModel(llmConfig, novelConfig({ summaryModel: "" }), "summary")
    expect(summary.usedFallbackModel).toBe(true)
    expect(streamChatMock.mock.calls[0][1][0].content).toContain("摘要模型测试")

    streamWith(["ok"])
    const extract = await testNovelModel(
      llmConfig,
      novelConfig({ extractModel: "ex" }),
      "extract",
    )
    expect(extract.usedFallbackModel).toBe(false)
    expect(streamChatMock.mock.calls[1][1][0].content).toContain("提取模型测试")
  })
})
