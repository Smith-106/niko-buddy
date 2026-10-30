import { describe, it, expect } from "vitest"
import { tokenizeQuery } from "@/lib/search"
import {
  charShingleJaccard,
  getCharShingles,
  mmrRerank,
  nodeDistanceRerank,
  applySearchRecipe,
  SEARCH_RECIPES,
  SEARCH_RECIPE_IDS,
  isSearchRecipeId,
} from "./search-strategy"

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
