/**
 * retrieval-source-pipeline.spec.ts — 多源检索公共层纯函数行为守卫
 *
 * 拆分自 search-adapter.ts（纯搬迁）。本 spec 钉住「搬迁前后语义不变」：
 * 源权重 / RRF 融合排序 / 去重代表选择 / 单源超时包装。
 */
import { describe, expect, it, vi } from "vitest"
import {
  SOURCE_RRF_K_DEFAULT,
  SOURCE_TIE_PRIORITY,
  SOURCE_WEIGHTS,
  deduplicateResults,
  normalizeResultPath,
  rankSourceResults,
  toPublicResult,
  withTimeout,
} from "./retrieval-source-pipeline"
import type { NovelSearchResult } from "./search-adapter"

function item(type: NovelSearchResult["type"], path: string, relevance: number, title = path): NovelSearchResult {
  return { type, path, title, snippet: "", relevance }
}

describe("retrieval-source-pipeline", () => {
  it("源权重与 tie 优先级覆盖全部检索类型，且 keyword 优先级最高", () => {
    const types: NovelSearchResult["type"][] = ["keyword", "vector", "graph", "canon", "recent_chapter"]
    for (const t of types) {
      expect(SOURCE_WEIGHTS[t]).toBeGreaterThan(0)
      expect(SOURCE_TIE_PRIORITY[t]).toBeGreaterThanOrEqual(0)
    }
    expect(Math.min(...types.map((t) => SOURCE_TIE_PRIORITY[t]))).toBe(SOURCE_TIE_PRIORITY.keyword)
    expect(SOURCE_RRF_K_DEFAULT).toBe(60)
  })

  it("normalizeResultPath 统一分隔符并小写", () => {
    expect(normalizeResultPath("A\\B\\C.MD")).toBe("a/b/c.md")
  })

  it("toPublicResult 只保留公开字段（丢弃 sourceRank）", () => {
    const ranked = { ...item("vector", "/p/a.md", 0.5), sourceRank: 3 }
    expect(toPublicResult(ranked)).toEqual({
      type: "vector",
      path: "/p/a.md",
      title: "/p/a.md",
      snippet: "",
      relevance: 0.5,
    })
  })

  it("rankSourceResults 按到达顺序标注 sourceRank", () => {
    const ranked = rankSourceResults([item("keyword", "/p/a.md", 1), item("vector", "/p/b.md", 1)])
    expect(ranked.map((r) => r.sourceRank)).toEqual([0, 1])
  })

  it("deduplicateResults 融合同路径多源结果并按 RRF 分数排序", () => {
    // 同 path 的 keyword(rank0) + vector(rank1) 融合分数 = 1/61 + 1/62 ≈ 0.03252
    const fused = deduplicateResults(rankSourceResults([
      item("keyword", "/p/a.md", 0.9),
      item("vector", "/p/A.md", 0.4),
      item("graph", "/p/c.md", 0.2),
    ]))
    expect(fused).toHaveLength(2)
    expect(fused[0].path).toBe("/p/a.md")
    // 代表结果取贡献更高的一源（keyword rank0）
    expect(fused[0].title).toBe("/p/a.md")
    expect(fused[0].relevance).toBeGreaterThan(fused[1].relevance)
  })

  it("deduplicateResults 无重复时保持加权分数语义（weight/(k+rank+1)）", () => {
    const fused = deduplicateResults(rankSourceResults([item("graph", "/p/x.md", 0.7, "x")]))
    expect(fused[0].relevance).toBeCloseTo(SOURCE_WEIGHTS.graph / (SOURCE_RRF_K_DEFAULT + 0 + 1), 6)
  })

  it("withTimeout 正常 resolve 并透传 reject", async () => {
    await expect(withTimeout(Promise.resolve(42), 50, "ok")).resolves.toBe(42)
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, "bad")).rejects.toThrow("boom")
  })

  it("withTimeout 超时抛出带 label 的错误", async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(new Promise<number>(() => {}), 10, "slow")
      const assertion = expect(pending).rejects.toThrow("slow search timed out after 10ms")
      await vi.advanceTimersByTimeAsync(20)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
