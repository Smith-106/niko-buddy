import { describe, it, expect, vi } from "vitest"
import { tokenizeQuery } from "@/lib/search"

// KB-VIEW JSON 以深拷贝 mock：既有测试沿用与真实数据逐字节相同的内容；
// 缺字段/零收藏用例在 try/finally 内局部篡改后复原，不影响其它用例。
vi.mock("./kb/kb-routing-view.generated.json", async (importOriginal) => {
  const actual = (await importOriginal()) as unknown as { default?: unknown }
  const data = actual && typeof actual === "object" && "default" in actual ? actual.default : actual
  return { default: JSON.parse(JSON.stringify(data)) as unknown }
})
import {
  charShingleJaccard,
  getCharShingles,
  mmrRerank,
  nodeDistanceRerank,
  applySearchRecipe,
  SEARCH_RECIPES,
  SEARCH_RECIPE_IDS,
  isSearchRecipeId,
  isAuthoritativeGenerationPath,
  isHistoricalProjectionSnippet,
  filterAuthoritative,
  loadKbRoutingMatrix,
  loadKbRoutingViewBuiltFrom,
  loadKbCollectionCounts,
  routeByQueryIntent,
  assertNoTechLeak,
  tokensForKbMatch,
  reorderByUsefulness,
  generateMultiQueries,
  fuseAcrossQueries,
} from "./search-strategy"
import type { SearchRecipeId } from "./search-strategy"
import { decomposeNovelQuery } from "./bm25-ranking"
import type { QueryDecomposition } from "./bm25-ranking"
import type { NovelSearchResult } from "./search-adapter"
import kbRoutingViewMock from "./kb/kb-routing-view.generated.json"

describe("charShingleJaccard", () => {
  it("相同文本返回 1.0，完全不相交文本返回 0.0", () => {
    expect(charShingleJaccard("玄阴谷", "玄阴谷")).toBe(1.0)
    expect(charShingleJaccard("  云州客栈  ", "云州客栈")).toBe(1.0)
    expect(charShingleJaccard("", "")).toBe(1.0)
    expect(charShingleJaccard("玄阴谷", "魔门宗主")).toBe(0.0)
  })

  it("getCharShingles 生成预期 2-gram 集合", () => {
    const s = getCharShingles("林晚秋")
    expect(Array.from(s)).toEqual(["林晚", "晚秋"])
  })

  it("中文 2-gram (bi-shingle) 准确计算交并比", () => {
    // "林晚秋" -> {"林晚", "晚秋"} (2)
    // "林晚秋佩剑" -> {"林晚", "晚秋", "秋佩", "佩剑"} (4)
    // 交集 2 ("林晚", "晚秋")，并集 4 -> 0.5
    expect(charShingleJaccard("林晚秋", "林晚秋佩剑")).toBe(0.5)
  })

  it("单字符边缘情况安全处理", () => {
    expect(charShingleJaccard("剑", "剑")).toBe(1.0)
    expect(charShingleJaccard("剑", "刀")).toBe(0.0)
  })
})

describe("mmrRerank", () => {
  it("空集或单项或 k<=1 边缘情况安全返回", () => {
    expect(mmrRerank([], { k: 3 })).toEqual([])
    expect(mmrRerank([{ id: "1" }], { k: 3 })).toEqual([{ id: "1" }])
    expect(mmrRerank([{ id: "1" }, { id: "2" }], { k: 0 })).toEqual([])
    expect(mmrRerank([{ id: "1", relevance: 0.9 }, { id: "2", relevance: 0.5 }], { k: 1 })).toEqual([
      { id: "1", relevance: 0.9 },
    ])
  })

  it("惩罚高重合冗余候选，将多样性候选提前进 top-K", () => {
    const candidates = [
      { id: "c1", title: "林晚秋佩剑", snippet: "林晚秋的佩剑乃是青锋剑", relevance: 0.9 },
      { id: "c2", title: "林晚秋青锋剑", snippet: "林晚秋的佩剑青锋剑削铁如泥", relevance: 0.85 },
      { id: "c3", title: "云州秘境地图", snippet: "记载了云州秘境各大关卡与入口", relevance: 0.7 },
    ]

    // 默认 slice(0, 2) 取 c1, c2（都是关于林晚秋佩剑）
    const rrfTop2 = candidates.slice(0, 2).map((c) => c.id)
    expect(rrfTop2).toEqual(["c1", "c2"])

    // MMR (k=2, lambda=0.7) 惩罚 c2 的冗余相似度，选择 c3
    const mmrTop2 = mmrRerank(candidates, { k: 2, lambda: 0.7 }).map((c) => c.id)
    expect(mmrTop2).toEqual(["c1", "c3"])
  })

  it("lambda = 1.0 时退化为纯相关性排序", () => {
    const candidates = [
      { id: "c1", title: "相同标题", snippet: "相同内容", relevance: 0.9 },
      { id: "c2", title: "相同标题", snippet: "相同内容", relevance: 0.8 },
      { id: "c3", title: "完全不同", snippet: "异构信息", relevance: 0.5 },
    ]
    const reranked = mmrRerank(candidates, { k: 3, lambda: 1.0 }).map((c) => c.id)
    expect(reranked).toEqual(["c1", "c2", "c3"])
  })

  it("同分与同相似度下保持确定性 tie-break", () => {
    const candidates = [
      { id: "a", title: "测试 A", snippet: "内容", relevance: 0.5 },
      { id: "b", title: "测试 B", snippet: "内容", relevance: 0.5 },
      { id: "c", title: "测试 C", snippet: "内容", relevance: 0.5 },
    ]
    const reranked1 = mmrRerank(candidates, { k: 3 }).map((c) => c.id)
    const reranked2 = mmrRerank(candidates, { k: 3 }).map((c) => c.id)
    expect(reranked1).toEqual(reranked2)
    expect(reranked1[0]).toBe("a")
  })
})

describe("nodeDistanceRerank", () => {
  it("无 anchors 或无 graph 时原样返回", () => {
    const candidates = [{ id: "c1", relevance: 0.8 }, { id: "c2", relevance: 0.5 }]
    expect(nodeDistanceRerank(candidates, { anchors: [] })).toEqual(candidates)
    expect(nodeDistanceRerank(candidates, { anchors: ["陆青"], graph: null })).toEqual(candidates)
  })

  it("支持 RetrievalGraph (Map nodes + inLinks/outLinks)", () => {
    const nodes = new Map([
      [
        "陆青",
        {
          id: "陆青",
          title: "陆青",
          path: "wiki/entities/陆青.md",
          outLinks: new Set(["林晚秋"]),
          inLinks: new Set(),
          relationEdges: [],
        },
      ],
      [
        "林晚秋",
        {
          id: "林晚秋",
          title: "林晚秋",
          path: "wiki/entities/林晚秋.md",
          outLinks: new Set(["云州"]),
          inLinks: new Set(["陆青"]),
          relationEdges: [],
        },
      ],
      [
        "云州",
        {
          id: "云州",
          title: "云州",
          path: "wiki/entities/云州.md",
          outLinks: new Set(),
          inLinks: new Set(["林晚秋"]),
          relationEdges: [],
        },
      ],
      [
        "魔门",
        {
          id: "魔门",
          title: "魔门",
          path: "wiki/entities/魔门.md",
          outLinks: new Set(),
          inLinks: new Set(),
          relationEdges: [],
        },
      ],
    ])
    const graph = { nodes, dataVersion: 1 }

    const candidates = [
      { id: "c-mo", title: "魔门", path: "wiki/entities/魔门.md", snippet: "", relevance: 0.8 },
      { id: "c-lin", title: "林晚秋", path: "wiki/entities/林晚秋.md", snippet: "", relevance: 0.75 },
    ]

    // 锚点为 "陆青"：
    // 林晚秋 1-hop: 0.75 * 0.8 = 0.60
    // 魔门 unreachable (decay^4 = 0.4096): 0.8 * 0.4096 = 0.32768
    // 林晚秋跃升至第 1 位
    const reranked = nodeDistanceRerank(candidates, {
      anchors: ["陆青"],
      graph,
      decay: 0.8,
      maxDepth: 3,
    })

    expect(reranked[0].id).toBe("c-lin")
    expect(reranked[1].id).toBe("c-mo")
    expect(reranked[0].relevance).toBe(0.6)
  })

  it("支持普通 edges 邻接图格式", () => {
    const graph = {
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ],
    }
    const candidates = [
      { id: "C", title: "C", snippet: "", relevance: 0.9 },
      { id: "B", title: "B", snippet: "", relevance: 0.85 },
    ]

    // 锚点 A: B 是 1-hop (0.85 * 0.8 = 0.68), C 是 2-hop (0.9 * 0.64 = 0.576)
    const reranked = nodeDistanceRerank(candidates, {
      anchors: ["A"],
      graph,
      decay: 0.8,
    })
    expect(reranked.map((c) => c.id)).toEqual(["B", "C"])
  })
})

describe("applySearchRecipe", () => {
  it("default 预设或缺失时返回严格 slice(0, topK)，不改变分数与顺序", () => {
    const candidates = [
      { id: "1", title: "A", snippet: "AAA", relevance: 0.9 },
      { id: "2", title: "B", snippet: "BBB", relevance: 0.8 },
      { id: "3", title: "C", snippet: "CCC", relevance: 0.7 },
    ]
    expect(applySearchRecipe(candidates, { topK: 2 })).toEqual(candidates.slice(0, 2))
    expect(applySearchRecipe(candidates, { recipe: "default", topK: 2 })).toEqual(candidates.slice(0, 2))
    // 确保没有变异原候选
    expect(candidates[0].relevance).toBe(0.9)
  })

  it("diverse 预设执行 MMR 截断", () => {
    const candidates = [
      { id: "c1", title: "青锋剑", snippet: "林晚秋的佩剑乃是青锋宝剑", relevance: 0.9 },
      { id: "c2", title: "青锋剑", snippet: "林晚秋随身佩剑乃是青锋剑", relevance: 0.88 },
      { id: "c3", title: "灵兽丹", snippet: "喂养灵兽专用的珍稀丹药", relevance: 0.7 },
    ]
    const res = applySearchRecipe(candidates, { recipe: "diverse", topK: 2 })
    expect(res.map((c) => c.id)).toEqual(["c1", "c3"])
  })

  it("local 预设执行 NodeDistance 排序", () => {
    const graph = {
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
      edges: [{ source: "A", target: "B" }],
    }
    const candidates = [
      { id: "C", title: "C", snippet: "", relevance: 0.9 },
      { id: "B", title: "B", snippet: "", relevance: 0.85 },
    ]
    const res = applySearchRecipe(candidates, {
      recipe: "local",
      topK: 2,
      anchors: ["A"],
      graph,
    })
    expect(res.map((c) => c.id)).toEqual(["B", "C"])
  })

  it("balanced 预设结合 NodeDistance 衰减与 MMR 多样性", () => {
    const graph = {
      nodes: [{ id: "陆青" }, { id: "林晚秋" }, { id: "云州" }],
      edges: [
        { source: "陆青", target: "林晚秋" },
        { source: "林晚秋", target: "云州" },
      ],
    }
    const candidates = [
      { id: "c1", title: "远方宗门", snippet: "十万八千里外的宗门秘辛", relevance: 0.95 },
      { id: "c2", title: "林晚秋佩剑", snippet: "林晚秋随身佩剑青锋剑", relevance: 0.9 },
      { id: "c3", title: "林晚秋剑鞘", snippet: "林晚秋随身佩剑剑鞘", relevance: 0.88 },
      { id: "c4", title: "云州城池", snippet: "云州城池守备森严", relevance: 0.8 },
    ]

    const res = applySearchRecipe(candidates, {
      recipe: "balanced",
      topK: 2,
      anchors: ["陆青"],
      graph,
    })
    // 林晚秋 1-hop 衰减较小，c2 / c3 重合度高，MMR 会选 c2 并避免 c3
    expect(res[0].id).toBe("c2")
    expect(res.length).toBe(2)
  })

  it("SEARCH_RECIPES 包含 4 种预设", () => {
    expect(Object.keys(SEARCH_RECIPES)).toEqual(["default", "diverse", "local", "balanced"])
    expect(SEARCH_RECIPE_IDS).toEqual(["default", "diverse", "local", "balanced"])
    expect(isSearchRecipeId("diverse")).toBe(true)
    expect(isSearchRecipeId("invalid")).toBe(false)
  })

  it("RV-001: real tokenizeQuery + stem-id graph 成功解析并重排 (写第三章：林晚秋在云州客栈与陆青重逢)", () => {
    const task = "写第三章：林晚秋在云州客栈与陆青重逢"
    const tokens = tokenizeQuery(task)
    const entityHints = tokens.filter((t) => t.length >= 2).slice(0, 5)
    // 真实 context-retrieval 生产链路 anchors 生成逻辑（纯 bigrams: 写第、第三、三章、写第三章、林晚）
    const anchors = [...entityHints]

    // stem-id 图谱（真实 RetrievalGraph 形态）
    const graph = {
      nodes: new Map([
        ["林晚秋", { id: "林晚秋", title: "林晚秋", path: "wiki/entities/林晚秋.md", outLinks: new Set(["云州客栈"]), inLinks: new Set(), relationEdges: [] }],
        ["云州客栈", { id: "云州客栈", title: "云州客栈", path: "wiki/entities/云州客栈.md", outLinks: new Set(), inLinks: new Set(["林晚秋"]), relationEdges: [] }],
        ["陆青", { id: "陆青", title: "陆青", path: "wiki/entities/陆青.md", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
        ["天剑门", { id: "天剑门", title: "天剑门", path: "wiki/entities/天剑门.md", outLinks: new Set(), inLinks: new Set(["林晚秋"]), relationEdges: [] }],
        ["魔门秘境", { id: "魔门秘境", title: "魔门秘境", path: "wiki/entities/魔门秘境.md", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
      ]),
    }

    const candidates = [
      { id: "c1", title: "魔门秘境", path: "wiki/entities/魔门秘境.md", relevance: 0.95 },
      { id: "c2", title: "林晚秋", path: "wiki/entities/林晚秋.md", relevance: 0.8 },
      { id: "c3", title: "天剑门", path: "wiki/entities/天剑门.md", relevance: 0.75 },
    ]

    // 默认切片保持原排序：c1(魔门秘境 0.95) > c2(林晚秋 0.8) > c3(天剑门 0.75)
    const defaultOrder = applySearchRecipe(candidates, { recipe: "default", topK: 3 }).map((c) => c.title)
    expect(defaultOrder).toEqual(["魔门秘境", "林晚秋", "天剑门"])

    // local 配方应用：
    // 虽然 anchors 仅包含 bigram 切片（无全称 '林晚秋'），
    // 但经任务文本扫描及双向包含对齐成功命中 '林晚秋'/'云州客栈'/'陆青'，
    // 林晚秋(0跳 0.8)与天剑门(1跳 0.75*0.8=0.6)分数显著超越不可达的魔门秘境(0.95*0.4096=0.389)，
    // 证明 local 现在发生确定性重排！
    const localOrder = applySearchRecipe(candidates, {
      recipe: "local",
      topK: 3,
      anchors,
      task,
      graph,
    }).map((c) => c.title)

    expect(localOrder).toEqual(["林晚秋", "天剑门", "魔门秘境"])
  })

  it("RV-001: real tokenizeQuery + stem-id graph 成功解析并重排 (续写云州客栈的冲突场面)", () => {
    const task = "续写云州客栈的冲突场面"
    const tokens = tokenizeQuery(task)
    const entityHints = tokens.filter((t) => t.length >= 2).slice(0, 5)
    // 真实 bigram 列表: ["续写", "写云", "云州", "州客", "客栈"]
    const anchors = [...entityHints]

    const graph = {
      nodes: new Map([
        ["云州客栈", { id: "云州客栈", title: "云州客栈", path: "wiki/entities/云州客栈.md", outLinks: new Set(["客栈掌柜"]), inLinks: new Set(), relationEdges: [] }],
        ["客栈掌柜", { id: "客栈掌柜", title: "客栈掌柜", path: "wiki/entities/客栈掌柜.md", outLinks: new Set(), inLinks: new Set(["云州客栈"]), relationEdges: [] }],
        ["遥远边荒", { id: "遥远边荒", title: "遥远边荒", path: "wiki/entities/遥远边荒.md", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
      ]),
    }

    const candidates = [
      { id: "c1", title: "遥远边荒", path: "wiki/entities/遥远边荒.md", relevance: 0.95 },
      { id: "c2", title: "客栈掌柜", path: "wiki/entities/客栈掌柜.md", relevance: 0.8 },
      { id: "c3", title: "云州客栈", path: "wiki/entities/云州客栈.md", relevance: 0.75 },
    ]

    const defaultOrder = applySearchRecipe(candidates, { recipe: "default", topK: 3 }).map((c) => c.title)
    expect(defaultOrder).toEqual(["遥远边荒", "客栈掌柜", "云州客栈"])

    const localOrder = applySearchRecipe(candidates, {
      recipe: "local",
      topK: 3,
      anchors,
      task,
      graph,
    }).map((c) => c.title)

    // 锚点对齐到客栈相关实体，两者均超越遥远边荒(0.95*0.4096=0.389)
    expect(localOrder).toEqual(["客栈掌柜", "云州客栈", "遥远边荒"])

    // 额外验证：即使未显式传 task，仅凭 bigram 锚点双向包含（'云州'与'客栈'均被'云州客栈'包含），依然能完成对齐与重排
    const localOrderNoTask = applySearchRecipe(candidates, {
      recipe: "local",
      topK: 3,
      anchors,
      graph,
    }).map((c) => c.title)
    expect(localOrderNoTask).toEqual(["客栈掌柜", "云州客栈", "遥远边荒"])
  })

  it("RV-009: 章节序号二字片段（第三/三章）不把章节节点变成锚点", () => {
    // 「写第三章」的 第三/三章 被 第三十三章-夜袭 包含。若该章节成为锚点，
    // 只在该章被提到的魔门宗主（1 跳）会被拉到被点名的林晚秋前面。
    const graph = {
      nodes: new Map([
        ["林晚秋", { id: "林晚秋", title: "林晚秋", path: "wiki/entities/林晚秋.md", outLinks: new Set([]), inLinks: new Set([]), relationEdges: [] }],
        ["魔门宗主", { id: "魔门宗主", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", outLinks: new Set([]), inLinks: new Set(["第三十三章-夜袭"]), relationEdges: [] }],
        ["第三十三章-夜袭", { id: "第三十三章-夜袭", title: "第三十三章-夜袭", path: "wiki/chapters/第三十三章-夜袭.md", outLinks: new Set(["魔门宗主"]), inLinks: new Set([]), relationEdges: [] }],
      ]),
    }
    const candidates = [
      { id: "c1", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", relevance: 0.95 },
      { id: "c2", title: "林晚秋", path: "wiki/entities/林晚秋.md", relevance: 0.7 },
    ]
    const run = (task: string) =>
      nodeDistanceRerank(candidates, {
        anchors: tokenizeQuery(task).filter((x) => x.length >= 2).slice(0, 5),
        task,
        graph,
      }).map((c) => c.title)

    // 锚点只有林晚秋：魔门宗主不可达（0.95×0.4096≈0.39）排在林晚秋（0.7）之后。
    expect(run("写第三章：林晚秋拔剑")).toEqual(["林晚秋", "魔门宗主"])
    // 章节被任务原文完整点名时仍是锚点（任务扫描），其邻居魔门宗主随之靠前。
    expect(run("续写第三十三章-夜袭的余波")).toEqual(["魔门宗主", "林晚秋"])
  })

  it("RV-009/RV-103: chapter-NNN 文件名与仅章名标题同样排除；「第N章」按序号只锚定该章", () => {
    // chapter-170 的标题只有章名「夜袭」；chapter-017 用来检验 17/70 等数字片段不会误中。
    const graph = {
      nodes: new Map([
        ["林晚秋", { id: "林晚秋", title: "林晚秋", path: "wiki/entities/林晚秋.md", outLinks: new Set([]), inLinks: new Set([]), relationEdges: [] }],
        ["魔门宗主", { id: "魔门宗主", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", outLinks: new Set([]), inLinks: new Set(["chapter-017"]), relationEdges: [] }],
        ["云州客栈", { id: "云州客栈", title: "云州客栈", path: "wiki/entities/云州客栈.md", outLinks: new Set([]), inLinks: new Set(["chapter-170"]), relationEdges: [] }],
        ["chapter-017", { id: "chapter-017", title: "夜袭", path: "wiki/chapters/chapter-017.md", outLinks: new Set(["魔门宗主"]), inLinks: new Set([]), relationEdges: [] }],
        ["chapter-170", { id: "chapter-170", title: "新灵气契约", path: "wiki/chapters/chapter-170.md", outLinks: new Set(["云州客栈"]), inLinks: new Set([]), relationEdges: [] }],
      ]),
    }
    const candidates = [
      { id: "c1", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", relevance: 0.95 },
      { id: "c2", title: "云州客栈", path: "wiki/entities/云州客栈.md", relevance: 0.9 },
      { id: "c3", title: "林晚秋", path: "wiki/entities/林晚秋.md", relevance: 0.7 },
    ]
    const run = (task: string) =>
      nodeDistanceRerank(candidates, {
        anchors: tokenizeQuery(task).filter((x) => x.length >= 2).slice(0, 5),
        task,
        graph,
      }).map((c) => c.title)

    // 第170章 只锚定 chapter-170（序号）与林晚秋（点名）：云州客栈 1 跳靠前，
    // 只在 chapter-017 出现的魔门宗主不可达，排最后。
    expect(run("写第170章：林晚秋拔剑")).toEqual(["云州客栈", "林晚秋", "魔门宗主"])
    // 中文序号同样解析到 chapter-017。
    expect(run("续写第十七章：林晚秋拔剑")).toEqual(["魔门宗主", "林晚秋", "云州客栈"])
  })

  it("RV-106: 「第三回合」「第二卷」等实体不算章节，不挤掉同序号章节的唯一命中", () => {
    // 若「第三回合」被当成第 3 章，序号 3 会有两个命中，第 2a 步的唯一命中规则就放弃锚定 chapter-003。
    const graph = {
      nodes: new Map([
        ["林晚秋", { id: "林晚秋", title: "林晚秋", path: "wiki/entities/林晚秋.md", outLinks: new Set([]), inLinks: new Set([]), relationEdges: [] }],
        ["魔门宗主", { id: "魔门宗主", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", outLinks: new Set([]), inLinks: new Set(["chapter-003"]), relationEdges: [] }],
        ["第三回合", { id: "第三回合", title: "第三回合", path: "wiki/concepts/第三回合.md", outLinks: new Set([]), inLinks: new Set([]), relationEdges: [] }],
        ["第三卷", { id: "第三卷", title: "第三卷 风起", path: "wiki/concepts/第三卷.md", outLinks: new Set([]), inLinks: new Set([]), relationEdges: [] }],
        ["chapter-003", { id: "chapter-003", title: "夜袭", path: "wiki/chapters/chapter-003.md", outLinks: new Set(["魔门宗主"]), inLinks: new Set([]), relationEdges: [] }],
      ]),
    }
    const candidates = [
      { id: "c1", title: "林晚秋", path: "wiki/entities/林晚秋.md", relevance: 0.9 },
      { id: "c2", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", relevance: 0.8 },
    ]
    const run = (task: string) =>
      nodeDistanceRerank(candidates, {
        anchors: tokenizeQuery(task).filter((x) => x.length >= 2).slice(0, 5),
        task,
        graph,
      }).map((c) => c.title)

    // 第三章 唯一锚定 chapter-003：魔门宗主 1 跳（0.8×0.8=0.64）> 林晚秋不可达（0.9×0.4096≈0.37）。
    expect(run("续写第三章的余波")).toEqual(["魔门宗主", "林晚秋"])
    // 任务里的「第三卷」「第三回合」不是章节序号，不锚定 chapter-003。
    expect(run("续写第三卷的余波")).toEqual(["林晚秋", "魔门宗主"])
    expect(run("写一场第三回合的对决")).toEqual(["林晚秋", "魔门宗主"])
    // 先出现的「第一卷」不挡住后面的「第三章」。
    expect(run("续写第一卷第三章的余波")).toEqual(["魔门宗主", "林晚秋"])

    // 无分隔符章标题节点（如「第三章决战」）也能被识别为第 3 章并锚定
    const graphWithUnseparated = {
      nodes: new Map([
        ["林晚秋", { id: "林晚秋", title: "林晚秋", path: "wiki/entities/林晚秋.md", outLinks: new Set([]), inLinks: new Set([]), relationEdges: [] }],
        ["魔门宗主", { id: "魔门宗主", title: "魔门宗主", path: "wiki/entities/魔门宗主.md", outLinks: new Set([]), inLinks: new Set(["node-03"]), relationEdges: [] }],
        ["node-03", { id: "node-03", title: "第三章决战", path: "wiki/chapters/node-03.md", outLinks: new Set(["魔门宗主"]), inLinks: new Set([]), relationEdges: [] }],
      ]),
    }
    expect(
      nodeDistanceRerank(candidates, {
        anchors: ["续写", "第三章"],
        task: "续写第三章",
        graph: graphWithUnseparated,
      }).map((c) => c.title),
    ).toEqual(["魔门宗主", "林晚秋"])
  })

  it("RV-001: 锚点无法解析为图谱节点时发射信号且保持原始顺序返回", () => {
    const candidates = [
      { id: "c1", title: "无关条目A", relevance: 0.9 },
      { id: "c2", title: "无关条目B", relevance: 0.8 },
    ]
    const graph = {
      nodes: new Map([
        ["林晚秋", { id: "林晚秋", title: "林晚秋", path: "", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
      ]),
    }
    const res = applySearchRecipe(candidates, {
      recipe: "local",
      topK: 2,
      anchors: ["今天天气不错"],
      task: "今天天气不错",
      graph,
    })
    expect(res.map((c) => c.id)).toEqual(["c1", "c2"])
  })
})

describe("isAuthoritativeGenerationPath", () => {
  it("权威生成路径四收藏 + canon + 快照全部命中", () => {
    // 注意：收藏分支正则要求 "/wiki/<收藏>/" 含前导斜杠（调用方传入项目相对全路径）
    expect(isAuthoritativeGenerationPath("p/wiki/entities/林晚秋.md")).toBe(true)
    expect(isAuthoritativeGenerationPath("p/wiki/concepts/修真体系.md")).toBe(true)
    expect(isAuthoritativeGenerationPath("p/wiki/memory/伏笔.md")).toBe(true)
    expect(isAuthoritativeGenerationPath("p/wiki/chapters/第三章.md")).toBe(true)
    expect(isAuthoritativeGenerationPath("proj/wiki/canon.md")).toBe(true)
    expect(isAuthoritativeGenerationPath("proj/.novel/snapshots/s1.md")).toBe(true)
  })

  it("tech / 零散路径一律不算权威", () => {
    expect(isAuthoritativeGenerationPath("wiki/tech/检索工具.md")).toBe(false)
    expect(isAuthoritativeGenerationPath("wiki/other/杂项.md")).toBe(false)
    expect(isAuthoritativeGenerationPath("random.md")).toBe(false)
    expect(isAuthoritativeGenerationPath("")).toBe(false)
    // canon 必须精确落在 wiki 根下：子目录 canon 不算
    expect(isAuthoritativeGenerationPath("wiki/sub/canon.mdx")).toBe(false)
  })
})

describe("isHistoricalProjectionSnippet", () => {
  it("history 路径或 is_historical 标记即历史投影", () => {
    expect(isHistoricalProjectionSnippet("wiki/history/旧时间线.md", "正文")).toBe(true)
    expect(isHistoricalProjectionSnippet("wiki/entities/a.md", "前情 is_historical: true")).toBe(true)
    expect(isHistoricalProjectionSnippet("wiki/entities/a.md", "IS_HISTORICAL: TRUE")).toBe(true)
  })

  it("普通路径 + 普通片段不是历史投影", () => {
    expect(isHistoricalProjectionSnippet("wiki/entities/a.md", "正文片段")).toBe(false)
    expect(isHistoricalProjectionSnippet("", "")).toBe(false)
  })
})

describe("filterAuthoritative", () => {
  const nr = (over: Partial<NovelSearchResult> & { path: string }): NovelSearchResult => ({
    type: "keyword",
    title: "t",
    snippet: "s",
    relevance: 0.5,
    ...over,
  })

  it("canon / recent_chapter 永远保留，历史投影被剔除", () => {
    const items = [
      nr({ type: "canon", path: "wiki/tech/工具.md", title: "canon-tech" }),
      nr({ type: "recent_chapter", path: "random.md", title: "recent" }),
      nr({ type: "keyword", path: "wiki/entities/a.md", title: "entity", snippet: "is_historical: true" }),
      nr({ type: "keyword", path: "wiki/history/旧.md", title: "history" }),
    ]
    expect(filterAuthoritative(items).map((i) => i.title)).toEqual(["canon-tech", "recent"])
  })

  it("权威生成路径保留，非权威 keyword 丢弃", () => {
    const items = [
      nr({ path: "p/wiki/entities/林晚秋.md", title: "keep-entity" }),
      nr({ path: "proj/.novel/snapshots/s1.md", title: "keep-snap" }),
      nr({ path: "proj/wiki/canon.md", title: "keep-canon" }),
      nr({ path: "wiki/tech/工具.md", title: "drop-tech" }),
    ]
    expect(filterAuthoritative(items).map((i) => i.title)).toEqual([
      "keep-entity",
      "keep-snap",
      "keep-canon",
    ])
  })
})

describe("KB-VIEW 路由消费（真实 generated JSON）", () => {
  it("loadKbRoutingMatrix 读出写作 Agent 面五意图 allowlist", () => {
    const matrix = loadKbRoutingMatrix()
    expect(Object.keys(matrix.agent).sort()).toEqual(["draft", "lookup", "plan", "revise", "style"])
    expect(matrix.agent["draft"]).toEqual(["craft", "corpus", "lexicon", "world_ref"])
    for (const list of Object.values(matrix.agent)) {
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBeGreaterThan(0)
    }
  })

  it("loadKbRoutingViewBuiltFrom 返回 sha256 指纹", () => {
    const builtFrom = loadKbRoutingViewBuiltFrom()
    expect(typeof builtFrom).toBe("string")
    expect(builtFrom.startsWith("sha256:")).toBe(true)
    expect(builtFrom.length).toBeGreaterThan("sha256:".length)
  })

  it("loadKbCollectionCounts 返回各收藏条目数", () => {
    const counts = loadKbCollectionCounts()
    expect(counts["corpus"]).toBeGreaterThan(0)
    expect(counts["craft"]).toBeGreaterThan(0)
    expect(counts["world_ref"]).toBeGreaterThan(0)
  })

  it("routeByQueryIntent 已知意图全量路由、零缺口", () => {
    const routed = routeByQueryIntent("draft")
    expect(routed.collections).toEqual(["craft", "corpus", "lexicon", "world_ref"])
    expect(routed.gaps).toEqual([])
    expect(routed.blocked).toEqual([])
  })

  it("routeByQueryIntent 未知意图返回空路由（不抛错）", () => {
    expect(routeByQueryIntent("unknown-intent-xyz")).toEqual({
      collections: [],
      gaps: [],
      blocked: [],
    })
  })

  it("loadKbRoutingMatrix 缺 routing 即 fail-loud", () => {
    const view = kbRoutingViewMock as unknown as Record<string, unknown>
    const saved = view["routing"]
    delete view["routing"]
    try {
      expect(() => loadKbRoutingMatrix()).toThrow(/REFERENCE-KB-VIEW\.json 缺少 routing\.agent/)
      expect(() => routeByQueryIntent("draft")).toThrow(/缺少 routing\.agent/)
    } finally {
      view["routing"] = saved
    }
  })

  it("loadKbRoutingMatrix 非法矩阵形状 zod 报错", () => {
    const view = kbRoutingViewMock as unknown as Record<string, unknown>
    const routing = view["routing"] as Record<string, unknown>
    const savedAgent = routing["agent"]
    routing["agent"] = { draft: "not-an-array" }
    try {
      expect(() => loadKbRoutingMatrix()).toThrow()
    } finally {
      routing["agent"] = savedAgent
    }
  })

  it("loadKbRoutingViewBuiltFrom 缺失或空串即 fail-loud", () => {
    const view = kbRoutingViewMock as unknown as Record<string, unknown>
    const saved = view["builtFrom"]
    delete view["builtFrom"]
    try {
      expect(() => loadKbRoutingViewBuiltFrom()).toThrow(/缺少 builtFrom/)
    } finally {
      view["builtFrom"] = saved
    }
    view["builtFrom"] = ""
    try {
      expect(() => loadKbRoutingViewBuiltFrom()).toThrow(/缺少 builtFrom/)
    } finally {
      view["builtFrom"] = saved
    }
  })

  it("loadKbCollectionCounts 缺失即 fail-loud", () => {
    const view = kbRoutingViewMock as unknown as Record<string, unknown>
    const saved = view["collectionCounts"]
    delete view["collectionCounts"]
    try {
      expect(() => loadKbCollectionCounts()).toThrow(/缺少 collectionCounts/)
    } finally {
      view["collectionCounts"] = saved
    }
  })

  it("routeByQueryIntent 零收藏显式 Gap + 阻断（计数为 0）", () => {
    const view = kbRoutingViewMock as unknown as Record<string, unknown>
    const counts = view["collectionCounts"] as Record<string, unknown>
    const saved = counts["lexicon"]
    counts["lexicon"] = 0
    try {
      const routed = routeByQueryIntent("draft")
      expect(routed.collections).toEqual(["craft", "corpus", "world_ref"])
      expect(routed.blocked).toEqual(["lexicon"])
      expect(routed.gaps).toHaveLength(1)
      expect(routed.gaps[0]).toMatchObject({ collection: "lexicon", impactedIntents: ["draft"] })
      expect(routed.gaps[0].message).toContain("收藏缺失")
      expect(routed.gaps[0].message).toContain("lexicon")
    } finally {
      counts["lexicon"] = saved
    }
  })

  it("routeByQueryIntent 缺计数键按 0 处理（?? 回退分支）", () => {
    const view = kbRoutingViewMock as unknown as Record<string, unknown>
    const counts = view["collectionCounts"] as Record<string, unknown>
    const saved = counts["lexicon"]
    delete counts["lexicon"]
    try {
      const routed = routeByQueryIntent("draft")
      expect(routed.blocked).toEqual(["lexicon"])
      expect(routed.gaps).toHaveLength(1)
    } finally {
      counts["lexicon"] = saved
    }
  })
})

describe("assertNoTechLeak", () => {
  it("非 tech / 非 blocked 条目静默通过", () => {
    expect(() => assertNoTechLeak([])).not.toThrow()
    expect(() => assertNoTechLeak([null, "x", 42, {}, { collection: "entities" }])).not.toThrow()
    expect(() => assertNoTechLeak([{ collection: "TECH" }])).not.toThrow()
    expect(() => assertNoTechLeak([{ trust: "reference_only" }])).not.toThrow()
  })

  it("collection=tech 或 trust=blocked 即 fail-loud", () => {
    expect(() => assertNoTechLeak([{ collection: "tech", trust: "reference_only" }])).toThrow(
      /tech 隔离断言失败/,
    )
    expect(() => assertNoTechLeak([{ collection: "corpus", trust: "blocked" }])).toThrow(
      /tech 隔离断言失败/,
    )
  })
})

describe("tokensForKbMatch", () => {
  it("中文走 BM25 同款分词并丢弃单字 token", () => {
    expect(tokensForKbMatch("林晚秋")).toEqual(["林晚", "晚秋"])
  })

  it("ASCII 按词元小写化", () => {
    expect(tokensForKbMatch("Hello")).toEqual(["hello"])
  })

  it("去重 + cap 封顶", () => {
    expect(tokensForKbMatch("林晚秋林晚秋")).toEqual(["林晚", "晚秋", "秋林"])
    expect(tokensForKbMatch("林晚秋在云州", 3)).toEqual(["林晚", "晚秋", "秋在"])
  })

  it("空查询返回空数组", () => {
    expect(tokensForKbMatch("")).toEqual([])
    expect(tokensForKbMatch("   ")).toEqual([])
  })
})

describe("reorderByUsefulness", () => {
  const cands = [
    { title: "林晚秋佩剑", snippet: "青锋剑削铁如泥", path: "wiki/entities/a.md" },
    { title: "云州客栈", snippet: "客栈掌柜", path: "wiki/history/b.md" },
    { title: "魔门", snippet: "【冲突】与正文矛盾", path: "wiki/entities/c.md" },
    { title: "天剑门", snippet: "canon_conflict 标记", path: "wiki/entities/d.md" },
  ]

  it("冲突候选否决制剔除，实体提示加分、历史投影降权", () => {
    const ranked = reorderByUsefulness(cands, { entityHints: ["林晚秋", "  ", "青锋"] })
    // c1: 标题命中林晚秋(+1) + 片段命中青锋(+1) = 2；c2: 无命中但历史投影(-1) = -1
    expect(ranked.map((c) => c.title)).toEqual(["林晚秋佩剑", "云州客栈"])
  })

  it("硬注入去重：已注入 path 扣分沉底", () => {
    const ranked = reorderByUsefulness(cands, {
      hardInjectRefs: new Set(["wiki/entities/a.md"]),
    })
    // c1: 0 - 2 = -2；c2: 0 - 1(历史投影) = -1 → c2 在前
    expect(ranked.map((c) => c.title)).toEqual(["云州客栈", "林晚秋佩剑"])
  })

  it("无 ctx 时保持原始相对顺序（仅剔除冲突）", () => {
    expect(reorderByUsefulness(cands).map((c) => c.title)).toEqual(["林晚秋佩剑", "云州客栈"])
    expect(reorderByUsefulness([])).toEqual([])
  })
})

describe("generateMultiQueries", () => {
  it("实体分面拼出扩展查询（含原查询，上限 3）", () => {
    const query = "character:林晚秋 云州客栈"
    const d = decomposeNovelQuery(query)
    expect(d.facets.character).toBe("林晚秋")
    expect(generateMultiQueries(query, d)).toEqual([query, "林晚秋 云州客栈"])
  })

  it("verbatim 字面量独立成查询", () => {
    const query = "「青锋剑」在何处"
    const d = decomposeNovelQuery(query)
    expect(d.verbatim).toEqual(["青锋剑"])
    expect(generateMultiQueries(query, d)).toEqual([query, "青锋剑"])
  })

  it("maxQueries 封顶：verbatim 超量时截断", () => {
    const d: QueryDecomposition = {
      original: "q",
      verbatim: ["a", "b", "c", "d"],
      entityMentions: [],
      facets: {},
      rest: "q",
    }
    expect(generateMultiQueries("q", d, { maxQueries: 2 })).toEqual(["q", "a"])
  })

  it("maxQueries=1 时只保留原查询", () => {
    const d = decomposeNovelQuery("「青锋剑」在何处")
    expect(generateMultiQueries("「青锋剑」在何处", d, { maxQueries: 1 })).toEqual(["「青锋剑」在何处"])
  })

  it("includeVerbatimLift=false 跳过字面量提升", () => {
    const d = decomposeNovelQuery("「青锋剑」在何处")
    expect(generateMultiQueries("「青锋剑」在何处", d, { includeVerbatimLift: false })).toEqual([
      "「青锋剑」在何处",
    ])
  })

  it("includeEntityExpand=false 跳过实体扩展", () => {
    const query = "character:林晚秋 云州客栈"
    const d = decomposeNovelQuery(query)
    expect(generateMultiQueries(query, d, { includeEntityExpand: false })).toEqual([query])
  })

  it("空 verbatim + 空分面时只返回原查询（去重/空分支）", () => {
    const d: QueryDecomposition = {
      original: "q",
      verbatim: [""],
      entityMentions: [],
      facets: {},
      rest: "",
    }
    expect(generateMultiQueries("q", d)).toEqual(["q"])
  })

  it("扩展查询与原查询相同时不重复追加", () => {
    const d: QueryDecomposition = {
      original: "林晚秋",
      verbatim: [],
      entityMentions: [],
      facets: { character: "林晚秋" },
      rest: "",
    }
    // expandedQuery = "林晚秋" === query → 跳过
    expect(generateMultiQueries("林晚秋", d)).toEqual(["林晚秋"])
  })
})

describe("fuseAcrossQueries", () => {
  const nr = (over: Partial<NovelSearchResult> & { path: string }): NovelSearchResult => ({
    type: "keyword",
    title: "t",
    snippet: "s",
    relevance: 0.5,
    ...over,
  })

  it("单分支按 weight/(K+rank+1) 计分并重写 relevance", () => {
    const [only] = fuseAcrossQueries([[nr({ path: "A.md", relevance: 0.9 })]])
    // keyword weight 1.0, K=60, rank 0 → 1/61 ≈ 0.016393
    expect(only.relevance).toBe(0.016393)
    expect(only.path).toBe("A.md")
  })

  it("跨分支同 path（归一化后）分数累加并保留首分支公开字段", () => {
    const fused = fuseAcrossQueries([
      [nr({ type: "keyword", path: "A.md", title: "first", relevance: 0.5 })],
      [nr({ type: "graph", path: "a.md", title: "second", relevance: 0.9 })],
    ])
    // (1.0 + 0.95)/61 ≈ 0.031967
    expect(fused).toHaveLength(1)
    expect(fused[0].relevance).toBe(0.031967)
    expect(fused[0].title).toBe("first")
  })

  it("反斜杠与大小写路径归一到同一融合键", () => {
    const fused = fuseAcrossQueries([[nr({ path: "X\\Y.md" }), nr({ path: "x/y.md" })]])
    // rank0: 1/61, rank1: 1/62 → 累加
    expect(fused).toHaveLength(1)
    expect(fused[0].relevance).toBe(Math.round((1 / 61 + 1 / 62) * 1_000_000) / 1_000_000)
  })

  it("自定义 rrfK 改变衰减", () => {
    const [only] = fuseAcrossQueries([[nr({ path: "A.md" })]], 10)
    expect(only.relevance).toBe(Math.round((1 / 11) * 1_000_000) / 1_000_000)
  })

  it("未知 type 回退权重 0.8", () => {
    const [only] = fuseAcrossQueries([
      [nr({ path: "A.md", type: "alien" as unknown as NovelSearchResult["type"] })],
    ])
    expect(only.relevance).toBe(Math.round((0.8 / 61) * 1_000_000) / 1_000_000)
  })

  it("空分支返回空数组", () => {
    expect(fuseAcrossQueries([])).toEqual([])
    expect(fuseAcrossQueries([[]])).toEqual([])
  })

  it("多候选按融合分降序排列", () => {
    const fused = fuseAcrossQueries([
      [
        nr({ path: "B.md", type: "graph" }),
        nr({ path: "A.md", type: "keyword" }),
      ],
    ])
    // A: 1/62 ≈ 0.016129；B: 0.95/61 ≈ 0.015574 → A 在前
    expect(fused.map((r) => r.path)).toEqual(["A.md", "B.md"])
    expect(fused[0].relevance).toBe(Math.round((1 / 62) * 1_000_000) / 1_000_000)
    expect(fused[1].relevance).toBe(Math.round((0.95 / 61) * 1_000_000) / 1_000_000)
  })
})

describe("mmrRerank 增补", () => {
  it("字符串候选：首个最高归一分，长度受 k 约束", () => {
    expect(mmrRerank(["aa", "bb", "cc"], { k: 2 })).toEqual(["aa", "bb"])
  })

  it("null / 无 relevance 候选走默认文本与零分分支", () => {
    const res = mmrRerank<string | null>([null, "ab", "cd"], { k: 2 })
    expect(res).toHaveLength(2)
    expect(res[0]).toBeNull()
  })

  it("自定义 similarity 接管相似度计算", () => {
    const cands = [
      { id: "c1", title: "林晚秋佩剑", snippet: "青锋剑", relevance: 0.9 },
      { id: "c2", title: "云州客栈", snippet: "掌柜", relevance: 0.8 },
    ]
    const res = mmrRerank(cands, { k: 2, similarity: () => 0 })
    expect(res.map((c) => c.id)).toEqual(["c1", "c2"])
  })

  it("lambda 越界时钳制到 [0,1]：5 等价纯相关性，-1 等价纯多样性", () => {
    const cands = [
      { id: "c1", title: "林晚秋佩剑", snippet: "林晚秋的佩剑乃是青锋宝剑", relevance: 0.9 },
      { id: "c2", title: "林晚秋青锋剑", snippet: "林晚秋随身佩剑乃是青锋剑", relevance: 0.88 },
      { id: "c3", title: "灵兽丹", snippet: "喂养灵兽专用的珍稀丹药", relevance: 0.7 },
    ]
    expect(mmrRerank(cands, { k: 3, lambda: 5 }).map((c) => c.id)).toEqual(["c1", "c2", "c3"])
    expect(mmrRerank(cands, { k: 2, lambda: -1 }).map((c) => c.id)).toEqual(["c1", "c3"])
  })

  it("单字文本相似度走 trim 相等分支（0.0），tie 按原始索引稳定", () => {
    const cands = [
      { id: "a", title: "a", snippet: "", relevance: 0.5 },
      { id: "b", title: "b", snippet: "", relevance: 0.5 },
      { id: "c", title: "c", snippet: "", relevance: 0.4 },
    ]
    expect(mmrRerank(cands, { k: 3 }).map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("mmr 打平但后者归一分更高时后来者居上（tie-break 高分优先）", () => {
    const cands = [
      { id: "a", title: "aaaa", snippet: "", relevance: 1.0 },
      { id: "b", title: "bbbb", snippet: "", relevance: 0.9 },
      { id: "c", title: "cccc", snippet: "", relevance: 0.95 },
    ]
    const sim = (x: { id: string }, y: { id: string }): number => {
      const pair = [x.id, y.id].sort().join("")
      if (pair === "ab") return 0.5
      if (pair === "ac") return 0.55
      if (pair === "bc") return 0.9
      return 0
    }
    // round2: mmr(b) = .45-.25 = .2, mmr(c) = .475-.275 ≈ .2 → 打平，c 归一分更高
    expect(mmrRerank(cands, { k: 3, lambda: 0.5, similarity: sim }).map((c) => c.id)).toEqual([
      "a",
      "c",
      "b",
    ])
  })
})

describe("nodeDistanceRerank 增补：图谱形态与锚点解析", () => {
  const mapNode = (
    id: string,
    links: { out?: string[]; in?: string[]; rel?: Array<{ target: string } | null | object> } = {},
    path = `wiki/entities/${id}.md`,
  ) =>
    [
      id,
      {
        id,
        title: id,
        path,
        outLinks: new Set(links.out ?? []),
        inLinks: new Set(links.in ?? []),
        relationEdges: links.rel ?? [],
      },
    ] as const

  it("非对象 graph 直接返回拷贝（buildGraphIndex null 分支）", () => {
    const cands = [{ id: "c1", relevance: 0.9 }]
    const res = nodeDistanceRerank(cands, { anchors: ["A"], graph: "nope" })
    expect(res).toEqual(cands)
    expect(res).not.toBe(cands)
  })

  it("relationEdges（含 target / null / 无 target）参与建边", () => {
    const graph = {
      nodes: new Map([
        mapNode("A", { rel: [{ target: "B" }, null, {}] }),
        mapNode("B"),
      ]),
    }
    const cands = [
      { id: "far", title: "远方", relevance: 0.95 },
      { id: "b", title: "B", relevance: 0.9 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["A"], graph })
    // B 经 relationEdge 1 跳：0.9*0.8=0.72；远方不可达：0.95*0.8^4≈0.389
    expect(res.map((c) => c.id)).toEqual(["b", "far"])
    expect(res[0].relevance).toBe(0.72)
  })

  it("Map 实例邻接表图谱可建边", () => {
    const graph = new Map([
      ["A", ["B"]],
      ["B", ["A", "C"]],
      ["C", ["B"]],
    ])
    const cands = [
      { id: "far", title: "远", relevance: 0.99 },
      { id: "c", title: "C", relevance: 0.9 },
      { id: "b", title: "B", relevance: 0.85 },
    ]
    const res = nodeDistanceRerank(cands, {
      anchors: ["A"],
      graph,
      unreachableDecay: 0.05,
    })
    expect(res.map((c) => c.id)).toEqual(["b", "c", "far"])
    expect(res[2].relevance).toBeCloseTo(0.0495, 10)
  })

  it("普通对象邻接表图谱可建边（缺省 decay 生效）", () => {
    const graph = { A: ["B"], B: ["A"] }
    const cands = [
      { id: "far", title: "孤", relevance: 0.9 },
      { id: "b", title: "B", relevance: 0.5 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["A"], graph })
    // B 1 跳 0.4；孤不可达 0.9*0.8^4=0.36864
    expect(res.map((c) => c.id)).toEqual(["b", "far"])
    expect(res[1].relevance).toBe(0.36864)
  })

  it("edges 数组 + 字符串节点 / 非法边安全跳过", () => {
    const graph = {
      nodes: ["A", "B"],
      edges: [{ source: "A", target: "B" }, null, { foo: 1 }],
    }
    const cands = [
      { id: "far", title: "远方", relevance: 0.95 },
      { id: "b", title: "B", relevance: 0.5 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["A"], graph })
    expect(res.map((c) => c.id)).toEqual(["b", "far"])
  })

  it("edges 数组对象节点：重复 id 后补 title 生效，别名可解析 title", () => {
    const graph = {
      nodes: [{ id: "A" }, { id: "A", title: "ATitle" }, { id: "B", title: "BTitle" }],
      edges: [{ source: "A", target: "B" }],
    }
    const cands = [
      { id: "far", title: "远方", relevance: 0.9 },
      { id: "b", title: "B", relevance: 0.5 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["ATitle"], graph })
    expect(res.map((c) => c.id)).toEqual(["b", "far"])
    expect(res[0].relevance).toBe(0.4)
  })

  it("空 id 节点 + 空锚点：解析失败走 warn 原样返回", () => {
    const graph = {
      nodes: new Map([
        ["", { id: "", title: "", path: "", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
      ]),
    }
    const cands = [{ id: "x", relevance: 0.5 }]
    expect(nodeDistanceRerank(cands, { anchors: [""], graph })).toEqual(cands)
  })

  it("maxAnchors=1 在显式别名命中后提前返回（仅首锚点参与 BFS）", () => {
    const graph = {
      nodes: new Map([mapNode("A", { out: ["B"] }), mapNode("B", { out: ["C"] }), mapNode("C")]),
    }
    const cands = [{ id: "c", title: "C", relevance: 0.5 }]
    const one = nodeDistanceRerank(cands, { anchors: ["A", "B"], maxAnchors: 1, graph })
    const all = nodeDistanceRerank(cands, { anchors: ["A", "B"], graph })
    // 仅 A：C 为 2 跳 0.5*0.64=0.32；A+B：C 为 1 跳 0.5*0.8=0.4
    expect(one[0].relevance).toBe(0.32)
    expect(all[0].relevance).toBe(0.4)
  })

  it("maxAnchors=1 在任务序号唯一命中后提前返回", () => {
    const graph = {
      nodes: new Map([
        ["chapter-170", { id: "chapter-170", title: "新灵气契约", path: "wiki/chapters/c170.md", outLinks: new Set(["云州客栈"]), inLinks: new Set<string>(), relationEdges: [] }],
        mapNode("云州客栈", { in: ["chapter-170"] }),
        mapNode("林晚秋"),
      ]),
    }
    const cands = [
      { id: "lin", title: "林晚秋", relevance: 0.9 },
      { id: "yun", title: "云州客栈", relevance: 0.5 },
    ]
    const res = nodeDistanceRerank(cands, {
      anchors: [],
      task: "写第170章：林晚秋拔剑",
      maxAnchors: 1,
      graph,
    })
    // 仅 chapter-170：云州 1 跳 0.4 > 林晚秋不可达 0.9*0.8^4≈0.369
    expect(res.map((c) => c.id)).toEqual(["yun", "lin"])
    expect(res[0].relevance).toBe(0.4)
  })

  it("maxAnchors=1 在任务文本扫描命中后提前返回", () => {
    const graph = {
      nodes: new Map([mapNode("林晚秋", { out: ["云州客栈"] }), mapNode("云州客栈"), mapNode("魔门")]),
    }
    const cands = [
      { id: "mo", title: "魔门", relevance: 0.95 },
      { id: "yun", title: "云州客栈", relevance: 0.5 },
    ]
    const res = nodeDistanceRerank(cands, {
      anchors: [],
      task: "林晚秋在云州客栈",
      maxAnchors: 1,
      graph,
    })
    expect(res.map((c) => c.id)).toEqual(["yun", "mo"])
  })

  it("任务扫描排序：同位置更长实体优先，同位置同长按 id 字母序", () => {
    const graph = {
      nodes: new Map([
        ["n1", { id: "n1", title: "林晚", path: "p1", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
        ["n2", { id: "n2", title: "林晚", path: "p2", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
        ["n3", { id: "n3", title: "林晚秋", path: "p3", outLinks: new Set(), inLinks: new Set(), relationEdges: [] }],
      ]),
    }
    const cands = [{ title: "n1" }, { title: "n2", relevance: 0.5 }]
    // "林晚"：n1/n2 同 pos 同 len → localeCompare 确定性顺序
    const r1 = nodeDistanceRerank(cands, { task: "林晚", graph })
    expect(r1.map((c) => c.title)).toEqual(["n1", "n2"])
    // 无 relevance 字段的候选按原对象返回（不补 relevance）
    expect(r1[0]).toEqual({ title: "n1" })
    // "林晚秋"：n3(pos0,len4) 排在 n1/n2(pos0,len2) 之前
    const r2 = nodeDistanceRerank(cands, { task: "林晚秋", graph })
    expect(r2.map((c) => c.title)).toEqual(["n1", "n2"])
    // 已显式锚定的节点在任务扫描中跳过
    const r3 = nodeDistanceRerank(cands, { anchors: ["n1"], task: "林晚", graph })
    expect(r3.map((c) => c.title)).toEqual(["n1", "n2"])
    // 两次运行逐字节确定
    expect(JSON.stringify(r1)).toBe(JSON.stringify(nodeDistanceRerank(cands, { task: "林晚", graph })))
  })

  it("方向一包含（anchor 含节点 stem）命中并参与排序", () => {
    const graph = {
      nodes: new Map([mapNode("林晚秋"), mapNode("魔门")]),
    }
    const cands = [
      { id: "mo", title: "魔门", relevance: 0.95 },
      { id: "lin", title: "林晚秋", relevance: 0.7 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["林晚秋拔剑"], graph })
    expect(res.map((c) => c.id)).toEqual(["lin", "mo"])
  })

  it("双向包含排序 + maxAnchors=1（章节节点跳过包含匹配）", () => {
    const graph = {
      nodes: new Map([
        mapNode("林晚秋"),
        mapNode("云州客栈"),
        mapNode("魔门"),
        ["chapter-170", { id: "chapter-170", title: "夜袭", path: "c", outLinks: new Set<string>(), inLinks: new Set<string>(), relationEdges: [] }],
      ]),
    }
    const cands = [
      { id: "lin", title: "林晚秋", relevance: 0.9 },
      { id: "yun", title: "云州客栈", relevance: 0.6 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["林晚", "云州"], maxAnchors: 1, graph })
    // 林晚→林晚秋 / 云州→云州客栈均为 matchLen 2，按 id 字母序云州客栈在前 → 仅它成锚
    // 无边：云州 0 跳 0.6 > 林晚秋不可达 0.9*0.8^4≈0.369
    expect(res.map((c) => c.id)).toEqual(["yun", "lin"])
    expect(res[0].relevance).toBe(0.6)
  })

  it("maxDepth=0 时 BFS 不扩散，邻居按不可达衰减", () => {
    const graph = { nodes: new Map([mapNode("A", { out: ["B"] }), mapNode("B", { in: ["A"] })]) }
    const cands = [
      { id: "a", title: "A", relevance: 0.5 },
      { id: "b", title: "B", relevance: 0.9 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["A"], maxDepth: 0, graph })
    // unreachableDecay 缺省 = 0.8^(0+1) = 0.8 → B: 0.72 > A: 0.5
    expect(res.map((c) => c.id)).toEqual(["b", "a"])
    expect(res[0].relevance).toBeCloseTo(0.72, 10)
  })

  it("幽灵邻居（未注册别名）经 ?? 回退参与距离计算", () => {
    const graph = {
      nodes: new Map([mapNode("A", { out: ["幽灵"] })]),
    }
    const cands = [
      { id: "far", title: "远方", relevance: 0.95 },
      { id: "ghost", title: "幽灵", relevance: 0.9 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["A"], graph })
    // 幽灵 1 跳 0.72；远方不可达 0.95*0.8^4≈0.389
    expect(res.map((c) => c.id)).toEqual(["ghost", "far"])
    expect(res[0].relevance).toBeCloseTo(0.72, 10)
  })

  it("候选含子串命中已解析节点（title 包含 distanceMap 节点）", () => {
    const graph = {
      nodes: new Map([mapNode("林晚秋", { out: ["云州"] }), mapNode("云州")]),
    }
    const cands = [
      { id: "other", title: "远方", relevance: 0.95 },
      { id: "hit", title: "林晚秋在此", relevance: 0.9 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["云州"], graph })
    // "林晚秋在此" 精确解析失败，但包含 1 跳节点林晚秋 → 0.9*0.8=0.72
    expect(res.map((c) => c.id)).toEqual(["hit", "other"])
    expect(res[0].relevance).toBeCloseTo(0.72, 10)
  })

  it("候选 path 大小写不一致经小写别名解析到锚点", () => {
    const graph = {
      nodes: new Map([mapNode("林晚秋", {}, "wiki/entities/林晚秋.md")]),
    }
    const cands = [
      { id: "other", title: "远方", relevance: 0.95 },
      { id: "hit", path: "WIKI/ENTITIES/林晚秋.MD", relevance: 0.7 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["林晚秋"], graph })
    expect(res.map((c) => c.id)).toEqual(["hit", "other"])
    expect(res[0].relevance).toBe(0.7)
  })

  it("候选 path 经词干别名解析到锚点", () => {
    // 大写路径：词干 "ReadMe" 与小写词干 "readme" 分别注册（lowerStem 分支）
    const graph = {
      nodes: new Map([mapNode("DocNode", {}, "DOCs/ReadMe.MD")]),
    }
    const cands = [
      { id: "other", title: "远方", relevance: 0.95 },
      { id: "hit", path: "x/README", relevance: 0.7 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["DocNode"], graph })
    expect(res.map((c) => c.id)).toEqual(["hit", "other"])
  })

  it("id 与词干不一致的节点同时参与任务扫描与包含匹配", () => {
    const longNode = (id: string) =>
      [
        id,
        {
          id,
          title: "林晚秋",
          path: id,
          outLinks: new Set<string>(),
          inLinks: new Set<string>(),
          relationEdges: [],
        },
      ] as const
    const graph = {
      // longNode/mapNode 均为 as const 只读元组：显式标注值类型以统一
      // 可变字面量与只读 helper 产物的 Map 推断（运行时均为普通节点对象）。
      nodes: new Map<
        string,
        {
          id: string
          title: string
          path: string
          outLinks: Set<string>
          inLinks: Set<string>
          relationEdges: readonly unknown[]
        }
      >([longNode("P/林晚秋.md"), mapNode("魔门")]),
    }
    const cands = [
      { id: "mo", title: "魔门", relevance: 0.95 },
      { id: "lin", title: "P/林晚秋.md", relevance: 0.6 },
    ]
    // 任务扫描：id("P/林晚秋.md")与词干("林晚秋")分别计入 keysToTest
    const viaTask = nodeDistanceRerank(cands, { task: "林晚秋", graph })
    expect(viaTask.map((c) => c.id)).toEqual(["lin", "mo"])
    expect(viaTask[0].relevance).toBe(0.6)
    // 包含匹配：anchor 含词干 → 方向一命中
    const viaAnchor = nodeDistanceRerank(cands, { anchors: ["林晚秋在此"], graph })
    expect(viaAnchor.map((c) => c.id)).toEqual(["lin", "mo"])
  })

  it("同一节点多次包含匹配按 matchLen 降序", () => {
    const graph = {
      nodes: new Map([mapNode("林晚秋"), mapNode("魔门")]),
    }
    const cands = [
      { id: "mo", title: "魔门", relevance: 0.95 },
      { id: "lin", title: "林晚秋", relevance: 0.5 },
    ]
    // "林晚秋拔剑"→matchLen 3；"林晚"→matchLen 2：排序器走不等分支
    const res = nodeDistanceRerank(cands, { anchors: ["林晚秋拔剑", "林晚"], graph })
    expect(res.map((c) => c.id)).toEqual(["lin", "mo"])
  })

  it("字符串候选保持原序（非对象分支）", () => {
    const graph = new Map([["A", ["B"]]])
    expect(nodeDistanceRerank(["aa", "bb"], { anchors: ["A"], graph })).toEqual(["aa", "bb"])
  })

  it("孤立锚点 getNeighbors 为空仍可排序", () => {
    const graph = { nodes: new Map([mapNode("孤岛"), mapNode("远方")]) }
    const cands = [
      { id: "far", title: "远方", relevance: 0.95 },
      { id: "iso", title: "孤岛", relevance: 0.5 },
    ]
    const res = nodeDistanceRerank(cands, { anchors: ["孤岛"], graph })
    expect(res.map((c) => c.id)).toEqual(["iso", "far"])
  })
})

describe("applySearchRecipe 增补", () => {
  it("未知 recipe 回退 slice 保底", () => {
    const cands = [
      { id: "1", title: "A", snippet: "AAA", relevance: 0.9 },
      { id: "2", title: "B", snippet: "BBB", relevance: 0.8 },
    ]
    expect(
      applySearchRecipe(cands, { recipe: "zzz" as unknown as SearchRecipeId, topK: 1 }),
    ).toEqual([cands[0]])
  })

  it("local 无 graph / 无锚点任务时跳过 NodeDistance 直接截断", () => {
    const cands = [
      { id: "1", title: "A", snippet: "AAA", relevance: 0.9 },
      { id: "2", title: "B", snippet: "BBB", relevance: 0.8 },
    ]
    expect(applySearchRecipe(cands, { recipe: "local", topK: 1, anchors: ["A"] })).toEqual([cands[0]])
    const graph = { nodes: [{ id: "A" }, { id: "B" }], edges: [] }
    expect(applySearchRecipe(cands, { recipe: "local", topK: 1, graph })).toEqual([cands[0]])
  })

  it("balanced 无 graph 时仅执行 MMR", () => {
    const cands = [
      { id: "c1", title: "青锋剑", snippet: "林晚秋的佩剑乃是青锋宝剑", relevance: 0.9 },
      { id: "c2", title: "青锋剑", snippet: "林晚秋随身佩剑乃是青锋剑", relevance: 0.88 },
      { id: "c3", title: "灵兽丹", snippet: "喂养灵兽专用的珍稀丹药", relevance: 0.7 },
    ]
    // balanced mmrLambda=0.75 比 diverse(0.7)更重相关性：c2 相关性优势盖过冗余惩罚
    expect(
      applySearchRecipe(cands, { recipe: "balanced", topK: 2 }).map((c) => c.id),
    ).toEqual(["c1", "c2"])
  })

  it("自定义 similarity / textOf 透传给 MMR", () => {
    const cands = [
      { id: "c1", title: "A", snippet: "x", relevance: 0.9 },
      { id: "c2", title: "B", snippet: "y", relevance: 0.8 },
      { id: "c3", title: "C", snippet: "z", relevance: 0.7 },
    ]
    const res = applySearchRecipe(cands, {
      recipe: "diverse",
      topK: 2,
      similarity: () => 0,
      textOf: (x) => (x as { id: string }).id,
    })
    expect(res.map((c) => c.id)).toEqual(["c1", "c2"])
  })
})
