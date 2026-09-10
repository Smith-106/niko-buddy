import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  combineAbortSignals: vi.fn((...signals: AbortSignal[]) => signals[0] as AbortSignal),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30000,
  t: vi.fn((_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k),
  getOutputLanguage: vi.fn(() => "zh-CN"),
  buildLanguageReminder: vi.fn((lang: string) => `[LANG:${lang}]`),
  validateSeverity: vi.fn((s: unknown) => (["error", "warning", "info"].includes(s as string) ? (s as "error") : "info")),
  loggerError: vi.fn(),
  contextPackToPrompt: vi.fn((pack: unknown) => `CP:${JSON.stringify(pack)}`),
  buildContextPack: vi.fn(),
  resolveNovelModel: vi.fn(),
  hasUsableLlm: vi.fn(),
  sliceChapterForReview: vi.fn((c: string) => `SLICED:${c}`),
  useWikiStore: {
    getState: vi.fn(() => ({
      llmConfig: { apiKey: "k" },
      novelConfig: {},
      novelMode: true,
    })),
  },
}))

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
      streamChat: mocks.streamChat,
      combineAbortSignals: mocks.combineAbortSignals,
      DEFAULT_LLM_REQUEST_TIMEOUT_MS: mocks.DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    
  }
})
vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>()
  return {
    ...actual,
      default: { t: mocks.t },
    
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
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
      validateSeverity: mocks.validateSeverity,
      logger: { error: mocks.loggerError },
    
  }
})
vi.mock("./context-engine", () => ({
  contextPackToPrompt: mocks.contextPackToPrompt,
  buildContextPack: mocks.buildContextPack,
}))
vi.mock("./model-resolver", () => ({
  resolveNovelModel: mocks.resolveNovelModel,
}))
vi.mock("@/lib/has-usable-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/has-usable-llm")>()
  return {
    ...actual,
      hasUsableLlm: mocks.hasUsableLlm,
    
  }
})
vi.mock("./chapter-window", () => ({
  sliceChapterForReview: mocks.sliceChapterForReview,
}))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: mocks.useWikiStore,
    
  }
})

import { buildBookRulesLintFragment, buildNovelLintPrompt, runNovelLint } from "./lint"
import { EMPTY_BOOK_RULES } from "./book-rules"

const baseLlmConfig = { apiKey: "k", model: "m", baseUrl: "http://x" } as never

function pack() {
  return { sections: [{ title: "t", content: "c" }] } as never
}

describe("lint", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.streamChat.mockResolvedValue(undefined)
    mocks.buildContextPack.mockResolvedValue(pack())
    mocks.resolveNovelModel.mockImplementation((cfg: unknown) => cfg)
    mocks.hasUsableLlm.mockReturnValue(true)
    mocks.useWikiStore.getState.mockReturnValue({
      llmConfig: baseLlmConfig,
      novelConfig: {},
      novelMode: true,
    })
  })

  describe("buildNovelLintPrompt", () => {
    it("composes context, dimensions and sliced content", () => {
      const prompt = buildNovelLintPrompt(pack(), "章节正文")
      expect(prompt).toContain("CP:")
      expect(prompt).toContain("1. 是否违背总大纲")
      expect(prompt).toContain("SLICED:章节正文")
      expect(prompt).toContain("severity")
    })
  })

  describe("buildBookRulesLintFragment (64 号实施接线：book-rules 机械预检)", () => {
    it("无规则 → 空串", () => {
      expect(buildBookRulesLintFragment(undefined, "正文")).toBe("")
    })

    it("全通过 → 空串", () => {
      expect(buildBookRulesLintFragment(EMPTY_BOOK_RULES, "正文内容")).toBe("")
    })

    it("命中禁止项 → 渲染 error 行", () => {
      const rules: typeof EMPTY_BOOK_RULES = {
        ...EMPTY_BOOK_RULES,
        prohibitions: ["金手指"],
      }
      const fragment = buildBookRulesLintFragment(rules, "主角获得金手指后一路碾压。")
      expect(fragment).toContain("书规则机械预检")
      expect(fragment).toContain("[error]")
      expect(fragment).toContain("金手指")
    })
  })

  describe("runNovelLint", () => {
    it("returns [] when LLM unusable", async () => {
      mocks.hasUsableLlm.mockReturnValue(false)
      const result = await runNovelLint("C:/novel", "正文")
      expect(result).toEqual([])
      expect(mocks.streamChat).not.toHaveBeenCalled()
    })

    it("returns [] when not in novel mode", async () => {
      mocks.useWikiStore.getState.mockReturnValue({
        llmConfig: baseLlmConfig,
        novelConfig: {},
        novelMode: false,
      })
      const result = await runNovelLint("C:/novel", "正文")
      expect(result).toEqual([])
    })

    it("uses options llmConfig/novelConfig/novelMode when provided", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken('[{"severity":"error","type":"x","message":"m","evidence":"e","relatedMemory":"r","suggestion":"s"}]')
      })
      const result = await runNovelLint("C:/novel", "正文", 3, {
        llmConfig: baseLlmConfig,
        novelConfig: {} as never,
        novelMode: true,
      })
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        severity: "error",
        type: "x",
        message: "m",
        evidence: "e",
        relatedMemory: "r",
        suggestion: "s",
      })
      expect(mocks.resolveNovelModel).toHaveBeenCalled()
      expect(mocks.buildContextPack).toHaveBeenCalledWith("C:/novel", "连贯性检查第3章", 3)
    })

    it("normalizes parsed items with defaults", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken('[{"severity":"bogus","message":"仅消息"},{"severity":"info"}]')
      })
      mocks.validateSeverity.mockReturnValue("info")
      const result = await runNovelLint("C:/novel", "正文")
      expect(result[0]).toEqual({
        severity: "info",
        type: "unknown",
        message: "仅消息",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      })
      expect(result[1].message).toBe("")
      expect(result[1].type).toBe("unknown")
    })

    it("invokes onDone when the stream completes", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void; onDone: () => void },
      ) => {
        callbacks.onToken("[]")
        callbacks.onDone()
      })
      expect(await runNovelLint("C:/novel", "正文")).toEqual([])
    })

    it("returns [] when stream has no JSON array", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken("没有发现问题，输出空数组")
      })
      expect(await runNovelLint("C:/novel", "正文")).toEqual([])
    })

    it("returns [] when parsed value is not an array", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken('{"not":"array"}')
      })
      expect(await runNovelLint("C:/novel", "正文")).toEqual([])
    })

    it("returns [] when JSON parse fails", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken("[{broken")
      })
      expect(await runNovelLint("C:/novel", "正文")).toEqual([])
    })

    it("logs stream errors via onError callback (Error and non-Error)", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onError: (e: unknown) => void },
      ) => {
        callbacks.onError(new Error("stream hiccup"))
      })
      await runNovelLint("C:/novel", "正文")
      expect(mocks.loggerError).toHaveBeenCalledWith(
        "Novel Lint",
        "Stream error",
        expect.objectContaining({ error: "stream hiccup" }),
      )
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onError: (e: unknown) => void },
      ) => {
        callbacks.onError("plain stream failure")
      })
      await runNovelLint("C:/novel", "正文")
      expect(mocks.loggerError).toHaveBeenCalledWith(
        "Novel Lint",
        "Stream error",
        expect.objectContaining({ error: "plain stream failure" }),
      )
    })

    it("returns [] when streamChat throws (Error and non-Error)", async () => {
      mocks.streamChat.mockRejectedValueOnce(new Error("boom"))
      expect(await runNovelLint("C:/novel", "正文")).toEqual([])
      mocks.streamChat.mockRejectedValueOnce("plain boom")
      expect(await runNovelLint("C:/novel", "正文")).toEqual([])
      expect(mocks.loggerError).toHaveBeenCalledTimes(2)
    })

    it("merges caller signal with timeout when provided", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken("[]")
      })
      const controller = new AbortController()
      await runNovelLint("C:/novel", "正文", undefined, {
        signal: controller.signal,
      })
      expect(mocks.combineAbortSignals).toHaveBeenCalledWith(
        controller.signal,
        expect.any(AbortSignal),
      )
    })

    it("uses plain timeout signal when caller signal absent", async () => {
      mocks.streamChat.mockImplementationOnce(async (
        _cfg: unknown,
        _msgs: unknown,
        callbacks: { onToken: (t: string) => void },
      ) => {
        callbacks.onToken("[]")
      })
      await runNovelLint("C:/novel", "正文")
      expect(mocks.combineAbortSignals).not.toHaveBeenCalled()
    })
  })
})
