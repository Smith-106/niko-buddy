// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import Graph from "graphology"
import {
  CameraFocusController,
  EventHandler,
  GraphLoader,
  HighlightManager,
  SigmaResizeRefresher,
  __resetGraphLayoutCachesForTests,
} from "./sigma-graph-views"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"

const mocks = vi.hoisted(() => ({
  getContainer: vi.fn(),
  refresh: vi.fn(),
}))

const sigmaState = vi.hoisted(() => ({
  sigmaImpl: null as unknown,
  loadGraph: null as unknown as (...args: unknown[]) => void,
  handlers: {} as Record<string, (...args: never[]) => void>,
  computeLayout: null as unknown as (...args: unknown[]) => Promise<unknown>,
}))

vi.mock("@react-sigma/core", () => ({
  useSigma: () => sigmaState.sigmaImpl ?? { getContainer: mocks.getContainer, refresh: mocks.refresh },
  useLoadGraph: () => (...args: unknown[]) => sigmaState.loadGraph(...args),
  useRegisterEvents: () => (handlers: Record<string, (...args: never[]) => void>) => {
    sigmaState.handlers = handlers
  },
}))

vi.mock("./use-graph-layout-worker", () => ({
  useGraphLayoutWorker: () => ({ computeLayout: sigmaState.computeLayout }),
}))

type ROCallback = () => void

interface SeenObserver {
  callback: ROCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

function installResizeObserver(): SeenObserver[] {
  const seen: SeenObserver[] = []
  class FakeResizeObserver {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    constructor(callback: ROCallback) {
      seen.push({ callback, observe: this.observe, disconnect: this.disconnect })
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  return seen
}

describe("SigmaResizeRefresher", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getContainer.mockReturnValue(document.createElement("div"))
    mocks.refresh.mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("缺 ResizeObserver 时静默跳过", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    render(<SigmaResizeRefresher />)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("非 Element 容器（测试替身）时不监听不崩", () => {
    installResizeObserver()
    mocks.getContainer.mockReturnValue({ style: {} })
    render(<SigmaResizeRefresher />)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("getContainer 抛错时静默跳过", () => {
    installResizeObserver()
    mocks.getContainer.mockImplementation(() => {
      throw new Error("no sigma")
    })
    expect(() => render(<SigmaResizeRefresher />)).not.toThrow()
  })

  it("高频 resize 收敛为一次 refresh（防抖）", async () => {
    vi.useFakeTimers()
    try {
      const seen = installResizeObserver()
      render(<SigmaResizeRefresher debounceMs={50} />)
      expect(seen).toHaveLength(1)
      expect(seen[0].observe).toHaveBeenCalledTimes(1)
      const fire = seen[0].callback
      await act(async () => {
        fire()
        fire()
        fire()
      })
      expect(mocks.refresh).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(mocks.refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("refresh 抛错时吞掉不崩", async () => {
    vi.useFakeTimers()
    try {
      const seen = installResizeObserver()
      mocks.refresh.mockImplementation(() => {
        throw new Error("not ready")
      })
      render(<SigmaResizeRefresher debounceMs={50} />)
      await act(async () => {
        seen[0].callback()
      })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(mocks.refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("卸载时清理 timer 与 observer", async () => {
    vi.useFakeTimers()
    try {
      const seen = installResizeObserver()
      let unmount!: () => void
      await act(async () => {
        ;({ unmount } = render(<SigmaResizeRefresher debounceMs={50} />))
      })
      await act(async () => {
        seen[0].callback()
      })
      await act(async () => {
        unmount()
      })
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect(seen[0].disconnect).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

function fireHandler(name: string, payload?: unknown): void {
  const handler = sigmaState.handlers[name] as unknown as ((payload?: unknown) => void) | undefined
  if (!handler) throw new Error(`handler ${name} not registered`)
  act(() => {
    handler(payload)
  })
}

function makeLoaderNodes(): GraphNode[] {
  return [
    { id: "a", label: "A", type: "character", path: "/a.md", linkCount: 2, community: 0 },
    { id: "b", label: "B", type: "character", path: "/b.md", linkCount: 1, community: 1 },
  ]
}

function makeLoaderEdges(): GraphEdge[] {
  return [{ source: "a", target: "b", weight: 1 }]
}

const GRAPH_VISUAL_TIER = {
  baseNodeSize: 5,
  maxNodeSize: 15,
  minEdgeSize: 0.5,
  maxEdgeSize: 2.5,
  minEdgeAlpha: 0.2,
  maxEdgeAlpha: 0.9,
}

function renderLoader(props: {
  nodes?: GraphNode[]
  edges?: GraphEdge[]
  onLayoutSettled?: () => void
  refresh?: ReturnType<typeof vi.fn>
  loadGraph?: (graph: Graph) => void
  sigmaImpl?: unknown
}): void {
  const sigmaImpl = props.sigmaImpl ?? {
    getContainer: () => document.createElement("div"),
    refresh: props.refresh ?? vi.fn(),
    getGraph: () => {
      throw new Error("not ready")
    },
    getCamera: () => ({ animate: vi.fn() }),
  }
  sigmaState.sigmaImpl = sigmaImpl
  render(
    <GraphLoader
      nodes={props.nodes ?? makeLoaderNodes()}
      edges={props.edges ?? makeLoaderEdges()}
      colorMode="type"
      novelMode={false}
      graphMode="overview"
      labelDisplayMode="all"
      edgeColorHex="#7f8ea3"
      edgeStrengthPercent={100}
      edgeLabelsAlwaysVisible={false}
      visualSettings={GRAPH_VISUAL_TIER}
      foreshadowingStatusMap={new Map()}
      layoutPreset="compact"
      onLayoutSettled={props.onLayoutSettled}
    />,
  )
}

describe("GraphLoader — 覆盖补齐", () => {
  let refresh: ReturnType<typeof vi.fn>
  let liveGraph: Graph | null
  let resolveCompute: ((positions: Record<string, { x: number; y: number }>) => void) | null

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    __resetGraphLayoutCachesForTests()
    vi.useFakeTimers()
    vi.stubGlobal("requestAnimationFrame", undefined)
    refresh = vi.fn()
    liveGraph = null
    resolveCompute = null
    sigmaState.sigmaImpl = null
    sigmaState.handlers = {}
    sigmaState.loadGraph = ((graph: Graph) => {
      liveGraph = graph
    }) as (...args: unknown[]) => void
    sigmaState.computeLayout = (() =>
      new Promise<unknown>((resolve) => {
        resolveCompute = resolve as (positions: Record<string, { x: number; y: number }>) => void
      })) as (...args: unknown[]) => Promise<unknown>
  })

  afterEach(() => {
    cleanup()
    sigmaState.sigmaImpl = null
    sigmaState.handlers = {}
    resolveCompute = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("主路径（setTimeout 回退时钟）：tween 完整落定并通知 settled，最终坐标等于 worker 输出", async () => {
    const settled = vi.fn()
    const realPositions = { a: { x: 5, y: 6 }, b: { x: 50, y: 60 } }
    sigmaState.computeLayout = (() => Promise.resolve(realPositions)) as (...args: unknown[]) => Promise<unknown>
    renderLoader({ onLayoutSettled: settled, refresh })
    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(settled).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls.length).toBeGreaterThan(5)
    expect((liveGraph as unknown as Graph).getNodeAttribute("a", "x")).toBe(5)
    expect((liveGraph as unknown as Graph).getNodeAttribute("b", "y")).toBe(60)
  })

  it("空 positions 走快捷路径：refresh 后通知 settled", async () => {
    const settled = vi.fn()
    sigmaState.computeLayout = (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>
    renderLoader({ onLayoutSettled: settled, refresh })
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalled()
  })

  it("节点属性非数字时回退 end 坐标", async () => {
    const settled = vi.fn()
    renderLoader({ onLayoutSettled: settled, refresh })
    await act(async () => {
      await Promise.resolve()
    })
    expect(liveGraph).not.toBeNull()
    ;(liveGraph as unknown as Graph).setNodeAttribute("a", "x", "oops")
    await act(async () => {
      resolveCompute?.({ a: { x: 9, y: 9 }, b: { x: 20, y: 20 } })
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(settled).toHaveBeenCalledTimes(1)
    expect((liveGraph as unknown as Graph).getNodeAttribute("a", "x")).toBe(9)
  })

  it("performance.now 不可用时回退 Date.now 仍能落定", async () => {
    vi.stubGlobal("performance", undefined)
    const settled = vi.fn()
    renderLoader({ onLayoutSettled: settled, refresh })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      resolveCompute?.({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } })
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it("拖拽节点在 tween 与最终回填时被跳过；拖拽中 click/doubleClick 被吞", async () => {
    const onNodeClick = vi.fn()
    const onNodeDoubleClick = vi.fn()
    const onNodeContextMenu = vi.fn()
    const settled = vi.fn()
    const container = document.createElement("div")
    const workingSigma = {
      getContainer: () => container,
      refresh,
      getGraph: () => {
        if (!liveGraph) throw new Error("not ready")
        return liveGraph
      },
      getCamera: () => ({ animate: vi.fn() }),
      viewportToGraph: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      setSetting: vi.fn(),
    }
    renderLoader({ onLayoutSettled: settled, refresh, sigmaImpl: workingSigma })
    render(
      <EventHandler
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
      />,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(liveGraph).not.toBeNull()
    // 第一轮拖拽：拖拽中的 doubleClick 被吞（one-shot 标记被消费）
    fireHandler("downNode", {
      node: "a",
      event: { original: { button: 0, preventDefault: vi.fn() } },
      preventSigmaDefault: vi.fn(),
    })
    fireHandler("mousemovebody", { x: 11, y: 22 })
    fireHandler("doubleClickNode", { node: "a" })
    expect(onNodeDoubleClick).not.toHaveBeenCalled()
    fireHandler("mouseup", {})
    // 第二轮拖拽：拖拽中的 click 被吞
    fireHandler("downNode", {
      node: "a",
      event: { original: { button: 0, preventDefault: vi.fn() } },
      preventSigmaDefault: vi.fn(),
    })
    fireHandler("mousemovebody", { x: 13, y: 24 })
    fireHandler("clickNode", { node: "a" })
    expect(onNodeClick).not.toHaveBeenCalled()
    await act(async () => {
      resolveCompute?.({ a: { x: 100, y: 100 }, b: { x: 200, y: 200 } })
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(settled).toHaveBeenCalledTimes(1)
    expect((liveGraph as unknown as Graph).getNodeAttribute("a", "x")).toBe(13)
    expect((liveGraph as unknown as Graph).getNodeAttribute("b", "x")).toBe(200)
    fireHandler("mouseup", {})
    fireHandler("clickNode", { node: "a" })
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith("a")
  })
})

describe("CameraFocusController — 覆盖补齐", () => {
  let animate: ReturnType<typeof vi.fn>

  function setupCamera(graph: Graph): void {
    animate = vi.fn()
    sigmaState.sigmaImpl = {
      getContainer: () => document.createElement("div"),
      refresh: vi.fn(),
      getGraph: () => graph,
      getCamera: () => ({ animate }),
    }
  }

  function twoNodeGraph(): Graph {
    const graph = new Graph()
    graph.addNode("a", { x: 10, y: 20 })
    graph.addNode("b", { x: 30, y: 40 })
    return graph
  }

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    sigmaState.handlers = {}
  })

  afterEach(() => {
    cleanup()
    sigmaState.sigmaImpl = null
  })

  it("target 为空直接返回", () => {
    setupCamera(twoNodeGraph())
    render(<CameraFocusController targetNodeId={null} nonce={1} />)
    expect(animate).not.toHaveBeenCalled()
  })

  it("图中无目标节点直接返回", () => {
    setupCamera(twoNodeGraph())
    render(<CameraFocusController targetNodeId="ghost" nonce={1} />)
    expect(animate).not.toHaveBeenCalled()
  })

  it("坐标非数字直接返回", () => {
    const graph = twoNodeGraph()
    graph.setNodeAttribute("a", "x", "oops")
    setupCamera(graph)
    render(<CameraFocusController targetNodeId="a" nonce={1} />)
    expect(animate).not.toHaveBeenCalled()
  })

  it("首次飞入使用 400ms；同 nonce 下坐标不动不再重飞", () => {
    setupCamera(twoNodeGraph())
    const { rerender } = render(<CameraFocusController targetNodeId="a" nonce={5} />)
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledWith({ x: 10, y: 20, ratio: 0.25 }, { duration: 400 })
    rerender(<CameraFocusController targetNodeId="a" nonce={5} layoutSignal={1} />)
    expect(animate).toHaveBeenCalledTimes(1)
  })

  it("layoutSignal 变化且坐标移动后按 250ms 重飞", () => {
    const graph = twoNodeGraph()
    setupCamera(graph)
    const { rerender } = render(<CameraFocusController targetNodeId="a" nonce={5} />)
    expect(animate).toHaveBeenCalledTimes(1)
    graph.setNodeAttribute("a", "x", 99)
    rerender(<CameraFocusController targetNodeId="a" nonce={5} layoutSignal={1} />)
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenLastCalledWith({ x: 99, y: 20, ratio: 0.25 }, { duration: 250 })
  })
})

describe("HighlightManager — 覆盖补齐", () => {
  let refresh: ReturnType<typeof vi.fn>

  function graphWithEdge(): Graph {
    const graph = new Graph()
    graph.addNode("a", { x: 0, y: 0 })
    graph.addNode("b", { x: 1, y: 1 })
    graph.addEdge("a", "b")
    return graph
  }

  function setupHighlight(graph: () => Graph): void {
    sigmaState.sigmaImpl = {
      getContainer: () => document.createElement("div"),
      refresh,
      getGraph: graph,
      getCamera: () => ({ animate: vi.fn() }),
    }
  }

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    refresh = vi.fn()
  })

  afterEach(() => {
    cleanup()
    sigmaState.sigmaImpl = null
  })

  it("非 Set 高亮输入回退空集合并正常刷新", () => {
    setupHighlight(() => graphWithEdge())
    render(<HighlightManager highlightedNodes={undefined as unknown as Set<string>} />)
    expect(refresh).toHaveBeenCalled()
  })

  it("getGraph 抛错时跳过本轮不崩", () => {
    setupHighlight(() => {
      throw new Error("not ready")
    })
    expect(() => render(<HighlightManager highlightedNodes={new Set(["a"])} />)).not.toThrow()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("空图跳过高亮与刷新", () => {
    setupHighlight(() => new Graph())
    render(<HighlightManager highlightedNodes={new Set(["a"])} />)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("refresh 抛错时吞掉不崩", () => {
    refresh.mockImplementation(() => {
      throw new Error("remounting")
    })
    setupHighlight(() => graphWithEdge())
    expect(() => render(<HighlightManager highlightedNodes={new Set(["a"])} />)).not.toThrow()
    expect(refresh).toHaveBeenCalled()
  })
})

describe("EventHandler — 覆盖补齐", () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    sigmaState.handlers = {}
  })

  afterEach(() => {
    cleanup()
    sigmaState.sigmaImpl = null
  })

  it("未传 highlightedNodes 时 leaveNode 恢复空基准", () => {
    const container = document.createElement("div")
    const graph = new Graph()
    graph.addNode("a", { x: 0, y: 0 })
    graph.addNode("b", { x: 1, y: 1 })
    graph.addNode("c", { x: 2, y: 2 })
    graph.addEdge("a", "b")
    const refresh = vi.fn()
    sigmaState.sigmaImpl = {
      getContainer: () => container,
      refresh,
      getGraph: () => graph,
      getCamera: () => ({ animate: vi.fn() }),
      viewportToGraph: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      setSetting: vi.fn(),
    }
    render(<EventHandler onNodeClick={vi.fn()} onNodeDoubleClick={vi.fn()} onNodeContextMenu={vi.fn()} />)
    fireHandler("enterNode", { node: "a" })
    expect(graph.getNodeAttribute("a", "hovering")).toBe(true)
    // b 与 a 相邻 → 留在悬停集合；c 不相邻 → 置灰
    expect(graph.getNodeAttribute("c", "dimmed")).toBe(true)
    expect(graph.getNodeAttribute("b", "dimmed")).toBeUndefined()
    fireHandler("leaveNode", {})
    expect(graph.getNodeAttribute("a", "hovering")).toBeUndefined()
    expect(graph.getNodeAttribute("c", "dimmed")).toBeUndefined()
  })
})

