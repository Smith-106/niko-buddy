import { useEffect, useCallback, useMemo, useState, useRef } from "react"
import { SigmaContainer } from "@react-sigma/core"
import "@react-sigma/core/lib/style.css"
import {
  EdgeArrowProgram,
  EdgeClampedProgram,
  EdgeLineProgram,
} from "sigma/rendering"
import EdgeCurveProgram from "@sigma/edge-curve"
import { Network, RefreshCw, Lightbulb, AlertTriangle, Link2, X, Filter, EyeOff, FileText } from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFileAtomic, createDirectory, fileExists } from "@/commands/fs"
import { buildWikiGraph, type GraphNode, type GraphEdge, type CommunityInfo } from "@/lib/wiki-graph"
import { buildEditableGraphNodePage } from "@/lib/graph-node-page"
import { findSurprisingConnections, detectKnowledgeGaps, type SurprisingConnection, type KnowledgeGap } from "@/lib/graph-insights"
import { normalizePath } from "@/lib/path-utils"
import { applyGraphFilters, DEFAULT_GRAPH_FILTERS, type GraphFilterState } from "@/lib/graph-filters"
import { buildGraphMindMap } from "@/lib/graph-readable"
import { NOVEL_NODE_TYPE_LABELS, NOVEL_RELATION_LABELS, loadForeshadowingTracker } from "@/lib/novel"
import type { ForeshadowingStore } from "@/lib/novel"
import { getGraphVisualSettings } from "@/lib/graph-layout"
import { GRAPH_MODE_LABELS, GRAPH_MODE_PRESETS, type GraphMode } from "@/lib/graph-mode"
import { useTranslation } from "react-i18next"
import { formatOperationError } from "@/lib/format-operation-error"
import { NODE_TYPE_COLORS, edgeTypeForStyle, hexToRgba, mixColor, type GraphEdgeStyle, type GraphLabelDisplayMode } from "@/lib/graph-style"
import { toErrorMessage } from "@/lib/utils"
import { COMMUNITY_COLORS, EventHandler, GraphLoader, HighlightManager, type ColorMode } from "./sigma-graph-views"
import { DocumentGraphView } from "./document-graph-view"
import { MindMapGraphView, ZoomControls } from "./mindmap-views"


type GraphDisplayMode = "graph" | "document" | "mindmap"

const GRAPH_LABEL_MODE_KEY = "lk-graph-label-display-mode"
const GRAPH_EDGE_COLOR_KEY = "lk-graph-edge-color"
const GRAPH_EDGE_STRENGTH_KEY = "lk-graph-edge-strength"
const GRAPH_EDGE_STYLE_KEY = "lk-graph-edge-style"

async function openProjectFromGraph() {
  const { pickDirectory } = await import("@/lib/platform")
  const { openProject } = await import("@/commands/fs")
  const path = await pickDirectory()
  if (!path) return
  try {
    const proj = await openProject(path)
    const { claimProjectOwnership } = await import("@/lib/project-owner")
    const claim = await claimProjectOwnership(proj.path)
    if (!claim.ok && claim.conflict && claim.occupant) {
      const proceed = window.confirm(
        `该项目正被「${claim.occupant.app}」占用（${new Date(claim.occupant.startedAt).toLocaleTimeString()} 起）。\n` +
        `两个引擎实例同时写入 .niko-buddy/ 与 .novel/status.json 会互相覆盖。\n\n` +
        `确定继续打开？`,
      )
      if (!proceed) return
    }
    const { hydrateProjectOnOpen } = await import("@/lib/composition-root")
    await hydrateProjectOnOpen(proj)
  } catch (err) {
    window.alert(`打开项目失败：${err}`)
  }
}










// --- Main component ---

export function GraphView() {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [communities, setCommunities] = useState<CommunityInfo[]>([])
  const [surprisingConns, setSurprisingConns] = useState<SurprisingConnection[]>([])
  const [knowledgeGaps, setKnowledgeGaps] = useState<KnowledgeGap[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoveredType, setHoveredType] = useState<string | null>(null)
  const colorMode = useWikiStore((s) => s.graphColorMode) as ColorMode
  const displayMode = useWikiStore((s) => s.graphDisplayMode) as GraphDisplayMode
  const graphMode = useWikiStore((s) => s.graphMode) as GraphMode
  const labelDisplayMode = useWikiStore((s) => s.graphLabelDisplayMode) as GraphLabelDisplayMode
  const edgeColorHex = useWikiStore((s) => s.graphEdgeColorHex)
  const edgeStrengthPercent = useWikiStore((s) => s.graphEdgeStrengthPercent)
  const edgeStyle = useWikiStore((s) => s.graphEdgeStyle) as GraphEdgeStyle
  const edgeLabelsAlwaysVisible = useWikiStore((s) => s.graphEdgeLabelsAlwaysVisible)
  const showFilters = useWikiStore((s) => s.graphShowFilters)
  const setGraphStats = useWikiStore((s) => s.setGraphStats)
  const setRefreshGraph = useWikiStore((s) => s.setRefreshGraph)
  const [showInsights, setShowInsights] = useState(false)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set())
  const [sigmaKey, setSigmaKey] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const [legendCollapsed, setLegendCollapsed] = useState(false)
  const [filters, setFilters] = useState<GraphFilterState>(() => ({
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: new Set(),
    hiddenNodeIds: new Set(),
  }))
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [editingNode, setEditingNode] = useState<GraphNode | null>(null)
  const [editingPath, setEditingPath] = useState("")
  const [editingContent, setEditingContent] = useState("")
  const [editStatus, setEditStatus] = useState<string | null>(null)
  const [savingNode, setSavingNode] = useState(false)
  const graphContainerRef = useRef<HTMLDivElement>(null)
  // i18n node type labels (populated after mount to support language switching)
  const [nodeTypeLabels, setNodeTypeLabels] = useState<Record<string, string>>({})

  const [foreshadowingStore, setForeshadowingStore] = useState<ForeshadowingStore | null>(null)

  useEffect(() => {
    if (!project) return
    // DEBUG#8 / defensive D1：失败不再静默变成 null（与「确实没有伏笔」不可区分），
    // 切换项目时迟到的结果也不再写入当前图。
    let cancelled = false
    const path = project.path
    loadForeshadowingTracker(path)
      .then((store) => {
        if (!cancelled) setForeshadowingStore(store)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("[Graph] foreshadowing tracker load failed:", toErrorMessage(err))
        setForeshadowingStore(null)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  useEffect(() => {
    localStorage.setItem(GRAPH_LABEL_MODE_KEY, labelDisplayMode)
  }, [labelDisplayMode])

  useEffect(() => {
    localStorage.setItem(GRAPH_EDGE_COLOR_KEY, edgeColorHex)
  }, [edgeColorHex])

  useEffect(() => {
    localStorage.setItem(GRAPH_EDGE_STRENGTH_KEY, String(edgeStrengthPercent))
  }, [edgeStrengthPercent])

  useEffect(() => {
    localStorage.setItem(GRAPH_EDGE_STYLE_KEY, edgeStyle)
  }, [edgeStyle])

  const lastLoadedVersion = useRef(-1)
  // R4 共识（glm+qwen）: 并发重载时旧请求的响应可回填覆盖新图数据（缺请求代次守卫）。
  const loadGraphGenRef = useRef(0)

  const loadGraph = useCallback(async () => {
    if (!project) return
    const gen = ++loadGraphGenRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await buildWikiGraph(normalizePath(project.path))
      if (loadGraphGenRef.current !== gen) return
      setNodes(result.nodes)
      setEdges(result.edges)
      setCommunities(result.communities)
      setSurprisingConns(findSurprisingConnections(result.nodes, result.edges, result.communities))
      setKnowledgeGaps(detectKnowledgeGaps(result.nodes, result.edges, result.communities))
      lastLoadedVersion.current = useWikiStore.getState().dataVersion
    } catch (err) {
      if (loadGraphGenRef.current !== gen) return
      // R4 共识（glm+qwen）: 原错误页直接渲染原始 err.message，未按「本地化引导 + 原始诊断」。
      setError(`${t("graph.buildFailed")}：${toErrorMessage(err)}`)
    } finally {
      if (loadGraphGenRef.current === gen) setLoading(false)
    }
  }, [project])

  useEffect(() => {
    setRefreshGraph(() => loadGraph)
    return () => setRefreshGraph(null)
  }, [loadGraph, setRefreshGraph])

  // Initialize node type labels when i18n is ready
  useEffect(() => {
    if (novelMode) {
      setNodeTypeLabels({
        entity: t("graph.nodeTypeLabels.entity"),
        concept: t("novel.graph.nodeTypeLabels.concept"),
        source: t("graph.nodeTypeLabels.source"),
        query: t("graph.nodeTypeLabels.query"),
        synthesis: t("graph.nodeTypeLabels.synthesis"),
        overview: t("graph.nodeTypeLabels.overview"),
        comparison: t("graph.nodeTypeLabels.comparison"),
        other: t("graph.nodeTypeLabels.other"),
        character: t("novel.graph.nodeTypeLabels.character"),
        location: t("novel.graph.nodeTypeLabels.location"),
        organization: t("novel.graph.nodeTypeLabels.organization"),
        item: t("novel.graph.nodeTypeLabels.item"),
        event: t("novel.graph.nodeTypeLabels.event"),
        chapter: t("novel.graph.nodeTypeLabels.chapter"),
        outline: t("novel.graph.nodeTypeLabels.outline"),
        foreshadowing: t("novel.graph.nodeTypeLabels.foreshadowing"),
        secret: t("novel.graph.nodeTypeLabels.secret"),
        conflict: t("novel.graph.nodeTypeLabels.conflict"),
        "timeline-point": t("novel.graph.nodeTypeLabels.timeline-point"),
        "canon-rule": t("novel.graph.nodeTypeLabels.canon-rule"),
      })
    } else {
      setNodeTypeLabels({
        entity: t("graph.nodeTypeLabels.entity"),
        concept: t("graph.nodeTypeLabels.concept"),
        source: t("graph.nodeTypeLabels.source"),
        query: t("graph.nodeTypeLabels.query"),
        synthesis: t("graph.nodeTypeLabels.synthesis"),
        overview: t("graph.nodeTypeLabels.overview"),
        comparison: t("graph.nodeTypeLabels.comparison"),
        other: t("graph.nodeTypeLabels.other"),
      })
    }
  }, [t, novelMode])

  useEffect(() => {
    if (dataVersion !== lastLoadedVersion.current) {
      loadGraph()
    }
  }, [loadGraph, dataVersion])

  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return
      try {
        const content = await readFile(node.path)
        setSelectedFile(node.path)
        setFileContent(content)
      } catch (err) {
        console.error("Failed to open wiki page:", err)
      }
    },
    [nodes, setSelectedFile, setFileContent],
  )

  const handleEditNode = useCallback(
    async (node: GraphNode) => {
      /* v8 ignore next */
      if (!project) return
      const page = buildEditableGraphNodePage(project.path, node)
      let content = page.content
      // R4 共识（deepseek+glm，high）: 原先 readFile 失败时回退模板内容，而 editingPath
      // 仍是真实档案页 → 用户对着模板编辑并保存，会把真实档案页覆盖成模板（数据丢失）。
      // 正确做法：读取失败如实上报并**不进入编辑态**；仅「文件不存在」才用模板新建。
      try {
        if (await fileExists(page.path)) content = await readFile(page.path)
      } catch (err) {
        setError(formatOperationError(t, err))
        setNodeMenu(null)
        return
      }
      setEditingNode(node)
      setEditingPath(page.path)
      setEditingContent(content)
      setEditStatus(null)
      setNodeMenu(null)
    },
    [project],
  )

  const handleOpenNodeProfilePage = useCallback(
    async (node: GraphNode) => {
      /* v8 ignore next */
      if (!project) return
      const page = buildEditableGraphNodePage(project.path, node)
      let content = page.content
      let created = false
      try {
        if (await fileExists(page.path)) {
          content = await readFile(page.path)
        } else {
          const dir = page.path.split(/[/\\]/).slice(0, -1).join("/")
          if (dir) await createDirectory(dir)
          await writeFileAtomic(page.path, content)
          created = true
        }
        setSelectedFile(page.path)
        setFileContent(content)
        setActiveView("sources")
        setNodeMenu(null)
        if (created) bumpDataVersion()
      } catch (err) {
        console.error("Failed to open node profile page:", err)
        setError(formatOperationError(t, err))
      }
    },
    [project, setSelectedFile, setFileContent, setActiveView, bumpDataVersion, t],
  )

  const handleSaveNodeEdit = useCallback(async () => {
    /* v8 ignore next */
    if (!project || !editingNode || !editingPath) return
    setSavingNode(true)
    setEditStatus(null)
    try {
      const dir = editingPath.split(/[/\\]/).slice(0, -1).join("/")
      if (dir) await createDirectory(dir)
      await writeFileAtomic(editingPath, editingContent)
      const page = buildEditableGraphNodePage(project.path, editingNode)
      const embCfg = useWikiStore.getState().embeddingConfig
      if (embCfg.enabled && embCfg.model) {
        const { embedPage } = await import("@/lib/embedding")
        await embedPage(project.path, page.pageId, page.title, editingContent, embCfg)
      }
      setSelectedFile(editingPath)
      setFileContent(editingContent)
      bumpDataVersion()
      setEditStatus(embCfg.enabled && embCfg.model ? t("graph.savedRealProfileWithEmbedding") : t("graph.savedRealProfile"))
    } catch (err) {
      // R4 共识（glm+qwen）: 原直接展示原始 err.message。
      setEditStatus(`${t("graph.saveNodeFailed")}：${toErrorMessage(err)}`)
    } finally {
      setSavingNode(false)
    }
  }, [project, editingNode, editingPath, editingContent, setSelectedFile, setFileContent, bumpDataVersion, t])

  const handleNodeContextMenu = useCallback((nodeId: string, x: number, y: number) => {
    if (!nodeId) {
      setNodeMenu(null)
      return
    }
    const rect = graphContainerRef.current?.getBoundingClientRect()
    setNodeMenu({
      nodeId,
      x: rect ? x - rect.left : x,
      y: rect ? y - rect.top : y,
    })
  }, [])

  const resetFilters = useCallback(() => {
    setFilters({
      ...DEFAULT_GRAPH_FILTERS,
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
    })
    setNodeMenu(null)
  }, [])

  const handleCancelNodeEdit = useCallback(() => {
    setEditingNode(null)
    setEditingPath("")
    setEditingContent("")
    setEditStatus(null)
  }, [])

  // Unmount sigma when panels resize or toggle to prevent WebGL crash.
  // Sigma crashes with "could not find suitable program for node type circle"
  // when its canvas is resized by external layout changes.

  // 1. Detect panel open/close (selectedFile, insights)
  const selectedFileForLayout = useWikiStore((s) => s.selectedFile)
  const layoutKey = `${!!selectedFileForLayout}-${showInsights}`
  const prevLayoutKey = useRef(layoutKey)

  useEffect(() => {
    if (prevLayoutKey.current !== layoutKey) {
      prevLayoutKey.current = layoutKey
      setIsResizing(true)
      const timer = setTimeout(() => {
        setSigmaKey((k) => k + 1)
        setIsResizing(false)
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [layoutKey])

  // 2. Detect panel drag resize via data-panel-resizing attribute on body
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      const dragging = document.body.dataset.panelResizing === "true"
      if (dragging && !isResizing) {
        setIsResizing(true)
      }
      if (!dragging && isResizing) {
        // Drag ended — remount sigma after a tick
        timer = setTimeout(() => {
          setSigmaKey((k) => k + 1)
          setIsResizing(false)
        }, 50)
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-panel-resizing"] })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
    }
  }, [isResizing])

  useEffect(() => {
    setHighlightedNodes(new Set())
    setNodeMenu(null)
    setSigmaKey((current) => current + 1)
  }, [graphMode])

  // Count nodes by type for legend
  const typeCounts = useMemo(
    () =>
      nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.type] = (acc[n.type] ?? 0) + 1
        return acc
      }, {}),
    [nodes],
  )

  const effectiveFilters = useMemo<GraphFilterState>(() => {
    const modePreset = GRAPH_MODE_PRESETS[graphMode]
    const combinedHiddenTypes = new Set(filters.hiddenTypes)
    /* v8 ignore next */
    if (modePreset.hiddenNodeTypes) {
      for (const t of modePreset.hiddenNodeTypes) {
        combinedHiddenTypes.add(t)
      }
    }
    return {
      ...filters,
      hideStructural: modePreset.hideStructural,
      hideIsolated: modePreset.hideIsolated,
      hiddenTypes: combinedHiddenTypes,
      allowedNodeTypes: modePreset.allowedNodeTypes,
      minimumEdgeWeight: modePreset.minimumEdgeWeight,
    }
  }, [filters, graphMode])

  const filteredGraph = useMemo(
    () => applyGraphFilters(nodes, edges, effectiveFilters),
    [nodes, edges, effectiveFilters],
  )
  const visualSettings = useMemo(() => getGraphVisualSettings(nodes.length), [nodes.length])
  const foreshadowingStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    if (!foreshadowingStore) return map
    for (const item of foreshadowingStore.items) {
      if (item.name) map.set(item.name, item.status)
    }
    return map
  }, [foreshadowingStore])
  const graphMindMap = useMemo(
    () => buildGraphMindMap(filteredGraph.nodes, filteredGraph.edges),
    [filteredGraph.nodes, filteredGraph.edges],
  )
  const hiddenCount = nodes.length - filteredGraph.nodes.length
  const modePreset = GRAPH_MODE_PRESETS[graphMode]

  useEffect(() => {
    setGraphStats({
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hiddenCount,
      filteredNodeCount: filteredGraph.nodes.length,
      filteredEdgeCount: filteredGraph.edges.length,
    })
  }, [nodes.length, edges.length, hiddenCount, filteredGraph.nodes.length, filteredGraph.edges.length, setGraphStats])
  const modeControlsStructural = modePreset.hideStructural
  const modeControlsIsolated = modePreset.hideIsolated
  const contextNode = nodeMenu ? nodes.find((node) => node.id === nodeMenu.nodeId) : null

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">{t("graph.openProject")}</p>
        <Button variant="outline" size="sm" onClick={() => void openProjectFromGraph()}>打开项目</Button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <RefreshCw className="h-8 w-8 animate-spin opacity-50" />
        <p className="text-sm">{t("graph.buildingGraph")}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={loadGraph}>{t("graph.retry")}</Button>
      </div>
    )
  }

  if (!loading && nodes.length === 0 && !error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">{t("graph.noPages")}</p>
        <p className="text-xs">{t(novelMode ? "novel.graph.importSourcesHint" : "graph.importSourcesHint")}</p>
        <Button variant="outline" size="sm" onClick={() => setActiveView("sources")}>去导入资料</Button>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Graph canvas + Insights side panel */}
      <div className="flex flex-1 min-h-0">
        {/* Graph canvas */}
        <div
          ref={graphContainerRef}
          className="relative flex-1 min-w-0 overflow-hidden bg-background"
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => setNodeMenu(null)}
        >
          {displayMode === "document" ? (
            <DocumentGraphView
              nodes={filteredGraph.nodes}
              edges={filteredGraph.edges}
              editingNode={editingNode}
              editingPath={editingPath}
              editingContent={editingContent}
              editStatus={editStatus}
              savingNode={savingNode}
              onEditNode={handleEditNode}
              onChangeEditingContent={setEditingContent}
              onSaveNodeEdit={() => void handleSaveNodeEdit()}
              onCancelNodeEdit={handleCancelNodeEdit}
            />
          ) : displayMode === "mindmap" ? (
            <MindMapGraphView mindMap={graphMindMap} />
          ) : isResizing ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("graph.resizing")}
            </div>
          ) : (
            <ErrorBoundary>
              <SigmaContainer
                key={`${sigmaKey}-${edgeStyle}`}
                style={{ width: "100%", height: "100%", background: "transparent" }}
                settings={{
                  renderEdgeLabels: true,
                  defaultEdgeColor: edgeColorHex,
                  defaultEdgeType: edgeTypeForStyle(edgeStyle),
                  edgeProgramClasses: {
                    line: EdgeLineProgram,
                    clamped: EdgeClampedProgram,
                    curve: EdgeCurveProgram,
                    arrow: EdgeArrowProgram,
                  },
                  defaultNodeColor: "#94a3b8",
                  labelSize: 13,
                  labelWeight: "bold",
                  labelColor: { color: "#1e293b" },
                  edgeLabelSize: 14,
                  edgeLabelWeight: "600",
                  edgeLabelColor: { color: "#334155" },
                  labelDensity: labelDisplayMode === "all" ? 1 : labelDisplayMode === "focused" ? 0.25 : 0.4,
                  labelRenderedSizeThreshold: labelDisplayMode === "all" ? 0 : labelDisplayMode === "focused" ? 8 : 6,
                  stagePadding: 30,
                  nodeReducer: (_node, attrs) => {
                    const result = { ...attrs }
                    if (attrs.insightHighlight) {
                      result.size = (attrs.size ?? visualSettings.baseNodeSize) * 1.5
                      result.zIndex = 10
                      result.forceLabel = true
                    }
                    if (attrs.hovering) {
                      result.size = (attrs.size ?? visualSettings.baseNodeSize) * 1.4
                      result.zIndex = 10
                      result.forceLabel = true
                    }
                    if (attrs.dragging) {
                      result.size = (attrs.size ?? visualSettings.baseNodeSize) * 1.35
                      result.zIndex = 12
                      result.forceLabel = true
                    }
                    if (attrs.dimmed) {
                      result.color = mixColor(attrs.color ?? "#94a3b8", "#e2e8f0", 0.75)
                      result.label = ""
                      result.size = (attrs.size ?? visualSettings.baseNodeSize) * 0.6
                    }
                    return result
                  },
                  edgeReducer: (edge, attrs) => {
                    const result = { ...attrs }
                    if (attrs.dimmed) {
                      result.color = mixColor(edgeColorHex, "#e2e8f0", 0.75)
                      result.size = 0.3
                    }
                    if (attrs.highlighted) {
                      result.color = "#1e293b"
                      result.size = Math.max(2, (attrs.size ?? 1) * 1.5)
                      // 显示关系描述而非相关度数字
                      const relation = attrs.relation as string | undefined
                      if (relation) {
                        const relationLabel = NOVEL_RELATION_LABELS[relation as keyof typeof NOVEL_RELATION_LABELS] ?? relation
                        result.label = relationLabel
                      } else {
                        // 从 edge key (source->target) 提取节点名显示关系
                        const parts = edge.split("->")
                        if (parts.length === 2) {
                          result.label = `${parts[0]} \u2194 ${parts[1]}`
                        }
                      }
                      result.forceLabel = true
                    }
                    return result
                  },
                }}
              >
                <GraphLoader
                  nodes={filteredGraph.nodes}
                  edges={filteredGraph.edges}
                  colorMode={colorMode}
                  novelMode={novelMode}
                  graphMode={graphMode}
                  labelDisplayMode={labelDisplayMode}
                  edgeColorHex={edgeColorHex}
                  edgeStrengthPercent={edgeStrengthPercent}
                  edgeLabelsAlwaysVisible={edgeLabelsAlwaysVisible}
                  visualSettings={visualSettings}
                  foreshadowingStatusMap={foreshadowingStatusMap}
                />
                <EventHandler onNodeClick={handleNodeClick} onNodeContextMenu={handleNodeContextMenu} />
                <HighlightManager highlightedNodes={highlightedNodes} />
                <ZoomControls />
              </SigmaContainer>
            </ErrorBoundary>
          )}

          {showFilters && (
            <div className="absolute top-3 left-3 w-72 rounded-lg border bg-background/95 p-3 text-xs shadow-lg backdrop-blur-sm">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Filter className="h-3.5 w-3.5 shrink-0" />
                  {t("graph.graphFilters")}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[0.625rem]"
                  onClick={resetFilters}
                >
                  {t("graph.reset")}
                </Button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.quickFilters")}</div>
                  {/* v8 ignore start */}
                  <label className={`flex items-center gap-2 ${modeControlsStructural ? "opacity-50 cursor-not-allowed" : ""}`}>
                    <input
                      type="checkbox"
                      checked={effectiveFilters.hideStructural}
                      disabled={modeControlsStructural}
                      onChange={(e) => setFilters((prev) => ({ ...prev, hideStructural: e.target.checked }))}
                    />
                    <span>{t("graph.hideIndexOverview")}</span>
                    {modeControlsStructural && (
                      <span className="text-[0.625rem] text-muted-foreground">
                        ({t("novel.graph.modeControlHint", {
                          mode: t(`novel.graph.modeLabels.${graphMode}`, { defaultValue: GRAPH_MODE_LABELS[graphMode] }),
                        })})
                      </span>
                    )}
                  </label>
                  {/* v8 ignore stop */}
                  {/* v8 ignore start */}
                  <label className={`flex items-center gap-2 ${modeControlsIsolated ? "opacity-50 cursor-not-allowed" : ""}`}>
                    <input
                      type="checkbox"
                      checked={effectiveFilters.hideIsolated}
                      disabled={modeControlsIsolated}
                      onChange={(e) => setFilters((prev) => ({ ...prev, hideIsolated: e.target.checked }))}
                    />
                    <span>{t("graph.hideIsolated")}</span>
                    {modeControlsIsolated && (
                      <span className="text-[0.625rem] text-muted-foreground">
                        ({t("novel.graph.modeControlHint", {
                          mode: t(`novel.graph.modeLabels.${graphMode}`, { defaultValue: GRAPH_MODE_LABELS[graphMode] }),
                        })})
                      </span>
                    )}
                  </label>
                  {/* v8 ignore stop */}
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.maxLinks")}</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      className="h-7 w-20 rounded border bg-background px-2 text-xs"
                      value={filters.maxLinks ?? ""}
                      onChange={(e) => {
                        const raw = e.target.value.trim()
                        const value = Number(raw)
                        setFilters((prev) => ({
                          ...prev,
                          maxLinks: raw === "" || !Number.isFinite(value) ? undefined : Math.max(0, value),
                        }))
                      }}
                      placeholder={t("graph.allPlaceholder")}
                    />
                    <span className="text-muted-foreground">{t("graph.maxLinksHint")}</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.nodeTypes")}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {Object.entries(nodeTypeLabels)
                      .filter(([type]) => (typeCounts[type] ?? 0) > 0)
                      .map(([type, label]) => (
                        <label key={type} className="flex min-w-0 items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="shrink-0"
                            checked={!filters.hiddenTypes.has(type)}
                            onChange={(e) => {
                              setFilters((prev) => {
                                const next = new Set(prev.hiddenTypes)
                                if (e.target.checked) next.delete(type)
                                else next.add(type)
                                return { ...prev, hiddenTypes: next }
                              })
                            }}
                          />
                          <span className="truncate min-w-0">{label}</span>
                          <span className="text-muted-foreground/60 shrink-0 ml-auto">{typeCounts[type]}</span>
                        </label>
                      ))}
                  </div>
                </div>

                {filters.hiddenNodeIds.size > 0 && (
                  <div className="space-y-1.5">
                    <div className="font-medium text-muted-foreground">{t("graph.hiddenNodes")}</div>
                    <div className="max-h-24 space-y-1 overflow-y-auto">
                      {[...filters.hiddenNodeIds].map((nodeId) => {
                        const node = nodes.find((n) => n.id === nodeId)
                        return (
                          <div key={nodeId} className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 min-w-0">
                            <span className="truncate min-w-0">{node?.label ?? nodeId}</span>
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground shrink-0"
                              onClick={() => setFilters((prev) => {
                                const next = new Set(prev.hiddenNodeIds)
                                next.delete(nodeId)
                                return { ...prev, hiddenNodeIds: next }
                              })}
                            >
                              {t("graph.show")}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="rounded bg-muted/50 px-2 py-1.5 text-muted-foreground">
                  {t("graph.showingStats", { pages: filteredGraph.nodes.length, total: nodes.length, links: filteredGraph.edges.length, totalLinks: edges.length })}
                </div>
              </div>
            </div>
          )}

          {nodeMenu && contextNode && (
            <div
              className="absolute z-20 w-56 rounded-md border bg-background py-1 text-xs shadow-lg"
              style={{ left: nodeMenu.x, top: nodeMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="border-b px-3 py-2 min-w-0">
                <div className="truncate font-medium text-foreground min-w-0">{contextNode.label}</div>
                <div className="text-muted-foreground">{t("graph.contextNodeLinks", { count: contextNode.linkCount })}</div>
                {novelMode && NOVEL_NODE_TYPE_LABELS[contextNode.type as keyof typeof NOVEL_NODE_TYPE_LABELS] && (() => {
                  /* v8 ignore next -- novelMode 下 type 恒在 NOVEL_NODE_TYPE_LABELS → 恒有颜色 */
                  const typeColor = NODE_TYPE_COLORS[contextNode.type] ?? "#94a3b8"
                  return (
                    <span
                      className="mt-1 inline-block rounded px-1.5 py-0.5 text-[0.625rem] font-medium"
                      style={{
                        backgroundColor: hexToRgba(typeColor, 0.15),
                        color: typeColor,
                      }}
                    >
                      {NOVEL_NODE_TYPE_LABELS[contextNode.type as keyof typeof NOVEL_NODE_TYPE_LABELS]}
                    </span>
                  )
                })()}
              </div>
              {novelMode && (() => {
                const nodeEdges = edges.filter(
                  (e) => e.source === contextNode.id || e.target === contextNode.id,
                )
                if (nodeEdges.length === 0) return null
                return (
                  <div className="border-b px-3 py-2 max-h-32 overflow-y-auto">
                    <div className="text-muted-foreground mb-1">{t("novel.graph.relations")}</div>
                    {nodeEdges.slice(0, 8).map((edge, i) => {
                      const isSource = edge.source === contextNode.id
                      const otherId = isSource ? edge.target : edge.source
                      const otherNode = nodes.find((n) => n.id === otherId)
                      return (
                        <div key={i} className="text-muted-foreground/80 truncate min-w-0">
                          {isSource ? "→" : "←"} {otherNode?.label ?? otherId}
                        </div>
                      )
                    })}
                    {nodeEdges.length > 8 && (
                      <div className="text-muted-foreground/60">+{nodeEdges.length - 8}</div>
                    )}
                  </div>
                )
              })()}
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                onClick={() => void handleOpenNodeProfilePage(contextNode)}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                {t("graph.editRealProfilePage")}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                onClick={() => {
                  setFilters((prev) => ({
                    ...prev,
                    hiddenNodeIds: new Set([...prev.hiddenNodeIds, contextNode.id]),
                  }))
                  setNodeMenu(null)
                }}
              >
                <EyeOff className="h-3.5 w-3.5 shrink-0" />
                {t("graph.hideThisNode")}
              </button>
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 backdrop-blur-sm px-3 py-2 text-xs shadow-sm max-w-[260px]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-foreground">
                {colorMode === "type" ? t("graph.nodeTypesLabel") : t("graph.communitiesLabel")}
              </span>
              <div className="flex items-center gap-1">
                {colorMode === "type" && filters.hiddenTypes.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[0.625rem] px-1"
                    onClick={() => setFilters((prev) => ({ ...prev, hiddenTypes: new Set() }))}
                    title={t("graph.showAllTypes")}
                  >
                    {t("graph.showAll")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setLegendCollapsed(!legendCollapsed)}
                  title={legendCollapsed ? t("graph.expandLegend") : t("graph.collapseLegend")}
                >
                  {legendCollapsed ? "▶" : "▼"}
                </Button>
              </div>
            </div>
            {!legendCollapsed && (
              colorMode === "type" ? (
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
                  <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
                    {novelMode
                      ? (() => {
                          const novelTypes = ["character", "location", "organization", "item", "event", "chapter", "outline", "foreshadowing", "secret", "conflict", "timeline-point", "canon-rule"]
                          const baseTypes = ["entity", "concept", "source", "query", "synthesis", "overview", "comparison", "other"]
                          const renderTypeItem = (type: string, label: string) => {
                            const isHidden = filters.hiddenTypes.has(type)
                            /* v8 ignore next -- novelTypes/baseTypes 恒在 NODE_TYPE_COLORS */
                            const shadowColor = NODE_TYPE_COLORS[type] ?? "#94a3b8"
                            return (
                              <div
                                key={type}
                                className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50 ${isHidden ? "opacity-40" : ""}`}
                                onMouseEnter={() => setHoveredType(type)}
                                onMouseLeave={() => setHoveredType(null)}
                                onDoubleClick={() => {
                                  setFilters((prev) => {
                                    const next = new Set(prev.hiddenTypes)
                                    if (next.has(type)) {
                                      next.delete(type)
                                    } else {
                                      next.add(type)
                                    }
                                    return { ...prev, hiddenTypes: next }
                                  })
                                }}
                                title={t("graph.doubleClickToggleVisibility")}
                              >
                                <span
                                  className="inline-block h-3 w-3 rounded-full shrink-0 shadow-sm"
                                  style={{
                                    backgroundColor: isHidden ? "#94a3b8" : NODE_TYPE_COLORS[type],
                                    boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : shadowColor, 0.4)}`,
                                  }}
                                />
                                <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                                  {label}
                                </span>
                                <span className="text-muted-foreground/60 ml-auto">{typeCounts[type]}</span>
                                {isHidden && <span className="text-muted-foreground/60 text-[0.625rem]">{t("graph.hidden")}</span>}
                              </div>
                            )
                          }
                          return (
                            <>
                              {novelTypes.some((t) => (typeCounts[t] ?? 0) > 0) && (
                                <>
                                  <div className="text-muted-foreground/70 text-[0.625rem] font-semibold px-1 pt-1 border-t border-border/50 mt-0.5">
                                    {t("novel.graph.novelNodeTypes")}
                                  </div>
                                  {/* v8 ignore start */}
                                  {novelTypes.filter((t) => (typeCounts[t] ?? 0) > 0).map((type) =>
                                    renderTypeItem(type, nodeTypeLabels[type] ?? type)
                                  )}
                                  {/* v8 ignore stop */}
                                </>
                              )}
                              {baseTypes.some((t) => (typeCounts[t] ?? 0) > 0) && (
                                <>
                                  <div className="text-muted-foreground/70 text-[0.625rem] font-semibold px-1 pt-1 border-t border-border/50 mt-0.5">
                                    {t("novel.graph.baseNodeTypes")}
                                  </div>
                                  {/* v8 ignore start */}
                                  {baseTypes.filter((t) => (typeCounts[t] ?? 0) > 0).map((type) =>
                                    renderTypeItem(type, nodeTypeLabels[type] ?? type)
                                  )}
                                  {/* v8 ignore stop */}
                                </>
                              )}
                            </>
                          )
                        })()
                      : Object.entries(nodeTypeLabels)
                          .filter(([type]) => (typeCounts[type] ?? 0) > 0)
                          .map(([type, label]) => {
                            const isHidden = filters.hiddenTypes.has(type)
                            /* v8 ignore next -- nodeTypeLabels 固定映射，type 恒在 NODE_TYPE_COLORS */
                            const shadowColor = NODE_TYPE_COLORS[type] ?? "#94a3b8"
                            return (
                              <div
                                key={type}
                                className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50 ${isHidden ? "opacity-40" : ""}`}
                                onMouseEnter={() => setHoveredType(type)}
                                onMouseLeave={() => setHoveredType(null)}
                                onDoubleClick={() => {
                                  setFilters((prev) => {
                                    const next = new Set(prev.hiddenTypes)
                                    if (next.has(type)) {
                                      next.delete(type)
                                    } else {
                                      next.add(type)
                                    }
                                    return { ...prev, hiddenTypes: next }
                                  })
                                }}
                                title={t("graph.doubleClickToggleVisibility")}
                              >
                                <span
                                  className="inline-block h-3 w-3 rounded-full shrink-0 shadow-sm"
                                  style={{
                                    backgroundColor: isHidden ? "#94a3b8" : NODE_TYPE_COLORS[type],
                                    boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : shadowColor, 0.4)}`,
                                  }}
                                />
                                <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                                  {label}
                                </span>
                                <span className="text-muted-foreground/60 ml-auto">{typeCounts[type]}</span>
                                {isHidden && <span className="text-muted-foreground/60 text-[0.625rem]">{t("graph.hidden")}</span>}
                              </div>
                            )
                          })}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
                  <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
                    {communities.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50"
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-full shrink-0 shadow-sm"
                        style={{
                          backgroundColor: COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length],
                          boxShadow: `0 0 4px ${hexToRgba(COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length], 0.4)}`,
                        }}
                      />
                      <span className="text-muted-foreground truncate min-w-0" title={c.topNodes.join(", ")}>
                        {c.topNodes[0] ?? `${t("graph.cluster", { id: c.id })}`}
                      </span>
                      <span className="text-muted-foreground/60 ml-auto shrink-0">{c.nodeCount}</span>
                      {c.cohesion < 0.15 && c.nodeCount >= 3 && (
                        <span className="text-warning shrink-0" title={t("graph.lowCohesion", { value: c.cohesion.toFixed(2) })}>!</span>
                      )}
                    </div>
                  ))}
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        {/* Insights Side Panel */}
        {/* v8 ignore start */}
        {showInsights && (
          <div className="w-80 shrink-0 border-l bg-background overflow-y-auto">
            <div className="px-4 py-3 border-b">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 shrink-0 text-warning" />
                  <span className="text-sm font-medium">{t("graph.insights")}</span>
                </div>
                <button
                  className="p-1 rounded hover:bg-muted text-muted-foreground"
                  onClick={() => {
                    setShowInsights(false)
                    setHighlightedNodes(new Set())
                  }}
                >
                  <X className="h-4 w-4 shrink-0" />
                </button>
              </div>
            </div>

            <div className="p-3 flex flex-col gap-4">
              {/* Surprising Connections */}
              {surprisingConns.filter((c) => !dismissedInsights.has(c.key)).length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-foreground">
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-info" />
                    {t("graph.surprisingConnections")}
                  </div>
                  <div className="flex flex-col gap-2">
                    {surprisingConns
                      .filter((conn) => !dismissedInsights.has(conn.key))
                      .map((conn, i) => {
                        const ids = new Set([conn.source.id, conn.target.id])
                        const isActive = highlightedNodes.size === ids.size &&
                          [...ids].every((id) => highlightedNodes.has(id))
                        return (
                          <div
                            key={i}
                            className={`relative rounded-lg border p-3 text-sm transition-colors ${isActive ? "bg-info/10 border-info/40" : "hover:bg-muted/50"}`}
                          >
                            <button
                              className="absolute top-1.5 right-1.5 z-10 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation()
                                setDismissedInsights((prev) => new Set([...prev, conn.key]))
                                /* v8 ignore next */
                                if (isActive) setHighlightedNodes(new Set())
                              }}
                            >
                              <X className="h-3.5 w-3.5 shrink-0" />
                            </button>
                            <button type="button"
                              className="cursor-pointer pr-6 text-left"
                              onClick={() => setHighlightedNodes(isActive ? new Set() : ids)}
                            >
                              <div className="font-medium text-foreground text-xs">
                                {conn.source.label} ↔ {conn.target.label}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {conn.reasons.join("，")}
                              </p>
                            </button>
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}

              {/* Knowledge Gaps */}
              {knowledgeGaps.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-foreground">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
                    {t("graph.knowledgeGaps")}
                  </div>
                  <div className="flex flex-col gap-2">
                    {knowledgeGaps.map((gap, i) => {
                      const ids = new Set(gap.nodeIds)
                      const isActive = highlightedNodes.size > 0 &&
                        [...ids].every((id) => highlightedNodes.has(id)) &&
                        [...highlightedNodes].every((id) => ids.has(id))
                      return (
                        <button type="button"
                          key={i}
                          className={`rounded-lg border p-3 text-sm cursor-pointer transition-colors ${isActive ? "bg-warning/10 border-warning/40" : "hover:bg-muted/50"}`}
                          onClick={() => setHighlightedNodes(isActive ? new Set() : ids)}
                        >
                          <div className="font-medium text-xs text-foreground mb-1">{gap.title}</div>
                          <p className="text-xs text-muted-foreground mb-2">{gap.description}</p>
                          <p className="text-xs text-muted-foreground/80 italic mb-2">{gap.suggestion}</p>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {/* v8 ignore stop */}
      </div>

    </div>
  )
}
