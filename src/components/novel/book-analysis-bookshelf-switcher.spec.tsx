// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import * as jestDomMatchers from "@testing-library/jest-dom/matchers"
import type { BookAnalysisLibraryBook } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { BookAnalysisBookshelfSwitcher } from "./book-analysis-bookshelf-switcher"
import { BookshelfView } from "./bookshelf-view"

expect.extend(jestDomMatchers)

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(async () => ""),
  }
})

function makeBook(overrides: Partial<BookAnalysisLibraryBook> = {}): BookAnalysisLibraryBook {
  return {
    id: "book-1",
    path: "/proj/book-analysis/book-1",
    metadata: {
      title: "凡人修仙传",
      author: "忘语",
      totalChapters: 12,
      totalWords: 120000,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 2,
    },
    recognizedCharacters: [],
    characters: [],
    skills: [],
    styleStatus: "enabled",
    boundAurasCount: 2,
    addedAuraCharacterIds: [],
    ...overrides,
  }
}

beforeEach(() => {
  useWikiStore.getState().setActiveView("bookshelf")
})

afterEach(() => {
  cleanup()
  useWikiStore.getState().setActiveView("wiki")
})

describe("BookAnalysisBookshelfSwitcher", () => {
  it("空书架渲染导入空态，点击导入回调 onImportNovel", () => {
    const onImportNovel = vi.fn()
    const onClose = vi.fn()
    render(
      <BookAnalysisBookshelfSwitcher
        books={[]}
        selectedBookId={null}
        onSelectBook={vi.fn()}
        onImportNovel={onImportNovel}
        onClose={onClose}
      />,
    )

    expect(screen.getByTestId("book-analysis-bookshelf-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("book-analysis-bookshelf-import"))
    expect(onImportNovel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("book-analysis-bookshelf-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("多本书时渲染卡片网格，支持选书切换与删除作品", () => {
    const onSelectBook = vi.fn()
    const onDeleteBook = vi.fn()
    const books = [
      makeBook({ id: "book-1", styleStatus: "enabled", boundAurasCount: 2 }),
      makeBook({
        id: "book-2",
        metadata: {
          title: "诡秘之主",
          totalChapters: 8,
          totalWords: 80000,
          sourceType: "file",
          createdAt: 3,
          updatedAt: 4,
        },
        styleStatus: "available",
        boundAurasCount: 0,
      }),
      makeBook({
        id: "book-3",
        metadata: {
          title: "道诡异仙",
          author: "狐尾的笔",
          totalChapters: 5,
          totalWords: 50000,
          sourceType: "file",
          createdAt: 5,
          updatedAt: 6,
        },
        styleStatus: "missing",
        boundAurasCount: 0,
      }),
    ]

    render(
      <BookAnalysisBookshelfSwitcher
        books={books}
        selectedBookId="book-1"
        onSelectBook={onSelectBook}
        onDeleteBook={onDeleteBook}
        onImportNovel={vi.fn()}
      />,
    )

    expect(screen.getByTestId("book-analysis-bookshelf-grid")).toBeInTheDocument()
    expect(screen.getByTestId("book-analysis-bookshelf-select-book-1")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("book-analysis-bookshelf-select-book-2")).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(screen.getByTestId("book-analysis-bookshelf-select-book-2"))
    expect(onSelectBook).toHaveBeenCalledWith("book-2")

    fireEvent.click(screen.getByTestId("book-analysis-bookshelf-delete-book-3"))
    expect(onDeleteBook).toHaveBeenCalledWith("book-3")
  })
})

describe("BookshelfView 桥接拆文库视图按钮", () => {
  it("点击顶部前往拆文库视图按钮（bookshelf-open-library-view）与空态 CTA（bookshelf-empty-cta）均切至 bookAnalysis", () => {
    render(<BookshelfView projectPath="" />)
    const bridgeBtn = screen.getByTestId("bookshelf-open-library-view")
    expect(bridgeBtn).toBeInTheDocument()
    fireEvent.click(bridgeBtn)
    expect(useWikiStore.getState().activeView).toBe("bookAnalysis")

    useWikiStore.getState().setActiveView("bookshelf")
    const emptyCta = screen.getByTestId("bookshelf-empty-cta")
    expect(emptyCta).toBeInTheDocument()
    fireEvent.click(emptyCta)
    expect(useWikiStore.getState().activeView).toBe("bookAnalysis")
  })
})
