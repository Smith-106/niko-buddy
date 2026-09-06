import { describe, expect, it } from "vitest"
import {
  buildFtsIndex,
  FTS_INDEX_VERSION,
  searchFtsIndex,
  type FtsIndex,
} from "./fts-index"

const corpus = [
  { id: "entities/张三", title: "张三", text: "张三是一名剑客，在雪夜敲响李四的门。" },
  { id: "entities/李四", title: "李四", text: "李四是青云山弟子，擅长炼丹。" },
  { id: "concepts/雪夜", title: "雪夜", text: "雪夜事件发生在第三章，主角见证了一场血月。" },
]

describe("fts-index (64 号实施：可重建持久 FTS 索引)", () => {
  it("build：倒排正确（token → docId 序，含 tf 多次出现）", () => {
    const idx = buildFtsIndex(corpus, { now: "2026-09-06T00:00:00.000Z" })
    expect(idx.version).toBe(FTS_INDEX_VERSION)
    expect(idx.postings["张三"]).toBeTruthy()
    // 张三出现在 doc0 标题+正文 → 至少 2 次
    expect(idx.postings["张三"].filter((id) => id === "entities/张三").length).toBeGreaterThanOrEqual(2)
    expect(idx.docFreq["张三"]).toBe(1)
  })

  it("中文 bigram 查询召回：雪夜 → 命中 doc0 与 doc2", () => {
    const idx = buildFtsIndex(corpus)
    const hits = searchFtsIndex(idx, "雪夜")
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("BM25 排序：高频匹配 doc 靠前", () => {
    const idx = buildFtsIndex(corpus)
    const hits = searchFtsIndex(idx, "张三")
    expect(hits[0].id).toBe("entities/张三")
    expect(hits[0].score).toBeGreaterThan(0)
  })

  it("重建幂等：同语料两次 build 深比较（除 builtAt）", () => {
    const a = buildFtsIndex(corpus, { now: "T" })
    const b = buildFtsIndex(corpus, { now: "T" })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it("空语料：空索引，查询返回 []", () => {
    const idx = buildFtsIndex([], { now: "T" })
    expect(searchFtsIndex(idx, "雪夜")).toEqual([])
  })

  it("单文档索引", () => {
    const idx = buildFtsIndex([corpus[0]])
    expect(Object.keys(idx.docs)).toHaveLength(1)
    const hits = searchFtsIndex(idx, "剑客")
    expect(hits).toHaveLength(1)
  })

  it("重建后旧词条消失（全量重建语义）", () => {
    const idx1 = buildFtsIndex(corpus)
    const idx2 = buildFtsIndex([corpus[0]])
    expect(idx2.postings["青云山"]).toBeUndefined()
    // 原语料 3 篇含 青云山 相关词；重建 1 篇后倒排收缩
    expect(Object.keys(idx2.postings).length).toBeLessThan(Object.keys(idx1.postings).length)
  })

  it("topK 截断", () => {
    const idx = buildFtsIndex(corpus)
    const hits = searchFtsIndex(idx, "雪夜", 1)
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  it("零命中返回 []", () => {
    const idx = buildFtsIndex(corpus)
    // 用全角字母组合（bigram 下无共享词元）
    expect(searchFtsIndex(idx, "ＱＷＥＲＴＹＺＸＣＶＢ")).toEqual([])
  })

  it("纯性：searchFtsIndex 不改索引", () => {
    const idx = buildFtsIndex(corpus, { now: "T" })
    const snapshot = JSON.stringify(idx)
    searchFtsIndex(idx, "雪夜")
    expect(JSON.stringify(idx)).toBe(snapshot)
  })

  it("空查询返回 []", () => {
    const idx = buildFtsIndex(corpus)
    expect(searchFtsIndex(idx, "  ")).toEqual([])
  })

  it("docs 元数据含 length/path", () => {
    const idx = buildFtsIndex(corpus, { now: "T" })
    const meta = (idx as FtsIndex).docs["entities/张三"]
    expect(meta.length).toBeGreaterThan(0)
    expect(meta.path).toBe("entities/张三")
  })
})
