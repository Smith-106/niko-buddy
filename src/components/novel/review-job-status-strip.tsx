/**
 * U1 — review_job status strip (presentation only; never blocks write).
 */
import { useEffect, useState } from "react"
import { loadNovelSessionStatus, formatReviewJobStatusLine, getReviewJobUiModel } from "@/lib/novel"
import type { ReviewJobUiModel } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { cn } from "@/lib/utils"

const PHASE_PLAIN: Record<string, string> = {
  idle: "审稿空闲",
  queued: "审稿排队",
  running: "审稿进行中",
  done: "审稿完成",
  failed: "审稿失败",
}

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
        /* v8 ignore next */
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

  // ③-9：任务运行中轮询 status.json（仅 running 时启动，卸载/停止清理），
  // 消除 refreshKey 不变时状态条停滞。已 grep 确认无跨进程 review 事件可订阅。
  const shouldPoll = Boolean(projectPath) && model?.phase === "running"
  useEffect(() => {
    if (!shouldPoll || !projectPath) return
    let cancelled = false
    const id = setInterval(async () => {
      try {
        const status = await loadNovelSessionStatus(projectPath)
        if (cancelled) return
        setModel(getReviewJobUiModel(status?.review_job))
      } catch {
        /* 轮询失败不阻断：下次继续 */
      }
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [projectPath, shouldPoll])

  if (!model) return null

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground",
        className,
      )}
      data-testid="review-job-status-strip"
      title="审稿不挡住写作"
    >
      <span className="font-medium text-foreground">
        {PHASE_PLAIN[model.phase] ?? "审稿"}
        <span className="sr-only">{model.phaseLabel}</span>
      </span>
      {model.chapterNumber != null && (
        <span className="ml-1.5">
          第 {model.chapterNumber} 章
          <span className="sr-only">ch={model.chapterNumber}</span>
        </span>
      )}
      <span className="ml-1.5 opacity-80">
        · 写作没有被挡住
        <span className="sr-only">write unblocked</span>
      </span>
      <div className="sr-only">
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
