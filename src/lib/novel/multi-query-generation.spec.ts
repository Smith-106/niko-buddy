import { describe, expect, it } from "vitest"
import { decomposeNovelQuery } from "./bm25-ranking"
import {
  fuseAcrossQueries,
  generateMultiQueries,
  type NovelSearchResult,
} from "./search-adapter"

const result = (type: NovelSearchResult["type"], path: string, relevance: number) =>
  ({ type, path, title: path, snippet: "", relevance })

describe("multi-query-generation (64 号实施：rag-fusion multi-query 改写)", () => {
  it("基础：原查询 + verbatim-lift 至多 3 条", () => {
    const q = "「雪夜」的主角"
    const d = decomposeNovelQuery(q)
    const queries = generateMultiQueries(q, d)
    expect(queries[0]).toBe(q)
    expect(queries).toContain("雪夜")
    expect(queries.length).toBeLessThanOrEqual(3)
  })

  it("verbatim 独立成查询：原查询(带引号) + 无引号变体", () => {
    const q = "「剑」"
    const d = decomposeNovelQuery(q)
    const queries = generateMultiQueries(q, d)
    expect(queries).toHaveLength(2)
    expect(queries[0]).toBe(q)
    expect(queries[1]).toBe("剑")
  })

  it("实体扩展：facets 拼查询", () => {
    const q = "character:张三 去哪了"
    const d = decomposeNovelQuery(q)
    const queries = generateMultiQueries(q, d)
    expect(queries.some((x) => x.includes("张三"))).toBe(true)
  })

  it("封顶：maxQueries=2 只产 2 条", () => {
    const q = "「雪夜」「断剑」的主角"
    const d = decomposeNovelQuery(q)
    const queries = generateMultiQueries(q, d, { maxQueries: 2 })
    expect(queries).toHaveLength(2)
  })

  it("确定性：同输入同输出", () => {
    const q = "「血月」前夜 character:王五"
    const d = decomposeNovelQuery(q)
    expect(generateMultiQueries(q, d)).toEqual(generateMultiQueries(q, d))
  })

  it("空查询退化：仅原查询", () => {
    const d = decomposeNovelQuery("")
    expect(generateMultiQueries("", d)).toEqual([""])
  })

  it("fuseAcrossQueries：跨查询按 RRF 融合排序", () => {
    const a = [result("keyword", "/wiki/entities/甲.md", 1), result("keyword", "/wiki/entities/乙.md", 0.5)]
    const b = [result("vector", "/wiki/entities/乙.md", 0.9)]
    const fused = fuseAcrossQueries([a, b], 60)
    expect(fused[0].path).toContain("乙")
    expect(fused[1].path).toContain("甲")
  })

  it("fuseAcrossQueries：path 归一去重（大小写/反斜杠）", () => {
    const a = [result("keyword", "/Wiki/Entities/甲.md", 1)]
    const b = [result("vector", "/wiki/entities/甲.md", 0.9)]
    expect(fuseAcrossQueries([a, b])).toHaveLength(1)
  })

  it("fuseAcrossQueries：空输入返回 []", () => {
    expect(fuseAcrossQueries([])).toEqual([])
  })
})
