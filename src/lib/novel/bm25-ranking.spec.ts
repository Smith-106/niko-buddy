import { describe, expect, it } from "vitest"
import { rankByBm25, tokenizeForBm25 } from "./bm25-ranking"

describe("tokenizeForBm25（中文 bigram + ASCII 词元混合切分）", () => {
  it("ASCII 连续串按词元保留并小写化", () => {
    expect(tokenizeForBm25("Hello World 42")).toEqual(["hello", "world", "42"])
  })

  it("中文按字符 bigram 切分，末位单字保留 unigram", () => {
    expect(tokenizeForBm25("林澈跑了")).toEqual(["林澈", "澈跑", "跑了", "了"])
  })

  it("混合文本：ASCII 词与中文 bigram 共存", () => {
    const tokens = tokenizeForBm25("AI 写作 AI")
    expect(tokens).toContain("ai")
    expect(tokens).toContain("写作")
  })

  it("确定性：同输入两次切分全等", () => {
    const t = "确定性切分 test 123"
    expect(tokenizeForBm25(t)).toEqual(tokenizeForBm25(t))
  })
})

describe("rankByBm25（Okapi BM25，吸收自 inkos retrieval FTS5/BM25 模式）", () => {
  it("含查询词的文档得分高于不含者", () => {
    const docs = [
      { id: "d1", text: "讲述一位刑警追查连环案件的故事" },
      { id: "d2", text: "描写小镇风光与四季变化" },
      { id: "d3", text: "刑警搭档破案，案件背后另有隐情" },
    ]
    const ranked = rankByBm25("刑警 案件", docs)
    const scores = new Map(ranked.map((r) => [r.id, r.score]))
    expect(scores.get("d1")!).toBeGreaterThan(scores.get("d2")!)
    expect(scores.get("d3")!).toBeGreaterThan(scores.get("d2")!)
  })

  it("词频越高得分越高（TF 项生效）", () => {
    const docs = [
      { id: "once", text: "伏笔埋设" },
      { id: "twice", text: "伏笔埋设与伏笔回收" },
    ]
    const ranked = rankByBm25("伏笔", docs)
    const scores = new Map(ranked.map((r) => [r.id, r.score]))
    expect(scores.get("twice")!).toBeGreaterThan(scores.get("once")!)
  })

  it("长文档稀释效应（长度归一 b 参数生效）：短文档命中得分更高", () => {
    const docs = [
      { id: "short", text: "刑警办案" },
      {
        id: "long",
        text:
          "刑警办案" + "。这是一大段与查询完全无关的填充内容，用来稀释词频与长度归一化的作用，让同样的命中词出现在更长的文档里。",
      },
    ]
    const ranked = rankByBm25("刑警", docs)
    expect(ranked[0].id).toBe("short")
  })

  it("查询为空返回全零分", () => {
    const ranked = rankByBm25("", [{ id: "a", text: "文本" }])
    expect(ranked).toEqual([{ id: "a", score: 0 }])
  })

  it("docs 为空返回空数组；确定性双跑全等", () => {
    expect(rankByBm25("任意", [])).toEqual([])
    const docs = [
      { id: "a", text: "向量检索与全文检索" },
      { id: "b", text: "混合召回策略" },
    ]
    expect(JSON.stringify(rankByBm25("检索", docs))).toBe(
      JSON.stringify(rankByBm25("检索", docs)),
    )
  })
})
