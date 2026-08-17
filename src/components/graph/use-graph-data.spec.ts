// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setupDomGlobals } from "@/test-helpers/component-test-utils"
import { useGraphData } from "./use-graph-data"
import type { GraphNode, GraphEdge, CommunityInfo } from "@/lib/wiki-graph"

interface WikiStateLike {
  project: { id: string; name: string; path: string } | null
  dataVersion: number
  setRefreshGraph: (fn: (() => void) | null) => void
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    project: null,
    dataVersion: 0,
    setRefreshGraph: vi.fn(),
  }
  return {
    state,
    buildWikiGraph: vi.fn(),
    findSurprisingConnections: vi.fn(),
    detectKnowledgeGaps: vi.fn(),
    loadForeshadowingTracker: vi.fn(),
    t: vi.fn((key: string) => key),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: WikiStateLike) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/wiki-graph", () => ({
  buildWikiGraph: mocks.buildWikiGraph,
}))

vi.mock("@/lib/graph-insights", () => ({
  findSurprisingConnections: mocks.findSurprisingConnections,
  detectKnowledgeGaps: mocks.detectKnowledgeGaps,
}))

vi.mock("@/lib/novel/foreshadowing-tracker", () => ({
  loadForeshadowingTracker: mocks.loadForeshadowingTracker,
}))

const NODES: GraphNode[] = [
  { id: "n1", label: "甲", type: "character", path: "/p/wiki/甲.md", linkCount: 2, community: 0 },
]
const EDGES: GraphEdge[] = [{ source: "n1", target: "n2", weight: 1 }]
const COMMUNITIES: CommunityInfo[] = [{ id: 0, nodeCount: 1, cohesion: 1, topNodes: ["甲"] }]

const PROJECT = { id: "p1", name: "Book", path: "/p" }

describe("useGraphData", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.project = null
    mocks.state.dataVersion = 0
    mocks.buildWikiGraph.mockResolvedValue({ nodes: NODES, edges: EDGES, communities: COMMUNITIES })
    mocks.findSurprisingConnections.mockReturnValue([{ key: "sc1", score: 1 }] as never)
    mocks.detectKnowledgeGaps.mockReturnValue([{ type: "isolated-node", title: "孤立" }] as never)
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "t" })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("无 project：loadGraph 提前返回，不加载图/伏笔；卸载时注销 refresh", async () => {
    const { result, unmount } = renderHook(() => useGraphData())
    await act(async () => {})

    expect(mocks.state.setRefreshGraph).toHaveBeenCalledTimes(1)
    expect(mocks.buildWikiGraph).not.toHaveBeenCalled()
    expect(mocks.loadForeshadowingTracker).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()

    // dataVersion 0 !== lastLoadedVersion(-1) → loadGraph 被调用，但 project 为空直接 return（async fn 仍返回 resolved Promise）
    await expect(result.current.loadGraph()).resolves.toBeUndefined()
    expect(result.current.loading).toBe(false)

    unmount()
    expect(mocks.state.setRefreshGraph).toHaveBeenLastCalledWith(null)
  })

  it("有 project：加载成功填充 nodes/edges/communities/洞察，并同步 dataVersion", async () => {
    mocks.state.project = PROJECT
    mocks.state.dataVersion = 5
    const { result, unmount } = renderHook(() => useGraphData())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mocks.buildWikiGraph).toHaveBeenCalledWith("/p")
    expect(result.current.nodes).toEqual(NODES)
    expect(result.current.edges).toEqual(EDGES)
    expect(result.current.communities).toEqual(COMMUNITIES)
    expect(mocks.findSurprisingConnections).toHaveBeenCalledWith(NODES, EDGES, COMMUNITIES)
    expect(result.current.surprisingConns).toEqual([{ key: "sc1", score: 1 }])
    expect(mocks.detectKnowledgeGaps).toHaveBeenCalledWith(NODES, EDGES, COMMUNITIES)
    expect(result.current.knowledgeGaps).toEqual([{ type: "isolated-node", title: "孤立" }])
    await waitFor(() => expect(result.current.foreshadowingStore).toEqual({ items: [], lastUpdated: "t" }))
    expect(mocks.loadForeshadowingTracker).toHaveBeenCalledWith("/p")

    // loading 期间为 true 再回落
    expect(result.current.loading).toBe(false)
    unmount()
  })

  it("dataVersion 变化触发重载（lastLoadedVersion 已同步则不重载）", async () => {
    mocks.state.project = PROJECT
    mocks.state.dataVersion = 5
    const { result, rerender, unmount } = renderHook(() => useGraphData())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(1)

    // dataVersion 从 5 → 6：5 !== 6 → 重载
    mocks.state.dataVersion = 6
    rerender()
    await waitFor(() => expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(2))

    // project 换成新对象但 dataVersion 不变 → effect 重跑但 lastLoadedVersion 相同 → 跳过
    mocks.state.project = { id: "p2", name: "Book2", path: "/p2" }
    rerender()
    await act(async () => {})
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("buildWikiGraph 失败：Error 实例取 message，非 Error 回退翻译文案", async () => {
    mocks.state.project = PROJECT
    mocks.buildWikiGraph.mockRejectedValueOnce(new Error("graph-boom"))
    const first = renderHook(() => useGraphData())
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.error).toBe("graph-boom")
    first.unmount()

    mocks.buildWikiGraph.mockRejectedValueOnce("raw-failure")
    const second = renderHook(() => useGraphData())
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    expect(second.result.current.error).toBe("graph.buildFailed")
    expect(mocks.t).toHaveBeenCalledWith("graph.buildFailed")
    second.unmount()
  })

  it("loadForeshadowingTracker 失败 → foreshadowingStore 置 null", async () => {
    mocks.state.project = PROJECT
    mocks.loadForeshadowingTracker.mockRejectedValue(new Error("no-store"))
    const { result, unmount } = renderHook(() => useGraphData())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.foreshadowingStore).toBeNull()
    expect(result.current.nodes).toEqual(NODES)
    unmount()
  })

  it("setRefreshGraph 注册的 loadGraph 可直接调用并返回 Promise", async () => {
    mocks.state.project = PROJECT
    const { result, unmount } = renderHook(() => useGraphData())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(1)

    // setRefreshGraph 收到的是 `() => loadGraph`（返回 loadGraph 的箭头函数）
    const register = mocks.state.setRefreshGraph.mock.calls[0]?.[0] as () => () => Promise<void>
    expect(typeof register).toBe("function")
    const loadFn = register()
    await act(async () => {
      await loadFn()
    })
    expect(mocks.buildWikiGraph).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(false)
    unmount()
  })
})
