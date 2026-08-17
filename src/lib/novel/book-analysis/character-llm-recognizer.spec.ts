import { describe, it, expect, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { llmRecognizeCharacters } from "./character-llm-recognizer"

const streamChatMock = vi.fn()
const extractJsonArraySpanMock = vi.hoisted(() => {
  const fn = vi.fn()
  // mirror real extractJsonArraySpan (pure)
  fn.mockImplementation((text: string): string | null => {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    const end = cleaned.lastIndexOf("]")
    if (end === -1) return null
    let depth = 0
    for (let i = end; i >= 0; i -= 1) {
      const ch = cleaned[i]
      if (ch === "]") depth += 1
      else if (ch === "[") {
        depth -= 1
        if (depth === 0) return cleaned.slice(i, end + 1)
      }
    }
    const greedy = cleaned.match(/\[[\s\S]*\]/)
    return greedy ? greedy[0] : null
  })
  return fn
})
vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
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
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30 * 60 * 1000,
  extractJsonArraySpan: (...args: unknown[]) => extractJsonArraySpanMock(...args),
}))

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
}

const chapters = [
  { index: 0, content: "韩立站在山边小村。" },
  { index: 1, content: "韩铸打着呼噜。" },
]

describe("llmRecognizeCharacters", () => {
  it("keeps a character even when the model omits chapterIndices", async () => {
    const raw = JSON.stringify([
      { name: "韩立", importanceScore: 90, category: "主角" }, // 无 chapterIndices
      { name: "韩铸", importanceScore: 40, category: "配角", chapterIndices: [1] },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "凡人",
      _llmCall: async () => raw,
    })

    const names = result.map((c) => c.name)
    expect(names).toContain("韩立")
    expect(names).toContain("韩铸")
    expect(result.find((c) => c.name === "韩立")?.appearances).toBe(1)
  })

  it("accepts Chinese field names returned by some models", async () => {
    const raw = JSON.stringify([
      { "角色名": "韩立", "重要度": 90, "类别": "主角", "章节索引": [0, 1], "别名": ["二愣子"] },
      { "角色名": "厉飞雨", "重要度": 55, "类别": "配角", "章节索引": [1] },
    ])

    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "凡人",
      _llmCall: async () => raw,
    })

    expect(result.map((c) => c.name)).toEqual(["韩立", "厉飞雨"])
    expect(result[0].aliases).toEqual(["二愣子"])
    expect(result[0].chapterIndices).toEqual([0, 1])
  })

  it("parses fenced JSON and sorts by importance score", async () => {
    const raw = "```json\n" + JSON.stringify([
      { name: "甲", importanceScore: 30, category: "次要", chapterIndices: [0] },
      { name: "乙", importanceScore: 80, category: "主角", chapterIndices: [0, 1] },
    ]) + "\n```"
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    expect(result[0].name).toBe("乙")
  })

  it("throws (rather than silently returning empty) when the response has no JSON array", async () => {
    await expect(
      llmRecognizeCharacters({
        chapters,
        llmConfig,
        sourceBook: "x",
        _llmCall: async () => "模型出错了，这里没有数组",
      }),
    ).rejects.toThrow()
  })

  it("caps the number of chapters sent to the LLM to avoid oversized prompts (HTTP 524)", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ index: i, content: `第${i + 1}章 韩立做了一件事。` }))
    let capturedPrompt = ""
    await llmRecognizeCharacters({
      chapters: many,
      llmConfig,
      sourceBook: "x",
      _llmCall: async (p) => {
        capturedPrompt = p
        return JSON.stringify([{ name: "韩立", importanceScore: 90, category: "主角" }])
      },
    })
    const chapterMarkers = (capturedPrompt.match(/【第 \d+ 章】/g) || []).length
    expect(chapterMarkers).toBeGreaterThan(0)
    expect(chapterMarkers).toBeLessThanOrEqual(12)
  })
})

describe("llmRecognizeCharacters 边界分支", () => {
  it("chapters 为空 → 返回空数组", async () => {
    const result = await llmRecognizeCharacters({
      chapters: [],
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => "[]",
    })
    expect(result).toEqual([])
  })

  it("跳过无 name / 非字符串 name / 空白 name 的角色", async () => {
    const raw = JSON.stringify([
      { importanceScore: 90, category: "主角" },          // 无 name
      { name: 123, importanceScore: 90, category: "主角" }, // 非字符串 name
      { name: "   ", importanceScore: 90, category: "主角" }, // 空白 name
      { name: "韩立", importanceScore: 90, category: "主角", chapterIndices: [0] },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    expect(result.map((c) => c.name)).toEqual(["韩立"])
  })

  it("characterName / 姓名 别名键 + 非法章节索引过滤 + 非字符串别名过滤", async () => {
    const raw = JSON.stringify([
      {
        characterName: "韩立", importanceScore: 90, category: "主角",
        chapterIndices: [0, 1, -1, 2.5, 99, 1],
        aliases: ["韩跑跑", 42, ""],
      },
      { name: "厉飞雨", importanceScore: 55, category: "配角", chapterIndices: [1] },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    const han = result.find((c) => c.name === "韩立")!
    expect(han.chapterIndices).toEqual([0, 1, 1].sort((a, b) => a - b))
    expect(han.aliases).toEqual(["韩跑跑", ""]) // 空串也是 string, 不过滤
  })

  it("字符串数字重要度解析 / 非法数字回退 50 / 分数兜底分类", async () => {
    const raw = JSON.stringify([
      { name: "甲", importanceScore: "85", category: "乱写", chapterIndices: [0] },
      { name: "乙", importanceScore: "abc", category: "乱写", chapterIndices: [0] },
      { name: "丙", importanceScore: 40, category: "乱写", chapterIndices: [0] },
      { name: "丁", importanceScore: 10, category: "乱写", chapterIndices: [0] },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    expect(result.find((c) => c.name === "甲")!.category).toBe("主角") // 85 >= 70
    expect(result.find((c) => c.name === "乙")!.importanceScore).toBe(50)
    expect(result.find((c) => c.name === "乙")!.category).toBe("配角") // 50 >= 30
    expect(result.find((c) => c.name === "丙")!.category).toBe("配角")
    expect(result.find((c) => c.name === "丁")!.category).toBe("次要")
  })

  it("clampScore: 上限 100 / 下限 0 / 四舍五入 / 非法类型回退 50", async () => {
    const raw = JSON.stringify([
      { name: "甲", importanceScore: 999, category: "主角" },
      { name: "乙", importanceScore: -5, category: "主角" },
      { name: "丙", importanceScore: 87.6, category: "主角" },
      { name: "丁", importanceScore: [90], category: "主角" },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    expect(result.find((c) => c.name === "甲")!.importanceScore).toBe(100)
    expect(result.find((c) => c.name === "乙")!.importanceScore).toBe(0)
    expect(result.find((c) => c.name === "丙")!.importanceScore).toBe(88)
    expect(result.find((c) => c.name === "丁")!.importanceScore).toBe(50)
  })

  it("有效类别直接透传（主角/配角/次要）", async () => {
    const raw = JSON.stringify([
      { name: "甲", importanceScore: 10, category: "主角" },
      { name: "乙", importanceScore: 10, category: "配角" },
      { name: "丙", importanceScore: 10, category: "次要" },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    expect(result.find((c) => c.name === "甲")!.category).toBe("主角")
    expect(result.find((c) => c.name === "乙")!.category).toBe("配角")
    expect(result.find((c) => c.name === "丙")!.category).toBe("次要")
  })

  it("空响应 → 返回空数组", async () => {
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => "",
    })
    expect(result).toEqual([])
  })

  it("非数组 JSON → 抛错（extractJsonArraySpan 返回非数组 JSON 时）", async () => {
    extractJsonArraySpanMock.mockReturnValueOnce('{"name":"韩立"}')
    await expect(
      llmRecognizeCharacters({
        chapters,
        llmConfig,
        sourceBook: "x",
        _llmCall: async () => "whatever",
      }),
    ).rejects.toThrow("不是 JSON 数组")
  })

  it("JSON 解析失败 → 抛错（含解析错误信息）", async () => {
    await expect(
      llmRecognizeCharacters({
        chapters,
        llmConfig,
        sourceBook: "x",
        _llmCall: async () => "[{\"name\": }]",
      }),
    ).rejects.toThrow("JSON 解析失败")
  })

  it("importance 相关别名键（importance/score/重要度/重要性/分数）", async () => {
    const raw = JSON.stringify([
      { name: "甲", importance: 66, category: "主角" },
      { name: "乙", score: 77, category: "主角" },
      { name: "丙", 重要度: 88, category: "主角" },
      { name: "丁", 重要性: 99, category: "主角" },
      { name: "戊", 分数: 33, category: "主角" },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
      _llmCall: async () => raw,
    })
    expect(result.find((c) => c.name === "甲")!.importanceScore).toBe(66)
    expect(result.find((c) => c.name === "乙")!.importanceScore).toBe(77)
    expect(result.find((c) => c.name === "丙")!.importanceScore).toBe(88)
    expect(result.find((c) => c.name === "丁")!.importanceScore).toBe(99)
    expect(result.find((c) => c.name === "戊")!.importanceScore).toBe(33)
  })

  it("姓名别名键（姓名）+ sourceBook 缺省默认空串", async () => {
    const raw = JSON.stringify([
      { 姓名: "韩立", importanceScore: 90, category: "主角", chapterIndices: [0] },
    ])
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      _llmCall: async () => raw,
    })
    expect(result[0].name).toBe("韩立")
    expect(result[0].sourceBook).toBe("")
  })
})

describe("callLlmForRecognition（无 _llmCall 走 streamChat）", () => {
  it("happy path: onToken 累积 → trim 返回", async () => {
    streamChatMock.mockReset()
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onToken: (t: string) => void
      onDone: () => void
    }) => {
      callbacks.onToken('  [{"name":"韩立","importanceScore":90,"category":"主角",')
      callbacks.onToken('"chapterIndices":[0]}]  ')
      callbacks.onDone()
    })
    const result = await llmRecognizeCharacters({
      chapters,
      llmConfig,
      sourceBook: "x",
    })
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(result.map((c) => c.name)).toEqual(["韩立"])
  })

  it("onError → streamError 抛给调用方", async () => {
    streamChatMock.mockReset()
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: {
      onError: (e: Error) => void
    }) => {
      callbacks.onError(new Error("429 rate limited"))
    })
    await expect(
      llmRecognizeCharacters({ chapters, llmConfig, sourceBook: "x" }),
    ).rejects.toThrow("429 rate limited")
  })
})
