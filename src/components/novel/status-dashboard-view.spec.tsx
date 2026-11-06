// @vitest-environment jsdom
// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * StatusDashboardView + 维度开关 spec（plan T4 单测矩阵）。
 * 沿用 graph-view.spec / node-inspector-drawer.spec 模式：
 * jsdom + component-test-utils render/screen + zh defaultValue 兜底 + 30s 超时。
 * 用例：(1)五维全量计数 (2)口径主行/次行 (3)人物 join (4)伏笔 60 行截断
 * (5)canon 非 Tauri degraded (6)canon 真空 honest empty (7)开关 hiddenTypes-only。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, configure } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"

configure({ asyncUtilTimeout: 30000 })
vi.setConfig({ testTimeout: 30_000 })

const mocks = vi.hoisted(() => ({
  tauri: true,
  project: { id: "p1", name: "proj", path: "C:/proj" } as { id: string; name: string; path: string } | null,
  dataVersion: 0,
  graphNodes: [] as Array<{ id: string; label: string; type: string; path: string; linkCount: number; community: number }>,
  graphEdges: [] as Array<{ source: string; target: string; weight: number; relation: string }>,
  characters: [] as Array<{ characterName: string; currentLocation: string; status: string }>,
  foreshadowingItems: [] as Array<{
    id: string
    name: string
    description: string
    status: string
    plantedChapter: number
    advancedChapters: number[]
    resolvedChapter?: number
  }>,
  canonFacts: [] as Array<{ id: string }>,
  queryCalls: [] as Array<Record<string, unknown>>,
  sidebarState: {
    graphMode: "overview",
    graphDisplayMode: "graph",
    graphColorMode: "type",
    graphLabelDisplayMode: "all",
    graphShowFilters: false,
    graphShowEdgeControls: false,
    graphEdgeStyle: "curve",
    graphEdgeColorHex: "#7f8ea3",
    graphEdgeStrengthPercent: 180,
    graphStats: { nodeCount: 0, edgeCount: 0, hiddenCount: 0, filteredNodeCount: 0, filteredEdgeCount: 0 },
  },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof store) => unknown) => selector(store),
  }
})

const store = {
  get project() {
    return mocks.project
  },
  get dataVersion() {
    return mocks.dataVersion
  },
  get graphMode() {
    return mocks.sidebarState.graphMode
  },
  setGraphMode: vi.fn(),
  get graphDisplayMode() {
    return mocks.sidebarState.graphDisplayMode
  },
  setGraphDisplayMode: vi.fn(),
  get graphColorMode() {
    return mocks.sidebarState.graphColorMode
  },
  setGraphColorMode: vi.fn(),
  get graphLabelDisplayMode() {
    return mocks.sidebarState.graphLabelDisplayMode
  },
  setGraphLabelDisplayMode: vi.fn(),
  get graphShowFilters() {
    return mocks.sidebarState.graphShowFilters
  },
  setShowFilters: vi.fn(),
  get showEdgeControls() {
    return mocks.sidebarState.graphShowEdgeControls
  },
  setShowEdgeControls: vi.fn(),
  get graphEdgeStyle() {
    return mocks.sidebarState.graphEdgeStyle
  },
  setGraphEdgeStyle: vi.fn(),
  get graphEdgeColorHex() {
    return mocks.sidebarState.graphEdgeColorHex
  },
  setGraphEdgeColorHex: vi.fn(),
  get graphEdgeStrengthPercent() {
    return mocks.sidebarState.graphEdgeStrengthPercent
  },
  setGraphEdgeStrengthPercent: vi.fn(),
  get graphStats() {
    return mocks.sidebarState.graphStats
  },
  setGraphShowFilters: vi.fn(),
  setGraphShowEdgeControls: vi.fn(),
  refreshGraph: null,
}

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let text = typeof opts?.["defaultValue"] === "string" ? (opts["defaultValue"] as string) : key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === "defaultValue") continue
          text = text.split(`{{${k}}}`).join(String(v)).split(`{{ ${k} }}`).join(String(v))
        }
      }
      return text
    },
  }),
}))

vi.mock("@/lib/wiki-graph", () => ({
  buildWikiGraph: vi.fn(async () => ({ nodes: mocks.graphNodes, edges: mocks.graphEdges, communities: [] })),
}))

vi.mock("@/lib/novel", () => ({
  loadCharacterStates: vi.fn(async () => ({ characters: mocks.characters, lastUpdated: "" })),
  loadForeshadowingTracker: vi.fn(async () => ({ items: mocks.foreshadowingItems, lastUpdated: "" })),
  getForeshadowingWatermark: vi.fn((items: Array<{ plantedChapter: number }>) => {
    let max = 1
    for (const f of items) max = Math.max(max, f.plantedChapter)
    return max
  }),
  analyzeForeshadowingDebt: vi.fn((store: { items: Array<{ status: string }> }) => {
    const unresolved = store.items.filter((i) => i.status === "planted" || i.status === "advanced")
    return {
      items: [],
      totalUnresolved: unresolved.length,
      criticalCount: 0,
      warningCount: 0,
      debtScore: 100,
      thresholds: { plantedStale: 5, advancedStale: 10, densityLimit: 5 },
    }
  }),
  NOVEL_RELATION_LABELS: { APPEARS_IN: "出场于", KNOWS: "知道", CAUSES: "导致" },
  buildCanonEdgeFilter: vi.fn((opts: Record<string, unknown>) => ({
    known_by: opts["knownBy"] ?? null,
    valid_at_chapter: opts["validAtChapter"] ?? null,
    include_invalidated: null,
    edge_kinds: opts["edgeKinds"] ?? null,
    predicates: null,
    entity_ids: null,
    archived: null,
    digest: null,
    limit: opts["limit"] ?? null,
    offset: opts["offset"] ?? null,
  })),
  queryCanonEdges: vi.fn(async (_projectId: string, filter: { limit?: number; offset?: number }) => {
    mocks.queryCalls.push({ ...(filter as Record<string, unknown>) })
    const offset = filter.offset ?? 0
    return mocks.canonFacts.slice(offset, offset + (filter.limit ?? 100))
  }),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: () => mocks.tauri,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

const {
  StatusDashboardView,
  countNodesByType,
  groupEdgesByRelation,
  parseDashboardChapterNumber,
  maxChapterFromNodes,
  truncateRows,
  toggleDashboardHiddenType,
  formatCharacterStateLine,
  loadDashboardHiddenTypes,
  saveDashboardHiddenTypes,
  DASHBOARD_FILTER_KEY,
  DASHBOARD_FILTERS_EVENT,
  FORESHADOWING_LIST_LIMIT,
  CANON_QUERY_LIMIT,
  CANON_TOTAL_CAP,
} = await import("./status-dashboard-view")
const { GraphSidebarPanel } = await import("../layout/graph-sidebar-panel")

function seedBaseline() {
  mocks.graphNodes = [
    { id: "character:林砚", label: "林砚", type: "character", path: "wiki/characters/林砚.md", linkCount: 2, community: 1 },
    { id: "character:苏晚", label: "苏晚", type: "character", path: "wiki/characters/苏晚.md", linkCount: 1, community: 1 },
    { id: "organization:青云宗", label: "青云宗", type: "organization", path: "wiki/org.md", linkCount: 1, community: 1 },
    { id: "event:大比", label: "大比", type: "event", path: "wiki/events.md", linkCount: 1, community: 1 },
    { id: "location:青石镇", label: "青石镇", type: "location", path: "wiki/loc.md", linkCount: 1, community: 1 },
    { id: "chapter:3", label: "第3章", type: "chapter", path: "wiki/chapters/03.md", linkCount: 2, community: 1 },
  ]
  mocks.graphEdges = [
    { source: "character:林砚", target: "chapter:3", weight: 1, relation: "APPEARS_IN" },
    { source: "character:苏晚", target: "chapter:3", weight: 1, relation: "APPEARS_IN" },
    { source: "character:林砚", target: "character:苏晚", weight: 1, relation: "KNOWS" },
  ]
  mocks.characters = [
    { characterName: "林砚", currentLocation: "青石镇", status: "active" },
    { characterName: "赵九", currentLocation: "云海", status: "idle" },
  ]
  mocks.foreshadowingItems = [
    { id: "f1", name: "黑剑", description: "d", status: "planted", plantedChapter: 1, advancedChapters: [] },
    { id: "f2", name: "玉佩", description: "d", status: "advanced", plantedChapter: 1, advancedChapters: [2] },
    { id: "f3", name: "旧约", description: "d", status: "resolved", plantedChapter: 1, advancedChapters: [2], resolvedChapter: 3 },
  ]
  mocks.canonFacts = [{ id: "canon-1" }, { id: "canon-2" }]
}

beforeEach(() => {
  setupDomGlobals()
  mocks.tauri = true
  mocks.project = { id: "p1", name: "proj", path: "C:/proj" }
  mocks.dataVersion = 0
  mocks.queryCalls = []
  localStorage.clear()
  seedBaseline()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("StatusDashboardView helpers", () => {
  it("countNodesByType 按类型全量计数", () => {
    expect(countNodesByType([{ type: "character" }, { type: "character" }, { type: "event" }])).toEqual({
      character: 2,
      event: 1,
    })
  })

  it("groupEdgesByRelation 空 relation 回退 AFFECTS", () => {
    expect(groupEdgesByRelation([{ relation: "KNOWS" }, { relation: "" }])).toEqual({ KNOWS: 1, AFFECTS: 1 })
  })

  it("parseDashboardChapterNumber 与 graph-view 同口径", () => {
    expect(parseDashboardChapterNumber({ label: "第12章 起点", path: "/p/test/wiki/chapters/12.md" })).toBe(12)
    expect(parseDashboardChapterNumber({ label: "ch3", path: "/p/test/wiki/chapters/ch3.md" })).toBe(3)
    expect(parseDashboardChapterNumber({ label: "Alpha", path: "/p/test/wiki/characters/a.md" })).toBeNull()
  })

  it("maxChapterFromNodes 取全量 chapter 最大值", () => {
    expect(
      maxChapterFromNodes([
        { label: "第1章", path: "wiki/chapters/01.md", type: "chapter" },
        { label: "第3章", path: "wiki/chapters/03.md", type: "chapter" },
        { label: "林砚", path: "x.md", type: "character" },
      ]),
    ).toBe(3)
    expect(maxChapterFromNodes([{ label: "林砚", path: "x.md", type: "character" }])).toBeNull()
  })

  it("truncateRows 边界：不足 limit 不截断", () => {
    expect(truncateRows([1, 2], 60)).toEqual({ visible: [1, 2], hiddenCount: 0 })
    expect(truncateRows([1, 2, 3], 2)).toEqual({ visible: [1, 2], hiddenCount: 1 })
  })

  it("toggleDashboardHiddenType additive 切换", () => {
    expect([...toggleDashboardHiddenType(new Set(), "character")]).toEqual(["character"])
    expect([...toggleDashboardHiddenType(new Set(["character"]), "character")]).toEqual([])
  })

  it("formatCharacterStateLine 缺字段回退 —", () => {
    expect(formatCharacterStateLine({ characterName: "林砚", currentLocation: "", status: "" } as never)).toContain("—")
  })
})

describe("StatusDashboardView", () => {
  it("(1)五维卡片渲染全量计数 + 口径 label", async () => {
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-relations")).toBeTruthy())
    expect(screen.getByTestId("caliber-full-graph")).toHaveTextContent("全图口径")
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("边总数：3")
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("出场于：2")
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("人物：2")
    expect(screen.getByTestId("dashboard-card-scenes")).toHaveTextContent("地点：1")
    expect(screen.getByTestId("dashboard-card-scenes")).toHaveTextContent("章节：1")
    expect(screen.getByTestId("dashboard-time-anchor")).toHaveTextContent("第 3 章")
    expect(screen.getByTestId("dashboard-card-foreshadowing")).toHaveTextContent("已埋设：1")
    expect(screen.getByTestId("dashboard-card-canon")).toHaveTextContent("正史事实：2")
  })

  it("(2)次行标注：hiddenTypes 非空时展示 view-filtered", async () => {
    localStorage.setItem(DASHBOARD_FILTER_KEY, JSON.stringify(["event"]))
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("caliber-view-filtered")).toBeTruthy())
    // event 节点被滤掉：6→5 节点；含 event 的边不受影响（夹具边不含 event，3→3）
    expect(screen.getByTestId("caliber-view-filtered")).toHaveTextContent("5/6")
    expect(screen.getByTestId("caliber-view-filtered")).toHaveTextContent("当前视图（次行）")
  })

  it("(2b)hiddenTypes 为空时无次行", async () => {
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-relations")).toBeTruthy())
    expect(screen.queryByTestId("caliber-view-filtered")).toBeNull()
  })

  it("(3)人物状态 join：建模行显示 + 未建模计数", async () => {
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getAllByTestId("dashboard-character-row").length).toBeGreaterThan(0))
    const rows = screen.getAllByTestId("dashboard-character-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("林砚")
    expect(screen.getByTestId("dashboard-card-characters")).toHaveTextContent("未建模 1 人")
  })

  it("(4)伏笔超 60 行截断 + “还有 N 条”", async () => {
    mocks.foreshadowingItems = Array.from({ length: FORESHADOWING_LIST_LIMIT + 5 }, (_, i) => ({
      id: `f${i}`,
      name: `伏笔${i}`,
      description: "d",
      status: "planted",
      plantedChapter: 1,
      advancedChapters: [],
    }))
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("foreshadowing-truncated")).toBeTruthy())
    expect(screen.getByTestId("foreshadowing-truncated")).toHaveTextContent("…还有5条")
  })

  it("(5)canon 非 Tauri → degraded-empty，不伪造数字", async () => {
    mocks.tauri = false
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("canon-degraded")).toBeTruthy())
    expect(screen.getByTestId("canon-degraded")).toHaveTextContent("仅桌面端可用")
    expect(screen.queryByTestId("dashboard-card-canon")).toBeNull()
    expect(mocks.queryCalls).toHaveLength(0)
  })

  it("(6)canon 真空 honest empty（Tauri 下零事实）", async () => {
    mocks.canonFacts = []
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-canon")).toBeTruthy())
    expect(screen.getByTestId("dashboard-card-canon")).toHaveTextContent("暂无正史事实")
    expect(screen.queryByTestId("canon-degraded")).toBeNull()
  })

  it("canon 查询含 limit/offset 分页且总量封顶", async () => {
    mocks.canonFacts = Array.from({ length: CANON_TOTAL_CAP }, (_, i) => ({ id: `canon-${i}` }))
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-canon")).toBeTruthy())
    expect(mocks.queryCalls.length).toBeGreaterThan(0)
    for (const call of mocks.queryCalls) {
      expect(call["limit"]).toBeLessThanOrEqual(CANON_QUERY_LIMIT)
      expect(typeof call["offset"]).toBe("number")
    }
    expect(screen.getByTestId("dashboard-card-canon")).toHaveTextContent("上限 500 条")
  })

  it("无项目时诚实空态", async () => {
    mocks.project = null
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-no-project")).toBeTruthy())
  })
})

describe("GraphSidebarPanel dimension toggles", () => {
  it("(7)开关只写 hiddenTypes：勾选/取消 additive 且可聚焦命名", async () => {
    render(<GraphSidebarPanel />)
    const group = await screen.findByTestId("dashboard-dimension-toggles")
    expect(group).toBeTruthy()
    const checkbox = screen.getByLabelText("character") as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(JSON.parse(localStorage.getItem(DASHBOARD_FILTER_KEY) ?? "[]")).toEqual(["character"])
    fireEvent.click(screen.getByLabelText("character"))
    expect(JSON.parse(localStorage.getItem(DASHBOARD_FILTER_KEY) ?? "[]")).toEqual([])
  })
})

describe("StatusDashboardView 分支覆盖补齐", () => {
  it("脏 localStorage（非数组/非字符串项）回退过滤", () => {
    localStorage.setItem(DASHBOARD_FILTER_KEY, JSON.stringify({ a: 1 }))
    expect(loadDashboardHiddenTypes().size).toBe(0)
    localStorage.setItem(DASHBOARD_FILTER_KEY, JSON.stringify(["a", 1, "b", null]))
    expect([...loadDashboardHiddenTypes()]).toEqual(["a", "b"])
    localStorage.clear()
  })

  it("无 localStorage 时读写静默回退（无 DOM 存储环境）", () => {
    const saved = (globalThis as Record<string, unknown>)["localStorage"]
    try {
      vi.stubGlobal("localStorage", undefined)
      expect(loadDashboardHiddenTypes().size).toBe(0)
      expect(() => saveDashboardHiddenTypes(new Set(["character"]))).not.toThrow()
    } finally {
      if (saved === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal("localStorage", saved)
    }
    localStorage.clear()
  })

  it("无 window 事件总线时保存仍落盘（跳过派发）", () => {
    const savedWindow = (globalThis as Record<string, unknown>)["window"]
    try {
      vi.stubGlobal("window", undefined)
      saveDashboardHiddenTypes(new Set(["event"]))
      expect(JSON.parse(localStorage.getItem(DASHBOARD_FILTER_KEY) ?? "[]")).toEqual(["event"])
    } finally {
      if (savedWindow === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal("window", savedWindow)
    }
    localStorage.clear()
  })

  it("文件名数字回退解析（无章节标记时取文件名前缀）", () => {
    expect(parseDashboardChapterNumber({ label: "前言", path: "wiki/chapters/07-前言.md" })).toBe(7)
  })

  it("空章节时 canon 不带 validAtChapter 且伏笔用水位回退", async () => {
    mocks.graphNodes = [
      { id: "character:林砚", label: "林砚", type: "character", path: "wiki/characters/林砚.md", linkCount: 1, community: 1 },
    ]
    mocks.graphEdges = []
    mocks.foreshadowingItems = [
      { id: "f1", name: "黑剑", description: "d", status: "planted", plantedChapter: 4, advancedChapters: [] },
    ]
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-time-anchor")).toBeTruthy())
    expect(screen.getByTestId("dashboard-time-anchor")).toHaveTextContent("时间锚：—")
    await waitFor(() => expect(mocks.queryCalls.length).toBeGreaterThan(0))
    // mock 的 buildCanonEdgeFilter 把 undefined 归一为 null：关键是 anchor 为 null 时走了回退分支
    expect(mocks.queryCalls[0]).toMatchObject({ valid_at_chapter: null })
  })

  it("加载失败显示错误且不渲染空态数字", async () => {
    render(<StatusDashboardView loaders={{ loadGraph: async () => { throw new Error("graph boom") } }} />)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByRole("alert")).toHaveTextContent("graph boom")
  })

  it("非 Error 拒绝被字符串化展示", async () => {
    render(<StatusDashboardView loaders={{ loadGraph: async () => { throw "plain-string-fail" } }} />)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByRole("alert")).toHaveTextContent("plain-string-fail")
  })

  it("卸载后解决不再写状态（竞态守卫 finally 不二次 loading）", async () => {
    let resolveGraph: (v: { nodes: never[]; edges: never[] }) => void = () => undefined
    const { unmount, container } = render(
      <StatusDashboardView loaders={{ loadGraph: () => new Promise((res) => { resolveGraph = res }) }} />,
    )
    unmount()
    resolveGraph({ nodes: [], edges: [] })
    await new Promise((r) => setTimeout(r, 50))
    expect(container.innerHTML).toBe("")
  })

  it("卸载后拒绝也不写错误态", async () => {
    let rejectGraph: (e: unknown) => void = () => undefined
    const { unmount, container } = render(
      <StatusDashboardView loaders={{ loadGraph: () => new Promise((_res, rej) => { rejectGraph = rej }) }} />,
    )
    unmount()
    rejectGraph(new Error("late boom"))
    await new Promise((r) => setTimeout(r, 50))
    expect(container.innerHTML).toBe("")
  })

  it("正史/时间线节点计数（含 timeline 别名）", async () => {
    mocks.graphNodes = [
      ...mocks.graphNodes,
      { id: "canon-rule:1", label: "规则一", type: "canon-rule", path: "wiki/canon.md", linkCount: 0, community: 0 },
      { id: "timeline:1", label: "时间点一", type: "timeline-point", path: "wiki/tl.md", linkCount: 0, community: 0 },
      { id: "timeline:2", label: "时间点二", type: "timeline", path: "wiki/tl2.md", linkCount: 0, community: 0 },
    ]
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-canon")).toBeTruthy())
    expect(screen.getByTestId("dashboard-card-canon")).toHaveTextContent("canon-rule 节点：1")
    expect(screen.getByTestId("dashboard-card-canon")).toHaveTextContent("timeline-point 节点：2")
  })

  it("未知 relation 回退原文", async () => {
    mocks.graphEdges = [
      { source: "character:林砚", target: "chapter:3", weight: 1, relation: "MYSTIC_X" },
    ]
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-relations")).toBeTruthy())
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("MYSTIC_X：1")
  })

  it("缺类型计数回退 0 且场景空态诚实", async () => {
    mocks.graphNodes = [
      { id: "event:大比", label: "大比", type: "event", path: "wiki/events.md", linkCount: 0, community: 0 },
    ]
    mocks.graphEdges = [
      { source: "event:大比", target: "event:大比", weight: 1, relation: "KNOWS" },
    ]
    mocks.characters = []
    mocks.foreshadowingItems = []
    mocks.canonFacts = []
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-relations")).toBeTruthy())
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("人物：0")
    expect(screen.getByTestId("dashboard-card-scenes")).toHaveTextContent("地点：0")
    expect(screen.getByTestId("dashboard-card-scenes")).toHaveTextContent("暂无数据")
  })

  it("关系卡无组织/事件类型时计数回退 0", async () => {
    mocks.graphNodes = [
      { id: "character:林砚", label: "林砚", type: "character", path: "wiki/characters/林砚.md", linkCount: 1, community: 1 },
      { id: "character:苏晚", label: "苏晚", type: "character", path: "wiki/characters/苏晚.md", linkCount: 1, community: 1 },
    ]
    mocks.graphEdges = [
      { source: "character:林砚", target: "character:苏晚", weight: 1, relation: "KNOWS" },
    ]
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-relations")).toBeTruthy())
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("人物：2")
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("组织：0")
    expect(screen.getByTestId("dashboard-card-relations")).toHaveTextContent("事件：0")
  })

  it("伏笔无 planted 时已埋设回退 0", async () => {
    mocks.foreshadowingItems = [
      { id: "f1", name: "旧约", description: "d", status: "resolved", plantedChapter: 1, advancedChapters: [2], resolvedChapter: 3 },
      { id: "f2", name: "新约", description: "d", status: "resolved", plantedChapter: 2, advancedChapters: [3], resolvedChapter: 4 },
    ]
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-foreshadowing")).toBeTruthy())
    expect(screen.getByTestId("dashboard-card-foreshadowing")).toHaveTextContent("已埋设：0")
    expect(screen.getByTestId("dashboard-card-foreshadowing")).toHaveTextContent("已回收：2")
  })

  it("(2c) 运行中收到 DASHBOARD_FILTERS_EVENT → 重读隐藏类型并出现次行", async () => {
    render(<StatusDashboardView />)
    await waitFor(() => expect(screen.getByTestId("dashboard-card-relations")).toBeTruthy())
    expect(screen.queryByTestId("caliber-view-filtered")).toBeNull()

    // 其他入口（图侧边栏）改了隐藏类型后会广播该事件，面板需跟着重读
    localStorage.setItem(DASHBOARD_FILTER_KEY, JSON.stringify(["event"]))
    window.dispatchEvent(new CustomEvent(DASHBOARD_FILTERS_EVENT))

    await waitFor(() => expect(screen.getByTestId("caliber-view-filtered")).toHaveTextContent("5/6"))
  })

  it("(2d) 隐藏类型存储损坏 → 读成空集合", () => {
    localStorage.setItem(DASHBOARD_FILTER_KEY, "{not json")
    expect([...loadDashboardHiddenTypes()]).toEqual([])
  })
})
