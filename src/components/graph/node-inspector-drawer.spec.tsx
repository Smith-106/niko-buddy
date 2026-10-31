// @vitest-environment jsdom
// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { NodeInspectorDrawer } from "./node-inspector-drawer"
import type { GraphNode, GraphEdge } from "@/lib/wiki-graph"

describe("NodeInspectorDrawer", () => {
  const mockNodes: GraphNode[] = [
    { id: "node-1", label: "林动", type: "character", path: "characters/lin-dong.md", linkCount: 2, community: 1 },
    { id: "node-2", label: "绫清竹", type: "character", path: "characters/ling-qingzhu.md", linkCount: 1, community: 1 },
    { id: "node-3", label: "天妖貂", type: "beast", path: "beasts/diao.md", linkCount: 1, community: 2 },
  ]

  const mockEdges: GraphEdge[] = [
    { source: "node-1", target: "node-2", weight: 0.9, relation: "道侣" },
    { source: "node-3", target: "node-1", weight: 0.8, relation: "生死相随" },
  ]

  beforeEach(() => {
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  it("renders nothing when node is null", () => {
    const { container } = render(
      <NodeInspectorDrawer
        node={null}
        nodes={mockNodes}
        edges={mockEdges}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders node basic info and attributes", () => {
    render(
      <NodeInspectorDrawer
        node={mockNodes[0]}
        nodes={mockNodes}
        edges={mockEdges}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId("inspector-node-label")).toHaveTextContent("林动")
    expect(screen.getByTestId("inspector-node-type")).toHaveTextContent("character")
    expect(screen.getByText("characters/lin-dong.md")).toBeInTheDocument()
  })

  it("groups and displays outgoing and incoming relations", () => {
    render(
      <NodeInspectorDrawer
        node={mockNodes[0]}
        nodes={mockNodes}
        edges={mockEdges}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />
    )

    // 断言分组归属而非仅文案存在：入/出边判反时本用例必须失败。
    // node-1 出边 → node-2（道侣）；node-3 入边 → node-1（生死相随）。
    const outgoingGroup = screen.getByText(/指向关系/).closest("[data-relation-group]") as HTMLElement
    const incomingGroup = screen.getByText(/指入关系/).closest("[data-relation-group]") as HTMLElement
    expect(outgoingGroup).not.toBeNull()
    expect(incomingGroup).not.toBeNull()

    expect(outgoingGroup).toHaveTextContent("绫清竹")
    expect(outgoingGroup).toHaveTextContent("道侣")
    expect(outgoingGroup).not.toHaveTextContent("天妖貂")
    expect(incomingGroup).toHaveTextContent("天妖貂")
    expect(incomingGroup).toHaveTextContent("生死相随")
    expect(incomingGroup).not.toHaveTextContent("绫清竹")
  })

  it("renders every relation when the same pair has multiple relations (no duplicate React key)", () => {
    const multiEdges: GraphEdge[] = [
      { source: "node-1", target: "node-2", weight: 0.9, relation: "道侣" },
      { source: "node-1", target: "node-2", weight: 0.7, relation: "同门" },
      { source: "node-1", target: "node-2", weight: 0.5, relation: "宿敌" },
    ]
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <NodeInspectorDrawer
        node={mockNodes[0]}
        nodes={mockNodes}
        edges={multiEdges}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText("道侣")).toBeInTheDocument()
    expect(screen.getByText("同门")).toBeInTheDocument()
    expect(screen.getByText("宿敌")).toBeInTheDocument()
    // 重复 key 会让 React 打 warning；这里显式断言没有 key 相关告警。
    const keyWarnings = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("same key"),
    )
    expect(keyWarnings).toHaveLength(0)
    errorSpy.mockRestore()
  })

  it("fires onSelectNode when a relation item is clicked", () => {
    const onSelectNode = vi.fn()
    render(
      <NodeInspectorDrawer
        node={mockNodes[0]}
        nodes={mockNodes}
        edges={mockEdges}
        onSelectNode={onSelectNode}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByText("绫清竹"))

    expect(onSelectNode).toHaveBeenCalledTimes(1)
    expect(onSelectNode).toHaveBeenCalledWith("node-2")
  })

  it("fires onClose when close button is clicked", () => {
    const onClose = vi.fn()
    render(
      <NodeInspectorDrawer
        node={mockNodes[0]}
        nodes={mockNodes}
        edges={mockEdges}
        onSelectNode={vi.fn()}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByLabelText("关闭详情面板"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("fires onOpenWiki when open wiki document button is clicked", () => {
    const onOpenWiki = vi.fn()
    render(
      <NodeInspectorDrawer
        node={mockNodes[0]}
        nodes={mockNodes}
        edges={mockEdges}
        onSelectNode={vi.fn()}
        onOpenWiki={onOpenWiki}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /打开完整 Wiki 档案/i }))
    expect(onOpenWiki).toHaveBeenCalledTimes(1)
    expect(onOpenWiki).toHaveBeenCalledWith("characters/lin-dong.md")
  })

  it("shows empty state when node has no relations", () => {
    const isolatedNode: GraphNode = {
      id: "node-isolated",
      label: "隐居散人",
      type: "character",
      path: "characters/isolated.md",
      linkCount: 0,
      community: 3,
    }

    render(
      <NodeInspectorDrawer
        node={isolatedNode}
        nodes={[...mockNodes, isolatedNode]}
        edges={mockEdges}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText(/暂无直接关联/i)).toBeInTheDocument()
  })
})

describe("NodeInspectorDrawer — a11y 与筛选提示", () => {
  const nodes: GraphNode[] = [
    { id: "node-1", label: "林动", type: "character", path: "characters/lin-dong.md", linkCount: 2, community: 1 },
    { id: "node-2", label: "绫清竹", type: "character", path: "characters/ling-qingzhu.md", linkCount: 1, community: 1 },
    { id: "node-3", label: "天妖貂", type: "beast", path: "beasts/diao.md", linkCount: 1, community: 2 },
  ]
  const edges: GraphEdge[] = [
    { source: "node-1", target: "node-2", weight: 0.9, relation: "道侣" },
    { source: "node-3", target: "node-1", weight: 0.8, relation: "生死相随" },
  ]

  beforeEach(() => {
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  it("closes on Escape", () => {
    const onClose = vi.fn()
    render(
      <NodeInspectorDrawer node={nodes[0]} nodes={nodes} edges={edges} onSelectNode={vi.fn()} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("moves focus into the panel when opened", () => {
    render(
      <NodeInspectorDrawer node={nodes[0]} nodes={nodes} edges={edges} onSelectNode={vi.fn()} onClose={vi.fn()} />,
    )
    expect(document.activeElement).toBe(screen.getByTestId("node-inspector-drawer"))
  })

  it("marks relation items whose peer is hidden by the current view filter", () => {
    render(
      <NodeInspectorDrawer
        node={nodes[0]}
        nodes={nodes}
        edges={edges}
        visibleNodeIds={new Set(["node-1", "node-2"])}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // node-3 被筛选隐藏 → 入边项带「已过滤」标注；node-2 在视图内 → 不标注
    const hints = screen.getAllByTestId("inspector-relation-filtered")
    expect(hints).toHaveLength(1)
    expect(hints[0]).toHaveTextContent("已过滤")
    expect(hints[0].closest("button")).toHaveTextContent("天妖貂")
  })

  it("does not mark anything when the whole graph is visible", () => {
    render(
      <NodeInspectorDrawer
        node={nodes[0]}
        nodes={nodes}
        edges={edges}
        visibleNodeIds={new Set(["node-1", "node-2", "node-3"])}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryAllByTestId("inspector-relation-filtered")).toHaveLength(0)
  })
})
