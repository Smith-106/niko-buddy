import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Clock } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { getTimelineEvents, type TimelineEntry } from "@/lib/novel/timeline"

export function TimelineView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [events, setEvents] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(true)

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

  if (!project) return null

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("novel.timeline.title")}</h2>
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
              {events.map((item) => (
                <div key={`${item.chapterNumber}-${item.event.slice(0, 16)}`} className="relative flex items-start gap-4 px-4 py-2 pl-10">
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