import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, RerankConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  retrieveDualTrack: vi.fn(),
  novelMixedSearch: vi.fn(),
  searchWiki: vi.fn(),
  rerankCandidates: vi.fn(),
  runVectorSearchShared: vi.fn(),
}))

vi.mock("./search-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./search-adapter")>()
  return {
    ...actual,
    retrieveDualTrack: mocks.retrieveDualTrack,
    novelMixedSearch: mocks.novelMixedSearch,
  }
})

vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>()
  return {
    ...actual,
    searchWiki: mocks.searchWiki,
  }
})

vi.mock("@/lib/rerank", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rerank")>()
  return {
    ...actual,
    rerankCandidates: mocks.rerankCandidates,
  }
})

vi.mock("./vector-search-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vector-search-core")>()
  return {
    ...actual,
    runVectorSearchShared: mocks.runVectorSearchShared,
  }
})

import { searchRelevantContentUnified } from "./context-retrieval"

const DUAL_ON = { dualKbRoutingEnabled: true } as never
const DUAL_OFF = { dualKbRoutingEnabled: false } as never

describe("searchRelevantContentUnified 双轨分支（E-02 / C-3）与 K-4 回归", () => {
  beforeEach(() => {
    mocks.retrieveDualTrack.mockReset()
    mocks.novelMixedSearch.mockReset()
    mocks.searchWiki.mockReset()
    mocks.rerankCandidates.mockReset()
    mocks.runVectorSearchShared.mockReset()

    mocks.novelMixedSearch.mockResolvedValue([])
    mocks.searchWiki.mockResolvedValue([])
    mocks.runVectorSearchShared.mockResolvedValue([])
    mocks.rerankCandidates.mockImplementation(async (_q: string, candidates: unknown[]) => candidates)
  })

  it("dualKbRoutingEnabled → 只消费 dual.ranked，且透传与非双轨对等的检索选项（含 embCfg）", async () => {
    const embCfg: EmbeddingConfig = {
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "k",
      model: "emb-m",
    }
    const rerankConfig = { enabled: false, recipe: "balanced" } as RerankConfig
    mocks.retrieveDualTrack.mockResolvedValue({
      ranked: [
        { type: "wiki", path: "/p/book/wiki/entities/alice.md", title: "双轨结果", snippet: "双轨片段" },
      ],
    })

    const out = await searchRelevantContentUnified("/p/book", "任务目标", 3, 6, {
      novelConfig: DUAL_ON,
      embeddingConfig: embCfg,
      rerankConfig,
      entityNames: ["林晚秋"],
    })

    expect(mocks.retrieveDualTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p/book",
        task: "任务目标",
        chapterNumber: 3,
        // topK = max(limit * 2, 6)
        topK: 12,
        authoritativeOnly: true,
        includeKeyword: true,
        includeVector: true,
        includeGraph: true,
        includeRecentChapters: true,
        embCfg,
        recipe: "balanced",
        anchors: expect.arrayContaining(["林晚秋"]),
      }),
    )
    const callArg = mocks.retrieveDualTrack.mock.calls[0]?.[0] as Record<string, unknown>
    expect("includeCanon" in callArg).toBe(false)
    expect(out).toContain("双轨片段")
  })

  it("非双轨分支透传 embCfg，且索引通道 searchWiki 显式传 includeVector: false", async () => {
    const embCfg: EmbeddingConfig = {
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "k",
      model: "emb-m",
    }
    mocks.novelMixedSearch.mockResolvedValue([
      { type: "keyword", path: "/p/book/wiki/entities/a.md", title: "甲", snippet: "甲片段", relevance: 0.8 },
    ])

    await searchRelevantContentUnified("/p/book", "任务目标", 3, 6, {
      novelConfig: DUAL_OFF,
      embeddingConfig: embCfg,
    })

    expect(mocks.novelMixedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p/book",
        embCfg,
        includeCanon: true,
      }),
    )
    expect(mocks.searchWiki).toHaveBeenCalledWith(
      "/p/book",
      "关键词索引 向量索引 任务目标",
      expect.objectContaining({
        rerank: true,
        includeVector: false,
      }),
    )
  })

  it("rerankCandidates 失败回退 dedupedCandidates（不把同 path 跨源重复项回灌输出）", async () => {
    mocks.novelMixedSearch.mockResolvedValue([
      { type: "keyword", path: "/p/book/wiki/entities/alice.md", title: "语义版甲", snippet: "语义片段", relevance: 0.9 },
    ])
    mocks.searchWiki.mockResolvedValue([
      { path: "/p/book/wiki/entities/alice.md", title: "索引重复版甲", snippet: "索引重复片段", titleMatch: false, score: 0.7, images: [] },
      { path: "/p/book/wiki/entities/bob.md", title: "唯一乙", snippet: "乙片段", titleMatch: false, score: 0.6, images: [] },
    ])
    mocks.rerankCandidates.mockRejectedValue(new Error("rerank timeout"))

    const out = await searchRelevantContentUnified("/p/book", "任务目标", 3, 6, {
      novelConfig: DUAL_OFF,
    })

    expect(out).toContain("语义版甲: 语义片段")
    expect(out).toContain("唯一乙: 乙片段")
    expect(out).not.toContain("索引重复版甲")
  })

  it("dual-track 抛错 → catch 成 null → 不返回其片段，且整体不失败", async () => {
    mocks.retrieveDualTrack.mockRejectedValue(new Error("dual boom"))

    const out = await searchRelevantContentUnified("/p/book", "任务目标", 3, 6, {
      novelConfig: DUAL_ON,
    })

    expect(mocks.retrieveDualTrack).toHaveBeenCalledTimes(1)
    expect(out).not.toContain("双轨片段")
    expect(typeof out).toBe("string")
  })
})
