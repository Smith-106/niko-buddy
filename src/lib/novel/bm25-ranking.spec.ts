import { describe, expect, it } from "vitest"
import { rankByBm25, tokenizeForBm25 } from "./bm25-ranking"

describe("tokenizeForBm25（中文 bigram + ASCII 词元混合切分）", () => {
  it("ASCII 连续串按词元保留并小写化", () => {
    expect(tokenizeForBm25("Hello World 42")).toEqual(["hello", "world", "42"])
  })

  it("中文按字符 bigram 切分，同时收束单字 token（单字查询可命中）", () => {
    expect(tokenizeForBm25("林澈跑了")).toEqual(["林澈", "林", "澈跑", "澈", "跑了", "跑", "了"])
  })

  it("终验 P1：单字 CJK 查询不再恒 0 分——单字 token 与文档单字匹配", () => {
    const docs = [
      { id: "乙", text: "剑 剑 剑 设定" },
      { id: "甲", text: "剑 设定" },
    ]
    const ranked = rankByBm25("剑", docs)
    // 乙词频高 → 真实 BM25 区分（不再依赖输入序巧合）
    expect(ranked[0]!.id).toBe("乙")
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
    // 输入序反转同样成立
    const reversed = rankByBm25("剑", [...docs].reverse())
    expect(reversed[0]!.id).toBe("乙")
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

describe("decomposeNovelQuery（zero-LLM 查询分解）", () => {
  it("引号字面量提取：四组引号 + 空字面量丢弃", async () => {
    const { decomposeNovelQuery } = await import("./bm25-ranking")
    const d = decomposeNovelQuery("找「青云山」和“星辰剑”还有『九霄诀』以及 \"Lin Che\" 的剧情")
    expect(d.verbatim).toEqual(["青云山", "星辰剑", "九霄诀", "Lin Che"])
    expect(d.rest).not.toContain("青云山")
    // 不成对引号不提取
    const d2 = decomposeNovelQuery("他说了「没说完的话")
    expect(d2.verbatim).toEqual([])
    // 空字面量丢弃但仍裁剪
    const d3 = decomposeNovelQuery("查「」的下落")
    expect(d3.verbatim).toEqual([])
    expect(d3.rest).toContain("的下落")
  })

  it("实体前缀提及 + 别名命中 + 残查询归一", async () => {
    const { decomposeNovelQuery } = await import("./bm25-ranking")
    const d = decomposeNovelQuery(
      "character:林澈 在 location:青云山 和 item:星辰剑 做了什么",
      { aliases: new Map([["阿澈", "林澈"]]) },
    )
    expect(d.entityMentions).toContain("character:林澈")
    expect(d.entityMentions).toContain("location:青云山")
    expect(d.entityMentions).toContain("item:星辰剑")
    expect(d.facets).toMatchObject({ character: "林澈", location: "青云山", item: "星辰剑" })
    // 别名命中追加 character 实体并裁剪原文
    const d2 = decomposeNovelQuery("阿澈去了哪里", { aliases: new Map([["阿澈", "林澈"]]) })
    expect(d2.entityMentions).toContain("character:林澈")
    expect(d2.facets.character).toBe("林澈")
    expect(d2.rest).not.toContain("阿澈")
    // 空别名不命中；无实体时 facets 为空、rest 即原查询
    const d3 = decomposeNovelQuery("今晚月色真美")
    expect(d3.entityMentions).toEqual([])
    expect(d3.facets).toEqual({})
    expect(d3.rest).toBe("今晚月色真美")
    expect(d3.original).toBe("今晚月色真美")
  })

  it("同一分面只保留首个实体名（替换后 regex 游标行为：后位同分面提及不再拾取）", async () => {
    const { decomposeNovelQuery } = await import("./bm25-ranking")
    const d = decomposeNovelQuery("character:林澈 与 character:沈鸢 的对手戏")
    expect(d.facets.character).toBe("林澈")
    expect(d.entityMentions).toEqual(["character:林澈"])
  })
})

describe("classifyNovelIntent（确定性意图路由）", () => {
  it("五类意图全覆盖", async () => {
    const { decomposeNovelQuery, classifyNovelIntent } = await import("./bm25-ranking")
    expect(classifyNovelIntent(decomposeNovelQuery("找「青云山」在哪一章"))).toBe("verbatim_lookup")
    expect(classifyNovelIntent(decomposeNovelQuery("character:林澈 现在知道什么"))).toBe("entity_fact")
    expect(classifyNovelIntent(decomposeNovelQuery("林澈后来去了哪里"))).toBe("continuity_check")
    expect(classifyNovelIntent(decomposeNovelQuery("这段文风如何"))).toBe("style_lookup")
    expect(classifyNovelIntent(decomposeNovelQuery("今晚月色真美"))).toBe("scene_search")
  })
})

describe("buildQueryPlan（意图剪枝 + verbatim 闸门）", () => {
  it("五类意图路由剪枝各不相同", async () => {
    const { buildQueryPlan } = await import("./bm25-ranking")
    const verbatim = buildQueryPlan("找「青云山」在哪一章")
    expect(verbatim.intent).toBe("verbatim_lookup")
    expect(verbatim.route).toEqual({ keyword: true, vector: false, canon: true, graph: false, recentChapters: true })
    const entity = buildQueryPlan("character:林澈 现在知道什么")
    expect(entity.intent).toBe("entity_fact")
    expect(entity.route.graph).toBe(true)
    expect(entity.route.recentChapters).toBe(false)
    const continuity = buildQueryPlan("林澈后来去了哪里")
    expect(continuity.intent).toBe("continuity_check")
    expect(continuity.route.recentChapters).toBe(true)
    const style = buildQueryPlan("这段文风如何")
    expect(style.intent).toBe("style_lookup")
    expect(style.route).toEqual({ keyword: true, vector: false, canon: false, graph: false, recentChapters: false })
    const scene = buildQueryPlan("今晚月色真美")
    expect(scene.intent).toBe("scene_search")
    expect(scene.route).toEqual({ keyword: true, vector: true, canon: true, graph: true, recentChapters: true })
  })

  it("verbatim 闸门：全命中 pass / 部分命中 / 无 corpus 不 gate", async () => {
    const { buildQueryPlan } = await import("./bm25-ranking")
    const titles = new Set(["第一章 青云山之战", "第二章 星辰剑出鞘"])
    const allHit = buildQueryPlan("找「青云山」和「星辰剑」", titles)
    expect(allHit.verbatimGate).toEqual({ pass: true, hits: ["青云山", "星辰剑"], missed: [] })
    const partial = buildQueryPlan("找「青云山」和「九霄诀」", titles)
    expect(partial.verbatimGate.pass).toBe(false)
    expect(partial.verbatimGate.hits).toEqual(["青云山"])
    expect(partial.verbatimGate.missed).toEqual(["九霄诀"])
    const noCorpus = buildQueryPlan("找「青云山」", undefined)
    expect(noCorpus.verbatimGate).toEqual({ pass: false, hits: [], missed: [] })
  })
})

describe("decomposeNovelQuery 覆盖补齐第二轮（85/174/182）", () => {
  it("rankByBm25：查询词全局缺失时全零分", async () => {
    const { rankByBm25 } = await import("./bm25-ranking")
    const ranked = rankByBm25("xyzzyqq", [{ id: "a", text: "完全无关的文本内容" }])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]).toMatchObject({ id: "a", score: 0 })
  })

  it("同分面前缀二次命中：分面只保留首个（facets 已占用分支）", async () => {
    const { decomposeNovelQuery } = await import("./bm25-ranking")
    const d = decomposeNovelQuery(`character:AB${"，".repeat(30)}character:CD`)
    expect(d.entityMentions).toEqual(["character:AB", "character:CD"])
    expect(d.facets.character).toBe("AB")
  })

  it("别名命中时分面已被前缀占用则不再覆盖", async () => {
    const { decomposeNovelQuery } = await import("./bm25-ranking")
    const d = decomposeNovelQuery("character:林澈，派阿澈出门", {
      aliases: new Map([["阿澈", "林澈"]]),
    })
    expect(d.entityMentions).toEqual(["character:林澈", "character:林澈"])
    expect(d.facets.character).toBe("林澈")
  })
})
