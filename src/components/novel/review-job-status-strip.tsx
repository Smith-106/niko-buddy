/**
 * U1 — review_job status strip (presentation only; never blocks write).
 */
import { useEffect, useState } from "react"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { formatReviewJobStatusLine, getReviewJobUiModel } from "@/lib/novel/review-job-ui"
import type { ReviewJobUiModel } from "@/lib/novel/review-job-ui"
import { useWikiStore } from "@/stores/wiki-store"
import { cn } from "@/lib/utils"

export function ReviewJobStatusStrip({
  className,
  refreshKey,
}: {
  className?: string
  /** Bump to re-read status.json */
  refreshKey?: string | number
}) {
  const projectPath = useWikiStore((s) => s.project?.path)
  const [model, setModel] = useState<ReviewJobUiModel | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!projectPath) {
        if (!cancelled) setModel(null)
        return
      }
      try {
        const status = await loadNovelSessionStatus(projectPath)
        if (cancelled) return
        setModel(getReviewJobUiModel(status?.review_job))
      } catch {
        if (!cancelled) setModel(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath, refreshKey])

  if (!model) return null

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground",
        className,
      )}
      data-testid="review-job-status-strip"
      title="Write/review split — review never blocks accept"
    >
      <span className="font-medium text-foreground/80">{model.phaseLabel}</span>
      {model.chapterNumber != null && (
        <span className="ml-1.5">ch={model.chapterNumber}</span>
      )}
      <span className="ml-1.5 opacity-80">· write unblocked</span>
      <div className="mt-0.5 truncate font-mono text-[10px] opacity-70">
        {formatReviewJobStatusLine(
          // reconstruct minimal for line — model already has statusLine
          {
            schemaVersion: "write-review-split/1.0",
            phase: model.phase,
            chapterNumber: model.chapterNumber,
            writeReadyAt: model.writeReadyAt,
            reviewQueuedAt: model.reviewQueuedAt,
            reviewStartedAt: model.reviewStartedAt,
            reviewFinishedAt: model.reviewFinishedAt,
            note: model.note,
            blocksWrite: false,
            productHardGate: false,
          },
        )}
      </div>
    </div>
  )
}
