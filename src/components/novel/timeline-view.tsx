import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Clock } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { getTimelineEvents, type TimelineEntry } from "@/lib/novel/timeline"
import { findChapterFileByNumber } from "@/lib/novel/chapter-utils"

export function TimelineView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const [events, setEvents] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [rangeFrom, setRangeFrom] = useState("")
  const [rangeTo, setRangeTo] = useState("")

  // dataVersion 监听: chapter-ingest saveSnapshot(1217) 后 bumpDataVersion(1229),
  // timeline 从 snapshots 派生, 不订阅则 ingest 后显示陈旧时间线条目。
  // cancelled flag 防 race: project/dataVersion 快速变化时旧 fetch 的 setEvents 覆盖最新。
  useEffect(() => {
    if (!project) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const entries = await getTimelineEvents(project.path)
        if (!cancelled) setEvents(entries)
      } catch {
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [project, dataVersion])

  const fromNum = rangeFrom.trim() === "" ? -Infinity : Number(rangeFrom)
  const toNum = rangeTo.trim() === "" ? Infinity : Number(rangeTo)
  const inRange = (n: number) => n >= fromNum && n <= toNum
  const visibleEvents = events.filter((e) => inRange(e.chapterNumber))

  const handleOpenChapter = useCallback(async (chapterNumber: number) => {
    if (!project) return
    const path = await findChapterFileByNumber(project.path, chapterNumber)
    if (path) setSelectedFile(path)
  }, [project, setSelectedFile])

  if (!project) return null

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("novel.timeline.title")}</h2>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
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
      <div className="flex-1 overflow-y-auto scroll-fade-y">
        {loading ? (
          <div className="space-y-3 p-4" role="status" aria-label={t("novel.timeline.loading")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-4">
                <div className="skeleton-bar h-3 w-3 shrink-0 rounded-full" />
                <div className="skeleton-bar h-4 w-full" />
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Clock className="h-8 w-8 text-muted-foreground/40" />
            <p>{t("novel.timeline.noEvents")}</p>
            <p className="text-xs italic">{t("novel.timeline.noEventsHint")}</p>
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-6 top-0 h-full w-px bg-border" />
            <div className="space-y-0">
              {visibleEvents.map((item) => (
                <div
                  key={`${item.chapterNumber}-${item.event.slice(0, 16)}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => void handleOpenChapter(item.chapterNumber)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      void handleOpenChapter(item.chapterNumber)
                    }
                  }}
                  title={t("novel.timeline.openChapter", { num: item.chapterNumber, defaultValue: `打开第${item.chapterNumber}章` })}
                  className="relative flex cursor-pointer items-start gap-4 px-4 py-2 pl-10 hover:bg-muted/40"
                >
                  <div className="absolute left-[18px] top-3 h-3 w-3 rounded-full border-2 border-primary bg-background" />
                  <div className="min-w-[60px] text-xs font-medium text-primary">
                    {t("novel.timeline.chapter", { num: item.chapterNumber })}
                  </div>
                  <div className="text-sm text-foreground">{item.event}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}