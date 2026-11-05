// @vitest-environment jsdom
/**
 * 文档图谱视图（document-graph-view）行为测试。
 *
 * 覆盖：风险报告导出失败的用户可见反馈（R4 共识：不再吞成未处理 rejection）、
 * 分页「上一页」回退，以及编辑跳转两效应流水线里「目标节点被当前筛选隐藏」的
 * 早退守卫（不误滚动，清除筛选后恢复定位）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { DocumentGraphView } from "./document-graph-view"

const mocks = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(),
  projectPath: "/p/test" as string | undefined,
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, writeFileAtomic: mocks.writeFileAtomic }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(() => undefined, {
    getState: () => ({ project: mocks.projectPath ? { path: mocks.projectPath } : null }),
  }),
}))

function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    label: overrides.id,
    type: "secret",
    path: `/p/test/wiki/secrets/${overrides.id}.md`,
    linkCount: 1,
    community: 0,
    ...overrides,
  }
}

function renderView(props: {
  nodes: GraphNode[]
  edges?: GraphEdge[]
  editingNode?: GraphNode | null
  editingContent?: string
}) {
  return render(
    <DocumentGraphView
      nodes={props.nodes}
      edges={props.edges ?? []}
      editingNode={props.editingNode ?? null}
      editingPath="/p/test/wiki/secrets/x.md"
      editingContent={props.editingContent ?? ""}
      editStatus={null}
      savingNode={false}
      onEditNode={() => {}}
      onChangeEditingContent={() => {}}
      onSaveNodeEdit={() => {}}
      onCancelNodeEdit={() => {}}
    />,
  )
}

describe("DocumentGraphView — 风险报告导出反馈", () => {
  beforeEach(() => {
    mocks.writeFileAtomic.mockReset()
    mocks.projectPath = "/p/test"
  })

  afterEach(() => {
    cleanup()
  })

  it("写盘失败时以 alert 呈现本地化错误（不再静默失败）", async () => {
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    renderView({ nodes: [node({ id: "sc:1", label: "秘密甲" })] })

    fireEvent.click(screen.getByText("导出报告"))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("操作失败：disk full")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/p/test/wiki/risk-report.md", expect.any(String))
  })

  it("写盘成功时以 status 呈现导出路径", async () => {
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    renderView({ nodes: [node({ id: "sc:1", label: "秘密甲" })] })

    fireEvent.click(screen.getByText("导出报告"))

    const status = await screen.findByRole("status")
    expect(status.textContent).toBe("风险报告已导出：/p/test/wiki/risk-report.md")
  })
})

describe("DocumentGraphView — 分页回退", () => {
  beforeEach(() => {
    mocks.writeFileAtomic.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  function pageNodes(count: number): GraphNode[] {
    return Array.from({ length: count }, (_, i) =>
      node({ id: `sc:p${i + 1}`, label: `分页秘密${String(i + 1).padStart(2, "0")}` }),
    )
  }

  it("翻到第 2 页后「上一页」回到第 1 页，编号跨页连续且回退正确", async () => {
    renderView({ nodes: pageNodes(21) })

    expect(screen.getByText("1.1 分页秘密01")).toBeTruthy()
    fireEvent.click(screen.getByTestId("pagination-next"))
    await waitFor(() => {
      expect(screen.getByText("1.21 分页秘密21")).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId("pagination-prev"))
    await waitFor(() => {
      expect(screen.getByText("1.1 分页秘密01")).toBeTruthy()
    })
    expect(screen.queryByText("1.21 分页秘密21")).toBeNull()
    expect((screen.getByTestId("pagination-prev") as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("DocumentGraphView — 编辑跳转定位", () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    scrollIntoView.mockClear()
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = scrollIntoView
  })

  afterEach(() => {
    cleanup()
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
  })

  function fiveSecrets(): GraphNode[] {
    return Array.from({ length: 5 }, (_, i) => node({ id: `sc:${i + 1}`, label: `秘密${i + 1}` }))
  }

  it("编辑目标被搜索词隐藏时不滚动；清除搜索后定位并展开该卡片", async () => {
    const nodes = fiveSecrets()
    const { rerender } = renderView({ nodes })

    fireEvent.change(screen.getByPlaceholderText("搜索节点标题或来源路径"), { target: { value: "秘密1" } })
    await waitFor(() => {
      expect(screen.queryByText(/秘密3/)).toBeNull()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()

    // editingNode 在筛选期间落地：目标不在 visibleNodes 内 → 定位效应早退，不误滚动
    rerender(
      <DocumentGraphView
        nodes={nodes}
        edges={[]}
        editingNode={nodes[2]}
        editingPath="/p/test/wiki/secrets/sc-3.md"
        editingContent="# 秘密3 档案"
        editStatus={null}
        savingNode={false}
        onEditNode={() => {}}
        onChangeEditingContent={() => {}}
        onSaveNodeEdit={() => {}}
        onCancelNodeEdit={() => {}}
      />,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(screen.queryByText("秘密3", { exact: false })).toBeNull()

    // 清除搜索 → 目标重新可见，定位效应恢复并滚动到该卡片
    fireEvent.change(screen.getByPlaceholderText("搜索节点标题或来源路径"), { target: { value: "" } })
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    })
    const scrolled = scrollIntoView.mock.contexts[0] as HTMLElement
    expect(scrolled.id).toBe("graph-doc-node-sc-3")
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" })
    // 卡片展开为编辑态（可观察：档案内容进入 textarea）
    const editor = document.querySelector("textarea") as HTMLTextAreaElement
    expect(editor.value).toBe("# 秘密3 档案")
  })
})
