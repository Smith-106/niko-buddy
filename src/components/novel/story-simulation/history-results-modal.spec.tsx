// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { HistoryResultsModal } from "./history-results-modal"
import { deleteSimulationResult, loadSimulationResults } from "@/lib/novel"
import type { SimulationReport, StoryDraft } from "@/lib/novel/story-simulation/types"

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadSimulationResults: vi.fn(),
    deleteSimulationResult: vi.fn(),
  }
})

const loadMock = vi.mocked(loadSimulationResults)
const deleteMock = vi.mocked(deleteSimulationResult)

type SavedRow = Awaited<ReturnType<typeof loadSimulationResults>>[number]

function makeRow(overrides: Partial<SavedRow> = {}): SavedRow {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    report: {
      frameworkId: "fw-1",
      mode: "event-driven",
      characterAnalyses: [],
      branches: [],
      createdAt: "2026-10-30T11:21:00.000Z",
      recommendation: "建议摘要 UNIQUE-REC-1：稳扎稳打推进主线剧情发展",
    },
    draft: null,
    status: "complete",
    ...overrides,
  }
}

function makeReport(overrides: Partial<SimulationReport> = {}): SimulationReport {
  return {
    frameworkId: "fw-1",
    mode: "event-driven",
    characterAnalyses: [],
    branches: [],
    createdAt: "2026-10-30T11:21:00.000Z",
    recommendation: "",
    ...overrides,
  }
}

function makeDraft(overrides: Partial<StoryDraft> = {}): StoryDraft {
  return {
    branchId: "b1",
    frameworkId: "fw-1",
    chapters: [],
    totalWords: 0,
    createdAt: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    projectPath: "/proj",
    frameworkId: "fw1",
    onSelectResult: vi.fn(),
    onContinueResult: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

function resultButton(summary: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(summary) })
}

beforeEach(() => {
  document.body.innerHTML = ""
  loadMock.mockClear()
  deleteMock.mockClear()
  vi.spyOn(window, "confirm").mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("HistoryResultsModal 关闭态与缺参", () => {
  it("open=false 渲染 null 且不加载", () => {
    loadMock.mockResolvedValue([])
    const { container } = render(<HistoryResultsModal {...baseProps({ open: false })} />)
    expect(container.innerHTML).toBe("")
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("缺 projectPath/frameworkId 时不加载并显示空态", async () => {
    loadMock.mockResolvedValue([makeRow()])
    render(<HistoryResultsModal {...baseProps({ projectPath: undefined })} />)
    await waitFor(() => expect(screen.getByText("暂无历史推演结果")).toBeTruthy())
    expect(loadMock).not.toHaveBeenCalled()
  })
})

describe("HistoryResultsModal 加载成功映射", () => {
  it("加载中显示 spinner；成功后渲染结果并映射字段", async () => {
    let resolveLoad!: (v: unknown[]) => void
    loadMock.mockReturnValue(new Promise((r) => { resolveLoad = r as (v: unknown[]) => void }))
    render(<HistoryResultsModal {...baseProps()} />)
    expect(document.querySelector(".animate-spin")).toBeTruthy()
    resolveLoad([makeRow({ id: "r1" })])
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    expect(screen.getByText("历史推演结果")).toBeTruthy()
  })

  it("缺 recommendation 时回退默认文案；长摘要截断 40 字", async () => {
    const longSummary = "超长摘要 UNIQUE-LONG-2：" + "正".repeat(60)
    loadMock.mockResolvedValue([
      makeRow({ id: "r1", report: makeReport({ createdAt: "2026-10-30T11:21:00.000Z", recommendation: "" }) }),
      makeRow({ id: "r2", report: makeReport({ createdAt: "2026-10-30T11:21:00.000Z", recommendation: longSummary }) }),
    ])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("查看推演结果")).toBeTruthy())
    const btn = resultButton("超长摘要")
    expect(btn.textContent ?? "").toContain(longSummary.slice(0, 40))
    expect(btn.textContent ?? "").not.toContain("正".repeat(60))
  })

  it("草稿/降级徽标与计数", async () => {
    loadMock.mockResolvedValue([
      makeRow({ id: "r1", draft: makeDraft(), status: "degraded" }),
    ])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(screen.getByText("草稿")).toBeTruthy())
    expect(screen.getByText("降级")).toBeTruthy()
    expect(screen.getByText("(1)")).toBeTruthy()
  })

  it("complete 无徽标无继续按钮", async () => {
    loadMock.mockResolvedValue([makeRow({ id: "r1", status: "complete" })])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    expect(screen.queryByText("未完成")).toBeNull()
    expect(screen.queryByText("继续推演")).toBeNull()
  })

  it("partial/cancelled 渲染未完成徽标与继续按钮并回调", async () => {
    loadMock.mockResolvedValue([
      makeRow({ id: "r1", status: "partial" }),
      makeRow({ id: "r2", status: "cancelled", report: makeReport({ createdAt: "2026-10-30T11:22:00.000Z", recommendation: "第二条 UNIQUE-REC-3" }) }),
    ])
    const props = baseProps()
    render(<HistoryResultsModal {...props} />)
    await waitFor(() => expect(screen.getAllByText("未完成")).toHaveLength(2))
    const continues = screen.getAllByText("继续推演")
    expect(continues).toHaveLength(2)
    fireEvent.click(continues[0])
    expect(props.onContinueResult).toHaveBeenCalledWith("r1")
  })

  it("无 onContinueResult 时 partial 不渲染继续按钮", async () => {
    loadMock.mockResolvedValue([makeRow({ id: "r1", status: "partial" })])
    render(<HistoryResultsModal {...baseProps({ onContinueResult: undefined })} />)
    await waitFor(() => expect(screen.getByText("未完成")).toBeTruthy())
    expect(screen.queryByText("继续推演")).toBeNull()
  })

  it("点击结果触发 onSelectResult", async () => {
    loadMock.mockResolvedValue([makeRow({ id: "r-sel" })])
    const props = baseProps()
    render(<HistoryResultsModal {...props} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    fireEvent.click(resultButton("UNIQUE-REC-1"))
    expect(props.onSelectResult).toHaveBeenCalledWith("r-sel")
  })
})

describe("HistoryResultsModal 加载失败", () => {
  it("reject 显示错误文案并清空列表", async () => {
    loadMock.mockRejectedValue(new Error("磁盘不可读 UNIQUE-ERR-4"))
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(screen.getByText(/磁盘不可读 UNIQUE-ERR-4/)).toBeTruthy())
    expect(screen.getByText(/操作失败/)).toBeTruthy()
  })
})

describe("HistoryResultsModal 竞态取消", () => {
  it("frameworkId 快速切换时旧请求结果被忽略", async () => {
    let resolveFirst!: (v: unknown[]) => void
    let resolveSecond!: (v: unknown[]) => void
    loadMock.mockImplementation(((...args: unknown[]) => {
      if (args[1] === "fw-old") return new Promise((r) => { resolveFirst = r as (v: unknown[]) => void })
      return new Promise((r) => { resolveSecond = r as (v: unknown[]) => void })
    }) as never)
    const view = render(<HistoryResultsModal {...baseProps({ frameworkId: "fw-old" })} />)
    view.rerender(<HistoryResultsModal {...baseProps({ frameworkId: "fw-new" })} />)
    resolveFirst([makeRow({ id: "r-old", report: makeReport({ createdAt: "2026-10-30T11:21:00.000Z", recommendation: "旧请求数据 UNIQUE-OLD-5" }) })])
    resolveSecond([makeRow({ id: "r-new", report: makeReport({ createdAt: "2026-10-30T11:21:00.000Z", recommendation: "新请求数据 UNIQUE-NEW-6" }) })])
    await waitFor(() => expect(resultButton("UNIQUE-NEW-6")).toBeTruthy())
    expect(screen.queryByText(/旧请求数据/)).toBeNull()
  })
})

describe("HistoryResultsModal 卸载后失败", () => {
  it("卸载后 reject 被忽略不抛错", async () => {
    let rejectLoad!: (e: unknown) => void
    loadMock.mockReturnValue(new Promise((_, rej) => { rejectLoad = rej }))
    const view = render(<HistoryResultsModal {...baseProps()} />)
    view.unmount()
    rejectLoad(new Error("迟到错误 UNIQUE-ERR-8"))
    await new Promise((r) => setTimeout(r, 0))
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("非 Escape 按键不关闭", async () => {
    loadMock.mockResolvedValue([])
    const props = baseProps()
    render(<HistoryResultsModal {...props} />)
    await waitFor(() => expect(screen.getByText("暂无历史推演结果")).toBeTruthy())
    fireEvent.keyDown(window, { key: "Enter" })
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe("HistoryResultsModal 删除", () => {
  it("confirm 拒绝时不删除", async () => {
    ;(window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    deleteMock.mockResolvedValue(undefined)
    loadMock.mockResolvedValue([makeRow({ id: "r1" })])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    fireEvent.click(screen.getByTitle("删除此结果"))
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it("confirm 通过后删除并从列表移除", async () => {
    deleteMock.mockResolvedValue(undefined)
    loadMock.mockResolvedValue([
      makeRow({ id: "r1" }),
      makeRow({ id: "r2", report: makeReport({ createdAt: "2026-10-30T11:22:00.000Z", recommendation: "保留条目 UNIQUE-KEEP-7" }) }),
    ])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    fireEvent.click(screen.getAllByTitle("删除此结果")[0])
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/proj", "fw1", "r1"))
    await waitFor(() => expect(screen.queryByText(/UNIQUE-REC-1/)).toBeNull())
    expect(screen.getByText(/保留条目 UNIQUE-KEEP-7/)).toBeTruthy()
  })

  it("projectPath 丢失时删除直接返回", async () => {
    deleteMock.mockResolvedValue(undefined)
    loadMock.mockResolvedValue([makeRow({ id: "r1" })])
    const view = render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    view.rerender(<HistoryResultsModal {...baseProps({ projectPath: undefined })} />)
    fireEvent.click(screen.getByTitle("删除此结果"))
    expect(deleteMock).not.toHaveBeenCalled()
    expect(resultButton("UNIQUE-REC-1")).toBeTruthy()
  })

  it("删除失败时条目保留", async () => {
    deleteMock.mockRejectedValue(new Error("删不动"))
    loadMock.mockResolvedValue([makeRow({ id: "r1" })])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    fireEvent.click(screen.getByTitle("删除此结果"))
    await waitFor(() => expect(deleteMock).toHaveBeenCalled())
    // catch 分支吞错后条目仍在
    expect(resultButton("UNIQUE-REC-1")).toBeTruthy()
  })
})

describe("HistoryResultsModal 关闭交互", () => {
  it("X 按钮与背景点击关闭；内容区点击不关闭", async () => {
    loadMock.mockResolvedValue([])
    const props = baseProps()
    render(<HistoryResultsModal {...props} />)
    await waitFor(() => expect(screen.getByText("暂无历史推演结果")).toBeTruthy())
    fireEvent.click(screen.getByText("暂无历史推演结果"))
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("dialog"))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it("Escape 关闭；关闭后移除监听", async () => {
    loadMock.mockResolvedValue([])
    const props = baseProps()
    const view = render(<HistoryResultsModal {...props} />)
    await waitFor(() => expect(screen.getByText("暂无历史推演结果")).toBeTruthy())
    fireEvent.keyDown(window, { key: "Escape" })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    view.unmount()
    props.onClose.mockClear()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe("HistoryResultsModal 分页", () => {
  it("超 20 条时翻页前进后退", async () => {
    const rows = Array.from({ length: 21 }, (_, i) =>
      makeRow({
        id: `r-${i}`,
        report: makeReport({ recommendation: `第${i}条分页数据 UNIQUE-PAGE-${i}` }),
      }),
    )
    loadMock.mockResolvedValue(rows)
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-PAGE-0")).toBeTruthy())
    expect(screen.queryByText(/UNIQUE-PAGE-20/)).toBeNull()
    fireEvent.click(screen.getByTestId("pagination-next"))
    await waitFor(() => expect(screen.getByText(/UNIQUE-PAGE-20/)).toBeTruthy())
    expect(screen.queryByText(/UNIQUE-PAGE-0/)).toBeNull()
    fireEvent.click(screen.getByTestId("pagination-prev"))
    await waitFor(() => expect(screen.getByText(/UNIQUE-PAGE-0/)).toBeTruthy())
  })

  it("单页时不渲染分页控件", async () => {
    loadMock.mockResolvedValue([makeRow({ id: "r1" })])
    render(<HistoryResultsModal {...baseProps()} />)
    await waitFor(() => expect(resultButton("UNIQUE-REC-1")).toBeTruthy())
    expect(screen.queryByTestId("pagination")).toBeNull()
  })
})
