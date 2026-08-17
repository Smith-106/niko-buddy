import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PageSearchResult } from "@/lib/embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  searchWiki: vi.fn(),
  readFile: vi.fn(),
  logger: { error: vi.fn() },
  rerankCandidates: vi.fn(),
  useWikiStoreGetState: vi.fn(),
  loadSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
  sanitizeEntitySlug: vi.fn(),
  searchByEmbedding: vi.fn(),
  buildRetrievalGraph: vi.fn(),
  getRelatedNodes: vi.fn(),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: (...args: unknown[]) => mocks.searchWiki(...args),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...args),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}))

vi.mock("@/lib/utils", () => ({
  logger: mocks.logger,
}))

vi.mock("@/lib/rerank", () => ({
  rerankCandidates: (...args: unknown[]) => mocks.rerankCandidates(...args),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.useWikiStoreGetState },
}))

vi.mock("./chapter-ingest", () => ({
  loadSnapshot: (...args: unknown[]) => mocks.loadSnapshot(...args),
  listSnapshots: (...args: unknown[]) => mocks.listSnapshots(...args),
}))

vi.mock("./graph-adapter", () => ({
  sanitizeEntitySlug: (...args: unknown[]) => mocks.sanitizeEntitySlug(...args),
}))

vi.mock("@/lib/embedding", () => ({
  searchByEmbedding: (...args: unknown[]) => mocks.searchByEmbedding(...args),
}))

vi.mock("@/lib/graph-relevance", () => ({
  buildRetrievalGraph: (...args: unknown[]) => mocks.buildRetrievalGraph(...args),
  getRelatedNodes: (...args: unknown[]) => mocks.getRelatedNodes(...args),
}))

import {
  isAuthoritativeGenerationPath,
  isHistoricalProjectionSnippet,
  novelMixedSearch,
  searchPlot,
} from "./search-adapter"

const pp = "E:/Novel"

function keywordItem(overrides: Partial<{ path: string; title: string; snippet: string; score: number }> = {}) {
  return {
    path: `${pp}/wiki/entities/剑.md`,
    title: "剑",
    snippet: "剑的设定",
    score: 1.2,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.searchWiki.mockResolvedValue([])
  mocks.rerankCandidates.mockImplementation(async (_query: string, candidates: unknown[]) => candidates)
  mocks.readFile.mockRejectedValue(new Error("ENOENT"))
  mocks.useWikiStoreGetState.mockReturnValue({
    embeddingConfig: { enabled: false, model: "" },
  })
  mocks.sanitizeEntitySlug.mockImplementation((raw: string) => raw.replace(/[/\\]/g, ""))
  mocks.loadSnapshot.mockResolvedValue(null)
  mocks.listSnapshots.mockResolvedValue([])
})

describe("search-adapter pure helpers", () => {
  it("isAuthoritativeGenerationPath matches wiki/entities, concepts, memory, chapters, canon.md, snapshots", () => {
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/entities/剑.md`)).toBe(true)
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/concepts/剑.md`)).toBe(true)
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/memory/记忆.md`)).toBe(true)
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/chapters/ch-1.md`)).toBe(true)
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/canon.md`)).toBe(true)
    expect(isAuthoritativeGenerationPath(`${pp}/.novel/snapshots/001.snapshot.json`)).toBe(true)
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/sources/原始.md`)).toBe(false)
    expect(isAuthoritativeGenerationPath(`${pp}/wiki/outlines/总大纲.md`)).toBe(false)
  })

  it("isHistoricalProjectionSnippet flags history paths and historical markers", () => {
    expect(isHistoricalProjectionSnippet(`${pp}/wiki/history/x.md`, "")).toBe(true)
    expect(isHistoricalProjectionSnippet(`${pp}/wiki/entities/a.md`, "is_historical: true")).toBe(true)
    expect(isHistoricalProjectionSnippet(`${pp}/wiki/entities/a.md`, "普通内容")).toBe(false)
  })
})

describe("novelMixedSearch", () => {
  it("runs keyword branch by default, reranks, and returns results", async () => {
    mocks.searchWiki.mockResolvedValue([keywordItem(), keywordItem({ path: `${pp}/wiki/concepts/刀.md`, title: "刀" })])
    const results = await novelMixedSearch({ projectPath: pp, query: "剑" })
    expect(results).toHaveLength(2)
    expect(results[0]!.type).toBe("keyword")
    // deduplicateResults replaces relevance with the RRF fusion score
    // weight=1 / (SOURCE_RRF_K=60 + sourceRank 0 + 1) = 1/61
    expect(results[0]!.relevance).toBeCloseTo(1 / 61, 5)
    // rerank receives id + source augmented candidates (path lowercased via normalizeResultPath)
    const [, candidates] = mocks.rerankCandidates.mock.calls[0] as [string, unknown[]]
    expect(candidates[0]).toEqual(expect.objectContaining({ id: `keyword:e:/novel/wiki/entities/剑.md`, source: "keyword" }))
  })

  it("defaults topK to 5 and slices keyword results", async () => {
    mocks.searchWiki.mockResolvedValue(Array.from({ length: 8 }, (_, i) => keywordItem({ path: `${pp}/wiki/entities/e${i}.md`, title: `e${i}` })))
    const results = await novelMixedSearch({ projectPath: pp, query: "q" })
    expect(results).toHaveLength(5)
  })

  it("includes vector branch when includeVector and embedding enabled", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "剑", score: 0.8, matchedChunks: [{ text: "剑的正文", headingPath: "设定", score: 0.8 }] },
    ])
    mocks.readFile.mockResolvedValue("# 剑\n\n剑的正文内容")
    const results = await novelMixedSearch({ projectPath: pp, query: "剑", includeVector: true })
    expect(results.some((r) => r.type === "vector")).toBe(true)
    const vr = results.find((r) => r.type === "vector")!
    expect(vr.path).toBe(`${pp}/wiki/entities/剑.md`)
    expect(vr.title).toBe("剑")
  })

  it("vector branch: probes all candidate dirs in priority order (root fallback)", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "rootdoc", score: 0.7 }])
    // entities/rootdoc.md missing, root wiki/rootdoc.md present
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === `${pp}/wiki/rootdoc.md`) return "# 根文档\n正文"
      throw new Error("ENOENT")
    })
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    const vr = results.find((r) => r.type === "vector")
    expect(vr?.path).toBe(`${pp}/wiki/rootdoc.md`)
  })

  it("vector branch: extracts title from frontmatter title and falls back to id", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "fm-doc", score: 0.6 },
      { id: "no-title-doc", score: 0.55 },
    ])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("fm-doc")) return "---\ntitle: 前端标题\n---\n正文"
      return "正文没有标题"
    })
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    const fm = results.find((r) => r.path.includes("fm-doc"))
    expect(fm?.title).toBe("前端标题")
    const fallback = results.find((r) => r.path.includes("no-title-doc"))
    expect(fallback?.title).toBe("no-title-doc")
  })

  it("vector branch: sanitizes vr.id and probes with the sanitized slug", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "../evil", score: 0.9 }])
    mocks.sanitizeEntitySlug.mockReturnValue("evil")
    mocks.readFile.mockResolvedValue("# 安全\n正文")
    await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    expect(mocks.readFile).toHaveBeenCalledWith(`${pp}/wiki/entities/evil.md`)
  })

  it("vector branch: returns empty when embedding disabled and when search returns nothing", async () => {
    const disabled = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    expect(disabled.some((r) => r.type === "vector")).toBe(false)
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([])
    const none = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    expect(none.some((r) => r.type === "vector")).toBe(false)
  })

  it("vector branch: searchByEmbedding rejection is contained by the outer catch", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockRejectedValue(new Error("embedding down"))
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    expect(results.some((r) => r.type === "vector")).toBe(false)
  })

  it("graph branch: matches nodes by title/id token and reads related nodes in parallel", async () => {
    mocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([
        ["n1", { id: "n1", title: "白砚", type: "character", path: `${pp}/wiki/entities/白砚.md`, sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
        ["n2", { id: "n2", title: "轩辕剑", type: "item", path: `${pp}/wiki/entities/轩辕剑.md`, sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
      ]),
      dataVersion: 1,
    })
    mocks.getRelatedNodes.mockImplementation((id: string) => {
      if (id === "n1") return [{ node: { id: "n3", title: "苏未晞", path: `${pp}/wiki/entities/苏未晞.md` }, relevance: 0.8 }]
      return []
    })
    mocks.readFile.mockResolvedValue("# 苏未晞\n配角")
    const results = await novelMixedSearch({ projectPath: pp, query: "白砚 轩辕剑", includeGraph: true })
    const graph = results.filter((r) => r.type === "graph")
    // scoredNodes only carries related-node reads (matched nodes drive the
    // expansion; their own content is not re-read here)
    expect(graph).toHaveLength(1)
    expect(graph[0]!.title).toBe("苏未晞")
    // dedup replaced raw relevance with RRF fusion score 0.95/61
    expect(graph[0]!.relevance).toBeCloseTo(0.95 / 61, 5)
  })

  it("graph branch: returns empty for empty graph / no token matches", async () => {
    mocks.buildRetrievalGraph.mockResolvedValue({ nodes: new Map(), dataVersion: 1 })
    const empty = await novelMixedSearch({ projectPath: pp, query: "q", includeGraph: true })
    expect(empty.some((r) => r.type === "graph")).toBe(false)

    mocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([["n1", { id: "n1", title: "白砚", type: "character", path: "p", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }]]),
      dataVersion: 1,
    })
    mocks.getRelatedNodes.mockReturnValue([])
    const noMatch = await novelMixedSearch({ projectPath: pp, query: "zzz", includeGraph: true })
    expect(noMatch.some((r) => r.type === "graph")).toBe(false)
  })

  it("graph branch: tolerates unreadable related files (readFile errors skipped)", async () => {
    mocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([["n1", { id: "n1", title: "白砚", type: "character", path: `${pp}/wiki/entities/白砚.md`, sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }]]),
      dataVersion: 1,
    })
    mocks.getRelatedNodes.mockReturnValue([
      { node: { id: "n9", title: "九", path: `${pp}/wiki/entities/九.md` }, relevance: 0.5 },
      { node: { id: "n10", title: "十", path: `${pp}/wiki/entities/十.md` }, relevance: 0.4 },
    ])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("十.md")) return "# 十\n正文"
      throw new Error("ENOENT")
    })
    const results = await novelMixedSearch({ projectPath: pp, query: "白砚", includeGraph: true })
    const graph = results.filter((r) => r.type === "graph")
    expect(graph).toHaveLength(1)
    expect(graph[0]!.title).toBe("十")
    expect(graph[0]!.relevance).toBeCloseTo(0.95 / 61, 5)
  })

  it("recent_chapter branch: lists snapshots and loads summaries", async () => {
    mocks.listSnapshots.mockResolvedValue([3, 4, 5])
    mocks.loadSnapshot.mockImplementation(async (_p: string, num: number) =>
      num === 5 ? { summary: "第5章摘要", endingHook: "" } : null,
    )
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeRecentChapters: true })
    const recent = results.find((r) => r.type === "recent_chapter")
    expect(recent).toBeDefined()
    expect(recent!.path).toBe(`${pp}/.novel/snapshots/005.snapshot.json`)
    expect(recent!.title).toBe("第5章")
    expect(recent!.snippet).toBe("第5章摘要")
    // dedup replaced relevance with RRF fusion score 0.75/61 ≈ 0.0123
    expect(recent!.relevance).toBeCloseTo(0.75 / 61, 5)
  })

  it("recent_chapter branch: empty when no snapshots", async () => {
    mocks.listSnapshots.mockResolvedValue([])
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeRecentChapters: true })
    expect(results.some((r) => r.type === "recent_chapter")).toBe(false)
  })

  it("canon branch: returns fallback entry when no line matches", async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === `${pp}/wiki/canon.md`) return "正史规则第一行\n正史规则第二行"
      throw new Error("ENOENT")
    })
    const results = await novelMixedSearch({ projectPath: pp, query: "不存在的词", includeCanon: true })
    const canon = results.find((r) => r.type === "canon")
    expect(canon).toBeDefined()
    expect(canon!.snippet).toContain("正史规则")
    // dedup replaced the raw 0.5 with the RRF fusion score 0.9/61
    expect(canon!.relevance).toBeCloseTo(0.9 / 61, 5)
  })

  it("canon branch: returns matched line windows merged on shared path", async () => {
    mocks.readFile.mockResolvedValueOnce("行1\n行2 关键词\n行3\n行4\n行5 关键词\n行6")
    const results = await novelMixedSearch({ projectPath: pp, query: "关键词", includeCanon: true })
    const canon = results.filter((r) => r.type === "canon")
    // both matched windows share `${pp}/wiki/canon.md` → deduplicated into one entry
    expect(canon).toHaveLength(1)
    expect(canon[0]!.snippet).toContain("行2 关键词")
    // both windows share the canon path → contributions fuse: 0.9/61 + 0.9/62
    expect(canon[0]!.relevance).toBeCloseTo(0.9 / 61 + 0.9 / 62, 5)
  })

  it("canon branch: returns empty when canon.md empty or missing", async () => {
    mocks.readFile.mockResolvedValueOnce("   \n")
    const empty = await novelMixedSearch({ projectPath: pp, query: "q", includeCanon: true })
    expect(empty.some((r) => r.type === "canon")).toBe(false)
    mocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    const missing = await novelMixedSearch({ projectPath: pp, query: "q", includeCanon: true })
    expect(missing.some((r) => r.type === "canon")).toBe(false)
  })

  it("deduplicates same-path results across sources with RRF fusion", async () => {
    mocks.searchWiki.mockResolvedValue([keywordItem({ path: `${pp}/wiki/entities/剑.md` })])
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "剑", score: 0.9 }])
    mocks.readFile.mockResolvedValue("# 剑\n正文")
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "剑",
      includeVector: true,
      includeKeyword: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })
    const deduped = results.filter((r) => r.path === `${pp}/wiki/entities/剑.md`)
    expect(deduped.length).toBe(1)
    // fusionScore = keyword contribution + vector contribution (round-trip)
    expect(deduped[0]!.relevance).toBeCloseTo(2 / 61, 5)
  })

  it("dedup replaces the representative when a same-contribution candidate scores higher", async () => {
    // keyword 甲 rank 0 (1/61, score 0.5) then vector 甲 rank 0 (1/61, score
    // 0.9): equal contribution → relevance tie-break replaces the representative
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/甲.md`, score: 0.5 }),
      keywordItem({ path: `${pp}/wiki/entities/乙.md`, score: 0.7 }),
    ])
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "甲", score: 0.9 }])
    mocks.readFile.mockResolvedValue("# 甲\n正文")
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      includeVector: true,
      includeKeyword: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })
    const jia = results.find((r) => r.path === `${pp}/wiki/entities/甲.md`)!
    // representative replaced by the higher-relevance vector entry (2/61 fused)
    expect(jia.relevance).toBeCloseTo(2 / 61, 5)
    expect(results).toHaveLength(2)
  })

  it("dedup tie-break chain: rank comparison when contribution+relevance equal", async () => {
    // same contribution (1/61) and same relevance (0.9), different ranks
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/甲.md`, score: 0.9 }),
      keywordItem({ path: `${pp}/wiki/entities/甲.md`, score: 0.9 }),
    ])
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "甲", score: 0.9 }])
    mocks.readFile.mockResolvedValue("# 甲\n正文")
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      includeVector: true,
      includeKeyword: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })
    const jia = results.find((r) => r.path === `${pp}/wiki/entities/甲.md`)!
    // kw rank0 (1/61) + kw rank1 (1/62) + vector rank0 (1/61)
    expect(jia.relevance).toBeCloseTo(2 / 61 + 1 / 62, 5)
  })

  it("dedup result sort falls through equal fusion scores to title order", async () => {
    // two distinct paths each fused from 2 keyword entries → equal fusion 2/61,
    // equal relevance, equal rank, equal type priority → title localeCompare
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/alpha.md`, title: "alpha", score: 0.9 }),
      keywordItem({ path: `${pp}/wiki/entities/alpha.md`, title: "alpha", score: 0.8 }),
      keywordItem({ path: `${pp}/wiki/entities/beta.md`, title: "beta", score: 0.9 }),
      keywordItem({ path: `${pp}/wiki/entities/beta.md`, title: "beta", score: 0.7 }),
    ])
    const results = await novelMixedSearch({ projectPath: pp, query: "q", topK: 5 })
    expect(results).toHaveLength(2)
    expect(results[0]!.title).toBe("alpha")
    expect(results[1]!.title).toBe("beta")
  })

  it("dedup result sort tie-breaks on bestRelevance then bestRank then type priority", async () => {
    // path A: bestRelevance 0.9 (no replace) vs path B: bestRelevance 1.0
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/甲.md`, title: "甲", score: 0.9 }),
      keywordItem({ path: `${pp}/wiki/entities/甲.md`, title: "甲", score: 0.8 }),
      keywordItem({ path: `${pp}/wiki/entities/乙.md`, title: "乙", score: 0.9 }),
      keywordItem({ path: `${pp}/wiki/entities/乙.md`, title: "乙", score: 1.0 }),
      keywordItem({ path: `${pp}/wiki/entities/丙.md`, title: "丙", score: 0.6 }),
    ])
    const results = await novelMixedSearch({ projectPath: pp, query: "q", topK: 5 })
    // tie-breakers sort ascending: 乙 has bestRelevance 1.0 (replaced rep),
    // 甲 0.9 → 甲 first; 丙 lower fusion score last
    expect(results[0]!.title).toBe("甲")
    expect(results[1]!.title).toBe("乙")
    expect(results[2]!.title).toBe("丙")
  })

  it("authoritativeOnly filters out non-authoritative paths and historical projections", async () => {
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/好.md` }),
      keywordItem({ path: `${pp}/wiki/sources/原始.md` }),
      keywordItem({ path: `${pp}/wiki/history/旧.md` }),
      keywordItem({ path: `${pp}/wiki/canon.md`, title: "正史规则" }),
      keywordItem({ path: `${pp}/.novel/snapshots/001.snapshot.json`, title: "快照" }),
    ])
    const results = await novelMixedSearch({ projectPath: pp, query: "q", authoritativeOnly: true })
    const paths = results.map((r) => r.path)
    expect(paths).toContain(`${pp}/wiki/entities/好.md`)
    expect(paths).toContain(`${pp}/wiki/canon.md`)
    expect(paths).toContain(`${pp}/.novel/snapshots/001.snapshot.json`)
    expect(paths).not.toContain(`${pp}/wiki/sources/原始.md`)
    expect(paths).not.toContain(`${pp}/wiki/history/旧.md`)
  })

  it("suppresses a source branch when it times out, logging the error", async () => {
    vi.useFakeTimers()
    try {
      mocks.searchWiki.mockImplementation(() => new Promise(() => {})) // never resolves
      const promise = novelMixedSearch({ projectPath: pp, query: "q" })
      await vi.advanceTimersByTimeAsync(2600)
      const results = await promise
      expect(results).toEqual([])
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "Novel Search",
        "keyword error",
        expect.objectContaining({ error: expect.stringContaining("timed out") }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs branch errors and continues other branches", async () => {
    mocks.searchWiki.mockRejectedValue(new Error("boom"))
    const results = await novelMixedSearch({ projectPath: pp, query: "q" })
    expect(results).toEqual([])
    expect(mocks.logger.error).toHaveBeenCalledWith("Novel Search", "keyword error", {
      error: "boom",
    })
  })

  it("keyword branch: falls back to empty snippet and 0 relevance when missing", async () => {
    mocks.searchWiki.mockResolvedValue([{
      path: `${pp}/wiki/entities/无.md`,
      title: "无",
      snippet: undefined,
      score: undefined,
    } as never])
    const results = await novelMixedSearch({ projectPath: pp, query: "q" })
    expect(results[0]!.snippet).toBe("")
    // dedup replaced raw 0 with the RRF fusion score 1/61
    expect(results[0]!.relevance).toBeCloseTo(1 / 61, 5)
  })

  it("vector branch: skips vector results whose files are unreadable everywhere", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "ghost-doc", score: 0.9 }])
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    expect(results.some((r) => r.type === "vector")).toBe(false)
  })

  it("vector branch: per-vr processing failure is caught and the branch continues", async () => {
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "explode", score: 0.9 },
      { id: "ok-doc", score: 0.8 },
    ])
    mocks.sanitizeEntitySlug.mockImplementation((raw: string) => {
      if (raw === "explode") throw new Error("sanitize boom")
      return raw
    })
    mocks.readFile.mockResolvedValue("# ok\n正文")
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeVector: true })
    const vr = results.find((r) => r.type === "vector")
    expect(vr?.title).toBe("ok")
    expect(vr?.path).toBe(`${pp}/wiki/entities/ok-doc.md`)
  })

  it("graph branch: buildRetrievalGraph failure is contained (outer catch → [])", async () => {
    mocks.buildRetrievalGraph.mockRejectedValue(new Error("graph boom"))
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeGraph: true })
    expect(results.some((r) => r.type === "graph")).toBe(false)
  })

  it("graph branch: skips related nodes already seen (dedup guard)", async () => {
    mocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([["n1", { id: "n1", title: "白砚", type: "character", path: `${pp}/wiki/entities/白砚.md`, sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }]]),
      dataVersion: 1,
    })
    // related list includes the matched node itself (already seen) + a fresh one
    mocks.getRelatedNodes.mockReturnValue([
      { node: { id: "n1", title: "白砚", path: `${pp}/wiki/entities/白砚.md` }, relevance: 0.9 },
      { node: { id: "n2", title: "苏未晞", path: `${pp}/wiki/entities/苏未晞.md` }, relevance: 0.8 },
    ])
    mocks.readFile.mockResolvedValue("# 苏未晞\n正文")
    const results = await novelMixedSearch({ projectPath: pp, query: "白砚", includeGraph: true })
    const graph = results.filter((r) => r.type === "graph")
    expect(graph).toHaveLength(1)
    expect(graph[0]!.title).toBe("苏未晞")
  })

  it("recent_chapter branch: listSnapshots failure is contained (outer catch → [])", async () => {
    mocks.listSnapshots.mockRejectedValue(new Error("snap boom"))
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeRecentChapters: true })
    expect(results.some((r) => r.type === "recent_chapter")).toBe(false)
  })

  it("recent_chapter branch: snippet falls back to endingHook then empty", async () => {
    mocks.listSnapshots.mockResolvedValue([6, 7])
    mocks.loadSnapshot.mockImplementation(async (_p: string, num: number) => {
      if (num === 7) return { summary: "", endingHook: "章末钩子" }
      return { summary: "", endingHook: "" }
    })
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeRecentChapters: true })
    const recent = results.filter((r) => r.type === "recent_chapter")
    expect(recent).toHaveLength(2)
    expect(recent.find((r) => r.title === "第7章")!.snippet).toBe("章末钩子")
    expect(recent.find((r) => r.title === "第6章")!.snippet).toBe("")
  })

  it("treats empty includeKeyword=false as explicit disable", async () => {
    mocks.searchWiki.mockResolvedValue([keywordItem()])
    const results = await novelMixedSearch({ projectPath: pp, query: "q", includeKeyword: false })
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })

  it("authoritativeOnly keeps canon/recent_chapter typed results via type check", async () => {
    mocks.searchWiki.mockResolvedValue([keywordItem()])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === `${pp}/wiki/canon.md`) return "正史\n关键词行\n更多正史\n关键词行2\n关键词行3"
      throw new Error("ENOENT")
    })
    mocks.listSnapshots.mockResolvedValue([3, 4, 5])
    mocks.loadSnapshot.mockImplementation(async (_p: string, num: number) =>
      num === 5 ? { summary: "摘要", endingHook: "" } : null,
    )
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "关键词",
      includeKeyword: false,
      includeCanon: true,
      includeRecentChapters: true,
      authoritativeOnly: true,
    })
    // canon entries (type "canon") and recent entries (type "recent_chapter")
    // survive the authoritativeOnly filter via the type branch, not the path
    expect(results.some((r) => r.type === "canon")).toBe(true)
    expect(results.some((r) => r.type === "recent_chapter")).toBe(true)
  })

  it("graph branch: sorts scored nodes by relevance (2+ readable related files)", async () => {
    mocks.buildRetrievalGraph.mockResolvedValue({
      nodes: new Map([["n1", { id: "n1", title: "白砚", type: "character", path: `${pp}/wiki/entities/白砚.md`, sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }]]),
      dataVersion: 1,
    })
    mocks.getRelatedNodes.mockReturnValue([
      { node: { id: "n9", title: "九", path: `${pp}/wiki/entities/九.md` }, relevance: 0.8 },
      { node: { id: "n4", title: "四", path: `${pp}/wiki/entities/四.md` }, relevance: 0.4 },
    ])
    mocks.readFile.mockResolvedValue("# 内容\n正文")
    const results = await novelMixedSearch({ projectPath: pp, query: "白砚", includeGraph: true })
    const graph = results.filter((r) => r.type === "graph")
    expect(graph).toHaveLength(2)
    // scoredNodes.sort by relevance desc: 九 (0.8) before 四 (0.4)
    expect(graph[0]!.title).toBe("九")
    expect(graph[1]!.title).toBe("四")
    expect(graph[0]!.relevance).toBeCloseTo(0.95 / 61, 5)
    expect(graph[1]!.relevance).toBeCloseTo(0.95 / 62, 5)
  })

  it("dedup sort: bestRelevance tie-break when fusion scores equal", async () => {
    // two single rank-0 entries from different branches: kw 1/61 (rel 0.5) and
    // vector 1/61 (rel 0.9) → equal fusion, relevance 0.9 sorts first
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/低.md`, title: "低", score: 0.5 }),
    ])
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "高", score: 0.9 }])
    mocks.readFile.mockResolvedValue("# 高\n正文")
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      topK: 5,
      includeVector: true,
      includeKeyword: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })
    expect(results[0]!.title).toBe("高")
    expect(results[1]!.title).toBe("低")
  })

  it("dedup sort: bestRank tie-break (equal fusion + relevance, different rank)", async () => {
    // E1 path: keyword rank2 (1/63) + recent rank2 (0.75/63) = 2/72
    // E2 path: keyword rank11 (1/72) + vector rank11 (1/72) = 2/72 — equal fusion,
    // equal bestRelevance 0.9, but bestRank 2 vs 11 → rank tie-break orders E1 first
    const e1Path = `${pp}/.novel/snapshots/010.snapshot.json`
    const e2Path = `${pp}/wiki/entities/乙.md`
    const kwItems = Array.from({ length: 12 }, (_, i) => {
      if (i === 2) return keywordItem({ path: e1Path, title: "甲", score: 0.9 })
      if (i === 11) return keywordItem({ path: e2Path, title: "乙", score: 0.9 })
      return keywordItem({ path: `${pp}/wiki/entities/其他${i}.md`, title: `其他${i}`, score: 0.5 })
    })
    mocks.searchWiki.mockResolvedValue(kwItems)
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => (i === 11 ? { id: "乙", score: 0.9 } : { id: `other-${i}`, score: 0.4 })),
    )
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === e2Path || path.includes("other-")) return "# 内容\n正文"
      throw new Error("ENOENT")
    })
    mocks.listSnapshots.mockResolvedValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    mocks.loadSnapshot.mockImplementation(async (_p: string, num: number) => ({ summary: `第${num}章摘要`, endingHook: "" }))
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      topK: 12,
      includeKeyword: true,
      includeVector: true,
      includeRecentChapters: true,
      includeGraph: false,
      includeCanon: false,
    })
    // E1 (bestRank 2) sorts before E2 (bestRank 11) at equal fusion
    const e1 = results.find((r) => r.path === e1Path)
    const e2 = results.find((r) => r.path === e2Path)
    expect(e1).toBeDefined()
    expect(e2).toBeDefined()
    expect(results.indexOf(e1!)).toBeLessThan(results.indexOf(e2!))
  })

  it("dedup sort: type-priority tie-break (equal fusion + relevance + rank)", async () => {
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/剑.md`, title: "剑", score: 0.9 }),
    ])
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "刀", score: 0.9 }])
    mocks.readFile.mockResolvedValue("# 刀\n正文")
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      includeVector: true,
      includeKeyword: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })
    // kw (priority 0) and vector (priority 1) both single rank-0 entries:
    // fusion 1/61 each, relevance 0.9, rank 0 → type priority 0 sorts first
    expect(results[0]!.type).toBe("keyword")
    expect(results[1]!.type).toBe("vector")
  })

  it("dedup sort: fusion-differing paths keep RRF-descending order", async () => {
    // two keyword entries at ranks 0 and 1 → fusion 1/61 vs 1/62 differ,
    // so the sort short-circuits on fusion score (rank-0 entry first)
    mocks.searchWiki.mockResolvedValue([
      keywordItem({ path: `${pp}/wiki/entities/alpha.md`, title: "alpha", score: 0.9 }),
      keywordItem({ path: `${pp}/wiki/entities/beta.md`, title: "beta", score: 0.9 }),
    ])
    const results = await novelMixedSearch({ projectPath: pp, query: "q", topK: 5 })
    expect(results[0]!.title).toBe("alpha")
    expect(results[1]!.title).toBe("beta")
    expect(results[0]!.relevance).toBeCloseTo(1 / 61, 5)
    expect(results[1]!.relevance).toBeCloseTo(1 / 62, 5)
  })

  it("dedup representative: rank tie-break replaces when contribution+relevance equal", async () => {
    // keyword rank31 contribution 1/92; recent rank8 contribution 0.75/69 = 1/92,
    // same path, same relevance 1.0 → sourceRank 8 < 31 replaces the representative
    const snapPath = `${pp}/.novel/snapshots/001.snapshot.json`
    const kwItems = Array.from({ length: 32 }, (_, i) =>
      i === 31
        ? keywordItem({ path: snapPath, title: "旧", score: 1.0 })
        : keywordItem({ path: `${pp}/wiki/entities/其他${i}.md`, title: `其他${i}`, score: 0.5 }),
    )
    mocks.searchWiki.mockResolvedValue(kwItems)
    mocks.listSnapshots.mockResolvedValue([1, 2, 3, 4, 5, 6, 7, 8, 9])
    mocks.loadSnapshot.mockImplementation(async (_p: string, num: number) => ({ summary: `第${num}章摘要`, endingHook: "" }))
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      topK: 32,
      includeRecentChapters: true,
      includeKeyword: true,
      includeVector: false,
      includeGraph: false,
      includeCanon: false,
    })
    const snap = results.find((r) => r.path === snapPath)
    expect(snap).toBeDefined()
    // representative replaced by the recent_chapter entry (title 第1章)
    expect(snap!.title).toBe("第1章")
  })

  it("dedup representative: keeps existing when candidate type priority is not lower", async () => {
    // same path: keyword rank0 first (priority 0), then vector rank0 (priority 1)
    // equal contribution 1/61, equal relevance, equal rank → vector does NOT replace
    const samePath = `${pp}/wiki/entities/剑.md`
    mocks.searchWiki.mockResolvedValue([keywordItem({ path: samePath, title: "剑", score: 0.9 })])
    mocks.useWikiStoreGetState.mockReturnValue({
      embeddingConfig: { enabled: true, model: "bge" } as EmbeddingConfig,
    })
    mocks.searchByEmbedding.mockResolvedValue([{ id: "剑", score: 0.9 }])
    mocks.readFile.mockResolvedValue("# 剑\n正文")
    const results = await novelMixedSearch({
      projectPath: pp,
      query: "q",
      includeVector: true,
      includeKeyword: true,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: false,
    })
    const deduped = results.filter((r) => r.path === samePath)
    expect(deduped).toHaveLength(1)
    expect(deduped[0]!.type).toBe("keyword")
  })

  it("logs non-Error branch rejections by stringifying the value", async () => {
    mocks.searchWiki.mockRejectedValue("plain string failure")
    const results = await novelMixedSearch({ projectPath: pp, query: "q" })
    expect(results).toEqual([])
    expect(mocks.logger.error).toHaveBeenCalledWith("Novel Search", "keyword error", {
      error: "plain string failure",
    })
  })
})

describe("searchPlot", () => {
  it("defaults options: topK 10, keyword/vector/graph/recent on, canon off", async () => {
    mocks.searchWiki.mockResolvedValue([keywordItem()])
    const results = await searchPlot(pp, "剑")
    expect(results).toHaveLength(1)
    const args = mocks.searchWiki.mock.calls[0] as [string, string]
    expect(args[0]).toBe(pp)
    expect(args[1]).toBe("剑")
  })

  it("propagates explicit options including includeCanon true", async () => {
    mocks.searchWiki.mockResolvedValue([keywordItem()])
    mocks.readFile.mockResolvedValueOnce("canon 内容")
    const results = await searchPlot(pp, "剑", {
      topK: 3,
      includeKeyword: true,
      includeVector: false,
      includeGraph: false,
      includeRecentChapters: false,
      includeCanon: true,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.type === "canon")).toBe(true)
  })
})
