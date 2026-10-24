import type { ForceAtlas2Settings } from "graphology-layout-forceatlas2"

export const GRAPH_VISUAL_SETTINGS = {
  baseNodeSize: 6,
  maxNodeSize: 20,
  minEdgeSize: 0.35,
  maxEdgeSize: 2,
  minEdgeAlpha: 0.12,
  maxEdgeAlpha: 0.42,
} as const

export const GRAPH_LAYOUT_SETTINGS = {
  gravity: 1,
  scalingRatio: 1.5,
  slowDown: 1,
  adjustSizes: true,
  strongGravityMode: false,
  // 对比证据见 graph-layout-clustering.spec.ts：linLog/outbound 组合在小说型社区图谱
  // （环 lattice + 社区 hub + 跨社区噪声边 + 主角 hub）上 silhouette 反而低于默认 FA2；
  // 显式 gravity 1 + scalingRatio 1.5 的 plain FA2 在 90/120/300 节点三档基准上稳定胜出。
  linLogMode: false,
  outboundAttractionDistribution: false,
} as const

export type GraphLayoutPresetKey = "community" | "compact" | "explore"

export const LAYOUT_PRESET_ORDER: GraphLayoutPresetKey[] = ["community", "compact", "explore"]

export const DEFAULT_LAYOUT_PRESET: GraphLayoutPresetKey = "community"

/**
 * 布局预设三档：社区优先 (默认调优值) / 紧凑中心 (强引力收拢) / 宽松探索 (弱引力摊开)。
 * community 由 GRAPH_LAYOUT_SETTINGS 派生，单一可信源，避免两处数字漂移。
 */
export const GRAPH_LAYOUT_PRESETS: Record<GraphLayoutPresetKey, ForceAtlas2Settings> = {
  community: { ...GRAPH_LAYOUT_SETTINGS },
  compact: {
    gravity: 1.2,
    scalingRatio: 2,
    slowDown: 2.2,
    adjustSizes: true,
    strongGravityMode: true,
    linLogMode: true,
    outboundAttractionDistribution: true,
  },
  explore: {
    gravity: 0.05,
    scalingRatio: 8,
    slowDown: 2.2,
    adjustSizes: true,
    strongGravityMode: false,
    linLogMode: false,
    outboundAttractionDistribution: false,
  },
}

export interface GraphVisualTier {
  baseNodeSize: number
  maxNodeSize: number
  minEdgeSize: number
  maxEdgeSize: number
  minEdgeAlpha: number
  maxEdgeAlpha: number
}

export function getGraphVisualSettings(nodeCount: number): GraphVisualTier {
  if (nodeCount >= 500) {
    return {
      baseNodeSize: 4,
      maxNodeSize: 14,
      minEdgeSize: 0.2,
      maxEdgeSize: 1.2,
      minEdgeAlpha: 0.06,
      maxEdgeAlpha: 0.25,
    }
  }
  if (nodeCount >= 100) {
    return {
      baseNodeSize: 5,
      maxNodeSize: 17,
      minEdgeSize: 0.28,
      maxEdgeSize: 1.6,
      minEdgeAlpha: 0.09,
      maxEdgeAlpha: 0.34,
    }
  }
  return {
    baseNodeSize: GRAPH_VISUAL_SETTINGS.baseNodeSize,
    maxNodeSize: GRAPH_VISUAL_SETTINGS.maxNodeSize,
    minEdgeSize: GRAPH_VISUAL_SETTINGS.minEdgeSize,
    maxEdgeSize: GRAPH_VISUAL_SETTINGS.maxEdgeSize,
    minEdgeAlpha: GRAPH_VISUAL_SETTINGS.minEdgeAlpha,
    maxEdgeAlpha: GRAPH_VISUAL_SETTINGS.maxEdgeAlpha,
  }
}

export const GRAPH_LAYOUT_ITERATIONS = 220