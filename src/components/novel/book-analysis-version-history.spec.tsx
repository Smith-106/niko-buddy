// @vitest-environment jsdom
/**
 * BookAnalysisVersionHistory — 拆书版本历史（P2）。
 * 真实行为测试（C4 空壳已删除，原位重写）：
 * 空 projectPath、加载态、空列表/读盘失败降级、混合版本过滤+排序、
 * 分页翻页、选中下钻/关闭、选中失败静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
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
    const listed = deferred<ReturnType<typeof dirNode>[]>()
    const metadata = new Map(nodes.map((node) => [`${node.path}/metadata.json`, deferred<string>()]))
    fsMock.listDirectory.mockReturnValue(listed.promise)
    fsMock.readFile.mockImplementation((p: string) => {
      const pending = metadata.get(p)
      if (!pending) throw new Error(`unexpected ${p}`)
      return pending.promise
    })
    render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    expect(screen.getByText("加载中...")).toBeInTheDocument()
    await act(async () => { listed.resolve(nodes) })
    expect(fsMock.readFile).toHaveBeenCalledTimes(25)
    // 按相反完成顺序交付 metadata，装载完成后立即翻页。
    await act(async () => {
      for (let index = nodes.length - 1; index >= 0; index--) {
        metadata.get(`${nodes[index].path}/metadata.json`)!.resolve(metaJson(`书${String(index + 1).padStart(2, "0")}`, index + 1))
      }
      await Promise.all([...metadata.values()].map((pending) => pending.promise))
    })
    // 排序后首位应为 book-25（createdAt 最大）
    const firstPage = screen.getAllByRole("button")
    // 20 条 + prev + next = 22 个 button（Pagination pageCount=2 时渲染）
    expect(firstPage.length).toBeGreaterThanOrEqual(20)
    expect(screen.getByText("书25")).toBeInTheDocument()
    expect(screen.queryByText("书05")).toBeNull()
    expect(screen.getByTestId("pagination-info")).toHaveTextContent(/第\s*1\s*\/\s*2\s*页/)
    expect(screen.getByTestId("pagination-prev")).toBeDisabled()
    expect(screen.getByTestId("pagination-next")).not.toBeDisabled()
    // 下一页
    fireEvent.click(screen.getByTestId("pagination-next"))
    expect(screen.getByText("书05")).toBeInTheDocument()
    expect(screen.queryByText("书25")).toBeNull()
    expect(screen.getByTestId("pagination-info")).toHaveTextContent(/第\s*2\s*\/\s*2\s*页/)
    expect(screen.getByTestId("pagination-prev")).not.toBeDisabled()
    expect(screen.getByTestId("pagination-next")).toBeDisabled()
    // 上一页钳位回第一页
    fireEvent.click(screen.getByTestId("pagination-prev"))
    expect(screen.getByText("书25")).toBeInTheDocument()
    // 第一页时 prev 禁用（钳位 Math.max）
    expect((screen.getByTestId("pagination-prev") as HTMLButtonElement).disabled).toBe(true)
    expect(fsMock.listDirectory).toHaveBeenCalledTimes(1)
  })

  it("新项目提交第一页，迟到旧项目结果不重置已翻到的第二页", async () => {
    const oldList = deferred<ReturnType<typeof dirNode>[]>()
    const newList = deferred<ReturnType<typeof dirNode>[]>()
    const nodes = (project: string) => Array.from({ length: 25 }, (_, index) =>
      dirNode(`book-${String(index + 1).padStart(2, "0")}`, `${project}/book-analysis`))
    fsMock.listDirectory.mockImplementation((base: string) => {
      if (base === "E:/Novel/book-analysis") return Promise.resolve(nodes("E:/Novel"))
      if (base === "E:/Late/book-analysis") return oldList.promise
      if (base === "E:/Other/book-analysis") return newList.promise
      throw new Error(`unexpected ${base}`)
    })
    fsMock.readFile.mockImplementation(async (p: string) => {
      const number = Number(p.match(/book-(\d+)/)?.[1])
      const title = p.startsWith("E:/Other") ? "新书" : p.startsWith("E:/Late") ? "迟到书" : "书"
      return metaJson(`${title}${String(number).padStart(2, "0")}`, number)
    })
    const { rerender } = render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    await screen.findByText("书25")
    fireEvent.click(screen.getByTestId("pagination-next"))
    expect(screen.getByText("书05")).toBeInTheDocument()

    rerender(<BookAnalysisVersionHistory projectPath="E:/Late" />)
    rerender(<BookAnalysisVersionHistory projectPath="E:/Other" />)
    await act(async () => { newList.resolve(nodes("E:/Other")) })
    expect(screen.getByText("新书25")).toBeInTheDocument()
    expect(screen.queryByText("新书05")).toBeNull()
    expect(screen.getByTestId("pagination-info")).toHaveTextContent(/第\s*1\s*\/\s*2\s*页/)
    expect(screen.getByTestId("pagination-prev")).toBeDisabled()
    fireEvent.click(screen.getByTestId("pagination-next"))
    expect(screen.getByText("新书05")).toBeInTheDocument()
    expect(screen.getByTestId("pagination-next")).toBeDisabled()

    await act(async () => { oldList.resolve(nodes("E:/Late")) })
    expect(screen.getByText("新书05")).toBeInTheDocument()
    expect(screen.queryByText("迟到书25")).toBeNull()
    expect(screen.getByTestId("pagination-info")).toHaveTextContent(/第\s*2\s*\/\s*2\s*页/)
    expect(fsMock.listDirectory).toHaveBeenCalledTimes(3)
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
    fsMock.listDirectory.mockResolvedValue(nodes)
    fsMock.readFile.mockImplementation(async (p: string) => {
      const m = p.match(/book-(\d+)/)
      const n = m ? Number(m[1]) : 0
      return metaJson(`书${String(n).padStart(2, "0")}`, n)
    })
    const { rerender } = render(<BookAnalysisVersionHistory projectPath="E:/Novel" />)
    await screen.findByText("书25")
    fireEvent.click(screen.getByTestId("pagination-next"))
    // setPage 是 act 内的同步重渲染，不需要轮询：用同步 getByText 而不是 findByText，
    // 避免在覆盖率插桩 + 并发负载下被 RTL 的 1000ms 轮询预算误伤（隔离跑 30ms，
    // 全量跑会涨到 1030ms 而超时）。
    expect(screen.getByText("书05")).toBeInTheDocument()
    // 切换 project → versions 重取为单版本，page 应钳回第一页
    fsMock.listDirectory.mockResolvedValue([dirNode("book-99")])
    // 两处都用持久实现而非 *Once：项目切换后 effect 会重跑，listDirectory / readFile
    // 都可能被调用不止一次。一次性实现会在第二次调用时落回上一阶段（或 beforeEach
    // 的默认空实现），于是 versions 变空、「新书」永不出现 → 偶发超时。
    fsMock.readFile.mockImplementation(async () => metaJson("新书", 999))
    rerender(<BookAnalysisVersionHistory projectPath="E:/Other" />)
    expect(await screen.findByText("新书")).toBeInTheDocument()
    expect(screen.queryByTestId("pagination")).toBeNull()
  })
})
