import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Table } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { listSnapshots } from "@/lib/novel/chapter-ingest"
import {
  loadForeshadowingTracker,
  type Foreshadowing,
} from "@/lib/novel/foreshadowing-tracker"

/**
 * PlotgridView — 情节线×章节矩阵（F-010，审查/记忆面板可选可视化子面板）。
 *
 * G-002 resolution：不新建独立 plotline 实体 —— plotline 行复用伏笔池
 * （foreshadowing-tracker 条目派生），列=章节标记（snapshots 派生），
 * 单元格=该情节线在章节的参与标记（埋设/推进/回收）。全部只读派生。
 */

export type PlotlineCellMark = "planted" | "advanced" | "resolved"

/** 矩阵行：由伏笔池条目派生的 plotline。 */
export interface PlotlineRow {
  id: string
  name: string
  status: Foreshadowing["status"]
  /** 该 plotline 参与的章节及参与类型（升序）。 */
  participation: Array<{ chapterNumber: number; mark: PlotlineCellMark }>
}

/** 从伏笔条目派生 plotline 参与单元格（埋设章 + 推进章列表 + 回收章）。 */
export function derivePlotlineParticipation(
  item: Pick<Foreshadowing, "plantedChapter" | "advancedChapters" | "resolvedChapter">,
): Array<{ chapterNumber: number; mark: PlotlineCellMark }> {
  const cells: Array<{ chapterNumber: number; mark: PlotlineCellMark }> = [
    { chapterNumber: item.plantedChapter, mark: "planted" },
  ]
  for (const chapter of item.advancedChapters ?? []) {
    if (!cells.some((c) => c.chapterNumber === chapter)) {
      cells.push({ chapterNumber: chapter, mark: "advanced" })
    }
  }
  if (
    typeof item.resolvedChapter === "number" &&
    !cells.some((c) => c.chapterNumber === item.resolvedChapter)
  ) {
    cells.push({ chapterNumber: item.resolvedChapter, mark: "resolved" })
  }
  return cells.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export function derivePlotlineRows(items: Foreshadowing[]): PlotlineRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    participation: derivePlotlineParticipation(item),
  }))
}

// 与 foreshadowing-panel 同款状态语义色 token（PAT-U4）
const MARK_CLASS: Record<PlotlineCellMark, string> = {
  planted: "bg-warning",
  advanced: "bg-accent",
  resolved: "bg-success",
}

const STATUS_BADGE: Record<string, string> = {
  planted: "bg-warning/15 text-warning",
  advanced: "bg-accent text-accent-foreground",
  resolved: "bg-success/15 text-success",
}

export function PlotgridView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [rows, setRows] = useState<PlotlineRow[]>([])
  const [chapters, setChapters] = useState<number[]>([])
  const [loading, setLoading] = useState(true)

  // dataVersion 监听与 TimelineView 同款：cancelled flag 防旧 fetch 覆盖最新。
  useEffect(() => {
    if (!project) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const [store, snapshotNumbers] = await Promise.all([
          loadForeshadowingTracker(project.path),
          listSnapshots(project.path),
        ])
        if (cancelled) return
        setRows(derivePlotlineRows(store.items))
        setChapters(snapshotNumbers.filter((n) => n > 0).sort((a, b) => a - b))
      } catch {
        if (!cancelled) {
          setRows([])
          setChapters([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [project, dataVersion])

  if (!project) return null

  const legendItems: Array<{ mark: PlotlineCellMark; labelKey: string }> = [
    { mark: "planted", labelKey: "novel.foreshadowing.planted" },
    { mark: "advanced", labelKey: "novel.foreshadowing.advanced" },
    { mark: "resolved", labelKey: "novel.foreshadowing.resolved" },
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Table className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("novel.plotgrid.title")}</h2>
          </div>
          {!loading && rows.length > 0 && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {legendItems.map(({ mark, labelKey }) => (
                <span key={mark} className="flex items-center gap-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${MARK_CLASS[mark]}`} aria-hidden="true" />
                  {t(labelKey)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto scroll-fade-y p-3">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("novel.plotgrid.loading")}>
            <div className="skeleton-bar h-8 w-full rounded-md" />
            <div className="skeleton-bar h-8 w-5/6 rounded-md" />
            <div className="skeleton-bar h-8 w-4/6 rounded-md" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Table className="h-8 w-8 text-muted-foreground/40" />
            <p>{t("novel.plotgrid.noData")}</p>
            <p className="text-xs italic">{t("novel.plotgrid.noDataHint")}</p>
          </div>
        ) : chapters.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Table className="h-8 w-8 text-muted-foreground/40" />
            <p>{t("novel.plotgrid.noChapters")}</p>
            <p className="text-xs italic">{t("novel.plotgrid.noChaptersHint")}</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-xs" data-plotgrid-matrix="true">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 min-w-[140px] bg-background px-2 py-2 text-left font-semibold">
                  {t("novel.plotgrid.plotline")}
                </th>
                {chapters.map((chapter) => (
                  <th key={chapter} className="min-w-[48px] px-1 py-2 text-center font-medium text-muted-foreground">
                    {t("novel.plotgrid.chapterShort", { num: chapter })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="sticky left-0 z-10 bg-background px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="max-w-[96px] truncate font-medium" title={row.name}>{row.name}</span>
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${STATUS_BADGE[row.status] ?? ""}`}>
                        {row.status === "resolved"
                          ? t("novel.foreshadowing.resolved")
                          : row.status === "advanced"
                            ? t("novel.foreshadowing.advanced")
                            : t("novel.foreshadowing.planted")}
                      </span>
                    </div>
                  </td>
                  {chapters.map((chapter) => {
                    const cell = row.participation.find((p) => p.chapterNumber === chapter)
                    const markLabel = cell
                      ? cell.mark === "planted"
                        ? t("novel.foreshadowing.planted")
                        : cell.mark === "advanced"
                          ? t("novel.foreshadowing.advanced")
                          : t("novel.foreshadowing.resolved")
                      : undefined
                    return (
                      <td
                        key={chapter}
                        className="px-1 py-2 text-center"
                        data-plotgrid-cell={`${row.id}:${chapter}`}
                        data-plotgrid-mark={cell?.mark ?? ""}
                      >
                        {cell ? (
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full align-middle ${MARK_CLASS[cell.mark]}`}
                            title={markLabel}
                            aria-label={`${row.name} · ${markLabel}`}
                          />
                        ) : (
                          <span className="text-muted-foreground/25" aria-hidden="true">·</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
