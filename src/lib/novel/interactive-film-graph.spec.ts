import { describe, expect, it } from "vitest"
import {
  buildInteractiveExport,
  exportInteractiveHtml,
  exportInteractiveInk,
  validateInteractiveGraph,
  type InteractiveNode,
  type InteractiveStoryGraph,
} from "./interactive-film-graph"

function graph(overrides: Partial<InteractiveStoryGraph> = {}): InteractiveStoryGraph {
  return {
    version: 1,
    startId: "k1",
    nodes: [
      { id: "k1", kind: "knot", title: "雪夜敲门", text: "风雪夜，你站在李四门前。", emotionTag: "惧" },
      { id: "k2", kind: "knot", title: "屋内", text: "你推门而入。" },
      { id: "c1", kind: "choice", title: "抉择", text: "李四递来一杯热茶。" },
      { id: "end1", kind: "end", title: "终章", text: "你接过茶，故事到此。" },
    ],
    edges: [
      { from: "k1", to: "c1" },
      { from: "c1", to: "k2", choiceLabel: "接过茶" },
      { from: "c1", to: "end1", choiceLabel: "转身离开" },
    ],
    ...overrides,
  }
}

describe("interactive-film-graph (64 号实施：P0-1 互动影游图模型)", () => {
  it("合法图 → 零诊断", () => {
    expect(validateInteractiveGraph(graph())).toEqual([])
  })

  it("startId 缺失 → missing_start", () => {
    const g = graph({ startId: "nope" })
    const diags = validateInteractiveGraph(g)
    expect(diags.some((d) => d.code === "missing_start")).toBe(true)
  })

  it("choice 无 label → empty_choice", () => {
    const g = graph()
    g.edges.push({ from: "c1", to: "k2" })
    const diags = validateInteractiveGraph(g)
    expect(diags.some((d) => d.code === "empty_choice")).toBe(true)
  })

  it("孤儿节点（无入边非 start）→ orphan", () => {
    const g = graph()
    g.nodes.push({ id: "orphan1", kind: "knot", title: "孤", text: "无人到达" })
    const diags = validateInteractiveGraph(g)
    expect(diags.some((d) => d.code === "orphan" && d.nodeId === "orphan1")).toBe(true)
  })

  it("end 有出边 → 诊断", () => {
    const g = graph()
    g.edges.push({ from: "end1", to: "k1" })
    const diags = validateInteractiveGraph(g)
    expect(diags.some((d) => d.code === "empty_choice" && d.nodeId === "end1")).toBe(true)
  })

  it("有向环 → cycle_warn（不 fail）", () => {
    const g = graph()
    g.edges.push({ from: "k2", to: "k1" })
    const diags = validateInteractiveGraph(g)
    expect(diags.some((d) => d.code === "cycle_warn")).toBe(true)
  })

  it("ink 导出：knot/choice/divert 骨架", () => {
    const ink = exportInteractiveInk(graph())
    expect(ink).toContain("=== k1 ===")
    expect(ink).toContain("=== c1 ===")
    expect(ink).toContain("* [接过茶] -> k2")
    expect(ink).toContain("-> end1")
  })

  it("ink 导出：确定性双跑全等", () => {
    const a = exportInteractiveInk(graph())
    const b = exportInteractiveInk(graph())
    expect(a).toBe(b)
  })

  it("html 导出：含 data 与选项按钮结构", () => {
    const html = exportInteractiveHtml(graph())
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("decodeURIComponent")
    expect(html).toContain("go(")
  })

  it("html 导出：文本注入安全（escapeHtml 语义）", () => {
    const g = graph()
    const node = g.nodes.find((n) => n.id === "k1") as InteractiveNode
    node.text = "<script>alert(1)</script>"
    const html = exportInteractiveHtml(g)
    expect(html).not.toContain("<script>alert")
  })

  it("buildInteractiveExport：组合三产物", () => {
    const result = buildInteractiveExport(graph())
    expect(result.diagnostics).toEqual([])
    expect(result.ink).toContain("=== k1 ===")
    expect(result.html).toContain("<!DOCTYPE html>")
  })

  it("确定性：同图两次校验全等", () => {
    const g = graph()
    expect(JSON.stringify(validateInteractiveGraph(g))).toBe(JSON.stringify(validateInteractiveGraph(g)))
  })

  it("空图：startId 缺失诊断", () => {
    const empty: InteractiveStoryGraph = { version: 1, startId: "x", nodes: [], edges: [] }
    const diags = validateInteractiveGraph(empty)
    expect(diags.some((d) => d.code === "missing_start")).toBe(true)
  })
})
