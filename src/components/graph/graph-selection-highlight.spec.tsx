// @vitest-environment jsdom
// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { CameraFocusController, EventHandler, HighlightManager } from "./sigma-graph-views"

/** 最小 graphology 替身：只实现 HighlightManager/CameraFocusController 触达的 API。 */
class FakeGraph {
  nodeAttrs = new Map<string, Record<string, unknown>>()
  edgeAttrs = new Map<string, Record<string, unknown>>()
  edges: Array<{ id: string; source: string; target: string }> = []

  constructor(nodeIds: string[], edges: Array<[string, string]> = []) {
    for (const id of nodeIds) this.nodeAttrs.set(id, { x: 1, y: 2 })
    edges.forEach(([source, target], index) => {
      const id = `e${index}`
      this.edges.push({ id, source, target })
      this.edgeAttrs.set(id, {})
    })
  }

  get order(): number {
    return this.nodeAttrs.size
  }

  hasNode(id: string): boolean {
    return this.nodeAttrs.has(id)
  }

  hasEdge(id: string): boolean {
    return this.edgeAttrs.has(id)
  }

  neighbors(id: string): string[] {
    if (!this.nodeAttrs.has(id)) throw new Error(`graphology: node ${id} not found`)
    const found: string[] = []
    for (const edge of this.edges) {
      if (edge.source === id) found.push(edge.target)
      else if (edge.target === id) found.push(edge.source)
    }
    return found
  }

  getNodeAttributes(id: string): Record<string, unknown> {
    return this.nodeAttrs.get(id) ?? {}
  }

  setNodeAttribute(id: string, key: string, value: unknown): void {
    this.nodeAttrs.set(id, { ...(this.nodeAttrs.get(id) ?? {}), [key]: value })
  }

  removeNodeAttribute(id: string, key: string): void {
    const attrs = this.nodeAttrs.get(id)
    if (!attrs) return
    delete attrs[key]
  }

  setEdgeAttribute(id: string, key: string, value: unknown): void {
    this.edgeAttrs.set(id, { ...(this.edgeAttrs.get(id) ?? {}), [key]: value })
  }

  removeEdgeAttribute(id: string, key: string): void {
    const attrs = this.edgeAttrs.get(id)
    if (!attrs) return
    delete attrs[key]
  }

  forEachNode(cb: (id: string) => void): void {
    for (const id of this.nodeAttrs.keys()) cb(id)
  }

  forEachEdge(cb: (id: string, attrs: Record<string, unknown>, source: string, target: string) => void): void {
    for (const edge of this.edges) cb(edge.id, this.edgeAttrs.get(edge.id) ?? {}, edge.source, edge.target)
  }
}

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  animate: vi.fn(),
  setSetting: vi.fn(),
  container: null as unknown,
  events: {} as Record<string, (...a: unknown[]) => void>,
  graph: null as unknown,
  graphThrows: false,
}))

vi.mock("@react-sigma/core", () => ({
  useSigma: () => ({
    getGraph: () => {
      if (mocks.graphThrows) throw new Error("sigma not ready")
      return mocks.graph
    },
    getCamera: () => ({ animate: mocks.animate }),
    refresh: mocks.refresh,
    getContainer: () => mocks.container,
    setSetting: mocks.setSetting,
    viewportToGraph: (p: unknown) => p,
  }),
  useRegisterEvents: () => (handlers: Record<string, (...a: unknown[]) => void>) => {
    for (const [key, handler] of Object.entries(handlers)) mocks.events[key] = handler
  },
}))

function setGraph(graph: FakeGraph | null): void {
  mocks.graph = graph
}

describe("HighlightManager selectedNodeId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.graphThrows = false
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it("highlights the selected node plus its 1-hop neighbors and dims everything else", () => {
    const graph = new FakeGraph(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "c"],
    ])
    setGraph(graph)

    act(() => {
      render(<HighlightManager highlightedNodes={new Set()} selectedNodeId="b" />)
    })

    // b 的 1 度邻居 = a, c；d 应被置灰
    expect(graph.nodeAttrs.get("b")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("a")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("c")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("d")?.dimmed).toBe(true)
    expect(graph.nodeAttrs.get("b")?.dimmed).toBeUndefined()

    // 两端都在高亮集合内的边 highlighted，a-b 在内、b-c 在内
    expect(graph.edgeAttrs.get("e0")?.highlighted).toBe(true)
    expect(graph.edgeAttrs.get("e1")?.highlighted).toBe(true)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it("dims edges that do not touch the selected neighborhood", () => {
    const graph = new FakeGraph(["a", "b", "c", "d"], [
      ["a", "b"],
      ["c", "d"],
    ])
    setGraph(graph)

    act(() => {
      render(<HighlightManager highlightedNodes={new Set()} selectedNodeId="a" />)
    })

    expect(graph.edgeAttrs.get("e0")?.highlighted).toBe(true)
    expect(graph.edgeAttrs.get("e1")?.dimmed).toBe(true)
  })

  it("keeps an isolated selected node highlighted without throwing", () => {
    const graph = new FakeGraph(["solo"])
    setGraph(graph)

    act(() => {
      render(<HighlightManager highlightedNodes={new Set()} selectedNodeId="solo" />)
    })

    expect(graph.nodeAttrs.get("solo")?.insightHighlight).toBe(true)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it("ignores a selectedNodeId that is not present in the graph", () => {
    const graph = new FakeGraph(["a", "b"], [["a", "b"]])
    setGraph(graph)

    act(() => {
      render(<HighlightManager highlightedNodes={new Set(["a"])} selectedNodeId="missing" />)
    })

    // 回落到批量高亮集合：a 高亮、b 置灰
    expect(graph.nodeAttrs.get("a")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("b")?.dimmed).toBe(true)
  })

  it("skips work when the sigma graph is not ready yet", () => {
    mocks.graphThrows = true

    act(() => {
      render(<HighlightManager highlightedNodes={new Set(["a"])} selectedNodeId="a" />)
    })

    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})

describe("CameraFocusController", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.graphThrows = false
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it("animates the camera to the target node coordinates", () => {
    const graph = new FakeGraph(["a"])
    graph.nodeAttrs.set("a", { x: 12, y: -34 })
    setGraph(graph)

    act(() => {
      render(<CameraFocusController targetNodeId="a" nonce={1} />)
    })

    expect(mocks.animate).toHaveBeenCalledWith({ x: 12, y: -34, ratio: 0.25 }, { duration: 400 })
  })

  it("does nothing when targetNodeId is null", () => {
    setGraph(new FakeGraph(["a"]))

    act(() => {
      render(<CameraFocusController targetNodeId={null} nonce={1} />)
    })

    expect(mocks.animate).not.toHaveBeenCalled()
  })

  it("does nothing when the target node is absent from the rendered graph", () => {
    setGraph(new FakeGraph(["a"]))

    act(() => {
      render(<CameraFocusController targetNodeId="ghost" nonce={1} />)
    })

    expect(mocks.animate).not.toHaveBeenCalled()
  })

  it("does nothing when node coordinates are missing", () => {
    const graph = new FakeGraph([])
    graph.nodeAttrs.set("a", {})
    setGraph(graph)

    act(() => {
      render(<CameraFocusController targetNodeId="a" nonce={1} />)
    })

    expect(mocks.animate).not.toHaveBeenCalled()
  })

  it("re-animates the same node when nonce changes", () => {
    const graph = new FakeGraph(["a"])
    setGraph(graph)

    const { rerender } = render(<CameraFocusController targetNodeId="a" nonce={1} />)
    expect(mocks.animate).toHaveBeenCalledTimes(1)

    rerender(<CameraFocusController targetNodeId="a" nonce={2} />)
    expect(mocks.animate).toHaveBeenCalledTimes(2)
  })
})

describe("EventHandler 选中态与拖拽交互", () => {
  function renderHandler(overrides: {
    onNodeClick?: () => void
    onStageClick?: () => void
    highlightedNodes?: Set<string>
    selectedNodeId?: string | null
  } = {}) {
    const onNodeClick = overrides.onNodeClick ?? vi.fn()
    const onStageClick = overrides.onStageClick ?? vi.fn()
    render(
      <EventHandler
        onNodeClick={onNodeClick}
        onNodeDoubleClick={vi.fn()}
        onNodeContextMenu={vi.fn()}
        onStageClick={onStageClick}
        highlightedNodes={overrides.highlightedNodes}
        selectedNodeId={overrides.selectedNodeId}
      />,
    )
    return { onNodeClick, onStageClick }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.graphThrows = false
    mocks.events = {}
    mocks.container = document.createElement("div")
    setGraph(new FakeGraph(["a", "b"], [["a", "b"]]))
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it("restores the selection baseline synchronously on leaveNode (hover 置灰不再被抹掉)", () => {
    const graph = new FakeGraph(["a", "b", "c"], [["a", "b"]])
    setGraph(graph)
    renderHandler({ selectedNodeId: "a" })

    // enterNode 建立 hover 态：非邻居 c 置灰、a-b 边高亮
    act(() => {
      mocks.events.enterNode?.({ node: "a" })
    })
    expect(graph.nodeAttrs.get("c")?.dimmed).toBe(true)

    // leaveNode 必须同步恢复“选中 + 1 度邻居”基准态：a 高亮、c 仍置灰
    act(() => {
      mocks.events.leaveNode?.({})
    })
    expect(graph.nodeAttrs.get("a")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("b")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("c")?.dimmed).toBe(true)
    expect(graph.nodeAttrs.get("a")?.hovering).toBeUndefined()
  })

  it("clears highlight attributes on leaveNode when there is no selection or bulk highlight", () => {
    const graph = new FakeGraph(["a", "b"], [["a", "b"]])
    setGraph(graph)
    renderHandler({})

    act(() => {
      mocks.events.enterNode?.({ node: "a" })
    })
    act(() => {
      mocks.events.leaveNode?.({})
    })

    expect(graph.nodeAttrs.get("a")?.dimmed).toBeUndefined()
    expect(graph.nodeAttrs.get("a")?.insightHighlight).toBeUndefined()
    expect(graph.edgeAttrs.get("e0")?.highlighted).toBeUndefined()
  })

  it("keeps the bulk highlight baseline alive across hover on leaveNode", () => {
    const graph = new FakeGraph(["a", "b", "c"], [["a", "b"]])
    setGraph(graph)
    renderHandler({ highlightedNodes: new Set(["a"]) })

    act(() => {
      mocks.events.enterNode?.({ node: "a" })
    })
    act(() => {
      mocks.events.leaveNode?.({})
    })

    expect(graph.nodeAttrs.get("a")?.insightHighlight).toBe(true)
    expect(graph.nodeAttrs.get("b")?.dimmed).toBe(true)
  })

  it("fires onStageClick when the empty stage is clicked", () => {
    const { onStageClick } = renderHandler()

    act(() => {
      mocks.events.clickStage?.({})
    })
    expect(onStageClick).toHaveBeenCalledTimes(1)
  })

  it("swallows a stage click that arrives while a drag is still in flight", () => {
    const { onStageClick } = renderHandler()

    act(() => {
      mocks.events.downNode?.({ node: "a", preventSigmaDefault: vi.fn(), event: { original: { button: 0, preventDefault: vi.fn() } } })
    })
    act(() => {
      mocks.events.mousemovebody?.({ x: 10, y: 10 })
    })

    act(() => {
      mocks.events.clickStage?.({})
    })
    expect(onStageClick).not.toHaveBeenCalled()
  })

  it("resets the drag guard on mouseup so the next stage click works again", () => {
    const { onStageClick } = renderHandler()

    act(() => {
      mocks.events.downNode?.({ node: "a", preventSigmaDefault: vi.fn(), event: { original: { button: 0, preventDefault: vi.fn() } } })
    })
    act(() => {
      mocks.events.mousemovebody?.({ x: 10, y: 10 })
    })
    act(() => {
      mocks.events.mouseup?.({})
    })
    // 真实拖拽后 sigma 不派发 click（draggedEvents 超容差），
    // 因此必须在 mouseup 复位，否则下一次空白点击会被误吞。
    act(() => {
      mocks.events.clickStage?.({})
    })
    expect(onStageClick).toHaveBeenCalledTimes(1)
  })
})

describe("CameraFocusController 布局校正", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.graphThrows = false
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it("re-animates with the settled coordinates when layoutSignal changes", () => {
    const graph = new FakeGraph(["a"])
    graph.nodeAttrs.set("a", { x: 0, y: 0 })
    setGraph(graph)

    const { rerender } = render(<CameraFocusController targetNodeId="a" nonce={1} layoutSignal={0} />)
    expect(mocks.animate).toHaveBeenCalledTimes(1)
    expect(mocks.animate).toHaveBeenLastCalledWith({ x: 0, y: 0, ratio: 0.25 }, { duration: 400 })

    // 布局 tween 落定：坐标改写 + layoutSignal 递增
    graph.nodeAttrs.set("a", { x: 120, y: -80 })
    rerender(<CameraFocusController targetNodeId="a" nonce={1} layoutSignal={1} />)

    expect(mocks.animate).toHaveBeenCalledTimes(2)
    expect(mocks.animate).toHaveBeenLastCalledWith({ x: 120, y: -80, ratio: 0.25 }, { duration: 250 })
  })

  it("skips the correction when layout settles without moving the node", () => {
    const graph = new FakeGraph(["a"])
    setGraph(graph)

    const { rerender } = render(<CameraFocusController targetNodeId="a" nonce={1} layoutSignal={0} />)
    rerender(<CameraFocusController targetNodeId="a" nonce={1} layoutSignal={1} />)

    expect(mocks.animate).toHaveBeenCalledTimes(1)
  })

  it("re-animates the same node on a new nonce even when coordinates are unchanged", () => {
    const graph = new FakeGraph(["a"])
    setGraph(graph)

    const { rerender } = render(<CameraFocusController targetNodeId="a" nonce={1} layoutSignal={0} />)
    rerender(<CameraFocusController targetNodeId="a" nonce={2} layoutSignal={0} />)

    expect(mocks.animate).toHaveBeenCalledTimes(2)
    expect(mocks.animate).toHaveBeenLastCalledWith({ x: 1, y: 2, ratio: 0.25 }, { duration: 400 })
  })
})
