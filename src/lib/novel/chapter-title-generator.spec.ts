import { describe, expect, it, vi, beforeEach } from "vitest"

const streamChatMock = vi.fn()
const combineAbortSignalsMock = vi.fn((...signals: AbortSignal[]) => signals[0])
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: (...args: Parameters<typeof streamChatMock>) => streamChatMock(...args),
      combineAbortSignals: (...args: Parameters<typeof combineAbortSignalsMock>) => combineAbortSignalsMock(...args),
      DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
    
  }
})

import { generateChapterTitle, ensureChapterTitle } from "./chapter-title-generator"

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

describe("chapter-title-generator ensureChapterTitle（RV-001 无标题路径）", () => {
  const llmConfig = { apiKey: "k", model: "m", baseUrl: "http://x" } as never

  it("开关为假时零 LLM 调用，正文原样返回", async () => {
    const generateTitle = vi.fn()
    const out = await ensureChapterTitle("正文内容", {
      chapterNumber: 7,
      llmConfig,
      autoGenerateChapterTitle: false,
      generateTitle,
    })
    expect(generateTitle).not.toHaveBeenCalled()
    expect(out).toEqual({ content: "正文内容", title: "", source: "disabled" })
  })

  it("没有章号时不猜章号，也不调用模型", async () => {
    const generateTitle = vi.fn()
    const out = await ensureChapterTitle("正文内容", {
      llmConfig,
      autoGenerateChapterTitle: true,
      generateTitle,
    })
    expect(generateTitle).not.toHaveBeenCalled()
    expect(out.source).toBe("disabled")
  })

  it("正文已带富标题时不再多跑一次模型", async () => {
    const generateTitle = vi.fn()
    const content = "# 第7章 夜雨\n\n正文内容"
    const out = await ensureChapterTitle(content, {
      chapterNumber: 7,
      llmConfig,
      autoGenerateChapterTitle: true,
      generateTitle,
    })
    expect(generateTitle).not.toHaveBeenCalled()
    expect(out).toEqual({ content, title: "第7章 夜雨", source: "content" })
  })

  it("无标题时调用 generateChapterTitle 并补 H1", async () => {
    const generateTitle = vi.fn(async () => "第7章 夜雨")
    const out = await ensureChapterTitle("正文内容", {
      chapterNumber: 7,
      llmConfig,
      autoGenerateChapterTitle: true,
      generateTitle,
    })
    expect(generateTitle).toHaveBeenCalledOnce()
    expect(out.source).toBe("generated")
    expect(out.title).toBe("第7章 夜雨")
    expect(out.content).toBe("# 第7章 夜雨\n\n正文内容")
  })

  it("裸 H1 先摘掉再补，不出现两个标题行", async () => {
    const generateTitle = vi.fn(async () => "第7章 夜雨")
    const out = await ensureChapterTitle("# 第7章\n\n正文内容", {
      chapterNumber: 7,
      llmConfig,
      autoGenerateChapterTitle: true,
      generateTitle,
    })
    expect(out.content).toBe("# 第7章 夜雨\n\n正文内容")
    expect(out.content.match(/^# /gm)).toHaveLength(1)
  })

  it("生成失败降级「第N章」且绝不丢正文（不抛）", async () => {
    const generateTitle = vi.fn(async () => {
      throw new Error("upstream 500")
    })
    const out = await ensureChapterTitle("正文内容", {
      chapterNumber: 7,
      llmConfig,
      autoGenerateChapterTitle: true,
      generateTitle,
    })
    expect(out.source).toBe("fallback")
    expect(out.title).toBe("第7章")
    expect(out.content).toBe("# 第7章\n\n正文内容")
    expect(out.error).toContain("upstream 500")
  })

  it("模型返回空串也走降级，不留下空标题行", async () => {
    const generateTitle = vi.fn(async () => "   ")
    const out = await ensureChapterTitle("正文内容", {
      chapterNumber: 3,
      llmConfig,
      autoGenerateChapterTitle: true,
      generateTitle,
    })
    expect(out.source).toBe("fallback")
    expect(out.content).toBe("# 第3章\n\n正文内容")
  })
})
