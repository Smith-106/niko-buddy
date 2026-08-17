import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode, WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"

const fsState = vi.hoisted(() => {
  const calls = {
    copyDirectory: vi.fn(),
    copyFile: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
    listDirectory: vi.fn(),
    preprocessFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  }
  return calls
})
const enqueueBatchMock = vi.hoisted(() => vi.fn())
const removeFromIngestCacheMock = vi.hoisted(() => vi.fn())
const removePageEmbeddingMock = vi.hoisted(() => vi.fn())
const cascadeDeleteWikiPagesWithRefsMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => fsState)
vi.mock("@/lib/ingest-queue", () => ({ enqueueBatch: enqueueBatchMock }))
vi.mock("@/lib/ingest-cache", () => ({ removeFromIngestCache: removeFromIngestCacheMock }))
vi.mock("@/lib/embedding", () => ({ removePageEmbedding: removePageEmbeddingMock }))
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPagesWithRefs: cascadeDeleteWikiPagesWithRefsMock,
}))

import {
  cleanupDeletedWikiPages,
  deleteSourceFile,
  deleteSourceFiles,
  deleteSourceFolder,
  enqueueSourceIngest,
  folderContextForSourcePath,
  importSourceFiles,
  importSourceFolder,
  isIngestableSourcePath,
} from "./source-lifecycle"

const project: WikiProject = { id: "proj-1", name: "P", path: "/P" }
const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxContextSize: 128000,
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  reasoning: { mode: "off" },
}

function mdFile(name: string, path: string, content = ""): FileNode {
  return { name, path, is_dir: false }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── isIngestableSourcePath ────────────────────────────────────────────────────

describe("isIngestableSourcePath", () => {
  it("accepts known extensions case-insensitively", () => {
    expect(isIngestableSourcePath("/x/report.md")).toBe(true)
    expect(isIngestableSourcePath("/x/report.PDF")).toBe(true)
    expect(isIngestableSourcePath("/x/data.csv")).toBe(true)
    expect(isIngestableSourcePath("/x/file.docx")).toBe(true)
  })

  it("rejects .cache paths, dotfiles, extensionless files, and unknown extensions", () => {
    expect(isIngestableSourcePath("/x/raw/sources/.cache/foo.txt")).toBe(false)
    expect(isIngestableSourcePath("/x/.hidden.md")).toBe(false)
    expect(isIngestableSourcePath("/x/noext")).toBe(false)
    expect(isIngestableSourcePath("/x/file.exe")).toBe(false)
  })
})

// ── folderContextForSourcePath ────────────────────────────────────────────────

describe("folderContextForSourcePath", () => {
  it("derives a breadcrumb from the relative path under sourcesRoot", () => {
    expect(folderContextForSourcePath("/P/raw/sources/AI-Research/papers/paper1.pdf")).toBe("AI-Research > papers")
  })

  it("falls back to the /raw/sources/ marker position", () => {
    expect(folderContextForSourcePath("/somewhere/raw/sources/books/fantasy/book1.txt")).toBe("books > fantasy")
  })

  it("returns an empty context for files directly under the root", () => {
    expect(folderContextForSourcePath("/P/raw/sources/file.md")).toBe("")
  })

  it("respects a custom sourcesRoot", () => {
    expect(folderContextForSourcePath("raw/inbox/a/b/file.md", "raw/inbox")).toBe("a > b")
  })

  it("keeps the whole path when neither root nor marker matches", () => {
    expect(folderContextForSourcePath("/P/raw/inbox/a/b/file.md")).toBe(" > P > raw > inbox > a > b")
  })
})

// ── enqueueSourceIngest ───────────────────────────────────────────────────────

describe("enqueueSourceIngest", () => {
  it("returns [] when the LLM is unusable", async () => {
    expect(await enqueueSourceIngest(project, ["/P/raw/sources/a.md"], { ...llmConfig, apiKey: "", model: "" })).toEqual([])
    expect(enqueueBatchMock).not.toHaveBeenCalled()
  })

  it("returns [] when no files are ingestable", async () => {
    expect(await enqueueSourceIngest(project, ["/P/raw/sources/archive.zip"], llmConfig)).toEqual([])
    expect(enqueueBatchMock).not.toHaveBeenCalled()
  })

  it("enqueues ingestable files with folder context and root context", async () => {
    enqueueBatchMock.mockResolvedValueOnce(["t1", "t2"])
    const ids = await enqueueSourceIngest(project, ["/P/raw/sources/a/f1.md", "/P/raw/sources/a/f2.txt", "/P/raw/sources/a/skip.zip"], llmConfig, { rootContext: "Inbox" })
    expect(ids).toEqual(["t1", "t2"])
    expect(enqueueBatchMock).toHaveBeenCalledWith("proj-1", [
      { sourcePath: "/P/raw/sources/a/f1.md", folderContext: "Inbox > a" },
      { sourcePath: "/P/raw/sources/a/f2.txt", folderContext: "Inbox > a" },
    ])
  })

  it("applies the root context directly when a file has no folder context", async () => {
    enqueueBatchMock.mockResolvedValueOnce(["t1"])
    await enqueueSourceIngest(project, ["/P/raw/sources/file.md"], llmConfig, { rootContext: "Inbox" })
    expect(enqueueBatchMock).toHaveBeenCalledWith("proj-1", [
      { sourcePath: "/P/raw/sources/file.md", folderContext: "Inbox" },
    ])
  })
})

// ── importSourceFiles ─────────────────────────────────────────────────────────

describe("importSourceFiles", () => {
  it("copies files to unique destinations and auto-extracts by default", async () => {
    fsState.fileExists.mockResolvedValue(false)
    fsState.copyFile.mockResolvedValue(undefined)
    fsState.preprocessFile.mockResolvedValue(undefined)
    enqueueBatchMock.mockResolvedValue(["t1"])

    const result = await importSourceFiles(project, ["/src/doc.md"], llmConfig)
    expect(fsState.copyFile).toHaveBeenCalledWith("/src/doc.md", "/P/raw/sources/doc.md")
    expect(fsState.preprocessFile).toHaveBeenCalled()
    expect(result.importedPaths).toEqual(["/P/raw/sources/doc.md"])
    expect(result.taskIdsByPath).toEqual({ "/P/raw/sources/doc.md": ["t1"] })
  })

  it("ignores preprocessing failures after copying files", async () => {
    fsState.fileExists.mockResolvedValue(false)
    fsState.copyFile.mockResolvedValue(undefined)
    fsState.preprocessFile.mockRejectedValue(new Error("preprocess boom"))
    enqueueBatchMock.mockResolvedValue([])
    const result = await importSourceFiles(project, ["/src/doc.md"], llmConfig)
    expect(result.importedPaths).toEqual(["/P/raw/sources/doc.md"])
    await Promise.resolve()
    await Promise.resolve()
  })

  it("maps task ids only for ingestable paths present in the response", async () => {
    fsState.fileExists.mockResolvedValue(false)
    fsState.copyFile.mockResolvedValue(undefined)
    fsState.preprocessFile.mockResolvedValue(undefined)
    // enqueueBatch returns fewer ids than files → missing ids are skipped
    enqueueBatchMock.mockResolvedValue(["t1"])
    const result = await importSourceFiles(project, ["/src/one.md", "/src/two.md"], llmConfig)
    expect(result.taskIdsByPath["/P/raw/sources/one.md"]).toEqual(["t1"])
    expect(result.taskIdsByPath["/P/raw/sources/two.md"]).toBeUndefined()
  })

  it("appends a date suffix when the destination already exists", async () => {
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/raw/sources/doc.md")
    fsState.copyFile.mockResolvedValue(undefined)
    enqueueBatchMock.mockResolvedValue([])
    await importSourceFiles(project, ["/src/doc.md"], llmConfig, { autoExtract: false })
    const destCalls = fsState.copyFile.mock.calls.map((c) => c[1])
    expect(destCalls[0]).toMatch(/doc-\d{8}\.md$/)
  })

  it("falls back to a Date.now() suffix when 99 numbered variants exist", async () => {
    fsState.fileExists.mockImplementation(async () => true)
    fsState.copyFile.mockResolvedValue(undefined)
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now)
    await importSourceFiles(project, ["/src/doc.md"], llmConfig, { autoExtract: false })
    const destCalls = fsState.copyFile.mock.calls.map((c) => c[1])
    expect(destCalls[0]).toBe(`/P/raw/sources/doc-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${now}.md`)
    vi.restoreAllMocks()
  })

  it("logs a copy failure and continues with other files", async () => {
    fsState.fileExists.mockResolvedValue(false)
    fsState.copyFile
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined)
    enqueueBatchMock.mockResolvedValue(["t2"])
    const result = await importSourceFiles(project, ["/src/bad.md", "/src/good.md"], llmConfig, { autoExtract: false })
    expect(result.importedPaths).toEqual(["/P/raw/sources/good.md"])
  })

  it("falls back to the unknown name for an empty source path", async () => {
    fsState.fileExists.mockResolvedValue(false)
    fsState.copyFile.mockResolvedValue(undefined)
    await importSourceFiles(project, [""], llmConfig, { autoExtract: false })
    expect(fsState.copyFile).toHaveBeenCalledWith("", "/P/raw/sources/unknown")
  })

  it("handles extensionless source files when the base exists", async () => {
    fsState.fileExists.mockImplementation(async (p: string) => p === "/P/raw/sources/noext")
    fsState.copyFile.mockResolvedValue(undefined)
    await importSourceFiles(project, ["/src/noext"], llmConfig, { autoExtract: false })
    const dest = fsState.copyFile.mock.calls[0][1]
    expect(dest).toMatch(/noext-\d{8}$/)
  })

  it("walks numbered variants when the dated name also exists", async () => {
    // Date-derived name must be computed from the run date (not hard-coded),
    // otherwise this test breaks on the next calendar day.
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    fsState.fileExists.mockImplementation(async (p: string) =>
      p === "/P/raw/sources/doc.md" || p === `/P/raw/sources/doc-${date}.md`,
    )
    fsState.copyFile.mockResolvedValue(undefined)
    await importSourceFiles(project, ["/src/doc.md"], llmConfig, { autoExtract: false })
    const dest = fsState.copyFile.mock.calls[0][1]
    expect(dest).toBe(`/P/raw/sources/doc-${date}-2.md`)
  })
})

// ── importSourceFolder ────────────────────────────────────────────────────────

describe("importSourceFolder", () => {
  it("copies the folder and preprocesses every copied file", async () => {
    fsState.copyDirectory.mockResolvedValue(["/P/raw/sources/inbox/a.md", "/P/raw/sources/inbox/b.txt"])
    fsState.preprocessFile.mockResolvedValue(undefined)
    enqueueBatchMock.mockResolvedValue(["t1", "t2"])
    const result = await importSourceFolder(project, "/sel/folder", llmConfig)
    expect(fsState.copyDirectory).toHaveBeenCalledWith("/sel/folder", "/P/raw/sources/folder")
    expect(fsState.preprocessFile).toHaveBeenCalledTimes(2)
    expect(result.importedPaths).toHaveLength(2)
    expect(result.taskIdsByPath["/P/raw/sources/inbox/a.md"]).toEqual(["t1"])
    expect(result.taskIdsByPath["/P/raw/sources/inbox/b.txt"]).toEqual(["t2"])
  })

  it("ignores preprocessing failures after copying a folder", async () => {
    fsState.copyDirectory.mockResolvedValue(["/P/raw/sources/inbox/a.md"])
    fsState.preprocessFile.mockRejectedValue(new Error("preprocess boom"))
    enqueueBatchMock.mockResolvedValue([])
    const result = await importSourceFolder(project, "/sel/folder", llmConfig)
    expect(result.importedPaths).toEqual(["/P/raw/sources/inbox/a.md"])
    await Promise.resolve()
    await Promise.resolve()
  })

  it("skips ingest with autoExtract: false", async () => {
    fsState.copyDirectory.mockResolvedValue(["/P/raw/sources/folder/a.md"])
    const result = await importSourceFolder(project, "/sel/folder", llmConfig, { autoExtract: false })
    expect(result.taskIdsByPath).toEqual({})
    expect(enqueueBatchMock).not.toHaveBeenCalled()
  })

  it("falls back to the imported folder name for an empty selection", async () => {
    fsState.copyDirectory.mockResolvedValue([])
    enqueueBatchMock.mockResolvedValue([])
    const result = await importSourceFolder(project, "", llmConfig, { autoExtract: false })
    expect(fsState.copyDirectory).toHaveBeenCalledWith("", "/P/raw/sources/imported")
    expect(result.importedPaths).toEqual([])
  })
})

// ── deleteSourceFiles ─────────────────────────────────────────────────────────

describe("deleteSourceFiles", () => {
  function wikiFiles(files: FileNode[]): FileNode[] {
    return [{ name: "wiki", path: "/P/wiki", is_dir: true, children: files }]
  }

  it("returns empty results when no file names can be derived", async () => {
    const result = await deleteSourceFiles("/P", ["/"], {})
    expect(result).toEqual({ deletedWikiPaths: [], rewrittenSourcePages: 0, skippedPages: 0 })
  })

  it("skips pages whose sources do not include any deleted file", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue(wikiFiles([
      mdFile("other.md", "/P/wiki/entities/other.md"),
      mdFile("notes.txt", "/P/wiki/notes.txt"),
    ]))
    fsState.readFile.mockResolvedValue("---\nsources: [unrelated.md]\n---\nbody")
    fsState.writeFile.mockResolvedValue(undefined)
    const result = await deleteSourceFiles("/P", ["/P/a.md"], {})
    expect(result.rewrittenSourcePages).toBe(0)
    // 页面正文不被重写；只有删除日志文件被追加
    const pageWrites = fsState.writeFile.mock.calls.filter(([p]) => String(p).includes("entities") || String(p).endsWith("notes.txt"))
    expect(pageWrites).toHaveLength(0)
    expect(fsState.writeFile).toHaveBeenCalledWith("/P/wiki/log.md", expect.stringContaining("a.md"))
  })

  it("tolerates directory nodes without children during the wiki scan", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    // A dir node with no `children` array (flattenMd walks past it)
    fsState.listDirectory.mockResolvedValue([{ name: "wiki", path: "/P/wiki", is_dir: true }])
    fsState.readFile.mockResolvedValue("---\nsources: [a.md]\n---\nbody")
    fsState.writeFile.mockResolvedValue(undefined)
    cascadeDeleteWikiPagesWithRefsMock.mockResolvedValue({ deletedPaths: [] })
    const result = await deleteSourceFiles("/P", ["/P/a.md"], {})
    // No pages were scanned, so nothing rewritten and nothing cascade-deleted
    expect(result.rewrittenSourcePages).toBe(0)
    expect(cascadeDeleteWikiPagesWithRefsMock).not.toHaveBeenCalled()
    expect(fsState.writeFile).toHaveBeenCalledWith("/P/wiki/log.md", expect.stringContaining("a.md"))
  })

  it("deletes the source file, cache artifacts, and source-derived wiki pages", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue(wikiFiles([
      mdFile("only-from-a.md", "/P/wiki/entities/only-from-a.md"),
      mdFile("shared.md", "/P/wiki/entities/shared.md"),
    ]))
    fsState.readFile.mockImplementation(async (path: string) =>
      String(path).endsWith("only-from-a.md")
        ? "---\nsources: [a.md]\n---\nbody"
        : "---\nsources: [a.md, b.md]\n---\nbody",
    )
    fsState.writeFile.mockResolvedValue(undefined)
    cascadeDeleteWikiPagesWithRefsMock.mockResolvedValue({ deletedPaths: ["/P/wiki/entities/only-from-a.md"] })

    const result = await deleteSourceFiles("/P", ["/P/raw/sources/a.md"], {})
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/raw/sources/a.md")
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/raw/sources/.cache/a.md.txt")
    expect(removeFromIngestCacheMock).toHaveBeenCalledWith("/P", "a.md")
    // shared page rewritten, exclusive page cascade-deleted
    expect(fsState.writeFile).toHaveBeenCalled()
    expect(cascadeDeleteWikiPagesWithRefsMock).toHaveBeenCalledWith("/P", ["/P/wiki/entities/only-from-a.md"])
    expect(result.deletedWikiPaths).toEqual(["/P/wiki/entities/only-from-a.md"])
    expect(result.rewrittenSourcePages).toBe(1)
    expect(result.skippedPages).toBe(0)
    // delete log appended
    expect(fsState.writeFile).toHaveBeenCalledWith("/P/wiki/log.md", expect.stringContaining("a.md"))
  })

  it("skips pages without parseable sources and counts them", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue(wikiFiles([mdFile("nosources.md", "/P/wiki/entities/nosources.md")]))
    fsState.readFile.mockResolvedValue("---\ntitle: X\n---\nbody")
    const result = await deleteSourceFiles("/P", ["/P/a.md"], {})
    expect(result.skippedPages).toBe(1)
  })

  it("handles unreadable wiki pages as skipped", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue(wikiFiles([mdFile("x.md", "/P/wiki/entities/x.md")]))
    fsState.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    const result = await deleteSourceFiles("/P", ["/P/a.md"], {})
    expect(result.skippedPages).toBe(1)
  })

  it("does not delete the source file when fileAlreadyDeleted is set", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([])
    const result = await deleteSourceFiles("/P", ["/P/a.md"], { fileAlreadyDeleted: true })
    expect(fsState.deleteFile).not.toHaveBeenCalledWith("/P/a.md")
    expect(result.deletedWikiPaths).toEqual([])
  })

  it("tolerates a failing wiki scan", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockRejectedValueOnce(new Error("ENOENT"))
    const result = await deleteSourceFiles("/P", ["/P/a.md"], {})
    expect(result).toMatchObject({ deletedWikiPaths: [], rewrittenSourcePages: 0 })
  })

  it("tolerates a failing cache deletion and ingest-cache removal", async () => {
    fsState.deleteFile
      .mockResolvedValueOnce(undefined) // source file
      .mockRejectedValueOnce(new Error("no cache")) // .cache file
    fsState.listDirectory.mockResolvedValue([])
    removeFromIngestCacheMock.mockRejectedValueOnce(new Error("boom"))
    const result = await deleteSourceFiles("/P", ["/P/a.md"], {})
    expect(result.deletedWikiPaths).toEqual([])
  })

  it("rewrites a shared page and appends a multi-file delete log", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue(wikiFiles([mdFile("shared.md", "/P/wiki/entities/shared.md")]))
    fsState.readFile.mockResolvedValue("---\nsources: [a.md, b.md, c.md]\n---\nbody")
    fsState.writeFile.mockResolvedValue(undefined)
    const result = await deleteSourceFiles("/P", ["/P/a.md", "/P/b.md"], { logReason: "整理" })
    expect(result.rewrittenSourcePages).toBe(1)
    const logCalls = fsState.writeFile.mock.calls.filter((c) => String(c[0]).endsWith("/wiki/log.md"))
    expect(logCalls[0][1]).toContain("2 个源文件")
    expect(logCalls[0][1]).toContain("源文件：")
    expect(logCalls[0][1]).toContain("- a.md")
  })

  it("tolerates a failing rewrite of a shared source page", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue(wikiFiles([mdFile("shared.md", "/P/wiki/entities/shared.md")]))
    fsState.readFile.mockResolvedValue("---\nsources: [a.md, b.md]\n---\nbody")
    fsState.writeFile.mockRejectedValueOnce(new Error("readonly"))
    const result = await deleteSourceFiles("/P", ["/P/a.md"])
    expect(result.rewrittenSourcePages).toBe(0)
  })

  it("falls back to the default log header when the log file is unreadable", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([])
    fsState.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    fsState.writeFile.mockResolvedValue(undefined)
    const result = await deleteSourceFiles("/P", ["/P/a.md"], { logReason: "整理" })
    const logCalls = fsState.writeFile.mock.calls.filter((c) => String(c[0]).endsWith("/wiki/log.md"))
    expect(logCalls[0][1]).toContain("# Wiki Log")
    expect(result.deletedWikiPaths).toEqual([])
  })

  it("tolerates a failing delete-log write", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([])
    fsState.readFile.mockResolvedValue("# Wiki Log\n")
    fsState.writeFile.mockRejectedValueOnce(new Error("disk full"))
    const result = await deleteSourceFiles("/P", ["/P/a.md"], { logReason: "整理" })
    expect(result.deletedWikiPaths).toEqual([])
  })
})

// ── deleteSourceFile / deleteSourceFolder ─────────────────────────────────────

describe("deleteSourceFile / deleteSourceFolder", () => {
  it("deleteSourceFile wraps deleteSourceFiles", async () => {
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([])
    const result = await deleteSourceFile("/P", "/P/a.md")
    expect(result).toEqual({ deletedWikiPaths: [], rewrittenSourcePages: 0 })
  })

  it("deleteSourceFolder collects files and deletes the folder", async () => {
    const folder: FileNode = {
      name: "sub",
      path: "/P/raw/sources/sub",
      is_dir: true,
      children: [
        mdFile("a.md", "/P/raw/sources/sub/a.md"),
        mdFile("b.txt", "/P/raw/sources/sub/b.txt"),
      ],
    }
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([])
    const result = await deleteSourceFolder("/P", folder)
    expect(result.deletedWikiPaths).toEqual([])
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/raw/sources/sub")
  })

  it("deleteSourceFolder tolerates an empty folder", async () => {
    const folder: FileNode = { name: "empty", path: "/P/raw/sources/empty", is_dir: true }
    fsState.deleteFile.mockResolvedValue(undefined)
    const result = await deleteSourceFolder("/P", folder)
    expect(result.deletedWikiPaths).toEqual([])
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/raw/sources/empty")
  })

  it("deleteSourceFolder tolerates a failing folder delete", async () => {
    const folder: FileNode = {
      name: "sub",
      path: "/P/raw/sources/sub",
      is_dir: true,
      children: [mdFile("a.md", "/P/raw/sources/sub/a.md")],
    }
    fsState.deleteFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("/sub")) throw new Error("busy")
      return undefined
    })
    fsState.listDirectory.mockResolvedValue([])
    const result = await deleteSourceFolder("/P", folder)
    expect(result.deletedWikiPaths).toEqual([])
  })

  it("deleteSourceFolder honors folderAlreadyDeleted", async () => {
    const folder: FileNode = {
      name: "sub",
      path: "/P/raw/sources/sub",
      is_dir: true,
      children: [mdFile("a.md", "/P/raw/sources/sub/a.md")],
    }
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([])
    await deleteSourceFolder("/P", folder, { folderAlreadyDeleted: true })
    // folder itself NOT deleted again
    expect(fsState.deleteFile).not.toHaveBeenCalledWith("/P/raw/sources/sub")
  })
})

// ── cleanupDeletedWikiPages ───────────────────────────────────────────────────

describe("cleanupDeletedWikiPages", () => {
  it("returns early when no valid slugs remain", async () => {
    await cleanupDeletedWikiPages("/P", [".hidden", ""])
    expect(removePageEmbeddingMock).not.toHaveBeenCalled()
  })

  it("removes embeddings, media dirs, and rewrites references", async () => {
    removePageEmbeddingMock.mockResolvedValue(undefined)
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([
      {
        name: "wiki",
        path: "/P/wiki",
        is_dir: true,
        children: [
          mdFile("index.md", "/P/wiki/index.md"),
          mdFile("foo.md", "/P/wiki/foo.md"),
          mdFile("other.md", "/P/wiki/other.md"),
        ],
      },
    ])
    fsState.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("index.md")) {
        return ["---", "title: Index", "---", "", "# Index", "", "[[gone-page]] still here"].join("\n")
      }
      if (p.endsWith("foo.md")) {
        return "---\nrelated: [gone-page, keep]\n---\n[[gone-page]] body"
      }
      return "---\ntitle: Other\n---\nbody [[gone-page]]"
    })
    fsState.writeFile.mockResolvedValue(undefined)

    await cleanupDeletedWikiPages("/P", ["wiki/entities/gone-page.md"])

    // embedding removed + media dir deleted
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/P", "gone-page")
    expect(fsState.deleteFile).toHaveBeenCalledWith("/P/wiki/media/gone-page")
    // index listing cleaned + wikilinks stripped everywhere
    const indexWrite = fsState.writeFile.mock.calls.find((c) => String(c[0]).endsWith("index.md"))
    expect(indexWrite).toBeTruthy()
    expect(indexWrite[1]).not.toContain("[[gone-page]]")
    // related frontmatter filtered on foo.md
    const fooWrite = fsState.writeFile.mock.calls.find((c) => String(c[0]).endsWith("foo.md"))
    expect(fooWrite).toBeTruthy()
    expect(fooWrite[1]).not.toContain("related: [gone-page")
  })

  it("tolerates a failing media delete and unreadable files", async () => {
    removePageEmbeddingMock.mockResolvedValue(undefined)
    fsState.deleteFile.mockRejectedValueOnce(new Error("gone")).mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([
      { name: "wiki", path: "/P/wiki", is_dir: true, children: [mdFile("x.md", "/P/wiki/x.md")] },
    ])
    fsState.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    await expect(cleanupDeletedWikiPages("/P", ["wiki/x.md"])).resolves.toBeUndefined()
  })

  it("tolerates a failing rewrite", async () => {
    removePageEmbeddingMock.mockResolvedValue(undefined)
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([
      { name: "wiki", path: "/P/wiki", is_dir: true, children: [mdFile("x.md", "/P/wiki/x.md")] },
    ])
    fsState.readFile.mockResolvedValue("---\nrelated: [gone-page]\n---\n[[gone-page]]")
    fsState.writeFile.mockRejectedValueOnce(new Error("readonly"))
    await expect(cleanupDeletedWikiPages("/P", ["wiki/x.md"])).resolves.toBeUndefined()
  })

  it("tolerates a failing rewrite that actually changes the page", async () => {
    // The page must contain a reference to the DELETED slug for the rewrite
    // to fire; a failing write then lands in the per-page catch.
    removePageEmbeddingMock.mockResolvedValue(undefined)
    fsState.deleteFile.mockResolvedValue(undefined)
    fsState.listDirectory.mockResolvedValue([
      { name: "wiki", path: "/P/wiki", is_dir: true, children: [mdFile("foo.md", "/P/wiki/foo.md")] },
    ])
    fsState.readFile.mockResolvedValue("---\nrelated: [foo]\n---\n[[foo]] body")
    fsState.writeFile.mockRejectedValueOnce(new Error("readonly"))
    await expect(cleanupDeletedWikiPages("/P", ["wiki/foo.md"])).resolves.toBeUndefined()
  })
})
