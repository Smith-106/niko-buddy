import { useEffect, useCallback, useMemo, useState, useRef } from "react"
import { SigmaContainer, useSetSettings } from "@react-sigma/core"
import type { Settings } from "sigma/settings"
import "@react-sigma/core/lib/style.css"
import {
  EdgeArrowProgram,
  EdgeClampedProgram,
  EdgeLineProgram,
} from "sigma/rendering"
import EdgeCurveProgram from "@sigma/edge-curve"
import { Network, Lightbulb, AlertTriangle, Link2, X, Filter, EyeOff, FileText, Crosshair, ArrowRight } from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFileAtomic, createDirectory, fileExists } from "@/commands/fs"
import { buildWikiGraph, dedupeImportEdges, type GraphNode, type GraphEdge, type CommunityInfo } from "@/lib/wiki-graph"
import { buildEditableGraphNodePage } from "@/lib/graph-node-page"
import { findSurprisingConnections, detectKnowledgeGaps, type SurprisingConnection, type KnowledgeGap } from "@/lib/graph-insights"
import { normalizePath } from "@/lib/path-utils"
import { applyGraphFilters, DEFAULT_GRAPH_FILTERS, type GraphFilterState } from "@/lib/graph-filters"
import { buildGraphMindMap } from "@/lib/graph-readable"
import { NOVEL_NODE_TYPE_LABELS, NOVEL_RELATION_LABELS, loadForeshadowingTracker } from "@/lib/novel"
import type { ForeshadowingStore } from "@/lib/novel"
import { DEFAULT_LAYOUT_PRESET, LAYOUT_PRESET_ORDER, getGraphVisualSettings, type GraphLayoutPresetKey } from "@/lib/graph-layout"
import { GRAPH_MODE_LABELS, GRAPH_MODE_PRESETS, type GraphMode } from "@/lib/graph-mode"
import { extractNeighborhood, pickDefaultFocus } from "@/lib/graph-neighborhood"
import { useTranslation } from "react-i18next"
import { formatOperationError } from "@/lib/format-operation-error"
import { NODE_TYPE_COLORS, edgeTypeForStyle, getSigmaThemeColors, hexToRgba, mixColor, shouldRenderEdgeLabels, type GraphEdgeStyle, type GraphLabelDisplayMode, type SigmaThemeColors } from "@/lib/graph-style"
import { toErrorMessage } from "@/lib/utils"
import { isSystemDark } from "@/lib/theme-utils"
import { COMMUNITY_COLORS, EventHandler, GraphLoader, HighlightManager, SigmaResizeRefresher, type ColorMode } from "./sigma-graph-views"
import { DocumentGraphView } from "./document-graph-view"
import { MindMapGraphView, ZoomControls } from "./mindmap-views"
import { toast } from "@/lib/toast"


type GraphDisplayMode = "graph" | "document" | "mindmap"

const GRAPH_LABEL_MODE_KEY = "lk-graph-label-display-mode"
const GRAPH_EDGE_COLOR_KEY = "lk-graph-edge-color"
const GRAPH_EDGE_STRENGTH_KEY = "lk-graph-edge-strength"
const GRAPH_EDGE_STYLE_KEY = "lk-graph-edge-style"
/** 焦点邻域模式自动开启的节点数阈值：小图保持全图，大图默认只看焦点邻域 */
const FOCUS_AUTO_THRESHOLD = 120

/** 章节号解析：支撑时间轴过滤（第12章/第12回/ch12/012-xxx.md），无编号返回 null。 */
export function parseChapterNumber(node: Pick<GraphNode, "label" | "path">): number | null {
  const text = `${node.label} ${node.path}`
  const cn = text.match(/第\s*(\d+)\s*[章节回话]/)
  if (cn) return Number(cn[1])
  const en = text.match(/(?:ch(?:apter)?|c)[-_ ]?(\d+)/i)
  if (en) return Number(en[1])
  const file = node.path.split(/[/\\]/).pop() ?? ""
  const num = file.match(/^(\d+)[-_ ]/)
  if (num) return Number(num[1])
  return null
}

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
    toast.error(`打开项目失败：${err}`)
  }
}










// --- Main component ---

/** S3-3: 主题切换时热推 sigma 文本色（setSetting，不重建实例，不丢相机/布局）。 */
function SigmaThemeSync({ colorsRef, isDark }: { colorsRef: { current: SigmaThemeColors }; isDark: boolean }) {
  const setSettings = useSetSettings()
  useEffect(() => {
    const colors = getSigmaThemeColors(isDark)
    colorsRef.current = colors
    setSettings({ labelColor: { color: colors.label }, edgeLabelColor: { color: colors.edgeLabel } })
  }, [isDark, colorsRef, setSettings])
  return null
}

export function GraphView() {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setPendingEditorHighlight = useWikiStore((s) => s.setPendingEditorHighlight)
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
  const appTheme = useWikiStore((s) => s.theme)
  // S3-3: 深色主题下 sigma 标签（#1e293b/#334155）沉底不可读。settings 身份必须稳定
  //（#39 教训：换身份即 kill+重建），故主题色走 ref + SigmaThemeSync 热推，不进 useMemo 依赖。
  const isDarkTheme = appTheme === "dark" || appTheme === "deep-blue" || (appTheme === "system" && isSystemDark())
  const themeColorsRef = useRef<SigmaThemeColors>(getSigmaThemeColors(isDarkTheme))
  const showFilters = useWikiStore((s) => s.graphShowFilters)
  const setGraphStats = useWikiStore((s) => s.setGraphStats)
  const setRefreshGraph = useWikiStore((s) => s.setRefreshGraph)
  const [showInsights, setShowInsights] = useState(false)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  // 第8块：孤立节点高亮开关（全图 linkCount<=1）：辅助发现未织入主线的废设定/断头伏笔。
  const [orphanHighlight, setOrphanHighlight] = useState(false)
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set())
  const [sigmaKey, setSigmaKey] = useState(0)
  const [legendCollapsed, setLegendCollapsed] = useState(false)
  const [filters, setFilters] = useState<GraphFilterState>(() => ({
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: new Set(),
    hiddenNodeIds: new Set(),
  }))
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [layoutPreset, setLayoutPreset] = useState<GraphLayoutPresetKey>(DEFAULT_LAYOUT_PRESET)
  const [focusDepth, setFocusDepth] = useState<1 | 2>(1)
  const [focusOverride, setFocusOverride] = useState<boolean | null>(null)
  // 章节时间轴：null = 不限（默认全量），数字 = 只看 <= N 章的章节节点与其关联边。
  const [maxChapter, setMaxChapter] = useState<number | null>(null)
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

  // A（单击探图聚焦 + 双击/按钮跳正文）：打开档案页并预写高亮锚点是共享的，
  // 只有双击/显式按钮才切 wiki 视图——单击留在图谱内（探图不被打断）。
  const openNodeFile = useCallback(
    async (node: GraphNode) => {
      const content = await readFile(node.path)
      setSelectedFile(node.path)
      setFileContent(content)
      // P2 高亮→原文定位：取正文首个 Markdown 标题（必命中内容自身），无标题回退节点 label；
      // 复用审查问题同款 pendingEditorHighlight 通道（WikiEditor 滚动+选中，未命中安全 no-op）。
      const heading = content.split("\n").map((line) => line.trim()).find((line) => line.startsWith("#"))
      const anchorText = (heading ? heading.replace(/^#+\s*/, "") : node.label).trim()
      if (anchorText) {
        setPendingEditorHighlight({ path: node.path, text: anchorText, nonce: Date.now() })
      }
    },
    [setSelectedFile, setFileContent, setPendingEditorHighlight],
  )

  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return
      // 焦点模式下点节点即把焦点切过去（同时照常打开档案页）
      setFocusNodeId(nodeId)
      try {
        await openNodeFile(node)
      } catch (err) {
        console.error("Failed to open wiki page:", err)
      }
    },
    [nodes, openNodeFile],
  )

  const handleNodeDoubleClick = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return
      setFocusNodeId(nodeId)
      try {
        await openNodeFile(node)
        setActiveView("wiki")
      } catch (err) {
        console.error("Failed to open wiki page:", err)
      }
    },
    [nodes, openNodeFile, setActiveView],
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

  // Sigma 自带容器尺寸自适应：面板开合 / 拖拽 resize 只需防抖 refresh（见 SigmaResizeRefresher），
  // 不再 remount，相机位姿与交互态完整保留。graphMode 切换仍 remount（过滤语义变化）。

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
  // 章节时间轴范围：从 chapter 类型节点解析编号；无章节节点时不展示滑块。
  const chapterRange = useMemo(() => {
    const nums = filteredGraph.nodes
      .filter((n) => n.type === "chapter")
      .map(parseChapterNumber)
      .filter((n): n is number => n !== null)
    if (nums.length === 0) return null
    return { min: Math.min(...nums), max: Math.max(...nums), current: maxChapter ?? Math.max(...nums) }
  }, [filteredGraph.nodes, maxChapter])
  // 时间轴过滤：仅隐藏超前章节节点与其关联边，其余类型保留（默认 null = 不限）。
  const timelineGraph = useMemo(() => {
    if (!chapterRange || maxChapter === null || maxChapter >= chapterRange.max) return filteredGraph
    const visibleIds = new Set(
      filteredGraph.nodes
        .filter((n) => {
          if (n.type !== "chapter") return true
          const num = parseChapterNumber(n)
          return num === null || num <= maxChapter
        })
        .map((n) => n.id),
    )
    return {
      ...filteredGraph,
      nodes: filteredGraph.nodes.filter((n) => visibleIds.has(n.id)),
      edges: filteredGraph.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    }
  }, [filteredGraph, chapterRange, maxChapter])
  // 焦点邻域模式：节点超阈值（>120）或长连载（章节节点 >=10）时默认 Ego，主角 1~2 跳；
  // 小图保持全图，避免打扰现有行为；点击任意节点可切换焦点。
  const chapterCount = useMemo(
    () => filteredGraph.nodes.filter((n) => n.type === "chapter").length,
    [filteredGraph.nodes],
  )
  const focusActive = focusOverride ?? (nodes.length > FOCUS_AUTO_THRESHOLD || chapterCount >= 10)
  const autoFocusNode = useMemo(() => pickDefaultFocus(timelineGraph.nodes), [timelineGraph.nodes])
  const effectiveFocusId = focusNodeId && timelineGraph.nodes.some((n) => n.id === focusNodeId)
    ? focusNodeId
    : autoFocusNode?.id ?? null
  const neighborhood = useMemo(() => {
    if (!focusActive || !effectiveFocusId || displayMode !== "graph") return null
    return extractNeighborhood(timelineGraph.nodes, timelineGraph.edges, {
      focusId: effectiveFocusId,
      depth: focusDepth,
    })
  }, [focusActive, effectiveFocusId, displayMode, timelineGraph.nodes, timelineGraph.edges, focusDepth])
  const displayNodes = neighborhood?.nodes ?? timelineGraph.nodes
  const displayEdges = neighborhood?.edges ?? timelineGraph.edges
  const focusNode = effectiveFocusId ? timelineGraph.nodes.find((n) => n.id === effectiveFocusId) ?? null : null
  const visualSettings = useMemo(() => getGraphVisualSettings(nodes.length), [nodes.length])
  // #39 根因A修复:settings 身份稳定 —— 内联字面量每 render 新身份会触发 react-sigma
  // isEqual 判异 → kill + 重建风暴;useMemo 限定仅视觉旋钮变化时才更新。
  const sigmaSettings = useMemo<Partial<Settings>>(
    () => ({
    // 默认关闭边标签降噪（毛线球根因），Hover/选中经 edgeReducer forceLabel 高亮关系名；
    // 用户在设置中显式开启 edgeLabelsAlwaysVisible 时才按 LOD 渲染。
    renderEdgeLabels: edgeLabelsAlwaysVisible && shouldRenderEdgeLabels(displayEdges.length, false),
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
    labelColor: { color: themeColorsRef.current.label },
    edgeLabelSize: 14,
    edgeLabelWeight: "600",
    edgeLabelColor: { color: themeColorsRef.current.edgeLabel },
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
        result.color = mixColor(attrs.color ?? "#94a3b8", themeColorsRef.current.dimMix, 0.75)
        result.label = ""
        result.size = (attrs.size ?? visualSettings.baseNodeSize) * 0.6
      }
      return result
    },
    edgeReducer: (edge, attrs) => {
      const result = { ...attrs }
      if (attrs.dimmed) {
        result.color = mixColor(edgeColorHex, themeColorsRef.current.dimMix, 0.75)
        result.size = 0.3
      }
      if (attrs.highlighted) {
        result.color = themeColorsRef.current.edgeHighlight
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
    }),
    [displayEdges.length, edgeColorHex, edgeStyle, edgeLabelsAlwaysVisible, labelDisplayMode, visualSettings],
  )

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
  // 第8块：孤立节点 id 集（展示层节点，全图 linkCount<=1；切换过滤时自动刷新）。
  const orphanNodeIds = useMemo(
    () => displayNodes.filter((n) => (n.linkCount ?? 0) <= 1).map((n) => n.id),
    [displayNodes],
  )
  useEffect(() => {
    if (!orphanHighlight) return
    setHighlightedNodes(new Set(orphanNodeIds))
  }, [orphanHighlight, orphanNodeIds])
  const modePreset = GRAPH_MODE_PRESETS[graphMode]

  // P0-2 边计数对齐：统计口径 = 实际渲染口径（展示层节点 + dedupeImportEdges 去重），
  // 与 GraphLoader 导入共用 helper，保证去重计数 == sigma 实际边数。
  const renderableEdgeCount = useMemo(
    () => dedupeImportEdges(new Set(displayNodes.map((n) => n.id)), displayEdges).length,
    [displayNodes, displayEdges],
  )
  useEffect(() => {
    setGraphStats({
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hiddenCount,
      filteredNodeCount: displayNodes.length,
      filteredEdgeCount: renderableEdgeCount,
    })
  }, [nodes.length, edges.length, hiddenCount, displayNodes.length, renderableEdgeCount, setGraphStats])
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
      <div
        className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground"
        data-testid="graph-loading-skeleton"
        aria-busy="true"
        aria-label={t("graph.buildingGraph")}
      >
        <div className="relative h-40 w-64" aria-hidden="true">
          <div className="absolute left-6 top-16 h-px w-14 rotate-12 animate-pulse bg-muted" />
          <div className="absolute left-24 top-10 h-px w-16 -rotate-12 animate-pulse bg-muted" />
          <div className="absolute left-24 top-24 h-px w-14 rotate-6 animate-pulse bg-muted" />
          <div className="absolute left-6 top-8 h-px w-12 rotate-45 animate-pulse bg-muted" />
          <div className="absolute left-4 top-20 h-5 w-5 animate-pulse rounded-full bg-muted" />
          <div className="absolute left-20 top-6 h-4 w-4 animate-pulse rounded-full bg-muted" />
          <div className="absolute left-40 top-14 h-6 w-6 animate-pulse rounded-full bg-muted" />
          <div className="absolute left-24 top-28 h-4 w-4 animate-pulse rounded-full bg-muted" />
          <div className="absolute left-44 top-28 h-3 w-3 animate-pulse rounded-full bg-muted" />
        </div>
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
          ) : (
            <ErrorBoundary>
              <SigmaContainer
                key={`${sigmaKey}-${edgeStyle}`}
                style={{ width: "100%", height: "100%", background: "transparent" }}
                settings={sigmaSettings}
              >
                <SigmaThemeSync colorsRef={themeColorsRef} isDark={isDarkTheme} />
                <GraphLoader
                  nodes={displayNodes}
                  edges={displayEdges}
                  layoutPreset={layoutPreset}
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
                <EventHandler onNodeClick={handleNodeClick} onNodeDoubleClick={handleNodeDoubleClick} onNodeContextMenu={handleNodeContextMenu} />
                <HighlightManager highlightedNodes={highlightedNodes} />
                <SigmaResizeRefresher />
                <ZoomControls />
              </SigmaContainer>
            </ErrorBoundary>
          )}

          {!loading && !error && nodes.length > 0 && displayMode === "graph" && (!focusActive || (neighborhood && focusNode)) && (
            <div className="absolute top-3 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border bg-background/95 py-1 pl-3 pr-1.5 text-xs elevation-3 backdrop-blur-sm">
              <Crosshair className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {!focusActive ? (
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setFocusOverride(true)}
                >
                  {t("graph.enableFocus", { defaultValue: "聚焦模式" })}
                </button>
              ) : neighborhood && focusNode ? (
                <>
                  <span className="max-w-40 truncate font-medium text-foreground" title={`${focusNode.label} · ${t("graph.focusHint", { defaultValue: "点击任意节点切换焦点" })}`}>
                    {t("graph.focus", { defaultValue: "焦点" })}：{focusNode.label}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {displayNodes.length}/{timelineGraph.nodes.length}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5">
                    {([1, 2] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        data-testid={`graph-focus-depth-${d}`}
                        className={`rounded-full px-2 py-0.5 ${focusDepth === d ? "bg-background font-medium text-foreground elevation-1" : "text-muted-foreground hover:text-foreground"}`}
                        onClick={() => setFocusDepth(d)}
                      >
                        {d === 1 ? t("graph.oneHop", { defaultValue: "1跳" }) : t("graph.twoHops", { defaultValue: "2跳" })}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-full px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setFocusOverride(false)}
                  >
                    {t("graph.showFullGraph", { defaultValue: "全图" })}
                  </button>
                </>
              ) : null}
            </div>
          )}

          {chapterRange && !loading && !error && nodes.length > 0 && displayMode === "graph" && (
            <div
              className="absolute top-12 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border bg-background/95 px-3 py-1 text-xs elevation-3 backdrop-blur-sm"
              data-testid="graph-chapter-timeline"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t("graph.chapterUpTo", { current: chapterRange.current, max: chapterRange.max, defaultValue: `看到第 ${chapterRange.current} 章 / 共 ${chapterRange.max} 章` })}
              </span>
              <input
                type="range"
                min={chapterRange.min}
                max={chapterRange.max}
                step={1}
                value={chapterRange.current}
                aria-label={t("graph.chapterTimeline", { defaultValue: "章节时间轴" })}
                data-testid="graph-chapter-timeline-slider"
                className="h-1 w-36 cursor-pointer accent-primary"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setMaxChapter(Number.isFinite(v) && v < chapterRange.max ? v : null)
                }}
              />
              {maxChapter !== null && (
                <button
                  type="button"
                  data-testid="graph-chapter-timeline-reset"
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setMaxChapter(null)}
                >
                  {t("graph.reset", { defaultValue: "重置" })}
                </button>
              )}
            </div>
          )}

          {showFilters && (
            <div className="absolute top-3 left-3 w-72 rounded-lg border bg-background/95 p-3 text-xs elevation-3 backdrop-blur-sm">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Filter className="h-3.5 w-3.5 shrink-0" />
                  {t("graph.graphFilters")}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs"
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
                      <span className="text-xs text-muted-foreground">
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
                      <span className="text-xs text-muted-foreground">
                        ({t("novel.graph.modeControlHint", {
                          mode: t(`novel.graph.modeLabels.${graphMode}`, { defaultValue: GRAPH_MODE_LABELS[graphMode] }),
                        })})
                      </span>
                    )}
                  </label>
                  {/* v8 ignore stop */}
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.layoutPreset.label", { defaultValue: "布局预设" })}</div>
                  <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5" role="group" aria-label={t("graph.layoutPreset.label", { defaultValue: "布局预设" })}>
                    {LAYOUT_PRESET_ORDER.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        data-testid={`layout-preset-${preset}`}
                        className={`flex-1 rounded-md px-2 py-1 ${layoutPreset === preset ? "bg-background font-medium text-foreground elevation-1" : "text-muted-foreground hover:text-foreground"}`}
                        aria-pressed={layoutPreset === preset}
                        onClick={() => setLayoutPreset(preset)}
                      >
                        {t(`graph.layoutPreset.${preset}`, { defaultValue: preset })}
                      </button>
                    ))}
                  </div>
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
                          <span className="text-muted-foreground shrink-0 ml-auto">{typeCounts[type]}</span>
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
                  {t("graph.showingStats", { pages: displayNodes.length, total: nodes.length, links: displayEdges.length, totalLinks: edges.length })}
                  {neighborhood && neighborhood.omittedEdgeCount > 0 && (
                    <span className="mt-0.5 block">{t("graph.focusOmitted", { count: neighborhood.omittedEdgeCount, defaultValue: `已收起弱连接 ${neighborhood.omittedEdgeCount} 条` })}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {nodeMenu && contextNode && (
            <div
              className="absolute z-20 w-56 rounded-md border bg-background py-1 text-xs elevation-3"
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
                      className="mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium"
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
                    {nodeEdges.slice(0, 8).map((edge) => {
                      const isSource = edge.source === contextNode.id
                      const otherId = isSource ? edge.target : edge.source
                      const otherNode = nodes.find((n) => n.id === otherId)
                      return (
                        <div key={`${edge.source}-${edge.target}`} className="text-muted-foreground truncate min-w-0">
                          {isSource ? "→" : "←"} {otherNode?.label ?? otherId}
                        </div>
                      )
                    })}
                    {nodeEdges.length > 8 && (
                      <div className="text-muted-foreground">+{nodeEdges.length - 8}</div>
                    )}
                  </div>
                )
              })()}
              <button
                type="button"
                data-testid="graph-jump-to-editor"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                title={t("graph.jumpToEditor", { defaultValue: "跳到正文" })}
                onClick={() => {
                  setNodeMenu(null)
                  void handleNodeDoubleClick(contextNode.id)
                }}
              >
                <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                {t("graph.jumpToEditor", { defaultValue: "跳到正文" })}
              </button>
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
                title={t("graph.setAsFocusHint", { defaultValue: "之后点击任意节点也会切换焦点" })}
                onClick={() => {
                  setFocusNodeId(contextNode.id)
                  setFocusOverride(true)
                  setNodeMenu(null)
                }}
              >
                <Crosshair className="h-3.5 w-3.5 shrink-0" />
                {t("graph.setAsFocus", { defaultValue: "设为焦点" })}
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
          <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 backdrop-blur-sm px-3 py-2 text-xs elevation-1 max-w-[260px]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-foreground">
                {colorMode === "type" ? t("graph.nodeTypesLabel") : t("graph.communitiesLabel")}
              </span>
              <div className="flex items-center gap-1">
                {displayMode === "graph" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-1"
                    data-testid="graph-orphan-filter-toggle"
                    aria-pressed={orphanHighlight}
                    title={t("graph.orphanHighlight")}
                    onClick={() => {
                      if (orphanHighlight) {
                        setOrphanHighlight(false)
                        setHighlightedNodes(new Set())
                      } else {
                        setOrphanHighlight(true)
                        setHighlightedNodes(new Set(orphanNodeIds))
                      }
                    }}
                  >
                    {t("graph.orphanHighlight")}{orphanHighlight ? ` (${orphanNodeIds.length})` : ""}
                  </Button>
                )}
                {colorMode === "type" && filters.hiddenTypes.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-1"
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
                                  className="inline-block h-3 w-3 rounded-full shrink-0 elevation-1"
                                  style={{
                                    backgroundColor: isHidden ? "#94a3b8" : NODE_TYPE_COLORS[type],
                                    boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : shadowColor, 0.4)}`,
                                  }}
                                />
                                <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                                  {label}
                                </span>
                                <span className="text-muted-foreground ml-auto">{typeCounts[type]}</span>
                                {isHidden && <span className="text-muted-foreground text-xs">{t("graph.hidden")}</span>}
                              </div>
                            )
                          }
                          return (
                            <>
                              {novelTypes.some((t) => (typeCounts[t] ?? 0) > 0) && (
                                <>
                                  <div className="text-muted-foreground text-xs font-semibold px-1 pt-1 border-t border-border/50 mt-0.5">
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
                                  <div className="text-muted-foreground text-xs font-semibold px-1 pt-1 border-t border-border/50 mt-0.5">
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
                                  className="inline-block h-3 w-3 rounded-full shrink-0 elevation-1"
                                  style={{
                                    backgroundColor: isHidden ? "#94a3b8" : NODE_TYPE_COLORS[type],
                                    boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : shadowColor, 0.4)}`,
                                  }}
                                />
                                <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                                  {label}
                                </span>
                                <span className="text-muted-foreground ml-auto">{typeCounts[type]}</span>
                                {isHidden && <span className="text-muted-foreground text-xs">{t("graph.hidden")}</span>}
                              </div>
                            )
                          })}
                  </div>
                </div>
              ) : (
                <div
                  data-testid="graph-community-legend"
                  className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
                  <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
                    {communities.map((c) => {
                    const memberIds = displayNodes.filter((n) => n.community === c.id).map((n) => n.id)
                    const memberSet = new Set(memberIds)
                    const isActive = memberSet.size > 0 && highlightedNodes.size === memberSet.size &&
                      [...memberSet].every((id) => highlightedNodes.has(id))
                    return (
                    <button
                      type="button"
                      key={c.id}
                      aria-pressed={isActive}
                      title={t("graph.focusCommunity")}
                      onClick={() => {
                        if (isActive) {
                          if (orphanHighlight) setOrphanHighlight(false)
                          setHighlightedNodes(new Set())
                        } else {
                          if (orphanHighlight) setOrphanHighlight(false)
                          setHighlightedNodes(memberSet)
                        }
                      }}
                      className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/50 ${isActive ? "bg-info/10" : ""}`}
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-full shrink-0 elevation-1"
                        style={{
                          backgroundColor: COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length],
                          boxShadow: `0 0 4px ${hexToRgba(COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length], 0.4)}`,
                        }}
                      />
                      <span className="text-muted-foreground truncate min-w-0" title={c.topNodes.join(", ")}>
                        {c.topNodes[0] ?? `${t("graph.cluster", { id: c.id })}`}
                      </span>
                      <span className="text-muted-foreground ml-auto shrink-0">{c.nodeCount}</span>
                      {c.cohesion < 0.15 && c.nodeCount >= 3 && (
                        <span className="text-warning shrink-0" role="img" aria-label={t("graph.lowCohesion", { value: c.cohesion.toFixed(2) })} title={t("graph.lowCohesion", { value: c.cohesion.toFixed(2) })}>!</span>
                      )}
                    </button>
                    )
                  })}
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
                  aria-label={t("graph.dismissInsight")}
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
                      .map((conn) => {
                        const ids = new Set([conn.source.id, conn.target.id])
                        const isActive = highlightedNodes.size === ids.size &&
                          [...ids].every((id) => highlightedNodes.has(id))
                        return (
                          <div
                            key={conn.key}
                            className={`relative rounded-lg border p-3 text-sm transition-colors ${isActive ? "bg-info/10 border-info/40" : "hover:bg-muted/50"}`}
                          >
                            <button
                              className="absolute top-1.5 right-1.5 z-10 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                              aria-label={t("graph.dismissInsight")}
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
                    {knowledgeGaps.map((gap) => {
                      const ids = new Set(gap.nodeIds)
                      const isActive = highlightedNodes.size > 0 &&
                        [...ids].every((id) => highlightedNodes.has(id)) &&
                        [...highlightedNodes].every((id) => ids.has(id))
                      return (
                        <button type="button"
                          key={gap.title}
                          className={`rounded-lg border p-3 text-sm cursor-pointer transition-colors ${isActive ? "bg-warning/10 border-warning/40" : "hover:bg-muted/50"}`}
                          onClick={() => setHighlightedNodes(isActive ? new Set() : ids)}
                        >
                          <div className="font-medium text-xs text-foreground mb-1">{gap.title}</div>
                          <p className="text-xs text-muted-foreground mb-2">{gap.description}</p>
                          <p className="text-xs text-muted-foreground italic mb-2">{gap.suggestion}</p>
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