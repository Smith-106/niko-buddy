import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  logger: { error: vi.fn() },
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: (...args: unknown[]) => mocks.createDirectory(...args),
  listDirectory: (...args: unknown[]) => mocks.listDirectory(...args),
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}))

vi.mock("@/lib/utils", () => ({
  logger: mocks.logger,
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
  getFileName: (p: string) => p.split("/").pop() ?? p,
  getFileStem: (p: string) => {
    const name = p.split("/").pop() ?? ""
    const dot = name.lastIndexOf(".")
    return dot > 0 ? name.slice(0, dot) : name
  },
  getRelativePath: (fullPath: string, basePath: string) => fullPath.replace(basePath, "").replace(/^\//, ""),
  getUniqueOutlinePath: async (dir: string, fileName: string) => `${dir}/${fileName}`,
}))

vi.mock("@/lib/wiki-filename", () => ({
  makeSafeFileSlug: (title: string) => title,
  yamlEscape: (value: string) => value.replace(/"/g, '\\"'),
}))

import {
  collectOutlineImportCandidatesFromFolder,
  importOutlineCandidates,
  importOutlineFiles,
  importOutlineFolder,
  OUTLINE_IMPORT_EXTENSIONS,
} from "./outline-import"

describe("outline-import", () => {
  beforeEach(() => {
    mocks.createDirectory.mockReset()
    mocks.listDirectory.mockReset()
    mocks.readFile.mockReset()
    mocks.writeFile.mockReset()
    mocks.logger.error.mockReset()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.readFile.mockResolvedValue("# 内容")
    mocks.writeFile.mockResolvedValue(undefined)
  })

  it("exposes the supported extension list", () => {
    expect(OUTLINE_IMPORT_EXTENSIONS).toContain("md")
    expect(OUTLINE_IMPORT_EXTENSIONS).toContain("pdf")
    expect(OUTLINE_IMPORT_EXTENSIONS).toContain("docx")
  })

  it("collects importable files recursively with target folders", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/src/总大纲.md", name: "总大纲.md", is_dir: false },
      { path: "E:/src/sub", name: "sub", is_dir: true, children: [
        { path: "E:/src/sub/卷一.md", name: "卷一.md", is_dir: false },
        { path: "E:/src/sub/.hidden.md", name: ".hidden.md", is_dir: false },
        { path: "E:/src/sub/readme.txt", name: "readme.txt", is_dir: false },
      ] },
    ])

    const candidates = await collectOutlineImportCandidatesFromFolder("E:\\src")
    expect(candidates).toEqual([
      { path: "E:/src/总大纲.md", name: "总大纲.md", targetFolders: ["src"] },
      { path: "E:/src/sub/卷一.md", name: "卷一.md", targetFolders: ["src", "sub"] },
      { path: "E:/src/sub/readme.txt", name: "readme.txt", targetFolders: ["src", "sub"] },
    ])
  })

  it("falls back to imported-outline root name when folder has no file name", async () => {
    mocks.listDirectory.mockResolvedValue([{ path: "/root.md", name: "root.md", is_dir: false }])
    const candidates = await collectOutlineImportCandidatesFromFolder("")
    expect(candidates[0]!.targetFolders).toEqual(["imported-outline"])
  })

  it("importOutlineFiles writes sanitized outline markdown", async () => {
    mocks.readFile.mockResolvedValueOnce("# 原始大纲\n\n正文内容")
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/总大纲.md"])
    expect(paths).toEqual(["E:/Novel/wiki/outlines/总大纲.md"])
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("type: outline")
    expect(content).toContain('title: "总大纲"')
    expect(content).toContain("# 原始大纲")
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines")
  })

  it("importOutlineFiles strips frontmatter and adds title heading when body has none", async () => {
    mocks.readFile.mockResolvedValueOnce("---\ntype: notes\n---\n\n正文内容")
    await importOutlineFiles("E:/Novel", ["E:/src/notes.md"])
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("# notes")
    expect(content).toContain("正文内容")
    expect(content).not.toContain("type: notes")
  })

  it("skips non-importable files silently", async () => {
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/archive.zip", "E:/src/.env"])
    expect(paths).toEqual([])
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("logs errors and continues when a file fails to import", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("boom"))
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/broken.md", "E:/src/ok.md"])
    expect(mocks.logger.error).toHaveBeenCalled()
    expect(paths).toEqual(["E:/Novel/wiki/outlines/ok.md"])
  })

  it("importOutlineCandidates uses target folders and escapes title quotes", async () => {
    mocks.readFile.mockResolvedValueOnce("内容")
    const paths = await importOutlineCandidates("E:/Novel", [
      { path: "E:/src/卷二.md", name: "卷二.md", targetFolders: ["src", "sub"] },
    ])
    expect(paths).toEqual(["E:/Novel/wiki/outlines/src/sub/卷二.md"])
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines/src/sub")
  })

  it("importOutlineCandidates logs folder import failures", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("boom"))
    const paths = await importOutlineCandidates("E:/Novel", [
      { path: "E:/src/x.md", name: "x.md", targetFolders: ["src"] },
    ])
    expect(mocks.logger.error).toHaveBeenCalled()
    expect(paths).toEqual([])
  })

  it("importOutlineFolder wires candidates into import", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/src/总大纲.md", name: "总大纲.md", is_dir: false },
    ])
    mocks.readFile.mockResolvedValueOnce("正文")
    const paths = await importOutlineFolder("E:/Novel", "E:/src")
    expect(paths).toEqual(["E:/Novel/wiki/outlines/src/总大纲.md"])
  })

  it("skips hidden dot-file paths (empty-stem case is gated as hidden before stem extraction)", async () => {
    mocks.readFile.mockResolvedValueOnce("正文")
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/.md"])
    expect(paths).toEqual([])
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("tolerates directory creation failures", async () => {
    mocks.createDirectory.mockRejectedValueOnce(new Error("denied"))
    mocks.readFile.mockResolvedValueOnce("正文")
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/a.md"])
    expect(paths).toEqual(["E:/Novel/wiki/outlines/a.md"])
  })

  it("skips extensionless file names (no dot → empty extension not importable)", async () => {
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/README"])
    expect(paths).toEqual([])
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("renders an empty title heading without body when sanitized content is empty", async () => {
    mocks.readFile.mockResolvedValueOnce("---\ntype: notes\n---")
    await importOutlineFiles("E:/Novel", ["E:/src/blank.md"])
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("# blank")
    expect(content).not.toContain("正文")
  })

  it("falls back to untitled title when file stem is whitespace-only", async () => {
    mocks.readFile.mockResolvedValueOnce("正文")
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/ .md"])
    expect(paths).toEqual(["E:/Novel/wiki/outlines/untitled.md"])
  })

  it("collectImportableFiles skips dirs without children and non-importable files", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/src/empty", name: "empty", is_dir: true, children: [] },
      { path: "E:/src/bare", name: "bare", is_dir: true },
      { path: "E:/src/notes.md", name: "notes.md", is_dir: false },
      { path: "E:/src/archive.zip", name: "archive.zip", is_dir: false },
    ])
    const candidates = await collectOutlineImportCandidatesFromFolder("E:/src")
    expect(candidates).toEqual([
      { path: "E:/src/notes.md", name: "notes.md", targetFolders: ["src"] },
    ])
  })

  it("collectOutlineImportCandidatesFromFolder handles backslash in folder path", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:\\src\\deep\\卷一.md", name: "卷一.md", is_dir: false },
    ])
    const candidates = await collectOutlineImportCandidatesFromFolder("E:\\src")
    expect(candidates[0]!.targetFolders).toEqual(["src", "deep"])
  })

  it("tolerates directory creation failures inside nested target folders", async () => {
    // first createDirectory (wiki/outlines) and segment-level createDirectory
    // both reject — the loop catch inside ensureOutlineDirectory swallows them
    mocks.createDirectory.mockRejectedValue(new Error("denied"))
    mocks.readFile.mockResolvedValueOnce("正文")
    const paths = await importOutlineCandidates("E:/Novel", [
      { path: "E:/src/a.md", name: "a.md", targetFolders: ["src", "sub"] },
    ])
    expect(paths).toEqual(["E:/Novel/wiki/outlines/src/sub/a.md"])
    expect(mocks.writeFile).toHaveBeenCalled()
  })

  it("logs non-Error rejections using String() in importOutlineFiles", async () => {
    mocks.readFile.mockRejectedValueOnce("boom-string")
    const paths = await importOutlineFiles("E:/Novel", ["E:/src/broken.md"])
    expect(paths).toEqual([])
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Outline Import",
      "failed to import file",
      expect.objectContaining({ error: "boom-string" }),
    )
  })

  it("logs non-Error rejections using String() in importOutlineCandidates", async () => {
    mocks.readFile.mockRejectedValueOnce("boom-string")
    const paths = await importOutlineCandidates("E:/Novel", [
      { path: "E:/src/broken.md", name: "broken.md", targetFolders: ["src"] },
    ])
    expect(paths).toEqual([])
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Outline Import",
      "failed to import folder file",
      expect.objectContaining({ error: "boom-string" }),
    )
  })

  it("importOutlineCandidates skips non-importable candidates silently", async () => {
    const paths = await importOutlineCandidates("E:/Novel", [
      { path: "E:/src/archive.zip", name: "archive.zip", targetFolders: ["src"] },
    ])
    expect(paths).toEqual([])
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})
