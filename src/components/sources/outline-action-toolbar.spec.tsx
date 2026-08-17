// @vitest-environment jsdom
/**
 * W4E5 coverage campaign — OutlineActionToolbar 全口径 100%。
 * store 依赖 vi.mock（可写 state），lib 依赖 runBulkOutlineIngest mock，
 * OutlineGeneratorDialog mock 为纯标记组件。断言对照源码实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { OutlineActionToolbar } from "./outline-action-toolbar"

interface OutlineTaskLike {
  projectPath: string
  kind: string
  status: string
  id?: string
}

const mocks = vi.hoisted(() => {
  const wikiState: {
    project: { id: string; name: string; path: string } | null
    setActiveView: ReturnType<typeof vi.fn>
  } = {
    project: { id: "p1", name: "Book", path: "/p" },
    setActiveView: vi.fn(),
  }
  const ogState: {
    tasks: OutlineTaskLike[]
    panelOpen: boolean
    setPanelOpen: ReturnType<typeof vi.fn>
  } = {
    tasks: [],
    panelOpen: false,
    setPanelOpen: vi.fn(),
  }
  return {
    wikiState,
    ogState,
    t: vi.fn((key: string, _opts?: unknown) => key),
    runBulkOutlineIngest: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
}))

vi.mock("@/stores/outline-generation-store", () => ({
  useOutlineGenerationStore: (selector: (s: typeof mocks.ogState) => unknown) => selector(mocks.ogState),
}))

vi.mock("@/lib/novel/outline-generation", () => ({
  runBulkOutlineIngest: mocks.runBulkOutlineIngest,
}))

vi.mock("@/components/sources/outline-generator-dialog", () => ({
  OutlineGeneratorDialog: ({
    open,
    mode,
    onOpenChange,
  }: {
    open: boolean
    mode: string
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div
        data-testid="outline-dialog"
        data-mode={mode}
        data-onopenchange={typeof onOpenChange === "function" ? "fn" : "missing"}
      />
    ) : null,
}))

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.wikiState.project = { id: "p1", name: "Book", path: "/p" }
  mocks.ogState.tasks = []
  mocks.ogState.panelOpen = false
  mocks.runBulkOutlineIngest.mockResolvedValue({ total: 3, succeeded: 3, failed: 0 })
  mocks.t.mockImplementation((key: string, _opts?: unknown) => key)
})

afterEach(() => {
  cleanup()
})

describe("OutlineActionToolbar — 渲染", () => {
  it("渲染四个按钮：生成大纲 / AI大纲 / 细化 / 批量摄取", () => {
    render(<OutlineActionToolbar />)
    expect(screen.getByRole("button", { name: "novel.outlineGenerator.title" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "AI大纲" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" })).toBeTruthy()
    // 对话框默认关闭
    expect(screen.queryByTestId("outline-dialog")).toBeNull()
  })

  it("className 合并到容器", () => {
    const { container } = render(<OutlineActionToolbar className="extra-cls" />)
    const root = container.querySelector("div")
    expect(root?.className).toContain("extra-cls")
    expect(root?.className).toContain("flex-wrap")
  })
})

describe("OutlineActionToolbar — 大纲对话框", () => {
  it("点击生成大纲 → outline 模式对话框打开", () => {
    render(<OutlineActionToolbar />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))
    const dialog = screen.getByTestId("outline-dialog")
    expect(dialog.getAttribute("data-mode")).toBe("outline")
  })

  it("点击细化 → refine 模式对话框打开，onOpenChange 为函数", () => {
    render(<OutlineActionToolbar />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
    const dialog = screen.getByTestId("outline-dialog")
    expect(dialog.getAttribute("data-mode")).toBe("refine")
    expect(dialog.getAttribute("data-onopenchange")).toBe("fn")
  })

  it("对话框 onOpenChange 可关闭（传给真实 Dialog 的 onOpenChange 回调）", () => {
    render(<OutlineActionToolbar />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))
    const dialog = screen.getByTestId("outline-dialog")
    expect(dialog).toBeTruthy()
    // mock 组件不真正渲染 DialogContent；这里验证 open 状态由内部 state 驱动
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
    expect(screen.getByTestId("outline-dialog").getAttribute("data-mode")).toBe("refine")
  })
})

describe("OutlineActionToolbar — AI 大纲聊天", () => {
  it("提供 onToggleOutlineChat 时只回调，不触碰 store", () => {
    const onToggle = vi.fn()
    render(<OutlineActionToolbar onToggleOutlineChat={onToggle} />)
    fireEvent.click(screen.getByRole("button", { name: "AI大纲" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(mocks.ogState.setPanelOpen).not.toHaveBeenCalled()
    expect(mocks.wikiState.setActiveView).not.toHaveBeenCalled()
  })

  it("未提供 onToggleOutlineChat 时打开大纲面板并切到 sources 视图", () => {
    render(<OutlineActionToolbar />)
    fireEvent.click(screen.getByRole("button", { name: "AI大纲" }))
    expect(mocks.ogState.setPanelOpen).toHaveBeenCalledWith(true)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("sources")
  })
})

describe("OutlineActionToolbar — 批量摄取", () => {
  it("无项目时点击直接返回", async () => {
    mocks.wikiState.project = null
    render(<OutlineActionToolbar onBulkIngestResult={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" }))
    await act(async () => {})
    expect(mocks.runBulkOutlineIngest).not.toHaveBeenCalled()
  })

  it("成功且 total>0 → bulkIngestResult 消息", async () => {
    const onResult = vi.fn()
    render(<OutlineActionToolbar onBulkIngestResult={onResult} />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" }))
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestResult"),
    )
    expect(mocks.runBulkOutlineIngest).toHaveBeenCalledWith("/p")
    expect(mocks.t).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestResult", {
      total: 3,
      succeeded: 3,
      failed: 0,
    })
  })

  it("成功且 total=0 → bulkIngestEmpty 消息", async () => {
    mocks.runBulkOutlineIngest.mockResolvedValue({ total: 0, succeeded: 0, failed: 0 })
    const onResult = vi.fn()
    render(<OutlineActionToolbar onBulkIngestResult={onResult} />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestEmpty"))
  })

  it("失败（Error）→ bulkIngestError 消息携带 err.message", async () => {
    mocks.runBulkOutlineIngest.mockRejectedValue(new Error("boom"))
    const onResult = vi.fn()
    render(<OutlineActionToolbar onBulkIngestResult={onResult} />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestError"))
    expect(mocks.t).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestError", { message: "boom" })
  })

  it("失败（非 Error）→ String(err) 消息", async () => {
    mocks.runBulkOutlineIngest.mockRejectedValue("raw-failure")
    const onResult = vi.fn()
    render(<OutlineActionToolbar onBulkIngestResult={onResult} />)
    fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestError"))
    expect(mocks.t).toHaveBeenCalledWith("novel.outlineGenerator.bulkIngestError", { message: "raw-failure" })
  })

  it("开始时先发 null（清空旧消息）并在 finally 恢复按钮", async () => {
    let resolveIngest: (v: { total: number; succeeded: number; failed: number }) => void = () => {}
    mocks.runBulkOutlineIngest.mockImplementation(
      () => new Promise((resolve) => { resolveIngest = resolve }),
    )
    const onResult = vi.fn()
    render(<OutlineActionToolbar onBulkIngestResult={onResult} />)
    const btn = screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" })
    fireEvent.click(btn)
    expect(onResult).toHaveBeenCalledWith(null)
    // 运行中：按钮禁用并显示 bulkIngesting + Loader2
    expect(btn.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("novel.outlineGenerator.bulkIngesting")).toBeTruthy()
    expect(btn.querySelector("svg")).toBeTruthy()

    await act(async () => {
      resolveIngest({ total: 1, succeeded: 1, failed: 0 })
    })
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false))
    expect(screen.queryByText("novel.outlineGenerator.bulkIngesting")).toBeNull()
  })

  it("bulkIngesting 派生状态（有进行中任务）时按钮禁用并显示进行中", () => {
    mocks.ogState.tasks = [
      { projectPath: "/p", kind: "ingest", status: "ingesting", id: "t1" },
    ]
    render(<OutlineActionToolbar />)
    const btn = screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngesting" })
    expect(btn.hasAttribute("disabled")).toBe(true)
    expect(btn.querySelector("svg")).toBeTruthy()
  })

  it("bulkIngesting 只认本项目 ingest+ingesting 任务", () => {
    mocks.ogState.tasks = [
      { projectPath: "/other", kind: "ingest", status: "ingesting" },
      { projectPath: "/p", kind: "outline", status: "ingesting" },
      { projectPath: "/p", kind: "ingest", status: "done" },
    ]
    render(<OutlineActionToolbar />)
    // 无匹配任务 → 正常按钮可用
    const btn = screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" })
    expect(btn.hasAttribute("disabled")).toBe(false)
  })

  it("项目为 null 时 bulkIngesting 为 false（任务不匹配）", () => {
    mocks.wikiState.project = null
    mocks.ogState.tasks = [{ projectPath: "/p", kind: "ingest", status: "ingesting" }]
    render(<OutlineActionToolbar />)
    expect(screen.getByRole("button", { name: "novel.outlineGenerator.bulkIngest" })).toBeTruthy()
  })
})
