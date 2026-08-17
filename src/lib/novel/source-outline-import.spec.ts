import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: (...args: unknown[]) => mocks.createDirectory(...args),
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
  getFileName: (p: string) => p.split("/").pop() ?? "",
  getRelativePath: (fullPath: string, basePath: string) => {
    const rel = fullPath.replace(basePath, "")
    return rel.startsWith("/") ? rel.slice(1) : rel
  },
  getUniqueOutlinePath: async (dir: string, fileName: string) => `${dir}/${fileName}`,
}))

vi.mock("@/lib/wiki-filename", () => ({
  makeSafeFileSlug: (title: string) => title,
  yamlEscape: (value: string) => value.replace(/"/g, '\\"'),
}))

import {
  addSourceToOutlineCategory,
  SOURCE_OUTLINE_IMPORT_TARGETS,
  type SourceOutlineImportTarget,
} from "./source-outline-import"

describe("source-outline-import", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.readFile.mockResolvedValue("# 源文档内容\n\n正文")
    mocks.writeFile.mockResolvedValue(undefined)
  })

  it("exposes the seven outline import targets with metadata", () => {
    expect(SOURCE_OUTLINE_IMPORT_TARGETS.map((t) => t.id)).toEqual([
      "story-outline",
      "chapter-outline",
      "character-briefs",
      "locations",
      "organizations",
      "power-system",
      "foreshadowing-plan",
    ])
    const story = SOURCE_OUTLINE_IMPORT_TARGETS.find((t) => t.id === "story-outline")!
    expect(story.outlineType).toBe("story-outline")
    expect(story.category).toBe("story")
    const briefs = SOURCE_OUTLINE_IMPORT_TARGETS.find((t) => t.id === "character-briefs")!
    expect(briefs.outlineType).toBeUndefined()
    expect(briefs.category).toBe("characters")
  })

  it("writes a story-outline target page with outline_type frontmatter", async () => {
    mocks.readFile.mockResolvedValueOnce("第一章：开局\n\n主角登场")
    const path = await addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/总纲.txt", "story-outline")

    expect(path).toBe("E:/Novel/wiki/outlines/总大纲/总纲.md")
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines")
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines/总大纲")

    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("type: outline")
    expect(content).toContain('title: "总纲"')
    expect(content).toContain("outline_type: story-outline")
    expect(content).toContain("outline_category: story")
    expect(content).toContain('outline_folder: "总大纲"')
    expect(content).toContain('sources: ["raw/sources/总纲.txt"]')
    expect(content).toContain("## 来源：总纲.txt")
    expect(content).toContain("> 原始来源：raw/sources/总纲.txt")
    expect(content).toContain("第一章：开局")
  })

  it("writes a chapter-outline target page (outlineType present) with title quote escaping", async () => {
    mocks.readFile.mockResolvedValueOnce("细纲正文")
    await addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/细纲\"v1\".md", "chapter-outline")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("outline_type: chapter-outline")
    expect(content).toContain('title: "细纲\\"v1\\""')
    expect(content).toContain("outline_category: chapter")
    expect(content).toContain('outline_folder: "章节细纲"')
  })

  it("writes a category-only target page without outline_type", async () => {
    mocks.readFile.mockResolvedValueOnce("人物小传正文")
    const path = await addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/白砚.md", "character-briefs")
    expect(path).toBe("E:/Novel/wiki/outlines/人物小传/白砚.md")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).not.toContain("outline_type:")
    expect(content).toContain("outline_category: characters")
  })

  it("falls back to the relative source path when getFileName is empty (trailing-slash source)", async () => {
    mocks.readFile.mockResolvedValueOnce("内容")
    // sourcePath ends with "/": getFileName returns "" → sourceName falls back
    // to relativeSourcePath ("" here), pageTitle stays empty
    await addSourceToOutlineCategory("E:/Novel", "E:/Novel/", "locations")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("## 来源：")
    expect(content).toContain("> 原始来源：")
    expect(content).toContain('title: ""')
  })

  it("keeps file name without extension as page title (stripExtension)", async () => {
    mocks.readFile.mockResolvedValueOnce("组织正文")
    await addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/org.v1.final.md", "organizations")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('title: "org.v1.final"')
  })

  it("trims source content and renders section markdown", async () => {
    mocks.readFile.mockResolvedValueOnce("  \n  设定正文  \n\n  ")
    await addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/能力.md", "power-system")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("设定正文")
  })

  it("throws for an unknown target", async () => {
    await expect(
      addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/x.md", "unknown-target" as SourceOutlineImportTarget),
    ).rejects.toThrow("Unknown outline import target: unknown-target")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("uses the unique outline path returned by path-utils", async () => {
    // unique path mock returns dir/fileName directly; verify the source list target
    // resolves through the folder name for foreshadowing-plan
    await addSourceToOutlineCategory("E:/Novel", "E:/Novel/raw/sources/fp.md", "foreshadowing-plan")
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "E:/Novel/wiki/outlines/伏笔计划/fp.md",
      expect.any(String),
    )
  })
})
