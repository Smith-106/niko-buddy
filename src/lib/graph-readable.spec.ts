import { describe, expect, it } from "vitest"
import {
  buildGraphDocument,
  buildGraphMindMap,
  buildGraphNodeRelationSummary,
  buildGraphRiskReport,
  buildGraphRiskSummaryItems,
  buildGraphRiskSummaryItemsForGroup,
  filterGraphDocumentNodes,
  filterGraphDocumentNodesByIsolation,
  filterGraphDocumentNodesByRelations,
  filterGraphDocumentNodesByRiskState,
  filterGraphDocumentNodesBySearch,
  filterNonZeroRiskSummaryItems,
  getGraphDocumentIsolationStats,
  getGraphDocumentNodeTypeOptions,
  getGraphDocumentQuickRiskFilters,
  getGraphDocumentRiskStateOptions,
  getGraphDocumentSortOptions,
  getGraphNodeRelatedEdges,
  getGraphNodeRiskLabel,
  getGraphNodeRiskStateLabel,
  getGraphNodeRiskStateLabelColor,
  getGraphNodeRiskStateOptions,
  getGraphNodeTypeLabel,
  getGraphRelationLabel,
  getGraphRiskSummaryItemColor,
  getGraphRiskSummaryTotal,
  getNextGraphNodeRiskStateLabel,
  groupGraphDocumentNodes,
  setGraphNodeRiskStateInContent,
  sortGraphDocumentNodes,
} from "./graph-readable"
import type { GraphEdge, GraphNode } from "./wiki-graph"

const node = (partial: Partial<GraphNode>): GraphNode => ({
  id: "n1",
  label: "节点",
  type: "character",
  path: "wiki/entities/n1.md",
  linkCount: 1,
  community: 0,
  ...partial,
})

const edge = (partial: Partial<GraphEdge>): GraphEdge => ({
  source: "a",
  target: "b",
  weight: 1,
  ...partial,
})

describe("label accessors", () => {
  it("maps known and unknown node types", () => {
    expect(getGraphNodeTypeLabel("character")).toBe("人物")
    expect(getGraphNodeTypeLabel("mystery-type")).toBe("mystery-type")
  })

  it("maps relations, defaulting to 关联 for missing", () => {
    expect(getGraphRelationLabel("KNOWS")).toBe("知晓")
    expect(getGraphRelationLabel("MYSTERY")).toBe("MYSTERY")
    expect(getGraphRelationLabel(undefined)).toBe("关联")
  })

  it("maps risk labels and states, returning null for unknown", () => {
    expect(getGraphNodeRiskLabel("foreshadowing")).toBe("需追踪")
    expect(getGraphNodeRiskLabel("plain")).toBeNull()
    expect(getGraphNodeRiskStateLabel("secret")).toBe("未揭露")
    expect(getGraphNodeRiskStateLabel("plain")).toBeNull()
  })

  it("returns risk-state option lists, empty for unknown types", () => {
    expect(getGraphNodeRiskStateOptions("foreshadowing")).toEqual(["未回收", "推进中", "已回收"])
    expect(getGraphNodeRiskStateOptions("unknown")).toEqual([])
  })
})

describe("next risk state", () => {
  it("returns null when the type has no state options", () => {
    expect(getNextGraphNodeRiskStateLabel("plain", null)).toBeNull()
  })

  it("returns the first option when no current state", () => {
    expect(getNextGraphNodeRiskStateLabel("conflict", null)).toBe("待推进")
  })

  it("covers the defensive undefined option fallback", () => {
    expect(getNextGraphNodeRiskStateLabel("conflict", undefined as unknown as string | null)).toBe("待推进")
  })

  it("advances to the next option", () => {
    expect(getNextGraphNodeRiskStateLabel("conflict", "待推进")).toBe("推进中")
  })

  it("wraps around from the last option", () => {
    expect(getNextGraphNodeRiskStateLabel("foreshadowing", "已回收")).toBe("未回收")
  })

  it("treats an unknown current state as no state", () => {
    expect(getNextGraphNodeRiskStateLabel("secret", "???")).toBe("未揭露")
  })
})

describe("setGraphNodeRiskStateInContent", () => {
  it("replaces an existing 状态 line", () => {
    expect(setGraphNodeRiskStateInContent("状态：旧\n正文", "新")).toBe("状态：新\n正文")
  })

  it("inserts after the title line when present", () => {
    expect(setGraphNodeRiskStateInContent("# 标题\n内容", "新")).toBe("# 标题\n状态：新\n\n内容")
  })

  it("prepends when there is no title and no state line", () => {
    expect(setGraphNodeRiskStateInContent("正文内容", "新")).toBe("状态：新\n\n正文内容")
  })
})

describe("edge helpers", () => {
  it("filters edges touching the node id", () => {
    const edges: GraphEdge[] = [
      edge({ source: "n1", target: "x" }),
      edge({ source: "y", target: "n1" }),
      edge({ source: "a", target: "b" }),
    ]
    expect(getGraphNodeRelatedEdges(edges, "n1")).toHaveLength(2)
  })
})

describe("grouping / filtering", () => {
  it("groups nodes by document group and appends leftovers", () => {
    const nodes = [
      node({ id: "e1", type: "event" }),
      node({ id: "c1", type: "character" }),
      node({ id: "t1", type: "entity" }),
      node({ id: "z1", type: "zzz" }),
    ]
    const groups = groupGraphDocumentNodes(nodes)
    expect(groups.map((g) => g.title)).toEqual(["剧情事件", "重要角色", "其他节点", "其他节点"])
    expect(groups[2].nodes.map((n) => n.id)).toEqual(["t1"])
    expect(groups[3].nodes.map((n) => n.id)).toEqual(["z1"])
  })

  it("returns an empty list for no matching nodes", () => {
    expect(groupGraphDocumentNodes([])).toEqual([])
  })

  it("filters by node type or returns all", () => {
    const nodes = [node({ id: "a", type: "character" }), node({ id: "b", type: "location" })]
    expect(filterGraphDocumentNodes(nodes, "all")).toBe(nodes)
    expect(filterGraphDocumentNodes(nodes, "location").map((n) => n.id)).toEqual(["b"])
  })

  it("filters by search keyword over label and path", () => {
    const nodes = [
      node({ id: "a", label: "林云", path: "wiki/entities/a.md" }),
      node({ id: "b", label: "陈云", path: undefined as unknown as string }),
    ]
    expect(filterGraphDocumentNodesBySearch(nodes, "")).toBe(nodes)
    expect(filterGraphDocumentNodesBySearch(nodes, "林").map((n) => n.id)).toEqual(["a"])
    expect(filterGraphDocumentNodesBySearch(nodes, "B.MD")).toEqual([])
    expect(filterGraphDocumentNodesBySearch(nodes, "none")).toEqual([])
  })

  it("filters by risk state with overrides", () => {
    const nodes = [
      node({ id: "a", type: "secret" }),
      node({ id: "b", type: "secret" }),
    ]
    const overrides = { b: "部分揭露" }
    expect(filterGraphDocumentNodesByRiskState(nodes, overrides, "all")).toBe(nodes)
    expect(filterGraphDocumentNodesByRiskState(nodes, overrides, "未揭露").map((n) => n.id)).toEqual(["a"])
    expect(filterGraphDocumentNodesByRiskState(nodes, overrides, "部分揭露").map((n) => n.id)).toEqual(["b"])
  })

  it("filters by relation presence and isolation", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" })]
    const edges: GraphEdge[] = [edge({ source: "a", target: "x" })]
    expect(filterGraphDocumentNodesByRelations(nodes, edges, false)).toBe(nodes)
    expect(filterGraphDocumentNodesByRelations(nodes, edges, true).map((n) => n.id)).toEqual(["a"])
    expect(filterGraphDocumentNodesByIsolation(nodes, edges, false)).toBe(nodes)
    expect(filterGraphDocumentNodesByIsolation(nodes, edges, true).map((n) => n.id)).toEqual(["b"])
    expect(getGraphDocumentIsolationStats(nodes, edges)).toEqual({ total: 2, isolated: 1 })
  })
})

describe("dropdown options", () => {
  it("lists distinct node types with the all-option first", () => {
    const nodes = [node({ id: "a", type: "character" }), node({ id: "b", type: "location" }), node({ id: "c", type: "character" })]
    expect(getGraphDocumentNodeTypeOptions(nodes)).toEqual([
      { value: "all", label: "全部类型" },
      { value: "character", label: "人物" },
      { value: "location", label: "地点" },
    ])
  })

  it("lists distinct non-null risk states", () => {
    const nodes = [
      node({ id: "a", type: "secret" }),
      node({ id: "b", type: "secret" }),
      node({ id: "c", type: "plain" }),
    ]
    const overrides = { b: "已揭露" }
    expect(getGraphDocumentRiskStateOptions(nodes, overrides)).toEqual([
      { value: "all", label: "全部状态" },
      { value: "未揭露", label: "未揭露" },
      { value: "已揭露", label: "已揭露" },
    ])
  })

  it("returns the fixed sort options", () => {
    expect(getGraphDocumentSortOptions()).toEqual([
      { value: "default", label: "默认顺序" },
      { value: "links-desc", label: "关联最多" },
      { value: "links-asc", label: "关联最少" },
      { value: "title", label: "标题排序" },
    ])
  })
})

describe("risk summary", () => {
  it("builds quick-risk filters", () => {
    expect(getGraphDocumentQuickRiskFilters()).toHaveLength(5)
    expect(getGraphDocumentQuickRiskFilters()[0]).toMatchObject({ key: "secret-unrevealed", nodeType: "secret", riskState: "未揭露" })
  })

  it("counts nodes per filter with overrides", () => {
    const nodes = [
      node({ id: "a", type: "secret" }),
      node({ id: "b", type: "secret" }),
      node({ id: "c", type: "secret" }),
      node({ id: "d", type: "foreshadowing" }),
      node({ id: "e", type: "canon-rule" }),
      node({ id: "f", type: "timeline-point" }),
      node({ id: "g", type: "conflict" }),
    ]
    const overrides = {
      b: "已揭露",
      e: "疑似冲突",
      f: "疑似矛盾",
    }
    const items = buildGraphRiskSummaryItems(nodes, overrides)
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.count]))
    expect(byKey["secret-unrevealed"]).toBe(2)
    expect(byKey["foreshadowing-unresolved"]).toBe(1)
    expect(byKey["canon-rule-conflict"]).toBe(1)
    expect(byKey["timeline-conflict"]).toBe(1)
    expect(byKey["conflict-pending"]).toBe(1)
    expect(buildGraphRiskSummaryItemsForGroup(nodes, overrides)).toEqual(items)
    expect(filterNonZeroRiskSummaryItems(items)).toHaveLength(5)
    expect(getGraphRiskSummaryTotal(items)).toBe(6)
  })

  it("filters out zero-count items", () => {
    const items = buildGraphRiskSummaryItems([node({ id: "a", type: "plain" })], {})
    expect(filterNonZeroRiskSummaryItems(items)).toEqual([])
  })

  it("colors conflict keys red and others orange", () => {
    expect(getGraphRiskSummaryItemColor({ key: "canon-rule-conflict" } as never).text).toContain("red")
    expect(getGraphRiskSummaryItemColor({ key: "timeline-conflict" } as never).text).toContain("red")
    expect(getGraphRiskSummaryItemColor({ key: "secret-unrevealed" } as never).text).toContain("orange")
  })

  it("colors risk states red / orange / emerald", () => {
    expect(getGraphNodeRiskStateLabelColor("疑似冲突").text).toContain("red")
    expect(getGraphNodeRiskStateLabelColor("疑似矛盾").text).toContain("red")
    expect(getGraphNodeRiskStateLabelColor("未回收").text).toContain("orange")
    expect(getGraphNodeRiskStateLabelColor("部分揭露").text).toContain("orange")
    expect(getGraphNodeRiskStateLabelColor("已回收").text).toContain("emerald")
  })
})

describe("risk report", () => {
  it("renders risk nodes, change lines and archives", () => {
    const nodes = [
      node({ id: "f1", type: "foreshadowing", label: "旧伏笔", path: "wiki/entities/f1.md" }),
      node({ id: "s1", type: "secret", label: "秘密", path: "" }),
      node({ id: "c1", type: "character", label: "人物" }),
    ]
    const report = buildGraphRiskReport(nodes, { f1: "已回收" })
    expect(report).toContain("# 风险排查报告")
    expect(report).toContain("共 2 个风险追踪节点。")
    expect(report).toContain("## 旧伏笔")
    expect(report).toContain("- 状态：已回收")
    expect(report).toContain("- 变更：未回收 → 已回收")
    expect(report).toContain("- 档案：wiki/entities/f1.md")
    expect(report).not.toContain("## 人物")
    expect(report.match(/- 档案：/g)).toHaveLength(1)
    expect(report).toContain("## 秘密")
  })

  it("omits the change line when the override matches the default", () => {
    const report = buildGraphRiskReport([node({ id: "f1", type: "foreshadowing" })], { f1: "未回收" })
    expect(report).not.toContain("- 变更：")
  })
})

describe("sorting", () => {
  const nodes = [
    node({ id: "a", label: "甲", linkCount: 2 }),
    node({ id: "b", label: "乙", linkCount: 5 }),
    node({ id: "c", label: "丙", linkCount: 2 }),
  ]

  it("returns the same array for default mode", () => {
    expect(sortGraphDocumentNodes(nodes, "default")).toBe(nodes)
  })

  it("sorts by links descending with zh label tie-break", () => {
    expect(sortGraphDocumentNodes(nodes, "links-desc").map((n) => n.id)).toEqual(["b", "c", "a"])
  })

  it("sorts by links ascending with zh label tie-break", () => {
    // 丙(bǐng) < 甲(jiǎ) under zh-CN collation
    expect(sortGraphDocumentNodes(nodes, "links-asc").map((n) => n.id)).toEqual(["c", "a", "b"])
  })

  it("sorts by title", () => {
    expect(sortGraphDocumentNodes(nodes, "title").map((n) => n.id)).toEqual(["c", "a", "b"])
  })
})

describe("relation summary", () => {
  it("groups edge labels with node labels", () => {
    const nodes = [node({ id: "a", label: "甲" }), node({ id: "b", label: "乙" })]
    const edges: GraphEdge[] = [
      edge({ source: "a", target: "b", relation: "KNOWS" }),
      edge({ source: "b", target: "a", relation: "KNOWS" }),
      edge({ source: "a", target: "missing", relation: undefined }),
    ]
    expect(buildGraphNodeRelationSummary(nodes[0], nodes, edges)).toEqual([
      { title: "知晓", items: ["乙", "乙"] },
      { title: "关联", items: ["missing"] },
    ])
  })
})

describe("document generation", () => {
  const baseNodes = [
    node({ id: "a", type: "character", label: "甲", linkCount: 2 }),
    node({ id: "b", type: "event", label: "决战", linkCount: 1, path: "wiki/entities/b.md" }),
  ]
  const baseEdges: GraphEdge[] = [
    edge({ source: "a", target: "b", relation: "APPEARS_IN", weight: 0.8 }),
  ]
  const eventNodes = [
    ...baseNodes,
    node({ id: "e", type: "event", label: "起因", linkCount: 0, path: "wiki/entities/e.md" }),
  ]
  const eventEdges: GraphEdge[] = [
    ...baseEdges,
    edge({ source: "e", target: "a", relation: "CAUSED_BY", weight: 0.6 }),
  ]

  it("builds a document with edges, relations and events", () => {
    const doc = buildGraphDocument(eventNodes, eventEdges)
    expect(doc).toContain("# 小说图谱文档")
    expect(doc).toContain("## 1. 剧情事件")
    expect(doc).toContain("### 1.1 [[决战]]")
    expect(doc).toContain("- 节点类型：事件")
    expect(doc).toContain("- 关联数量：1")
    expect(doc).toContain("- 来源路径：wiki/entities/b.md")
    expect(doc).toContain("| [[决战]] | 出场于 | 指向对方 | 0.8 |")
    expect(doc).toContain("| [[甲]] | 出场于 | 来自对方 | 0.8 |")
    expect(doc).toContain("- [[决战]]：出场于")
    expect(doc).toContain("## 3. 全部关系")
    expect(doc).toContain("| [[甲]] | 出场于 | [[决战]] | 0.8 |")
  })

  it("shows no-relation placeholders for isolated nodes and empty graphs", () => {
    const isolated = node({ id: "z", type: "character", label: "孤", linkCount: 0, path: "" })
    const doc = buildGraphDocument([...baseNodes, isolated], baseEdges)
    expect(doc).toContain("暂无已记录关系。")
    expect(doc).toContain("暂无直接关联事件。")

    const empty = buildGraphDocument([], [])
    expect(empty).toContain("暂无关系。")
    expect(empty).toContain("## 1. 全部关系")
  })

  it("handles missing node labels by falling back to the id", () => {
    const doc = buildGraphDocument(baseNodes, [edge({ source: "a", target: "ghost", weight: 0.5 })])
    expect(doc).toContain("[[ghost]]")
  })
})

describe("mind map", () => {
  it("groups nodes by type and attaches related edges", () => {
    const nodes = [
      node({ id: "a", type: "character", label: "甲" }),
      node({ id: "b", type: "location", label: "城" }),
      node({ id: "c", type: "character", label: "乙" }),
    ]
    const edges: GraphEdge[] = [edge({ source: "a", target: "c", relation: "KNOWS" })]
    const [root] = buildGraphMindMap(nodes, edges)
    expect(root.label).toBe("小说图谱")
    const groups = new Map(root.children.map((g) => [g.label, g]))
    expect(groups.get("人物")?.children.map((n) => n.label)).toEqual(["甲", "乙"])
    expect(groups.get("地点")?.children.map((n) => n.label)).toEqual(["城"])
    const a = groups.get("人物")!.children.find((n) => n.id === "a")!
    expect(a.children.map((n) => n.label)).toEqual(["乙"])
    expect(groups.get("人物")!.children.find((n) => n.id === "b")).toBeUndefined()
  })
})
