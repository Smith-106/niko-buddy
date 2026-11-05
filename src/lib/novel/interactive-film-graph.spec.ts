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

  it("html 导出：文本注入安全（render 时 esc 转义，非仅编码侥幸）", () => {
    const g = graph()
    const node = g.nodes.find((n) => n.id === "k1") as InteractiveNode
    node.title = "<img src=x onerror=alert(1)>"
    node.text = "<script>alert(1)</script>"
    const html = exportInteractiveHtml(g)
    // 静态源码层：生成脚本必须对三类用户内容应用 esc()（encodeURIComponent 编码
    // 只保护模版嵌入，运行时 decodeURIComponent 后拼接才是真实注入点）
    expect(html).toContain("esc(node.title)")
    expect(html).toContain("esc(node.text)")
    expect(html).toContain("esc(e.choiceLabel")
    expect(html).not.toContain("+ node.title")
    expect(html).not.toContain("+ node.text")
    // esc 函数存在且覆盖五个危险字符
    expect(html).toContain('"&": "&amp;"')
    expect(html).toContain('"<": "&lt;"')
    expect(html).toContain('"\'": "&#39;"')
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

// ── 覆盖加深（增补：原有用例保留不动）─────────────────────────────────────────
// 目标：三条此前无用例的诊断/导出分支 —— 悬空边、choice 无出边、stitch 段导出。
describe("interactive-film-graph — 校验与导出补充分支（增补）", () => {
  it("边引用不存在的节点 → dangling_edge（且不计入出入度）", () => {
    const g = graph()
    g.edges.push({ from: "k2", to: "ghost", choiceLabel: "幽灵" })
    const diags = validateInteractiveGraph(g)
    const dangling = diags.filter((d) => d.code === "dangling_edge")
    expect(dangling).toHaveLength(1)
    expect(dangling[0].nodeId).toBe("k2")
    expect(dangling[0].message).toContain("ghost")
    // 悬空边不产生额外孤儿误报：其余诊断仍为空
    expect(diags.filter((d) => d.code === "orphan")).toEqual([])
  })

  it("choice 节点没有任何出边 → empty_choice（玩家会卡死）", () => {
    const g = graph({
      nodes: [
        { id: "k1", kind: "knot", title: "开端", text: "风雪夜。" },
        { id: "c1", kind: "choice", title: "抉择", text: "门在你面前。" },
        { id: "end1", kind: "end", title: "终章", text: "故事到此。" },
      ],
      edges: [
        { from: "k1", to: "c1" },
        { from: "c1", to: "end1" },
      ],
    })
    // 把 c1 的出边替换掉：删掉 c1→end1 后，c1 出度为 0
    g.edges = [{ from: "k1", to: "c1" }]
    const diags = validateInteractiveGraph(g)
    expect(diags.some((d) => d.code === "empty_choice" && d.nodeId === "c1")).toBe(true)
    expect(diags.find((d) => d.code === "empty_choice")?.message).toContain("无出边")
  })

  it("stitch 节点导出为 ink 小节（`=` 单等号）而不是 knot 段（`===`）", () => {
    const g = graph({
      nodes: [
        { id: "k1", kind: "knot", title: "开端", text: "风雪夜。" },
        { id: "s1", kind: "stitch", title: "小节", text: "屋内。" },
        { id: "end1", kind: "end", title: "终章", text: "故事到此。" },
      ],
      edges: [
        { from: "k1", to: "s1" },
        { from: "s1", to: "end1" },
      ],
    })
    const ink = exportInteractiveInk(g)
    expect(ink).toContain("\n= s1\n")
    expect(ink).not.toContain("=== s1 ===")
    // stitch 有出边 → divert，无选项行
    expect(ink).toContain("-> end1")
    expect(ink).not.toContain("* [")
  })
})
