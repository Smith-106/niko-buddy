import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  deleteFile: fsMocks.deleteFile,
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
}))

vi.mock("@/lib/utils", () => ({
  logger: loggerMocks,
}))

import {
  deleteNovelSourceMemory,
  getOutlineSnapshotNumberFromPath,
} from "./delete-source-memory"
import { deleteChapterSnapshots } from "@/lib/novel/chapter-ingest"

vi.mock("@/lib/novel/chapter-ingest", () => ({
  deleteChapterSnapshots: vi.fn(),
}))

describe("deleteNovelSourceMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("deletes chapter snapshots by chapter_number before the page disappears", async () => {
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })

    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 12)
  })

  it("deletes outline snapshots using the same filename hash as outline ingest", async () => {
    const outlinePath = "/project/wiki/outlines/人物小传/主角.md"
    const expected = getOutlineSnapshotNumberFromPath(outlinePath)

    await deleteNovelSourceMemory("/project", {
      kind: "outline",
      pagePath: outlinePath,
    })

    expect(expected).toBeLessThan(0)
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", expected)
  })

  it("deletes entity pages that only came from the deleted chapter source", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "主角.md", path: "/project/wiki/entities/主角.md", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValueOnce([
      "---",
      "type: entity",
      'sources: ["012.snapshot.json"]',
      'source_type: "chapter"',
      "source_sequence: 12",
      "---",
      "# 主角",
    ].join("\n"))

    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })

    expect(fsMocks.deleteFile).toHaveBeenCalledWith("/project/wiki/entities/主角.md")
  })

  it("preserves entity pages that still reference other sources", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "主角.md", path: "/project/wiki/entities/主角.md", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValueOnce([
      "---",
      "type: entity",
      'sources: ["012.snapshot.json", "013.snapshot.json"]',
      'source_type: "chapter"',
      "source_sequence: 13",
      "---",
      "# 主角",
      "",
      "## 章节信息",
      "",
      "- **相关章节**: 12",
      "",
      "## 章节信息",
      "",
      "- **相关章节**: 13",
    ].join("\n"))

    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })

    expect(fsMocks.deleteFile).not.toHaveBeenCalledWith("/project/wiki/entities/主角.md")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/project/wiki/entities/主角.md",
      expect.not.stringContaining("012.snapshot.json"),
    )
  })

  it("falls back to the chapter number embedded in the page path when content lacks chapter_number", async () => {
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-007.md",
      content: "# 第七章\n\n没有 chapter_number 前注。",
    })
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 7)
  })

  it("falls back to the page path number when chapter_number is not a positive integer", async () => {
    // NaN parse → skip frontmatter, use path number
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-003.md",
      content: "---\nchapter_number: abc\n---\n# 第三章\n",
    })
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 3)
    // zero / negative → not > 0 → use path number
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-004.md",
      content: "---\nchapter_number: 0\n---\n# 第四章\n",
    })
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 4)
    // digit string that overflows parseInt to Infinity → not finite → path number
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-005.md",
      content: `---\nchapter_number: ${'9'.repeat(400)}\n---\n# 第五章\n`,
    })
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 5)
  })

  it("falls back to the page path number when content is absent", async () => {
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-006.md",
    })
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 6)
  })

  it("returns early (no snapshot delete) when the page path has no number", async () => {
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/前言.md",
      content: "# 前言",
    })
    expect(deleteChapterSnapshots).not.toHaveBeenCalled()
  })

  it("returns early when the page path number overflows to non-finite", async () => {
    const huge = "9".repeat(400)
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: `/project/wiki/chapters/chapter-${huge}.md`,
    })
    expect(deleteChapterSnapshots).not.toHaveBeenCalled()
  })

  it("skips entity files that do not reference the deleted snapshot source", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "配角.md", path: "/project/wiki/entities/配角.md", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValueOnce([
      "---",
      "type: entity",
      'sources: ["013.snapshot.json"]',
      "---",
      "# 配角",
    ].join("\n"))
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("recurses into entity subdirectories when flattening entity files", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "门派", path: "/project/wiki/entities/门派", is_dir: true, children: [
        { name: "弟子.md", path: "/project/wiki/entities/门派/弟子.md", is_dir: false },
      ] },
      { name: "杂物.txt", path: "/project/wiki/entities/杂物.txt", is_dir: false },
    ])
    fsMocks.readFile.mockResolvedValueOnce([
      "---",
      'sources: ["012.snapshot.json"]',
      "---",
      "# 弟子",
    ].join("\n"))
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("/project/wiki/entities/门派/弟子.md")
    expect(fsMocks.deleteFile).not.toHaveBeenCalledWith("/project/wiki/entities/杂物.txt")
  })

  it("logs and continues when an entity file cannot be read", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "坏档.md", path: "/project/wiki/entities/坏档.md", is_dir: false },
    ])
    fsMocks.readFile.mockRejectedValueOnce(new Error("EACCES"))
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })
    expect(loggerMocks.error).toHaveBeenCalledWith(
      "Delete Source Memory",
      "failed to clean entity source",
      expect.objectContaining({ path: "/project/wiki/entities/坏档.md", error: "EACCES" }),
    )
  })

  it("skips cleanup entirely when the entities directory listing fails", async () => {
    fsMocks.listDirectory.mockRejectedValueOnce(new Error("ENOENT"))
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })
    expect(fsMocks.readFile).not.toHaveBeenCalled()
    expect(deleteChapterSnapshots).toHaveBeenCalledWith("/project", 12)
  })

  it("non-Error read failures are stringified in the log", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "坏档.md", path: "/project/wiki/entities/坏档.md", is_dir: false },
    ])
    fsMocks.readFile.mockRejectedValueOnce("raw string failure")
    await deleteNovelSourceMemory("/project", {
      kind: "chapter",
      pagePath: "/project/wiki/chapters/chapter-012.md",
      content: "---\nchapter_number: 12\n---\n# 第十二章\n",
    })
    expect(loggerMocks.error).toHaveBeenCalledWith(
      "Delete Source Memory",
      "failed to clean entity source",
      expect.objectContaining({ error: "raw string failure" }),
    )
  })
})
