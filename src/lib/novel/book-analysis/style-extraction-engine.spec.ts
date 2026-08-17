import { beforeEach, describe, expect, it, vi } from "vitest"
import { analyzeWritingStyle, styleProfileToMarkdown } from "./style-extraction-engine"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  streamChat: vi.fn(),
  combineAbortSignals: vi.fn(),
  loadChapterList: vi.fn(),
  loadMetadata: vi.fn(),
  buildStyleExtractionPrompt: vi.fn(),
  parseStyleProfileResult: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
  combineAbortSignals: mocks.combineAbortSignals,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30,
}))

vi.mock("./analysis-engine", () => ({
  loadChapterList: mocks.loadChapterList,
  loadMetadata: mocks.loadMetadata,
}))

vi.mock("./style-prompts", () => ({
  STYLE_DIMENSIONS: [
    { key: "narrativeDensity", label: "叙事密度 / 节奏" },
    { key: "descriptionWeight", label: "环境描写比重" },
  ],
  buildStyleExtractionPrompt: mocks.buildStyleExtractionPrompt,
  parseStyleProfileResult: mocks.parseStyleProfileResult,
}))

import type { LlmConfig } from "@/stores/wiki-store"
import type { BookStyleProfile } from "./types"

const stubLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "x",
  model: "x",
  ollamaUrl: "http://127.0.0.1:1",
  customEndpoint: "http://127.0.0.1:1",
  maxContextSize: 8000,
}

const chapters = [
  { chapterId: "ch-0001", title: "第1章 初入江湖", order: 1, wordCount: 5000, selected: false, analyzed: false },
  { chapterId: "ch-0002", title: "第2章 夜探", order: 2, wordCount: 4000, selected: false, analyzed: false },
  { chapterId: "ch-0003", title: "第3章 惊变", order: 3, wordCount: 6000, selected: false, analyzed: false },
  { chapterId: "ch-0004", title: "第4章 收束", order: 4, wordCount: 100, selected: false, analyzed: false },
]

function baseProfile(ids: string[] = ["ch-0001", "ch-0002", "ch-0003"]): BookStyleProfile {
  return {
    schemaVersion: 1,
    generatedAt: 0,
    sampledChapterIds: ids,
    narrativeDensity: "密度高、推进快",
    descriptionWeight: "环境描写少且具体",
    emotionRendering: "",
    sentenceStyle: "",
    rhetoricDensity: "",
    transitionStyle: "",
    narrativeVoice: "",
    dialogueStyle: "",
    thematicHabits: "",
    constitution: "1. 朴素\n2. 克制",
    samples: ["原文片段一", "原文片段二"],
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.combineAbortSignals.mockImplementation((...s: (AbortSignal | undefined)[]) => s[0] as AbortSignal)
  mocks.parseStyleProfileResult.mockImplementation((_raw: string, ids: string[]) => baseProfile(ids))
})

describe("analyzeWritingStyle", () => {
  it("全流程: 读章节 → 抽样 → LLM 流式 → 写 style-profile.json + style.md", async () => {
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue({ title: "长夜书" })
    mocks.readFile.mockResolvedValue("---\nid: ch-0001\ntitle: 第1章\ntype: chapter\n---\n\n正文第一段。\n正文第二段。")
    mocks.buildStyleExtractionPrompt.mockReturnValue("prompt-text")
    mocks.parseStyleProfileResult.mockReturnValue(baseProfile())
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, cb) => {
      cb.onToken("JSON 结果")
      cb.onDone()
    })

    const onProgress = vi.fn()
    const profile = await analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig, { onProgress })

    expect(profile.sampledChapterIds).toHaveLength(3)
    expect(profile.generatedAt).toBeGreaterThan(0)
    expect(mocks.readFile).toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile).toHaveBeenCalledTimes(2)
    // style-profile.json 内容
    const jsonCall = mocks.writeFile.mock.calls.find((c) => c[0].endsWith("style-profile.json"))
    expect(jsonCall).toBeDefined()
    expect(JSON.parse(jsonCall![1] as string).constitution).toContain("朴素")
    // style.md 内容
    const mdCall = mocks.writeFile.mock.calls.find((c) => c[0].endsWith("style.md"))
    expect(mdCall![1]).toContain("长夜书")
    expect(onProgress).toHaveBeenCalled()
  })

  it("开头 signal aborted → throw 用户取消提取", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig, { signal: controller.signal }),
    ).rejects.toThrow("用户取消提取")
  })

  it("无章节 → throw 提示先完成拆书", async () => {
    mocks.loadChapterList.mockResolvedValue([])
    await expect(
      analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig),
    ).rejects.toThrow("没有可用于分析的章节")
  })

  it("章节太少 → 全量作池（meaningful < 3 用全部章节）", async () => {
    const two = [
      { chapterId: "ch-0001", title: "第1章", order: 1, wordCount: 5000, selected: false, analyzed: false },
      { chapterId: "ch-0002", title: "第2章", order: 2, wordCount: 4000, selected: false, analyzed: false },
    ]
    mocks.loadChapterList.mockResolvedValue(two)
    mocks.loadMetadata.mockResolvedValue({ title: "短篇" })
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n\n正文。")
    mocks.buildStyleExtractionPrompt.mockReturnValue("p")
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.streamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    const profile = await analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig)
    expect(profile.sampledChapterIds).toEqual(["ch-0001", "ch-0002"])
  })

  it("章节数 > 8 → pickEvenlySpread 首/中/尾均匀抽样（items.length > count 分支）", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      chapterId: `ch-${String(i + 1).padStart(4, "0")}`,
      title: `第${i + 1}章`,
      order: i + 1,
      wordCount: 3000 + i,
      selected: false,
      analyzed: false,
    }))
    mocks.loadChapterList.mockResolvedValue(many)
    mocks.loadMetadata.mockResolvedValue({ title: "长篇" })
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n\n正文内容。")
    mocks.buildStyleExtractionPrompt.mockReturnValue("p")
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.streamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    const profile = await analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig)
    // MAX_SAMPLE_CHAPTERS = 8: 首章与末章必须入选，且总数为 8
    expect(profile.sampledChapterIds).toHaveLength(8)
    expect(profile.sampledChapterIds[0]).toBe("ch-0001")
    expect(profile.sampledChapterIds[7]).toBe("ch-0012")
  })

  it("正文为空 → throw 样本章节正文为空", async () => {
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue({ title: "x" })
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n\n  ") // 全空白
    await expect(
      analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig),
    ).rejects.toThrow("样本章节正文为空")
  })

  it("部分章节读取失败 → 跳过失败章（catch 吞掉），成功章照常采样", async () => {
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue({ title: "x" })
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("ch-0002")) throw new Error("io")
      return "---\ntype: chapter\n---\n\n正文内容。"
    })
    mocks.buildStyleExtractionPrompt.mockReturnValue("p")
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.streamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    const profile = await analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig)
    // 采样列表仍含 ch-0002（parseStyleProfileResult 接收 sampled 全量），
    // 但 ch-0002 读取失败被 catch 吞掉，其余样本正常进入 prompt
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(mocks.writeFile).toHaveBeenCalledTimes(2)
    expect(profile.generatedAt).toBeGreaterThan(0)
  })

  it("抽样循环内 signal aborted → throw", async () => {
    const controller = new AbortController()
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue({ title: "x" })
    mocks.readFile.mockImplementation(async () => {
      controller.abort()
      throw new Error("io")
    })
    await expect(
      analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig, { signal: controller.signal }),
    ).rejects.toThrow("用户取消提取")
  })

  it("streamChat 后 signal aborted → throw", async () => {
    const controller = new AbortController()
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue({ title: "x" })
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n\n正文内容。")
    mocks.streamChat.mockImplementation(async () => {
      controller.abort()
    })
    await expect(
      analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig, { signal: controller.signal }),
    ).rejects.toThrow("用户取消提取")
  })

  it("streamError 非空 → throw streamError", async () => {
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue({ title: "x" })
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n\n正文内容。")
    mocks.streamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onError(new Error("llm-boom"))
    })
    await expect(
      analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig),
    ).rejects.toThrow("llm-boom")
  })

  it("loadMetadata 失败 → 书名回退未命名作品", async () => {
    mocks.loadChapterList.mockResolvedValue(chapters)
    mocks.loadMetadata.mockResolvedValue(null)
    mocks.readFile.mockResolvedValue("---\ntype: chapter\n---\n\n正文内容。")
    mocks.buildStyleExtractionPrompt.mockReturnValue("p")
    mocks.parseStyleProfileResult.mockReturnValue(baseProfile())
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.streamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    await analyzeWritingStyle("E:/Novel/book-analysis/b1", stubLlmConfig)
    const mdCall = mocks.writeFile.mock.calls.find((c) => c[0].endsWith("style.md"))
    expect(mdCall![1]).toContain("未命名作品")
  })
})

describe("styleProfileToMarkdown", () => {
  it("渲染标题 + 样本数 + 维度 + 宪法 + 样本列表", () => {
    const md = styleProfileToMarkdown(baseProfile(), "长夜书")
    expect(md).toContain("《长夜书》作品文风画像")
    expect(md).toContain("3 章样本")
    expect(md).toContain("叙事密度 / 节奏")
    expect(md).toContain("密度高、推进快")
    expect(md).toContain("1. 朴素")
    expect(md).toContain("1. 原文片段一")
    expect(md).toContain("2. 原文片段二")
  })

  it("空维度值 → （未提取）占位；空样本 → （无）", () => {
    const md = styleProfileToMarkdown({ ...baseProfile(), narrativeDensity: "", samples: [] }, "x")
    expect(md).toContain("（未提取）")
    expect(md).toContain("（无）")
  })
})
