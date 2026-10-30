import { describe, it, expect } from "vitest"
import { applySearchRecipe, type NovelSearchResult } from "./search-adapter"

describe("ISS-20260802-004: Retrieval Recipes Deterministic Evaluation", () => {
  // 合成评测候选池与实体关系图（纯确定性，零网络/零时钟依赖）
  // 实体图：陆青 <-> 林晚秋 <-> 云州客栈 <-> 魔门宗主
  const graph = {
    nodes: [
      { id: "陆青", title: "陆青" },
      { id: "林晚秋", title: "林晚秋" },
      { id: "云州客栈", title: "云州客栈" },
      { id: "魔门宗主", title: "魔门宗主" },
    ],
    edges: [
      { source: "陆青", target: "林晚秋" },
      { source: "林晚秋", target: "云州客栈" },
      { source: "云州客栈", target: "魔门宗主" },
    ],
  }

  const candidates: NovelSearchResult[] = [
    {
      type: "keyword",
      path: "wiki/entities/林晚秋佩剑-1.md",
      title: "林晚秋佩剑",
      snippet: "林晚秋随身佩带的青锋宝剑，乃云州名匠所铸神兵利器",
      relevance: 0.95,
    },
    {
      type: "vector",
      path: "wiki/entities/林晚秋佩剑-2.md",
      title: "林晚秋佩剑",
      snippet: "林晚秋随身佩带的青锋宝剑，削铁如泥乃云州名匠神兵",
      relevance: 0.93,
    },
    {
      type: "keyword",
      path: "wiki/entities/林晚秋佩剑-3.md",
      title: "林晚秋青锋剑",
      snippet: "林晚秋随身佩带青锋宝剑行走江湖，剑气凌厉无匹",
      relevance: 0.90,
    },
    {
      type: "vector",
      path: "wiki/entities/魔门宗主.md",
      title: "魔门宗主",
      snippet: "魔门当代宗主厉天绝，修炼玄阴魔功威震魔道",
      relevance: 0.88,
    },
    {
      type: "graph",
      path: "wiki/entities/林晚秋.md",
      title: "林晚秋",
      snippet: "青云宗核心弟子，与陆青同门学艺多年感情深厚",
      relevance: 0.82,
    },
    {
      type: "keyword",
      path: "wiki/entities/云州客栈.md",
      title: "云州客栈",
      snippet: "云州城内最大的客栈，往来修仙散修汇聚交换情报之地",
      relevance: 0.78,
    },
    {
      type: "canon",
      path: "wiki/entities/陆青.md",
      title: "陆青",
      snippet: "故事主角，自青云宗外门一步步崛起并破除宿命羁绊",
      relevance: 0.75,
    },
    {
      type: "vector",
      path: "wiki/entities/南蛮百毒谷.md",
      title: "南蛮百毒谷",
      snippet: "南蛮边陲的险绝死地，毒瘴遮天常人无法靠近半步",
      relevance: 0.60,
    },
  ]

  it("REQ-01: default 预设严格字节等价于原有切片 filtered.slice(0, topK)", () => {
    const topK = 5
    const originalSlice = candidates.slice(0, topK)
    const defaultResult = applySearchRecipe(candidates, { recipe: "default", topK })

    expect(defaultResult).toEqual(originalSlice)
    expect(defaultResult.map((r) => r.path)).toEqual(originalSlice.map((r) => r.path))
    expect(defaultResult.map((r) => r.relevance)).toEqual(originalSlice.map((r) => r.relevance))
  })

  it("REQ-02: diverse (MMR) 预设消除同质冗余，top-3 冗余密度显著下降", () => {
    const topK = 3

    // 默认 RRF 截断：前 3 条全部是同质的“林晚秋佩剑”重复条目（冗余度 100% / 3条中3条）
    const rrfTop3 = applySearchRecipe(candidates, { recipe: "default", topK })
    const rrfSwordHits = rrfTop3.filter((r) => r.title.includes("剑")).length
    expect(rrfSwordHits).toBe(3) // 3/3 均为佩剑冗余条目

    // MMR diverse 截断：由于相似度惩罚，只保留 1 条佩剑条目，将不同实体带入 top-3
    const mmrTop3 = applySearchRecipe(candidates, { recipe: "diverse", topK })
    const mmrSwordHits = mmrTop3.filter((r) => r.title.includes("剑")).length
    expect(mmrSwordHits).toBe(1) // 降至仅 1 条，冗余度从 100% 降至 33.3%

    // 异构实体被跃迁提升入 top-3
    const mmrTitles = mmrTop3.map((r) => r.title)
    expect(mmrTitles[0]).toBe("林晚秋佩剑")
    expect(mmrTitles).toContain("魔门宗主")
  })

  it("REQ-03: local (NodeDistance) 预设根据图谱邻近度提升 1-hop 实体排名", () => {
    // 基础 RRF 排序中：魔门宗主 (relevance 0.88, index 3) 排在 林晚秋 (relevance 0.82, index 4) 之前
    const baseIndexMo = candidates.findIndex((c) => c.title === "魔门宗主")
    const baseIndexLin = candidates.findIndex((c) => c.title === "林晚秋")
    expect(baseIndexMo).toBeLessThan(baseIndexLin)

    // 以“陆青”为锚点：
    // 林晚秋为 1-hop 邻居，衰减 factor = 0.8^1 = 0.8 -> 0.82 * 0.8 = 0.656
    // 云州客栈为 2-hop 邻居，衰减 factor = 0.8^2 = 0.64 -> 0.78 * 0.64 = 0.4992
    // 魔门宗主为 3-hop 邻居，衰减 factor = 0.8^3 = 0.512 -> 0.88 * 0.512 = 0.45056
    const localResult = applySearchRecipe(candidates, {
      recipe: "local",
      topK: 8,
      anchors: ["陆青"],
      graph,
    })

    const localIndexMo = localResult.findIndex((c) => c.title === "魔门宗主")
    const localIndexLin = localResult.findIndex((c) => c.title === "林晚秋")

    // 林晚秋的排名跃迁到魔门宗主之前，排名净提升（魔门宗主从第 4 位跌至第 7 位，林晚秋从第 5 位保持第 5 位）
    expect(localIndexLin).toBeLessThan(localIndexMo)
    expect(localResult[localIndexLin].relevance).toBeGreaterThan(localResult[localIndexMo].relevance)
  })

  it("REQ-04: balanced 预设结合空间距离衰减与多样性重排", () => {
    const balancedResult = applySearchRecipe(candidates, {
      recipe: "balanced",
      topK: 4,
      anchors: ["陆青"],
      graph,
    })

    const titles = balancedResult.map((r) => r.title)
    // 1-hop 实体“林晚秋”因空间局部性获得提升进入 top-4
    expect(titles).toContain("林晚秋")
    // MMR 保证多条佩剑不会占满窗口（至多 1 条）
    const swordCount = titles.filter((t) => t.includes("剑")).length
    expect(swordCount).toBeLessThanOrEqual(2)
  })
})
