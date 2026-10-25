import { describe, expect, it } from "vitest"
import {
  EDGE_LABEL_FULL_GRAPH_THRESHOLD,
  NODE_TYPE_COLORS,
  edgeTypeForStyle,
  getSigmaThemeColors,
  hexToRgba,
  initialGraphPosition,
  mixColor,
  nodeColor,
  nodeSize,
  safeNodeLabel,
  shouldRenderEdgeLabels,
  shouldShowNodeLabel,
} from "./graph-style"
import type { GraphNode } from "./wiki-graph"
import { GRAPH_VISUAL_SETTINGS } from "./graph-layout"

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "source:test.md",
    label: "Test",
    type: "entity",
    path: "test.md",
    linkCount: 3,
    community: 1,
    ...overrides,
  }
}

describe("nodeColor", () => {
  it("已知类型返回映射色", () => {
    expect(nodeColor("entity")).toBe("#60a5fa")
  })
  it("未知类型回落 other", () => {
    expect(nodeColor("nope")).toBe(NODE_TYPE_COLORS.other)
  })
})

describe("safeNodeLabel", () => {
  it("label 非空时 trim 返回", () => {
    expect(safeNodeLabel(node({ label: "  Hi  " }))).toBe("Hi")
  })
  it("label 为空时取 id 冒号后段", () => {
    expect(safeNodeLabel(node({ label: "   ", id: "source:doc.md:sec" }))).toBe("doc.md:sec")
  })
  it("id 无可用后段时返回原 id", () => {
    expect(safeNodeLabel(node({ label: "", id: "lonely" }))).toBe("lonely")
  })
})

describe("hexToRgba", () => {
  it("hex+alpha 转 rgba", () => {
    expect(hexToRgba("#60a5fa", 0.4)).toBe("rgba(96,165,250,0.4)")
  })
})

describe("mixColor", () => {
  it("ratio 0 取 color1，1 取 color2", () => {
    expect(mixColor("#000000", "#ffffff", 0)).toBe("#000000")
    expect(mixColor("#000000", "#ffffff", 1)).toBe("#ffffff")
  })
  it("ratio 0.5 取中点", () => {
    expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080")
  })
})

describe("nodeSize", () => {
  it("maxLinks 0 返回基准", () => {
    expect(nodeSize(5, 0, GRAPH_VISUAL_SETTINGS)).toBe(GRAPH_VISUAL_SETTINGS.baseNodeSize)
  })
  it("满链接返回上限", () => {
    expect(nodeSize(10, 10, GRAPH_VISUAL_SETTINGS)).toBe(GRAPH_VISUAL_SETTINGS.maxNodeSize)
  })
})

describe("edgeTypeForStyle", () => {
  it("curve/arrow 透传，其余收敛 clamped", () => {
    expect(edgeTypeForStyle("curve")).toBe("curve")
    expect(edgeTypeForStyle("arrow")).toBe("arrow")
    expect(edgeTypeForStyle("line")).toBe("clamped")
  })
})

describe("initialGraphPosition", () => {
  it("同输入确定性输出且含 x/y", () => {
    const n = node()
    expect(initialGraphPosition(n, 2, 9)).toEqual(initialGraphPosition(n, 2, 9))
    const p = initialGraphPosition(n, 2, 9)
    expect(typeof p.x).toBe("number")
    expect(typeof p.y).toBe("number")
  })
})

describe("shouldRenderEdgeLabels", () => {
  it("焦点模式恒开（含大边数）", () => {
    expect(shouldRenderEdgeLabels(1000, true)).toBe(true)
    expect(shouldRenderEdgeLabels(0, true)).toBe(true)
  })
  it("全图小边数开", () => {
    expect(shouldRenderEdgeLabels(0, false)).toBe(true)
    expect(shouldRenderEdgeLabels(EDGE_LABEL_FULL_GRAPH_THRESHOLD, false)).toBe(true)
  })
  it("全图超阈值关", () => {
    expect(shouldRenderEdgeLabels(EDGE_LABEL_FULL_GRAPH_THRESHOLD + 1, false)).toBe(false)
    expect(shouldRenderEdgeLabels(5000, false)).toBe(false)
  })
})
describe("shouldShowNodeLabel", () => {
  it("all 模式恒显示", () => {
    expect(shouldShowNodeLabel(node({ linkCount: 0 }), 10, "overview", "all")).toBe(true)
  })
  it("focused 模式按 35% 阈值", () => {
    expect(shouldShowNodeLabel(node({ linkCount: 4 }), 10, "overview", "focused")).toBe(true)
    expect(shouldShowNodeLabel(node({ linkCount: 1 }), 10, "overview", "focused")).toBe(false)
  })
  it("auto 模式跟随 preset（focused/minimal）", () => {
    expect(shouldShowNodeLabel(node({ linkCount: 4 }), 10, "overview", "auto")).toBe(true)
    expect(shouldShowNodeLabel(node({ linkCount: 4 }), 10, "storyline", "auto")).toBe(true)
    expect(shouldShowNodeLabel(node({ linkCount: 1 }), 10, "storyline", "auto")).toBe(false)
  })
})
describe("getSigmaThemeColors", () => {
  it("浅色 = 历史字面量（零行为变化）", () => {
    expect(getSigmaThemeColors(false)).toEqual({ label: "#1e293b", edgeLabel: "#334155", edgeHighlight: "#1e293b", dimMix: "#e2e8f0" })
  })
  it("深色 = slate 浅盘 + 向深收敛", () => {
    expect(getSigmaThemeColors(true)).toEqual({ label: "#e2e8f0", edgeLabel: "#cbd5e1", edgeHighlight: "#f1f5f8", dimMix: "#0f172a" })
  })
})
