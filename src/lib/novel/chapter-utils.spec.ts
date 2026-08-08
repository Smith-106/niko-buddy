import { beforeEach, describe, expect, it, vi } from "vitest"
import { detectLastGeneratedChapterNumber, findChapterFileByNumber, getNextChapterNumber, invalidateChapterCache, resolveTargetChapterNumberForChat } from "./chapter-utils"

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

  it("findChapterFileByNumber resolves files whose number comes from frontmatter only", async () => {
    fsMocks.listDirectory.mockResolvedValue([chapterNode("序章.md")])
    fsMocks.readFile.mockResolvedValue(chapterContent(5))
    await expect(findChapterFileByNumber("E:/Novel", 5)).resolves.toBe("E:/Novel/wiki/chapters/序章.md")
    await expect(findChapterFileByNumber("E:/Novel", 1)).resolves.toBeNull()
  })
})
