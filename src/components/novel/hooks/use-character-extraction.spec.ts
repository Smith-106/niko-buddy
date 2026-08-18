// @vitest-environment jsdom
/**
 * useCharacterExtraction — 深度提取 / 简单提取 / 失败重试三路全分支覆盖。
 * 所有 store 与外部模块 vi.mock（vi.hoisted 可写 state 模式，参照 src/App.spec.tsx）。
 */
import { renderHook, act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import type {
  AnalysisDepth,
  BookAnalysisConfig,
  BookAnalysisMetadata,
  BookAnalysisProgress,
  BookAnalysisTask,
  BookStyleProfile,
  CharacterSkill,
  ExtractedCharacter,
  RecognizedCharacter,
} from "@/lib/novel/book-analysis/types"
import type { CharacterExtractionInput } from "@/lib/novel/book-analysis/character-extraction-engine"
import type { SingleProfileInput } from "@/lib/novel/book-analysis/simple-extraction-engine"
import { useCharacterExtraction, type ChapterSelectionData } from "./use-character-extraction"

interface TaskLike {
  id: string
  metadata?: Record<string, unknown>
  characters?: ExtractedCharacter[]
}

const mocks = vi.hoisted(() => {
  type UpdateTaskProgressFn = (taskId: string, progress: Partial<BookAnalysisProgress>) => void
  type UpdateTaskCharactersFn = (taskId: string, characters: ExtractedCharacter[]) => void
  type UpdateTaskSkillsFn = (taskId: string, skills: CharacterSkill[]) => void
  type UpdateTaskBookDataFn = (
    taskId: string,
    bookId: string,
    chapters: NonNullable<BookAnalysisTask["chapters"]>,
    bookPath?: string,
  ) => void
  type UpdateTaskMetadataFn = (taskId: string, metadata: BookAnalysisMetadata) => void
  type UpdateTaskStyleProfileFn = (taskId: string, styleProfile: BookStyleProfile) => void
  type CompleteTaskFn = (taskId: string) => void
  type ErrorTaskFn = (taskId: string, error: string) => void
  type StartTaskFn = (projectPath: string, config: BookAnalysisConfig, abortController?: AbortController) => string
  type TriggerSidebarRefreshFn = () => void
  type RequestReopenChapterSelectionFn = (taskId: string) => void
  type SetStateFn = (updater: unknown) => void

  const bookAnalysis: {
    tasks: TaskLike[]
    updateTaskProgress: Mock<UpdateTaskProgressFn>
    updateTaskCharacters: Mock<UpdateTaskCharactersFn>
    updateTaskSkills: Mock<UpdateTaskSkillsFn>
    updateTaskBookData: Mock<UpdateTaskBookDataFn>
    updateTaskMetadata: Mock<UpdateTaskMetadataFn>
    updateTaskStyleProfile: Mock<UpdateTaskStyleProfileFn>
    completeTask: Mock<CompleteTaskFn>
    errorTask: Mock<ErrorTaskFn>
    startTask: Mock<StartTaskFn>
    triggerSidebarRefresh: Mock<TriggerSidebarRefreshFn>
    requestReopenChapterSelection: Mock<RequestReopenChapterSelectionFn>
    setState: Mock<SetStateFn>
  } = {
    tasks: [],
    updateTaskProgress: vi.fn<UpdateTaskProgressFn>(),
    updateTaskCharacters: vi.fn<UpdateTaskCharactersFn>(),
    updateTaskSkills: vi.fn<UpdateTaskSkillsFn>(),
    updateTaskBookData: vi.fn<UpdateTaskBookDataFn>(),
    updateTaskMetadata: vi.fn<UpdateTaskMetadataFn>(),
    updateTaskStyleProfile: vi.fn<UpdateTaskStyleProfileFn>(),
    completeTask: vi.fn<CompleteTaskFn>(),
    errorTask: vi.fn<ErrorTaskFn>(),
    startTask: vi.fn<StartTaskFn>(() => "task-1"),
    triggerSidebarRefresh: vi.fn<TriggerSidebarRefreshFn>(),
    requestReopenChapterSelection: vi.fn<RequestReopenChapterSelectionFn>(),
    setState: vi.fn<SetStateFn>((updater: unknown) => {
      const next =
        typeof updater === "function" ? (updater as (s: typeof bookAnalysis) => unknown)(bookAnalysis) : updater
      Object.assign(bookAnalysis, next as Partial<typeof bookAnalysis>)
    }),
  }
  const wiki: {
    aiChatModel: string
    llmConfig: { provider: string; apiKey: string; model: string } | null
    providerConfigs: Record<string, unknown>
  } = {
    aiChatModel: "",
    llmConfig: { provider: "openai", apiKey: "key-1", model: "gpt-4o" },
    providerConfigs: {},
  }
  type ResolveModelConfigFn = typeof import("@/lib/novel/model-resolver").resolveModelConfig
  type ReadFileFn = typeof import("@/commands/fs").readFile
  type JoinPathFn = typeof import("@/lib/path-utils").joinPath
  type ExtractCharactersFromChaptersFn = typeof import("@/lib/novel/book-analysis/character-extraction-engine").extractCharactersFromChapters
  type PersistCharacterToDiskFn = typeof import("@/lib/novel/book-analysis/character-disk-store").persistCharacterToDisk
  type GenerateSkillsForCharactersFn = typeof import("@/lib/novel/book-analysis/skill-generator").generateSkillsForCharacters
  type StreamChatFn = typeof import("@/lib/llm-client").streamChat
  type ExtractSingleProfileFn = typeof import("@/lib/novel/book-analysis/simple-extraction-engine").extractSingleProfile
  return {
    bookAnalysis,
    wiki,
    resolveModelConfig: vi.fn<ResolveModelConfigFn>(
      (targetModel, base) => ({
        ...base,
        model: targetModel,
      }),
    ),
    readFile: vi.fn<ReadFileFn>(async () => "---\ntitle: 第一章\n---\n正文内容正文内容"),
    joinPath: vi.fn<JoinPathFn>((...parts) => parts.join("/")),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    extractCharactersFromChapters: vi.fn<ExtractCharactersFromChaptersFn>(),
    persistCharacterToDisk: vi.fn<PersistCharacterToDiskFn>(),
    generateSkillsForCharacters: vi.fn<GenerateSkillsForCharactersFn>(),
    streamChat: vi.fn<StreamChatFn>(),
    extractSingleProfile: vi.fn<ExtractSingleProfileFn>(),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(mocks.wiki),
    { getState: () => mocks.wiki },
  ),
}))

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: {
    getState: () => mocks.bookAnalysis,
    setState: (updater: unknown) => mocks.bookAnalysis.setState(updater),
  },
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveModelConfig: mocks.resolveModelConfig,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
}))

vi.mock("@/lib/path-utils", () => ({
  joinPath: mocks.joinPath,
}))

vi.mock("@/lib/toast", () => ({
  toast: mocks.toast,
}))

vi.mock("@/lib/novel/book-analysis/character-extraction-engine", () => ({
  extractCharactersFromChapters: mocks.extractCharactersFromChapters,
}))

vi.mock("@/lib/novel/book-analysis/character-disk-store", () => ({
  persistCharacterToDisk: mocks.persistCharacterToDisk,
}))

vi.mock("@/lib/novel/book-analysis/skill-generator", () => ({
  generateSkillsForCharacters: mocks.generateSkillsForCharacters,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/lib/novel/book-analysis/simple-extraction-engine", () => ({
  extractSingleProfile: mocks.extractSingleProfile,
}))

// ── fixtures ────────────────────────────────────────────────────────────────────

const metadata = {
  title: "长夜书",
  author: "某人",
  totalChapters: 2,
  totalWords: 1800,
  sourceType: "file" as const,
  createdAt: 1,
  updatedAt: 2,
}

function makeChapterSelectionData(overrides: Partial<ChapterSelectionData> = {}): ChapterSelectionData {
  return {
    taskId: "task-1",
    bookPath: "/books/b1",
    chapters: [
      { id: "c1", title: "第一章", order: 1, wordCount: 1000, path: "/books/b1/chapters/c1.md" },
      { id: "c2", title: "第二章", order: 2, wordCount: 800, path: "/books/b1/chapters/c2.md" },
    ],
    metadata,
    abortController: new AbortController(),
    selectedChapterIds: ["c1", "c2"],
    depth: "standard" as AnalysisDepth,
    ...overrides,
  }
}

const recognized: RecognizedCharacter[] = [
  { id: "r1", name: "林烬", aliases: [], appearances: 3, chapterIndices: [0, 1], importanceScore: 90, category: "主角", sourceBook: "长夜书" },
  { id: "r2", name: "苏遥", aliases: [], appearances: 2, chapterIndices: [0], importanceScore: 70, category: "配角", sourceBook: "长夜书" },
  { id: "r3", name: "路人甲", aliases: [], appearances: 1, chapterIndices: [1], importanceScore: 30, category: "次要", sourceBook: "长夜书" },
]

const deepCharacters: ExtractedCharacter[] = [
  {
    id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist",
    firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "克制",
    speechStyle: "短句", relationships: [], keyEvents: [],
  },
  {
    id: "r2", name: "苏遥", aliases: [], importance: 7, category: "supporting",
    firstAppearance: 1, lastAppearance: 1, appearanceCount: 2, description: "", personality: "柔",
    speechStyle: "长句", relationships: [], keyEvents: [],
  },
]

const profile = { personality: "克制", motivation: "复仇", speechStyle: "短句", behaviorPatterns: "果断", quotes: ["走"] }

function successProfile(name: string) {
  return { name, profile, error: undefined as string | undefined, errorKind: undefined as string | undefined }
}
function errorProfile(name: string, errorKind?: string) {
  return { name, profile, error: "boom", errorKind }
}

/**
 * 类型上满足 Error、运行时不是 Error 实例。
 * 用于覆盖 hook 内 `err instanceof Error ? err.message : String(err)` 的 String(err) 兜底分支。
 */
class RawStringError {
  name = "Error"
  message: string
  constructor(message: string) {
    this.message = message
  }
  toString(): string {
    return this.message
  }
}

function renderExtractionHook(overrides: Partial<Parameters<typeof useCharacterExtraction>[0]> = {}) {
  const props = {
    chapterSelectionData: makeChapterSelectionData(),
    setChapterSelectionData: vi.fn(),
    recognizedCharacters: recognized,
    selectedCharacterIds: ["r1", "r2"],
    reloadLibraryState: vi.fn(async () => {}),
    ...overrides,
  }
  const rendered = renderHook(() => useCharacterExtraction(props))
  return { ...rendered, props }
}

describe("useCharacterExtraction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bookAnalysis.tasks = []
    mocks.wiki.aiChatModel = ""
    mocks.wiki.llmConfig = { provider: "openai", apiKey: "key-1", model: "gpt-4o" }
    mocks.wiki.providerConfigs = {}
    mocks.readFile.mockResolvedValue("---\ntitle: 第一章\n---\n正文内容正文内容")
    mocks.extractSingleProfile.mockImplementation(async ({ character }: { character: { name: string } }) =>
      successProfile(character.name),
    )
    mocks.persistCharacterToDisk.mockResolvedValue(undefined)
    mocks.generateSkillsForCharacters.mockResolvedValue([])
  })

  // ── handleDeepExtract ──────────────────────────────────────────────────────────

  it("deep: 无 chapterSelectionData 时直接返回", async () => {
    const { result, props } = renderExtractionHook({ chapterSelectionData: null })
    await act(async () => {
      await result.current.handleDeepExtract()
    })
    expect(mocks.bookAnalysis.updateTaskCharacters).not.toHaveBeenCalled()
    expect(props.reloadLibraryState).not.toHaveBeenCalled()
    expect(result.current.extracting).toBe(false)
  })

  it("deep: 无勾选角色时直接返回", async () => {
    const { result, props } = renderExtractionHook({ selectedCharacterIds: [] })
    await act(async () => {
      await result.current.handleDeepExtract()
    })
    expect(mocks.bookAnalysis.updateTaskCharacters).not.toHaveBeenCalled()
    expect(props.reloadLibraryState).not.toHaveBeenCalled()
  })

  it("deep: 成功路径（aiChatModel 存在 → resolveModelConfig；含 onProgress、持久化、技能生成）", async () => {
    mocks.wiki.aiChatModel = "openai/gpt-5"
    const progressCb: Parameters<NonNullable<CharacterExtractionInput["onProgress"]>>[0] = {
      stage: "analyzing", stageLabel: "分析中", completed: 1, total: 2, percentage: 50,
      currentItem: "x", currentCharacter: "林烬", currentDimension: "speechStyle",
      dimensions: [{ key: "speechStyle", label: "说话风格", status: "done" }],
    }
    mocks.extractCharactersFromChapters.mockImplementation(async (input) => {
      input.onProgress?.(progressCb)
      return { success: true, characters: deepCharacters }
    })
    mocks.persistCharacterToDisk.mockImplementation(async (_path: string, c: { name: string }) => {
      if (c.name === "苏遥") throw new Error("disk-fail")
    })
    const skillProgress = { stage: "generating_skills", stageLabel: "技能", completed: 1, total: 1, percentage: 100, currentItem: "s" }
    mocks.generateSkillsForCharacters.mockImplementation(async (_characters, _bookMetadata, _bookPath, _llmConfig, onProgress) => {
      onProgress?.(skillProgress)
      return [{ id: "skill-1", characterId: "r1", characterName: "林烬", skillContent: "# 林烬", sourceBook: "长夜书", chapterRange: ["1"], createdAt: 3 }]
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { result, props } = renderExtractionHook()

    await act(async () => {
      await result.current.handleDeepExtract()
    })

    expect(mocks.resolveModelConfig).toHaveBeenCalledWith("openai/gpt-5", mocks.wiki.llmConfig, mocks.wiki.providerConfigs)
    expect(mocks.extractCharactersFromChapters).toHaveBeenCalledWith(
      expect.objectContaining({
        bookPath: "/books/b1",
        selectedChapterIds: ["c1", "c2"],
        depth: "standard",
        bookTitle: "长夜书",
        bookAuthor: "某人",
      }),
    )
    // 过滤到勾选角色（r1/r2），排除未勾选的 r3
    expect(mocks.bookAnalysis.updateTaskCharacters).toHaveBeenCalledWith("task-1", deepCharacters)
    // 持久化 2 个角色，苏遥失败走 console.warn 分支
    expect(mocks.persistCharacterToDisk).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("苏遥"), expect.anything())
    expect(mocks.bookAnalysis.updateTaskSkills).toHaveBeenCalledTimes(1)
    expect(mocks.bookAnalysis.completeTask).toHaveBeenCalledWith("task-1")
    expect(props.reloadLibraryState).toHaveBeenCalledTimes(1)
    expect(mocks.bookAnalysis.triggerSidebarRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success).toHaveBeenCalledWith("深度提取完成")
    expect(props.setChapterSelectionData).toHaveBeenCalledWith(expect.objectContaining({ extractionPhase: "deep" }))
    expect(result.current.extracting).toBe(false)
    warnSpy.mockRestore()
  })

  it("deep: 提取引擎返回 success=false 时标记任务失败", async () => {
    mocks.extractCharactersFromChapters.mockResolvedValue({ success: false, characters: [] })
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleDeepExtract()
    })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "6 维度提取失败")
    expect(mocks.toast.error).not.toHaveBeenCalled()
    expect(mocks.bookAnalysis.completeTask).not.toHaveBeenCalled()
  })

  it("deep: 引擎抛普通错误 → errorTask + toast.error", async () => {
    mocks.extractCharactersFromChapters.mockRejectedValue(new Error("provider 500"))
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleDeepExtract()
    })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "provider 500")
    expect(mocks.toast.error).toHaveBeenCalledWith("深度提取失败：provider 500")
  })

  it("deep: 引擎抛非 Error 值 → 降级为『分析失败』", async () => {
    mocks.extractCharactersFromChapters.mockRejectedValue("raw-boom")
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleDeepExtract()
    })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "分析失败")
    expect(mocks.toast.error).toHaveBeenCalledWith("深度提取失败：分析失败")
  })

  it("deep: 引擎抛『取消』类错误时静默跳过", async () => {
    mocks.extractCharactersFromChapters.mockRejectedValue(new Error("用户取消"))
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleDeepExtract()
    })
    expect(mocks.bookAnalysis.errorTask).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  // ── handleSimpleExtract ────────────────────────────────────────────────────────

  it("simple: 无数据/无勾选时直接返回", async () => {
    const { result } = renderExtractionHook({ chapterSelectionData: null })
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    const { result: result2 } = renderExtractionHook({ selectedCharacterIds: [] })
    await act(async () => {
      await result2.current.handleSimpleExtract()
    })
    expect(mocks.bookAnalysis.updateTaskCharacters).not.toHaveBeenCalled()
  })

  it("simple: 全成功路径（读取章节、streamChat、完成、持久化、技能、sidebar 刷新）", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("样本文本")
      handlers.onDone()
    })
    mocks.generateSkillsForCharacters.mockImplementation(async (_characters, _bookMetadata, _bookPath, _llmConfig, onProgress) => {
      onProgress?.({ stage: "generating_skills", stageLabel: "技能", completed: 1, total: 1, percentage: 100, currentItem: "s" })
      return [
        { id: "skill-1", characterId: "r1", characterName: "林烬", skillContent: "# 林烬", sourceBook: "长夜书", chapterRange: ["1"], createdAt: 3 },
      ]
    })
    mocks.bookAnalysis.tasks = [
      { id: "other-task", metadata: {} },
      { id: "task-1" },
    ]
    // 真实 extractSingleProfile 会调用 _llmCall 走 streamChat 闭包（onToken/onDone）
    mocks.extractSingleProfile.mockImplementation(async ({ _llmCall }) => {
      await _llmCall?.("prompt")
      return successProfile("林烬")
    })
    // 简单提取持久化失败 → console.warn 分支
    mocks.persistCharacterToDisk.mockImplementation(async (_path, c) => {
      if (c.name === "苏遥") throw new Error("disk-fail")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { result, props } = renderExtractionHook({ selectedCharacterIds: ["r1", "r2", "r3"] })

    await act(async () => {
      await result.current.handleSimpleExtract()
    })

    expect(mocks.readFile).toHaveBeenCalledTimes(2)
    expect(mocks.readFile).toHaveBeenCalledWith("/books/b1/chapters/c1.md")
    expect(mocks.streamChat).toHaveBeenCalledTimes(3)
    // 3 个角色全部成功 → 分类映射 主角/配角/次要 → protagonist/supporting/minor
    const characters = mocks.bookAnalysis.updateTaskCharacters.mock.calls[0][1] as ExtractedCharacter[]
    expect(characters).toHaveLength(3)
    expect(characters.map((c) => c.category)).toEqual(["protagonist", "supporting", "minor"])
    expect(characters[0].firstAppearance).toBe(1)
    expect(characters[0].lastAppearance).toBe(2)
    // 失败 0 → 状态 done，stageLabel 无失败前缀
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ simpleExtractionStatus: "done" }),
    )
    expect(mocks.bookAnalysis.completeTask).toHaveBeenCalledWith("task-1")
    expect(props.reloadLibraryState).toHaveBeenCalledTimes(1)
    expect(mocks.bookAnalysis.triggerSidebarRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success).toHaveBeenCalledWith("简单提取完成")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("苏遥"), expect.anything())
    warnSpy.mockRestore()
    // 元数据回写：other-task 走 `: t` 分支；task-1 无 metadata → `?? {}` 兜底
    expect(mocks.bookAnalysis.setState).toHaveBeenCalled()
  })

  it("simple: 部分失败（network）+ 4 个失败角色 → 网络中断标签、errorSummary 省略号、partial 状态", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("样本")
      handlers.onDone()
    })
    mocks.extractSingleProfile.mockImplementation(async ({ character, _llmCall }: { character: { name: string }; _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      if (character.name === "林烬") return successProfile("林烬")
      return errorProfile(character.name, character.name === "苏遥" ? "network" : undefined)
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: {} }]
    // 5 个角色：1 成功 + 4 失败（1 个 network）→ 覆盖 errorSummary 的 "..." 分支
    const fiveRecognized: RecognizedCharacter[] = [
      ...recognized,
      { id: "r4", name: "乙", aliases: [], appearances: 1, chapterIndices: [0], importanceScore: 20, category: "次要", sourceBook: "长夜书" },
      { id: "r5", name: "丙", aliases: [], appearances: 1, chapterIndices: [0], importanceScore: 20, category: "次要", sourceBook: "长夜书" },
    ]
    const { result } = renderExtractionHook({
      recognizedCharacters: fiveRecognized,
      selectedCharacterIds: ["r1", "r2", "r3", "r4", "r5"],
    })

    await act(async () => {
      await result.current.handleSimpleExtract()
    })

    // 最终 stageLabel 含网络中断 + 失败汇总 + resumeHint
    const finalLabel = mocks.bookAnalysis.updateTaskProgress.mock.calls
      .map((c) => c[1])
      .find((p) => p.simpleExtractionStatus === "partial")
    expect(finalLabel).toBeDefined()
    expect(finalLabel?.stageLabel).toContain("网络中断")
    expect(finalLabel?.stageLabel).toContain("失败 4 个")
    expect(finalLabel?.stageLabel).toContain("...")
    // 元数据回写失败名单
    const setStateCall = mocks.bookAnalysis.setState.mock.calls.find(
      (c: [unknown]) => typeof c[0] === "function",
    )
    expect(setStateCall).toBeDefined()
    expect(mocks.bookAnalysis.completeTask).toHaveBeenCalledWith("task-1")
    expect(mocks.toast.success).toHaveBeenCalledWith("简单提取完成")
  })

  it("simple: streamChat onError 分支（_llmCall 收到非 Error → String(err)）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.streamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("net-down"))
      callbacks.onError(new RawStringError("raw-string"))
    })
    mocks.extractSingleProfile.mockImplementation(async ({ _llmCall }: { _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      return successProfile("林烬")
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: {} }]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    expect(errorSpy).toHaveBeenCalledWith("[simple-extract] LLM error:", "net-down")
    expect(errorSpy).toHaveBeenCalledWith("[simple-extract] LLM error:", "raw-string")
    expect(mocks.toast.success).toHaveBeenCalledWith("简单提取完成")
    errorSpy.mockRestore()
  })

  it("simple: 读取章节抛非 Error 值 → 降级『分析失败』", async () => {
    mocks.readFile.mockRejectedValue("raw-boom")
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "分析失败")
    expect(mocks.toast.error).toHaveBeenCalledWith("简单提取失败：分析失败")
  })

  it("simple: 提取循环中途 abort → 用户取消静默退出", async () => {
    const data = makeChapterSelectionData()
    mocks.extractSingleProfile.mockImplementation(async ({ _llmCall }: SingleProfileInput) => {
      // 第一次调用即中止 → 下一轮循环命中 abort 检查抛『用户取消』
      data.abortController.abort()
      await _llmCall?.("prompt")
      return successProfile("林烬")
    })
    const { result } = renderExtractionHook({ chapterSelectionData: data })
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    expect(mocks.bookAnalysis.errorTask).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
    expect(mocks.bookAnalysis.updateTaskCharacters).not.toHaveBeenCalled()
  })

  it("simple: 非网络失败（2 个）→ 『提取出错』标签 + resumeHint + 无省略号", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    const two: RecognizedCharacter[] = [
      { id: "r1", name: "甲", aliases: [], appearances: 1, chapterIndices: [0], importanceScore: 50, category: "主角", sourceBook: "长夜书" },
      { id: "r2", name: "乙", aliases: [], appearances: 1, chapterIndices: [0], importanceScore: 50, category: "配角", sourceBook: "长夜书" },
    ]
    mocks.extractSingleProfile.mockImplementation(async ({ character, _llmCall }: { character: { name: string }; _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      return errorProfile(character.name)
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: {} }]
    const { result } = renderExtractionHook({
      recognizedCharacters: two,
      selectedCharacterIds: ["r1", "r2"],
    })

    await act(async () => {
      await result.current.handleSimpleExtract()
    })

    const partialProgress = mocks.bookAnalysis.updateTaskProgress.mock.calls
      .map((c) => c[1])
      .find((p) => p.simpleExtractionStatus === "partial")
    expect(partialProgress?.stageLabel).toContain("提取出错")
    expect(partialProgress?.stageLabel).toContain("成功 0/2")
    expect(partialProgress?.stageLabel).toContain("失败 2 个：甲、乙")
    expect(partialProgress?.stageLabel).toContain("点击任务卡")
    expect(partialProgress?.stageLabel).not.toContain("...")
    // errorKindLabel=提取出错 → result.error 带标签
    expect(mocks.bookAnalysis.updateTaskCharacters).toHaveBeenCalledWith(
      "task-1",
      expect.arrayContaining([expect.objectContaining({ personality: "克制", speechStyle: "短句" })]),
    )
  })

  it("simple: 角色无出场章节（chapterIndices 为空）→ first/lastAppearance 兜底为 1", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: {} }]
    const solo: RecognizedCharacter[] = [
      { id: "r9", name: "孤影", aliases: [], appearances: 1, chapterIndices: [], importanceScore: 10, category: "次要", sourceBook: "长夜书" },
    ]
    const { result } = renderExtractionHook({ recognizedCharacters: solo, selectedCharacterIds: ["r9"] })
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    const chars = mocks.bookAnalysis.updateTaskCharacters.mock.calls[0][1] as ExtractedCharacter[]
    expect(chars[0].firstAppearance).toBe(1)
    expect(chars[0].lastAppearance).toBe(1)
  })

  it("simple: 提取引擎返回的角色名与勾选名不一致 → profile 缺失时 personality/speechStyle 兜底为空串", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    mocks.extractSingleProfile.mockImplementation(async ({ character, _llmCall }: { character: { name: string }; _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      return { name: `归一化-${character.name}`, profile, error: undefined, errorKind: undefined }
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: {} }]
    const { result } = renderExtractionHook({ selectedCharacterIds: ["r1", "r2", "r3"] })
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    const chars = mocks.bookAnalysis.updateTaskCharacters.mock.calls[0][1] as ExtractedCharacter[]
    // 名字不匹配 → profile undefined → ?? "" 兜底
    expect(chars[0].personality).toBe("")
    expect(chars[0].speechStyle).toBe("")
  })

  it("simple: 未配置 LLM → 抛错 → errorTask + toast.error", async () => {
    mocks.wiki.llmConfig = null
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "未配置 LLM，请先在设置中配置 LLM 后再提取")
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("未配置 LLM"))
  })

  it("simple: 用户取消（abort）时静默退出", async () => {
    const data = makeChapterSelectionData()
    data.abortController.abort()
    const { result } = renderExtractionHook({ chapterSelectionData: data })
    await act(async () => {
      await result.current.handleSimpleExtract()
    })
    expect(mocks.bookAnalysis.errorTask).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  // ── handleResumeFailedExtraction ──────────────────────────────────────────────

  it("resume: 任务不存在/无失败名单/失败角色为空/characters 字段缺失时直接返回", async () => {
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("missing")
    })
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: {} }]
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    mocks.bookAnalysis.tasks = [
      { id: "task-1", metadata: { failedCharacterNames: ["林烬"] }, characters: [] },
    ]
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    // characters 字段缺失 → `?? []` 兜底 → 失败角色为空 → 提前返回
    mocks.bookAnalysis.tasks = [{ id: "task-1", metadata: { failedCharacterNames: ["林烬"] } }]
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(mocks.bookAnalysis.updateTaskProgress).not.toHaveBeenCalled()
    expect(mocks.extractSingleProfile).not.toHaveBeenCalled()
  })

  it("resume: 未配置 LLM → alert 提示", async () => {
    mocks.wiki.llmConfig = null
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.bookAnalysis.tasks = [
      { id: "task-1", metadata: { failedCharacterNames: ["林烬"] }, characters: deepCharacters },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(alertSpy).toHaveBeenCalledWith("未配置 LLM，请先在设置中配置")
    alertSpy.mockRestore()
  })

  it("resume: 无 sourceBook → alert 提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.bookAnalysis.tasks = [
      { id: "task-1", metadata: { failedCharacterNames: ["林烬"] }, characters: deepCharacters },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(alertSpy).toHaveBeenCalledWith("找不到原始作品路径，无法继续生成")
    alertSpy.mockRestore()
  })

  it("resume: 读取原始章节失败 → alert 提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.readFile.mockRejectedValue(new Error("no file"))
    mocks.bookAnalysis.tasks = [
      { id: "task-1", metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" }, characters: deepCharacters },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(alertSpy).toHaveBeenCalledWith("无法读取原始章节内容，请重新发起提取")
    alertSpy.mockRestore()
  })

  it("resume: 成功/失败混合 → 更新角色、回写 stillFailed、partial 状态、重生成技能", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("样本")
      handlers.onDone()
    })
    // 3 个失败角色：主角成功、配角失败、次要成功 → 覆盖 category 三路映射
    const taskChars: ExtractedCharacter[] = [
      { id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
      { id: "r2", name: "苏遥", aliases: [], importance: 7, category: "supporting", firstAppearance: 1, lastAppearance: 1, appearanceCount: 2, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
      { id: "r3", name: "路人甲", aliases: [], importance: 3, category: "minor", firstAppearance: 1, lastAppearance: 1, appearanceCount: 1, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
    ]
    mocks.extractSingleProfile.mockImplementation(async ({ character, _llmCall }: { character: { name: string }; _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      if (character.name === "苏遥") return errorProfile("苏遥")
      return successProfile(character.name)
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([{ id: "s", characterId: "r1", characterName: "林烬", skillContent: "# x", sourceBook: "长夜书", chapterRange: ["1"], createdAt: 1 }])
    // 含一个不匹配 id 的任务 → setState 映射时走 `: t` 分支（真实多任务场景）
    mocks.bookAnalysis.tasks = [
      { id: "other-task", metadata: {} },
      { id: "task-1", metadata: { failedCharacterNames: ["林烬", "苏遥", "路人甲"], sourceBook: "/books/b1" }, characters: taskChars },
    ]
    const { result } = renderExtractionHook()

    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })

    // 成功 2 / 仍失败 1
    const updated = mocks.bookAnalysis.updateTaskCharacters.mock.calls[0][1] as ExtractedCharacter[]
    expect(updated.find((c) => c.id === "r1")?.personality).toBe("克制")
    expect(updated.find((c) => c.id === "r2")?.personality).toBe("旧")
    expect(updated.find((c) => c.id === "r3")?.personality).toBe("克制")
    const partialProgress = mocks.bookAnalysis.updateTaskProgress.mock.calls
      .map((c) => c[1])
      .find((p) => p.simpleExtractionStatus === "partial")
    expect(partialProgress?.stageLabel).toContain("成功 2")
    expect(partialProgress?.stageLabel).toContain("仍失败 1")
    // stillFailed 回写 metadata
    expect(mocks.bookAnalysis.setState).toHaveBeenCalled()
    // 技能重生成
    expect(mocks.generateSkillsForCharacters).toHaveBeenCalledTimes(1)
    expect(mocks.bookAnalysis.updateTaskSkills).toHaveBeenCalledWith("task-1", expect.any(Array))
  })

  it("resume: streamChat onError 分支（resume LLM 网络失败日志）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.streamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("resume-net-down"))
    })
    mocks.extractSingleProfile.mockImplementation(async ({ _llmCall }: { _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      return successProfile("林烬")
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [
      {
        id: "task-1",
        metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" },
        characters: [
          { id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
        ],
      },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(errorSpy).toHaveBeenCalledWith("[resume] LLM error:", "resume-net-down")
    expect(mocks.bookAnalysis.updateTaskCharacters).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it("resume: aiChatModel 存在时走 resolveModelConfig 分支", async () => {
    mocks.wiki.aiChatModel = "openai/gpt-5"
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [
      {
        id: "task-1",
        metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" },
        characters: [
          // aliases: undefined 运行时触发 hook 的 `?? []` 兜底（非空断言仅用于表达“故意为 undefined”）
          { id: "r1", name: "林烬", aliases: undefined!, importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
        ],
      },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(mocks.resolveModelConfig).toHaveBeenCalledWith("openai/gpt-5", mocks.wiki.llmConfig, mocks.wiki.providerConfigs)
    // aliases undefined → ?? [] 兜底（aliases 数组传入 extractSingleProfile）
    const charArg = mocks.extractSingleProfile.mock.calls[0][0].character
    expect(charArg.aliases).toEqual([])
  })

  it("resume: streamChat onError 收到非 Error → String(err) 兜底", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.streamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new RawStringError("raw-string"))
    })
    mocks.extractSingleProfile.mockImplementation(async ({ _llmCall }: { _llmCall?: (p: string) => Promise<string> }) => {
      await _llmCall?.("prompt")
      return successProfile("林烬")
    })
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [
      {
        id: "task-1",
        metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" },
        characters: [
          { id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
        ],
      },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(errorSpy).toHaveBeenCalledWith("[resume] LLM error:", "raw-string")
    errorSpy.mockRestore()
  })

  it("resume: 技能重生成抛非 Error → String(e) 兜底", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    mocks.generateSkillsForCharacters.mockRejectedValue("raw-skill-fail")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.bookAnalysis.tasks = [
      {
        id: "task-1",
        metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" },
        characters: [
          { id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
        ],
      },
    ]
    const { result } = renderExtractionHook()
    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })
    expect(errorSpy).toHaveBeenCalledWith("[resume] regenerate skills failed:", "raw-skill-fail")
    errorSpy.mockRestore()
  })

  it("resume: 全部失败（4 个）→ 进度标签省略号、无技能重生成", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    const mk = (id: string, name: string): ExtractedCharacter => ({
      id, name, aliases: [], importance: 3, category: "minor", firstAppearance: 1, lastAppearance: 1, appearanceCount: 1,
      description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [],
    })
    const taskChars = [mk("r1", "甲"), mk("r2", "乙"), mk("r3", "丙"), mk("r4", "丁")]
    mocks.extractSingleProfile.mockImplementation(async ({ character }: { character: { name: string } }) =>
      errorProfile(character.name),
    )
    mocks.bookAnalysis.tasks = [
      { id: "task-1", metadata: { failedCharacterNames: ["甲", "乙", "丙", "丁"], sourceBook: "/books/b1" }, characters: taskChars },
    ]
    const { result } = renderExtractionHook()

    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })

    const partialProgress = mocks.bookAnalysis.updateTaskProgress.mock.calls
      .map((c) => c[1])
      .find((p) => p.simpleExtractionStatus === "partial")
    expect(partialProgress?.stageLabel).toContain("...")
    expect(mocks.generateSkillsForCharacters).not.toHaveBeenCalled()
  })

  it("resume: 全部成功 → 进度 done、重生成技能", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    const taskChars: ExtractedCharacter[] = [
      { id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
    ]
    mocks.generateSkillsForCharacters.mockResolvedValue([])
    mocks.bookAnalysis.tasks = [
      { id: "task-1", metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" }, characters: taskChars },
    ]
    const { result } = renderExtractionHook()

    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })

    const doneProgress = mocks.bookAnalysis.updateTaskProgress.mock.calls
      .map((c) => c[1])
      .find((p) => p.simpleExtractionStatus === "done")
    expect(doneProgress?.stageLabel).toContain("全部完成")
    expect(mocks.generateSkillsForCharacters).toHaveBeenCalledTimes(1)
    expect(mocks.bookAnalysis.updateTaskSkills).toHaveBeenCalledTimes(1)
  })

  it("resume: 技能重生成抛错 → console.error 且不中断", async () => {
    mocks.streamChat.mockImplementation(async (_cfg: unknown, _msgs: unknown, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("x")
      handlers.onDone()
    })
    mocks.generateSkillsForCharacters.mockRejectedValue(new Error("llm-down"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.bookAnalysis.tasks = [
      {
        id: "task-1",
        metadata: { failedCharacterNames: ["林烬"], sourceBook: "/books/b1" },
        characters: [
          { id: "r1", name: "林烬", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "", personality: "旧", speechStyle: "旧", relationships: [], keyEvents: [] },
        ],
      },
    ]
    const { result } = renderExtractionHook()

    await act(async () => {
      await result.current.handleResumeFailedExtraction("task-1")
    })

    expect(errorSpy).toHaveBeenCalledWith("[resume] regenerate skills failed:", "llm-down")
    errorSpy.mockRestore()
  })
})
