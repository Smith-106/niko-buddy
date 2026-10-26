import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Lightbulb } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { loadForeshadowingTracker, findChapterFileByNumber } from "@/lib/novel"
import type { Foreshadowing, ForeshadowingStore } from "@/lib/novel"

const STATUS_LABEL_KEY: Record<string, string> = {
  planted: "novel.foreshadowing.planted",
  advanced: "novel.foreshadowing.advanced",
  resolved: "novel.foreshadowing.resolved",
}

// PAT-U4: 状态语义色走 oklch token (planted=warning 未推进, advanced=accent 推进中, resolved=success 已回收)
const STATUS_BADGE: Record<string, string> = {
  planted: "bg-warning/15 text-warning",
  advanced: "bg-accent text-accent-foreground",
  resolved: "bg-success/15 text-success",
}

// Lightbulb fill 态隐喻伏笔点亮程度: planted 仅描边(未亮), advanced 半亮(推进中), resolved 全亮(已回收)
const STATUS_BULB_CLASS: Record<string, string> = {
  planted: "text-warning/40",
  advanced: "text-warning/70 fill-warning/30",
  resolved: "text-success fill-success/40",
}

// 甘特条逾期阈值与 foreshadowing-debt.ts 同源（plantedStale=5 / advancedStale=10），
// 面板内纯展示不再调 analyze（store 已在手），保持单向依赖。
const GANTT_PLANTED_STALE = 5
const GANTT_ADVANCED_STALE = 10
const GANTT_MAX_ROWS = 60

export type ForeshadowingGanttLevel = "critical" | "warning" | "normal"

export interface ForeshadowingGanttBar {
  start: number
  end: number
  level: ForeshadowingGanttLevel
}

export function getForeshadowingGanttWindow(
  items: readonly Foreshadowing[],
  currentChapter: number,
): { min: number; max: number } {
  let min = currentChapter
  let max = currentChapter
  for (const f of items) {
    min = Math.min(min, f.plantedChapter)
    max = Math.max(max, f.plantedChapter)
    if (typeof f.resolvedChapter === "number") max = Math.max(max, f.resolvedChapter)
    for (const a of f.advancedChapters ?? []) max = Math.max(max, a)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 1, max: 1 }
  return { min, max: Math.max(max, min) }
}

export function getForeshadowingGanttBar(
  f: Foreshadowing,
  currentChapter: number,
): ForeshadowingGanttBar {
  const start = f.plantedChapter
  const end = typeof f.resolvedChapter === "number" ? f.resolvedChapter : currentChapter
  // 与 analyzeForeshadowingDebt 同口径：critical 仅 planted 超 plantedStale；
  // advanced 只看上次推进是否超 advancedStale（否则 normal）。
  let level: ForeshadowingGanttLevel = "normal"
  if (f.status === "planted" && currentChapter - f.plantedChapter >= GANTT_PLANTED_STALE) {
    level = "critical"
  } else if (f.status === "advanced") {
    const last = (f.advancedChapters ?? []).length > 0 ? Math.max(...(f.advancedChapters ?? [])) : undefined
    if (last !== undefined && currentChapter - last >= GANTT_ADVANCED_STALE) level = "warning"
  }
  return { start, end: Math.max(end, start), level }
}

function groupByChapter(
  items: Foreshadowing[],
  chapterOf: (item: Foreshadowing) => number | undefined,
) {
  const order: Array<number | undefined> = []
  const buckets = new Map<string, Foreshadowing[]>()
  for (const item of items) {
    const chapter = chapterOf(item)
    const key = chapter === undefined ? "?" : String(chapter)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else {
      buckets.set(key, [item])
      order.push(chapter)
    }
  }
  return order
    .map((chapter) => ({
      chapter,
      items: buckets.get(chapter === undefined ? "?" : String(chapter)) ?? [],
    }))
    .sort((a, b) => (a.chapter ?? Number.POSITIVE_INFINITY) - (b.chapter ?? Number.POSITIVE_INFINITY))
}

export function ForeshadowingPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const [store, setStore] = useState<ForeshadowingStore | null>(null)
  const [loading, setLoading] = useState(true)
  const [rangeFrom, setRangeFrom] = useState("")
  const [rangeTo, setRangeTo] = useState("")

  // dataVersion 监听: chapter-ingest saveForeshadowingTracker(554/1525/1666)
  // 后 bumpDataVersion(1037/1229/1927), 不订阅则 ingest 后显示陈旧伏笔列表。
  // cancelled flag 防 race: project/dataVersion 快速变化时旧 fetch 的 setStore 覆盖最新。
  useEffect(() => {
    if (!project) return
    let cancelled = false
    setLoading(true)
    loadForeshadowingTracker(project.path)
      .then((s) => { if (!cancelled) setStore(s) })
      .catch(() => { if (!cancelled) setStore(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [project, dataVersion])

  const fromNum = rangeFrom.trim() === "" ? -Infinity : Number(rangeFrom)
  const toNum = rangeTo.trim() === "" ? Infinity : Number(rangeTo)
  const inRange = (n: number) => n >= fromNum && n <= toNum
  const touchesRange = (f: Foreshadowing) =>
    inRange(f.plantedChapter) ||
    (typeof f.resolvedChapter === "number" && inRange(f.resolvedChapter)) ||
    (f.advancedChapters ?? []).some(inRange)
  const visibleItems = (store?.items ?? []).filter(touchesRange)

  const handleOpenChapter = useCallback(async (chapterNumber: number) => {
    if (!project) return
    const path = await findChapterFileByNumber(project.path, chapterNumber)
    if (path) setSelectedFile(path)
  }, [project, setSelectedFile])

  const unresolved = visibleItems.filter((f) => f.status !== "resolved")
  const resolved = visibleItems.filter((f) => f.status === "resolved")

  // 无项目不再静默消失（grok 计划审查：该出现的区块消失 = 撒谎）；显式空态。
  if (!project) {
    return (
      <div className="flex items-start p-3" data-testid="foreshadowing-panel-no-project">
        <p className="text-xs text-muted-foreground">{t("novel.foreshadowing.empty")}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col" data-testid="foreshadowing-panel">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lightbulb className={`h-4 w-4 shrink-0 ${unresolved.length > 0 ? "text-warning fill-warning/30" : "text-muted-foreground"}`} />
            <h2 className="text-sm font-semibold">{t("novel.foreshadowing.title")}</h2>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t("novel.range.from", { defaultValue: "起" })}</span>
            <input
              type="number"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              placeholder="1"
              className="w-14 rounded border bg-background px-1 py-0.5"
            />
            <span>{t("novel.range.to", { defaultValue: "止" })}</span>
            <input
              type="number"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
              placeholder="∞"
              className="w-14 rounded border bg-background px-1 py-0.5"
            />
          </div>
        </div>
      </div>
      <div className="p-3">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("novel.foreshadowing.loading")}>
            <div className="skeleton-bar h-16 w-full rounded-md" />
            <div className="skeleton-bar h-16 w-full rounded-md" />
            <div className="skeleton-bar h-16 w-3/4 rounded-md" />
          </div>
        ) : !store || store.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <Lightbulb className="h-8 w-8 shrink-0 text-warning/40" />
            <p>{t("novel.foreshadowing.noData")}</p>
            <p className="text-xs italic">{t("novel.foreshadowing.noDataHint")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {t("novel.foreshadowing.summary", {
                total: store.items.length,
                unresolved: unresolved.length,
                resolved: resolved.length,
              })}
            </div>
            {(() => {
              const win = getForeshadowingGanttWindow(visibleItems, Math.max(...visibleItems.map((f) => f.plantedChapter), 1))
              const span = Math.max(win.max - win.min, 1)
              const rows = [...visibleItems].sort((a, b) => a.plantedChapter - b.plantedChapter).slice(0, GANTT_MAX_ROWS)
              const current = win.max
              return (
                <div data-testid="foreshadowing-gantt" className="rounded-md border bg-muted/20 p-2">
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t("novel.foreshadowing.gantt", { defaultValue: "埋设→回收" })}</span>
                    <span>第{win.min}章 → 第{win.max}章</span>
                  </div>
                  <div className="space-y-1">
                    {rows.map((f) => {
                      const bar = getForeshadowingGanttBar(f, current)
                      const left = ((bar.start - win.min) / span) * 100
                      const width = Math.max(((bar.end - bar.start) / span) * 100, 2)
                      const color = bar.level === "critical"
                        ? "bg-destructive/80"
                        : bar.level === "warning"
                          ? "bg-warning/80"
                          : f.status === "resolved"
                            ? "bg-success/70"
                            : f.status === "advanced"
                              ? "bg-accent"
                              : "bg-warning/60"
                      return (
                        <div key={f.id} data-testid={`foreshadowing-gantt-row-${f.id}`} data-overdue={bar.level} className="flex items-center gap-2">
                          <span className="w-20 shrink-0 truncate text-xs" title={f.name}>{f.name}·{bar.start}</span>
                          <div className="relative h-2 flex-1 rounded bg-muted">
                            <div className={`absolute top-0 h-2 rounded ${color}`} style={{ left: `${left}%`, width: `${width}%` }} />
                            {(f.advancedChapters ?? []).map((a) => (
                              <span key={a} className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: `${((a - win.min) / span) * 100}%` }} />
                            ))}
                          </div>
                          <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{bar.start}→{bar.end}</span>
                        </div>
                      )
                    })}
                  </div>
                  {visibleItems.length > GANTT_MAX_ROWS && (
                    <p className="mt-1 text-xs text-muted-foreground">…还有{visibleItems.length - GANTT_MAX_ROWS}条</p>
                  )}
                </div>
              )
            })()}
            {unresolved.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-warning">
                  {t("novel.foreshadowing.unresolved")} ({unresolved.length})
                </h3>
                <div className="space-y-3">
                  {groupByChapter(unresolved, (item) => item.plantedChapter).map((group) => (
                    <div key={group.chapter ?? "?"} className="space-y-2">
                      <button
                        type="button"
                        onClick={() => { if (typeof group.chapter === "number") void handleOpenChapter(group.chapter) }}
                        title={typeof group.chapter === "number" ? t("novel.foreshadowing.openPlanted", { num: group.chapter, defaultValue: `打开第${group.chapter}章` }) : undefined}
                        className="border-0 bg-transparent p-0 text-left text-xs text-muted-foreground hover:underline"
                      >
                        {t("novel.foreshadowing.plantedAt", { chapter: group.chapter ?? "?" })}
                      </button>
                      {group.items.map((f) => (
                        <div key={f.id} className="rounded-lg border px-3 py-2 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Lightbulb className={`h-3.5 w-3.5 shrink-0 ${STATUS_BULB_CLASS[f.status] ?? ""}`} aria-hidden="true" />
                            <span className="min-w-0 font-medium break-words">{f.name}</span>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[f.status] ?? ""}`}>
                              {t(STATUS_LABEL_KEY[f.status] ?? "novel.foreshadowing.unresolved")}
                            </span>
                          </div>
                          {/* Q14-C：人物维度 —— 关联角色徒标（无关联不渲染）。 */}
                          {f.relatedCharacters.length > 0 ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1" data-testid={`foreshadow-related-${f.id}`}>
                              {f.relatedCharacters.map((name) => (
                                <span
                                  key={name}
                                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                                >
                                  {name}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {f.description && (
                            <p className="mt-1 text-xs text-muted-foreground break-words">{f.description}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {resolved.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-success">
                  {t("novel.foreshadowing.resolved")} ({resolved.length})
                </h3>
                <div className="space-y-3">
                  {groupByChapter(resolved, (item) => item.resolvedChapter).map((group) => (
                    <div key={group.chapter ?? "?"} className="space-y-2">
                      <button
                        type="button"
                        onClick={() => { if (typeof group.chapter === "number") void handleOpenChapter(group.chapter) }}
                        title={typeof group.chapter === "number" ? t("novel.foreshadowing.openResolved", { num: group.chapter, defaultValue: `打开第${group.chapter}章` }) : undefined}
                        className="border-0 bg-transparent p-0 text-left text-xs text-muted-foreground hover:underline"
                      >
                        {t("novel.foreshadowing.resolvedAt", { chapter: group.chapter ?? "?" })}
                      </button>
                      {group.items.map((f) => (
                        <div key={f.id} className="rounded-lg border bg-success/5 px-3 py-2 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-success fill-success/40" aria-hidden="true" />
                            <span className="min-w-0 font-medium line-through break-words">{f.name}</span>
                            <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">
                              {t(/* v8 ignore next -- resolved is filtered to the only status with a guaranteed label. */ STATUS_LABEL_KEY[f.status] ?? "novel.foreshadowing.unresolved")}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
