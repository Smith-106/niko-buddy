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
import { GraphNodeSearch } from "./graph-node-search"
import type { GraphNode } from "@/lib/wiki-graph"

describe("GraphNodeSearch", () => {
  const nodes: GraphNode[] = [
    { id: "n1", label: "林动", type: "character", path: "a.md", linkCount: 3, community: 1 },
    { id: "n2", label: "绫清竹", type: "character", path: "b.md", linkCount: 2, community: 1 },
    { id: "n3", label: "天妖貂", type: "beast", path: "c.md", linkCount: 1, community: 2 },
  ]

  beforeEach(() => {
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  it("renders search input with placeholder", () => {
    render(<GraphNodeSearch nodes={nodes} onSelectNode={vi.fn()} />)
    expect(screen.getByLabelText(/在图谱中搜索节点/)).toBeInTheDocument()
  })

  it("shows no results message when keyword matches nothing", () => {
    render(<GraphNodeSearch nodes={nodes} onSelectNode={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "zzz" } })
    expect(screen.getByText(/未匹配到相关节点/)).toBeInTheDocument()
  })

  it("filters nodes by label substring", () => {
    render(<GraphNodeSearch nodes={nodes} onSelectNode={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "林" } })

    expect(screen.getByText("林动")).toBeInTheDocument()
    expect(screen.queryByText("天妖貂")).toBeNull()
  })

  it("filters nodes by type", () => {
    render(<GraphNodeSearch nodes={nodes} onSelectNode={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "beast" } })

    expect(screen.getByText("天妖貂")).toBeInTheDocument()
    expect(screen.queryByText("林动")).toBeNull()
  })

  it("calls onSelectNode and clears query when a result is clicked", () => {
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={nodes} onSelectNode={onSelectNode} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/) as HTMLInputElement
    fireEvent.change(input, { target: { value: "林" } })

    fireEvent.click(screen.getByText("林动"))

    expect(onSelectNode).toHaveBeenCalledTimes(1)
    expect(onSelectNode).toHaveBeenCalledWith("n1")
    expect(input.value).toBe("")
  })

  it("selects first result with Enter key", () => {
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={nodes} onSelectNode={onSelectNode} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/)

    fireEvent.change(input, { target: { value: "林" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSelectNode).toHaveBeenCalledWith("n1")
  })

  it("moves active result with ArrowDown and commits with Enter", () => {
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={nodes} onSelectNode={onSelectNode} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/)

    fireEvent.change(input, { target: { value: "character" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSelectNode).toHaveBeenCalledWith("n2")
  })

  it("clears query on Escape", () => {
    render(<GraphNodeSearch nodes={nodes} onSelectNode={vi.fn()} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/) as HTMLInputElement

    fireEvent.change(input, { target: { value: "林" } })
    fireEvent.keyDown(input, { key: "Escape" })

    expect(input.value).toBe("")
  })

  it("respects maxResults cap", () => {
    const many: GraphNode[] = Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      label: `节点${index}`,
      type: "character",
      path: `p${index}.md`,
      linkCount: 1,
      community: 0,
    }))
    render(<GraphNodeSearch nodes={many} onSelectNode={vi.fn()} maxResults={3} />)

    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "节点" } })

    expect(screen.getAllByRole("option")).toHaveLength(3)
  })
})
