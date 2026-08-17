import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  parseFrontmatter: vi.fn(),
  isChapterPage: vi.fn(),
  isFinalChapter: vi.fn(),
  ingestChapter: vi.fn(),
  flattenMdFilesBase: vi.fn(),
  embedPage: vi.fn(),
  useWikiStore: {
    getState: vi.fn(() => ({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "m" },
    })),
  },
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  listDirectory: mocks.listDirectory,
}))
vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: mocks.parseFrontmatter,
}))
vi.mock("./chapter-meta", () => ({
  isChapterPage: mocks.isChapterPage,
  isFinalChapter: mocks.isFinalChapter,
}))
vi.mock("./chapter-ingest", () => ({
  ingestChapter: mocks.ingestChapter,
}))
vi.mock("./chapter-utils", () => ({
  flattenMdFilesBase: mocks.flattenMdFilesBase,
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: mocks.useWikiStore,
}))
vi.mock("@/lib/embedding", () => ({
  embedPage: mocks.embedPage,
}))

import { rebuildAllSnapshots, rebuildVectorIndex } from "./rebuild"

function mdNode(name: string, path: string) {
  return { name, path }
}

const fm = (overrides: Record<string, unknown> = {}) => ({
  frontmatter: { type: "chapter", chapter_status: "final", chapter_number: 1, ...overrides },
  body: "",
})

describe("rebuild rebuildAllSnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useWikiStore.getState.mockReturnValue({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "m" },
    })
    mocks.flattenMdFilesBase.mockImplementation((tree: { name: string; path: string }[]) => tree)
    mocks.parseFrontmatter.mockImplementation((content: string) => fm(JSON.parse(content)))
  })

  it("returns early when novel mode disabled", async () => {
    mocks.useWikiStore.getState.mockReturnValue({ novelMode: false })
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result).toEqual({ success: 0, failed: 0, errors: ["小说模式未开启"] })
  })

  it("returns error when chapters and wiki dirs unreadable", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result.errors).toEqual(["无法读取章节目录"])
  })

  it("falls back to wiki dir listing when chapters dir missing", async () => {
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/chapters")) throw new Error("no chapters dir")
      if (p.endsWith("/wiki")) return [mdNode("ch1.md", "C:/novel/wiki/ch1.md")]
      return []
    })
    mocks.readFile.mockResolvedValue('{"type":"chapter","chapter_status":"final","chapter_number":2}')
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter.mockResolvedValue({ snapshot: {}, failReason: undefined })
    const result = await rebuildAllSnapshots("C:/novel", undefined, { novelMode: true })
    expect(result.success).toBe(1)
    expect(result.failed).toBe(0)
  })

  it("ingests chapters in order, skipping non-chapter files and unreadable ones", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("ch2.md", "C:/novel/wiki/chapters/ch2.md"),
      mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md"),
      mdNode("outline.md", "C:/novel/wiki/chapters/outline.md"),
      mdNode("draft.md", "C:/novel/wiki/chapters/draft.md"),
      mdNode("strnum.md", "C:/novel/wiki/chapters/strnum.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("ch1.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":1}'
      if (p.endsWith("ch2.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":2}'
      if (p.endsWith("outline.md")) return '{"type":"outline"}'
      if (p.endsWith("draft.md")) return '{"type":"chapter","chapter_status":"draft","chapter_number":9}'
      if (p.endsWith("strnum.md")) return '{"type":"chapter","chapter_status":"final","chapter_number":"3"}'
      throw new Error("unreadable")
    })
    mocks.isChapterPage.mockImplementation((f: Record<string, unknown>) => f.type === "chapter")
    mocks.isFinalChapter.mockImplementation((f: Record<string, unknown>) => f.chapter_status === "final")
    mocks.ingestChapter.mockResolvedValue({ snapshot: {}, failReason: undefined })
    const progress: string[] = []
    const result = await rebuildAllSnapshots("C:/novel", (p) => {
      progress.push(`${p.completed}/${p.total}:${p.current}`)
    })
    expect(result.success).toBe(3)
    expect(result.failed).toBe(0)
    expect(progress[0]).toBe("0/3:第0章")
    expect(progress).toContain("1/3:第1章")
    expect(progress[3]).toContain("完成")
    // chapters sorted by chapterNumber; string chapter_number falls back to 0
    expect(mocks.ingestChapter.mock.calls[0][1]).toContain("strnum.md")
    expect(mocks.ingestChapter.mock.calls[1][1]).toContain("ch1.md")
    expect(mocks.ingestChapter.mock.calls[2][1]).toContain("ch2.md")
  })

  it("maps fail reasons to Chinese messages", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.readFile.mockResolvedValue('{"type":"chapter","chapter_status":"final","chapter_number":1}')
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "invalid_chapter_number" })
    const r1 = await rebuildAllSnapshots("C:/novel")
    expect(r1.errors[0]).toContain("章节编号无效")

    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "no_llm" })
    const r2 = await rebuildAllSnapshots("C:/novel")
    expect(r2.errors[0]).toContain("LLM 未配置")

    mocks.ingestChapter.mockResolvedValue({ snapshot: null, failReason: "other" })
    const r3 = await rebuildAllSnapshots("C:/novel")
    expect(r3.errors[0]).toContain("摄取返回空结果")
    expect(r3.failed).toBe(1)
  })

  it("records ingest exceptions as failures (Error and non-Error)", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md"),
      mdNode("ch2.md", "C:/novel/wiki/chapters/ch2.md"),
    ])
    mocks.readFile.mockResolvedValue('{"type":"chapter","chapter_status":"final","chapter_number":1}')
    mocks.isChapterPage.mockReturnValue(true)
    mocks.isFinalChapter.mockReturnValue(true)
    mocks.ingestChapter
      .mockRejectedValueOnce(new Error("crash"))
      .mockRejectedValueOnce("plain boom")
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result.failed).toBe(2)
    expect(result.errors[0]).toContain("crash")
    expect(result.errors[1]).toContain("plain boom")
  })

  it("skips chapter files without parseable frontmatter", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("ch1.md", "C:/novel/wiki/chapters/ch1.md")])
    mocks.readFile.mockResolvedValue("no frontmatter here")
    mocks.parseFrontmatter.mockReturnValue({ frontmatter: null, body: "" })
    const result = await rebuildAllSnapshots("C:/novel")
    expect(result.success).toBe(0)
    expect(result.failed).toBe(0)
  })
})

describe("rebuild rebuildVectorIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useWikiStore.getState.mockReturnValue({
      novelMode: true,
      embeddingConfig: { enabled: true, model: "m" },
    })
    mocks.flattenMdFilesBase.mockImplementation((tree: { name: string; path: string }[]) => tree)
    mocks.embedPage.mockResolvedValue(undefined)
  })

  it("returns early when embedding disabled or no model", async () => {
    mocks.useWikiStore.getState.mockReturnValue({
      embeddingConfig: { enabled: false, model: "m" },
    })
    expect(await rebuildVectorIndex("C:/novel")).toEqual({
      indexed: 0,
      errors: ["向量嵌入未启用或未配置模型"],
    })
    mocks.useWikiStore.getState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "" },
    })
    expect(await rebuildVectorIndex("C:/novel")).toEqual({
      indexed: 0,
      errors: ["向量嵌入未启用或未配置模型"],
    })
  })

  it("returns error when wiki dir unreadable", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    expect(await rebuildVectorIndex("C:/novel")).toEqual({
      indexed: 0,
      errors: ["无法读取 wiki 目录"],
    })
  })

  it("embeds pages with title from heading or file name", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("page.md", "C:/novel/wiki/page.md"),
      mdNode("no-title.md", "C:/novel/wiki/no-title.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("page.md") ? "# 标题页\n正文" : "无标题正文",
    )
    const progress: string[] = []
    const result = await rebuildVectorIndex("C:/novel", (p) => progress.push(p.current))
    expect(result.indexed).toBe(2)
    expect(result.errors).toEqual([])
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "C:/novel",
      "page",
      "标题页",
      "# 标题页\n正文",
      { enabled: true, model: "m" },
    )
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "C:/novel",
      "no-title",
      "no-title",
      "无标题正文",
      { enabled: true, model: "m" },
    )
    expect(progress).toContain("page.md")
    expect(progress).toContain("完成")
  })

  it("collects embed errors per page (Error and non-Error)", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdNode("bad.md", "C:/novel/wiki/bad.md"),
      mdNode("worse.md", "C:/novel/wiki/worse.md"),
      mdNode("good.md", "C:/novel/wiki/good.md"),
    ])
    mocks.readFile.mockResolvedValue("正文")
    mocks.embedPage.mockImplementation(async (_pp: string, pageId: string) => {
      if (pageId === "bad") throw new Error("embed failed")
      if (pageId === "worse") throw "plain fail"
    })
    const result = await rebuildVectorIndex("C:/novel")
    expect(result.indexed).toBe(1)
    expect(result.errors).toEqual(["bad.md：embed failed", "worse.md：plain fail"])
  })

  it("accepts explicit embedding config override", async () => {
    mocks.listDirectory.mockResolvedValue([mdNode("a.md", "C:/novel/wiki/a.md")])
    mocks.readFile.mockResolvedValue("正文")
    await rebuildVectorIndex("C:/novel", undefined, { enabled: true, model: "override" } as never)
    expect(mocks.embedPage).toHaveBeenCalledWith(
      expect.any(String),
      "a",
      "a",
      "正文",
      { enabled: true, model: "override" },
    )
  })
})
