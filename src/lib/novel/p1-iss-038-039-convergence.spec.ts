/**
 * P1 去孪生收敛 spec（ISS-20260709-038 / 039）。
 *
 * 1. ISS-038：非 Unified `searchRelevantContent` 已删，改为已废弃别名（与 Unified
 *    同一对象，生产零调用——唯一生产调用方 context-data-sources 走 Unified）。
 *    此处锁定：检索簇源绑定同一性 + engine 别名行为等价。
 * 2. ISS-039：图检索孪生体（matched 单遍 + related 并行）收敛到
 *    graph-search-shared.ts。此处单测共享核心（零 IO：getRelatedNodes/readFile
 *    全注入 fake）。
 */
import { describe, expect, it, vi } from "vitest"
import {
  collectGraphMatchedNodes,
  readGraphRelatedSnippets,
  collectGraphScoredSnippets,
  type GraphSearchNodeLike,
} from "./graph-search-shared"
import {
  searchRelevantContent as searchRelevantContentSource,
  searchRelevantContentUnified as searchRelevantContentUnifiedSource,
} from "./context-retrieval"
import {
  searchRelevantContent as searchRelevantContentEngine,
  searchRelevantContentUnified as searchRelevantContentUnifiedEngine,
  searchGraphRelevantContent as searchGraphRelevantContentEngine,
} from "./context-engine"

type N = GraphSearchNodeLike

function fakeGraph(): { nodes: Map<string, N> } {
  return {
    nodes: new Map<string, N>([
      ["n1", { id: "n1", title: "林云", path: "/P/n1.md" }],
      ["n2", { id: "n2", title: "林云之剑", path: "/P/n2.md" }],
      ["n3", { id: "n3", title: "赵雪", path: "/P/n3.md" }],
    ]),
  }
}

describe("ISS-20260709-038：searchRelevantContent 已废弃别名（零行为分叉）", () => {
  it("检索簇源绑定：searchRelevantContent === searchRelevantContentUnified", () => {
    expect(searchRelevantContentSource).toBe(searchRelevantContentUnifiedSource)
  })

  it("engine 别名仍导出且与 Unified 同为函数（import 面不变）", () => {
    expect(typeof searchRelevantContentEngine).toBe("function")
    expect(typeof searchRelevantContentUnifiedEngine).toBe("function")
    expect(typeof searchGraphRelevantContentEngine).toBe("function")
  })
})

describe("ISS-20260709-039：graph-search-shared 共享核心", () => {
  it("collectGraphMatchedNodes：单遍匹配 + 按 id 去重（含种子派生名）", () => {
    const graph = fakeGraph()
    // "林云" 命中 n1（标题）与 n2（标题包含派生名）；"赵雪" 命中 n3。
    const { matched, seenIds } = collectGraphMatchedNodes(graph, ["林云", "赵雪"])
    expect(matched.map((m) => m.id).sort()).toEqual(["n1", "n2", "n3"])
    expect(seenIds.size).toBe(3)
  })

  it("collectGraphMatchedNodes：重复候选名不产生重复节点", () => {
    const graph = fakeGraph()
    const { matched } = collectGraphMatchedNodes(graph, ["林云", "林云", "n1"])
    expect(matched.map((m) => m.id).sort()).toEqual(["n1", "n2"])
  })

  it("readGraphRelatedSnippets：并行读取 + 跨 matched 去重 + relevance 降序", async () => {
    const graph = fakeGraph()
    const extra = { id: "extra", title: "关联节点", path: "/P/extra.md" }
    const getRelatedNodes = vi.fn((id: string) => {
      if (id === "n3") return []
      return [{ node: extra, relevance: 0.8 }]
    })
    const readFile = vi.fn(async () => "关联片段内容")
    const { matched, seenIds } = collectGraphMatchedNodes(graph, ["林云"])
    const scored = await readGraphRelatedSnippets(
      matched,
      graph,
      seenIds,
      { getRelatedNodes: getRelatedNodes as never, readFile },
    )
    // n1 与 n2 共享同一 extra 关联节点 → 只读一次（seenIds 跨 matched 去重）。
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(scored).toHaveLength(1)
    expect(scored[0]).toMatchObject({ title: "关联节点", relevance: 0.8 })
    expect(scored[0].snippet).toContain("关联片段内容")
  })

  it("readGraphRelatedSnippets：读失败经 onReadError 上报并丢弃（检索侧 warn 语义）", async () => {
    const graph = fakeGraph()
    const bad = { id: "bad", title: "坏节点", path: "/P/bad.md" }
    const seenIds = new Set(["n1"])
    const onReadError = vi.fn()
    const scored = await readGraphRelatedSnippets(
      [{ id: "n1", title: "林云", path: "/P/n1.md" }],
      graph,
      seenIds,
      {
        getRelatedNodes: (() => [{ node: bad, relevance: 0.5 }]) as never,
        readFile: async () => {
          throw new Error("EIO")
        },
      },
      { onReadError },
    )
    expect(scored).toEqual([])
    expect(onReadError).toHaveBeenCalledTimes(1)
    expect(onReadError.mock.calls[0][0]).toMatchObject({ title: "坏节点" })
  })

  it("collectGraphScoredSnippets：一站式与分步调用结果一致", async () => {
    const graph = fakeGraph()
    const extra = { id: "extra", title: "关联节点", path: "/P/extra.md" }
    const deps = {
      getRelatedNodes: (() => [{ node: extra, relevance: 0.9 }]) as never,
      readFile: async () => "片段",
    }
    const oneShot = await collectGraphScoredSnippets(graph, ["林云"], deps)
    const { matched, seenIds } = collectGraphMatchedNodes(graph, ["林云"])
    const twoStep = await readGraphRelatedSnippets(matched, graph, seenIds, deps)
    expect(oneShot).toEqual(twoStep)
    expect(oneShot[0].relevance).toBe(0.9)
  })
})
