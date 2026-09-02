/**
 * 章节机械门控进度条（P2 项）
 * 展示逐章机械门控（thril 软门控）通过率，以及三条质量门控（一致性 P0 / 抗 AI P1 / 质量 P2）的开关状态。
 * 数据全部来自既有 store（thrilSoftGateAcknowledgedByChapter + novelConfig），不新增任何写入。
 * 受控 props（totalChapters / acknowledgedChapters）用于单测；不传时从 store + 目录读取。
 */
import { useEffect, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { useTranslation } from "react-i18next"
import { flattenMdFiles } from "@/lib/novel/chapter-utils"

export interface ChapterGatingProgressProps {
  /** 总章节数（受控；不传则从 wiki/chapters 目录读取）。 */
  totalChapters?: number
  /** 已确认通过机械门控的章节数（受控；不传则从 store 读取）。 */
  acknowledgedChapters?: number
}

export function ChapterGatingProgress({ totalChapters, acknowledgedChapters }: ChapterGatingProgressProps) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const project = useWikiStore((s) => s.project)
  const ackMap = useWikiStore((s) => s.thrilSoftGateAcknowledgedByChapter)
  const novelConfig = useWikiStore((s) => s.novelConfig)

  const [loadedTotal, setLoadedTotal] = useState<number | null>(null)

  // 读取 wiki/chapters 下章节总数（仅 novelMode + 有项目时）。
  useEffect(() => {
    if (totalChapters !== undefined) {
      setLoadedTotal(null)
      return
    }
    if (!novelMode || !project?.path) {
      setLoadedTotal(null)
      return
    }
    let cancelled = false
    void listDirectory(`${project.path}/wiki/chapters`)
      .then((tree) => {
        if (!cancelled) setLoadedTotal(flattenMdFiles(tree).length)
      })
      .catch(() => {
        if (!cancelled) setLoadedTotal(0)
      })
    return () => {
      cancelled = true
    }
  }, [novelMode, project?.path, totalChapters])

  if (!novelMode) return null

  const total = totalChapters ?? loadedTotal ?? 0
  const passed = acknowledgedChapters ?? Object.values(ackMap).filter(Boolean).length
  const percent = total > 0 ? Math.round((passed / total) * 100) : 0

  const gates = [
    { key: "consistency", label: t("wiki.gatingProgress.consistency"), on: novelConfig.stateDeltaLightCheckEnabled !== false },
    { key: "antiAi", label: t("wiki.gatingProgress.antiAi"), on: novelConfig.exemplarEnabled !== false },
    { key: "quality", label: t("wiki.gatingProgress.quality"), on: novelConfig.literaryPolishAfterGate === true },
  ] as const

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs"
      data-testid="wiki-gating-progress"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground">{t("wiki.gatingProgress.title")}</span>
        <span data-testid="wiki-gating-ratio">
          {t("wiki.gatingProgress.ratio", { passed, total, percent })}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        data-testid="wiki-gating-bar"
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {gates.map((g) => (
          <span
            key={g.key}
            className={
              g.on
                ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                : "rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            }
            data-testid={`wiki-gating-gate-${g.key}`}
            data-on={g.on}
          >
            {g.label}
          </span>
        ))}
      </div>
    </div>
  )
}
