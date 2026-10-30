import { describe, it, expect } from "vitest"
import {
  charShingleJaccard,
  mmrRerank,
  nodeDistanceRerank,
  applySearchRecipe,
  SEARCH_RECIPES,
} from "./search-strategy"

describe("charShingleJaccard", () => {
  it("相同文本返回 1.0，完全不相交文本返回 0.0", () => {
    expect(charShingleJaccard("玄阴谷", "玄阴谷")).toBe(1.0)
    expect(charShingleJaccard("  云州客栈  ", "云州客栈")).toBe(1.0)
    expect(charShingleJaccard("", "")).toBe(1.0)
    expect(charShingleJaccard("玄阴谷", "魔门宗主")).toBe(0.0)
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
  })
})
