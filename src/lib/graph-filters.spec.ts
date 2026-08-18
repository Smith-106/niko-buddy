import { describe, expect, it } from "vitest"
import {
  DEFAULT_GRAPH_FILTERS,
  applyGraphFilters,
  hasActiveGraphFilters,
  isStructuralGraphNode,
} from "./graph-filters"
import type { GraphEdge, GraphNode } from "./wiki-graph"

function node(id: string, type: string, linkCount = 1, path = `/p/${id}.md`): GraphNode {
  return { id, label: id, type, path, linkCount, community: 1 }
}

function edge(source: string, target: string, weight = 1): GraphEdge {
  return { source, target, weight }
}

const nodes: GraphNode[] = [
  node("index", "overview", 4, "/p/wiki/index.md"),
  node("hero", "character", 3),
  node("city", "location", 2),
  node("lone", "concept", 0),
  node("hub", "entity", 6),
]

const edges: GraphEdge[] = [
  edge("index", "hero", 2),
  edge("hero", "city", 1),
  edge("city", "hub", 0.5),
  edge("hub", "lone", 3),
]

describe("isStructuralGraphNode", () => {
  it("recognizes structural ids case-insensitively", () => {
    expect(isStructuralGraphNode({ id: "INDEX", path: "/x", type: "entity" })).toBe(true)
    expect(isStructuralGraphNode({ id: "overview", path: "/x", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "log", path: "/x", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "schema", path: "/x", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "purpose", path: "/x", type: "other" })).toBe(true)
  })

  it("recognizes the overview type regardless of id", () => {
    expect(isStructuralGraphNode({ id: "anything", path: "/x", type: "overview" })).toBe(true)
  })

  it("recognizes structural wiki paths with backslashes and slashes", () => {
    expect(isStructuralGraphNode({ id: "a", path: "C:\\proj\\wiki\\index.md", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "a", path: "/proj/wiki/overview.md", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "a", path: "/proj/wiki/log.md", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "a", path: "/proj/purpose.md", type: "other" })).toBe(true)
    expect(isStructuralGraphNode({ id: "a", path: "/proj/schema.md", type: "other" })).toBe(true)
  })

  it("returns false for ordinary nodes", () => {
    expect(isStructuralGraphNode({ id: "hero", path: "/p/hero.md", type: "character" })).toBe(false)
  })
})

describe("hasActiveGraphFilters", () => {
  it("is false for defaults", () => {
    expect(hasActiveGraphFilters(DEFAULT_GRAPH_FILTERS)).toBe(true) // hideStructural default
  })

  it("is false when everything is off", () => {
    expect(
      hasActiveGraphFilters({
        hiddenTypes: new Set(),
        hiddenNodeIds: new Set(),
        hideStructural: false,
        hideIsolated: false,
      }),
    ).toBe(false)
  })

  it("is true for each active filter", () => {
    expect(hasActiveGraphFilters({ hiddenTypes: new Set(["x"]), hiddenNodeIds: new Set(), hideStructural: false, hideIsolated: false })).toBe(true)
    expect(hasActiveGraphFilters({ hiddenTypes: new Set(), hiddenNodeIds: new Set(["a"]), hideStructural: false, hideIsolated: false })).toBe(true)
    expect(hasActiveGraphFilters({ hiddenTypes: new Set(), hiddenNodeIds: new Set(), hideStructural: false, hideIsolated: true })).toBe(true)
    expect(hasActiveGraphFilters({ hiddenTypes: new Set(), hiddenNodeIds: new Set(), hideStructural: false, hideIsolated: false, maxLinks: 3 })).toBe(true)
    expect(hasActiveGraphFilters({ hiddenTypes: new Set(), hiddenNodeIds: new Set(), hideStructural: false, hideIsolated: false, minimumEdgeWeight: 1 })).toBe(true)
    expect(hasActiveGraphFilters({ hiddenTypes: new Set(), hiddenNodeIds: new Set(), hideStructural: false, hideIsolated: false, allowedNodeTypes: new Set(["entity"]) })).toBe(true)
  })
})

describe("applyGraphFilters", () => {
  it("returns everything when no filters are active", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: false,
    })
    expect(out.nodes).toHaveLength(5)
    expect(out.edges).toHaveLength(4)
    expect(out.hiddenNodeIds.size).toBe(0)
  })

  it("hides structural nodes by default and prunes their edges", () => {
    const out = applyGraphFilters(nodes, edges, DEFAULT_GRAPH_FILTERS)
    expect(out.nodes.map((n) => n.id)).toEqual(["hero", "city", "lone", "hub"])
    expect(out.edges.map((e) => `${e.source}-${e.target}`)).toEqual(["hero-city", "city-hub", "hub-lone"])
  })

  it("hides explicitly hidden node ids", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(["hero"]),
      hideStructural: false,
      hideIsolated: false,
    })
    expect(out.nodes.map((n) => n.id)).toEqual(["index", "city", "lone", "hub"])
    expect(out.edges.some((e) => e.source === "hero" || e.target === "hero")).toBe(false)
  })

  it("hides types via allowedNodeTypes whitelist", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: false,
      allowedNodeTypes: new Set(["character", "location"]),
    })
    expect(out.nodes.map((n) => n.id)).toEqual(["hero", "city"])
    expect(out.edges).toEqual([edge("hero", "city")])
  })

  it("hides types via hiddenTypes", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(["character"]),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: false,
    })
    expect(out.nodes.map((n) => n.id)).toEqual(["index", "city", "lone", "hub"])
  })

  it("hides isolated nodes when hideIsolated is set", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: true,
    })
    expect(out.nodes.map((n) => n.id)).toEqual(["index", "hero", "city", "hub"])
  })

  it("keeps isolated nodes when hiding them would empty the graph", () => {
    const onlyLone = nodes.filter((n) => n.id === "lone")
    const out = applyGraphFilters(onlyLone, [], {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: true,
    })
    expect(out.nodes.map((n) => n.id)).toEqual(["lone"])
    expect(out.hiddenNodeIds.size).toBe(0)
  })

  it("does not fall back when other visible nodes remain", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: true,
    })
    expect(out.hiddenNodeIds.has("lone")).toBe(true)
  })

  it("hides high-degree nodes with maxLinks", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: false,
      maxLinks: 4,
    })
    expect(out.nodes.map((n) => n.id)).toEqual(["index", "hero", "city", "lone"])
  })

  it("filters edges by minimumEdgeWeight", () => {
    const out = applyGraphFilters(nodes, edges, {
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
      hideStructural: false,
      hideIsolated: false,
      minimumEdgeWeight: 1,
    })
    expect(out.edges.map((e) => `${e.source}-${e.target}`)).toEqual(["index-hero", "hero-city", "hub-lone"])
  })

  it("reports hidden node ids while keeping others visible", () => {
    const out = applyGraphFilters(nodes, edges, DEFAULT_GRAPH_FILTERS)
    expect(out.hiddenNodeIds).toEqual(new Set(["index"]))
  })
})
