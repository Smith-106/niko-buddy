import { GRAPH_MODE_PRESETS, type GraphMode } from "./graph-mode"
import type { GraphVisualTier } from "./graph-layout"
import type { GraphNode } from "./wiki-graph"

export const NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#60a5fa",    // blue-400
  concept: "#c084fc",   // purple-400
  source: "#fb923c",    // orange-400
  query: "#4ade80",     // green-400
  synthesis: "#f87171", // red-400
  overview: "#facc15",  // yellow-400
  comparison: "#2dd4bf", // teal-400
  other: "#94a3b8",     // slate-400
  character: "#f472b6",  // pink-400
  location: "#34d399",   // emerald-400
  organization: "#a78bfa", // violet-400
  item: "#fbbf24",       // amber-400
  event: "#38bdf8",      // sky-400
  chapter: "#818cf8",    // indigo-400
  outline: "#2dd4bf",    // teal-400
  foreshadowing: "#fb923c", // orange-400
  secret: "#e879f9",     // fuchsia-400
  conflict: "#f87171",   // red-400
  "timeline-point": "#67e8f9", // cyan-300
  "canon-rule": "#a3e635", // lime-400
}

export type GraphLabelDisplayMode = "all" | "auto" | "focused"
export type GraphEdgeStyle = "curve" | "arrow" | "line"

export function nodeColor(type: string): string {
  /* v8 ignore next */
  return NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.other
}

export function safeNodeLabel(node: GraphNode): string {
  const trimmed = node.label.trim()
  if (trimmed) return trimmed
  const fallback = node.id.split(":").slice(1).join(":").trim()
  return fallback || node.id
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function mixColor(color1: string, color2: string, ratio: number): string {
  const hex = (c: string) => parseInt(c, 16)
  const r1 = hex(color1.slice(1, 3)), g1 = hex(color1.slice(3, 5)), b1 = hex(color1.slice(5, 7))
  const r2 = hex(color2.slice(1, 3)), g2 = hex(color2.slice(3, 5)), b2 = hex(color2.slice(5, 7))
  const r = Math.round(r1 + (r2 - r1) * ratio)
  const g = Math.round(g1 + (g2 - g1) * ratio)
  const b = Math.round(b1 + (b2 - b1) * ratio)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

export function nodeSize(linkCount: number, maxLinks: number, visualSettings: GraphVisualTier): number {
  /* v8 ignore next */
  if (maxLinks === 0) return visualSettings.baseNodeSize
  const ratio = linkCount / maxLinks
  return visualSettings.baseNodeSize + Math.sqrt(ratio) * (visualSettings.maxNodeSize - visualSettings.baseNodeSize)
}

export function edgeTypeForStyle(edgeStyle: GraphEdgeStyle): string {
  if (edgeStyle === "curve") return "curve"
  if (edgeStyle === "arrow") return "arrow"
  return "clamped"
}

export function initialGraphPosition(node: GraphNode, index: number, total: number): { x: number; y: number } {
  const community = Number.isFinite(node.community) ? node.community : 0
  const communityAngle = community * 2.399963229728653
  const communityRadius = 25 + community * 6
  const centerX = Math.cos(communityAngle) * communityRadius
  const centerY = Math.sin(communityAngle) * communityRadius
  const nodeAngle = ((index / Math.max(total, 1)) * Math.PI * 2) + communityAngle
  const nodeRadius = 8 + (index % 11) * 2.5
  return {
    x: centerX + Math.cos(nodeAngle) * nodeRadius,
    y: centerY + Math.sin(nodeAngle) * nodeRadius,
  }
}

export function shouldShowNodeLabel(node: GraphNode, maxLinks: number, mode: GraphMode, labelDisplayMode: GraphLabelDisplayMode): boolean {
  if (labelDisplayMode === "all") return true
  if (labelDisplayMode === "focused") {
    return node.linkCount >= Math.max(2, Math.ceil(maxLinks * 0.35))
  }
  const preset = GRAPH_MODE_PRESETS[mode]
  /* v8 ignore next */
  if (preset.labelVisibility === "all") return true
  if (preset.labelVisibility === "minimal") {
    return node.linkCount >= Math.max(2, Math.ceil(maxLinks * 0.35))
  }
  return node.linkCount >= Math.max(1, Math.ceil(maxLinks * 0.2))
}
