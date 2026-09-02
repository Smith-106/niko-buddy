/**
 * 拆书版本历史（P2 项）
 * 数据源：项目内 `{project}/book-analysis/book-*` 目录集合（每个目录为一次拆解结果「版本」）。
 * 列表分页展示；点击条目复用既有 `BookAnalysisResultViewer` 下钻查看该版本结果。
 * 与既有 book-analysis-sidebar-panel 读取同一目录布局，不臆造路径；读取失败安全降级为空列表。
 */
import { useEffect, useState } from "react"
import { History } from "lucide-react"
import { useTranslation } from "react-i18next"
import { listDirectory, readFile } from "@/commands/fs"
import { joinPath } from "@/lib/path-utils"
import { loadBookAnalysisResult } from "@/lib/novel/book-analysis/result-loader"
import type { BookAnalysisMetadata, BookAnalysisResult } from "@/lib/novel/book-analysis/types"
import { BookAnalysisResultViewer } from "./book-analysis-result-viewer"
import { Pagination, PAGINATION_PAGE_SIZE } from "@/components/ui/pagination"

interface VersionItem {
  id: string
  title: string
  createdAt: number
  path: string
}

export function BookAnalysisVersionHistory({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation()
  const [versions, setVersions] = useState<VersionItem[]>([])
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ path: string; result: BookAnalysisResult } | null>(null)

  useEffect(() => {
    if (!projectPath) {
      setVersions([])
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const base = joinPath(projectPath, "book-analysis")
        const items = await listDirectory(base)
        const books: VersionItem[] = []
        for (const item of items) {
          if (!item.is_dir || !item.name.startsWith("book-")) continue
          try {
            const metaRaw = await readFile(joinPath(item.path, "metadata.json"))
            const meta = JSON.parse(metaRaw) as BookAnalysisMetadata
            books.push({ id: item.name, title: meta.title, createdAt: meta.createdAt, path: item.path })
          } catch {
            // 单本书元数据损坏不影响其它版本
          }
        }
        books.sort((a, b) => b.createdAt - a.createdAt)
        if (!cancelled) setVersions(books)
      } catch {
        if (!cancelled) setVersions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  useEffect(() => {
    setPage(0)
  }, [versions])

  if (!projectPath) return null

  const pageCount = Math.max(1, Math.ceil(versions.length / PAGINATION_PAGE_SIZE))
  const visible = versions.slice(page * PAGINATION_PAGE_SIZE, (page + 1) * PAGINATION_PAGE_SIZE)

  const handleSelect = async (v: VersionItem) => {
    try {
      const result = await loadBookAnalysisResult(projectPath, v.id)
      if (result) setSelected({ path: v.path, result })
    } catch {
      // 读取失败静默忽略
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4" data-testid="book-analysis-version-history">
      <div className="flex items-center gap-2">
        <History className="h-5 w-5 text-primary" />
        <h3 className="font-medium">{t("bookAnalysis.versionHistory.title")}</h3>
        {versions.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t("bookAnalysis.versionHistory.count", { count: versions.length })}
          </span>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("bookAnalysis.versionHistory.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {visible.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => void handleSelect(v)}
                className="flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="truncate font-medium">{v.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(v.createdAt).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pagination
        page={page + 1}
        pageCount={pageCount}
        total={versions.length}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
      />
      {selected && (
        <BookAnalysisResultViewer
          projectPath={selected.path}
          result={selected.result}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
