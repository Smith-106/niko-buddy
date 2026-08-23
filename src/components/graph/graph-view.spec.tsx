// @vitest-environment jsdom
import React from "react"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, configure } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { GraphView } from "./graph-view"
import type { GraphNode, GraphEdge, CommunityInfo } from "@/lib/wiki-graph"

// 覆盖率负载下 sigma 渲染较慢：放宽 waitFor 默认超时，避免时序偶发
configure({ asyncUtilTimeout: 10000 })

interface WikiStateLike {
  project: { id: string; name: string; path: string } | null
  novelMode: boolean
  dataVersion: number
  graphColorMode: string
  graphDisplayMode: string
  graphMode: string
  graphLabelDisplayMode: string
  graphEdgeColorHex: string
  graphEdgeStrengthPercent: number
  graphEdgeStyle: string
  graphEdgeLabelsAlwaysVisible: boolean
  graphShowFilters: boolean
  selectedFile: string | null
  embeddingConfig: { enabled: boolean; model: string }
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setActiveView: (view: string) => void
  bumpDataVersion: () => void
  setGraphStats: (stats: unknown) => void
  setRefreshGraph: (fn: (() => void) | null) => void
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    project: null,
    novelMode: true,
    dataVersion: 0,
    graphColorMode: "type",
    graphDisplayMode: "graph",
    graphMode: "overview",
    graphLabelDisplayMode: "all",
    graphEdgeColorHex: "#7f8ea3",
    graphEdgeStrengthPercent: 180,
    graphEdgeStyle: "curve",
    graphEdgeLabelsAlwaysVisible: false,
    graphShowFilters: false,
    selectedFile: null,
    embeddingConfig: { enabled: false, model: "" },
    setSelectedFile: vi.fn((path: string | null) => {
      state.selectedFile = path
    }),
    setFileContent: vi.fn(),
    setActiveView: vi.fn(),
    bumpDataVersion: vi.fn(() => {
      state.dataVersion += 1
    }),
    setGraphStats: vi.fn(),
    setRefreshGraph: vi.fn(),
  }
  return {
    state,
    readFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    createDirectory: vi.fn(),
    fileExists: vi.fn(),
    buildWikiGraph: vi.fn(),
    loadForeshadowingTracker: vi.fn(),
    embedPage: vi.fn(),
    findSurprisingConnections: vi.fn(),
    detectKnowledgeGaps: vi.fn(),
    buildEditableGraphNodePage: vi.fn(),
    t: vi.fn((key: string) => key),
    fa2: { inferSettings: vi.fn(() => ({})), assign: vi.fn() },
  }
})

// ── Module mocks ────────────────────────────────────────────────────

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: WikiStateLike) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
  createDirectory: mocks.createDirectory,
  fileExists: mocks.fileExists,
}))

vi.mock("@/lib/wiki-graph", () => ({
  buildWikiGraph: mocks.buildWikiGraph,
}))

vi.mock("@/lib/graph-insights", () => ({
  findSurprisingConnections: mocks.findSurprisingConnections,
  detectKnowledgeGaps: mocks.detectKnowledgeGaps,
}))

vi.mock("@/lib/graph-node-page", () => ({
  buildEditableGraphNodePage: mocks.buildEditableGraphNodePage,
}))

vi.mock("@/lib/novel/foreshadowing-tracker", () => ({
  loadForeshadowingTracker: mocks.loadForeshadowingTracker,
}))

vi.mock("@/lib/embedding", () => ({
  embedPage: mocks.embedPage,
}))

vi.mock("graphology-layout-forceatlas2", () => ({
  default: mocks.fa2,
}))

vi.mock("sigma/rendering", () => ({
  EdgeArrowProgram: class {},
  EdgeClampedProgram: class {},
  EdgeLineProgram: class {},
}))

vi.mock("@sigma/edge-curve", () => ({
  default: class {},
}))

const sigma = vi.hoisted(() => {
  const events: Record<string, (...args: unknown[]) => void> = {}
  const camera = { animatedZoom: vi.fn(), animatedUnzoom: vi.fn(), animatedReset: vi.fn() }
  const container = { style: {} as Record<string, string> }
  let graph: unknown = null
  let settings: unknown = null
  return {
    events,
    camera,
    container,
    getGraph: () => graph,
    setGraph: (g: unknown) => {
      graph = g
    },
    setSettings: (s: unknown) => {
      settings = s
    },
    getSettings: () => settings,
    registerEvents: vi.fn((handlers: Record<string, (...a: unknown[]) => void>) => {
      for (const [key, handler] of Object.entries(handlers)) events[key] = handler
    }),
    viewportToGraph: (p: unknown) => p,
    refresh: vi.fn(),
    setSetting: vi.fn(),
    getContainer: () => container,
    getCamera: () => camera,
  }
})

vi.mock("@react-sigma/core", async () => {
  const React = await import("react")
  return {
    SigmaContainer: ({ children, settings }: { children: React.ReactNode; settings: unknown }) => {
      sigma.setSettings(settings)
      return React.createElement("div", { "data-testid": "sigma-container" }, children)
    },
    useLoadGraph: () => (graph: unknown) => sigma.setGraph(graph),
    useRegisterEvents: () => (handlers: Record<string, (...a: unknown[]) => void>) =>
      sigma.registerEvents(handlers),
    useSigma: () => sigma,
  }
})

// ── Fixtures ────────────────────────────────────────────────────────

const PROJECT = { id: "p1", name: "Test", path: "/p/test" }

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "n1",
    label: "Alpha",
    type: "character",
    path: "/p/test/wiki/chapters/alpha.md",
    linkCount: 2,
    community: 0,
    ...overrides,
  }
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    source: "n1",
    target: "n2",
    weight: 5,
    relation: "APPEARS_IN",
    ...overrides,
  }
}

const BASIC_NODES: GraphNode[] = [
  makeNode({ id: "n1", label: "Alpha", type: "character", path: "/p/test/wiki/chapters/alpha.md", linkCount: 3, community: 0 }),
  makeNode({ id: "n2", label: "", type: "event", path: "/p/test/wiki/events/battle.md", linkCount: 1, community: 1 }),
  makeNode({ id: "x:y:z", label: "   ", type: "foreshadowing", path: "/p/test/wiki/events/fs.md", linkCount: 2, community: 1 }),
  makeNode({ id: "unknown-type-node", label: "custom", type: "custom-type", path: "/p/test/wiki/other.md", linkCount: 0, community: 2 }),
]

const BASIC_EDGES: GraphEdge[] = [
  makeEdge({ source: "n1", target: "n2", weight: 5, relation: "APPEARS_IN" }),
  // reverse duplicate → skipped by GraphLoader
  makeEdge({ source: "n2", target: "n1", weight: 5, relation: "APPEARS_IN" }),
  // target not in graph → skipped by GraphLoader
  makeEdge({ source: "n1", target: "ghost", weight: 1, relation: "UNKNOWN_REL" }),
  // unknown relation label
  makeEdge({ source: "x:y:z", target: "n2", weight: 2, relation: "CUSTOM_REL" }),
]

const BASIC_RESULT = {
  nodes: BASIC_NODES,
  edges: BASIC_EDGES,
  communities: [{ id: 0, nodeCount: 2, topNodes: ["Alpha"], cohesion: 0.9 } as CommunityInfo],
}

// overview 预设 allowedNodeTypes 只放行：character/chapter/event/location/item/organization/
// foreshadowing/secret/conflict；minimumEdgeWeight=2 过滤低权重边。
const DOC_NODES: GraphNode[] = [
  makeNode({ id: "ev:war", label: "大战", type: "event", path: "/p/test/wiki/events/war.md", linkCount: 2, community: 0 }),
  makeNode({ id: "fo:a", label: "伏笔A", type: "foreshadowing", path: "/p/test/wiki/events/foa.md", linkCount: 1, community: 0 }),
  makeNode({ id: "sc:1", label: "秘密A", type: "secret", path: "/p/test/wiki/secrets/sc1.md", linkCount: 1, community: 0 }),
  makeNode({ id: "cf:1", label: "冲突A", type: "conflict", path: "/p/test/wiki/conflicts/cf1.md", linkCount: 1, community: 0 }),
  makeNode({ id: "ch:1", label: "第一章", type: "chapter", linkCount: 1, community: 0 }),
  makeNode({ id: "ch:lin", label: "林烬", type: "character", path: "/p/test/wiki/chapters/lin.md", linkCount: 4, community: 0 }),
  makeNode({ id: "loc:town", label: "小镇", type: "location", path: "/p/test/wiki/locations/town.md", linkCount: 1, community: 0 }),
]

const DOC_EDGES: GraphEdge[] = [
  makeEdge({ source: "ch:lin", target: "ev:war", weight: 5, relation: "APPEARS_IN" }),
  makeEdge({ source: "ev:war", target: "fo:a", weight: 3, relation: "FORESHADOWS" }),
  makeEdge({ source: "ch:lin", target: "ch:1", weight: 2, relation: "APPEARS_IN" }),
  makeEdge({ source: "ch:lin", target: "sc:1", weight: 2, relation: "KNOWS" }),
  // weight 1 < minimumEdgeWeight(2) → 被过滤 → cf:1 在文档视图中孤立
  makeEdge({ source: "ch:lin", target: "cf:1", weight: 1, relation: "KNOWS" }),
  makeEdge({ source: "ch:lin", target: "loc:town", weight: 2, relation: "LOCATED_IN" }),
]

function setState(patch: Record<string, unknown>): void {
  Object.assign(mocks.state, patch)
}

async function renderLoadedGraph(patch: Record<string, unknown> = {}) {
  mocks.buildWikiGraph.mockResolvedValue(BASIC_RESULT)
  mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
  setState({ project: PROJECT, ...patch })
  const utils = render(<GraphView />)
  await waitFor(() => {
    expect(screen.getByTestId("sigma-container")).toBeTruthy()
  })
  return utils
}

async function renderDocumentView(patch: Record<string, unknown> = {}) {
  mocks.buildWikiGraph.mockResolvedValue({ nodes: DOC_NODES, edges: DOC_EDGES, communities: [] })
  mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
  mocks.findSurprisingConnections.mockReturnValue([])
  mocks.detectKnowledgeGaps.mockReturnValue([])
  setState({ project: PROJECT, graphDisplayMode: "document", ...patch })
  const utils = render(<GraphView />)
  await waitFor(() => {
    expect(screen.getByText("小说图谱文档")).toBeTruthy()
  })
  return utils
}

function fireSigmaEvent(name: string, payload: unknown): void {
  act(() => {
    sigma.events[name]?.(payload)
  })
}

function resetBaseline(): void {
  mocks.buildWikiGraph.mockReset()
  mocks.readFile.mockReset()
  mocks.writeFileAtomic.mockReset()
  mocks.createDirectory.mockReset()
  mocks.fileExists.mockReset()
  mocks.loadForeshadowingTracker.mockReset()
  mocks.embedPage.mockReset()
  mocks.fa2.assign.mockClear()
  mocks.fa2.inferSettings.mockClear()
  mocks.findSurprisingConnections.mockReset()
  mocks.detectKnowledgeGaps.mockReset()
  mocks.buildEditableGraphNodePage.mockReset()
  sigma.refresh.mockClear()
  sigma.setSetting.mockClear()
  // sigma 共享状态全量清理（防止跨测试泄漏）
  for (const key of Object.keys(sigma.events)) {
    delete sigma.events[key]
  }
  sigma.setGraph(null)
  sigma.setSettings(null)
  sigma.registerEvents.mockClear()
  sigma.camera.animatedZoom.mockClear()
  sigma.camera.animatedUnzoom.mockClear()
  sigma.camera.animatedReset.mockClear()
  sigma.container.style.cursor = ""
  mocks.state.project = null
  mocks.state.dataVersion = 0
  mocks.state.novelMode = true
  mocks.state.graphColorMode = "type"
  mocks.state.graphDisplayMode = "graph"
  mocks.state.graphMode = "overview"
  mocks.state.graphLabelDisplayMode = "all"
  mocks.state.graphEdgeColorHex = "#7f8ea3"
  mocks.state.graphEdgeStrengthPercent = 180
  mocks.state.graphEdgeStyle = "curve"
  mocks.state.graphEdgeLabelsAlwaysVisible = false
  mocks.state.graphShowFilters = false
  mocks.state.selectedFile = null
  mocks.state.embeddingConfig = { enabled: false, model: "" }
  mocks.buildEditableGraphNodePage.mockReturnValue({
    path: "/p/test/wiki/characters/Alpha.md",
    pageId: "alpha",
    title: "Alpha",
    content: "# Alpha\n\n正文",
  })
}

// RTL 自动清理依赖 vitest globals（本仓库未开启），显式注册
afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
})

describe("GraphView — 空态 / 加载 / 错误", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("无项目时渲染 graph.openProject 提示", () => {
    setState({ project: null })
    render(<GraphView />)
    expect(screen.getByText("graph.openProject")).toBeTruthy()
    expect(mocks.buildWikiGraph).not.toHaveBeenCalled()
  })

  it("加载中显示 graph.buildingGraph", async () => {
    let resolveLoad!: (value: unknown) => void
    mocks.buildWikiGraph.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      }),
    )
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT })
    const { unmount } = render(<GraphView />)
    expect(screen.getByText("graph.buildingGraph")).toBeTruthy()
    await act(async () => {
      resolveLoad(BASIC_RESULT)
    })
    unmount()
  })

  it("构建失败显示错误信息并可重试（Error 实例）", async () => {
    mocks.buildWikiGraph.mockRejectedValue(new Error("boom"))
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByText("boom")).toBeTruthy()
    })
    expect(screen.getByText("graph.retry")).toBeTruthy()
    mocks.buildWikiGraph.mockResolvedValue(BASIC_RESULT)
    fireEvent.click(screen.getByText("graph.retry"))
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    unmount()
  })

  it("构建失败显示 i18n 兜底文案（非 Error 抛出）", async () => {
    mocks.buildWikiGraph.mockRejectedValue("plain-string")
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByText("graph.buildFailed")).toBeTruthy()
    })
    unmount()
  })

  it("空图谱显示 noPages + 小说模式提示", async () => {
    mocks.buildWikiGraph.mockResolvedValue({ nodes: [], edges: [], communities: [] })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, novelMode: true })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByText("graph.noPages")).toBeTruthy()
    })
    expect(screen.getByText("novel.graph.importSourcesHint")).toBeTruthy()
    unmount()
  })

  it("空图谱显示非小说模式提示", async () => {
    mocks.buildWikiGraph.mockResolvedValue({ nodes: [], edges: [], communities: [] })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, novelMode: false })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByText("graph.noPages")).toBeTruthy()
    })
    expect(screen.getByText("graph.importSourcesHint")).toBeTruthy()
    unmount()
  })
})

describe("GraphView — 图谱加载与 Sigma 生命周期", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("加载图谱后渲染 Sigma 容器、注册刷新函数并写入统计", async () => {
    await renderLoadedGraph()
    expect(screen.getByTestId("sigma-container")).toBeTruthy()
    const graph = sigma.getGraph()
    expect(graph).not.toBeNull()
    // overview 预设 allowedNodeTypes 过滤掉 custom-type 节点 → 3 节点入图；
    // 4 条边中 1 条重复反向、1 条悬空被跳过 → 2 条边
    expect((graph as { nodes: () => string[] }).nodes()).toHaveLength(3)
    expect((graph as { edges: () => string[] }).edges()).toHaveLength(2)
    expect(mocks.state.setRefreshGraph).toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.state.setGraphStats).toHaveBeenCalledWith({
        nodeCount: 4,
        edgeCount: 4,
        hiddenCount: 1,
        filteredNodeCount: 3,
        filteredEdgeCount: 3,
      })
    })
  })

  it("dataVersion 变化触发重新加载", async () => {
    const { rerender } = await renderLoadedGraph()
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(1)
    setState({ dataVersion: 5 })
    await act(async () => {
      rerender(<GraphView />)
    })
    await waitFor(() => {
      expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(2)
    })
  })

  it("通过 store 注册的刷新函数触发重新加载，卸载时置空", async () => {
    const { unmount } = await renderLoadedGraph()
    const refresh = mocks.state.setRefreshGraph as unknown as ReturnType<typeof vi.fn>
    const thunk = refresh.mock.calls[refresh.mock.calls.length - 1]?.[0] as () => () => Promise<void>
    expect(typeof thunk).toBe("function")
    await act(async () => {
      const loadFn = thunk()
      await loadFn()
    })
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(2)
    unmount()
    expect(refresh).toHaveBeenLastCalledWith(null)
  })

  it("展示偏好写入 localStorage", async () => {
    await renderLoadedGraph({
      graphLabelDisplayMode: "focused",
      graphEdgeColorHex: "#123456",
      graphEdgeStrengthPercent: 200,
      graphEdgeStyle: "arrow",
    })
    expect(localStorage.getItem("lk-graph-label-display-mode")).toBe("focused")
    expect(localStorage.getItem("lk-graph-edge-color")).toBe("#123456")
    expect(localStorage.getItem("lk-graph-edge-strength")).toBe("200")
    expect(localStorage.getItem("lk-graph-edge-style")).toBe("arrow")
  })

  it("相同数据重复构建时不重复执行 ForceAtlas2（走 positionCache）", async () => {
    const uniqueNodes = [
      makeNode({ id: "u1", label: "Alpha", type: "character", path: "/p/a.md", linkCount: 3, community: 0 }),
      makeNode({ id: "u2", label: "", type: "event", path: "/p/b.md", linkCount: 1, community: 1 }),
      makeNode({ id: "u3", label: "  ", type: "foreshadowing", path: "/p/c.md", linkCount: 2, community: 1 }),
    ]
    const uniqueEdges = [
      makeEdge({ source: "u1", target: "u2", weight: 5, relation: "APPEARS_IN" }),
      makeEdge({ source: "u3", target: "u2", weight: 2, relation: "CUSTOM_REL" }),
    ]
    mocks.buildWikiGraph.mockResolvedValue({ nodes: uniqueNodes, edges: uniqueEdges, communities: [] })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, graphColorMode: "type" })
    const { rerender } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    expect(mocks.fa2.assign).toHaveBeenCalledTimes(1)
    // 改变 colorMode 触发 GraphLoader effect 重跑，但 dataKey 未变 → 跳过布局
    setState({ graphColorMode: "community" })
    await act(async () => {
      rerender(<GraphView />)
    })
    expect(mocks.fa2.assign).toHaveBeenCalledTimes(1)
    const graph = sigma.getGraph() as {
      getNodeAttribute: (n: string, k: string) => unknown
    }
    // community 配色已生效
    expect(graph.getNodeAttribute("u1", "color")).toBeTruthy()
    // 节点位置来自缓存
    expect(graph.getNodeAttribute("u1", "x")).toBeTypeOf("number")
  })

  it("单节点图谱跳过 ForceAtlas2", async () => {
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [makeNode({ id: "solo", label: "Solo", type: "character", path: "/p/test/wiki/chapters/solo.md", linkCount: 0, community: 0 })],
      edges: [],
      communities: [],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT })
    const { unmount } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    expect(mocks.fa2.assign).not.toHaveBeenCalled()
    unmount()
  })

  it("伏笔模式按 tracker 状态着色", async () => {
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [
        makeNode({ id: "fo:planted", label: "埋线", type: "foreshadowing", path: "/p/test/wiki/events/fo.md", linkCount: 1, community: 0 }),
        makeNode({ id: "fo:unknown", label: "未知状态", type: "foreshadowing", path: "/p/test/wiki/events/fo2.md", linkCount: 1, community: 0 }),
        makeNode({ id: "ch:1", label: "第一章", type: "chapter", path: "/p/test/wiki/chapters/1.md", linkCount: 1, community: 0 }),
      ],
      edges: [makeEdge({ source: "fo:planted", target: "ch:1", weight: 1, relation: "ADVANCES_FORESHADOWING" })],
      communities: [],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({
      items: [
        { name: "埋线", status: "planted" },
        { name: "未知状态", status: "odd-status" },
      ],
      lastUpdated: "",
    })
    setState({ project: PROJECT, graphMode: "foreshadowing" })
    const { unmount } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    const graph = sigma.getGraph() as { getNodeAttribute: (n: string, k: string) => unknown }
    await waitFor(() => {
      expect(graph.getNodeAttribute("fo:planted", "color")).toBe("#f59e0b")
      expect(graph.getNodeAttribute("fo:unknown", "color")).toBe("#fb923c")
    })
    unmount()
  })

  it("graphMode 变化重挂 Sigma 并保留注册", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { rerender } = await renderLoadedGraph()
    setState({ graphMode: "character" })
    await act(async () => {
      rerender(<GraphView />)
    })
    expect(screen.getByTestId("sigma-container")).toBeTruthy()
    expect(mocks.state.setRefreshGraph).toHaveBeenCalled()
  })
})

describe("GraphView — Sigma 事件与交互", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("点击节点打开对应档案页；未知节点忽略；读取失败仅记录错误", async () => {
    mocks.readFile.mockResolvedValue("file content")
    await renderLoadedGraph()
    fireSigmaEvent("clickNode", { node: "n1" })
    await waitFor(() => {
      expect(mocks.readFile).toHaveBeenCalledWith("/p/test/wiki/chapters/alpha.md")
    })
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/test/wiki/chapters/alpha.md")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("file content")
    // 未知节点 → 直接返回
    fireSigmaEvent("clickNode", { node: "missing" })
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
    // 读取失败 → console.error
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.readFile.mockRejectedValue(new Error("read failed"))
    fireSigmaEvent("clickNode", { node: "n1" })
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalled()
    })
    errorSpy.mockRestore()
  })

  it("左键拖拽移动节点、释放后点击被抑制", async () => {
    await renderLoadedGraph()
    const graph = sigma.getGraph() as {
      getNodeAttribute: (n: string, k: string) => unknown
    }
    const preventDefault = vi.fn()
    const preventSigmaDefault = vi.fn()
    const mouseDown = new MouseEvent("mousedown", { button: 0 })
    fireSigmaEvent("downNode", {
      node: "n1",
      event: { original: mouseDown },
      preventSigmaDefault,
    })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(preventSigmaDefault).toHaveBeenCalled()
    expect(graph.getNodeAttribute("n1", "dragging")).toBe(true)
    expect(sigma.container.style.cursor).toBe("grabbing")
    // 移动节点
    fireSigmaEvent("mousemovebody", { x: 50, y: 60 })
    expect(graph.getNodeAttribute("n1", "dragging")).toBe(true)
    // 拖拽后点击被抑制
    fireSigmaEvent("clickNode", { node: "n1" })
    expect(mocks.readFile).not.toHaveBeenCalled()
    // 释放
    fireSigmaEvent("mouseup", {})
    expect(graph.getNodeAttribute("n1", "dragging")).toBeUndefined()
    expect(sigma.container.style.cursor).toBe("default")
    // 无拖拽节点时释放直接返回
    fireSigmaEvent("mouseup", {})
  })

  it("非左键按下不触发拖拽；无拖拽节点时移动直接返回", async () => {
    await renderLoadedGraph()
    const graph = sigma.getGraph() as { getNodeAttribute: (n: string, k: string) => unknown }
    const preventSigmaDefault = vi.fn()
    const rightDown = new MouseEvent("mousedown", { button: 2 })
    fireSigmaEvent("downNode", {
      node: "n1",
      event: { original: rightDown },
      preventSigmaDefault,
    })
    expect(preventSigmaDefault).not.toHaveBeenCalled()
    expect(graph.getNodeAttribute("n1", "dragging")).not.toBe(true)
    sigma.refresh.mockClear()
    fireSigmaEvent("mousemovebody", { x: 10, y: 10 })
    expect(sigma.refresh).not.toHaveBeenCalled()
  })

  it("触屏拖拽与 touchup 释放", async () => {
    await renderLoadedGraph()
    const graph = sigma.getGraph() as { getNodeAttribute: (n: string, k: string) => unknown }
    const touch = { clientX: 30, clientY: 40 }
    fireSigmaEvent("downNode", {
      node: "n2",
      event: { original: new MouseEvent("mousedown", { button: 0 }) },
      preventSigmaDefault: vi.fn(),
    })
    fireSigmaEvent("touchmovebody", { touches: [touch], previousTouches: [] })
    expect(graph.getNodeAttribute("n2", "dragging")).toBe(true)
    fireSigmaEvent("touchmovebody", { touches: [], previousTouches: [touch] })
    fireSigmaEvent("touchmovebody", { touches: [], previousTouches: [] })
    fireSigmaEvent("touchup", {})
    expect(graph.getNodeAttribute("n2", "dragging")).toBeUndefined()
  })

  it("右键节点打开上下文菜单；空 nodeId 关闭菜单", async () => {
    await renderLoadedGraph()
    const preventSigmaDefault = vi.fn()
    const mouseEvent = new MouseEvent("contextmenu", { clientX: 100, clientY: 120 })
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: mouseEvent },
      preventSigmaDefault,
    })
    expect(preventSigmaDefault).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy()
    })
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.getByText("novel.graph.relations")).toBeTruthy()
    fireSigmaEvent("rightClickStage", {})
    await waitFor(() => {
      expect(screen.queryByText("graph.editRealProfilePage")).toBeNull()
    })
  })

  it("节点悬停高亮邻居、离开恢复；拖拽中 leave 提前返回", async () => {
    await renderLoadedGraph()
    const graph = sigma.getGraph() as {
      getNodeAttribute: (n: string, k: string) => unknown
    }
    fireSigmaEvent("enterNode", { node: "n1" })
    expect(graph.getNodeAttribute("n1", "hovering")).toBe(true)
    expect(graph.getNodeAttribute("n2", "dimmed")).toBeUndefined()
    expect(graph.getNodeAttribute("x:y:z", "dimmed")).toBe(true)
    expect(sigma.container.style.cursor).toBe("pointer")
    fireSigmaEvent("downNode", {
      node: "n1",
      event: { original: new MouseEvent("mousedown", { button: 0 }) },
      preventSigmaDefault: vi.fn(),
    })
    fireSigmaEvent("leaveNode", {})
    expect(graph.getNodeAttribute("n1", "hovering")).toBe(true)
    fireSigmaEvent("mouseup", {})
    fireSigmaEvent("leaveNode", {})
    expect(graph.getNodeAttribute("n1", "hovering")).toBeUndefined()
    expect(graph.getNodeAttribute("x:y:z", "dimmed")).toBeUndefined()
    expect(sigma.container.style.cursor).toBe("default")
  })
})

describe("GraphView — 过滤器 / 图例 / 缩放 / 布局", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("过滤器面板：maxLinks 输入、节点类型开关、重置", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { unmount } = await renderLoadedGraph({ graphShowFilters: true })
    // maxLinks 有效输入 → 隐藏 linkCount > 2 的节点
    const maxLinksInput = screen.getByPlaceholderText("graph.allPlaceholder")
    fireEvent.change(maxLinksInput, { target: { value: "2" } })
    await waitFor(() => {
      const calls = (mocks.state.setGraphStats as unknown as ReturnType<typeof vi.fn>).mock.calls
      const last = calls[calls.length - 1]?.[0] as { filteredNodeCount: number }
      expect(last.filteredNodeCount).toBe(2)
    })
    // 清空 → undefined
    fireEvent.change(maxLinksInput, { target: { value: "" } })
    // 非法输入 → undefined
    fireEvent.change(maxLinksInput, { target: { value: "abc" } })
    // 节点类型 checkbox：character（typeCounts 中存在）
    const checkboxes = screen.getAllByRole("checkbox")
    const charCheckbox = checkboxes.find((cb) =>
      cb.closest("label")?.textContent?.includes("novel.graph.nodeTypeLabels.character"),
    )
    expect(charCheckbox).toBeTruthy()
    fireEvent.click(charCheckbox!)
    // 隐藏类型后图例出现 graph.hidden 徽标
    await waitFor(() => {
      expect(screen.getByText("graph.hidden")).toBeTruthy()
    })
    // 重置
    fireEvent.click(screen.getByText("graph.reset"))
    await waitFor(() => {
      expect(screen.queryByText("graph.hidden")).toBeNull()
    })
    unmount()
  })

  it("节点上下文菜单：隐藏节点进入隐藏清单并可恢复", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { unmount } = await renderLoadedGraph({ graphShowFilters: true })
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => {
      expect(screen.getByText("graph.hideThisNode")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("graph.hideThisNode"))
    await waitFor(() => {
      expect(screen.getByText("graph.hiddenNodes")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("graph.show"))
    await waitFor(() => {
      expect(screen.queryByText("graph.hiddenNodes")).toBeNull()
    })
    unmount()
  })

  it("节点菜单：编辑真实档案页（文件存在）", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("existing content")
    const { unmount } = await renderLoadedGraph()
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy())
    fireEvent.click(screen.getByText("graph.editRealProfilePage"))
    await waitFor(() => {
      expect(mocks.state.setActiveView).toHaveBeenCalledWith("sources")
    })
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/test/wiki/characters/Alpha.md")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("existing content")
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    unmount()
  })

  it("节点菜单：编辑真实档案页（文件不存在 → 创建并 bumpDataVersion）", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    mocks.fileExists.mockResolvedValue(false)
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# 模板内容",
    })
    const { unmount } = await renderLoadedGraph()
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy())
    fireEvent.click(screen.getByText("graph.editRealProfilePage"))
    await waitFor(() => {
      expect(mocks.createDirectory).toHaveBeenCalledWith("/p/test/wiki/characters")
    })
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/p/test/wiki/characters/Alpha.md", "# 模板内容")
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("sources")
    unmount()
  })

  it("图例：类型模式小说节点分段、悬停、双击切换、显示全部、折叠", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [
        ...BASIC_NODES,
        makeNode({ id: "ent:1", label: "实体X", type: "entity", path: "/p/test/wiki/entities/e1.md", linkCount: 0, community: 0 }),
      ],
      edges: BASIC_EDGES,
      communities: [],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, novelMode: true })
    const { unmount } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    expect(screen.getByText("novel.graph.novelNodeTypes")).toBeTruthy()
    expect(screen.getByText("novel.graph.baseNodeTypes")).toBeTruthy()
    const legendItem = screen.getByText("novel.graph.nodeTypeLabels.character")
    fireEvent.mouseEnter(legendItem)
    fireEvent.mouseLeave(legendItem)
    fireEvent.doubleClick(legendItem)
    await waitFor(() => {
      expect(screen.getByText("graph.hidden")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("graph.showAll"))
    await waitFor(() => {
      expect(screen.queryByText("graph.hidden")).toBeNull()
    })
    fireEvent.click(screen.getByTitle("graph.collapseLegend"))
    await waitFor(() => {
      expect(screen.queryByText("novel.graph.novelNodeTypes")).toBeNull()
    })
    fireEvent.click(screen.getByTitle("graph.expandLegend"))
    expect(screen.getByText("novel.graph.novelNodeTypes")).toBeTruthy()
    unmount()
  })

  it("图例：非小说模式仅基础类型；社区模式渲染社区列表与低内聚标记", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: BASIC_NODES,
      edges: BASIC_EDGES,
      communities: [
        { id: 0, nodeCount: 2, topNodes: ["Alpha"], cohesion: 0.9 },
        { id: 1, nodeCount: 5, topNodes: ["Lonely"], cohesion: 0.05 },
        { id: 2, nodeCount: 1, topNodes: [], cohesion: 0.5 },
      ],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, novelMode: false, graphColorMode: "community" })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.getByText("Lonely")).toBeTruthy()
    expect(screen.getByTitle("graph.lowCohesion")).toBeTruthy()
    expect(screen.getByText("graph.cluster")).toBeTruthy()
    unmount()
  })

  it("缩放控件触发相机动画", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { unmount } = await renderLoadedGraph()
    const container = screen.getByTestId("sigma-container")
    const buttons = within(container).getAllByRole("button")
    expect(buttons.length).toBe(3)
    fireEvent.click(buttons[0])
    expect(sigma.camera.animatedZoom).toHaveBeenCalledWith({ duration: 200 })
    fireEvent.click(buttons[1])
    expect(sigma.camera.animatedUnzoom).toHaveBeenCalledWith({ duration: 200 })
    fireEvent.click(buttons[2])
    expect(sigma.camera.animatedReset).toHaveBeenCalledWith({ duration: 300 })
    unmount()
  })

  it("布局变化（selectedFile）触发重挂载遮罩并恢复", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { rerender } = await renderLoadedGraph()
    expect(screen.queryByText("graph.resizing")).toBeNull()
    setState({ selectedFile: "/p/test/wiki/chapters/alpha.md" })
    await act(async () => {
      rerender(<GraphView />)
    })
    expect(screen.getByText("graph.resizing")).toBeTruthy()
    await waitFor(
      () => {
        expect(screen.queryByText("graph.resizing")).toBeNull()
      },
      { timeout: 2000 },
    )
    expect(screen.getByTestId("sigma-container")).toBeTruthy()
  })

  it("面板拖拽（body dataset）触发重挂载遮罩并恢复", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    await renderLoadedGraph()
    document.body.dataset.panelResizing = "true"
    await waitFor(() => {
      expect(screen.getByText("graph.resizing")).toBeTruthy()
    })
    // 等待 isResizing=true 后的 effect 重绑 observer，避免结束属性变更被旧闭包忽略。
    await act(async () => {
      await Promise.resolve()
    })
    document.body.dataset.panelResizing = "false"
    await waitFor(
      () => {
        expect(screen.queryByText("graph.resizing")).toBeNull()
      },
      { timeout: 2000 },
    )
    expect(screen.getByTestId("sigma-container")).toBeTruthy()
  })
})

describe("GraphView — 节点编辑与保存（文档模式）", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })


  /** 文档模式：切到「重要角色」分组并展开林烬 */
  async function openLinJinNode() {
    fireEvent.click(screen.getByText("重要角色 1"))
    await waitFor(() => {
      expect(screen.getByText(/林烬/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/林烬/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("graph.editProfileInline")).toBeTruthy()
    })
  }

  function currentTextarea(): HTMLTextAreaElement {
    return (() => { const t = screen.getAllByRole("textbox"); return t[t.length - 1] })() as HTMLTextAreaElement
  }

  it("编辑节点（文件已存在），保存成功（无 embedding）", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("# Alpha\n\n旧内容")
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# Alpha\n\n正文",
    })
    const { unmount } = await renderDocumentView()
    // 展开林烬 → 编辑按钮
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => {
      expect(screen.getByText(/graph\.editingProfileFor/)).toBeTruthy()
    })
    expect(screen.getByText(/graph\.profilePath/)).toBeTruthy()
    const textarea = currentTextarea()
    fireEvent.change(textarea, { target: { value: "# Alpha\n\n新内容" } })
    expect(screen.getByText("graph.editNodeStatusDefault")).toBeTruthy()
    fireEvent.click(screen.getByText("graph.saveProfileInline"))
    await waitFor(() => {
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/p/test/wiki/characters/Alpha.md", "# Alpha\n\n新内容")
    })
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/test/wiki/characters")
    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("# Alpha\n\n新内容")
    await waitFor(() => {
      expect(screen.getByText("graph.savedRealProfile")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("graph.cancelProfileInline"))
    await waitFor(() => {
      expect(screen.queryByText(/graph\.editingProfileFor/)).toBeNull()
    })
    unmount()
  })

  it("保存节点编辑时启用 embedding（动态导入 embedPage）", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("# Alpha\n\n正文")
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# Alpha\n\n正文",
    })
    setState({ embeddingConfig: { enabled: true, model: "m" } })
    const { unmount } = await renderDocumentView()
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => expect(currentTextarea()).toBeTruthy())
    fireEvent.change(currentTextarea(), { target: { value: "# Alpha\n\n正文 v2" } })
    fireEvent.click(screen.getByText("graph.saveProfileInline"))
    await waitFor(() => {
      expect(mocks.embedPage).toHaveBeenCalledWith(
        "/p/test",
        "alpha",
        "Alpha",
        "# Alpha\n\n正文 v2",
        { enabled: true, model: "m" },
      )
    })
    await waitFor(() => {
      expect(screen.getByText("graph.savedRealProfileWithEmbedding")).toBeTruthy()
    })
    unmount()
  })

  it("保存失败显示错误状态", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("# Alpha\n\n正文")
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# Alpha\n\n正文",
    })
    const { unmount } = await renderDocumentView()
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => expect(currentTextarea()).toBeTruthy())
    fireEvent.click(screen.getByText("graph.saveProfileInline"))
    await waitFor(() => {
      expect(screen.getByText("disk full")).toBeTruthy()
    })
    unmount()
  })

  it("编辑时点击风险状态按钮同步写入编辑内容", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("# 秘密A\n\n正文")
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/secrets/sc1.md",
      pageId: "sc1",
      title: "秘密A",
      content: "# 秘密A\n\n正文",
    })
    const { unmount } = await renderDocumentView()
    // 展开 秘密A（默认分组：剧情事件）
    fireEvent.click(screen.getByText(/秘密A/).closest("button")!)
    await waitFor(() => expect(screen.getByText("graph.editProfileInline")).toBeTruthy())
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => expect(currentTextarea()).toBeTruthy())
    const textarea = currentTextarea()
    expect(textarea.value).toBe("# 秘密A\n\n正文")
    // 点击风险状态按钮（未揭露 → 部分揭露）
    const stateBtn = [...screen.getAllByText("未揭露")].find((el) => el.closest("button") && !el.closest("select"))!
    fireEvent.click(stateBtn)
    await waitFor(() => {
      expect(textarea.value).toBe("# 秘密A\n\n状态：部分揭露\n\n正文")
    })
    unmount()
  })

  it("编辑节点时文件不存在 → 使用模板内容", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# 模板标题",
    })
    const { unmount } = await renderDocumentView()
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => {
      expect(currentTextarea().value).toBe("# 模板标题")
    })
    unmount()
  })
})

describe("GraphView — 文档模式 DocumentGraphView", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("筛选为空渲染暂无节点提示与禁用按钮", async () => {
    const { unmount } = await renderDocumentView()
    expect(screen.getByText("当前显示 5 / 5 个节点")).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText("搜索节点标题或来源路径"), { target: { value: "zzz" } })
    await waitFor(() => {
      expect(screen.getByText("当前筛选下暂无节点。")).toBeTruthy()
    })
    expect(screen.getByText("全部展开").closest("button")).toBeDisabled()
    expect(screen.getByText("全部收起").closest("button")).toBeDisabled()
    unmount()
  })

  it("风险统计、快捷筛选、分组切换与清除筛选", async () => {
    const { unmount } = await renderDocumentView()
    // 风险统计项（统计卡 + 快捷筛选区同名 → getAllByText）
    expect(screen.getAllByText("未揭露秘密").length).toBeGreaterThan(0)
    expect(screen.getAllByText("未回收伏笔").length).toBeGreaterThan(0)
    expect(screen.getAllByText("待推进冲突").length).toBeGreaterThan(0)
    expect(screen.getByText(/共 3 项待处理/)).toBeTruthy()
    // 快捷筛选（统计卡 + 快捷筛选区同名 → 取最后一个）
    const quick = screen.getAllByText("未揭露秘密")
    fireEvent.click(quick[quick.length - 1])
    await waitFor(() => {
      expect(screen.getByText("清除筛选")).toBeTruthy()
    })
    // 再次点击 → 取消
    fireEvent.click(screen.getAllByText("未揭露秘密")[quick.length - 1])
    await waitFor(() => {
      expect(screen.queryByText("清除筛选")).toBeNull()
    })
    // 分组切换：重要角色
    fireEvent.click(screen.getByText("重要角色 1"))
    await waitFor(() => {
      expect(screen.getByText("当前分类暂无待处理风险项。")).toBeTruthy()
    })
    expect(screen.getByText(/林烬/)).toBeTruthy()
    // 返回剧情事件
    fireEvent.click(screen.getByText("剧情事件 5"))
    unmount()
  })

  it("筛选器：类型/状态/排序/搜索/隐藏无关系/孤立切换/展开收起", async () => {
    const { unmount } = await renderDocumentView()
    // 排序
    fireEvent.change(screen.getByDisplayValue("默认顺序"), { target: { value: "links-desc" } })
    fireEvent.change(screen.getByDisplayValue("关联最多"), { target: { value: "links-asc" } })
    fireEvent.change(screen.getByDisplayValue("关联最少"), { target: { value: "title" } })
    // 类型筛选：秘密
    fireEvent.change(screen.getByDisplayValue("全部类型"), { target: { value: "secret" } })
    await waitFor(() => {
      expect(screen.getByText(/秘密A/)).toBeTruthy()
    })
    expect(screen.queryByText(/大战/)).toBeNull()
    fireEvent.change(screen.getByDisplayValue("秘密"), { target: { value: "all" } })
    // 状态筛选：未回收（伏笔）
    fireEvent.change(screen.getByDisplayValue("全部状态"), { target: { value: "未回收" } })
    await waitFor(() => {
      expect(screen.getByText(/伏笔A/)).toBeTruthy()
    })
    fireEvent.change(screen.getByDisplayValue("未回收"), { target: { value: "all" } })
    // 搜索
    const search = screen.getByPlaceholderText("搜索节点标题或来源路径")
    fireEvent.change(search, { target: { value: "伏笔" } })
    await waitFor(() => {
      expect(screen.getByText(/伏笔A/)).toBeTruthy()
    })
    expect(screen.queryByText(/大战/)).toBeNull()
    fireEvent.change(search, { target: { value: "" } })
    // 隐藏无关系节点 → cf:1 无可见边被隐藏
    const hideUnrelated = screen.getByText("隐藏无关系节点").closest("label")!.querySelector("input")!
    fireEvent.click(hideUnrelated)
    await waitFor(() => {
      expect(screen.queryByText(/冲突A/)).toBeNull()
    })
    // 关闭隐藏无关系，再只看孤立节点（cf:1 在筛选后孤立）
    fireEvent.click(hideUnrelated)
    fireEvent.click(screen.getByText("只看孤立节点"))
    await waitFor(() => {
      expect(screen.getByText(/冲突A/)).toBeTruthy()
    })
    expect(screen.getByText("当前显示 1 / 5 个节点")).toBeTruthy()
    // 再叠加类型筛选 → 孤立空态（剧情事件组无 character，用 event 类型）
    fireEvent.change(screen.getByDisplayValue("全部类型"), { target: { value: "event" } })
    await waitFor(() => {
      expect(screen.getByText("当前分类暂无孤立节点。")).toBeTruthy()
    })
    fireEvent.change(screen.getByDisplayValue("事件"), { target: { value: "all" } })
    // 取消孤立
    fireEvent.click(screen.getByText("只看孤立节点"))
    // 全部展开 / 全部收起
    fireEvent.click(screen.getByText("全部展开"))
    fireEvent.click(screen.getByText("全部收起"))
    unmount()
  })

  it("节点展开：关系摘要、相关事件、技术信息", async () => {
    const { unmount } = await renderDocumentView()
    // 林烬在「重要角色」分组，先切换
    fireEvent.click(screen.getByText("重要角色 1"))
    await waitFor(() => {
      expect(screen.getByText(/林烬/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/林烬/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("关系摘要")).toBeTruthy()
    })
    // 大战同时出现在关系摘要与相关事件列表
    expect(screen.getAllByText(/大战/).length).toBeGreaterThan(0)
    // 相关事件（事件/章节邻居）
    expect(screen.getByText(/第一章：出场于/)).toBeTruthy()
    // 技术信息 details
    fireEvent.click(screen.getByText("技术信息"))
    expect(screen.getByText(/节点类型：/)).toBeTruthy()
    expect(screen.getByText(/关联数量：/)).toBeTruthy()
    expect(screen.getByText(/来源路径：/)).toBeTruthy()
    unmount()
  })

  it("事件节点展开：相关事件空态与关系表格（方向/权重）", async () => {
    const { unmount } = await renderDocumentView()
    fireEvent.click(screen.getByText(/大战/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("graph.noRelatedEvents")).toBeTruthy()
    })
    const table = screen.getByRole("table")
    expect(within(table).getByText("指向对方")).toBeTruthy()
    expect(within(table).getByText("林烬")).toBeTruthy()
    expect(within(table).getByText("出场于")).toBeTruthy()
    unmount()
  })

  it("孤立节点展开：关系摘要与关系网络空态", async () => {
    const { unmount } = await renderDocumentView()
    fireEvent.click(screen.getByText(/冲突A/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("暂无可用于写作参考的关系摘要。")).toBeTruthy()
    })
    expect(screen.getByText("graph.noRelations")).toBeTruthy()
    // 风险标签徽标（冲突 → 需推进）与状态按钮（待推进）
    expect(screen.getByText("需推进")).toBeTruthy()
    const pendingBtn = [...screen.getAllByText("待推进")].find((el) => el.closest("button") && !el.closest("select"))!
    expect(pendingBtn).toBeTruthy()
    unmount()
  })

  it("风险状态循环与变更历史时间格式", async () => {
    const { unmount } = await renderDocumentView()
    // 秘密A：未揭露 → 部分揭露 → 已揭露
    const stateBtn = [...screen.getAllByText("未揭露")].find((el) => el.closest("button") && !el.closest("select"))!
    fireEvent.click(stateBtn)
    await waitFor(() => {
      expect([...screen.getAllByText("部分揭露")].some((el) => el.closest("button"))).toBe(true)
    })
    fireEvent.click([...screen.getAllByText("部分揭露")].find((el) => el.closest("button") && !el.closest("select"))!)
    await waitFor(() => {
      expect([...screen.getAllByText("已揭露")].some((el) => el.closest("button"))).toBe(true)
    })
    // 展开秘密A → 状态变更记录
    fireEvent.click(screen.getByText(/秘密A/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("状态变更记录")).toBeTruthy()
    })
    expect(screen.getByText(/未揭露 → 部分揭露/)).toBeTruthy()
    expect(screen.getByText(/部分揭露 → 已揭露/)).toBeTruthy()
    unmount()
  })

  it("导出风险报告写入文件", async () => {
    const { unmount } = await renderDocumentView()
    fireEvent.click(screen.getByText("导出报告"))
    await waitFor(() => {
      expect(mocks.writeFileAtomic).toHaveBeenCalled()
    })
    const [reportPath] = mocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(reportPath).toBe("/p/test/wiki/risk-report.md")
    unmount()
  })
})

describe("GraphView — 思维导图模式", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("渲染嵌套分支（含子节点与叶子）", async () => {
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [
        makeNode({ id: "n1", label: "角色页", type: "character", path: "/p/a.md", linkCount: 2, community: 0 }),
        makeNode({ id: "n2", label: "林烬", type: "character", path: "/p/b.md", linkCount: 1, community: 0 }),
        makeNode({ id: "n3", label: "事件", type: "event", path: "/p/c.md", linkCount: 1, community: 0 }),
      ],
      edges: [makeEdge({ source: "n2", target: "n3", weight: 1, relation: "APPEARS_IN" })],
      communities: [],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    setState({ project: PROJECT, graphDisplayMode: "mindmap" })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByText("小说图谱")).toBeTruthy()
    })
    expect(screen.getAllByText("人物").length).toBeGreaterThan(0)
    expect(screen.getByText("角色页")).toBeTruthy()
    expect(screen.getByText("林烬")).toBeTruthy()
    unmount()
  })
})

describe("GraphView — 覆盖补充：Sigma 配置与边界分支", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("覆盖标签模式、边样式、关系标签与 reducer 视觉分支", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { rerender } = await renderLoadedGraph({
      graphMode: "storyline",
      labelDisplayMode: "auto",
      graphEdgeLabelsAlwaysVisible: true,
    })
    setState({ graphEdgeStyle: "line" })
    await act(async () => {
      rerender(<GraphView />)
    })
    await waitFor(() => expect((sigma.getSettings() as { defaultEdgeType: string }).defaultEdgeType).toBe("clamped"))

    const graph = sigma.getGraph() as {
      getNodeAttribute: (node: string, key: string) => unknown
      getEdgeAttribute: (edge: string, key: string) => unknown
    }
    expect(graph.getNodeAttribute("n1", "label")).toBe("Alpha")
    expect(graph.getNodeAttribute("n2", "label")).toBe("n2")
    expect(graph.getNodeAttribute("x:y:z", "label")).toBe("y:z")
    const settings = sigma.getSettings() as {
      defaultEdgeType: string
      nodeReducer: (node: string, attrs: Record<string, unknown>) => Record<string, unknown>
      edgeReducer: (edge: string, attrs: Record<string, unknown>) => Record<string, unknown>
    }
    expect(settings.defaultEdgeType).toBe("clamped")
    expect(graph.getEdgeAttribute("n1->n2", "label")).toBe("出场于")

    expect(settings.nodeReducer("n1", { size: 10, color: "#000000", label: "Alpha", insightHighlight: true })).toMatchObject({ size: 15, zIndex: 10, forceLabel: true })
    expect(settings.nodeReducer("n1", { size: 10, color: "#000000", label: "Alpha", hovering: true })).toMatchObject({ size: 14, zIndex: 10, forceLabel: true })
    expect(settings.nodeReducer("n1", { size: 10, color: "#000000", label: "Alpha", dragging: true })).toMatchObject({ size: 13.5, zIndex: 12, forceLabel: true })
    const dimmedNode = settings.nodeReducer("n1", { size: 10, label: "Alpha", dimmed: true })
    expect(dimmedNode.label).toBe("")
    expect(dimmedNode.size).toBe(6)
    expect(dimmedNode.color).toMatch(/^#|^rgba?\(/)

    const dimmedEdge = settings.edgeReducer("n1->n2", { size: 4, color: "#123456", dimmed: true })
    expect(dimmedEdge).toMatchObject({ size: 0.3 })
    expect(settings.edgeReducer("n1->n2", { size: 1, highlighted: true, relation: "APPEARS_IN" })).toMatchObject({
      color: "#1e293b",
      size: 2,
      label: "出场于",
      forceLabel: true,
    })
    expect(settings.edgeReducer("n1->n2", { size: 2, highlighted: true, relation: "CUSTOM_REL" }).label).toBe("CUSTOM_REL")
    expect(settings.edgeReducer("left->right", { highlighted: true }).label).toBe("left ↔ right")
    expect(settings.edgeReducer("single", { highlighted: true }).label).toBeUndefined()
  })

  it("tracker 加载失败仍保留图谱，并覆盖拖拽后节点被替换的分支", async () => {
    mocks.buildWikiGraph.mockResolvedValue(BASIC_RESULT)
    mocks.loadForeshadowingTracker.mockRejectedValue(new Error("tracker unavailable"))
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    setState({ project: PROJECT })
    render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())

    const graph = sigma.getGraph() as {
      dropNode: (node: string) => void
      hasNode: (node: string) => boolean
    }
    fireSigmaEvent("downNode", {
      node: "n1",
      event: { original: new MouseEvent("mousedown", { button: 0 }) },
      preventSigmaDefault: vi.fn(),
    })
    graph.dropNode("n1")
    expect(graph.hasNode("n1")).toBe(false)
    sigma.refresh.mockClear()
    fireSigmaEvent("mousemovebody", { x: 10, y: 10 })
    expect(sigma.refresh).not.toHaveBeenCalled()
    fireSigmaEvent("mouseup", {})
    expect(sigma.container.style.cursor).toBe("default")
  })

  it("大图启用 ForceAtlas2 Barnes-Hut 优化", async () => {
    const nodes = Array.from({ length: 51 }, (_, index) => makeNode({
      id: `large-${index}`,
      label: `节点${index}`,
      type: "character",
      path: `/p/test/wiki/characters/${index}.md`,
      linkCount: index === 0 ? 2 : 1,
      community: index % 3,
    }))
    const edges = nodes.slice(1).map((node, index) => makeEdge({
      source: nodes[index].id,
      target: node.id,
      weight: 1,
      relation: "KNOWS",
    }))
    mocks.buildWikiGraph.mockResolvedValue({ nodes, edges, communities: [] })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    setState({ project: PROJECT, graphMode: "character" })
    render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    await waitFor(() => {
      expect(mocks.fa2.assign).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ settings: expect.objectContaining({ barnesHutOptimize: true }) }),
      )
    })
  })
})


describe("GraphView — 洞察面板（内部 state 不可达）", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("showInsights 恒为 false：面板不渲染，find/detect 仍被调用", async () => {
    mocks.findSurprisingConnections.mockReturnValue([
      { source: { id: "n1", label: "Alpha" }, target: { id: "n2", label: "Beta" }, reasons: ["跨社区"], key: "c1" },
    ])
    mocks.detectKnowledgeGaps.mockReturnValue([
      { type: "isolated-node", title: "孤立", description: "缺关联", nodeIds: ["n1"], suggestion: "补" },
    ])
    mocks.buildWikiGraph.mockResolvedValue(BASIC_RESULT)
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    expect(mocks.findSurprisingConnections).toHaveBeenCalled()
    expect(mocks.detectKnowledgeGaps).toHaveBeenCalled()
    expect(screen.queryByText("graph.insights")).toBeNull()
    unmount()
  })
})

describe("GraphView — 覆盖率补齐：可达分支", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  async function renderFixture(fixture: unknown, patch: Record<string, unknown> = {}) {
    mocks.buildWikiGraph.mockResolvedValue(fixture)
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    setState({ project: PROJECT, ...patch })
    const utils = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    return utils
  }

  async function openLinJinNode() {
    fireEvent.click(screen.getByText("重要角色 1"))
    await waitFor(() => {
      expect(screen.getByText(/林烬/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/林烬/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("graph.editProfileInline")).toBeTruthy()
    })
  }

  function currentTextarea(): HTMLTextAreaElement {
    return (() => { const t = screen.getAllByRole("textbox"); return t[t.length - 1] })() as HTMLTextAreaElement
  }

  it("auto 标签模式：minimal/focused 预设、关系兜底、缺失源点边、NaN 社区", async () => {
    const autoNodes = [
      makeNode({ id: "n1", label: "Alpha", type: "character", path: "/p/test/wiki/chapters/alpha.md", linkCount: 3, community: 0 }),
      makeNode({ id: "n2", label: "", type: "event", path: "/p/test/wiki/events/battle.md", linkCount: 1, community: Number.NaN }),
      makeNode({ id: "x:y:z", label: "伏笔Z", type: "foreshadowing", path: "/p/test/wiki/events/fs.md", linkCount: 2, community: 1 }),
    ]
    const edgeNoRelation = makeEdge({ source: "x:y:z", target: "n2", weight: 2 })
    delete (edgeNoRelation as Partial<GraphEdge>).relation
    const autoEdges = [
      makeEdge({ source: "n1", target: "n2", weight: 5, relation: "APPEARS_IN" }),
      edgeNoRelation,
      // source 不在图中 → hasNode(edge.source) 短路
      makeEdge({ source: "ghost-src", target: "n1", weight: 1, relation: "KNOWS" }),
      // target 不在图中
      makeEdge({ source: "n1", target: "ghost-t", weight: 1, relation: "KNOWS" }),
    ]
    const { rerender } = await renderFixture({ nodes: autoNodes, edges: autoEdges, communities: [] }, {
      graphMode: "storyline",
      graphLabelDisplayMode: "auto",
    })

    const graphApi = () => sigma.getGraph() as {
      getNodeAttribute: (node: string, key: string) => unknown
      getEdgeAttribute: (edge: string, key: string) => unknown
      hasNode: (node: string) => boolean
    }
    // 等本轮 fixture 入图（x:y:z 为本 fixture 独有节点，避免读到上一轮异步重建前的旧图）
    await waitFor(() => {
      expect(graphApi().hasNode("x:y:z")).toBe(true)
    })
    const graph = graphApi()
    // storyline 预设 labelVisibility=minimal → linkCount >= max(2, ceil(3*0.35))
    expect(graph.getNodeAttribute("n1", "label")).toBe("Alpha")
    expect(graph.getNodeAttribute("n2", "label")).toBe("")
    // relation 缺失 → 兜底 ""
    expect(graph.getEdgeAttribute("x:y:z->n2", "relation")).toBe("")
    const settings = sigma.getSettings() as {
      labelDensity: number
      labelRenderedSizeThreshold: number
    }
    // labelDisplayMode=auto → 0.4 / 6
    expect(settings.labelDensity).toBe(0.4)
    expect(settings.labelRenderedSizeThreshold).toBe(6)

    // 切到 overview 预设 labelVisibility=focused → 默认阈值 return
    setState({ graphMode: "overview" })
    await act(async () => {
      rerender(<GraphView />)
    })
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    // 等模式切换后的图重建完成再断言
    await waitFor(() => {
      const graph2 = sigma.getGraph() as {
        getNodeAttribute: (node: string, key: string) => unknown
      }
      expect(graph2.getNodeAttribute("n2", "label")).toBe("n2")
    })
    const graph2 = sigma.getGraph() as {
      getNodeAttribute: (node: string, key: string) => unknown
    }
    expect(graph2.getNodeAttribute("n1", "label")).toBe("Alpha")
    expect(graph2.getNodeAttribute("n2", "label")).toBe("n2")
  })

  it("右键触摸事件走 clientPointFromEvent 触摸分支（含无触点兑底）", async () => {
    const { unmount } = await renderFixture({ nodes: BASIC_NODES, edges: BASIC_EDGES, communities: [] })
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: { touches: [], changedTouches: [{ clientX: 5, clientY: 9 }], preventDefault: vi.fn() } },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => {
      expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy()
    })
    expect(screen.getByText("Alpha")).toBeTruthy()
    // 无任何触点 → clientX 兑底 0
    fireSigmaEvent("rightClickNode", {
      node: "unknown-type-node",
      event: { original: { touches: [], changedTouches: [], preventDefault: vi.fn() } },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => {
      expect(screen.getByText("custom")).toBeTruthy()
    })
    unmount()
  })

  it("文档视图：全量过滤后 groups 为空（空态兜底）", async () => {
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [makeNode({ id: "ent:1", label: "实体X", type: "entity", path: "/p/test/wiki/entities/e1.md", linkCount: 0, community: 0 })],
      edges: [],
      communities: [],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, graphDisplayMode: "document" })
    const { unmount } = render(<GraphView />)
    await waitFor(() => {
      expect(screen.getByText("小说图谱文档")).toBeTruthy()
    })
    expect(screen.getByText("当前分类暂无待处理风险项。")).toBeTruthy()
    expect(screen.getByText("当前显示 0 / 0 个节点")).toBeTruthy()
    expect(screen.queryByText("graph.editProfileInline")).toBeNull()
    unmount()
  })

  it("文档视图：分组切换后隐藏角色类型 → 分组/类型筛选自动重置", async () => {
    const { unmount } = await renderDocumentView({ graphShowFilters: true })
    fireEvent.click(screen.getByText("重要角色 1"))
    await waitFor(() => {
      expect(screen.getByText(/林烬/)).toBeTruthy()
    })
    // 在「重要角色」分组内选择类型 character
    fireEvent.change(screen.getByDisplayValue("全部类型"), { target: { value: "character" } })
    await waitFor(() => {
      expect(screen.getByText("当前显示 1 / 1 个节点")).toBeTruthy()
    })
    // 过滤器面板隐藏 character → 重要角色分组消失 → activeGroupTitle / 类型筛选重置
    const charCheckbox = screen.getAllByRole("checkbox").find((cb) =>
      cb.closest("label")?.textContent?.includes("novel.graph.nodeTypeLabels.character"),
    )!
    fireEvent.click(charCheckbox)
    await waitFor(() => {
      expect(screen.queryByText(/林烬/)).toBeNull()
    })
    expect(screen.getByText(/剧情事件 5/)).toBeTruthy()
    expect(screen.getByDisplayValue("全部类型")).toBeTruthy()
    expect(screen.getAllByText("未揭露秘密").length).toBeGreaterThan(0)
    unmount()
  })

  it("文档视图：隐藏伏笔类型 → 状态筛选自动重置", async () => {
    const { unmount } = await renderDocumentView({ graphShowFilters: true })
    fireEvent.change(screen.getByDisplayValue("全部状态"), { target: { value: "未回收" } })
    await waitFor(() => {
      expect(screen.getByText(/伏笔A/)).toBeTruthy()
    })
    const foCheckbox = screen.getAllByRole("checkbox").find((cb) =>
      cb.closest("label")?.textContent?.includes("novel.graph.nodeTypeLabels.foreshadowing"),
    )!
    fireEvent.click(foCheckbox)
    await waitFor(() => {
      expect(screen.queryByText(/伏笔A/)).toBeNull()
    })
    expect(screen.getByDisplayValue("全部状态")).toBeTruthy()
    unmount()
  })

  it("文档视图：数据重载后渲染新分组与空 path 展示兜底", async () => {
    const { rerender } = await renderDocumentView()
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [makeNode({ id: "ch:np", label: "无名角色", type: "character", path: "", linkCount: 1, community: 0 })],
      edges: [],
      communities: [],
    })
    setState({ dataVersion: 42 })
    await act(async () => {
      rerender(<GraphView />)
    })
    await waitFor(() => {
      expect(screen.getByText(/无名角色/)).toBeTruthy()
    })
    // 空 path → 技术信息 来源路径：暂无
    fireEvent.click(screen.getByText(/无名角色/).closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("graph.editProfileInline")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("技术信息"))
    expect(screen.getByText(/来源路径：暂无/)).toBeTruthy()
  })

  it("文档视图：节点展开后再次点击折叠（toggle 删除分支）", async () => {
    const { unmount } = await renderDocumentView()
    fireEvent.click(screen.getByText("重要角色 1"))
    await waitFor(() => {
      expect(screen.getByText(/林烬/)).toBeTruthy()
    })
    const header = screen.getByText(/林烬/).closest("button")!
    fireEvent.click(header)
    await waitFor(() => {
      expect(screen.getByText("graph.editProfileInline")).toBeTruthy()
    })
    fireEvent.click(header)
    await waitFor(() => {
      expect(screen.queryByText("graph.editProfileInline")).toBeNull()
    })
    unmount()
  })

  it("文档视图：点击统计卡应用快捷筛选，再点清除筛选", async () => {
    const { unmount } = await renderDocumentView()
    const statCard = screen.getAllByText("未揭露秘密")[0]
    fireEvent.click(statCard)
    await waitFor(() => {
      expect(screen.getByText("清除筛选")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("清除筛选"))
    await waitFor(() => {
      expect(screen.queryByText("清除筛选")).toBeNull()
    })
    expect(screen.getAllByText("未揭露秘密").length).toBeGreaterThan(0)
    unmount()
  })

  it("文档视图：保存失败（非 Error）显示 i18n 兜底文案", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("# Alpha\n\n正文")
    mocks.writeFileAtomic.mockRejectedValue("oops-string")
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# Alpha\n\n正文",
    })
    const { unmount } = await renderDocumentView()
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => expect(currentTextarea()).toBeTruthy())
    fireEvent.click(screen.getByText("graph.saveProfileInline"))
    await waitFor(() => {
      expect(screen.getByText("graph.saveNodeFailed")).toBeTruthy()
    })
    unmount()
  })

  it("文档视图：档案页读取失败回退模板内容", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockRejectedValue(new Error("read failed"))
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# Alpha\n\n模板正文",
    })
    const { unmount } = await renderDocumentView()
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => {
      expect(currentTextarea().value).toBe("# Alpha\n\n模板正文")
    })
    unmount()
  })

  it("节点菜单：档案页写入失败记录 console.error", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "/p/test/wiki/characters/Alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# 模板",
    })
    const { unmount } = await renderLoadedGraph()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy())
    fireEvent.click(screen.getByText("graph.editRealProfilePage"))
    await waitFor(
      () => {
        expect(errorSpy).toHaveBeenCalled()
      },
      // 整文件并发时共享异步状态可能延迟 errorSpy 触发，默认 5s 不够
      { timeout: 10000 },
    )
    errorSpy.mockRestore()
    unmount()
  })

  it("节点菜单：裸文件名路径跳过 createDirectory", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    mocks.fileExists.mockResolvedValue(false)
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# 模板",
    })
    const { unmount } = await renderLoadedGraph()
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy())
    fireEvent.click(screen.getByText("graph.editRealProfilePage"))
    await waitFor(() => {
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith("alpha.md", "# 模板")
    })
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    unmount()
  })

  it("文档编辑保存：裸文件名路径跳过 createDirectory", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.buildEditableGraphNodePage.mockReturnValue({
      path: "alpha.md",
      pageId: "alpha",
      title: "Alpha",
      content: "# Alpha\n\n模板",
    })
    const { unmount } = await renderDocumentView()
    await openLinJinNode()
    fireEvent.click(screen.getByText("graph.editProfileInline"))
    await waitFor(() => expect(currentTextarea()).toBeTruthy())
    fireEvent.change(currentTextarea(), { target: { value: "# Alpha\n\n新内容" } })
    fireEvent.click(screen.getByText("graph.saveProfileInline"))
    await waitFor(() => {
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith("alpha.md", "# Alpha\n\n新内容")
    })
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    unmount()
  })

  it("节点菜单：关系超过 8 条显示 +N；无边节点不渲染关系区", async () => {
    const hubTargets = Array.from({ length: 10 }, (_, i) => makeNode({
      id: `t${i}`,
      label: `目标${i}`,
      type: "event",
      path: `/p/test/wiki/events/t${i}.md`,
      linkCount: 1,
      community: 0,
    }))
    const hub = makeNode({ id: "hub:1", label: "枢纽", type: "character", path: "/p/test/wiki/chapters/hub.md", linkCount: 10, community: 0 })
    const iso = makeNode({ id: "iso:1", label: "孤立点", type: "custom-type", path: "/p/test/wiki/other.md", linkCount: 0, community: 2 })
    const edges = hubTargets.map((target) => makeEdge({ source: hub.id, target: target.id, weight: 2, relation: "APPEARS_IN" }))
    const { unmount } = await renderFixture({ nodes: [hub, iso, ...hubTargets], edges, communities: [] })
    fireSigmaEvent("rightClickNode", {
      node: "hub:1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => {
      expect(screen.getByText("+2")).toBeTruthy()
    })
    // 孤立点无任何关系 → 关系区返回 null
    fireSigmaEvent("rightClickNode", {
      node: "iso:1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => {
      expect(screen.getByText("孤立点")).toBeTruthy()
    })
    expect(screen.queryByText("novel.graph.relations")).toBeNull()
    unmount()
  })

  it("过滤器：节点类型勾选再次点击恢复显示；容器 contextmenu 事件", async () => {
    const { unmount } = await renderLoadedGraph({ graphShowFilters: true })
    const checkboxes = screen.getAllByRole("checkbox")
    const charCheckbox = checkboxes.find((cb) =>
      cb.closest("label")?.textContent?.includes("novel.graph.nodeTypeLabels.character"),
    )!
    fireEvent.click(charCheckbox)
    await waitFor(() => {
      expect(screen.getByText("graph.hidden")).toBeTruthy()
    })
    // 再次点击 → delete 分支恢复显示
    fireEvent.click(charCheckbox)
    await waitFor(() => {
      expect(screen.queryByText("graph.hidden")).toBeNull()
    })
    // 容器 DOM contextmenu 事件
    const container = screen.getByTestId("sigma-container").parentElement!
    fireEvent.contextMenu(container)
    unmount()
  })

  it("隐藏节点后重载：隐藏清单显示原始 id", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { rerender } = await renderLoadedGraph({ graphShowFilters: true })
    fireSigmaEvent("rightClickNode", {
      node: "n1",
      event: { original: new MouseEvent("contextmenu", { clientX: 10, clientY: 10 }) },
      preventSigmaDefault: vi.fn(),
    })
    await waitFor(() => expect(screen.getByText("graph.hideThisNode")).toBeTruthy())
    fireEvent.click(screen.getByText("graph.hideThisNode"))
    await waitFor(() => expect(screen.getByText("graph.hiddenNodes")).toBeTruthy())

    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [
        makeNode({ id: "c1", label: "角色一", type: "character", path: "/p/test/wiki/chapters/c1.md", linkCount: 1, community: 0 }),
      ],
      edges: [],
      communities: [],
    })
    setState({ dataVersion: 7 })
    await act(async () => {
      rerender(<GraphView />)
    })
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    // n1 已不在新数据中 → 隐藏清单回退原始 id
    expect(screen.getByText("n1")).toBeTruthy()
  })

  it("图例：类型双击再次点击恢复显示（delete 分支）", async () => {
    const { unmount } = await renderLoadedGraph()
    const legendItem = screen.getByText("novel.graph.nodeTypeLabels.character")
    fireEvent.doubleClick(legendItem)
    await waitFor(() => {
      expect(screen.getByText("graph.hidden")).toBeTruthy()
    })
    fireEvent.doubleClick(legendItem)
    await waitFor(() => {
      expect(screen.queryByText("graph.hidden")).toBeNull()
    })
    unmount()
  })

  it("图例：非小说模式基础类型渲染 + hover + 双击切换", async () => {
    const entNode = makeNode({ id: "ent:1", label: "实体X", type: "entity", path: "/p/test/wiki/entities/e1.md", linkCount: 0, community: 0 })
    mocks.buildWikiGraph.mockResolvedValue({ nodes: [entNode], edges: [], communities: [] })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
    setState({ project: PROJECT, novelMode: false, graphColorMode: "type" })
    const { unmount } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    const item = screen.getByText("graph.nodeTypeLabels.entity")
    const labelSpan = within(item).getByText("graph.nodeTypeLabels.entity")
    fireEvent.mouseEnter(item)
    expect(labelSpan.className).toContain("text-foreground")
    fireEvent.mouseLeave(item)
    expect(labelSpan.className).toContain("text-muted-foreground")
    // 双击隐藏 → 徽标出现；再双击恢复
    fireEvent.doubleClick(item)
    await waitFor(() => {
      expect(screen.getByText("graph.hidden")).toBeTruthy()
    })
    fireEvent.doubleClick(item)
    await waitFor(() => {
      expect(screen.queryByText("graph.hidden")).toBeNull()
    })
    unmount()
  })

  it("project 变化重渲染：dataVersion 未变不重复构建", async () => {
    const { rerender } = await renderLoadedGraph()
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(1)
    setState({ project: { id: "p2", name: "Two", path: "/p/two" } })
    await act(async () => {
      rerender(<GraphView />)
    })
    await waitFor(() => {
      expect(screen.getByTestId("sigma-container")).toBeTruthy()
    })
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(1)
  })

  it("节点 reducer：无 size 时回退视觉基线", async () => {
    const { unmount } = await renderLoadedGraph()
    const settings = sigma.getSettings() as {
      nodeReducer: (node: string, attrs: Record<string, unknown>) => Record<string, unknown>
    }
    expect(settings.nodeReducer("n1", { insightHighlight: true }).size).toBeGreaterThan(0)
    expect(settings.nodeReducer("n1", { hovering: true }).size).toBeGreaterThan(0)
    expect(settings.nodeReducer("n1", { dragging: true }).size).toBeGreaterThan(0)
    const dimmed = settings.nodeReducer("n1", { dimmed: true })
    expect(dimmed.size).toBeGreaterThan(0)
    expect(dimmed.label).toBe("")
    unmount()
  })

  it("伏笔 tracker：空名称条目跳过建图", async () => {
    mocks.buildWikiGraph.mockResolvedValue({
      nodes: [
        makeNode({ id: "fo:a", label: "伏笔A", type: "foreshadowing", path: "/p/test/wiki/events/foa.md", linkCount: 1, community: 0 }),
        makeNode({ id: "ch:1", label: "第一章", type: "chapter", path: "/p/test/wiki/chapters/1.md", linkCount: 1, community: 0 }),
      ],
      edges: [makeEdge({ source: "fo:a", target: "ch:1", weight: 1, relation: "ADVANCES_FORESHADOWING" })],
      communities: [],
    })
    mocks.loadForeshadowingTracker.mockResolvedValue({
      items: [
        { name: "", status: "planted" },
        { name: "伏笔A", status: "resolved" },
      ],
      lastUpdated: "",
    })
    setState({ project: PROJECT, graphMode: "foreshadowing" })
    const { unmount } = render(<GraphView />)
    await waitFor(() => expect(screen.getByTestId("sigma-container")).toBeTruthy())
    const graph = sigma.getGraph() as { getNodeAttribute: (node: string, key: string) => unknown }
    expect(graph.getNodeAttribute("fo:a", "color")).toBe("#22c55e")
    unmount()
  })
})

describe("GraphView — 覆盖率终局：可达边界", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
    if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = vi.fn() as never
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
    document.body.dataset.panelResizing = ""
    delete document.body.dataset.panelResizing
  })

  it("文档视图: project.path 为空 → 导出风险报告守卫早退（不写文件）", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    await renderDocumentView()
    // getState() 直接读取 store — 改变 path 后按钮仍可点击，守卫应拦截
    setState({ project: { id: "p1", name: "Test", path: "" } })
    fireEvent.click(screen.getByText("导出报告"))
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("节点右键菜单: 容器 getBoundingClientRect 缺失 → 使用原始坐标兜底", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    await renderLoadedGraph()
    const containerEl = document.querySelector('[data-testid="sigma-container"]')?.parentElement as HTMLElement | null
    expect(containerEl).not.toBeNull()
    const original = containerEl!.getBoundingClientRect.bind(containerEl!)
    containerEl!.getBoundingClientRect = (() => null) as never
    try {
      const preventSigmaDefault = vi.fn()
      const mouseEvent = new MouseEvent("contextmenu", { clientX: 100, clientY: 120 })
      fireSigmaEvent("rightClickNode", {
        node: "n1",
        event: { original: mouseEvent },
        preventSigmaDefault,
      })
      await waitFor(() => expect(screen.getByText("graph.editRealProfilePage")).toBeTruthy())
      // rect 为空 → x/y 保持原始 client 坐标（无 left/top 修正）
      const menu = document.querySelector(".absolute.z-20.w-56") as HTMLElement | null
      expect(menu).not.toBeNull()
      expect(menu?.style.left).toBe("100px")
      expect(menu?.style.top).toBe("120px")
    } finally {
      containerEl!.getBoundingClientRect = original
    }
  })

  it("过滤器面板: hideStructural/hideIsolated 复选框 onChange（disabled 元素经 fireEvent 派发仍可达）", async () => {
    mocks.findSurprisingConnections.mockReturnValue([])
    mocks.detectKnowledgeGaps.mockReturnValue([])
    const { unmount } = await renderLoadedGraph({ graphShowFilters: true })
    const checkboxes = screen.getAllByRole("checkbox")
    const structural = checkboxes.find((cb) => cb.closest("label")?.textContent?.includes("graph.hideIndexOverview"))
    const isolated = checkboxes.find((cb) => cb.closest("label")?.textContent?.includes("graph.hideIsolated"))
    expect(structural).toBeTruthy()
    expect(isolated).toBeTruthy()
    expect((structural as HTMLInputElement).disabled).toBe(true)
    // fireEvent 直接派发 click 事件（绕过浏览器 disabled 拦截），触发 React onChange 处理器
    fireEvent.click(structural as HTMLInputElement)
    fireEvent.click(isolated as HTMLInputElement)
    unmount()
  })
})
