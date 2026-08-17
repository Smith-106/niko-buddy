import { describe, expect, it, vi, beforeEach } from "vitest"

const streamChatMock = vi.fn()
const combineAbortSignalsMock = vi.fn((...signals: AbortSignal[]) => signals[0])
vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
  combineAbortSignals: (...args: unknown[]) => combineAbortSignalsMock(...args),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

import { generateChapterTitle } from "./chapter-title-generator"

function runStream(chunks: string[]) {
  streamChatMock.mockImplementationOnce(async (_cfg: unknown, _msgs: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void }) => {
    for (const chunk of chunks) callbacks.onToken(chunk)
    callbacks.onDone()
  })
}

describe("chapter-title-generator generateChapterTitle", () => {
  beforeEach(() => {
    streamChatMock.mockReset()
    combineAbortSignalsMock.mockClear()
  })

  const llmConfig = { apiKey: "k", model: "m", baseUrl: "http://x" } as never

  it("returns prefixed title for plain output", async () => {
    runStream(["夜雨"])
    const title = await generateChapterTitle("正文内容", 7, llmConfig)
    expect(title).toBe("第7章 夜雨")
  })

  it("strips quotes, brackets and 第X章 prefix", async () => {
    runStream(['「"《第7章：夜雨"》」'])
    const title = await generateChapterTitle("正文", 7, llmConfig)
    expect(title).toBe("第7章 夜雨")
  })

  it("strips 标题: prefix", async () => {
    runStream(["标题：夜雨"])
    const title = await generateChapterTitle("正文", 7, llmConfig)
    expect(title).toBe("第7章 夜雨")
  })

  it("falls back to 第X章 when model returns empty", async () => {
    runStream(["   "])
    const title = await generateChapterTitle("正文", 3, llmConfig)
    expect(title).toBe("第3章")
  })

  it("truncates content longer than 3000 chars", async () => {
    runStream(["夜雨"])
    const longContent = "x".repeat(5000)
    await generateChapterTitle(longContent, 1, llmConfig)
    const call = streamChatMock.mock.calls[0]
    const userMessage = call[1][0]
    expect(userMessage.content.length).toBeLessThan(3500)
    expect(userMessage.content).toContain("...")
  })

  it("passes full short content without truncation", async () => {
    runStream(["夜雨"])
    await generateChapterTitle("短正文", 1, llmConfig)
    const call = streamChatMock.mock.calls[0]
    expect(call[1][0].content).toContain("短正文")
  })

  it("throws when stream reports an error", async () => {
    streamChatMock.mockImplementationOnce(async (_cfg: unknown, _msgs: unknown, callbacks: { onError: (e: Error) => void }) => {
      callbacks.onError(new Error("stream failed"))
    })
    await expect(generateChapterTitle("正文", 1, llmConfig)).rejects.toThrow(
      "stream failed",
    )
  })

  it("uses temperature 0.7 and max_tokens 100 options", async () => {
    runStream(["夜雨"])
    await generateChapterTitle("正文", 1, llmConfig)
    const call = streamChatMock.mock.calls[0]
    expect(call[4]).toEqual({ temperature: 0.7, max_tokens: 100 })
  })

  it("passes caller signal to combineAbortSignals", async () => {
    runStream(["夜雨"])
    const controller = new AbortController()
    await generateChapterTitle("正文", 1, llmConfig, controller.signal)
    expect(combineAbortSignalsMock).toHaveBeenCalledWith(
      controller.signal,
      expect.any(AbortSignal),
    )
  })
})
