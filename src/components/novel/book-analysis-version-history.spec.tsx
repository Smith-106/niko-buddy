// @vitest-environment jsdom
/**
 * BookAnalysisVersionHistory — 拆书版本历史（P2）。
 * 真实行为测试（C4 空壳已删除，原位重写）：
 * 空 projectPath、加载态、空列表/读盘失败降级、混合版本过滤+排序、
 * 分页翻页、选中下钻/关闭、选中失败静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { BookAnalysisVersionHistory } from "./book-analysis-version-history"

const fsMock = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: fsMock.listDirectory,
    readFile: fsMock.readFile,
  }
})

const novelMock = vi.hoisted(() => ({
  loadResult: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadBookAnalysisResult: novelMock.loadResult,
  }
})

vi.mock("./book-analysis-result-viewer", () => ({
  BookAnalysisResultViewer: (props: Record<string, unknown>) => (
    <div data-testid="mock-viewer">
      <span data-testid="viewer-title">{String((props.result as { metadata?: { title?: string } })?.metadata?.title ?? "")}</span>
      <span data-testid="viewer-path">{String(props.projectPath)}</span>
      <button data-testid="viewer-close" onClick={() => (props.onClose as () => void)()}>
        close
      </button>
    </div>
  ),
}))

function dirNode(name: string, base = "E:/Novel/book-analysis") {
  return { name, path: `${base}/${name}`, is_dir: true as const }
}

function metaJson(title: string, createdAt: number) {
  return JSON.stringify({
    title,
    totalChapters: 10,
    totalWords: 1000,
    sourceType: "file",
    createdAt,
    updatedAt: createdAt,
  })
}

function fakeResult(title: string) {
  return {
    metadata: { title, totalChapters: 1, totalWords: 10, sourceType: "file", createdAt: 1, updatedAt: 1 },
    characters: [],
    skills: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMock.listDirectory.mockResolvedValue([])
  fsMock.readFile.mockRejectedValue(new Error("no file"))
  novelMock.loadResult.mockResolvedValue(null)
})

afterEach(() => cleanup())

describe("BookAnalysisVersionHistory", () => {
  it("returns null when projectPath is empty (79 行 + effect 32-34 守卫）", () => {
    const { container } = render(<BookAnalysisVersionHistory projectPath="" />)
    expect(container.innerHTML).toBe("")
    expect(screen.queryByTestId("book-analysis-version-history")).toBeNull()
    expect(fsMock.listDirectory).not.toHaveBeenCalled()
  })

  it("shows loading then empty when directory is empty", async () => {
    let resolveList!: (v: unknown[]) => void
    fsMock.listDirectory.mockReturnValueOnce(
      new Promise((res) => {
        resolveList = res as (v: unknown[]) => void
      }),
    )
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    // 加载态（104-105 行）必须先出现
    expect(await screen.findByText("加载中...")).toBeInTheDocument()
    resolveList([])
    // 空态（106-107 行）
    expect(await screen.findByText("暂无拆书版本")).toBeInTheDocument()
  })

  it("falls back to empty list when listDirectory throws (64-65 行）", async () => {
    fsMock.listDirectory.mockRejectedValueOnce(new Error("io"))
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    expect(await screen.findByText("暂无拆书版本")).toBeInTheDocument()
    expect(screen.queryByTestId("mock-viewer")).toBeNull()
  })

  it("cancels in-flight success load on unmount (cancelled 分支 63/67 行）", async () => {
    let resolveList!: (v: unknown[]) => void
    fsMock.listDirectory.mockReturnValueOnce(
      new Promise((res) => {
        resolveList = res as (v: unknown[]) => void
      }),
    )
    const { unmount } = render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    expect(await screen.findByText("加载中...")).toBeInTheDocument()
    unmount()
    resolveList([])
    // 给微任务 tick，断言卸载后无报错、无状态更新（cancelled=true 跳过 setVersions/setLoading）
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId("book-analysis-version-history")).toBeNull()
  })

  it("cancels in-flight failed load on unmount (cancelled 分支 65/67 行）", async () => {
    let rejectList!: (e: unknown) => void
    fsMock.listDirectory.mockReturnValueOnce(
      new Promise((_, rej) => {
        rejectList = rej as (e: unknown) => void
      }),
    )
    const { unmount } = render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    expect(await screen.findByText("加载中...")).toBeInTheDocument()
    unmount()
    rejectList(new Error("io"))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId("book-analysis-version-history")).toBeNull()
  })

  it("filters non-book dirs, skips bad metadata/read failures, sorts desc by createdAt", async () => {
    fsMock.listDirectory.mockResolvedValueOnce([
      dirNode("book-old"),
      { name: "notes.txt", path: "E:/Novel/book-analysis/notes.txt", is_dir: false as const },
      dirNode("book-new"),
      dirNode("book-badjson"),
      dirNode("book-unreadable"),
      dirNode("other-dir"),
    ])
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (p.includes("book-old")) return metaJson("旧书", 100)
      if (p.includes("book-new")) return metaJson("新书", 200)
      if (p.includes("book-badjson")) return "{not-json"
      if (p.includes("book-unreadable")) throw new Error("denied")
      throw new Error(`unexpected ${p}`)
    })
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    // 仅两个合法版本，且按 createdAt 降序：新书在前
    const items = await screen.findAllByRole("button")
    // 两个版本按钮（Pagination 单页时不渲染翻页按钮）
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain("新书")
    expect(items[1].textContent).toContain("旧书")
    // 计数条（98-101 行）
    expect(screen.getByText("共 2 个版本")).toBeInTheDocument()
  })

  it("paginates over 25 versions and prev/next clamp correctly (81-82/130-131 行）", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => dirNode(`book-${String(i + 1).padStart(2, "0")}`))
    fsMock.listDirectory.mockResolvedValueOnce(nodes)
    fsMock.readFile.mockImplementation(async (p: string) => {
      const m = p.match(/book-(\d+)/)
      const n = m ? Number(m[1]) : 0
      return metaJson(`书${String(n).padStart(2, "0")}`, n)
    })
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    // 排序后首位应为 book-25（createdAt 最大）
    const firstPage = await screen.findAllByRole("button")
    // 20 条 + prev + next = 22 个 button（Pagination pageCount=2 时渲染）
    expect(firstPage.length).toBeGreaterThanOrEqual(20)
    expect(screen.getByText("书25")).toBeInTheDocument()
    expect(screen.queryByText("书05")).toBeNull()
    // 下一页
    fireEvent.click(screen.getByTestId("pagination-next"))
    await waitFor(() => expect(screen.getByText("书05")).toBeInTheDocument())
    expect(screen.queryByText("书25")).toBeNull()
    // 上一页钳位回第一页
    fireEvent.click(screen.getByTestId("pagination-prev"))
    await waitFor(() => expect(screen.getByText("书25")).toBeInTheDocument())
    // 第一页时 prev 禁用（钳位 Math.max）
    expect((screen.getByTestId("pagination-prev") as HTMLButtonElement).disabled).toBe(true)
  })

  it("selects a version to drill down and closes viewer (84-91/133-139 行）", async () => {
    fsMock.listDirectory.mockResolvedValueOnce([dirNode("book-01"), dirNode("book-02")])
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (p.includes("book-01")) return metaJson("书A", 10)
      return metaJson("书B", 20)
    })
    novelMock.loadResult.mockImplementation(async (_project: string, bookId: string) => {
      if (bookId === "book-02") return fakeResult("书B详情")
      return null
    })
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    const buttons = await screen.findAllByRole("button")
    // 新书（书B）在前，点击下钻
    fireEvent.click(buttons[0])
    expect(await screen.findByTestId("mock-viewer")).toBeInTheDocument()
    expect(screen.getByTestId("viewer-title").textContent).toBe("书B详情")
    expect(novelMock.loadResult).toHaveBeenCalledWith("E:/Novel", "book-02")
    // 关闭
    fireEvent.click(screen.getByTestId("viewer-close"))
    await waitFor(() => expect(screen.queryByTestId("mock-viewer")).toBeNull())
  })

  it("ignores null result and silent-catches load errors", async () => {
    fsMock.listDirectory.mockResolvedValueOnce([dirNode("book-01")])
    fsMock.readFile.mockResolvedValueOnce(metaJson("书A", 10))
    // null 结果 → 不弹 viewer（87 行 if (result) false 分支）
    novelMock.loadResult.mockResolvedValueOnce(null)
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    const buttons = await screen.findAllByRole("button")
    fireEvent.click(buttons[0])
    await waitFor(() => expect(novelMock.loadResult).toHaveBeenCalled())
    // 给一个 tick，确认 viewer 未出现
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("mock-viewer")).toBeNull()
    // 抛错 → 静默忽略（88-90 行 catch）
    novelMock.loadResult.mockRejectedValueOnce(new Error("boom"))
    fireEvent.click(buttons[0])
    await waitFor(() => expect(novelMock.loadResult).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("mock-viewer")).toBeNull()
  })

  it("resets page to 0 when versions change (75-77 行）", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => dirNode(`book-${String(i + 1).padStart(2, "0")}`))
    fsMock.listDirectory.mockResolvedValueOnce(nodes)
    fsMock.readFile.mockImplementation(async (p: string) => {
      const m = p.match(/book-(\d+)/)
      const n = m ? Number(m[1]) : 0
      return metaJson(`书${String(n).padStart(2, "0")}`, n)
    })
    const { rerender } = render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    await screen.findByText("书25")
    fireEvent.click(screen.getByTestId("pagination-next"))
    await screen.findByText("书05")
    // 切换 project → versions 重取为单版本，page 应钳回第一页
    fsMock.listDirectory.mockResolvedValueOnce([dirNode("book-99")])
    fsMock.readFile.mockImplementationOnce(async () => metaJson("新书", 999))
    rerender(<BookAnalysisVersionHistory projectPath="E:/Other" />)
    expect(await screen.findByText("新书")).toBeInTheDocument()
    expect(screen.queryByTestId("pagination")).toBeNull()
  })
})
