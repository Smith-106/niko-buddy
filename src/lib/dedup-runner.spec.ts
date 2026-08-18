import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  streamChat: vi.fn(),
  extractEntitySummary: vi.fn(),
  detectDuplicateGroups: vi.fn(),
  mergeDuplicateGroup: vi.fn(),
  rewriteIndexMd: vi.fn(),
  loadNotDuplicates: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  deleteFile: mocks.deleteFile,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("./dedup", () => ({
  extractEntitySummary: mocks.extractEntitySummary,
  detectDuplicateGroups: mocks.detectDuplicateGroups,
  mergeDuplicateGroup: mocks.mergeDuplicateGroup,
  rewriteIndexMd: mocks.rewriteIndexMd,
}))

vi.mock("./dedup-storage", () => ({
  loadNotDuplicates: mocks.loadNotDuplicates,
}))

import {
  buildDedupLlmCall,
  executeMerge,
  loadAllEntitySummaries,
  loadAllWikiPages,
  runDuplicateDetection,
} from "./dedup-runner"
import type { DuplicateGroup, MergeResult } from "./dedup"

const fakeLlmConfig = {} as LlmConfig

function tree(nodes: FileNode[]): FileNode[] {
  return nodes
}

function mdNode(path: string): FileNode {
  const name = path.split("/").pop() ?? path
  return { name, path, is_dir: false }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("buildDedupLlmCall", () => {
  it("accumulates tokens and resolves onDone", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("hel")
      callbacks.onToken("lo")
      callbacks.onDone()
    })
    const call = buildDedupLlmCall(fakeLlmConfig)
    await expect(call("sys", "user", undefined)).resolves.toBe("hello")
    expect(mocks.streamChat).toHaveBeenCalledWith(
      fakeLlmConfig,
      [
        { role: "system", content: "sys" },
        { role: "user", content: "user" },
      ],
      expect.any(Object),
      undefined,
      { temperature: 0.1 },
    )
  })

  it("throws the callback-provided error", async () => {
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("boom"))
      callbacks.onDone()
    })
    const call = buildDedupLlmCall(fakeLlmConfig)
    await expect(call("sys", "user", undefined)).rejects.toThrow("boom")
  })

  it("throws when the promise itself rejects", async () => {
    mocks.streamChat.mockRejectedValue(new Error("network down"))
    const call = buildDedupLlmCall(fakeLlmConfig)
    await expect(call("sys", "user", undefined)).rejects.toThrow("network down")
  })

  it("normalizes non-Error rejections into Error instances", async () => {
    mocks.streamChat.mockRejectedValue("string failure")
    const call = buildDedupLlmCall(fakeLlmConfig)
    await expect(call("sys", "user", undefined)).rejects.toThrow("string failure")
  })
})

describe("loadAllEntitySummaries", () => {
  it("walks wiki/entities and wiki/concepts, skipping unparsable pages", async () => {
    mocks.listDirectory.mockResolvedValue(
      tree([
        {
          name: "entities",
          path: "/P/wiki/entities",
          is_dir: true,
          children: [
            mdNode("/P/wiki/entities/A.md"),
            mdNode("/P/wiki/entities/B.md"),
            mdNode("/P/wiki/entities/note.txt"),
          ],
        },
        {
          name: "concepts",
          path: "/P/wiki/concepts",
          is_dir: true,
          children: [mdNode("/P/wiki/concepts/C.md")],
        },
        { name: "empty-dir", path: "/P/wiki/empty-dir", is_dir: true },
      ]),
    )
    mocks.readFile.mockImplementation(async (p: string) => `content-of-${p}`)
    mocks.extractEntitySummary.mockImplementation((rel: string) =>
      rel.endsWith("A.md") ? { slug: "a", summary: "s" } : null,
    )

    const out = await loadAllEntitySummaries("C:\\P")

    expect(out).toEqual([{ slug: "a", summary: "s" }])
    expect(mocks.readFile).toHaveBeenCalledWith("/P/wiki/entities/A.md")
    expect(mocks.readFile).not.toHaveBeenCalledWith("/P/wiki/entities/note.txt")
  })

  it("swallows read errors and extraction exceptions", async () => {
    mocks.listDirectory.mockResolvedValue(
      tree([mdNode("/P/wiki/entities/Broken.md"), mdNode("/P/wiki/entities/Bad.md")]),
    )
    mocks.readFile.mockRejectedValueOnce(new Error("no read"))
    mocks.extractEntitySummary.mockImplementation(() => {
      throw new Error("no summary")
    })
    const out = await loadAllEntitySummaries("/P")
    expect(out).toEqual([])
  })
})

describe("loadAllWikiPages", () => {
  it("returns relative paths for all markdown under wiki", async () => {
    mocks.listDirectory.mockResolvedValue(
      tree([
        {
          name: "sub",
          path: "/P/wiki/sub",
          is_dir: true,
          children: [mdNode("/P/wiki/sub/Deep.md")],
        },
        mdNode("/P/wiki/index.md"),
      ]),
    )
    mocks.readFile.mockImplementation(async (p: string) => `# ${p}`)
    const pages = await loadAllWikiPages("/P")
    expect(pages).toEqual([
      { path: "wiki/sub/Deep.md", content: "# /P/wiki/sub/Deep.md" },
      { path: "wiki/index.md", content: "# /P/wiki/index.md" },
    ])
  })

  it("skips pages that fail to read", async () => {
    mocks.listDirectory.mockResolvedValue(tree([mdNode("/P/wiki/index.md")]))
    mocks.readFile.mockRejectedValue(new Error("locked"))
    const pages = await loadAllWikiPages("/P")
    expect(pages).toEqual([])
  })
})

describe("runDuplicateDetection", () => {
  it("returns empty when fewer than two summaries exist", async () => {
    mocks.listDirectory.mockResolvedValue(tree([]))
    const out = await runDuplicateDetection("/P", fakeLlmConfig)
    expect(out).toEqual([])
    expect(mocks.loadNotDuplicates).not.toHaveBeenCalled()
  })

  it("delegates to detectDuplicateGroups with not-duplicates whitelist and signal", async () => {
    mocks.listDirectory.mockResolvedValue(
      tree([mdNode("/P/wiki/entities/A.md"), mdNode("/P/wiki/entities/B.md")]),
    )
    mocks.readFile.mockResolvedValue("---\ntype: entity\n---\nbody")
    mocks.extractEntitySummary.mockImplementation((rel: string) => ({ slug: rel, summary: "s" }))
    mocks.loadNotDuplicates.mockResolvedValue([["a", "b"]])
    const group: DuplicateGroup = { slugs: ["a", "b"], reason: "same", confidence: "high" }
    mocks.detectDuplicateGroups.mockResolvedValue([group])
    const signal = new AbortController().signal

    const out = await runDuplicateDetection("/P", fakeLlmConfig, { signal })

    expect(out).toEqual([group])
    expect(mocks.loadNotDuplicates).toHaveBeenCalledWith("/P")
    expect(mocks.detectDuplicateGroups).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function),
      { signal, notDuplicates: [["a", "b"]] },
    )
  })
})

describe("executeMerge", () => {
  const mergeResult: MergeResult = {
    canonicalPath: "wiki/entities/canon.md",
    canonicalContent: "# Canon merged",
    rewrites: [{ path: "wiki/entities/B.md", newContent: "[[canon]]" }],
    pagesToDelete: ["wiki/entities/A.md"],
    backup: [{ path: "wiki/entities/A.md", content: "old A" }],
  }

  beforeEach(() => {
    mocks.mergeDuplicateGroup.mockResolvedValue(mergeResult)
    mocks.rewriteIndexMd.mockImplementation((content: string, removed: Set<string>) =>
      removed.size > 0 ? `${content}\nrewritten` : content,
    )
  })

  function pagesFixture(): FileNode[] {
    return tree([
      {
        name: "entities",
        path: "/P/wiki/entities",
        is_dir: true,
        children: [mdNode("/P/wiki/entities/A.md"), mdNode("/P/wiki/entities/B.md")],
      },
      mdNode("/P/wiki/index.md"),
    ])
  }

  it("executes the full merge pipeline and rewrites index.md", async () => {
    mocks.listDirectory.mockResolvedValue(pagesFixture())
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("A.md")) return "A content"
      if (p.endsWith("B.md")) return "B content"
      return "# Index"
    })
    const group: DuplicateGroup = { slugs: ["A", "B"], reason: "dup", confidence: "high" }

    const result = await executeMerge("/P", group, "A", fakeLlmConfig)

    expect(result).toBe(mergeResult)
    expect(mocks.mergeDuplicateGroup).toHaveBeenCalledWith(
      {
        group: [
          { slug: "A", path: "wiki/entities/A.md", content: "A content" },
          { slug: "B", path: "wiki/entities/B.md", content: "B content" },
        ],
        canonicalSlug: "A",
        otherWikiPages: [{ path: "wiki/index.md", content: "# Index" }],
      },
      expect.any(Function),
      { signal: undefined },
    )
    // snapshot + canonical + rewrites
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\/P\/\.qmai\/page-history\/dedup-/),
      "old A",
    )
    expect(mocks.writeFile).toHaveBeenCalledWith("/P/wiki/entities/canon.md", "# Canon merged")
    expect(mocks.writeFile).toHaveBeenCalledWith("/P/wiki/entities/B.md", "[[canon]]")
    expect(mocks.deleteFile).toHaveBeenCalledWith("/P/wiki/entities/A.md")
    expect(mocks.rewriteIndexMd).toHaveBeenCalledWith("# Index", expect.any(Set))
    expect(mocks.writeFile).toHaveBeenCalledWith("/P/wiki/index.md", "# Index\nrewritten")
  })

  it("ignores non-markdown pages while resolving duplicate slugs", async () => {
    mocks.listDirectory.mockResolvedValue(tree([
      mdNode("/P/wiki/entities/A.md"),
      mdNode("/P/wiki/entities/B.md"),
      mdNode("/P/wiki/entities/notes.txt"),
    ]))
    mocks.readFile.mockResolvedValue("content")

    await executeMerge("/P", { slugs: ["A", "B"], reason: "dup", confidence: "high" }, "A", fakeLlmConfig)

    expect(mocks.mergeDuplicateGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        group: expect.arrayContaining([
          expect.objectContaining({ slug: "A" }),
          expect.objectContaining({ slug: "B" }),
        ]),
      }),
      expect.any(Function),
      expect.anything(),
    )
  })

  it("throws when a group slug cannot be resolved on disk", async () => {
    mocks.listDirectory.mockResolvedValue(pagesFixture())
    mocks.readFile.mockResolvedValue("content")
    const group: DuplicateGroup = { slugs: ["A", "Ghost"], reason: "dup", confidence: "high" }
    await expect(executeMerge("/P", group, "A", fakeLlmConfig)).rejects.toThrow(
      'Slug "Ghost" not found on disk',
    )
  })

  it("continues when deleting a merged-away page fails", async () => {
    mocks.listDirectory.mockResolvedValue(pagesFixture())
    mocks.readFile.mockResolvedValue("content")
    mocks.deleteFile.mockRejectedValue(new Error("permission"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await executeMerge("/P", { slugs: ["A", "B"], reason: "dup", confidence: "high" }, "A", fakeLlmConfig)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to delete"))
    warn.mockRestore()
  })

  it("skips index rewrite when index.md is absent", async () => {
    mocks.listDirectory.mockResolvedValue(
      tree([
        {
          name: "entities",
          path: "/P/wiki/entities",
          is_dir: true,
          children: [mdNode("/P/wiki/entities/A.md"), mdNode("/P/wiki/entities/B.md")],
        },
      ]),
    )
    mocks.readFile.mockResolvedValue("content")
    await executeMerge("/P", { slugs: ["A", "B"], reason: "dup", confidence: "high" }, "A", fakeLlmConfig)
    expect(mocks.rewriteIndexMd).not.toHaveBeenCalled()
  })

  it("does not rewrite index when content is unchanged", async () => {
    mocks.listDirectory.mockResolvedValue(pagesFixture())
    mocks.readFile.mockImplementation(async (p: string) => (p.endsWith("index.md") ? "plain" : "content"))
    mocks.rewriteIndexMd.mockReturnValue("plain")
    await executeMerge("/P", { slugs: ["A", "B"], reason: "dup", confidence: "high" }, "A", fakeLlmConfig)
    expect(mocks.writeFile).not.toHaveBeenCalledWith("/P/wiki/index.md", "plain")
  })
})
