import { beforeEach, describe, expect, it, vi } from "vitest"

const runSixDimensionReview = vi.fn()
const streamChat = vi.fn()

vi.mock("./dimension-review-adapter", () => ({ runSixDimensionReview: (...args: unknown[]) => runSixDimensionReview(...args) }))
vi.mock("@/lib/llm-client", () => ({ streamChat: (...args: unknown[]) => streamChat(...args) }))
vi.mock("./deep-chapter-generation", () => ({ runDeepChapterGeneration: vi.fn(async () => ({ ok: true, via: "single" })) }))
vi.mock("./consensus-writing", () => ({ runDeepChapterGenerationConsensus: vi.fn(async () => ({ ok: true, via: "consensus" })) }))

const { createMainControlQualityDeps, resolveDeepChapterRunner, stripCodeFence } = await import("./main-control-quality")

const LLM = { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "https://example.test" } as unknown as import("@/stores/wiki-store").LlmConfig

describe("stripCodeFence", () => {
  it("unwrap 单个代码围栏，保留内部换行", () => {
    expect(stripCodeFence("```ts\n第一章\n正文\n```")).toBe("第一章\n正文")
  })

  it("没有围栏时原样返回（去首尾空白）", () => {
    expect(stripCodeFence("  正文  ")).toBe("正文")
  })
})

describe("createMainControlQualityDeps", () => {
  beforeEach(() => {
    runSixDimensionReview.mockReset()
    streamChat.mockReset()
  })

  it("scoreChapter 把六维 review 结果映射成维度分", async () => {
    runSixDimensionReview.mockResolvedValue({
      thrill: { score: 8.2, status: "pass", summary: "", issues: [] },
      consistency: { score: 9, status: "pass", summary: "", issues: [] },
    })
    const deps = createMainControlQualityDeps({ projectPath: "/proj", llmConfig: LLM, chapterNumber: 3 })
    await expect(deps.scoreChapter("正文")).resolves.toEqual({ thrill: 8.2, consistency: 9 })
    expect(runSixDimensionReview).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/proj", chapterContent: "正文", chapterNumber: 3 }),
    )
  })

  it("六维无结果时如实报错而不是造分", async () => {
    runSixDimensionReview.mockResolvedValue({})
    const deps = createMainControlQualityDeps({ projectPath: "/proj", llmConfig: LLM })
    await expect(deps.scoreChapter("正文")).rejects.toThrow(/六维评分无结果/)
  })

  it("reviseChapter 走真实调用并剥掉代码围栏", async () => {
    streamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("```\n重写后的正文\n```")
      callbacks.onDone()
    })
    const deps = createMainControlQualityDeps({ projectPath: "/proj", llmConfig: LLM })
    await expect(deps.reviseChapter("原文", "把节奏调紧")).resolves.toBe("重写后的正文")
    const [, messages] = streamChat.mock.calls[0]
    expect(JSON.stringify(messages)).toContain("把节奏调紧")
  })

  it("reviseChapter 空输出报错、传输错误原样抛出", async () => {
    streamChat.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onDone()
    })
    const deps = createMainControlQualityDeps({ projectPath: "/proj", llmConfig: LLM })
    await expect(deps.reviseChapter("原文", "brief")).rejects.toThrow(/空文本/)

    const boom = new Error("network down")
    streamChat.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onError(boom)
    })
    await expect(deps.reviseChapter("原文", "brief")).rejects.toThrow("network down")
  })

  it("测试注入优先于真实调用", async () => {
    const deps = createMainControlQualityDeps({
      projectPath: "/proj",
      llmConfig: LLM,
      review: async () => ({ thrill: 7 }),
      rewrite: async () => "注入版",
    })
    await expect(deps.scoreChapter("正文")).resolves.toEqual({ thrill: 7 })
    await expect(deps.reviseChapter("原文", "b")).resolves.toBe("注入版")
    expect(runSixDimensionReview).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
  })
})

describe("resolveDeepChapterRunner", () => {
  it("未开启共识时返回单模型深章流水线", async () => {
    const runner = await resolveDeepChapterRunner({})
    await expect(runner({} as never)).resolves.toMatchObject({ via: "single" })
  })

  it("开启共识且配了写作模型组时返回共识版", async () => {
    const runner = await resolveDeepChapterRunner({ consensusEnabled: true, consensusWritingModels: ["a", "b"] })
    await expect(runner({} as never)).resolves.toMatchObject({ via: "consensus" })
  })

  it("开启共识但模型组为空时仍是单模型（空配置不切共识）", async () => {
    const runner = await resolveDeepChapterRunner({ consensusEnabled: true, consensusWritingModels: ["  "] })
    await expect(runner({} as never)).resolves.toMatchObject({ via: "single" })
  })
})
