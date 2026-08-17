// @vitest-environment jsdom
/**
 * BookAnalysisBookList — 作品库侧栏列表。
 * 覆盖：空态、三种文风状态标签、已绑定数量、作者行、删除按钮（含 stopPropagation）、
 * 未选中样式分支、onSelectBook 回调。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import type { BookAnalysisLibraryBook } from "@/lib/novel/book-analysis/library-state"
import { BookAnalysisBookList } from "./book-analysis-book-list"

function makeBook(overrides: Partial<BookAnalysisLibraryBook>): BookAnalysisLibraryBook {
  return {
    id: "book-1",
    path: "E:/Novel/b1",
    metadata: { title: "凡人修仙传", author: "忘语", totalChapters: 10, totalWords: 100000, sourceType: "file", createdAt: 1, updatedAt: 2 },
    styleStatus: "available",
    styleProfile: undefined,
    boundAurasCount: 0,
    addedAuraCharacterIds: [],
    recognizedCharacters: [],
    characters: [],
    skills: [],
    ...overrides,
  }
}

afterEach(() => cleanup())

describe("BookAnalysisBookList", () => {
  it("shows the empty state when there are no books", () => {
    render(<BookAnalysisBookList books={[]} selectedBookId={null} onSelectBook={vi.fn()} />)
    expect(screen.getByText("已拆书 0 本")).toBeInTheDocument()
    expect(screen.getByText(/还没有拆书作品/)).toBeInTheDocument()
  })

  it("renders books with enabled/available/missing status labels and bound count", () => {
    const books = [
      makeBook({ id: "b1", styleStatus: "enabled", boundAurasCount: 2 }),
      makeBook({ id: "b2", styleStatus: "available" }),
      makeBook({ id: "b3", styleStatus: "missing", metadata: { title: "无作者", author: "", totalChapters: 1, totalWords: 100, sourceType: "file", createdAt: 1, updatedAt: 2 } }),
    ]
    render(<BookAnalysisBookList books={books} selectedBookId="b1" onSelectBook={vi.fn()} />)
    expect(screen.getByText("已拆书 3 本")).toBeInTheDocument()
    expect(screen.getAllByText("凡人修仙传")).toHaveLength(2)
    // b1/b2 作者均为 忘语 → 两行作者行（源码 metadata.author && 分支，book-analysis-book-list.tsx:39）
    expect(screen.getAllByText("忘语")).toHaveLength(2)
    expect(screen.getByText("当前启用文风")).toBeInTheDocument()
    expect(screen.getByText("可启用文风")).toBeInTheDocument()
    expect(screen.getByText("未提取文风")).toBeInTheDocument()
    expect(screen.getByText(/已绑定 2/)).toBeInTheDocument()
    // b3 标题为"无作者"（作者为空 → 作者行不渲染，已由上方 getAllByText 长度 2 证明）
    expect(screen.getByText("无作者")).toBeInTheDocument()
  })

  it("calls onSelectBook when clicking a book row", () => {
    const onSelectBook = vi.fn()
    render(<BookAnalysisBookList books={[makeBook({ id: "b1" })]} selectedBookId={null} onSelectBook={onSelectBook} />)
    fireEvent.click(screen.getByRole("button", { name: /凡人修仙传/ }))
    expect(onSelectBook).toHaveBeenCalledWith("b1")
  })

  it("renders delete buttons only when onDeleteBook is provided and calls it with stopPropagation", () => {
    const onSelectBook = vi.fn()
    const onDeleteBook = vi.fn()
    const { rerender } = render(
      <BookAnalysisBookList books={[makeBook({ id: "b1" })]} selectedBookId="b1" onSelectBook={onSelectBook} onDeleteBook={onDeleteBook} />,
    )
    expect(screen.getByLabelText("删除作品")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("删除作品"))
    expect(onDeleteBook).toHaveBeenCalledWith("b1")
    // 点击删除不触发选中
    expect(onSelectBook).not.toHaveBeenCalled()

    // 未提供 onDeleteBook → 无删除按钮
    rerender(<BookAnalysisBookList books={[makeBook({ id: "b1" })]} selectedBookId="b1" onSelectBook={onSelectBook} />)
    expect(screen.queryByLabelText("删除作品")).not.toBeInTheDocument()
  })

  it("shows stats line with chapters/characters/skills counts", () => {
    const book = makeBook({
      id: "b1",
      characters: [{ id: "c1", name: "韩立", aliases: [], importance: 9, category: "protagonist", firstAppearance: 1, lastAppearance: 10, appearanceCount: 10, description: "", personality: "", speechStyle: "", relationships: [], keyEvents: [] }],
      skills: [{ id: "s1", characterId: "c1", characterName: "韩立", skillContent: "# 韩立", sourceBook: "凡人修仙传", chapterRange: ["1"], createdAt: 1 }],
    })
    render(<BookAnalysisBookList books={[book]} selectedBookId={null} onSelectBook={vi.fn()} />)
    expect(screen.getByText(/10 章 · 1 角色 · 1 Skill/)).toBeInTheDocument()
  })
})
