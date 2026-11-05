// @vitest-environment jsdom
/**
 * bookshelf-view.spec.tsx — 书架视图契约。
 *
 * 覆盖：
 * 1. 空库（readFile 返回空）→ 诚实空态 `bookshelf-empty`，无列表；
 * 2. 坏 JSON → 诚实空态（不崩）；
 * 3. 两本作品 → `bookshelf-list` 渲染书名/作者/章节数/字数/状态；
 * 4. 点击卡片 → `setSelectedLibraryBookId` 选中（store 真值断言）；
 * 5. 「继续创作」→ 选中 + `setActiveView("bookAnalysis")`；
 * 6. 「打开分析」→ 选中 + `setActiveView("bookAnalysis")`；
 * 7. projectPath 为空 → 空态且不读盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { BookshelfView } from "./bookshelf-view"
import { useBookAnalysisStore } from "@/stores/book-analysis-store"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(async () => ""),
  }
})

const mockedReadFile = vi.mocked(readFile)

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookId: "book-1",
    sourcePath: "E:/Novel/a.txt",
    contentHash: "hash-1",
    title: "凡人修仙传",
    author: "忘语",
    totalChapters: 10,
    totalWords: 100000,
    charactersCount: 3,
    skillsCount: 2,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function libraryJson(entries: unknown[]): string {
  return JSON.stringify({ version: 1, entries })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedReadFile.mockResolvedValue("")
  useBookAnalysisStore.getState().setSelectedLibraryBookId(null)
  useWikiStore.getState().setActiveView("wiki")
})

afterEach(() => cleanup())

describe("BookshelfView", () => {
  it("空库 → 诚实空态 bookshelf-empty，无列表", async () => {
    mockedReadFile.mockResolvedValue("")
    render(<BookshelfView projectPath="E:/Novel" />)
    expect(screen.getByTestId("bookshelf-view")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("bookshelf-empty")).toBeTruthy())
    expect(screen.getByTestId("bookshelf-empty").textContent).toContain("暂无拆文作品")
    expect(screen.queryByTestId("bookshelf-list")).toBeNull()
    expect(mockedReadFile).toHaveBeenCalledTimes(1)
    expect(String(mockedReadFile.mock.calls[0][0])).toContain("book-analysis/library.json")
  })

  it("坏 JSON → 诚实空态（不崩）", async () => {
    mockedReadFile.mockResolvedValue("{broken-json")
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-empty")).toBeTruthy())
    expect(screen.queryByTestId("bookshelf-list")).toBeNull()
  })

  it("两本作品 → 列表渲染书名/作者/章节数/字数/状态", async () => {
    mockedReadFile.mockResolvedValue(
      libraryJson([
        makeEntry(),
        makeEntry({
          bookId: "book-2",
          title: "诡秘之主",
          author: "爱潜水的乌贼",
          totalChapters: 20,
          totalWords: 200000,
          status: "partial",
        }),
      ]),
    )
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-list")).toBeTruthy())
    expect(screen.getByTestId("bookshelf-card-book-1")).toBeTruthy()
    expect(screen.getByTestId("bookshelf-card-book-2")).toBeTruthy()
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("凡人修仙传")
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("忘语")
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("10 章")
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("100000 字")
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("已完成")
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("诡秘之主")
    expect(screen.getByTestId("bookshelf-list").textContent).toContain("部分完成")
    expect(screen.queryByTestId("bookshelf-empty")).toBeNull()
  })

  it("点击卡片 → setSelectedLibraryBookId 选中", async () => {
    mockedReadFile.mockResolvedValue(libraryJson([makeEntry()]))
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-select-book-1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bookshelf-select-book-1"))
    expect(useBookAnalysisStore.getState().selectedLibraryBookId).toBe("book-1")
    expect(screen.getByTestId("bookshelf-select-book-1").getAttribute("aria-pressed")).toBe("true")
  })

  it("「继续创作」→ 选中 + 跳到 bookAnalysis", async () => {
    mockedReadFile.mockResolvedValue(libraryJson([makeEntry()]))
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-continue-book-1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bookshelf-continue-book-1"))
    expect(useBookAnalysisStore.getState().selectedLibraryBookId).toBe("book-1")
    expect(useWikiStore.getState().activeView).toBe("bookAnalysis")
  })

  it("「打开分析」→ 选中 + 跳到 bookAnalysis", async () => {
    mockedReadFile.mockResolvedValue(libraryJson([makeEntry({ bookId: "book-2", title: "诡秘之主" })]))
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-open-analysis-book-2")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bookshelf-open-analysis-book-2"))
    expect(useBookAnalysisStore.getState().selectedLibraryBookId).toBe("book-2")
    expect(useWikiStore.getState().activeView).toBe("bookAnalysis")
  })

  it("projectPath 为空 → 空态且不读盘", () => {
    render(<BookshelfView projectPath="" />)
    expect(screen.getByTestId("bookshelf-empty")).toBeTruthy()
    expect(mockedReadFile).not.toHaveBeenCalled()
  })
})

describe("BookshelfView 脏条目过滤（toBookshelfEntry 全出口）", () => {
  it("脏条目静默丢弃：仅 status=error 的无作者有效条目渲染", async () => {
    mockedReadFile.mockResolvedValue(
      libraryJson([
        "junk-string",
        null,
        42,
        makeEntry({ bookId: "" }),
        makeEntry({ bookId: "bad-title", title: "" }),
        makeEntry({ bookId: "bad-num", totalChapters: "10" }),
        makeEntry({ bookId: "bad-int", totalChapters: 1.5 }),
        makeEntry({ bookId: "bad-neg", totalWords: -5 }),
        makeEntry({ bookId: "bad-status", status: "weird" }),
        makeEntry({ bookId: "bad-author", author: 123 }),
        { ...makeEntry({ bookId: "book-ok", title: "有效", status: "error" }), author: undefined },
      ]),
    )
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-list")).toBeTruthy())
    const list = screen.getByTestId("bookshelf-list")
    expect(list.textContent).toContain("有效")
    expect(list.textContent).toContain("失败")
    for (const id of ["bad-title", "bad-num", "bad-int", "bad-neg", "bad-status", "bad-author"]) {
      expect(screen.queryByTestId(`bookshelf-card-${id}`)).toBeNull()
    }
    expect(screen.getByTestId("bookshelf-card-book-ok")).toBeTruthy()
    // 无作者条目不渲染作者行（author 分支 : entry / : null）
    expect(screen.getByTestId("bookshelf-card-book-ok").textContent).not.toContain("忘语")
  })

  it("卸载竞态：解析前卸载 → 不写已卸载组件状态；重挂载正常加载", async () => {
    let resolveRead!: (v: string) => void
    mockedReadFile.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRead = resolve
      }),
    )
    const { unmount } = render(<BookshelfView projectPath="E:/Novel" />)
    unmount()
    resolveRead(libraryJson([makeEntry()]))
    await waitFor(() => expect(mockedReadFile).toHaveBeenCalled())
    // 刷新宏任务，让 cancelled 分支实际执行
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId("bookshelf-list")).toBeNull()
    // 重挂载不受影响，正常渲染
    mockedReadFile.mockResolvedValue(libraryJson([makeEntry()]))
    render(<BookshelfView projectPath="E:/Novel" />)
    await waitFor(() => expect(screen.getByTestId("bookshelf-list")).toBeTruthy())
    expect(screen.getByTestId("bookshelf-card-book-1")).toBeTruthy()
  })
})
