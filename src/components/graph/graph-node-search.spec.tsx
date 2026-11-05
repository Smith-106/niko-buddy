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
  waitFor,
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

describe("GraphNodeSearch — 覆盖补齐", () => {
  beforeEach(() => {
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  const mixedNodes: GraphNode[] = [
    { id: "exact", label: "林", type: "character", path: "a.md", linkCount: 1, community: 0 },
    { id: "prefix", label: "林动", type: "character", path: "b.md", linkCount: 9, community: 0 },
    { id: "sub", label: "绫清竹", type: "character", path: "c.md", linkCount: 2, community: 0 },
  ]

  it("名称全等排在前缀之前（rank 0 < rank 1）", () => {
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={mixedNodes} onSelectNode={onSelectNode} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "林" } })
    const options = screen.getAllByRole("option")
    // 全等“林”在前，前缀“林动”在后：linkCount 9 也抢不走首位
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("林"), expect.stringContaining("林动")])
    expect(options[0].textContent).not.toContain("林动")
    fireEvent.keyDown(screen.getByLabelText(/在图谱中搜索节点/), { key: "Enter" })
    expect(onSelectNode).toHaveBeenCalledWith("exact")
  })

  it("名称子串（非前缀）命中 rank 2", () => {
    render(<GraphNodeSearch nodes={mixedNodes} onSelectNode={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "动" } })
    expect(screen.getByText("林动")).toBeInTheDocument()
    expect(screen.queryByText("绫清竹")).toBeNull()
  })

  it("缺 label/type/linkCount 的节点仍可检索，同级按 linkCount 降序", () => {
    const sparse: GraphNode[] = [
      { id: "no-label", label: undefined as unknown as string, type: "beast", path: "x.md", linkCount: 1, community: 0 },
      { id: "no-type", label: "林动", type: undefined as unknown as string, path: "y.md", linkCount: 1, community: 0 },
      { id: "tie-high", label: "yy甲", type: "character", path: "h.md", linkCount: undefined as unknown as number, community: 0 },
      { id: "tie-low", label: "yy乙", type: "character", path: "l.md", linkCount: undefined as unknown as number, community: 0 },
    ]
    render(<GraphNodeSearch nodes={sparse} onSelectNode={vi.fn()} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/)
    // type 缺失不影响 label 检索；label 缺失不影响 type 检索
    fireEvent.change(input, { target: { value: "beast" } })
    expect(screen.getByText("beast")).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "yy" } })
    // linkCount 缺失按 0 兜底：仍都出现且不崩
    expect(screen.getByText("yy甲")).toBeInTheDocument()
    expect(screen.getByText("yy乙")).toBeInTheDocument()
  })

  it("同级按 linkCount 降序排列", () => {
    const ranked: GraphNode[] = [
      { id: "low", label: "yy乙", type: "character", path: "l.md", linkCount: 1, community: 0 },
      { id: "high", label: "yy甲", type: "character", path: "h.md", linkCount: 5, community: 0 },
    ]
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={ranked} onSelectNode={onSelectNode} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "yy" } })
    const options = screen.getAllByRole("option")
    expect(options[0].textContent).toContain("yy甲")
    fireEvent.keyDown(screen.getByLabelText(/在图谱中搜索节点/), { key: "Enter" })
    expect(onSelectNode).toHaveBeenCalledWith("high")
  })

  it("ArrowUp 回绕到首项并提交", () => {
    const trio: GraphNode[] = [
      { id: "n1", label: "林动", type: "character", path: "a.md", linkCount: 3, community: 1 },
      { id: "n2", label: "绫清竹", type: "character", path: "b.md", linkCount: 2, community: 1 },
    ]
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={trio} onSelectNode={onSelectNode} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/)
    fireEvent.change(input, { target: { value: "character" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowUp" })
    fireEvent.keyDown(input, { key: "Enter" })
    // 下移到 n2 再上移回绕到 n1
    expect(onSelectNode).toHaveBeenCalledWith("n1")
  })

  it("空结果时 ArrowDown 不越界、Enter 不提交", () => {
    const onSelectNode = vi.fn()
    render(<GraphNodeSearch nodes={mixedNodes} onSelectNode={onSelectNode} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/)
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText(/未匹配到相关节点/)).toBeInTheDocument()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSelectNode).not.toHaveBeenCalled()
  })

  it("聚焦输入框重新展开下拉；外部点击关闭、内部点击保持", () => {
    render(<GraphNodeSearch nodes={mixedNodes} onSelectNode={vi.fn()} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/)
    fireEvent.change(input, { target: { value: "林" } })
    expect(screen.getByText("林动")).toBeInTheDocument()
    // 外部 mousedown 关闭
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("林动")).toBeNull()
    // 聚焦重新展开（query 保留）
    fireEvent.focus(input)
    expect(screen.getByText("林动")).toBeInTheDocument()
    // 内部 mousedown 不关闭
    fireEvent.mouseDown(screen.getByTestId("graph-node-search"))
    expect(screen.getByText("林动")).toBeInTheDocument()
  })

  it("清空按钮重置查询并关闭下拉", () => {
    render(<GraphNodeSearch nodes={mixedNodes} onSelectNode={vi.fn()} />)
    const input = screen.getByLabelText(/在图谱中搜索节点/) as HTMLInputElement
    fireEvent.change(input, { target: { value: "林" } })
    expect(screen.getByText("林动")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/清空搜索/))
    expect(input.value).toBe("")
    expect(screen.queryByText("林动")).toBeNull()
  })

  it("悬停结果切换高亮项", () => {
    const trio: GraphNode[] = [
      { id: "n1", label: "林动", type: "character", path: "a.md", linkCount: 3, community: 1 },
      { id: "n2", label: "绫清竹", type: "character", path: "b.md", linkCount: 2, community: 1 },
    ]
    render(<GraphNodeSearch nodes={trio} onSelectNode={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/在图谱中搜索节点/), { target: { value: "character" } })
    const options = screen.getAllByRole("option")
    expect(options[0].getAttribute("aria-selected")).toBe("true")
    fireEvent.mouseEnter(options[1])
    expect(options[1].getAttribute("aria-selected")).toBe("true")
    expect(options[0].getAttribute("aria-selected")).toBe("false")
  })
})

describe("GraphNodeSearch — combobox 语义", () => {
  const nodes = [
    { id: "a", label: "林动", type: "character", path: "/a.md", linkCount: 3, community: 0 },
    { id: "b", label: "绫清竹", type: "character", path: "/b.md", linkCount: 1, community: 0 },
  ]

  beforeEach(() => {
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  it("exposes combobox wiring and active descendant", async () => {
    render(<GraphNodeSearch nodes={nodes} onSelectNode={vi.fn()} />)
    const input = screen.getByRole("combobox") as HTMLInputElement
    expect(input.getAttribute("aria-expanded")).toBe("false")
    expect(input.getAttribute("aria-autocomplete")).toBe("list")

    fireEvent.change(input, { target: { value: "林" } })
    await waitFor(() => {
      expect(input.getAttribute("aria-expanded")).toBe("true")
    })
    const listboxId = input.getAttribute("aria-controls")
    expect(listboxId).toBeTruthy()
    expect(document.getElementById(listboxId as string)).toBeTruthy()

    const activeId = input.getAttribute("aria-activedescendant")
    expect(activeId).toBeTruthy()
    expect(document.getElementById(activeId as string)).toBeTruthy()
    expect(document.getElementById(activeId as string)?.textContent).toContain("林动")
  })
})
