/**
 * character-extraction-engine 全量覆盖测试（目标 s/l/b/f 100%）
 *
 * 覆盖范围：
 *   - extractCharactersFromChapters：章节读取 / frontmatter 解析（含 \r\n、缺 title/order、无
 *     frontmatter、order:0）/ 识别汇总（count/importance max/chapters 收集）/ 重要角色筛选排序
 *     （importance>=5、slice(0,20)）/ 深度分析（字段缺省兜底、null、LLM 抛错、onError）/
 *     6 维度扩展（standard/deep、bookTitle 缺省、corpus 空串、进度透传、引擎抛错、写档失败）/
 *     进度回调（提供/未提供）/ 取消信号（读取前、识别中、深度分析前、6 维中）
 *   - extractSingleCharacter：simple（内部 realLlmCall + streamChat、字段 ?? 兜底、profileError
 *     透传、写档失败、onError）+ six-dimension（默认 depth、bookTitle 缺省、corpus 空串、写档失败）
 *
 * mock 惯例与 character-llm-recognizer.spec.ts / six-dimension-engine.spec.ts 一致：
 *   - @/lib/llm-client：streamChat / combineAbortSignals / DEFAULT_LLM_REQUEST_TIMEOUT_MS
 *   - @/commands/fs：readFile / writeFile
 *   - ./six-dimension-engine 与 ./simple-extraction-engine 整体 mock
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ExtractedCharacter } from "./types"

const { readFileMock, writeFileMock, streamChatMock, analyzeSixDimensionsMock, extractSingleProfileMock } = vi.hoisted(
  () => ({
    readFileMock: vi.fn<(path: string) => Promise<string>>(async () => ""),
    writeFileMock: vi.fn<(path: string, content: string) => Promise<void>>(async () => undefined),
    streamChatMock: vi.fn(),
    analyzeSixDimensionsMock: vi.fn(),
    extractSingleProfileMock: vi.fn(),
  }),
)

vi.mock("@/commands/fs", () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
  // mirror real combineAbortSignals
  combineAbortSignals: (signal?: AbortSignal, timeoutSignal?: AbortSignal): AbortSignal | undefined => {
    const signals = [signal, timeoutSignal].filter(Boolean) as AbortSignal[]
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    const controller = new AbortController()
    for (const s of signals) {
      if (s.aborted) {
        controller.abort()
        break
      }
      s.addEventListener("abort", () => controller.abort(), { once: true })
    }
    return controller.signal
  },
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 30 * 60 * 1000,
  defaultLlmCall: async (_prompt: string): Promise<string> => {
    throw new Error("defaultLlmCall not implemented in this context")
  },
}))

vi.mock("./six-dimension-engine", () => ({
  analyzeSixDimensions: analyzeSixDimensionsMock,
  DEPTH_DESCRIPTIONS: {
    fast: { label: "快速", description: "d", approxTokenMultiplier: "1×" },
    standard: { label: "标准", description: "d", approxTokenMultiplier: "6×" },
    deep: { label: "完整", description: "d", approxTokenMultiplier: "6×+网络" },
  },
}))

vi.mock("./simple-extraction-engine", () => ({
  extractSingleProfile: extractSingleProfileMock,
}))

import { extractCharactersFromChapters, extractSingleCharacter } from "./character-extraction-engine"
import { stableCharacterId } from "./character-recognition-engine"

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
}

// ---------- helpers ----------

/** 构造带 frontmatter 的章节文件内容 */
const chapterFile = (title: string, order: number, body = "正文内容"): string =>
  `---\ntitle: ${title}\norder: ${order}\n---\n${body}`

/** 按 chapterId 配置 readFile 返回值 */
function setChapters(files: Record<string, string>) {
  readFileMock.mockImplementation(async (path: string) => {
    for (const [id, content] of Object.entries(files)) {
      if (String(path).endsWith(`${id}.md`)) return content
    }
    throw new Error(`chapter not found: ${path}`)
  })
}

const identifyJson = (list: Array<{ name: string; importance: number; aliases?: string[] }>): string =>
  JSON.stringify({
    characters: list.map((c) => ({ name: c.name, aliases: c.aliases ?? [], importance: c.importance })),
  })

const analyzeNameOf = (prompt: string): string => {
  const m = prompt.match(/角色"([^"]+)"/)
  return m ? m[1] : "未命名角色"
}

const chapterTitleOf = (prompt: string): string => {
  const m = prompt.match(/章节：(.+)\n/)
  return m ? m[1].trim() : ""
}

const FULL_ANALYZE = JSON.stringify({
  name: "韩立",
  aliases: ["韩跑跑"],
  category: "protagonist",
  description: "山村少年",
  personality: "坚毅",
  speechStyle: "朴素",
  relationships: [{ target: "厉飞雨", relation: "挚友", description: "同门" }],
  keyEvents: [{ chapterId: "1", description: "拜入七玄门" }],
})

function lastWriteJson(): any {
  const calls = writeFileMock.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1][1] as string)
}

function makeCharacter(over: Partial<ExtractedCharacter> = {}): ExtractedCharacter {
  return {
    id: "char-1",
    name: "韩立",
    aliases: [],
    importance: 9,
    category: "protagonist",
    firstAppearance: 1,
    lastAppearance: 1,
    appearanceCount: 1,
    description: "旧城巡夜人",
    personality: "克制",
    speechStyle: "短句",
    relationships: [],
    keyEvents: [],
    corpus: "示例语料",
    ...over,
  }
}

interface StreamDispatchOpts {
  /** identify 阶段响应（按 prompt 内容动态生成） */
  identify?: (prompt: string) => string
  /** 深度分析阶段响应 */
  analyze?: (prompt: string) => string
  /** 单角色重提（realLlmCall）响应 */
  single?: (prompt: string) => string
  /** identify 调用时的副作用（如 abort） */
  onIdentify?: () => void
  /** 深度分析调用时的副作用 */
  onAnalyze?: () => void
  identifyThrow?: unknown
  analyzeThrow?: unknown
  singleThrow?: unknown
  /** true：错误走 handlers.onError（不 reject）；false/缺省：直接 reject */
  callOnError?: boolean
}

/**
 * 按 prompt 内容分发 streamChat 行为：
 *   identify  prompt 含 "请分析以下小说章节"
 *   analyze   prompt 含 "请深度分析小说角色"
 *   single    其余（extractSingleCharacter 的 realLlmCall）
 */
function setStreamDispatch(opts: StreamDispatchOpts = {}) {
  streamChatMock.mockImplementation(async (_cfg: unknown, msgs: any, handlers: any) => {
    const prompt: string = msgs?.[0]?.content ?? ""
    const run = async (): Promise<string> => {
      if (prompt.includes("请分析以下小说章节")) {
        opts.onIdentify?.()
        if (opts.identifyThrow !== undefined) throw opts.identifyThrow
        return opts.identify ? opts.identify(prompt) : '{"characters":[]}'
      }
      if (prompt.includes("请深度分析小说角色")) {
        opts.onAnalyze?.()
        if (opts.analyzeThrow !== undefined) throw opts.analyzeThrow
        return opts.analyze ? opts.analyze(prompt) : '{"name":"未命名角色"}'
      }
      if (opts.singleThrow !== undefined) throw opts.singleThrow
      return opts.single ? opts.single(prompt) : "{}"
    }
    try {
      const text = await run()
      handlers.onToken?.(text)
      handlers.onDone?.()
    } catch (e) {
      if (opts.callOnError) handlers.onError?.(e)
      else throw e
    }
  })
}

beforeEach(() => {
  streamChatMock.mockReset()
  analyzeSixDimensionsMock.mockReset()
  extractSingleProfileMock.mockReset()
  readFileMock.mockReset()
  readFileMock.mockImplementation(async () => "")
  writeFileMock.mockReset()
  writeFileMock.mockImplementation(async () => undefined)

  // 默认 6 维引擎 mock：调用 onProgress（触发内层进度透传箭头）+ 回填 sixDimensionMeta
  analyzeSixDimensionsMock.mockImplementation(async (input: any) => {
    input.onProgress?.({
      stage: "dimension",
      label: "正在提取：公开资料",
      completed: 0,
      total: 6,
      percentage: 10,
      currentItem: `${input.character.name} · publicMaterial`,
      currentDimension: "publicMaterial",
      dimensions: [],
    })
    return {
      character: {
        ...input.character,
        sixDimensionMeta: {
          depth: input.depth,
          schemaVersion: 1,
          generatedAt: 123,
          webSearchUsed: false,
          llmFallbackUsed: false,
          sourceNote: "",
        },
      },
    }
  })

  // 默认 simple 提取 mock：调用 _llmCall 解析 JSON（模拟 simple-extraction-engine 行为）
  extractSingleProfileMock.mockImplementation(async (input: any) => {
    const raw = await input._llmCall("test prompt")
    let profile
    try {
      const parsed = JSON.parse(raw)
      profile = {
        personality: parsed.personality || "",
        motivation: parsed.motivation || "",
        speechStyle: parsed.speechStyle || "",
        behaviorPatterns: parsed.behaviorPatterns || "",
        quotes: parsed.quotes || [],
      }
    } catch {
      profile = {
        personality: raw.slice(0, 200).trim(),
        motivation: "",
        speechStyle: "",
        behaviorPatterns: "",
        quotes: [],
      }
    }
    return { name: input.character.name, profile, error: undefined, errorKind: undefined }
  })
})

// ============================================================
// extractCharactersFromChapters —— 基础流程
// ============================================================
describe("extractCharactersFromChapters — 基础流程", () => {
  it("happy path：识别→汇总→深度分析→完成（fast 默认）", async () => {
    setChapters({
      c1: chapterFile("第一章", 1),
      c2: chapterFile("第二章", 2),
    })
    setStreamDispatch({
      identify: (prompt) =>
        chapterTitleOf(prompt) === "第一章"
          ? identifyJson([
              { name: "韩立", importance: 9 },
              { name: "龙套", importance: 2 },
            ])
          : identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const progress: any[] = []
    const result = await extractCharactersFromChapters({
      bookPath: "E:/books/b1",
      selectedChapterIds: ["c1", "c2"],
      llmConfig,
      onProgress: (p) => progress.push(p),
    })

    expect(result.success).toBe(true)
    expect(result.characters).toHaveLength(1)
    const c = result.characters[0]
    expect(c.name).toBe("韩立")
    expect(c.id).toBe(stableCharacterId("韩立", ""))
    expect(c.aliases).toEqual(["韩跑跑"])
    expect(c.category).toBe("protagonist")
    expect(c.description).toBe("山村少年")
    expect(c.personality).toBe("坚毅")
    expect(c.speechStyle).toBe("朴素")
    expect(c.relationships).toEqual([{ target: "厉飞雨", relation: "挚友", description: "同门" }])
    expect(c.keyEvents).toEqual([{ chapterId: "1", description: "拜入七玄门" }])
    // importance / appearanceCount 被 mention 汇总数据覆盖
    expect(c.importance).toBe(9)
    expect(c.appearanceCount).toBe(2)
    expect(c.firstAppearance).toBe(1)
    expect(c.lastAppearance).toBe(2)
    // streamChat：2 次识别 + 1 次深度分析
    expect(streamChatMock).toHaveBeenCalledTimes(3)
    // 进度序列
    const labels = progress.map((p) => p.stageLabel)
    expect(labels[0]).toBe("正在识别角色")
    expect(labels).toContain("识别角色中")
    expect(labels).toContain("深度分析角色")
    expect(labels[labels.length - 1]).toBe("角色提取完成")
    expect(progress[progress.length - 1].percentage).toBe(90)
  })

  it("章节内容超过 8000 字符 → prompt 带截断标记", async () => {
    const longBody = "长".repeat(9000)
    setChapters({ c1: chapterFile("第一章", 1, longBody) })
    let identifyPrompt = ""
    setStreamDispatch({
      identify: (prompt) => {
        identifyPrompt = prompt
        return '{"characters":[]}'
      },
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(identifyPrompt).toContain("...(内容过长已截断)")
    expect(result.characters).toEqual([])
  })

  it("深度分析返回缺省字段 → 使用默认值", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => "{}",
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    const c = result.characters[0]
    expect(c.name).toBe("韩立") // data.name 缺省 → characterName
    expect(c.id).toBe(stableCharacterId("韩立", ""))
    expect(c.aliases).toEqual([])
    expect(c.category).toBe("minor")
    expect(c.description).toBe("")
    expect(c.personality).toBe("")
    expect(c.speechStyle).toBe("")
    expect(c.relationships).toEqual([])
    expect(c.keyEvents).toEqual([])
  })

  it("章节 order 为 0 → first/lastAppearance 兜底为 1", async () => {
    setChapters({ c1: chapterFile("第一章", 0) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters[0].firstAppearance).toBe(1)
    expect(result.characters[0].lastAppearance).toBe(1)
  })

  it("相关章节过滤：只包含角色实际出现的章节", async () => {
    setChapters({
      c1: chapterFile("第一章", 1),
      c2: chapterFile("第二章", 2),
      c3: chapterFile("第三章", 3),
    })
    setStreamDispatch({
      identify: (prompt) =>
        chapterTitleOf(prompt) === "第二章"
          ? identifyJson([{ name: "龙套", importance: 2 }])
          : identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1", "c2", "c3"],
      llmConfig,
    })
    const c = result.characters[0]
    expect(c.appearanceCount).toBe(2)
    expect(c.firstAppearance).toBe(1)
    expect(c.lastAppearance).toBe(3)
  })

  it("同一角色跨章节出现 → count 累加 / importance 取 max", async () => {
    setChapters({
      c1: chapterFile("第一章", 1),
      c2: chapterFile("第二章", 2),
    })
    setStreamDispatch({
      identify: (prompt) =>
        chapterTitleOf(prompt) === "第一章"
          ? identifyJson([{ name: "韩立", importance: 5 }])
          : identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1", "c2"],
      llmConfig,
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].importance).toBe(9)
    expect(result.characters[0].appearanceCount).toBe(2)
  })

  it(">20 个重要角色 → 按 importance 降序取前 20", async () => {
    const names: Array<{ name: string; importance: number }> = []
    for (let i = 25; i >= 1; i -= 1) names.push({ name: `角色${i}`, importance: i })
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson(names),
      analyze: (prompt) => JSON.stringify({ name: analyzeNameOf(prompt) }),
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toHaveLength(20)
    expect(result.characters[0].name).toBe("角色25")
    expect(result.characters[19].name).toBe("角色6")
    // identify 1 次 + analyze 20 次
    expect(streamChatMock).toHaveBeenCalledTimes(21)
  })

  it("未提供 onProgress → 正常完成（?. 未定义分支）", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(result.success).toBe(true)
    expect(result.characters).toHaveLength(1)
  })

  it("signal 提供但未取消 → 正常完成", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const controller = new AbortController()
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      signal: controller.signal,
    })
    expect(result.characters).toHaveLength(1)
  })
})

// ============================================================
// extractCharactersFromChapters —— 降级与错误路径
// ============================================================
describe("extractCharactersFromChapters — 降级与错误路径", () => {
  it("识别返回无 JSON → 空角色；depth standard 且无角色 → 跳过 6 维", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identify: () => "模型没有返回 JSON 格式" })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(result.success).toBe(true)
    expect(result.characters).toEqual([])
    expect(analyzeSixDimensionsMock).not.toHaveBeenCalled()
  })

  it("识别返回 characters: null → 兜底空数组", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identify: () => '{"characters": null}' })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("识别 LLM 抛错（Error）→ catch → 返回空", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identifyThrow: new Error("identify boom") })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("识别 LLM 抛非 Error（string）→ String(error) 分支", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identifyThrow: "identify boom string" })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("识别 LLM onError 回调（Error）→ 记录日志后返回空", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identifyThrow: new Error("identify err"), callOnError: true })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("识别 LLM onError 回调（string）→ String(error) 分支", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identifyThrow: "identify err string", callOnError: true })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("识别返回非法 JSON（有花括号但解析失败）→ catch → 空", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({ identify: () => '{"characters": }' })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("深度分析无有效 JSON → 角色被跳过（返回 null）", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => "模型输出没有花括号",
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
    expect(streamChatMock).toHaveBeenCalledTimes(2)
  })

  it("深度分析脏 JSON → jsonrepair 容错修复 → 角色保留", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => '{"name": }',
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    // jsonrepair 修复 '{"name": }' → 角色不再被跳过
    expect(result.characters.length).toBeGreaterThan(0)
  })

  it("深度分析 LLM 抛错（Error）→ catch → 角色跳过", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyzeThrow: new Error("analyze boom"),
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("深度分析 LLM 抛非 Error（string）→ String(error) 分支", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyzeThrow: "analyze boom string",
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("深度分析 onError 回调（Error）→ 返回 null → 角色跳过", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyzeThrow: new Error("analyze err"),
      callOnError: true,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })

  it("深度分析 onError 回调（string）→ 角色跳过", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyzeThrow: "analyze err string",
      callOnError: true,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.characters).toEqual([])
  })
})

// ============================================================
// extractCharactersFromChapters —— frontmatter / 文件读取
// ============================================================
describe("extractCharactersFromChapters — frontmatter / 文件读取", () => {
  it("读取章节失败（Error）→ 全部失败 → 抛 未能读取到任何章节内容", async () => {
    readFileMock.mockImplementation(async () => {
      throw new Error("EIO")
    })
    await expect(
      extractCharactersFromChapters({ bookPath: "B", selectedChapterIds: ["c1"], llmConfig }),
    ).rejects.toThrow("未能读取到任何章节内容")
  })

  it("读取章节失败（string）→ String(error) 分支", async () => {
    readFileMock.mockImplementation(async () => {
      throw "EIO-string"
    })
    await expect(
      extractCharactersFromChapters({ bookPath: "B", selectedChapterIds: ["c1"], llmConfig }),
    ).rejects.toThrow("未能读取到任何章节内容")
  })

  it("部分章节读取失败 → 跳过失败章节继续", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (String(path).endsWith("c1.md")) return chapterFile("第一章", 1)
      throw new Error("c2 missing")
    })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1", "c2"],
      llmConfig,
    })
    expect(result.characters).toHaveLength(1)
  })

  it("无 frontmatter / 缺 title / 缺 order → 章节被跳过 → 抛错", async () => {
    setChapters({
      plain: "纯文本，没有 frontmatter 分隔线",
      noOrder: "---\ntitle: 第一章\n---\n正文",
      noTitle: "---\norder: 1\n---\n正文",
    })
    await expect(
      extractCharactersFromChapters({
        bookPath: "B",
        selectedChapterIds: ["plain", "noOrder", "noTitle"],
        llmConfig,
      }),
    ).rejects.toThrow("未能读取到任何章节内容")
  })

  it("\\r\\n 换行 frontmatter 也能解析", async () => {
    const content = "---\r\ntitle: 第一章\r\norder: 1\r\n---\r\n正文"
    setChapters({ c1: content })
    setStreamDispatch({ identify: () => '{"characters":[]}' })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// extractCharactersFromChapters —— 取消信号
// ============================================================
describe("extractCharactersFromChapters — 取消信号", () => {
  it("signal 已取消（读取前）→ 抛 用户取消分析", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    const controller = new AbortController()
    controller.abort()
    await expect(
      extractCharactersFromChapters({
        bookPath: "B",
        selectedChapterIds: ["c1"],
        llmConfig,
        signal: controller.signal,
      }),
    ).rejects.toThrow("用户取消分析")
  })

  it("signal 在识别循环中取消 → 抛 用户取消分析", async () => {
    setChapters({
      c1: chapterFile("第一章", 1),
      c2: chapterFile("第二章", 2),
    })
    const controller = new AbortController()
    setStreamDispatch({
      identify: () => {
        controller.abort()
        return identifyJson([])
      },
    })
    await expect(
      extractCharactersFromChapters({
        bookPath: "B",
        selectedChapterIds: ["c1", "c2"],
        llmConfig,
        signal: controller.signal,
      }),
    ).rejects.toThrow("用户取消分析")
  })

  it("signal 在深度分析循环前取消 → 抛 用户取消分析", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    const controller = new AbortController()
    setStreamDispatch({
      identify: () => {
        controller.abort()
        return identifyJson([{ name: "韩立", importance: 9 }])
      },
    })
    await expect(
      extractCharactersFromChapters({
        bookPath: "B",
        selectedChapterIds: ["c1"],
        llmConfig,
        signal: controller.signal,
      }),
    ).rejects.toThrow("用户取消分析")
  })

  it("signal 在 6 维循环中取消 → 抛 用户取消分析", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    const controller = new AbortController()
    setStreamDispatch({
      identify: () =>
        identifyJson([
          { name: "韩立", importance: 9 },
          { name: "厉飞雨", importance: 7 },
        ]),
      analyze: () => FULL_ANALYZE,
    })
    analyzeSixDimensionsMock.mockImplementation(async () => {
      controller.abort()
      return { character: makeCharacter() }
    })
    await expect(
      extractCharactersFromChapters({
        bookPath: "B",
        selectedChapterIds: ["c1"],
        llmConfig,
        depth: "standard",
        signal: controller.signal,
      }),
    ).rejects.toThrow("用户取消分析")
  })
})

// ============================================================
// extractCharactersFromChapters —— 6 维度扩展
// ============================================================
describe("extractCharactersFromChapters — 6 维度扩展", () => {
  it("depth standard → 调用 6 维引擎，回填结果并保存档案", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const progress: any[] = []
    const result = await extractCharactersFromChapters({
      bookPath: "E:/books/b1",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
      bookTitle: "凡人修仙传",
      bookAuthor: "忘语",
      onProgress: (p) => progress.push(p),
    })

    expect(analyzeSixDimensionsMock).toHaveBeenCalledTimes(1)
    const sixInput = analyzeSixDimensionsMock.mock.calls[0][0]
    expect(sixInput.depth).toBe("standard")
    expect(sixInput.bookTitle).toBe("凡人修仙传")
    expect(sixInput.bookAuthor).toBe("忘语")
    expect(sixInput.corpus).toContain("正文内容")
    // 内层进度透传（L380/382 箭头）：带 currentDimension 的是透传条目
    const sixStage = progress.filter((p) => p.stage === "analyzing_six_dimension")
    expect(sixStage.length).toBeGreaterThan(1)
    expect(sixStage[0].currentCharacter).toBe("韩立") // 进入角色时（L362）无 currentDimension
    const passthrough = sixStage.find((p) => p.currentDimension)
    expect(passthrough.currentDimension).toBe("publicMaterial")
    expect(passthrough.currentCharacter).toBe("韩立")
    expect(passthrough.stageLabel).toContain("6 维度 · 韩立")
    // 结果回填 + 保存
    expect(result.characters[0].sixDimensionMeta?.depth).toBe("standard")
    const saved = lastWriteJson()
    expect(saved.name).toBe("韩立")
    expect(saved.sixDimensionMeta.depth).toBe("standard")
    const writePath = writeFileMock.mock.calls[0][0] as string
    expect(writePath).toContain("E:/books/b1/characters/")
    expect(writePath.endsWith(".json")).toBe(true)
  })

  it("depth deep 且未传 bookTitle → 默认 未知作品", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "deep",
    })
    const sixInput = analyzeSixDimensionsMock.mock.calls[0][0]
    expect(sixInput.depth).toBe("deep")
    expect(sixInput.bookTitle).toBe("未知作品")
    expect(result.characters[0].sixDimensionMeta?.depth).toBe("deep")
  })

  it("章节正文为空 → 6 维 corpus 传空串", async () => {
    setChapters({ c1: chapterFile("第一章", 1, "") })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(analyzeSixDimensionsMock.mock.calls[0][0].corpus).toBe("")
  })

  it("analyzeSixDimensions 抛错（Error）→ catch → 继续保存原角色", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    analyzeSixDimensionsMock.mockRejectedValueOnce(new Error("6d boom"))
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(result.success).toBe(true)
    expect(analyzeSixDimensionsMock).toHaveBeenCalledTimes(1)
    const saved = lastWriteJson()
    expect(saved.sixDimensionMeta).toBeUndefined()
  })

  it("analyzeSixDimensions 抛非 Error（string）→ String(error) 分支", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    analyzeSixDimensionsMock.mockRejectedValueOnce("6d boom string")
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(result.success).toBe(true)
  })

  it("6 维写档案失败（Error）→ warn → 流程继续", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    writeFileMock.mockRejectedValueOnce(new Error("disk full"))
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(result.success).toBe(true)
    expect(result.characters).toHaveLength(1)
  })

  it("6 维写档案失败（string）→ warn → 流程继续", async () => {
    setChapters({ c1: chapterFile("第一章", 1) })
    setStreamDispatch({
      identify: () => identifyJson([{ name: "韩立", importance: 9 }]),
      analyze: () => FULL_ANALYZE,
    })
    writeFileMock.mockRejectedValueOnce("disk full string")
    const result = await extractCharactersFromChapters({
      bookPath: "B",
      selectedChapterIds: ["c1"],
      llmConfig,
      depth: "standard",
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// extractSingleCharacter —— simple 模式
// ============================================================
describe("extractSingleCharacter — simple 模式", () => {
  it("simple：内部 realLlmCall 调用 streamChat → profile 回填并保存", async () => {
    setStreamDispatch({
      single: () =>
        JSON.stringify({
          personality: "冷静",
          motivation: "守护",
          speechStyle: "简短",
          behaviorPatterns: "克制",
          quotes: ["台词1"],
        }),
    })
    const result = await extractSingleCharacter({
      bookPath: "E:/books/b1",
      bookId: "b1",
      character: makeCharacter(),
      mode: "simple",
      llmConfig,
    })
    // 走真实 LLM（streamChat），不依赖外部 _llmCall
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(result.character.personalityProfile?.personality).toBe("冷静")
    expect(result.character.personalityProfile?.quotes).toEqual(["台词1"])
    expect(result.character.simpleExtractionMeta?.schemaVersion).toBe(1)
    // 清掉 6 维旧数据
    expect(result.character.sixDimensionResearch).toBeUndefined()
    expect(result.character.sixDimensionMeta).toBeUndefined()
    const saved = lastWriteJson()
    expect(saved.personalityProfile.personality).toBe("冷静")
    expect(saved.sixDimensionMeta).toBeUndefined()
  })

  it("simple：aliases/appearanceCount/importance/corpus 缺省 → ?? 兜底", async () => {
    setStreamDispatch({ single: () => "{}" })
    const char = makeCharacter() as unknown as Record<string, unknown>
    char.aliases = undefined
    char.appearanceCount = undefined
    char.importance = undefined
    char.corpus = undefined
    await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: char as unknown as ExtractedCharacter,
      mode: "simple",
      llmConfig,
    })
    const input = extractSingleProfileMock.mock.calls[0][0]
    expect(input.character.aliases).toEqual([])
    expect(input.character.appearances).toBe(0)
    expect(input.character.importanceScore).toBe(0)
    expect(input.chapterSamples).toBe("")
  })

  it("simple：profileError 存在 → 抛 简单提取失败", async () => {
    extractSingleProfileMock.mockResolvedValueOnce({
      name: "韩立",
      profile: { personality: "", motivation: "", speechStyle: "", behaviorPatterns: "", quotes: [] },
      error: "LLM 挂了",
      errorKind: "unknown",
    })
    await expect(
      extractSingleCharacter({
        bookPath: "B",
        bookId: "b1",
        character: makeCharacter(),
        mode: "simple",
        llmConfig,
      }),
    ).rejects.toThrow("简单提取失败：LLM 挂了")
  })

  it("simple：writeFile 失败（Error）→ warn → 仍返回结果", async () => {
    setStreamDispatch({ single: () => "{}" })
    writeFileMock.mockRejectedValueOnce(new Error("save fail"))
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "simple",
      llmConfig,
    })
    expect(result.character.personalityProfile).toBeDefined()
  })

  it("simple：writeFile 失败（string）→ warn → 仍返回结果", async () => {
    setStreamDispatch({ single: () => "{}" })
    writeFileMock.mockRejectedValueOnce("save fail string")
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "simple",
      llmConfig,
    })
    expect(result.character.personalityProfile).toBeDefined()
  })

  it("simple：realLlmCall onError 回调（Error）→ 记录日志", async () => {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: any) => {
      handlers.onError(new Error("llm err"))
    })
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "simple",
      llmConfig,
    })
    expect(result.character.personalityProfile).toBeDefined()
  })

  it("simple：realLlmCall onError 回调（string）→ String(error) 分支", async () => {
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: any) => {
      handlers.onError("llm err string")
    })
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "simple",
      llmConfig,
    })
    expect(result.character.personalityProfile).toBeDefined()
  })
})

// ============================================================
// extractSingleCharacter —— six-dimension 模式
// ============================================================
describe("extractSingleCharacter — six-dimension 模式", () => {
  it("six-dimension：默认 depth standard + bookTitle 缺省 → 未知作品，保存 result.character", async () => {
    analyzeSixDimensionsMock.mockResolvedValueOnce({
      character: {
        ...makeCharacter(),
        sixDimensionMeta: {
          depth: "standard",
          schemaVersion: 1,
          generatedAt: 1,
          webSearchUsed: false,
          llmFallbackUsed: false,
          sourceNote: "",
        },
      },
    })
    const result = await extractSingleCharacter({
      bookPath: "E:/books/b1",
      bookId: "b1",
      character: makeCharacter(),
      mode: "six-dimension",
      llmConfig,
    })
    const input = analyzeSixDimensionsMock.mock.calls[0][0]
    expect(input.depth).toBe("standard")
    expect(input.corpus).toBe("示例语料")
    expect(input.bookTitle).toBe("未知作品")
    expect(result.character.sixDimensionMeta?.depth).toBe("standard")
    const saved = lastWriteJson()
    expect(saved.sixDimensionMeta.depth).toBe("standard")
  })

  it("six-dimension：bookTitle 透传 + depth deep", async () => {
    analyzeSixDimensionsMock.mockResolvedValueOnce({
      character: {
        ...makeCharacter(),
        sixDimensionMeta: {
          depth: "deep",
          schemaVersion: 1,
          generatedAt: 1,
          webSearchUsed: false,
          llmFallbackUsed: false,
          sourceNote: "",
        },
      },
    })
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "six-dimension",
      depth: "deep",
      llmConfig,
      bookTitle: "凡人修仙传",
      bookAuthor: "忘语",
    })
    const input = analyzeSixDimensionsMock.mock.calls[0][0]
    expect(input.depth).toBe("deep")
    expect(input.bookTitle).toBe("凡人修仙传")
    expect(input.bookAuthor).toBe("忘语")
    expect(result.character.sixDimensionMeta?.depth).toBe("deep")
  })

  it("six-dimension：character.corpus 缺省 → corpus 空串", async () => {
    analyzeSixDimensionsMock.mockResolvedValueOnce({ character: makeCharacter({ corpus: undefined }) })
    const char = makeCharacter() as unknown as Record<string, unknown>
    char.corpus = undefined
    await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: char as unknown as ExtractedCharacter,
      mode: "six-dimension",
      llmConfig,
    })
    expect(analyzeSixDimensionsMock.mock.calls[0][0].corpus).toBe("")
  })

  it("six-dimension：writeFile 失败（Error）→ warn → 仍返回", async () => {
    analyzeSixDimensionsMock.mockResolvedValueOnce({ character: makeCharacter() })
    writeFileMock.mockRejectedValueOnce(new Error("save fail"))
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "six-dimension",
      llmConfig,
    })
    expect(result.character).toBeDefined()
  })

  it("six-dimension：writeFile 失败（string）→ warn → 仍返回", async () => {
    analyzeSixDimensionsMock.mockResolvedValueOnce({ character: makeCharacter() })
    writeFileMock.mockRejectedValueOnce("save fail string")
    const result = await extractSingleCharacter({
      bookPath: "B",
      bookId: "b1",
      character: makeCharacter(),
      mode: "six-dimension",
      llmConfig,
    })
    expect(result.character).toBeDefined()
  })
})
