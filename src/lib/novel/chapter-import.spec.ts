import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

import {
  buildImportedChapterMarkdown,
  collectChapterImportCandidatesFromFolder,
  extractImportedChapterNumber,
  importChapterFiles,
  importChapterFolder,
  runImportedChapterMemoryExtraction,
  sortChapterImportCandidates,
} from "./chapter-import"

describe("chapter import", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
  })

  it("extracts Arabic and Chinese chapter numbers from file names", () => {
    expect(extractImportedChapterNumber("第1章 开局.txt")).toBe(1)
    expect(extractImportedChapterNumber("第十章 真相.docx")).toBe(10)
    expect(extractImportedChapterNumber("chapter-002.md")).toBe(2)
    expect(extractImportedChapterNumber("番外.txt")).toBeNull()
  })

  it("matches chapter numbers after book and volume prefixes without treating volume as the chapter", () => {
    expect(extractImportedChapterNumber("万古逍遥游-第一卷-第1章 前言.docx")).toBe(1)
    expect(extractImportedChapterNumber("万古逍遥游-第一卷-第2章 浮生苍穹为寒.docx")).toBe(2)
    expect(extractImportedChapterNumber("万古逍遥游-第一卷-第3章 十又五载.docx")).toBe(3)
  })

  it("sorts imported chapters by detected chapter number before unknown files", () => {
    const sorted = sortChapterImportCandidates([
      { path: "E:/book/第10章.txt", name: "第10章.txt" },
      { path: "E:/book/番外.txt", name: "番外.txt" },
      { path: "E:/book/第2章.txt", name: "第2章.txt" },
      { path: "E:/book/第1章.txt", name: "第1章.txt" },
    ])

    expect(sorted.map((item) => item.name)).toEqual([
      "第1章.txt",
      "第2章.txt",
      "第10章.txt",
      "番外.txt",
    ])
  })

  it("collects and sorts importable chapter files from a selected folder before confirmation", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "notes.tmp", path: "E:/book/notes.tmp", is_dir: false },
      { name: "chapter-002.md", path: "E:/book/chapter-002.md", is_dir: false },
      {
        name: "volume",
        path: "E:/book/volume",
        is_dir: true,
        children: [
          { name: "chapter-001.txt", path: "E:/book/volume/chapter-001.txt", is_dir: false },
        ],
      },
    ])

    const candidates = await collectChapterImportCandidatesFromFolder("E:\\book")

    expect(fsMocks.listDirectory).toHaveBeenCalledWith("E:/book")
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "E:/book/volume/chapter-001.txt",
      "E:/book/chapter-002.md",
    ])
  })

  it("builds chapter markdown as final only when memory extraction is requested", () => {
    const draft = buildImportedChapterMarkdown({
      title: "第1章 开局",
      chapterNumber: 1,
      body: "# 原标题\n\n正文",
      finalForMemoryExtraction: false,
    })
    const final = buildImportedChapterMarkdown({
      title: "第1章 开局",
      chapterNumber: 1,
      body: "正文",
      finalForMemoryExtraction: true,
    })

    expect(draft).toContain("chapter_status: draft")
    expect(final).toContain("chapter_status: final")
    expect(final).toContain("# 第1章 开局")
  })

  it("imports prefixed book-volume chapter files with clean chapter titles", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)

    await importChapterFiles("E:/Novel", [
      "E:/book/万古逍遥游-第一卷-第3章 十又五载.docx",
      "E:/book/万古逍遥游-第一卷-第1章 前言.docx",
      "E:/book/万古逍遥游-第一卷-第2章 浮生苍穹为寒.docx",
    ], { finalForMemoryExtraction: false })

    const written = fsMocks.writeFile.mock.calls.map(([path, content]) => ({
      path,
      content: String(content),
    }))
    expect(written.map((item) => item.path)).toEqual([
      "E:/Novel/wiki/chapters/chapter-001-前言.md",
      "E:/Novel/wiki/chapters/chapter-002-浮生苍穹为寒.md",
      "E:/Novel/wiki/chapters/chapter-003-十又五载.md",
    ])
    expect(written[0].content).toContain('title: "第1章 前言"')
    expect(written[0].content).toContain("# 第1章 前言")
    expect(written[1].content).toContain('title: "第2章 浮生苍穹为寒"')
    expect(written[2].content).toContain('title: "第3章 十又五载"')
  })

  it("extracts imported chapter memories one by one and stops after cancellation", async () => {
    const abortController = new AbortController()
    const ingestChapter = vi.fn(async () => {
      abortController.abort()
      return { snapshot: { chapterNumber: 1 } }
    })
    const onProgress = vi.fn()

    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/chapter-001.md", "E:/Novel/wiki/chapters/chapter-002.md"],
      signal: abortController.signal,
      ingestChapter,
      onProgress,
    })

    expect(ingestChapter).toHaveBeenCalledTimes(1)
    expect(result.cancelled).toBe(true)
    expect(result.completed).toBe(1)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 0, total: 2 }))
  })
})

describe("chapter import number parsing edge cases", () => {
  it("parses Chinese digits, the 万 unit and zero-result numerals", () => {
    expect(extractImportedChapterNumber("第三章 试炼.txt")).toBe(3)
    expect(extractImportedChapterNumber("第三万章 洪荒.txt")).toBe(30000)
    expect(extractImportedChapterNumber("第万章 洪荒.txt")).toBe(10000)
    // 零 normalizes away -> parseChineseInteger returns 0 -> rejected
    expect(extractImportedChapterNumber("第零章 起.txt")).toBeNull()
    // 第0章 rejected by the <=0 guard
    expect(extractImportedChapterNumber("第0章.txt")).toBeNull()
  })

  it("falls through to the english/leading-number matchers when the chapter patterns miss", () => {
    // chapter pattern rejects number 0, english matcher still catches it
    expect(extractImportedChapterNumber("chapter 0.txt")).toBe(0)
    // leading digits without 第/chapter
    expect(extractImportedChapterNumber("001 开局.txt")).toBe(1)
  })

  it("handles empty/extensionless text", () => {
    expect(extractImportedChapterNumber("")).toBeNull()
    expect(extractImportedChapterNumber("番外.txt")).toBeNull()
  })

  it("normalizes full-width digits before matching (第１２章 → 12)", () => {
    expect(extractImportedChapterNumber("第１２章 开幕.txt")).toBe(12)
    expect(extractImportedChapterNumber("chapter ３.txt")).toBe(3)
    expect(extractImportedChapterNumber("０４ 开局.txt")).toBe(4)
  })

  it("sorts two null-numbered candidates by localeCompare", () => {
    const sorted = sortChapterImportCandidates([
      { path: "E:/book/b.txt", name: "b.txt" },
      { path: "E:/book/a.txt", name: "a.txt" },
    ])
    expect(sorted.map((item) => item.name)).toEqual(["a.txt", "b.txt"])
  })
})

describe("chapter import candidate filtering and title derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips hidden nodes and dirs without children during folder collection", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: ".hidden.md", path: "E:/book/.hidden.md", is_dir: false },
      { name: "chapter-001.md", path: "E:/book/chapter-001.md", is_dir: false },
      { name: "emptydir", path: "E:/book/emptydir", is_dir: true },
      { name: "sub", path: "E:/book/sub", is_dir: true, children: [{ name: "chapter-002.md", path: "E:/book/sub/chapter-002.md", is_dir: false }] },
    ])
    const candidates = await collectChapterImportCandidatesFromFolder("E:/book")
    expect(candidates.map((c) => c.path)).toEqual(["E:/book/chapter-001.md", "E:/book/sub/chapter-002.md"])
  })

  it("filters hidden files and extensionless files out of direct imports", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/.hidden.md", "E:/book/README", "E:/book/正文.txt"], { finalForMemoryExtraction: false })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/正文.txt")
  })

  it("derives a bare 第N章 title when the file name carries no suffix", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/chapter-002.md"], { finalForMemoryExtraction: true })
    expect(imported[0]!.title).toBe("第2章")
    expect(imported[0]!.path).toBe("E:/Novel/wiki/chapters/chapter-002.md")
    expect(String(fsMocks.writeFile.mock.calls[0]![1])).toContain("# 第2章")
  })

  it("derives the title suffix via stripChapterPrefix when the name has no chapter pattern", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/前言.txt"], { finalForMemoryExtraction: false })
    expect(imported[0]!.title).toBe("第1章 前言")
    expect(imported[0]!.path).toBe("E:/Novel/wiki/chapters/chapter-001-前言.md")
  })

  it("suffixes the target file with -2 when the first path already exists", async () => {
    fsMocks.fileExists.mockImplementation(async (path: string) => path.includes("chapter-001-前言.md"))
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/前言.txt"], { finalForMemoryExtraction: false })
    expect(imported[0]!.path).toBe("E:/Novel/wiki/chapters/chapter-001-前言-2.md")
  })

  it("falls back to a Date.now-suffixed path when every numbered variant exists", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/前言.txt"], { finalForMemoryExtraction: false })
    expect(imported[0]!.path).toMatch(/chapter-001-前言-\d+\.md$/)
  })

  it("records failures for unreadable chapter files and continues", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("坏文件")) throw new Error("read denied")
      return `正文 ${path}`
    })
    const imported = await importChapterFiles("E:/Novel", ["E:/book/坏文件.txt", "E:/book/好文件.txt"], { finalForMemoryExtraction: false })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/好文件.txt")
  })

  it("records non-Error failures with String(error) formatting", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("坏文件")) throw "string failure"
      return `正文 ${path}`
    })
    const imported = await importChapterFiles("E:/Novel", ["E:/book/坏文件.txt", "E:/book/好文件.txt"], { finalForMemoryExtraction: false })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/好文件.txt")
  })

  it("imports every importable file found in a selected folder via importChapterFolder", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "chapter-002.md", path: "E:/book/chapter-002.md", is_dir: false },
      { name: "notes.tmp", path: "E:/book/notes.tmp", is_dir: false },
    ])
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)

    const imported = await importChapterFolder("E:/Novel", "E:\\book", { finalForMemoryExtraction: false })

    expect(fsMocks.listDirectory).toHaveBeenCalledWith("E:/book")
    expect(imported.map((item) => item.path)).toEqual(["E:/Novel/wiki/chapters/chapter-002.md"])
    const written = fsMocks.writeFile.mock.calls.map(([path]) => path)
    expect(written).toEqual(["E:/Novel/wiki/chapters/chapter-002.md"])
  })

  it("continues importing when the chapters directory cannot be created", async () => {
    fsMocks.createDirectory.mockRejectedValueOnce(new Error("mkdir denied"))
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)

    const imported = await importChapterFiles("E:/Novel", ["E:/book/正文.txt"], { finalForMemoryExtraction: false })

    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/正文.txt")
  })
})

describe("runImportedChapterMemoryExtraction failure paths", () => {
  it("counts snapshot-less results as failed with failReason message", async () => {
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/chapter-001.md"],
      ingestChapter: vi.fn(async () => ({ snapshot: null, failReason: "no_llm" })),
    })
    expect(result).toMatchObject({ completed: 0, failed: 1, cancelled: false })
    expect(result.errors[0]).toContain("no_llm")
  })

  it("counts snapshot-less results with a generic 提取失败 message", async () => {
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/chapter-001.md"],
      ingestChapter: vi.fn(async () => ({ snapshot: null })),
    })
    expect(result.errors[0]).toContain("提取失败")
  })

  it("records thrown Error and non-Error failures", async () => {
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/a.md", "E:/Novel/wiki/chapters/b.md"],
      ingestChapter: vi.fn(async (_pp: string, path: string) => {
        if (path.endsWith("a.md")) throw new Error("boom")
        throw "string failure"
      }),
    })
    expect(result).toMatchObject({ completed: 0, failed: 2 })
    expect(result.errors[0]).toContain("boom")
    expect(result.errors[1]).toContain("string failure")
  })
})
