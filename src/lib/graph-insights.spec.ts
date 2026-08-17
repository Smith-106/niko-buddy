import { describe, expect, it } from "vitest"
import { detectKnowledgeGaps, findSurprisingConnections } from "./graph-insights"
import type { CommunityInfo, GraphEdge, GraphNode } from "./wiki-graph"

function node(id: string, label: string, type: string, linkCount: number, community: number): GraphNode {
  return { id, label, type, path: `/p/${id}.md`, linkCount, community }
}

function edge(source: string, target: string, weight = 1): GraphEdge {
  return { source, target, weight }
}

const n = {
  index: node("index", "目录", "overview", 5, 0),
  log: node("log", "日志", "other", 4, 0),
  overview: node("overview", "总览", "overview", 3, 0),
  hero: node("hero", "林云", "character", 4, 0),
  villain: node("villain", "陈渊", "character", 3, 1),
  city: node("city", "临江城", "location", 2, 0),
  tower: node("tower", "望月楼", "location", 1, 1),
  sword: node("sword", "断水剑", "item", 1, 2),
  secret: node("secret", "身世秘密", "secret", 2, 2),
  source: node("src-doc", "素材A", "source", 1, 3),
  synthesis: node("synth", "综合整理", "synthesis", 1, 3),
  query: node("query-1", "问答记录", "query", 1, 3),
  isolated: node("isolated", "孤立页", "concept", 0, 4),
}

const communities: CommunityInfo[] = [
  { id: 0, nodeCount: 4, cohesion: 0.5, topNodes: ["hero", "city"] },
  { id: 1, nodeCount: 3, cohesion: 0.05, topNodes: ["villain"] },
  { id: 2, nodeCount: 2, cohesion: 0.3, topNodes: ["sword"] },
  { id: 3, nodeCount: 3, cohesion: 0.4, topNodes: ["src-doc"] },
  { id: 4, nodeCount: 1, cohesion: 0.1, topNodes: [] },
]

describe("findSurprisingConnections", () => {
  const nodes = [n.index, n.log, n.overview, n.hero, n.villain, n.city, n.tower, n.sword, n.secret, n.source, n.synthesis, n.query, n.isolated]

  it("returns empty for an empty graph", () => {
    expect(findSurprisingConnections([], [], [], 5)).toEqual([])
  })

  it("skips edges whose endpoints are missing from the node map", () => {
    const result = findSurprisingConnections([n.hero], [edge("hero", "ghost", 1)], 5)
    expect(result).toEqual([])
  })

  it("skips structural node edges", () => {
    const result = findSurprisingConnections([n.hero, n.index], [edge("index", "hero", 3)], 5)
    expect(result).toEqual([])
  })

  it("scores cross-community links", () => {
    const result = findSurprisingConnections(nodes, [edge("hero", "villain", 2)], 5)
    expect(result.length).toBe(1)
    expect(result[0].score).toBeGreaterThanOrEqual(3)
    expect(result[0].reasons).toContain("跨社群关联")
  })

  it("scores distant cross-type pairs higher", () => {
    const srcA = node("srcA", "素材A", "source", 2, 1)
    const synthB = node("synthB", "综合", "synthesis", 1, 2)
    const result = findSurprisingConnections([srcA, synthB], [edge("srcA", "synthB", 0.5)], 5)
    expect(result.length).toBe(1)
    expect(result[0].reasons.some((r) => r.includes("连接到"))).toBe(true)
    expect(result[0].score).toBeGreaterThanOrEqual(3)
  })

  it("scores generic cross-type links", () => {
    const result = findSurprisingConnections(nodes, [edge("hero", "sword", 2)], 5)
    expect(result[0].reasons).toContain("不同类型节点相连")
  })

  it("scores peripheral-to-hub edges", () => {
    const result = findSurprisingConnections(nodes, [edge("tower", "hero", 2)], 5)
    expect(result[0].reasons).toContain("边缘节点连接到核心节点")
  })

  it("scores low-weight edges", () => {
    const result = findSurprisingConnections(nodes, [edge("hero", "villain", 0.5)], 5)
    expect(result[0].reasons).toContain("弱关联但已形成连接")
  })

  it("drops edges with score below the 3 threshold", () => {
    const a = node("a", "甲", "character", 3, 0)
    const b = node("b", "乙", "location", 3, 0)
    const result = findSurprisingConnections(
      [a, b],
      [edge("a", "b", 1)],
      5,
    )
    // same community, cross-type (+1), no peripheral signal, weight 1 → score 1 < 3
    expect(result).toEqual([])
  })

  it("builds a stable key from sorted ids and orders by score desc", () => {
    const result = findSurprisingConnections(
      nodes,
      [edge("hero", "villain", 2), edge("source", "synthesis", 2)],
      5,
    )
    expect(result[0].key).toBeDefined()
    expect(result.every((r) => r.score >= result[result.length - 1].score)).toBe(true)
  })

  it("runs the score-sort comparator across multiple candidates", () => {
    const result = findSurprisingConnections(
      nodes,
      [
        edge("hero", "villain", 0.5),
        edge("source", "synthesis", 0.5),
        edge("tower", "hero", 0.5),
        edge("sword", "secret", 0.5),
      ],
      5,
    )
    expect(result.length).toBeGreaterThan(1)
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
    }
  })

  it("respects the limit", () => {
    const edgesList = [edge("hero", "villain", 2), edge("source", "synthesis", 2)]
    expect(findSurprisingConnections(nodes, edgesList, 1)).toHaveLength(1)
  })

  it("uses custom type labels for distant pairs", () => {
    const q = node("q", "问答记录", "query", 2, 1)
    const e = node("e", "实体", "entity", 1, 2)
    const result = findSurprisingConnections([q, e], [edge("q", "e", 0.5)], 5)
    expect(result[0].reasons.some((r) => r.includes("问答记录连接到实体"))).toBe(true)
  })

  it("scores generic cross-type links for non-distant pairs", () => {
    const result = findSurprisingConnections(nodes, [edge("hero", "sword", 2)], 5)
    expect(result[0].reasons).toContain("不同类型节点相连")
  })
})

describe("detectKnowledgeGaps", () => {
  const nodes = [n.index, n.log, n.overview, n.hero, n.villain, n.city, n.tower, n.sword, n.secret, n.source, n.synthesis, n.query, n.isolated]
  const edges = [
    edge("hero", "city", 1),
    edge("hero", "sword", 1),
    edge("villain", "tower", 1),
    edge("sword", "secret", 1),
    edge("source", "synthesis", 1),
    edge("synthesis", "query-1", 1),
  ]

  it("reports isolated pages with a bounded top list", () => {
    const gaps = detectKnowledgeGaps(nodes, edges, communities, 20)
    const isolated = gaps.find((g) => g.type === "isolated-node")
    expect(isolated).toBeDefined()
    expect(isolated!.title).toContain("孤立页面")
    expect(isolated!.nodeIds).toContain("isolated")
    expect(isolated!.description).toContain("，以及另外")
    expect(isolated!.suggestion.length).toBeGreaterThan(0)
  })

  it("lists every isolated label directly when the count fits the top list", () => {
    // Only 1 isolated node → formatNodeList takes the `total <= nodes.length`
    // branch and lists the labels directly (no "以及另外 N 个页面" suffix).
    const gaps = detectKnowledgeGaps([n.hero, n.isolated], [], communities, 20)
    const isolated = gaps.find((g) => g.type === "isolated-node")
    expect(isolated).toBeDefined()
    expect(isolated!.description).toBe("孤立页")
    expect(isolated!.description).not.toContain("，以及另外")
  })

  it("reports sparse communities with cohesion below threshold", () => {
    const gaps = detectKnowledgeGaps(nodes, edges, communities, 20)
    const sparse = gaps.find((g) => g.type === "sparse-community")
    expect(sparse).toBeDefined()
    expect(sparse!.title).toContain("稀疏簇")
    expect(sparse!.nodeIds).toContain("villain")
    expect(sparse!.description).toContain("凝聚度 0.05")
  })

  it("handles sparse communities with no top nodes", () => {
    const noTop = [{ id: 4, nodeCount: 5, cohesion: 0.05, topNodes: [] as string[] }]
    const gaps = detectKnowledgeGaps(nodes, edges, noTop, 20)
    const sparse = gaps.find((g) => g.type === "sparse-community")
    expect(sparse!.title).toContain("社群 4")
  })

  it("reports bridge nodes connected to at least three communities", () => {
    const heroEdges = [
      edge("hero", "city", 1), // community 0
      edge("hero", "sword", 1), // community 2
      edge("hero", "src-doc", 1), // community 3
    ]
    const gaps = detectKnowledgeGaps(nodes, [...edges, ...heroEdges], communities, 20)
    const bridges = gaps.filter((g) => g.type === "bridge-node")
    expect(bridges.length).toBeGreaterThan(0)
    expect(bridges.some((b) => b.nodeIds.includes("hero"))).toBe(true)
  })

  it("sorts multiple bridge nodes by community count", () => {
    const bridgeNodes = [
      node("hubA", "枢纽甲", "entity", 6, 0),
      node("a", "a", "entity", 1, 1),
      node("b", "b", "entity", 1, 2),
      node("c", "c", "entity", 1, 3),
      node("hubB", "枢纽乙", "entity", 6, 0),
      node("d", "d", "entity", 1, 1),
      node("e", "e", "entity", 1, 2),
      node("f", "f", "entity", 1, 3),
    ]
    const bridgeEdges = [
      edge("hubA", "a", 1), edge("hubA", "b", 1), edge("hubA", "c", 1),
      edge("hubB", "d", 1), edge("hubB", "e", 1), edge("hubB", "f", 1),
    ]
    const gaps = detectKnowledgeGaps(bridgeNodes, bridgeEdges, [], 20)
    const bridges = gaps.filter((g) => g.type === "bridge-node")
    expect(bridges.map((g) => g.title)).toEqual(["关键桥梁：枢纽甲", "关键桥梁：枢纽乙"])
  })

  it("respects the limit", () => {
    expect(detectKnowledgeGaps(nodes, edges, communities, 1)).toHaveLength(1)
  })

  it("returns empty for an empty graph", () => {
    expect(detectKnowledgeGaps([], [], [], 8)).toEqual([])
  })

  it("skips structural ids when finding bridges", () => {
    const bigNodes = [
      node("hero", "林云", "character", 6, 0),
      node("a", "a", "entity", 1, 1),
      node("b", "b", "entity", 1, 2),
      node("c", "c", "entity", 1, 3),
    ]
    const bigEdges = [edge("hero", "a", 1), edge("hero", "b", 1), edge("hero", "c", 1)]
    const gaps = detectKnowledgeGaps(bigNodes, bigEdges, [], 20)
    const bridge = gaps.find((g) => g.type === "bridge-node")
    expect(bridge).toBeDefined()
    expect(bridge!.nodeIds).toEqual(["hero"])
    expect(bridge!.description).toContain("3 个不同知识簇")
  })

  it("does not report bridges when edges reference missing nodes", () => {
    const gaps = detectKnowledgeGaps([n.hero], [edge("hero", "ghost", 1)], communities, 20)
    expect(gaps.find((g) => g.type === "bridge-node")).toBeUndefined()
  })
})
