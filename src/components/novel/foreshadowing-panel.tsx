import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Lightbulb } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { loadForeshadowingTracker, type ForeshadowingStore } from "@/lib/novel/foreshadowing-tracker"

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

export function ForeshadowingPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [store, setStore] = useState<ForeshadowingStore | null>(null)
  const [loading, setLoading] = useState(true)

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

  const unresolved = store?.items.filter(f => f.status !== "resolved") ?? []
  const resolved = store?.items.filter(f => f.status === "resolved") ?? []

  if (!project) return null

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Lightbulb className={`h-4 w-4 ${unresolved.length > 0 ? "text-warning fill-warning/30" : "text-muted-foreground/40"}`} />
          <h2 className="text-sm font-semibold">{t("novel.foreshadowing.title")}</h2>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scroll-fade-y p-3">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("novel.foreshadowing.loading")}>
            <div className="skeleton-bar h-16 w-full rounded-md" />
            <div className="skeleton-bar h-16 w-full rounded-md" />
            <div className="skeleton-bar h-16 w-3/4 rounded-md" />
          </div>
        ) : !store || store.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <Lightbulb className="h-8 w-8 text-warning/40" />
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
            {unresolved.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-warning">
                  {t("novel.foreshadowing.unresolved")} ({unresolved.length})
                </h3>
                <div className="space-y-2">
                  {unresolved.map((f) => (
                    <div key={f.id} className="rounded-lg border p-2 text-sm transition-colors hover:border-primary/40">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 truncate">
                          <Lightbulb className={`h-3.5 w-3.5 shrink-0 ${STATUS_BULB_CLASS[f.status] ?? ""}`} aria-hidden="true" />
                          <span className="font-medium truncate">{f.name}</span>
                        </div>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[f.status] ?? ""}`}>
                          {t(STATUS_LABEL_KEY[f.status] ?? "novel.foreshadowing.unresolved")}
                        </span>
                      </div>
                      {f.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("novel.foreshadowing.plantedAt", { chapter: f.plantedChapter })}
                      </p>
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
                <div className="space-y-2">
                  {resolved.map((f) => (
                    <div key={f.id} className="rounded-lg border bg-success/5 p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 truncate">
                          <Lightbulb className="h-3.5 w-3.5 shrink-0 text-success fill-success/40" aria-hidden="true" />
                          <span className="font-medium line-through">{f.name}</span>
                        </div>
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-xs bg-success/15 text-success">
                          {t(STATUS_LABEL_KEY[f.status] ?? "novel.foreshadowing.unresolved")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("novel.foreshadowing.resolvedAt", { chapter: f.resolvedChapter ?? "?" })}
                      </p>
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
