import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  searchWiki,
  tokenizeQuery,
  type SearchWikiOptions,
} from "./search"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  wikiGetState: vi.fn(),
  searchByEmbedding: vi.fn(),
  rerankCandidates: vi.fn(),
  sanitizeEntitySlug: vi.fn((raw: string) => raw),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/novel/graph-adapter", () => ({
  sanitizeEntitySlug: mocks.sanitizeEntitySlug,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.wikiGetState },
}))

vi.mock("@/lib/embedding", () => ({
  searchByEmbedding: mocks.searchByEmbedding,
}))

vi.mock("@/lib/rerank", () => ({
  rerankCandidates: mocks.rerankCandidates,
}))

const mdFile = (path: string, name: string): FileNode => ({
  id: path,
  path,
  name,
  is_dir: false,
  children: undefined,
})

const dirNode = (path: string, name: string, children: FileNode[]): FileNode => ({
  id: path,
  path,
  name,
  is_dir: true,
  children,
})

const PP = "C:/proj"

function defaultEmbeddingState(enabled = true, model = "text-embedding"): void {
  mocks.wikiGetState.mockReturnValue({ embeddingConfig: { enabled, model } })
}

describe("tokenizeQuery", () => {
  it("splits on whitespace and punctuation, lowercases, drops single chars and stop words", () => {
    expect(tokenizeQuery("Hello, WORLD！")).toEqual(["hello", "world"])
    expect(tokenizeQuery("the quick fox")).toEqual(["quick", "fox"])
    expect(tokenizeQuery("a b c")).toEqual([])
    expect(tokenizeQuery("2024-Q3 总资产。")).toContain("2024")
    expect(tokenizeQuery("2024-Q3 总资产。")).toContain("总资产")
  })

  it("splits CJK tokens into bigrams, chars and the original token", () => {
    expect(tokenizeQuery("默会知识")).toEqual(["默会", "会知", "知识", "默", "会", "知", "识", "默会知识"])
  })

  it("skips single-char stop words inside CJK tokens", () => {
    expect(tokenizeQuery("的的的")).toEqual(["的的", "的的的"])
  })

  it("deduplicates repeated tokens", () => {
    expect(tokenizeQuery("foo foo foo")).toEqual(["foo"])
  })
})

describe("searchWiki — guard and token pass", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultEmbeddingState(false)
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockResolvedValue("")
    mocks.searchByEmbedding.mockResolvedValue([])
    mocks.rerankCandidates.mockResolvedValue([])
  })

  it("returns [] for a blank query without touching the fs", async () => {
    await expect(searchWiki(PP, "   ")).resolves.toEqual([])
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("walks nested directories, scores files and extracts titles/images", async () => {
    mocks.listDirectory.mockResolvedValue([
      dirNode(`${PP}/wiki/sub`, "sub", [mdFile(`${PP}/wiki/sub/alpha.md`, "alpha.md")]),
      mdFile(`${PP}/wiki/attention.md`, "attention.md"),
      mdFile(`${PP}/wiki/notes.md`, "notes.md"),
      mdFile(`${PP}/wiki/plan.txt`, "plan.txt"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("alpha.md")) {
        return `---\ntitle: "阿尔法"\n---\n# 阿尔法\n\n![图1](img/a.png)\n![图1](img/a.png)\n![图2](img/b.png)\n\nattention 内容 alpha`
      }
      if (p.endsWith("attention.md")) return "# 注意力\n\n关于注意力机制的笔记。"
      return "# 笔记\n\n随便写点什么。"
    })

    const results = await searchWiki(PP, "attention", { includeVector: false })
    expect(results[0].path).toBe(`${PP}/wiki/attention.md`)
    expect(results[0].titleMatch).toBe(true)
    // RRF score for token rank 1
    expect(results[0].score).toBeCloseTo(1 / 61)
    expect(results[1].title).toBe("阿尔法")
    expect(results[1].images).toEqual([
      { url: "img/a.png", alt: "图1" },
      { url: "img/b.png", alt: "图2" },
    ])
    // plan.txt is not .md so it is skipped; notes.md does not match at all
    expect(results).toHaveLength(2)
  })

  it("keeps a file whose only signal is a content token, anchoring the snippet on it", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue("标题以下全是内容 alpha 出现在这里")
    const [r] = await searchWiki(PP, "alpha beta", { includeVector: false })
    expect(r).toBeDefined()
    expect(r.titleMatch).toBe(false)
    expect(r.snippet).toContain("alpha")
    expect(r.score).toBeCloseTo(1 / 61) // single result at token rank 1
  })

  it("skips files whose readFile throws and omits non-matching files", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdFile(`${PP}/wiki/a.md`, "a.md"),
      mdFile(`${PP}/wiki/b.md`, "b.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("a.md")) throw new Error("boom")
      return "完全没有相关内容的页面"
    })
    const results = await searchWiki(PP, "attention", { includeVector: false })
    expect(results).toEqual([])
  })

  it("tolerates a missing wiki directory and a phrase-only punctuation query", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("no wiki"))
    await expect(searchWiki(PP, "，，", { includeVector: false })).resolves.toEqual([])
  })

  it("scores files against an empty phrase without matching anything", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue("任意正文内容")
    await expect(searchWiki(PP, "，，", { includeVector: false })).resolves.toEqual([])
  })

  it("batches reads when there are more than 16 files", async () => {
    const files: FileNode[] = []
    for (let i = 0; i < 17; i++) {
      files.push(mdFile(`${PP}/wiki/f${String(i).padStart(2, "0")}.md`, `f${String(i).padStart(2, "0")}.md`))
    }
    mocks.listDirectory.mockResolvedValue(files)
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("f00.md") ? "needle 匹配" : "无关内容",
    )
    const results = await searchWiki(PP, "needle", { includeVector: false })
    expect(results).toHaveLength(1)
  })

  it("caps the phrase-occurrence bonus at 10", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue("needle ".repeat(12) + "其它")
    const [r] = await searchWiki(PP, "needle", { includeVector: false })
    expect(r?.score).toBeCloseTo(1 / 61)
  })

  it("builds snippets with leading/trailing ellipses around the query", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue(`${"x".repeat(120)} needle ${"y".repeat(120)}`)
    const [r] = await searchWiki(PP, "needle", { includeVector: false })
    expect(r?.snippet.startsWith("...")).toBe(true)
    expect(r?.snippet.endsWith("...")).toBe(true)
    expect(r?.snippet).toContain("needle")

    mocks.readFile.mockResolvedValue(`needle ${"y".repeat(50)}`)
    const [r2] = await searchWiki(PP, "needle", { includeVector: false })
    expect(r2?.snippet.startsWith("...")).toBe(false)
    expect(r2?.snippet.endsWith("...")).toBe(false)
  })

  it("returns a raw slice when the query is absent from content", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/needle-guide.md`, "needle-guide.md")])
    mocks.readFile.mockResolvedValue("第一行\n第二行\n".repeat(60))
    const [r] = await searchWiki(PP, "needle", { includeVector: false })
    expect(r?.snippet.includes("\n")).toBe(false)
    expect(r?.snippet.length).toBeLessThanOrEqual(160)
  })

  it("respects topK", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdFile(`${PP}/wiki/a.md`, "a.md"),
      mdFile(`${PP}/wiki/b.md`, "b.md"),
    ])
    mocks.readFile.mockResolvedValue("needle 内容")
    const results = await searchWiki(PP, "needle", { includeVector: false, topK: 1 })
    expect(results).toHaveLength(1)
  })
})

describe("searchWiki — vector materialization and RRF", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultEmbeddingState(true, "model-x")
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockRejectedValue(new Error("missing"))
    mocks.searchByEmbedding.mockResolvedValue([])
  })

  it("materializes vector-only pages by probing wiki subdirectories", async () => {
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "foo", score: 0.9 },
      { id: "bar", score: 0.8 },
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("/wiki/concepts/bar.md")) {
        return `# 酒吧概念\n\n![图](imgs/bar.png)\n内容包含 needle。`
      }
      throw new Error("missing")
    })

    const results = await searchWiki(PP, "needle")
    // bar materialized from concepts/ (entities probe failed first)
    const bar = results.find((r) => r.path.endsWith("/wiki/concepts/bar.md"))
    expect(bar).toBeDefined()
    expect(bar?.title).toBe("酒吧概念")
    expect(bar?.images).toEqual([{ url: "imgs/bar.png", alt: "图" }])
    expect(bar?.score).toBeCloseTo(1 / (60 + 2)) // vector rank 2 only
    // foo was NOT materialized because readFile failed in every directory
    expect(results.some((r) => r.path.includes("foo"))).toBe(false)
  })

  it("keeps token pages known to the vector list in place", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/entities/foo.md`, "foo.md")])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("entities/foo.md")) return "# 已知实体 foo\n\nneedle 命中。"
      throw new Error("missing")
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "foo", score: 0.9 }])
    const results = await searchWiki(PP, "needle")
    expect(results).toHaveLength(1)
    // RRF: token rank 1 + vector rank 1
    expect(results[0].score).toBeCloseTo(2 / 61)
  })

  it("breaks RRF ties alphabetically by path", async () => {
    mocks.listDirectory.mockResolvedValue([
      mdFile(`${PP}/wiki/a.md`, "a.md"),
      mdFile(`${PP}/wiki/zeta.md`, "zeta.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("a.md")) return "# 甲页\n\nneedle 内容。"
      return "needle 内容。"
    })
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "zeta", score: 0.9 },
      { id: "a", score: 0.8 },
    ])
    const results = await searchWiki(PP, "needle")
    // both pages score 1/61 + 1/62 (token rank swaps with vector rank) → tie broken by path
    expect(results[0].score).toBeCloseTo(results[1].score)
    expect(results.map((r) => r.path)).toEqual([
      `${PP}/wiki/a.md`,
      `${PP}/wiki/zeta.md`,
    ])
  })

  it("sanitizes vector ids before building read paths", async () => {
    mocks.searchByEmbedding.mockResolvedValue([{ id: "../../evil", score: 0.9 }])
    mocks.sanitizeEntitySlug.mockImplementation((raw: string) => raw.replace(/[./]/g, ""))
    mocks.readFile.mockResolvedValue("# safe\n\n内容 needle。")
    const results = await searchWiki(PP, "needle")
    expect(results[0].path).toBe(`${PP}/wiki/entities/evil.md`)
  })

  it("skips vector search when embedding is disabled or model empty", async () => {
    defaultEmbeddingState(false)
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue("needle 内容")
    await searchWiki(PP, "needle")
    expect(mocks.searchByEmbedding).not.toHaveBeenCalled()

    defaultEmbeddingState(true, "")
    await searchWiki(PP, "needle")
    expect(mocks.searchByEmbedding).not.toHaveBeenCalled()
  })

  it("skips vector search on options.includeVector=false", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue("needle 内容")
    await searchWiki(PP, "needle", { includeVector: false })
    expect(mocks.searchByEmbedding).not.toHaveBeenCalled()
  })

  it("falls back to token-only ranking when vector search throws", async () => {
    mocks.listDirectory.mockResolvedValue([mdFile(`${PP}/wiki/notes.md`, "notes.md")])
    mocks.readFile.mockResolvedValue("needle 内容")
    mocks.searchByEmbedding.mockRejectedValue(new Error("embedding down"))
    const results = await searchWiki(PP, "needle")
    expect(results).toHaveLength(1)
    expect(results[0].score).toBeCloseTo(1 / 61)

    mocks.searchByEmbedding.mockRejectedValue("raw rejection")
    await searchWiki(PP, "needle")
  })

  it("returns an empty vector list gracefully", async () => {
    mocks.searchByEmbedding.mockResolvedValue([])
    const results = await searchWiki(PP, "needle")
    expect(results).toEqual([])
  })
})

describe("searchWiki — rerank", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    defaultEmbeddingState(false)
    mocks.listDirectory.mockResolvedValue([
      mdFile(`${PP}/wiki/a.md`, "a.md"),
      mdFile(`${PP}/wiki/b.md`, "b.md"),
    ])
    mocks.readFile.mockImplementation(async (p: string) =>
      p.endsWith("a.md") ? "# needle 标题\n\nneedle 内容" : "needle 内容",
    )
    mocks.rerankCandidates.mockImplementation(async (_q, candidates) =>
      [...candidates].reverse(),
    )
  })

  it("skips rerank when disabled or when there is at most one candidate", async () => {
    const results = await searchWiki(PP, "needle", { includeVector: false, rerank: true, topK: 1 })
    expect(results).toHaveLength(1)
    expect(mocks.rerankCandidates).not.toHaveBeenCalled()

    await searchWiki(PP, "needle", { includeVector: false })
    expect(mocks.rerankCandidates).not.toHaveBeenCalled()
  })

  it("reranks with title_match vs wiki_search sources and a custom purpose", async () => {
    const results = await searchWiki(PP, "needle", {
      includeVector: false,
      rerank: true,
      rerankPurpose: "测试目的",
    })
    expect(mocks.rerankCandidates).toHaveBeenCalledTimes(1)
    const [query, candidates, opts] = mocks.rerankCandidates.mock.calls[0]
    expect(query).toBe("needle")
    expect(candidates[0].source).toBe("title_match")
    expect(candidates[1].source).toBe("wiki_search")
    expect(candidates[0].id).toBe(`${PP}/wiki/a.md`)
    expect(opts).toMatchObject({ topK: 20, purpose: "测试目的" })
    expect(results.map((r) => r.path)).toEqual([
      `${PP}/wiki/b.md`,
      `${PP}/wiki/a.md`,
    ])
  })

  it("falls back to the fused order when rerank fails", async () => {
    mocks.rerankCandidates.mockRejectedValue(new Error("rerank provider down"))
    const results = await searchWiki(PP, "needle", { includeVector: false, rerank: true })
    expect(results.map((r) => r.path)).toEqual([`${PP}/wiki/a.md`, `${PP}/wiki/b.md`])

    mocks.rerankCandidates.mockRejectedValue("plain string failure")
    const results2 = await searchWiki(PP, "needle", { includeVector: false, rerank: true })
    expect(results2).toHaveLength(2)
  })
})
