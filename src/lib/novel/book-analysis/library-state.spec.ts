import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Map<string, Array<{ name: string; path: string; is_dir: boolean }>>(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async (path: string) => mockFs.directories.get(path.replace(/\\/g, "/")) ?? []),
  readFile: vi.fn(async (path: string) => {
    const key = path.replace(/\\/g, "/")
    if (!mockFs.files.has(key)) throw new Error(`missing ${key}`)
    return mockFs.files.get(key)!
  }),
}))

vi.mock("@/lib/novel/writing-style-store", () => ({
  loadWritingStyleStore: vi.fn(async () => ({
    version: 1,
    enabledStyleId: "style-1",
    styles: [
      {
        id: "style-1",
        name: "凡人修仙传 · 文风",
        sourceBook: "凡人修仙传",
        profile: {
          schemaVersion: 1,
          generatedAt: 1,
          sampledChapterIds: ["ch-1"],
          narrativeDensity: "叙事密度中高",
          descriptionWeight: "",
          emotionRendering: "",
          sentenceStyle: "",
          rhetoricDensity: "",
          transitionStyle: "",
          narrativeVoice: "",
          dialogueStyle: "",
          thematicHabits: "",
          constitution: "1. 动作推进优先",
          samples: [],
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })),
}))

vi.mock("@/lib/novel/character-aura", () => ({
  loadCharacterAuraStore: vi.fn(async () => ({
    customAuras: [
      {
        id: "aura-hanli",
        builtIn: false,
        name: "韩立",
        category: "拆书角色",
        sourceNote: "来自拆书作品《凡人修仙传》的角色分析。",
        corpus: "",
        styleDescription: "",
        behaviorRules: "",
        boundaries: "",
        notes: "",
      },
    ],
    bindings: [{ characterName: "主角", auraId: "aura-hanli" }],
  })),
}))

import { loadBookAnalysisLibraryState, toBookAnalysisResult } from "./library-state"
import { listDirectory } from "@/commands/fs"
import { loadCharacterAuraStore } from "@/lib/novel/character-aura"

beforeEach(() => {
  mockFs.files.clear()
  mockFs.directories.clear()
})

function addBook(projectPath: string, bookId: string, title: string, withStyle: boolean) {
  const bookPath = `${projectPath}/book-analysis/${bookId}`
  mockFs.directories.set(`${projectPath}/book-analysis`, [
    ...(mockFs.directories.get(`${projectPath}/book-analysis`) ?? []),
    { name: bookId, path: bookPath, is_dir: true },
  ])
  mockFs.files.set(`${bookPath}/metadata.json`, JSON.stringify({
    title,
    author: "作者",
    totalChapters: 10,
    totalWords: 100000,
    sourceType: "file",
    createdAt: 1,
    updatedAt: 2,
  }))
  mockFs.directories.set(`${bookPath}/characters`, [
    { name: "hanli.json", path: `${bookPath}/characters/hanli.json`, is_dir: false },
  ])
  mockFs.files.set(`${bookPath}/characters/hanli.json`, JSON.stringify({
    id: "char-hanli",
    name: "韩立",
    aliases: [],
    importance: 9,
    category: "protagonist",
    firstAppearance: 1,
    lastAppearance: 10,
    appearanceCount: 10,
    description: "谨慎",
    personality: "隐忍",
    speechStyle: "少承诺",
    relationships: [],
    keyEvents: [],
    corpus: "",
  }))
  mockFs.directories.set(`${bookPath}/skills`, [
    { name: "韩立-skill.md", path: `${bookPath}/skills/韩立-skill.md`, is_dir: false },
  ])
  mockFs.files.set(`${bookPath}/skills/韩立-skill.md`, "# 韩立")
  if (withStyle) {
    mockFs.files.set(`${bookPath}/style-profile.json`, JSON.stringify({
      schemaVersion: 1,
      generatedAt: 1,
      sampledChapterIds: ["ch-1"],
      narrativeDensity: "叙事密度中高",
      descriptionWeight: "",
      emotionRendering: "",
      sentenceStyle: "",
      rhetoricDensity: "",
      transitionStyle: "",
      narrativeVoice: "",
      dialogueStyle: "",
      thematicHabits: "",
      constitution: "1. 动作推进优先",
      samples: [],
    }))
  }
}

describe("loadBookAnalysisLibraryState", () => {
  it("loads books with active style and binding summary", async () => {
    addBook("E:/Novel", "book-1", "凡人修仙传", true)
    addBook("E:/Novel", "book-2", "诡秘之主", false)

    const state = await loadBookAnalysisLibraryState("E:/Novel")

    expect(state.books).toHaveLength(2)
    expect(state.enabledStyle?.sourceBook).toBe("凡人修仙传")
    expect(state.books[0].styleStatus).toBe("enabled")
    expect(state.books[1].styleStatus).toBe("missing")
    expect(state.bindings).toEqual([{ characterName: "主角", auraId: "aura-hanli", auraName: "韩立" }])
    expect(state.books[0].boundAurasCount).toBe(1)
  })
})

describe("loadBookAnalysisLibraryState 分支覆盖", () => {
  const P = "E:/Novel"

  function seedCharacter(path: string, overrides: Record<string, unknown> = {}) {
    mockFs.files.set(path, JSON.stringify({
      id: "char-x", name: "韩立", aliases: [], importance: 9, category: "protagonist",
      firstAppearance: 1, lastAppearance: 2, appearanceCount: 2,
      description: "", personality: "", speechStyle: "", relationships: [], keyEvents: [], corpus: "",
      ...overrides,
    }))
  }

  function seedBasicBook(bookId: string, title: string, updatedAt = 2) {
    const bookPath = `${P}/book-analysis/${bookId}`
    mockFs.directories.set(`${P}/book-analysis`, [
      ...(mockFs.directories.get(`${P}/book-analysis`) ?? []),
      { name: bookId, path: bookPath, is_dir: true },
    ])
    mockFs.files.set(`${bookPath}/metadata.json`, JSON.stringify({
      title, totalChapters: 2, totalWords: 2000, sourceType: "file", createdAt: 1, updatedAt,
    }))
    return bookPath
  }

  it("skills 匹配策略: includes / safeName / 未匹配回退 + 非 md 跳过", async () => {
    const bookPath = seedBasicBook("book-1", "长夜书")
    mockFs.directories.set(`${bookPath}/characters`, [
      { name: "hanli.json", path: `${bookPath}/characters/hanli.json`, is_dir: false },
      { name: "han2.json", path: `${bookPath}/characters/han2.json`, is_dir: false },
      { name: "evil.json", path: `${bookPath}/characters/evil.json`, is_dir: false },
      { name: "noalias.json", path: `${bookPath}/characters/noalias.json`, is_dir: false },
      { name: "note.txt", path: `${bookPath}/characters/note.txt`, is_dir: false },
      { name: "sub", path: `${bookPath}/characters/sub`, is_dir: true },
      { name: "broken.json", path: `${bookPath}/characters/broken.json`, is_dir: false },
    ])
    seedCharacter(`${bookPath}/characters/hanli.json`, { id: "char-hanli", name: "韩立" })
    seedCharacter(`${bookPath}/characters/han2.json`, {
      id: "char-han2", name: "韩·立", category: "supporting", firstAppearance: 0, lastAppearance: 0, appearanceCount: 1,
    })
    seedCharacter(`${bookPath}/characters/evil.json`, {
      id: "char-evil", name: "大反派", category: "antagonist",
    })
    // 无 aliases 字段的角色 → recognizedFromExtractedCharacters 的 ?? [] 分支
    seedCharacter(`${bookPath}/characters/noalias.json`, {
      id: "char-noalias", name: "无别名", category: "minor",
      // aliases 显式置 undefined → JSON.stringify 会省略该字段
      aliases: undefined as never,
    })
    // note.txt / broken.json 无文件 → readJson null → 跳过
    mockFs.directories.set(`${bookPath}/skills`, [
      { name: "韩立传-skill.md", path: `${bookPath}/skills/韩立传-skill.md`, is_dir: false },
      { name: "韩_立-skill.md", path: `${bookPath}/skills/韩_立-skill.md`, is_dir: false },
      { name: "路人甲-skill.md", path: `${bookPath}/skills/路人甲-skill.md`, is_dir: false },
      { name: "readme.txt", path: `${bookPath}/skills/readme.txt`, is_dir: false },
      { name: "subdir", path: `${bookPath}/skills/subdir`, is_dir: true },
    ])
    mockFs.files.set(`${bookPath}/skills/韩立传-skill.md`, "# 韩立传")
    mockFs.files.set(`${bookPath}/skills/韩_立-skill.md`, "# 韩立")
    mockFs.files.set(`${bookPath}/skills/路人甲-skill.md`, "# 路人甲")

    const state = await loadBookAnalysisLibraryState(P)
    const book = state.books[0]
    // 无效 characters 文件被跳过
    expect(book.characters.map((c) => c.name)).toEqual(["韩立", "韩·立", "大反派", "无别名"])
    // 无 recognized-characters.json → 从 characters 派生
    expect(book.recognizedCharacters.map((c) => [c.name, c.category])).toEqual([
      ["韩立", "主角"], ["韩·立", "配角"], ["大反派", "次要"], ["无别名", "次要"],
    ])
    expect(book.recognizedCharacters.find((c) => c.name === "无别名")!.aliases).toEqual([])
    // 韩·立 firstAppearance 0 → chapterIndices [0]
    expect(book.recognizedCharacters.find((c) => c.name === "韩·立")!.chapterIndices).toEqual([0])
    // skills 匹配策略
    const skillNames = book.skills.map((s) => [s.characterName, s.id])
    expect(skillNames).toContainEqual(["韩立", "skill-char-hanli"]) // includes 匹配
    expect(skillNames).toContainEqual(["韩·立", "skill-char-han2"]) // safeName 匹配
    expect(skillNames).toContainEqual(["路人甲", "skill-路人甲"]) // 回退
    const fallback = book.skills.find((s) => s.characterName === "路人甲")!
    expect(fallback.chapterRange).toEqual([])
    expect(book.skills).toHaveLength(3) // readme.txt/subdir 跳过
  })

  it("skills 目录中某文件读取失败 → loadSkills 整体回退 []", async () => {
    const bookPath = seedBasicBook("book-1", "长夜书")
    mockFs.directories.set(`${bookPath}/characters`, [
      { name: "hanli.json", path: `${bookPath}/characters/hanli.json`, is_dir: false },
    ])
    seedCharacter(`${bookPath}/characters/hanli.json`)
    mockFs.directories.set(`${bookPath}/skills`, [
      { name: "韩立-skill.md", path: `${bookPath}/skills/韩立-skill.md`, is_dir: false },
    ])
    // 不写 skill 文件 → readFile 抛错 → catch
    const state = await loadBookAnalysisLibraryState(P)
    expect(state.books[0].skills).toEqual([])
  })

  it("characters 目录列目录失败 → characters []", async () => {
    const bookPath = seedBasicBook("book-1", "长夜书")
    const real = vi.mocked(listDirectory).getMockImplementation()!
    vi.mocked(listDirectory).mockImplementation(async (path: string) => {
      if (path.replace(/\\/g, "/").includes("/characters")) throw new Error("boom")
      return mockFs.directories.get(path.replace(/\\/g, "/")) ?? []
    })
    try {
      const state = await loadBookAnalysisLibraryState(P)
      expect(state.books[0].characters).toEqual([])
      expect(state.books[0].recognizedCharacters).toEqual([])
    } finally {
      vi.mocked(listDirectory).mockImplementation(real)
    }
  })

  it("skills 目录列目录失败 → skills []", async () => {
    const bookPath = seedBasicBook("book-1", "长夜书")
    const real = vi.mocked(listDirectory).getMockImplementation()!
    vi.mocked(listDirectory).mockImplementation(async (path: string) => {
      if (path.replace(/\\/g, "/").includes("/skills")) throw new Error("boom")
      return mockFs.directories.get(path.replace(/\\/g, "/")) ?? []
    })
    try {
      const state = await loadBookAnalysisLibraryState(P)
      expect(state.books[0].skills).toEqual([])
    } finally {
      vi.mocked(listDirectory).mockImplementation(real)
    }
  })

  it("非 book- 前缀 / 非目录 / 无 metadata 的条目被跳过", async () => {
    seedBasicBook("book-1", "长夜书")
    mockFs.directories.set(`${P}/book-analysis`, [
      ...(mockFs.directories.get(`${P}/book-analysis`) ?? []),
      { name: "other", path: `${P}/book-analysis/other`, is_dir: true },
      { name: "file.txt", path: `${P}/book-analysis/file.txt`, is_dir: false },
      { name: "book-empty", path: `${P}/book-analysis/book-empty`, is_dir: true },
    ])
    // book-empty 不写 metadata.json → readJson null → 跳过
    const state = await loadBookAnalysisLibraryState(P)
    expect(state.books.map((b) => b.id)).toEqual(["book-1"])
  })

  it("book-analysis 目录列目录失败 → books []", async () => {
    const real = vi.mocked(listDirectory).getMockImplementation()!
    vi.mocked(listDirectory).mockImplementation(async (path: string) => {
      if (path.replace(/\\/g, "/").endsWith("/book-analysis")) throw new Error("boom")
      return mockFs.directories.get(path.replace(/\\/g, "/")) ?? []
    })
    try {
      const state = await loadBookAnalysisLibraryState(P)
      expect(state.books).toEqual([])
    } finally {
      vi.mocked(listDirectory).mockImplementation(real)
    }
  })

  it("binding 指向不存在的 aura → auraName 空串；书名不匹配 → boundAurasCount 0", async () => {
    vi.mocked(loadCharacterAuraStore).mockImplementationOnce(async () => ({
      customAuras: [{
        id: "aura-hanli", builtIn: false, name: "韩立", category: "拆书角色",
        sourceNote: "来自拆书作品《凡人修仙传》的角色分析。", corpus: "",
        styleDescription: "", behaviorRules: "", boundaries: "", notes: "",
      }],
      bindings: [
        { characterName: "主角", auraId: "aura-hanli" },
        { characterName: "幽灵", auraId: "aura-missing" },
      ],
    }))
    seedBasicBook("book-1", "长夜书") // 书名 ≠ 凡人修仙传
    const state = await loadBookAnalysisLibraryState(P)
    expect(state.bindings.find((b) => b.auraId === "aura-missing")!.auraName).toBe("")
    expect(state.books[0].boundAurasCount).toBe(0)
  })

  it("style-profile 存在但启用风格不匹配 → styleStatus available", async () => {
    const bookPath = seedBasicBook("book-1", "长夜书")
    mockFs.files.set(`${bookPath}/style-profile.json`, JSON.stringify({
      schemaVersion: 1, generatedAt: 1, sampledChapterIds: [], narrativeDensity: "x",
      descriptionWeight: "", emotionRendering: "", sentenceStyle: "", rhetoricDensity: "",
      transitionStyle: "", narrativeVoice: "", dialogueStyle: "", thematicHabits: "",
      constitution: "", samples: [],
    }))
    const state = await loadBookAnalysisLibraryState(P)
    expect(state.books[0].styleStatus).toBe("available")
    expect(state.books[0].styleProfile).toBeDefined()
  })

  it("sort 按 updatedAt 降序", async () => {
    seedBasicBook("book-old", "旧书", 1)
    seedBasicBook("book-new", "新书", 9)
    const state = await loadBookAnalysisLibraryState(P)
    expect(state.books.map((b) => b.id)).toEqual(["book-new", "book-old"])
  })
})

describe("toBookAnalysisResult", () => {
  it("映射 library book → analysis result", async () => {
    const bookPath = "E:/Novel/book-analysis/book-1"
    mockFs.directories.set("E:/Novel/book-analysis", [
      { name: "book-1", path: bookPath, is_dir: true },
    ])
    mockFs.files.set(`${bookPath}/metadata.json`, JSON.stringify({
      title: "长夜书", totalChapters: 2, totalWords: 2000, sourceType: "file", createdAt: 1, updatedAt: 2,
    }))
    const state = await loadBookAnalysisLibraryState("E:/Novel")
    const result = toBookAnalysisResult(state.books[0])
    expect(result.metadata.title).toBe("长夜书")
    expect(result.bookId).toBe("book-1")
    expect(result.characters).toEqual(state.books[0].characters)
    expect(result.skills).toEqual(state.books[0].skills)
    expect(result.styleProfile).toBeUndefined()
  })
})
