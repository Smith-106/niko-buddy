// @vitest-environment node

import { describe, expect, it } from "vitest"
import { extractNeighborhood, pickDefaultFocus } from "./graph-neighborhood"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"

function makeNode(id: string, linkCount = 1): GraphNode {
  return { id, label: id, type: "character", path: `wiki/${id}.md`, linkCount, community: 0 }
}

function makeEdge(source: string, target: string, weight = 1): GraphEdge {
  return { source, target, weight }
}

describe("pickDefaultFocus", () => {
  it("空图返回 null", () => {
    expect(pickDefaultFocus([])).toBeNull()
  })

  it("选连接最多的节点", () => {
    const nodes = [makeNode("a", 3), makeNode("b", 9), makeNode("c", 5)]
    expect(pickDefaultFocus(nodes)?.id).toBe("b")
  })
})

describe("extractNeighborhood", () => {
  it("焦点不存在返回空子图", () => {
    const result = extractNeighborhood([makeNode("a")], [], { focusId: "missing" })
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it("depth=1 只收一跳邻居", () => {
    const nodes = [makeNode("hub", 3), makeNode("n1"), makeNode("n2"), makeNode("far")]
    const edges = [makeEdge("hub", "n1"), makeEdge("hub", "n2"), makeEdge("n1", "far")]
    const result = extractNeighborhood(nodes, edges, { focusId: "hub", depth: 1 })
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["hub", "n1", "n2"])
    // n1-far 边因 far 不在子图内被裁掉
    expect(result.edges).toHaveLength(2)
  })

  it("depth=2 收进二跳但不收三跳", () => {
    const nodes = [makeNode("hub"), makeNode("n1"), makeNode("n2"), makeNode("far")]
    const edges = [makeEdge("hub", "n1"), makeEdge("n1", "n2"), makeEdge("n2", "far")]
    const result = extractNeighborhood(nodes, edges, { focusId: "hub", depth: 2 })
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["hub", "n1", "n2"])
  })

  it("邻居间的横向边会保留", () => {
    const nodes = [makeNode("hub"), makeNode("a"), makeNode("b")]
    const edges = [makeEdge("hub", "a"), makeEdge("hub", "b"), makeEdge("a", "b", 5)]
    const result = extractNeighborhood(nodes, edges, { focusId: "hub" })
    expect(result.edges).toHaveLength(3)
  })

  it("hub 按权重只留最强邻居并计数收起数", () => {
    const nodes = [makeNode("hub", 60)]
    const edges: GraphEdge[] = []
    for (let i = 0; i < 60; i++) {
      const id = `n${i.toString().padStart(2, "0")}`
      nodes.push(makeNode(id))
      edges.push(makeEdge("hub", id, i))
    }
    const result = extractNeighborhood(nodes, edges, { focusId: "hub", maxNeighborsPerNode: 10 })
    expect(result.nodes).toHaveLength(11)
    // 权重 50..59 的邻居被留下
    expect(result.nodes.map((n) => n.id)).toContain("n59")
    expect(result.nodes.map((n) => n.id)).not.toContain("n00")
    expect(result.omittedNeighborCounts).toEqual({ hub: 50 })
    expect(result.omittedEdgeCount).toBe(50)
  })

  it("总数上限按 BFS 顺序截断", () => {
    const nodes = [makeNode("hub", 10)]
    const edges: GraphEdge[] = []
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`
      nodes.push(makeNode(id))
      edges.push(makeEdge("hub", id))
    }
    const result = extractNeighborhood(nodes, edges, { focusId: "hub", maxTotalNodes: 5 })
    expect(result.nodes).toHaveLength(5)
    expect(result.nodes[0]?.id).toBe("hub")
    expect(result.truncated).toBe(true)
  })

  it("depth 越界收敛到 1..2", () => {
    const nodes = [makeNode("hub"), makeNode("n1")]
    const edges = [makeEdge("hub", "n1")]
    expect(extractNeighborhood(nodes, edges, { focusId: "hub", depth: 99 }).depth).toBe(2)
    expect(extractNeighborhood(nodes, edges, { focusId: "hub", depth: 0 }).depth).toBe(1)
  })
})
