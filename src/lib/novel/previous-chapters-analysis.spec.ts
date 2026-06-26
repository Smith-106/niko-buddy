import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  searchWikiMock: vi.fn(),
  readFileMock: vi.fn(),
  streamChatMock: vi.fn(),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: mocks.searchWikiMock,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFileMock,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChatMock,
}))

import { analyzePreviousChapters } from "./previous-chapters-analysis"

const llmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" },
} satisfies LlmConfig

describe("analyzePreviousChapters", () => {
  beforeEach(() => {
    mocks.searchWikiMock.mockReset()
    mocks.readFileMock.mockReset()
    mocks.streamChatMock.mockReset()
  })

  it("throws when the analysis stream reports an error", async () => {
    mocks.searchWikiMock.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/第2章.md" }])
    mocks.readFileMock.mockResolvedValue("---\ntitle: 第2章\n---\n正文内容")
    mocks.streamChatMock.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("API Error: Connection closed mid-response.")
      callbacks.onError(new Error("Connection lost during streaming. Try again."))
    })

    await expect(
      analyzePreviousChapters("E:/Novel", 3, llmConfig, 1),
    ).rejects.toThrow("Connection lost during streaming. Try again.")
  })

  it("returns the accumulated analysis when streaming succeeds", async () => {
    mocks.searchWikiMock.mockResolvedValue([{ path: "E:/Novel/wiki/chapters/第2章.md" }])
    mocks.readFileMock.mockResolvedValue("---\ntitle: 第2章\n---\n正文内容")
    mocks.streamChatMock.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("逐章摘要")
      callbacks.onToken("与关键衔接")
      callbacks.onDone()
    })

    await expect(
      analyzePreviousChapters("E:/Novel", 3, llmConfig, 1),
    ).resolves.toBe("逐章摘要与关键衔接")
  })
})
