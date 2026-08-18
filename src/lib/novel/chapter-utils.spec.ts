import { beforeEach, describe, expect, it, vi } from "vitest"
import { detectLastGeneratedChapterNumber, ensureString, extractChapterNumber, findChapterFileByNumber, flattenMdFiles, flattenMdFilesBase, formatStageThinking, getNextChapterNumber, invalidateChapterCache, readSelectedChapterNumberForFile, resolveTargetChapterNumberForChat } from "./chapter-utils"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
}))

function chapterNode(name: string, root = "E:/Novel"): { name: string; path: string; is_dir: boolean } {
  return { name, path: `${root}/wiki/chapters/${name}`, is_dir: false }
}

function chapterContent(number: number): string {
  return `---\nchapter_number: ${number}\n---\n# 第${number}章\n`
}

function titleOnlyContent(title: string): string {
  return `---\ntitle: "${title}"\n---\n# ${title}\n`
}

function numberFromPath(path: string): number {
  const m = path.match(/chapter-(\d+)\.md$/)
  return m ? Number.parseInt(m[1], 10) : 1
}

describe("resolveTargetChapterNumberForChat", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateChapterCache()
    fsMocks.listDirectory.mockResolvedValue([
      { name: "chapter-006.md", path: "E:/Novel/wiki/chapters/chapter-006.md", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValue(chapterContent(6))
  })

  it("uses the selected chapter plus one for continue-next-chapter requests", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续生成下一章",
      routeIntent: "continue_chapter",
      selectedFile: "E:/Novel/wiki/chapters/chapter-007.md",
    })).resolves.toBe(8)
  })

  it("uses the next available chapter when no chapter is selected", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "请根据当前小说上下文继续生成下一章正文",
      routeIntent: "continue_chapter",
    })).resolves.toBe(7)
  })

  it("keeps an explicit chapter number instead of advancing it", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续生成第7章",
      routeIntent: "continue_chapter",
      routeChapterNumber: 7,
      selectedFile: "E:/Novel/wiki/chapters/chapter-007.md",
    })).resolves.toBe(7)
  })

  it("does not force a target chapter for ordinary current-chapter continuation", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续写当前这一章",
      routeIntent: "continue_chapter",
      selectedFile: "E:/Novel/wiki/chapters/chapter-007.md",
    })).resolves.toBeUndefined()
  })

  it("advances past the chapter generated in this conversation even when it is not saved yet (issue #6)", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续生成下一章",
      routeIntent: "continue_chapter",
      lastGeneratedChapterNumber: 8,
    })).resolves.toBe(9)
  })

  it("keeps the library-derived next chapter when it is already ahead of the conversation", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续生成下一章",
      routeIntent: "continue_chapter",
      lastGeneratedChapterNumber: 3,
    })).resolves.toBe(7)
  })
})

describe("detectLastGeneratedChapterNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reads the deep-generation target chapter marker from the latest assistant message", () => {
    expect(detectLastGeneratedChapterNumber([
      "## 阶段1：上下文分析\n目标章节：第1章\n章节目标：开局",
      "## 阶段1：上下文分析\n目标章节：第2章\n章节目标：冲突升级",
    ])).toBe(2)
  })

  it("reads chapter heading lines from generated chapter content", () => {
    expect(detectLastGeneratedChapterNumber([
      "# 第3章\n\n夜色像一块浸了水的布。",
    ])).toBe(3)
  })

  it("ignores ordinary answers that merely mention chapter numbers", () => {
    expect(detectLastGeneratedChapterNumber([
      "主角在第3章的时候已经拿到了钥匙，所以这里不冲突。",
    ])).toBeUndefined()
  })

  it("skips empty assistant messages and rejects chapter zero", () => {
    expect(detectLastGeneratedChapterNumber(["", "目标章节：第0章"])).toBeUndefined()
    expect(detectLastGeneratedChapterNumber(["  ", "# 第0章"])).toBeUndefined()
  })
})

describe("project-scoped chapter index cache (ISS-20260724-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateChapterCache()
    fsMocks.listDirectory.mockResolvedValue([
      chapterNode("chapter-001.md"),
      chapterNode("chapter-002.md"),
      chapterNode("chapter-003.md"),
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => chapterContent(numberFromPath(path)))
  })

  it("performs bounded metadata IO on repeated lookups of an unchanged project", async () => {
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)

    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
    // one read per chapter for the single index build, not per lookup per chapter
    expect(fsMocks.readFile).toHaveBeenCalledTimes(3)
  })

  it("invalidating observes a newly written chapter", async () => {
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(3)

    invalidateChapterCache("E:/Novel")
    fsMocks.listDirectory.mockResolvedValue([
      chapterNode("chapter-001.md"),
      chapterNode("chapter-002.md"),
      chapterNode("chapter-003.md"),
      chapterNode("chapter-004.md"),
    ])

    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(5)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(7)
  })

  it("invalidating observes a deleted chapter", async () => {
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)

    invalidateChapterCache("E:/Novel")
    fsMocks.listDirectory.mockResolvedValue([
      chapterNode("chapter-001.md"),
      chapterNode("chapter-002.md"),
    ])

    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(3)
  })

  it("keeps separate projects isolated in the shared cache", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (path.startsWith("E:/NovelB")) {
        return [chapterNode("chapter-010.md", "E:/NovelB")]
      }
      return [chapterNode("chapter-001.md"), chapterNode("chapter-002.md")]
    })
    fsMocks.readFile.mockImplementation(async (path: string) => chapterContent(numberFromPath(path)))

    await expect(getNextChapterNumber("E:/NovelA")).resolves.toBe(3)
    await expect(getNextChapterNumber("E:/NovelB")).resolves.toBe(11)
    // A's cached index must not have been overwritten by B's load
    await expect(getNextChapterNumber("E:/NovelA")).resolves.toBe(3)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(2)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(3)
  })

  it("deduplicates concurrent lookups of the same project into one metadata load", async () => {
    const [first, second] = await Promise.all([
      getNextChapterNumber("E:/Novel"),
      getNextChapterNumber("E:/Novel"),
    ])
    expect(first).toBe(4)
    expect(second).toBe(4)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(3)
  })

  it("returns the first chapter when the chapters directory is empty", async () => {
    fsMocks.listDirectory.mockResolvedValue([])
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(1)
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("does not cache a failed listing so a later directory creation is observed", async () => {
    fsMocks.listDirectory.mockRejectedValueOnce(new Error("directory does not exist"))
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(1)
    expect(fsMocks.readFile).not.toHaveBeenCalled()

    fsMocks.listDirectory.mockResolvedValue([chapterNode("chapter-001.md")])
    // no explicit invalidation: the failed load must not have been cached
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(2)
  })

  it("keeps filename/frontmatter/title precedence semantics", async () => {
    // name 2 + frontmatter 5 + title 第100章 (title must be ignored when frontmatter exists) -> next 6
    fsMocks.listDirectory.mockResolvedValue([chapterNode("chapter-002.md")])
    fsMocks.readFile.mockResolvedValue(titleOnlyContent("第100章"))
    fsMocks.readFile.mockResolvedValueOnce(`---\nchapter_number: 5\n---\n# 第5章\n`)
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(6)

    // name without a number + title-only 第3章 -> next 4
    invalidateChapterCache("E:/Novel")
    fsMocks.listDirectory.mockResolvedValue([chapterNode("开局.md")])
    fsMocks.readFile.mockResolvedValue(titleOnlyContent("第3章 起步"))
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)

    // name still contributes when frontmatter exists (name 7 + frontmatter 3 -> next 8)
    invalidateChapterCache("E:/Novel")
    fsMocks.listDirectory.mockResolvedValue([chapterNode("chapter-007.md")])
    fsMocks.readFile.mockResolvedValue(chapterContent(3))
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(8)
  })

  it("skips unreadable chapter files like the previous implementation", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("chapter-001.md")) throw new Error("permission denied")
      return chapterContent(numberFromPath(path))
    })
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(3)
  })

  it("findChapterFileByNumber reuses the cached index without extra reads", async () => {
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(4)
    const readsAfterNextNumber = fsMocks.readFile.mock.calls.length

    await expect(findChapterFileByNumber("E:/Novel", 2)).resolves.toBe("E:/Novel/wiki/chapters/chapter-002.md")
    await expect(findChapterFileByNumber("E:/Novel", 99)).resolves.toBeNull()

    expect(fsMocks.readFile.mock.calls.length).toBe(readsAfterNextNumber)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
  })

  it("findChapterFileByNumber falls back to an empty index when the chapter dir is missing", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: wiki/chapters"))
    await expect(findChapterFileByNumber("E:/Novel", 2)).resolves.toBeNull()
  })

  it("findChapterFileByNumber resolves files whose number comes from frontmatter only", async () => {
    fsMocks.listDirectory.mockResolvedValue([chapterNode("序章.md")])
    fsMocks.readFile.mockResolvedValue(chapterContent(5))
    await expect(findChapterFileByNumber("E:/Novel", 5)).resolves.toBe("E:/Novel/wiki/chapters/序章.md")
    await expect(findChapterFileByNumber("E:/Novel", 1)).resolves.toBeNull()
  })

  it("discards an in-flight index snapshot when the cache is invalidated mid-load", async () => {
    let resolveList!: (value: unknown) => void
    fsMocks.listDirectory.mockReturnValueOnce(new Promise((resolve) => { resolveList = resolve }))
    const first = getNextChapterNumber("E:/Novel")
    await Promise.resolve()
    invalidateChapterCache("E:/Novel")
    resolveList([chapterNode("chapter-001.md")])
    await expect(first).resolves.toBe(2)

    // stale snapshot must NOT have been cached: second call reloads
    fsMocks.listDirectory.mockResolvedValue([chapterNode("chapter-001.md")])
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(2)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(2)
  })

  it("treats a duplicate numbered chapter idempotently (byName not above max)", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      chapterNode("chapter-005.md"),
      chapterNode("chapter-005-重.md"),
    ])
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(6)
  })

  it("byTitle alone marks chapter one and does not exceed a higher byFrontmatter max", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      chapterNode("开局.md"),
      chapterNode("chapter-005.md"),
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("开局")) return titleOnlyContent("第1章 起步")
      return chapterContent(5)
    })
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(6)
  })

  it("treats a file without title or frontmatter number as name-only (titleMatch absent)", async () => {
    fsMocks.listDirectory.mockResolvedValue([chapterNode("chapter-001.md")])
    fsMocks.readFile.mockResolvedValue("没有 frontmatter 的纯正文。")
    await expect(getNextChapterNumber("E:/Novel")).resolves.toBe(2)
  })
})

describe("ensureString / formatStageThinking", () => {
  it("ensureString passes strings through and coerces everything else to empty", () => {
    expect(ensureString("abc")).toBe("abc")
    expect(ensureString(undefined)).toBe("")
    expect(ensureString(null)).toBe("")
    expect(ensureString(42)).toBe("")
  })

  it("formatStageThinking builds a markdown h2 with trimmed content", () => {
    expect(formatStageThinking("阶段1", "  内容  \n")).toBe("## 阶段1\n内容")
  })
})

describe("extractChapterNumber / flattenMdFiles", () => {
  it("extractChapterNumber matches 第N章/节/回 and bare digits", () => {
    expect(extractChapterNumber("第12章 夜")).toBe(12)
    expect(extractChapterNumber("第3回")).toBe(3)
    expect(extractChapterNumber("chapter 5")).toBe(5)
    expect(extractChapterNumber("abc")).toBeNull()
    expect(extractChapterNumber("")).toBeNull()
  })

  it("flattenMdFilesBase recurses into dirs, skips dirs without children and non-md files", () => {
    const nodes = [
      { name: "a.md", path: "/a/a.md", is_dir: false },
      { name: "notes.txt", path: "/a/notes.txt", is_dir: false },
      { name: "sub", path: "/a/sub", is_dir: true, children: [{ name: "b.md", path: "/a/sub/b.md", is_dir: false }] },
      { name: "empty", path: "/a/empty", is_dir: true },
    ]
    expect(flattenMdFilesBase(nodes as never)).toEqual([
      { name: "a.md", path: "/a/a.md" },
      { name: "b.md", path: "/a/sub/b.md" },
    ])
  })

  it("flattenMdFiles sorts by chapter number with localeCompare fallback and null-number placement", () => {
    const nodes = [
      { name: "番外.md", path: "/a/番外.md", is_dir: false },
      { name: "第2章.md", path: "/a/第2章.md", is_dir: false },
      { name: "第10章.md", path: "/a/第10章.md", is_dir: false },
      { name: "第1章.md", path: "/a/第1章.md", is_dir: false },
      { name: "第2章A.md", path: "/a/第2章A.md", is_dir: false },
    ]
    const flat = flattenMdFiles(nodes as never)
    expect(flat.map((f) => f.name)).toEqual(["第1章.md", "第2章.md", "第2章A.md", "第10章.md", "番外.md"])
  })

  it("flattenMdFiles places a null-numbered name after a numbered name in a two-element sort", () => {
    const flat = flattenMdFiles([
      { name: "第1章.md", path: "/a/第1章.md", is_dir: false },
      { name: "番外.md", path: "/a/番外.md", is_dir: false },
    ] as never)
    expect(flat.map((f) => f.name)).toEqual(["第1章.md", "番外.md"])
  })
})

describe("readSelectedChapterNumberForFile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns undefined for missing selection or non-chapters paths", async () => {
    await expect(readSelectedChapterNumberForFile(undefined)).resolves.toBeUndefined()
    await expect(readSelectedChapterNumberForFile(null)).resolves.toBeUndefined()
    await expect(readSelectedChapterNumberForFile("E:/Novel/wiki/outline.md")).resolves.toBeUndefined()
  })

  it("extracts the number from the file name first", async () => {
    await expect(readSelectedChapterNumberForFile("E:\\Novel\\wiki\\chapters\\chapter-007.md")).resolves.toBe(7)
  })

  it("falls back to the frontmatter chapter_number when the name has none", async () => {
    fsMocks.readFile.mockResolvedValue(chapterContent(5))
    await expect(readSelectedChapterNumberForFile("E:/Novel/wiki/chapters/序章.md")).resolves.toBe(5)
    expect(fsMocks.readFile).toHaveBeenCalledWith("E:/Novel/wiki/chapters/序章.md")
  })

  it("rejects non-positive frontmatter numbers and ignores unreadable files", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent(0))
    await expect(readSelectedChapterNumberForFile("E:/Novel/wiki/chapters/序章.md")).resolves.toBeUndefined()
    fsMocks.readFile.mockRejectedValueOnce(new Error("denied"))
    await expect(readSelectedChapterNumberForFile("E:/Novel/wiki/chapters/序章.md")).resolves.toBeUndefined()
    // chapters-path file with neither a numbered name nor a chapter_number frontmatter
    fsMocks.readFile.mockResolvedValueOnce("没有编号的正文。")
    await expect(readSelectedChapterNumberForFile("E:/Novel/wiki/chapters/序章.md")).resolves.toBeUndefined()
    expect(fsMocks.readFile).toHaveBeenCalledTimes(3)
  })
})

describe("resolveTargetChapterNumberForChat routing edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateChapterCache()
  })

  it("does not resolve a next chapter for non-chapter intents", async () => {
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续生成下一章",
      routeIntent: "review_chapter",
    })).resolves.toBeUndefined()
    await expect(resolveTargetChapterNumberForChat({
      projectPath: "E:/Novel",
      userRequest: "继续生成下一章",
    })).resolves.toBeUndefined()
  })
})
