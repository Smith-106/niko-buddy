// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * 拆文库内联书架切换网格（收敛独立 bookshelf 孤岛视图）。
 *
 * 职责：
 * - 以卡片网格总览当前项目全部已导入的拆书作品，展示章节/字数/角色数/技能数/文风态/绑定数；
 * - 点击作品卡片直接切换当前拆书视图目标作品并收起切换面板；
 * - 支持内联删除作品与空态直达导入，零额外磁盘读取（复用 BookAnalysisLibraryState 真源）。
 */

import { BookOpen, Plus, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { BookAnalysisLibraryBook } from "@/lib/novel"
import { cn } from "@/lib/utils"

export interface BookAnalysisBookshelfSwitcherProps {
  books: readonly BookAnalysisLibraryBook[]
  selectedBookId: string | null
  onSelectBook: (bookId: string) => void
  onDeleteBook?: (bookId: string) => void
  onImportNovel: () => void
  onClose?: () => void
}

function resolveStyleStatusKey(status: BookAnalysisLibraryBook["styleStatus"]): string {
  if (status === "enabled") return "bookAnalysis.bookshelfStyleEnabled"
  if (status === "available") return "bookAnalysis.bookshelfStyleReady"
  return "bookAnalysis.bookshelfStyleMissing"
}

export function BookAnalysisBookshelfSwitcher({
  books,
  selectedBookId,
  onSelectBook,
  onDeleteBook,
  onImportNovel,
  onClose,
}: BookAnalysisBookshelfSwitcherProps) {
  const { t } = useTranslation()

  return (
    <section
      aria-label={t("bookAnalysis.bookshelfTitle")}
      data-testid="book-analysis-bookshelf-switcher"
      className="border-b bg-background/95 px-5 py-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t("bookAnalysis.bookshelfTitle")}</h3>
          <span className="text-xs text-muted-foreground">
            {t("bookAnalysis.bookshelfCount", { count: books.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              data-testid="book-analysis-bookshelf-close"
              aria-label={t("bookAnalysis.bookshelfClose")}
            >
              <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t("bookAnalysis.bookshelfClose")}
            </Button>
          ) : null}
        </div>
      </div>

      {books.length === 0 ? (
        <div
          data-testid="book-analysis-bookshelf-empty"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/20 p-4"
        >
          <div>
            <p className="text-sm font-medium">{t("bookAnalysis.noWorks")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("bookAnalysis.noWorksHint")}</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={onImportNovel}
            data-testid="book-analysis-bookshelf-import"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("bookAnalysis.importNovel")}
          </Button>
        </div>
      ) : (
        <div
          data-testid="book-analysis-bookshelf-grid"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {books.map((book) => {
            const active = book.id === selectedBookId
            return (
              <div
                key={book.id}
                data-testid={`book-analysis-bookshelf-card-${book.id}`}
                className={cn(
                  "flex flex-col justify-between gap-2 rounded-lg border p-3 transition-colors",
                  active ? "border-primary bg-primary/5" : "bg-card hover:border-primary/40",
                )}
              >
                <button
                  type="button"
                  data-testid={`book-analysis-bookshelf-select-${book.id}`}
                  aria-pressed={active}
                  onClick={() => onSelectBook(book.id)}
                  className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {book.metadata.title}
                    </span>
                    {active ? (
                      <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {t("bookAnalysis.bookshelfCurrent")}
                      </span>
                    ) : null}
                  </div>
                  {book.metadata.author ? (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {book.metadata.author}
                    </span>
                  ) : null}
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    {t("bookAnalysis.bookshelfMeta", {
                      chapters: book.metadata.totalChapters,
                      words: book.metadata.totalWords.toLocaleString(),
                      characters: book.characters.length,
                      skills: book.skills.length,
                    })}
                  </span>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        book.styleStatus === "enabled"
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      {t(resolveStyleStatusKey(book.styleStatus))}
                    </span>
                    {book.boundAurasCount > 0 ? (
                      <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {t("bookAnalysis.bookshelfBoundCount", { count: book.boundAurasCount })}
                      </span>
                    ) : null}
                  </div>
                </button>
                {onDeleteBook ? (
                  <div className="flex justify-end border-t pt-2">
                    <button
                      type="button"
                      data-testid={`book-analysis-bookshelf-delete-${book.id}`}
                      onClick={() => onDeleteBook(book.id)}
                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      {t("bookAnalysis.deleteWork")}
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
