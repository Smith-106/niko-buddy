import { useEffect, useCallback, useRef } from "react"
import Graph from "graphology"
import { useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core"
import type { MouseCoords, SigmaNodeEventPayload, TouchCoords } from "sigma/types"
import { useGraphLayoutWorker } from "@/components/graph/use-graph-layout-worker"
import { dedupeImportEdges, type GraphNode, type GraphEdge } from "@/lib/wiki-graph"
import { NOVEL_RELATION_LABELS } from "@/lib/novel"
import { GRAPH_LAYOUT_ITERATIONS, GRAPH_LAYOUT_PRESETS, type GraphLayoutPresetKey, type GraphVisualTier } from "@/lib/graph-layout"
import { type GraphMode } from "@/lib/graph-mode"
import { hexToRgba, initialGraphPosition, nodeColor, nodeSize, safeNodeLabel, shouldShowNodeLabel, type GraphLabelDisplayMode } from "@/lib/graph-style"

export const COMMUNITY_COLORS = [
  "#60a5fa",  // blue-400
  "#4ade80",  // green-400
  "#fb923c",  // orange-400
  "#c084fc",  // purple-400
  "#f87171",  // red-400
  "#2dd4bf",  // teal-400
  "#facc15",  // yellow-400
  "#f472b6",  // pink-400
  "#a78bfa",  // violet-400
  "#38bdf8",  // sky-400
  "#34d399",  // emerald-400
  "#fbbf24",  // amber-400
]

export type ColorMode = "type" | "community"

const FORESHADOWING_STATUS_FILL: Record<string, string> = {
  planted: "#f59e0b",
  advanced: "#3b82f6",
  resolved: "#22c55e",
  abandoned: "#6b7280",
}

// Cache computed node positions so re-renders don't re-layout
const positionCache = new Map<string, { x: number; y: number }>()
let lastLayoutDataKey = ""
// 用户已拖拽节点：布局 Worker 回填时跳过，避免覆盖手工排布；Tween 动画中途被拖拽也立即停靠。
const draggedNodeIds = new Set<string>()

export function __resetGraphLayoutCachesForTests(): void {
  positionCache.clear()
  draggedNodeIds.clear()
  lastLayoutDataKey = ""
}

/**
 * 面板开合 / 拖拽 resize 时的防抖刷新：只调 sigma.refresh()，不 remount，
 * 相机位姿与拖拽/悬停态完整保留。容器尺寸变化由 Sigma 内部处理，
 * 此处防抖只是把高频 ResizeObserver 回调收敛为一次 refresh。
 * 非 Element 容器（测试替身）或缺 ResizeObserver 时静默跳过。
 */
export function SigmaResizeRefresher({ debounceMs = 120 }: { debounceMs?: number } = {}) {
  const sigma = useSigma()

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return
    let container: unknown
    try {
      container = sigma.getContainer()
    } catch {
      return
    }
    if (!(container instanceof Element)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          sigma.refresh()
        } catch {
          // Sigma 未就绪时跳过本次刷新，下一次 resize 会再试
        }
      }, debounceMs)
    })
    observer.observe(container)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
    }
  }, [sigma, debounceMs])

  return null
}

export function GraphLoader({
  nodes,
  edges,
  colorMode,
  novelMode,
  graphMode,
  labelDisplayMode,
  edgeColorHex,
  edgeStrengthPercent,
  edgeLabelsAlwaysVisible,
  visualSettings,
  foreshadowingStatusMap,
  layoutPreset,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  colorMode: ColorMode
  novelMode: boolean
  graphMode: GraphMode
  labelDisplayMode: GraphLabelDisplayMode
  edgeColorHex: string
  edgeStrengthPercent: number
  edgeLabelsAlwaysVisible: boolean
  visualSettings: GraphVisualTier
  foreshadowingStatusMap: Map<string, string>
  layoutPreset: GraphLayoutPresetKey
}) {
  const loadGraph = useLoadGraph()
  const { computeLayout } = useGraphLayoutWorker()
  const sigma = useSigma()

  useEffect(() => {
    const dataKey = nodes.map((n) => `${n.id}:${n.community}:${n.linkCount}`).sort().join(",") + "|" + edges.map((edge) => `${edge.source}->${edge.target}:${edge.weight}`).sort().join(",") + `|preset:${layoutPreset}`
    const needsLayout = dataKey !== lastLayoutDataKey

    const graph = new Graph()
    const maxLinks = Math.max(...nodes.map((n) => n.linkCount), 1)

    for (const [index, node] of nodes.entries()) {
      const cached = positionCache.get(node.id)
      const initialPosition = initialGraphPosition(node, index, nodes.length)
      let assignedColor = colorMode === "community"
        ? COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]
        : nodeColor(node.type)
      if (graphMode === "foreshadowing" && node.type === "foreshadowing") {
        const status = foreshadowingStatusMap.get(node.label)
        if (status && FORESHADOWING_STATUS_FILL[status]) {
          assignedColor = FORESHADOWING_STATUS_FILL[status]
        }
      }
      graph.addNode(node.id, {
        x: cached?.x ?? initialPosition.x,
        y: cached?.y ?? initialPosition.y,
        size: nodeSize(node.linkCount, maxLinks, visualSettings),
        color: assignedColor,
        label: shouldShowNodeLabel(node, maxLinks, graphMode, labelDisplayMode) ? safeNodeLabel(node) : "",
        nodeType: node.type,
        nodePath: node.path,
        community: node.community,
      })
    }

    // Calculate max weight for normalization
    const maxWeight = Math.max(...edges.map((e) => e.weight), 1)

    // P0-2：与侧栏统计同一口径（dedupeImportEdges）：端点缺失丢弃同键/反向去重，
    // 首见保留。helper 已前置保证端点存在且键唯一，此处直接导入。
    for (const edge of dedupeImportEdges(new Set(nodes.map((n) => n.id)), edges)) {
      const edgeKey = `${edge.source}->${edge.target}`
      const normalizedWeight = edge.weight / maxWeight
      const strengthScale = edgeStrengthPercent / 100
      const size = (visualSettings.minEdgeSize + normalizedWeight * (visualSettings.maxEdgeSize - visualSettings.minEdgeSize)) * strengthScale
      const baseAlpha = visualSettings.minEdgeAlpha + normalizedWeight * (visualSettings.maxEdgeAlpha - visualSettings.minEdgeAlpha)
      const alpha = Math.max(0.14, Math.min(0.95, baseAlpha * strengthScale))
      const color = hexToRgba(edgeColorHex, alpha)
      const relationLabel = edgeLabelsAlwaysVisible && novelMode && edge.relation
        ? NOVEL_RELATION_LABELS[edge.relation as keyof typeof NOVEL_RELATION_LABELS] ?? edge.relation
        : undefined
      graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
        color,
        size,
        weight: edge.weight,
        relation: edge.relation ?? "",
        label: relationLabel,
        curvature: 0.25,
      })
    }

    // G3 (39 号修复): ForceAtlas2 下沉 Web Worker — 先以初始/缓存坐标立即渲染
    // (渐进式 UX, 不再白屏等待), worker 返回后更新坐标 + refresh。
    // worker 不可用/超时/出错时 computeLayout 内部回退主线程同步计算 (与原逻辑等价)。
    if (needsLayout && nodes.length > 1) {
      lastLayoutDataKey = dataKey
      const layoutInput = {
        nodes: nodes.map((n) => {
          const cached = positionCache.get(n.id)
          const initialPosition = initialGraphPosition(n, nodes.indexOf(n), nodes.length)
          return {
            id: n.id,
            x: cached?.x ?? initialPosition.x,
            y: cached?.y ?? initialPosition.y,
            size: nodeSize(n.linkCount, maxLinks, visualSettings),
          }
        }),
        edges: edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight })),
        iterations: GRAPH_LAYOUT_ITERATIONS,
        settings: GRAPH_LAYOUT_PRESETS[layoutPreset],
        barnesHutOptimize: nodes.length > 50,
      }
      void computeLayout(layoutInput).then((positions) => {
        // dataKey 守卫: 过期响应不覆盖新数据
        if (lastLayoutDataKey !== dataKey) return
        // 拖拽锁定：跳过用户已手工摆放的节点，保持其 positionCache/画面位置。
        const start = new Map<string, { x: number; y: number }>()
        graph.forEachNode((nodeId, attrs) => {
          if (draggedNodeIds.has(nodeId)) return
          const end = positions[nodeId]
          if (!end) return
          const sx = typeof attrs.x === "number" ? attrs.x : end.x
          const sy = typeof attrs.y === "number" ? attrs.y : end.y
          start.set(nodeId, { x: sx, y: sy })
        })
        if (start.size === 0) {
          try { sigma.refresh() } catch { /* 未就绪跳过 */ }
          return
        }
        // Tween 缓动：Worker 坐标分 350ms easeOutCubic 渐入，避免整图瞬间跳变。
        const DURATION_MS = 350
        const getNow = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now())
        const t0 = getNow()
        const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
        const rafFn: (cb: (t: number) => void) => number =
          typeof requestAnimationFrame !== "undefined"
            ? (cb) => requestAnimationFrame(cb)
            : ((cb: (t: number) => void) => setTimeout(() => cb(getNow()), 16) as unknown as number)
        const step = (now: number) => {
          if (lastLayoutDataKey !== dataKey) return
          const t = Math.min(1, (now - t0) / DURATION_MS)
          const k = easeOutCubic(t)
          start.forEach((s, nodeId) => {
            const end = positions[nodeId]
            if (!end || draggedNodeIds.has(nodeId)) return
            try {
              graph.setNodeAttribute(nodeId, "x", s.x + (end.x - s.x) * k)
              graph.setNodeAttribute(nodeId, "y", s.y + (end.y - s.y) * k)
            } catch { /* 节点已卸载时跳过 */ }
          })
          try { sigma.refresh() } catch { /* 未就绪跳过 */ }
          if (t < 1) {
            rafFn(step)
          } else {
            start.forEach((_, nodeId) => {
              const end = positions[nodeId]
              if (!end || draggedNodeIds.has(nodeId)) return
              try {
                graph.setNodeAttribute(nodeId, "x", end.x)
                graph.setNodeAttribute(nodeId, "y", end.y)
                positionCache.set(nodeId, { x: end.x, y: end.y })
              } catch { /* 节点已卸载时跳过 */ }
            })
            try { sigma.refresh() } catch { /* 未就绪跳过 */ }
          }
        }
        rafFn(step)
      })
    }

    loadGraph(graph)
  }, [loadGraph, computeLayout, sigma, nodes, edges, colorMode, novelMode, graphMode, labelDisplayMode, edgeColorHex, edgeStrengthPercent, edgeLabelsAlwaysVisible, visualSettings, foreshadowingStatusMap, layoutPreset])

  return null
}

export function HighlightManager({ highlightedNodes }: { highlightedNodes: Set<string> }) {
  const sigma = useSigma()
  // P0-1 三重加固：mounted 守卫 + 世代令牌（stale 闭包 refresh 直接丢弃，fail-closed）。
  const mountedRef = useRef(true)
  const genRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    const gen = ++genRef.current
    let graph: ReturnType<typeof sigma.getGraph>
    try {
      graph = sigma.getGraph()
    } catch {
      // Sigma 容器在 GraphLoader 重建瞬间可能未就绪：跳过本轮高亮，等待下一次 highlightedNodes/sigma 变更再试。
      return
    }
    // 空图守卫：无节点时高亮 mutation 与 refresh 均为无用功，直接返回。
    if (graph.order === 0) return
    const highlighted = highlightedNodes instanceof Set ? highlightedNodes : new Set<string>()
    /* v8 ignore next */
    if (highlighted.size === 0) {
      graph.forEachNode((n) => {
        if (!graph.hasNode(n)) return
        graph.removeNodeAttribute(n, "insightHighlight")
        graph.removeNodeAttribute(n, "dimmed")
      })
      graph.forEachEdge((e) => {
        if (!graph.hasEdge(e)) return
        graph.removeEdgeAttribute(e, "dimmed")
        graph.removeEdgeAttribute(e, "highlighted")
      })
    } else {
      /* v8 ignore start */
      const visibleHighlighted = new Set<string>()
      graph.forEachNode((n) => {
        if (highlighted.has(n)) visibleHighlighted.add(n)
      })
      graph.forEachNode((n) => {
        if (!graph.hasNode(n)) return
        if (visibleHighlighted.has(n)) {
          graph.setNodeAttribute(n, "insightHighlight", true)
          graph.removeNodeAttribute(n, "dimmed")
        } else {
          graph.setNodeAttribute(n, "dimmed", true)
          graph.removeNodeAttribute(n, "insightHighlight")
        }
      })
      graph.forEachEdge((e, _attrs, source, target) => {
        if (!graph.hasEdge(e)) return
        if (visibleHighlighted.has(source) && visibleHighlighted.has(target)) {
          graph.setEdgeAttribute(e, "highlighted", true)
          graph.removeEdgeAttribute(e, "dimmed")
        } else {
          graph.setEdgeAttribute(e, "dimmed", true)
          graph.removeEdgeAttribute(e, "highlighted")
        }
      })
      /* v8 ignore stop */
    }
    // 世代令牌 + unmount 双检：任一失配说明本闭包已过期，丢弃 refresh（#37 根因：kill 后 stale 刷）。
    if (!mountedRef.current || gen !== genRef.current) return
    try {
      sigma.refresh()
    } catch {
      // refresh 时容器若正被 remount（sigmaKey 变化）则跳过，下一帧 Sigma 会自行重绘。
    }
    return () => {
      mountedRef.current = false
    }
  }, [sigma, highlightedNodes])

  return null
}

export function EventHandler({
  onNodeClick,
  onNodeDoubleClick,
  onNodeContextMenu,
}: {
  onNodeClick: (nodeId: string) => void
  onNodeDoubleClick: (nodeId: string) => void
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void
}) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()
  const draggedNodeRef = useRef<string | null>(null)
  const draggedMovedRef = useRef(false)

  const moveDraggedNode = useCallback((coordinates: MouseCoords | { x: number; y: number }) => {
    const node = draggedNodeRef.current
    if (!node) return
    const graph = sigma.getGraph()
    if (!graph.hasNode(node)) return

    const nextPosition = sigma.viewportToGraph({ x: coordinates.x, y: coordinates.y })
    graph.setNodeAttribute(node, "x", nextPosition.x)
    graph.setNodeAttribute(node, "y", nextPosition.y)
    graph.setNodeAttribute(node, "dragging", true)
    positionCache.set(node, nextPosition)
    draggedNodeIds.add(node)
    draggedMovedRef.current = true
    sigma.refresh()
  }, [sigma])

  const releaseDraggedNode = useCallback(() => {
    const node = draggedNodeRef.current
    if (!node) return
    const graph = sigma.getGraph()
    if (graph.hasNode(node)) {
      graph.removeNodeAttribute(node, "dragging")
    }
    draggedNodeRef.current = null
    sigma.setSetting("enableCameraPanning", true)
    sigma.getContainer().style.cursor = "default"
    sigma.refresh()
  }, [sigma])

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        if (draggedMovedRef.current) {
          draggedMovedRef.current = false
          return
        }
        onNodeClick(node)
      },
      doubleClickNode: ({ node }) => {
        if (draggedMovedRef.current) {
          draggedMovedRef.current = false
          return
        }
        onNodeDoubleClick(node)
      },
      downNode: (payload: SigmaNodeEventPayload) => {
        // 只响应左键，右键只用于打开菜单，不触发拖拽
        if ((payload.event.original as MouseEvent).button !== 0) return
        const node = nodeIdFromPayload(payload)
        payload.preventSigmaDefault()
        payload.event.original.preventDefault()
        draggedNodeRef.current = node
        draggedMovedRef.current = false
        sigma.getGraph().setNodeAttribute(node, "dragging", true)
        sigma.setSetting("enableCameraPanning", false)
        sigma.getContainer().style.cursor = "grabbing"
      },
      mousemovebody: (coordinates: MouseCoords) => moveDraggedNode(coordinates),
      mouseup: releaseDraggedNode,
      touchmovebody: (coordinates: TouchCoords) => {
        const touch = coordinates.touches[0] ?? coordinates.previousTouches[0]
        if (touch) moveDraggedNode(touch)
      },
      touchup: releaseDraggedNode,
      rightClickNode: (payload: SigmaNodeEventPayload) => {
        payload.preventSigmaDefault()
        payload.event.original.preventDefault()
        const point = clientPointFromEvent(payload.event.original)
        onNodeContextMenu(nodeIdFromPayload(payload), point.x, point.y)
      },
      rightClickStage: () => onNodeContextMenu("", 0, 0),
      enterNode: ({ node }) => {
        const container = sigma.getContainer()
        container.style.cursor = "pointer"
        const graph = sigma.getGraph()
        graph.setNodeAttribute(node, "hovering", true)
        const neighbors = new Set(graph.neighbors(node))
        neighbors.add(node)
        graph.forEachNode((n) => {
          if (!neighbors.has(n)) graph.setNodeAttribute(n, "dimmed", true)
        })
        graph.forEachEdge((e, _attrs, source, target) => {
          if (source !== node && target !== node) {
            graph.setEdgeAttribute(e, "dimmed", true)
          } else {
            graph.setEdgeAttribute(e, "highlighted", true)
          }
        })
        sigma.refresh()
      },
      leaveNode: () => {
        if (draggedNodeRef.current) return
        const container = sigma.getContainer()
        container.style.cursor = "default"
        const graph = sigma.getGraph()
        graph.forEachNode((n) => {
          graph.removeNodeAttribute(n, "hovering")
          graph.removeNodeAttribute(n, "dimmed")
        })
        graph.forEachEdge((e) => {
          graph.removeEdgeAttribute(e, "dimmed")
          graph.removeEdgeAttribute(e, "highlighted")
        })
        sigma.refresh()
      },
    })
  }, [registerEvents, sigma, onNodeClick, onNodeContextMenu, moveDraggedNode, releaseDraggedNode])

  return null
}

function nodeIdFromPayload(payload: SigmaNodeEventPayload): string {
  return payload.node
}

function clientPointFromEvent(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY }
  const touch = event.touches[0] ?? event.changedTouches[0]
  return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 }
}
