import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const fsMocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))
const removePageEmbeddingMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/lib/embedding", () => ({ removePageEmbedding: removePageEmbeddingMock }))

import { deleteFile, listDirectory, readFile, writeFile } from "@/commands/fs"
import {
  cascadeDeleteWikiPage,
  cascadeDeleteWikiPagesWithRefs,
} from "./wiki-page-delete"

const mockedDeleteFile = vi.mocked(deleteFile)
const mockedListDirectory = vi.mocked(listDirectory)
const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)

function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

function dir(name: string, path: string, children: FileNode[]): FileNode {
  return { name, path, is_dir: true, children }
}

const wikiTree: FileNode[] = [
  dir("wiki", "/P/wiki", [
    file("index.md", "/P/wiki/index.md"),
    dir("concepts", "/P/wiki/concepts", [
      file("kv-cache.md", "/P/wiki/concepts/kv-cache.md"),
      file("kept.md", "/P/wiki/concepts/kept.md"),
    ]),
    dir("sources", "/P/wiki/sources", [file("foo.md", "/P/wiki/sources/foo.md")]),
    file("notes.txt", "/P/wiki/notes.txt"),
  ]),
]

const kvCacheContent = "---\ntitle: KV Cache\ntype: entity\n---\n# KV Cache\n"
const indexContent = "# Index\n\n- [[KV Cache]]\n- [[Kept]]\n- [[OpenAI]]\n"
const keptContent = [
  "---",
  "title: Kept",
  "related: [kv-cache, kept]",
  "---",
  "",
  "See [[kv-cache]] and [[kept]].",
  "",
].join("\n")

beforeEach(() => {
  vi.clearAllMocks()
  removePageEmbeddingMock.mockResolvedValue(undefined)
  mockedDeleteFile.mockResolvedValue(undefined)
  mockedWriteFile.mockResolvedValue(undefined)
  mockedListDirectory.mockResolvedValue(wikiTree)
  mockedReadFile.mockImplementation(async (path: string) => {
    if (path === "/P/wiki/concepts/kv-cache.md") return kvCacheContent
    if (path === "/P/wiki/index.md") return indexContent
    if (path === "/P/wiki/concepts/kept.md") return keptContent
    throw new Error("no content for " + path)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("cascadeDeleteWikiPage", () => {
  it("deletes the file and drops the page embedding", async () => {
    await cascadeDeleteWikiPage("/P", "/P/wiki/concepts/alpha.md")
    expect(mockedDeleteFile).toHaveBeenCalledWith("/P/wiki/concepts/alpha.md")
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/P", "alpha")
  })

  it("skips embedding removal when the slug is empty", async () => {
    await cascadeDeleteWikiPage("/P", "/P/wiki/empty/")
    expect(removePageEmbeddingMock).not.toHaveBeenCalled()
  })

  it("deletes the media directory for a source page", async () => {
    await cascadeDeleteWikiPage("/P", "/P/wiki/sources/foo.md")
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/P", "foo")
    expect(mockedDeleteFile).toHaveBeenCalledWith("/P/wiki/media/foo")
  })

  it("swallows a missing media directory", async () => {
    mockedDeleteFile.mockImplementation(async (path: string) => {
      if (path === "/P/wiki/media/foo") throw new Error("absent")
      return undefined
    })
    await expect(
      cascadeDeleteWikiPage("/P", "/P/wiki/sources/foo.md"),
    ).resolves.toBeUndefined()
  })

  it("does not touch media for dot-prefixed source slugs", async () => {
    await cascadeDeleteWikiPage("/P", "/P/wiki/sources/.hidden.md")
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/P", ".hidden")
    expect(mockedDeleteFile).not.toHaveBeenCalledWith("/P/wiki/media/.hidden")
  })

  it("does not touch media for non-source pages", async () => {
    await cascadeDeleteWikiPage("/P", "/P/wiki/concepts/alpha.md")
    expect(mockedDeleteFile).not.toHaveBeenCalledWith("/P/wiki/media/alpha")
  })
})

describe("cascadeDeleteWikiPagesWithRefs", () => {
  it("returns an empty result for an empty batch without touching fs", async () => {
    const result = await cascadeDeleteWikiPagesWithRefs("/P", [])
    expect(result).toEqual({ deletedPaths: [], rewrittenFiles: 0 })
    expect(mockedReadFile).not.toHaveBeenCalled()
    expect(mockedDeleteFile).not.toHaveBeenCalled()
    expect(mockedListDirectory).not.toHaveBeenCalled()
  })

  it("returns early when no deletable slug can be derived", async () => {
    const result = await cascadeDeleteWikiPagesWithRefs("/P", ["/P/wiki/"])
    expect(result.deletedPaths).toEqual(["/P/wiki/"])
    expect(mockedListDirectory).not.toHaveBeenCalled()
  })

  it("falls back to slug-only keys when the title cannot be read", async () => {
    mockedReadFile.mockRejectedValue(new Error("gone"))
    mockedListDirectory.mockResolvedValue([])
    const result = await cascadeDeleteWikiPagesWithRefs("/P", ["/P/wiki/concepts/alpha.md"])
    expect(result.deletedPaths).toEqual(["/P/wiki/concepts/alpha.md"])
    expect(result.rewrittenFiles).toBe(0)
  })

  it("warns and skips pages whose deletion fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockedDeleteFile.mockImplementation(async (path: string) => {
      if (path === "/P/wiki/concepts/alpha.md") throw new Error("locked")
      return undefined
    })
    mockedReadFile.mockResolvedValue("")
    mockedListDirectory.mockResolvedValue([])

    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/alpha.md",
      "/P/wiki/concepts/beta.md",
    ])
    expect(result.deletedPaths).toEqual(["/P/wiki/concepts/beta.md"])
    expect(warnSpy).toHaveBeenCalledWith(
      "[wiki-delete] failed to delete /P/wiki/concepts/alpha.md:",
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it("sweeps the wiki: prunes the index, strips wikilinks, filters related arrays", async () => {
    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/kv-cache.md",
    ])

    expect(result.deletedPaths).toEqual(["/P/wiki/concepts/kv-cache.md"])

    // Deleted page itself is skipped from the sweep.
    expect(mockedWriteFile).not.toHaveBeenCalledWith(
      "/P/wiki/concepts/kv-cache.md",
      expect.anything(),
    )

    const writes = new Map<string, string>()
    for (const call of mockedWriteFile.mock.calls) {
      writes.set(call[0] as string, call[1] as string)
    }

    const newIndex = writes.get("/P/wiki/index.md")
    expect(newIndex).toBe("# Index\n\n- [[Kept]]\n- [[OpenAI]]\n")

    const newKept = writes.get("/P/wiki/concepts/kept.md")
    expect(newKept).toContain("related: [\"kept\"]")
    expect(newKept).toContain("See kv-cache and [[kept]]")

    expect(result.rewrittenFiles).toBe(2)
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/P", "kv-cache")
  })

  it("treats any index.md by name as an index listing", async () => {
    mockedListDirectory.mockResolvedValue([
      dir("wiki", "/P/wiki", [
        dir("sub", "/P/wiki/sub", [file("index.md", "/P/wiki/sub/index.md")]),
      ]),
    ])
    mockedReadFile.mockImplementation(async (path: string) => {
      if (path === "/P/wiki/concepts/kv-cache.md") return kvCacheContent
      if (path === "/P/wiki/sub/index.md") return "- [[KV Cache]]\n- [[Kept]]\n"
      throw new Error("no content")
    })

    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/kv-cache.md",
    ])
    expect(result.rewrittenFiles).toBe(1)
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/P/wiki/sub/index.md",
      "- [[Kept]]\n",
    )
  })

  it("does not rewrite files whose content is unchanged", async () => {
    mockedListDirectory.mockResolvedValue([
      dir("wiki", "/P/wiki", [
        file("clean.md", "/P/wiki/clean.md"),
        // a directory with no children property — flattenMd must skip it
        { name: "empty", path: "/P/wiki/empty", is_dir: true },
      ]),
    ])
    mockedReadFile.mockImplementation(async (path: string) => {
      if (path === "/P/wiki/concepts/kv-cache.md") return kvCacheContent
      if (path === "/P/wiki/clean.md") return "no references here\n"
      throw new Error("no content")
    })

    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/kv-cache.md",
    ])
    expect(result.rewrittenFiles).toBe(0)
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("keeps related arrays that do not reference deleted pages", async () => {
    mockedListDirectory.mockResolvedValue([
      dir("wiki", "/P/wiki", [file("clean.md", "/P/wiki/clean.md")]),
    ])
    mockedReadFile.mockImplementation(async (path: string) => {
      if (path === "/P/wiki/concepts/kv-cache.md") return kvCacheContent
      if (path === "/P/wiki/clean.md") {
        return "---\nrelated: [other]\n---\nbody\n"
      }
      throw new Error("no content")
    })

    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/kv-cache.md",
    ])
    expect(result.rewrittenFiles).toBe(0)
  })

  it("skips files that cannot be read during the sweep", async () => {
    mockedListDirectory.mockResolvedValue([
      dir("wiki", "/P/wiki", [file("locked.md", "/P/wiki/locked.md")]),
    ])
    mockedReadFile.mockImplementation(async (path: string) => {
      if (path === "/P/wiki/concepts/kv-cache.md") return kvCacheContent
      if (path === "/P/wiki/locked.md") throw new Error("locked")
      throw new Error("no content")
    })

    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/kv-cache.md",
    ])
    expect(result.rewrittenFiles).toBe(0)
    expect(result.deletedPaths).toEqual(["/P/wiki/concepts/kv-cache.md"])
  })

  it("warns and does not count files whose rewrite fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockedWriteFile.mockRejectedValue(new Error("readonly"))

    const result = await cascadeDeleteWikiPagesWithRefs("/P", [
      "/P/wiki/concepts/kv-cache.md",
    ])
    expect(result.rewrittenFiles).toBe(0)
    expect(warnSpy).toHaveBeenCalledWith(
      "[wiki-delete] failed to rewrite /P/wiki/index.md:",
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it("cascades the media directory when a source page is deleted", async () => {
    const result = await cascadeDeleteWikiPagesWithRefs("/P", ["/P/wiki/sources/foo.md"])
    expect(result.deletedPaths).toEqual(["/P/wiki/sources/foo.md"])
    expect(mockedDeleteFile).toHaveBeenCalledWith("/P/wiki/media/foo")
  })
})
