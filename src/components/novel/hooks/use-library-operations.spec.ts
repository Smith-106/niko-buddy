// @vitest-environment jsdom
/**
 * useLibraryOperations — 文风提取/切换、Skill 入灵魂库、角色绑定、作品删除、重提角色全分支覆盖。
 */
import { renderHook, act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BookAnalysisLibraryBook, BookAnalysisLibraryState } from "@/lib/novel/book-analysis/library-state"
import type { ChapterSelectionData } from "./use-character-extraction"
import { useLibraryOperations } from "./use-library-operations"

const mocks = vi.hoisted(() => {
  const bookAnalysis: {
    startTask: ReturnType<typeof vi.fn>
    updateTaskBookData: ReturnType<typeof vi.fn>
    updateTaskProgress: ReturnType<typeof vi.fn>
    updateTaskStyleProfile: ReturnType<typeof vi.fn>
    updateTaskMetadata: ReturnType<typeof vi.fn>
    completeTask: ReturnType<typeof vi.fn>
    errorTask: ReturnType<typeof vi.fn>
    triggerSidebarRefresh: ReturnType<typeof vi.fn>
  } = {
    startTask: vi.fn(() => "task-1"),
    updateTaskBookData: vi.fn(),
    updateTaskProgress: vi.fn(),
    updateTaskStyleProfile: vi.fn(),
    updateTaskMetadata: vi.fn(),
    completeTask: vi.fn(),
    errorTask: vi.fn(),
    triggerSidebarRefresh: vi.fn(),
  }
  return {
    bookAnalysis,
    loadBookAnalysisLibraryState: vi.fn(async () => ({ books: [], enabledStyle: null, bindings: [] })),
    analyzeWritingStyle: vi.fn(),
    importBookAnalysisSkillsAsAuras: vi.fn(),
    deleteOrphanAurasForBook: vi.fn(async () => 0),
    bindCharacterAura: vi.fn(async () => {}),
    listBindableNovelCharacters: vi.fn(async () => []),
    setEnabledWritingStyle: vi.fn(async () => {}),
    upsertWritingStylePreset: vi.fn(async (p: unknown) => ({ id: "preset-1", ...(p as object) })),
    refreshProjectState: vi.fn(async () => {}),
    readFile: vi.fn(),
    listDirectory: vi.fn(),
    deleteFile: vi.fn(async () => {}),
    joinPath: vi.fn((...parts: string[]) => parts.join("/")),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  }
})

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: { getState: () => mocks.bookAnalysis },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign((s: (x: unknown) => unknown) => s({}), { getState: () => ({ llmConfig: mocks.llmConfig }) }),
}))

vi.mock("@/lib/novel/book-analysis/library-state", () => ({
  loadBookAnalysisLibraryState: mocks.loadBookAnalysisLibraryState,
}))

vi.mock("@/lib/novel/book-analysis/style-extraction-engine", () => ({
  analyzeWritingStyle: mocks.analyzeWritingStyle,
}))

vi.mock("@/lib/novel/book-analysis/aura-adapter", () => ({
  importBookAnalysisSkillsAsAuras: mocks.importBookAnalysisSkillsAsAuras,
}))

vi.mock("@/lib/novel/book-analysis/aura-cleanup", () => ({
  deleteOrphanAurasForBook: mocks.deleteOrphanAurasForBook,
}))

vi.mock("@/lib/novel/character-aura", () => ({
  bindCharacterAura: mocks.bindCharacterAura,
  listBindableNovelCharacters: mocks.listBindableNovelCharacters,
}))

vi.mock("@/lib/novel/writing-style-store", () => ({
  setEnabledWritingStyle: mocks.setEnabledWritingStyle,
  upsertWritingStylePreset: mocks.upsertWritingStylePreset,
}))

vi.mock("@/lib/project-refresh", () => ({
  refreshProjectState: mocks.refreshProjectState,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  listDirectory: mocks.listDirectory,
  deleteFile: mocks.deleteFile,
}))

vi.mock("@/lib/path-utils", () => ({
  joinPath: mocks.joinPath,
}))

vi.mock("@/lib/toast", () => ({
  toast: mocks.toast,
}))

// ── fixtures ────────────────────────────────────────────────────────────────────

const styleProfile = {
  schemaVersion: 1,
  generatedAt: 1,
  sampledChapterIds: ["c1"],
  narrativeDensity: "高",
  descriptionWeight: "中",
  emotionRendering: "克制",
  sentenceStyle: "短句",
  rhetoricDensity: "低",
  transitionStyle: "平铺",
  narrativeVoice: "第三人称",
  dialogueStyle: "简洁",
  thematicHabits: "复仇",
  constitution: "硬约束",
  samples: ["样本"],
}

const libraryBook: BookAnalysisLibraryBook = {
  id: "book-1",
  path: "/books/b1",
  metadata: { title: "长夜书", totalChapters: 2, totalWords: 1800, sourceType: "file", createdAt: 1, updatedAt: 2 },
  recognizedCharacters: [],
  characters: [
    {
      id: "char-1", name: "林烬", aliases: [], importance: 9, category: "protagonist",
      firstAppearance: 1, lastAppearance: 2, appearanceCount: 3, description: "",
      personality: "克制", speechStyle: "短句", relationships: [], keyEvents: [],
    },
  ],
  skills: [
    { id: "skill-1", characterId: "char-1", characterName: "林烬", skillContent: "# 林烬", sourceBook: "长夜书", chapterRange: ["1"], createdAt: 3 },
  ],
  styleProfile,
  styleStatus: "extracted",
  boundAurasCount: 0,
  addedAuraCharacterIds: [],
}

const llmConfig = { provider: "openai", apiKey: "key-1", model: "gpt-4o" }

function makeParams(overrides: Partial<Parameters<typeof useLibraryOperations>[0]> = {}) {
  const props = {
    currentProjectPath: "/proj",
    selectedLibraryBook: libraryBook,
    libraryState: { books: [libraryBook], enabledStyle: null, bindings: [] } as BookAnalysisLibraryState,
    setLibraryState: vi.fn(),
    setSelectedBookId: vi.fn(),
    setSelectedCharacterId: vi.fn(),
    setChapterSelectionData: vi.fn(),
    llmConfig,
    startTask: vi.fn(() => "task-1"),
    ...overrides,
  }
  const rendered = renderHook(() => useLibraryOperations(props))
  return { ...rendered, props }
}

describe("useLibraryOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadBookAnalysisLibraryState.mockResolvedValue({ books: [libraryBook], enabledStyle: null, bindings: [] })
    mocks.analyzeWritingStyle.mockImplementation(async (_p: unknown, _c: unknown, opts: { signal?: AbortSignal; onProgress?: (msg: string) => void }) => {
      opts.onProgress?.("正在分析作品文风…")
      return styleProfile
    })
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([])
    mocks.listDirectory.mockResolvedValue([])
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬"])
    mocks.readFile.mockResolvedValue("---\ntitle: 第一章\norder: 1\nwordCount: 100\n---\n正文内容正文内容")
    mocks.deleteOrphanAurasForBook.mockResolvedValue(0)
    mocks.deleteFile.mockResolvedValue(undefined)
    mocks.setEnabledWritingStyle.mockResolvedValue(undefined)
    mocks.upsertWritingStylePreset.mockImplementation(async (p: unknown) => ({ id: "preset-1", ...(p as object) }))
    mocks.bindCharacterAura.mockResolvedValue(undefined)
    mocks.refreshProjectState.mockResolvedValue(undefined)
    mocks.bookAnalysis.startTask.mockReturnValue("task-1")
  })

  // ── reloadLibraryState ─────────────────────────────────────────────────────────

  it("reload: 无项目路径时清空 libraryState 并清空选中", async () => {
    const { result, props } = makeParams({ currentProjectPath: null })
    await act(async () => {
      await result.current.reloadLibraryState()
    })
    expect(props.setLibraryState).toHaveBeenCalledWith({ books: [], enabledStyle: null, bindings: [] })
    expect(props.setSelectedBookId).toHaveBeenCalledWith(null)
  })

  it("reload: 保留仍在库中的选中书目", async () => {
    const { result, props } = makeParams({ selectedLibraryBook: null })
    await act(async () => {
      await result.current.reloadLibraryState()
    })
    expect(props.setLibraryState).toHaveBeenCalledWith({ books: [libraryBook], enabledStyle: null, bindings: [] })
    expect(props.setSelectedBookId).toHaveBeenCalledWith(expect.any(Function))
    const updater = props.setSelectedBookId.mock.calls[0][0] as (current: string | null) => string | null
    expect(updater("book-1")).toBe("book-1")
  })

  it("reload: 选中书已不存在时回退到第一本，库为空时回退 null", async () => {
    const { result, props } = makeParams({ selectedLibraryBook: null })
    await act(async () => {
      await result.current.reloadLibraryState()
    })
    const updater = props.setSelectedBookId.mock.calls[0][0] as (current: string | null) => string | null
    expect(updater("gone")).toBe("book-1")
    mocks.loadBookAnalysisLibraryState.mockResolvedValue({ books: [], enabledStyle: null, bindings: [] })
    await act(async () => {
      await result.current.reloadLibraryState()
    })
    const updater2 = props.setSelectedBookId.mock.calls[1][0] as (current: string | null) => string | null
    expect(updater2("book-1")).toBeNull()
  })

  // ── handleLibraryExtractStyle ──────────────────────────────────────────────────

  it("style: 前置条件不满足/正在提取时直接返回", async () => {
    const { result } = makeParams({ currentProjectPath: null })
    await act(async () => { await result.current.handleLibraryExtractStyle() })
    const { result: r2 } = makeParams({ selectedLibraryBook: null })
    await act(async () => { await r2.current.handleLibraryExtractStyle() })
    expect(mocks.analyzeWritingStyle).not.toHaveBeenCalled()
  })

  it("style: 未配置 apiKey → toast.error", async () => {
    const { result } = makeParams({ llmConfig: { ...llmConfig, apiKey: "" } })
    await act(async () => { await result.current.handleLibraryExtractStyle() })
    expect(mocks.toast.error).toHaveBeenCalledWith("未配置可用模型，请先在设置中配置 LLM。")
    expect(mocks.analyzeWritingStyle).not.toHaveBeenCalled()
  })

  it("style: 成功路径（进度映射 + 画像保存 + 完成 + 刷新）", async () => {
    const { result, props } = makeParams()
    await act(async () => {
      await result.current.handleLibraryExtractStyle()
    })
    expect(mocks.bookAnalysis.startTask).toHaveBeenCalledWith("/proj", { sourceType: "file", sourcePath: "/books/b1", selectedChapters: [] }, expect.any(AbortController))
    expect(mocks.bookAnalysis.updateTaskBookData).toHaveBeenCalledWith("task-1", "book-1", [])
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith("task-1", { stage: "extracting_style", stageLabel: "提取文风", percentage: 0 })
    // 进度回调：命中的 key（50）→ 更新 percentage
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith("task-1", expect.objectContaining({ percentage: 50, currentItem: "正在分析作品文风…" }))
    expect(mocks.bookAnalysis.updateTaskStyleProfile).toHaveBeenCalledWith("task-1", styleProfile)
    expect(mocks.bookAnalysis.updateTaskProgress).toHaveBeenCalledWith("task-1", { stage: "extracting_style", stageLabel: "提取文风", percentage: 100, currentItem: "完成" })
    expect(mocks.bookAnalysis.completeTask).toHaveBeenCalledWith("task-1")
    expect(mocks.toast.success).toHaveBeenCalledWith("已提取作品文风。")
    expect(mocks.bookAnalysis.triggerSidebarRefresh).toHaveBeenCalledTimes(1)
    expect(result.current.styleExtracting).toBe(false)
  })

  it("style: 进度消息不匹配任何 key 时跳过进度更新", async () => {
    mocks.analyzeWritingStyle.mockImplementation(async (_p: unknown, _c: unknown, opts: { onProgress?: (msg: string) => void }) => {
      opts.onProgress?.("某条未知消息")
      return styleProfile
    })
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryExtractStyle() })
    // 未知消息不产生 percentage 更新（仍完成流程）
    expect(mocks.bookAnalysis.completeTask).toHaveBeenCalledWith("task-1")
    expect(result.current.styleExtracting).toBe(false)
  })

  it("style: 提取失败（含非 Error）→ errorTask + toast.error", async () => {
    mocks.analyzeWritingStyle.mockRejectedValue(new Error("provider down"))
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryExtractStyle() })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "provider down")
    expect(mocks.toast.error).toHaveBeenCalledWith("提取文风失败：provider down")
    mocks.analyzeWritingStyle.mockRejectedValue("raw-boom")
    await act(async () => { await result.current.handleLibraryExtractStyle() })
    expect(mocks.bookAnalysis.errorTask).toHaveBeenCalledWith("task-1", "raw-boom")
    expect(mocks.toast.error).toHaveBeenCalledWith("提取文风失败：raw-boom")
    expect(result.current.styleExtracting).toBe(false)
  })

  // ── handleLibraryToggleStyle ───────────────────────────────────────────────────

  it("toggle: 无项目/无 styleProfile 时直接返回", async () => {
    const { result } = makeParams({ currentProjectPath: null })
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    const { result: r2 } = makeParams({ selectedLibraryBook: { ...libraryBook, styleProfile: undefined } })
    await act(async () => { await r2.current.handleLibraryToggleStyle() })
    expect(mocks.setEnabledWritingStyle).not.toHaveBeenCalled()
  })

  it("toggle: 当前已启用该书文风 → 取消启用", async () => {
    const { result } = makeParams({
      libraryState: {
        books: [libraryBook], bindings: [],
        enabledStyle: { id: "p1", name: "长夜书 · 文风", sourceBook: "长夜书", profile: styleProfile, createdAt: 1, updatedAt: 2 },
      },
    })
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    expect(mocks.setEnabledWritingStyle).toHaveBeenCalledWith("/proj", null)
    expect(mocks.toast.success).toHaveBeenCalledWith("已取消启用该文风。")
  })

  it("toggle: 启用新文风（无既有文风 → 直接启用）", async () => {
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    expect(mocks.upsertWritingStylePreset).toHaveBeenCalledWith("/proj", {
      name: "长夜书 · 文风",
      sourceBook: "长夜书",
      profile: styleProfile,
    })
    expect(mocks.setEnabledWritingStyle).toHaveBeenCalledWith("/proj", "preset-1")
    expect(mocks.toast.success).toHaveBeenCalledWith("已启用该文风，生成时会按此文风写作。")
  })

  it("toggle: 切换已有其他文风 → confirm 通过后启用", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { result } = makeParams({
      libraryState: {
        books: [libraryBook], bindings: [],
        enabledStyle: { id: "p0", name: "另一本 · 文风", sourceBook: "另一本", profile: styleProfile, createdAt: 1, updatedAt: 2 },
      },
    })
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.setEnabledWritingStyle).toHaveBeenCalledWith("/proj", "preset-1")
    confirmSpy.mockRestore()
  })

  it("toggle: 切换时 confirm 取消 → 不执行", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { result } = makeParams({
      libraryState: {
        books: [libraryBook], bindings: [],
        enabledStyle: { id: "p0", name: "另一本 · 文风", sourceBook: "另一本", profile: styleProfile, createdAt: 1, updatedAt: 2 },
      },
    })
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.setEnabledWritingStyle).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("toggle: 操作抛错（含非 Error）→ toast.error", async () => {
    mocks.setEnabledWritingStyle.mockRejectedValue(new Error("io"))
    const { result } = makeParams({
      libraryState: {
        books: [libraryBook], bindings: [],
        enabledStyle: { id: "p1", name: "长夜书 · 文风", sourceBook: "长夜书", profile: styleProfile, createdAt: 1, updatedAt: 2 },
      },
    })
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    expect(mocks.toast.error).toHaveBeenCalledWith("操作失败：io")
    mocks.setEnabledWritingStyle.mockRejectedValue("raw-io")
    await act(async () => { await result.current.handleLibraryToggleStyle() })
    expect(mocks.toast.error).toHaveBeenCalledWith("操作失败：raw-io")
  })

  // ── handleLibraryAddSkillsToSoul ──────────────────────────────────────────────

  it("soul: 前置条件不满足时直接返回", async () => {
    const { result } = makeParams({ currentProjectPath: null })
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.importBookAnalysisSkillsAsAuras).not.toHaveBeenCalled()
  })

  it("soul: 找不到 skill/角色 → toast.info 提示重新提取", async () => {
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("missing") })
    expect(mocks.toast.info).toHaveBeenCalledWith("未找到当前角色的 Skill，请重新提取角色。")
  })

  it("soul: 角色已加入灵魂库 → toast.info 无需重复", async () => {
    const { result } = makeParams({
      selectedLibraryBook: { ...libraryBook, addedAuraCharacterIds: ["char-1"] },
    })
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.toast.info).toHaveBeenCalledWith("「林烬」已加入自定义灵魂库，无需重复加入。")
    expect(mocks.importBookAnalysisSkillsAsAuras).not.toHaveBeenCalled()
  })

  it("soul: 作品无 skills / 无角色数据（skill 存在但字符缺失）→ 先触发未找到分支", async () => {
    // 注：skills.length===0 与 characters.length===0 两分支为防御性代码，
    // 因 selectedSkill/selectedCharacter 先查后判，真实输入不可达（见不可达清单）。
    const noChars = makeParams({ selectedLibraryBook: { ...libraryBook, characters: [] } })
    await act(async () => { await noChars.result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.toast.info).toHaveBeenCalledWith("未找到当前角色的 Skill，请重新提取角色。")
  })

  it("soul: 导入为空（已存在）→ toast.info；非空 → refresh + success", async () => {
    const { result, props } = makeParams()
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([])
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.toast.info).toHaveBeenCalledWith("「林烬」已加入自定义灵魂库，无需重复加入。")

    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { id: "aura-1", characterName: "林烬", auraId: "aura-1" },
    ])
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/proj")
    expect(mocks.toast.success).toHaveBeenCalledWith("已将「林烬」加入自定义灵魂库。")
    // imported[0] 无 characterName → ?? selectedCharacter.name 兜底
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([{ id: "aura-2", auraId: "aura-2" }])
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.toast.success).toHaveBeenCalledWith("已将「林烬」加入自定义灵魂库。")
    // 两次都触发 reloadLibraryState
    expect(props.setLibraryState).toHaveBeenCalled()
  })

  it("soul: 导入抛错（含非 Error）→ console.error + toast.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.importBookAnalysisSkillsAsAuras.mockRejectedValue(new Error("adapter-fail"))
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(errorSpy).toHaveBeenCalledWith("[加入灵魂库失败]", "adapter-fail")
    expect(mocks.toast.error).toHaveBeenCalledWith("添加失败：adapter-fail")
    mocks.importBookAnalysisSkillsAsAuras.mockRejectedValue("raw-fail")
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(errorSpy).toHaveBeenCalledWith("[加入灵魂库失败]", "raw-fail")
    expect(mocks.toast.error).toHaveBeenCalledWith("添加失败：raw-fail")
    errorSpy.mockRestore()
  })

  // ── handleLibraryBindCharacter ────────────────────────────────────────────────

  it("bind: skill 的 characterId 不匹配但 characterName 匹配 → 按名称找到角色", async () => {
    const { result } = makeParams({
      selectedLibraryBook: {
        ...libraryBook,
        skills: [{ id: "skill-1", characterId: "stale-id", characterName: "林烬", skillContent: "# 林烬", sourceBook: "长夜书", chapterRange: ["1"], createdAt: 3 }],
      },
      libraryState: {
        books: [libraryBook], enabledStyle: null,
        bindings: [{ characterName: "林烬", auraId: "aura-1", auraName: "林烬" }],
      },
    })
    await act(async () => { await result.current.handleLibraryAddSkillsToSoul("skill-1") })
    expect(mocks.importBookAnalysisSkillsAsAuras).toHaveBeenCalled()
    expect(mocks.toast.info).not.toHaveBeenCalledWith("未找到当前角色的 Skill，请重新提取角色。")
  })

  it("bind: 无项目/无书/无角色时直接返回", async () => {
    const { result } = makeParams({ currentProjectPath: null })
    await act(async () => { await result.current.handleLibraryBindCharacter("char-1") })
    const { result: r2 } = makeParams({ selectedLibraryBook: null })
    await act(async () => { await r2.current.handleLibraryBindCharacter("char-1") })
    const { result: r3 } = makeParams()
    await act(async () => { await r3.current.handleLibraryBindCharacter("missing-char") })
    expect(mocks.bindCharacterAura).not.toHaveBeenCalled()
    expect(mocks.toast.info).not.toHaveBeenCalled()
  })

  it("bind: 无可绑定人物 → toast.info", async () => {
    mocks.listBindableNovelCharacters.mockResolvedValue([])
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryBindCharacter("char-1") })
    expect(mocks.toast.info).toHaveBeenCalledWith("请先在大纲中添加人物小传或人物设定，再绑定角色 Skill。")
  })

  it("bind: 无对应 aura → toast.info 先加入灵魂库", async () => {
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryBindCharacter("char-1") })
    expect(mocks.toast.info).toHaveBeenCalledWith("请先将该角色 Skill 加入自定义灵魂库，再绑定到小说人物。")
  })

  it("bind: 成功 → 绑定 + 刷新 + toast.success + reload", async () => {
    const { result, props } = makeParams({
      libraryState: {
        books: [libraryBook], enabledStyle: null,
        bindings: [{ characterName: "林烬", auraId: "aura-1", auraName: "林烬" }],
      },
    })
    await act(async () => { await result.current.handleLibraryBindCharacter("char-1") })
    expect(mocks.bindCharacterAura).toHaveBeenCalledWith("/proj", { characterName: "林烬", auraId: "aura-1" })
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/proj")
    expect(mocks.toast.success).toHaveBeenCalledWith("已将「林烬」绑定到小说人物「林烬」。")
    expect(props.setLibraryState).toHaveBeenCalled()
  })

  // ── handleLibraryDeleteBook ────────────────────────────────────────────────────

  it("delete: 无项目/书不存在时直接返回", async () => {
    const { result } = makeParams({ currentProjectPath: null })
    await act(async () => { await result.current.handleLibraryDeleteBook("book-1", "book-1") })
    const { result: r2 } = makeParams({ libraryState: { books: [], enabledStyle: null, bindings: [] } })
    await act(async () => { await r2.current.handleLibraryDeleteBook("book-1", "book-1") })
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("delete: 用户取消确认 → 不删除", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryDeleteBook("book-1", "book-1") })
    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("delete: 成功且清理孤儿 > 0 → 提示清理数量；选中即清空选中", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    mocks.deleteOrphanAurasForBook.mockResolvedValue(3)
    const { result, props } = makeParams()
    await act(async () => { await result.current.handleLibraryDeleteBook("book-1", "book-1") })
    confirmSpy.mockRestore()
    expect(mocks.deleteFile).toHaveBeenCalledWith("/books/b1")
    expect(mocks.deleteOrphanAurasForBook).toHaveBeenCalledWith("/proj", "长夜书")
    expect(props.setSelectedBookId).toHaveBeenCalledWith(null)
    expect(props.setSelectedCharacterId).toHaveBeenCalledWith(null)
    expect(mocks.toast.success).toHaveBeenCalledWith("已删除作品「长夜书」，并清理了 3 个孤儿灵魂")
    expect(props.setLibraryState).toHaveBeenCalled()
  })

  it("delete: 清理为 0 且删除的不是选中书 → 简化提示、不清空选中", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { result, props } = makeParams()
    await act(async () => { await result.current.handleLibraryDeleteBook("book-1", "other-book") })
    confirmSpy.mockRestore()
    expect(mocks.toast.success).toHaveBeenCalledWith("已删除作品「长夜书」")
    // 未直接清空选中（reload 的 updater 仍会调用，但不会传 null）
    expect(props.setSelectedBookId).not.toHaveBeenCalledWith(null)
    expect(props.setSelectedCharacterId).not.toHaveBeenCalled()
  })

  it("delete: deleteOrphanAurasForBook 抛错被吞（.catch(() => 0)）", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    mocks.deleteOrphanAurasForBook.mockRejectedValue(new Error("cleanup-fail"))
    const { result, props } = makeParams()
    await act(async () => { await result.current.handleLibraryDeleteBook("book-1", "book-1") })
    confirmSpy.mockRestore()
    expect(mocks.toast.success).toHaveBeenCalledWith("已删除作品「长夜书」")
    expect(props.setSelectedBookId).toHaveBeenCalledWith(null)
  })

  it("delete: 删除抛错 → console.error + toast.error", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.deleteFile.mockRejectedValue(new Error("perm"))
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryDeleteBook("book-1", "book-1") })
    confirmSpy.mockRestore()
    expect(errorSpy).toHaveBeenCalledWith("Failed to delete book:", expect.any(Error))
    expect(mocks.toast.error).toHaveBeenCalledWith("删除作品失败，请稍后重试")
    errorSpy.mockRestore()
  })

  // ── handleLibraryReextractCharacters ──────────────────────────────────────────

  it("reextract: 无项目/无书时直接返回；无 llmConfig → toast.error", async () => {
    const { result } = makeParams({ currentProjectPath: null })
    await act(async () => { await result.current.handleLibraryReextractCharacters() })
    const { result: r2 } = makeParams({ llmConfig: null })
    await act(async () => { await r2.current.handleLibraryReextractCharacters() })
    expect(mocks.toast.error).toHaveBeenCalledWith("未配置可用模型，请先在设置中配置 LLM。")
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("reextract: 无章节文件 → toast.error", async () => {
    mocks.listDirectory.mockResolvedValue([])
    const { result } = makeParams()
    await act(async () => { await result.current.handleLibraryReextractCharacters() })
    expect(mocks.toast.error).toHaveBeenCalledWith("未找到章节文件，无法重新提取。")
  })

  it("reextract: 成功 → 解析 frontmatter（含 wordCount 缺失/无 fm/读取失败分支）+ 打开章节选择", async () => {
    const chaptersDir = "/books/b1/chapters"
    mocks.listDirectory.mockResolvedValue([
      { name: "c1.md", path: `${chaptersDir}/c1.md`, is_dir: false },
      { name: "c2.md", path: `${chaptersDir}/c2.md`, is_dir: false },
      { name: "notes.txt", path: `${chaptersDir}/notes.txt`, is_dir: false },
      { name: "sub", path: `${chaptersDir}/sub`, is_dir: true },
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("c1.md")) return "---\ntitle: 第一章\norder: 2\nwordCount: 100\n---\n正文A"
      if (p.endsWith("c2.md")) return "---\ntitle: 第二章\norder: 1\n---\n正文B正文B" // 无 wordCount → body.length
      if (p.endsWith("notes.txt")) return "no frontmatter"
      throw new Error("no file") // 读取失败 → 默认值
    })
    const { result, props } = makeParams()
    await act(async () => {
      await result.current.handleLibraryReextractCharacters()
    })

    const selection = props.setChapterSelectionData.mock.calls[0][0] as ChapterSelectionData
    expect(selection.taskId).toBe("task-1")
    expect(selection.bookPath).toBe("/books/b1")
    expect(selection.depth).toBe("standard")
    expect(selection.selectedChapterIds).toEqual([])
    // 按 id 排序：c1, c2
    expect(selection.chapters.map((c) => c.id)).toEqual(["c1", "c2"])
    const [c1, c2] = selection.chapters
    expect(c1.title).toBe("第一章")
    expect(c1.order).toBe(2)
    expect(c1.wordCount).toBe(100)
    expect(c2.title).toBe("第二章")
    expect(c2.order).toBe(1)
    expect(c2.wordCount).toBe("正文B正文B".length)
    expect(mocks.bookAnalysis.updateTaskMetadata).toHaveBeenCalledWith("task-1", libraryBook.metadata)
    expect(mocks.bookAnalysis.updateTaskBookData).toHaveBeenCalledWith("task-1", "book-1", selection.chapters)
  })

  it("reextract: 无 frontmatter 章节 → 默认 title/order/wordCount；部分 fm 缺失 title/order → 保持默认", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "c1.md", path: "/books/b1/chapters/c1.md", is_dir: false },
      { name: "c2.md", path: "/books/b1/chapters/c2.md", is_dir: false },
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("c2.md")) return "---\nwordCount: 66\n---\n正文" // 有 fm 但无 title/order
      return "没有 frontmatter 的正文"
    })
    const { result, props } = makeParams()
    await act(async () => {
      await result.current.handleLibraryReextractCharacters()
    })
    const selection = props.setChapterSelectionData.mock.calls[0][0] as ChapterSelectionData
    const [c1, c2] = selection.chapters
    expect(c1).toMatchObject({ id: "c1", title: "c1", order: 0, wordCount: 0 })
    expect(c1.path).toBe("/books/b1/chapters/c1.md")
    expect(c2).toMatchObject({ id: "c2", title: "c2", order: 1, wordCount: 66 })
  })
})
