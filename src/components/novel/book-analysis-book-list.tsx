import { BookOpen, CheckCircle2, Feather, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react"
import type { BookAnalysisLibraryBook, BookHealthSummary } from "@/lib/novel"

interface BookAnalysisBookListProps {
  books: BookAnalysisLibraryBook[]
  selectedBookId: string | null
  onSelectBook: (bookId: string) => void
  onDeleteBook?: (bookId: string) => void
  /** 列表健康列（波2-D 只读派生：per-bookId 门控摘要；缺省不渲染健康徽标）。 */
  healthByBookId?: Readonly<Record<string, BookHealthSummary>>
}

function styleStatusLabel(book: BookAnalysisLibraryBook): string {
  if (book.styleStatus === "enabled") return "当前启用文风"
  if (book.styleStatus === "available") return "可启用文风"
  return "未提取文风"
}

function healthBadge(health: BookHealthSummary): { icon: typeof ShieldCheck; label: string; className: string } {
  if (health.display === "fail") {
    return { icon: ShieldAlert, label: "门控未通过", className: "text-destructive" }
  }
  if (health.display === "pass") {
    return { icon: ShieldCheck, label: "门控通过", className: "text-primary" }
  }
  return { icon: ShieldQuestion, label: "门控未评估", className: "text-muted-foreground" }
}

export function BookAnalysisBookList({ books, selectedBookId, onSelectBook, onDeleteBook, healthByBookId }: BookAnalysisBookListProps) {
  return (
    <aside className="flex min-h-0 w-72 shrink-0 flex-col border-r bg-background">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-semibold">作品库</div>
        <div className="mt-1 text-xs text-muted-foreground">已拆书 {books.length} 本</div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {books.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">
            还没有拆书作品。点击“导入小说”开始分析。
          </div>
        ) : (
          books.map((book) => {
            const selected = book.id === selectedBookId
            return (
              <div
                key={book.id}
                className={`w-full rounded-lg border px-3 py-2 transition ${
                  selected ? "border-primary bg-primary/10" : "bg-background hover:bg-muted"
                }`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectBook(book.id)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{book.metadata.title}</div>
                      {book.metadata.author && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">{book.metadata.author}</div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {book.metadata.totalChapters} 章 · {book.characters.length} 角色 · {book.skills.length} Skill
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className={book.styleStatus === "enabled" ? "text-primary" : "text-muted-foreground"}>
                          <Feather className="mr-1 inline h-3 w-3" />
                          {styleStatusLabel(book)}
                        </span>
                        {book.boundAurasCount > 0 && (
                          <span className="text-primary">
                            <CheckCircle2 className="mr-1 inline h-3 w-3" />
                            已绑定 {book.boundAurasCount}
                          </span>
                        )}
                        {(() => {
                          // 列表健康列（波2-D）：只读派生徽标；无数据不渲染（R-04 不臆造）
                          const health = healthByBookId?.[book.id]
                          if (!health) return null
                          const badge = healthBadge(health)
                          const Icon = badge.icon
                          return (
                            <span
                              className={badge.className}
                              data-testid={`book-health-${book.id}`}
                              title={health.blockingGate ? `被 ${health.blockingGate} 阻塞` : badge.label}
                            >
                              <Icon className="mr-1 inline h-3 w-3" />
                              {badge.label}
                            </span>
                          )
                        })()}
                      </div>
                    </div>
                  </button>
                  {onDeleteBook && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onDeleteBook(book.id) }}
                      className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title="删除作品"
                      aria-label="删除作品"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
