/**
 * bookshelf-view.tsx — 书架视图（拆书作品库只读一览）。
 *
 * 职责：
 * - 读取 `{projectPath}/book-analysis/library.json`（与
 *   `book-analysis/library-store.ts` 的 loadBookLibrary 同契约：
 *   文件缺失/空/坏一律回诚实空态，不抛错）；
 * - 作品卡片列表（书名/作者/章节数/字数/状态），点击选中；
 * - 「继续创作 / 打开分析」选中作品并跳到拆书分析视图。
 *
 * 边界：
 * - 只读装载，不写 library.json；
 * - 选中态走 `useBookAnalysisStore.setSelectedLibraryBookId`，
 *   视图跳转走 `useWikiStore.setActiveView("bookAnalysis")`（仿 director-view 写法）。
 *
 * Barrel 缺口已解决（BGH-20261019 m6）：`loadBookLibrary` 与类型经 barrel 复用，
 * 文件直读解析器已删除；展示类型仍为本地投影子集（字段收窄，非契约复刻）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { loadBookLibrary, type BookLibraryEntry } from "@/lib/novel"
import { useBookAnalysisStore } from "@/stores/book-analysis-store"
import { useWikiStore } from "@/stores/wiki-store"

/**
 * 书架条目（MINOR-3：改为 `Pick<BookLibraryEntry>` 绑定真源字段，改名即爆；
 * 展示子集——`BookLibraryEntry` 的其余字段（sourcePath/contentHash/统计时间戳等）本页不渲染）。
 */
export type BookshelfEntry = Pick<
  BookLibraryEntry,
  "bookId" | "title" | "author" | "totalChapters" | "totalWords" | "status"
>

export interface BookshelfViewProps {
  readonly projectPath: string
}

const STATUS_LABEL: Record<BookshelfEntry["status"], string> = {
  completed: "已完成",
  partial: "部分完成",
  error: "失败",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toBookshelfEntry(raw: unknown): BookshelfEntry | null {
  if (!isRecord(raw)) return null
  const { bookId, title, author, totalChapters, totalWords, status } = raw
  if (typeof bookId !== "string" || bookId.length === 0) return null
  if (typeof title !== "string" || title.length === 0) return null
  if (typeof totalChapters !== "number" || typeof totalWords !== "number") return null
  // MINOR-3：章节数/字数为非负整数（NaN/Infinity/负数/小数一律丢弃，不渲染脏卡）。
  if (!Number.isInteger(totalChapters) || totalChapters < 0) return null
  if (!Number.isInteger(totalWords) || totalWords < 0) return null
  if (status !== "completed" && status !== "partial" && status !== "error") return null
  if (author !== undefined && typeof author !== "string") return null
  const entry: BookshelfEntry = {
    bookId,
    title,
    totalChapters,
    totalWords,
    status,
  }
  return author ? { ...entry, author } : entry
}

/**
 * 书架装载（复用 `loadBookLibrary` 真源：空/坏回空数组，不抛错；
 * 再经 `toBookshelfEntry` 投影为展示子集。BGH-20261019 m6：直读解析器已删除）。
 */
export async function loadBookshelfEntries(projectPath: string): Promise<BookshelfEntry[]> {
  const library = await loadBookLibrary(projectPath)
  const entries: BookshelfEntry[] = []
  for (const item of library.entries) {
    const entry = toBookshelfEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

export function BookshelfView({ projectPath }: BookshelfViewProps) {
  const [entries, setEntries] = useState<readonly BookshelfEntry[] | null>(null)
  const selectedBookId = useBookAnalysisStore((state) => state.selectedLibraryBookId)
  const setSelectedLibraryBookId = useBookAnalysisStore((state) => state.setSelectedLibraryBookId)
  const setActiveView = useWikiStore((state) => state.setActiveView)

  useEffect(() => {
    if (!projectPath) {
      setEntries([])
      return
    }
    let cancelled = false
    setEntries(null)
    void loadBookshelfEntries(projectPath).then((next) => {
      if (!cancelled) setEntries(next)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const openInAnalysis = (bookId: string) => {
    setSelectedLibraryBookId(bookId)
    setActiveView("bookAnalysis")
  }

  return (
    <section data-testid="bookshelf-view" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">书架</h2>
        {entries !== null && entries.length > 0 ? (
          <span className="text-xs text-muted-foreground">共 {entries.length} 本拆书作品</span>
        ) : null}
      </div>
      {entries === null ? (
        <p className="text-xs text-muted-foreground">正在读取书架…</p>
      ) : entries.length === 0 ? (
        <p
          data-testid="bookshelf-empty"
          className="rounded-md border border-dashed p-4 text-xs leading-5 text-muted-foreground"
        >
          暂无拆书作品。先去「拆书分析」导入一本小说吧。
        </p>
      ) : (
        <ul data-testid="bookshelf-list" className="flex flex-col gap-2">
          {entries.map((entry) => {
            const selected = entry.bookId === selectedBookId
            return (
              <li
                key={entry.bookId}
                data-testid={`bookshelf-card-${entry.bookId}`}
                className={`rounded-md border px-3 py-2 ${
                  selected ? "border-primary bg-primary/10" : "bg-background"
                }`}
              >
                <button
                  type="button"
                  data-testid={`bookshelf-select-${entry.bookId}`}
                  aria-pressed={selected}
                  onClick={() => setSelectedLibraryBookId(entry.bookId)}
                  className="w-full text-left"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {entry.title}
                    {selected ? <span className="text-xs text-primary">已选中</span> : null}
                  </span>
                  {entry.author ? (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {entry.author}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {entry.totalChapters} 章 · {entry.totalWords} 字 · {STATUS_LABEL[entry.status]}
                  </span>
                </button>
                <span className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-testid={`bookshelf-continue-${entry.bookId}`}
                    onClick={() => openInAnalysis(entry.bookId)}
                    className="rounded border border-border px-2 py-1 text-xs"
                  >
                    继续创作
                  </button>
                  <button
                    type="button"
                    data-testid={`bookshelf-open-analysis-${entry.bookId}`}
                    onClick={() => openInAnalysis(entry.bookId)}
                    className="rounded border border-border px-2 py-1 text-xs"
                  >
                    打开分析
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
