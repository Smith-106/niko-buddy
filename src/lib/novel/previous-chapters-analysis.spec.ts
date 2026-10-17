import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const fsMocks = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: (...args: unknown[]) => fsMocks.readFile(...args),
    
  }
})

const streamChatMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: (...args: unknown[]) => streamChatMock(...args),
      // mirror real combineAbortSignals: 任一 abort 即合并 abort
      combineAbortSignals: (signal?: AbortSignal, timeoutSignal?: AbortSignal): AbortSignal | undefined => {
        const signals = [signal, timeoutSignal].filter(Boolean) as AbortSignal[]
        if (signals.length === 0) return undefined
        if (signals.length === 1) return signals[0]
        const controller = new AbortController()
        for (const s of signals) {
          if (s.aborted) { controller.abort(); break }
          s.addEventListener("abort", () => controller.abort(), { once: true })
        }
        return controller.signal
      },
      DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
    
  }
})

const loggerErrorMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
      logger: { error: (...args: unknown[]) => loggerErrorMock(...args) },
    
  }
})

const llmConfig = { provider: "custom", apiKey: "x", model: "mock" } as LlmConfig

const chapterBody = (n: number): string =>
  `---\ntitle: 第${n}章\n---\n\n这是第${n}章的正文内容，包含剧情推进。`

describe("analyzePreviousChapters", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    streamChatMock.mockReset()
    loggerErrorMock.mockReset()
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const n = Number(String(path).match(/chapter-(\d+)\.md$/)?.[1])
      if (!n) throw new Error("ENOENT")
      return chapterBody(n)
    })
  })

  it("returns empty string when currentChapterNumber <= 1", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    expect(await analyzePreviousChapters("/p", 1, llmConfig)).toBe("")
    expect(await analyzePreviousChapters("/p", 0, llmConfig)).toBe("")
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("reads previous chapters, strips the yaml frontmatter, and streams the analysis", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      const prompt = messages[0].content as string
      // 分析提示包含前情章节正文（frontmatter 已被剥离）
      expect(prompt).toContain("第2章")
      expect(prompt).toContain("这是第2章的正文内容")
      expect(prompt).not.toContain("title: 第2章")
      callbacks.onToken?.("  分析结果文本  ")
      callbacks.onDone?.()
    })
    const result = await analyzePreviousChapters("/p", 3, llmConfig)
    expect(result).toBe("分析结果文本")
  })

  it("clamps startChapter to 1 and uses analysisCount window", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      callbacks.onToken?.("OK")
      callbacks.onDone?.()
    })
    await analyzePreviousChapters("/p", 4, llmConfig, 10)
    const paths = fsMocks.readFile.mock.calls.map(([p]) => p)
    expect(paths).toEqual([
      "/p/wiki/chapters/chapter-001.md",
      "/p/wiki/chapters/chapter-002.md",
      "/p/wiki/chapters/chapter-003.md",
    ])
  })

  it("uses the full content when the body separator is missing", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    fsMocks.readFile.mockResolvedValue("纯文本无分隔符")
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      expect((messages[0].content as string)).toContain("纯文本无分隔符")
      callbacks.onToken?.("R")
      callbacks.onDone?.()
    })
    const result = await analyzePreviousChapters("/p", 2, llmConfig)
    expect(result).toBe("R")
  })

  it("skips chapters with no search results or read failures", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await analyzePreviousChapters("/p", 3, llmConfig)).toBe("")

    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("chapter-001.md")) return chapterBody(1)
      throw new Error("ENOENT")
    })
    streamChatMock.mockImplementation(async (_cfg, messages, callbacks: { onToken?: (t: string) => void; onDone?: () => void }) => {
      expect((messages[0].content as string)).toContain("第1章")
      callbacks.onToken?.("部分成功")
      callbacks.onDone?.()
    })
    const result = await analyzePreviousChapters("/p", 3, llmConfig)
    expect(result).toBe("部分成功")
  })

  it("logs stream errors and returns whatever accumulated", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onError?: (e: Error) => void }) => {
      callbacks.onToken?.("部分内容")
      callbacks.onError?.(new Error("LLM down"))
    })
    const result = await analyzePreviousChapters("/p", 3, llmConfig)
    expect(result).toBe("部分内容")
    expect(loggerErrorMock).toHaveBeenCalledWith("Previous Chapters", "LLM error", expect.objectContaining({ error: "LLM down" }))

    // 非 Error 抛值 → String(err) 分支
    streamChatMock.mockImplementation(async (_cfg, _messages, callbacks: { onToken?: (t: string) => void; onError?: (e: Error) => void }) => {
      callbacks.onError?.("string-error" as unknown as Error)
    })
    await analyzePreviousChapters("/p", 3, llmConfig)
    expect(loggerErrorMock).toHaveBeenCalledWith("Previous Chapters", "LLM error", expect.objectContaining({ error: "string-error" }))
  })

  it("passes a combined abort signal to streamChat", async () => {
    const { analyzePreviousChapters } = await import("./previous-chapters-analysis")
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    streamChatMock.mockImplementation(async (_cfg, _messages, _callbacks, signal?: AbortSignal) => {
      receivedSignal = signal
    })
    await analyzePreviousChapters("/p", 3, llmConfig, 3, controller.signal)
    expect(receivedSignal).toBeDefined()
  })
})
