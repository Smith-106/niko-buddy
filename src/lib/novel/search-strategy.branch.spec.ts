import { describe, expect, it, vi } from "vitest"

vi.mock("./kb/kb-routing-view.generated.json", async (importOriginal) => {
  const actual = (await importOriginal()) as unknown as { default?: unknown }
  const data = actual && typeof actual === "object" && "default" in actual ? actual.default : actual
  return { default: JSON.parse(JSON.stringify(data)) as unknown }
})

import {
  assertNoTechLeak,
  charShingleJaccard,
  mmrRerank,
  nodeDistanceRerank,
} from "./search-strategy"
import type { NovelSearchResult } from "./search-adapter"

/**
 * 分支覆盖增补（BRANCH-BRIEF：search-strategy 33 miss）。只增补，不改既有用例。
 * 另有 5 处经论证不可达（见报告），此处仅覆盖可达分支。
 */

function result(path: string, relevance = 0.5, title = "标题"): NovelSearchResult {
  return { type: "keyword", path, title, snippet: `正文 ${title}`, relevance }
}

describe("search-strategy 分支增补", () => {
  it("assertNoTechLeak 对缺字段的命中项回退为 ?", () => {
    expect(() => assertNoTechLeak([{ trust: "blocked" }])).toThrow("?")
    expect(() => assertNoTechLeak([{ collection: "tech" }])).toThrow("trust=?")
    // 正常项不抛错
    expect(() => assertNoTechLeak([{ collection: "canon", trust: "ok" }])).not.toThrow()
  })

  it("mmrRerank 对无 relevance 候选走名次回退归一", () => {
    const out = mmrRerank(
      [
        { id: "a", title: "甲", snippet: "甲文" },
        { id: "b", title: "乙", snippet: "乙文" },
      ],
      { k: 2 },
    )
    expect(out.map((c) => (c as { id: string }).id)).toEqual(["a", "b"])
  })

  it("mmrRerank 修剪相等文本按 1.0 相似度去重排序", () => {
    const out = mmrRerank(["a", "a "], { k: 2 })
    expect(out).toEqual(["a", "a "])
  })

  it("charShingleJaccard 空 shingle 经守卫返回 0", () => {
    expect(charShingleJaccard("", "x")).toBe(0.0)
  })

  it("Map 节点缺 id/title/path/链接时走别名回退与跳过分支", () => {
    const graph = {
      nodes: new Map<string, Record<string, unknown>>([
        ["k1", { title: "林晚秋", path: "chars/林晚秋.md", outLinks: new Set(["k2"]), inLinks: new Set(["k2"]), relationEdges: [{ target: "k2" }] }],
        ["k2", {}],
      ]),
    }
    const candidates = [result("chars/林晚秋.md", 0.9, "林晚秋"), result("other.md", 0.5, "无关")]
    const out = nodeDistanceRerank(candidates, { anchors: ["林晚秋"], graph })
    expect(out[0]?.path).toBe("chars/林晚秋.md")
  })

  it("edges 数组图支持字符串/对象/非法节点与缺字段边", () => {
    const graph = {
      nodes: ["a", { title: "NoId" }, 42],
      edges: [
        { source: "a", target: "b" },
        { from: "x" },
      ],
    }
    const out = nodeDistanceRerank([result("a", 1, "a"), result("zzz", 0.5, "zzz")], {
      anchors: ["a"],
      graph,
    })
    expect(out.map((c) => c.title)).toEqual(["a", "zzz"])
  })

  it("Map 图非集合邻接与对象图非数组邻接直接跳过", () => {
    const mapGraph = new Map<string, unknown>([["a", 42]])
    const out1 = nodeDistanceRerank([result("a", 1, "a")], { anchors: ["a"], graph: mapGraph })
    expect(out1).toHaveLength(1)

    const objGraph = { a: 7 }
    const out2 = nodeDistanceRerank([result("a", 1, "a")], { anchors: ["a"], graph: objGraph })
    expect(out2).toHaveLength(1)
  })

  it("registerNode 对 .md 残干回退到完整 id", () => {
    const graph = { ".md": ["x"], x: [".md"] }
    const out = nodeDistanceRerank([result("x", 1, "x"), result("zzz", 0.5, "zzz")], {
      anchors: ["x"],
      graph,
    })
    expect(out[0]?.title).toBe("x")
  })

  it("单字干在任务扫描中被跳过", () => {
    const graph = {
      nodes: new Map<string, Record<string, unknown>>([
        ["林晚秋", { title: "林晚秋传" }],
        ["q", {}],
      ]),
    }
    const out = nodeDistanceRerank(
      [result("p1", 0.5, "林晚秋"), result("p2", 0.9, "云州")],
      { task: "林晚秋佩剑", graph },
    )
    expect(out[0]?.title).toBe("林晚秋")
  })

  it("同位置更长实体覆盖短命中", () => {
    const graph = {
      nodes: new Map<string, Record<string, unknown>>([["林晚", { title: "林晚秋" }]]),
    }
    const out = nodeDistanceRerank(
      [result("p1", 0.5, "林晚"), result("p2", 0.9, "云州")],
      { task: "林晚秋佩剑", graph },
    )
    expect(out[0]?.title).toBe("林晚")
  })

  it("edges 数组图无 nodes 数组时仍可建边", () => {
    const graph = { edges: [{ source: "a", target: "b" }] }
    const out = nodeDistanceRerank([result("a", 1, "a"), result("zzz", 0.5, "zzz")], {
      anchors: ["a"],
      graph,
    })
    expect(out.map((c) => c.title)).toEqual(["a", "zzz"])
  })

  it("任务扫描中靠后出现的位置不更新最佳命中", () => {
    const graph = {
      nodes: new Map<string, Record<string, unknown>>([["甲乙", { title: "丙丁" }]]),
    }
    const out = nodeDistanceRerank(
      [result("p1", 0.5, "甲乙"), result("p2", 0.9, "云州")],
      { task: "甲乙先行丙丁随后", graph },
    )
    expect(out[0]?.title).toBe("甲乙")
  })

  it("重复锚点只解析一次", () => {
    const graph = {
      nodes: new Map<string, Record<string, unknown>>([["林晚秋", { title: "林晚秋传" }]]),
    }
    const out = nodeDistanceRerank([result("p1", 0.7, "林晚秋")], {
      anchors: ["林晚秋", "林晚秋"],
      graph,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.relevance).toBeCloseTo(0.7, 5)
  })

  it("候选命中多节点时取最小距离", () => {
    const graph = { "林晚": ["晚秋"], "晚秋": ["林晚"] }
    const out = nodeDistanceRerank([result("p1", 1, "林晚晚秋")], {
      anchors: ["林晚"],
      graph,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.relevance).toBeCloseTo(1.0, 5)
  })
})
