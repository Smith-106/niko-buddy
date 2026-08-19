import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { DeAiBatchProgress, DeAiBatchSummary } from "@/lib/novel/de-ai-batch"

export interface DeAiBatchChapterRow {
  chapterNumber: number
  status: string
  lastError?: string
}

export interface DeAiBatchDialogProps {
  open: boolean
  running: boolean
  progress: DeAiBatchProgress | null
  summary: DeAiBatchSummary | null
  chapters: DeAiBatchChapterRow[]
  onCancel: () => void
  onAcceptAll: () => void
  onAcceptChapter: (chapterNumber: number) => void
  onRejectChapter: (chapterNumber: number) => void
  onClose: () => void
}

export function DeAiBatchDialog({
  open,
  running,
  progress,
  summary,
  chapters,
  onCancel,
  onAcceptAll,
  onAcceptChapter,
  onRejectChapter,
  onClose,
}: DeAiBatchDialogProps) {
  const total = progress?.total ?? summary?.total ?? 0
  const done = progress?.done ?? 0
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const readyChapters = chapters.filter((c) => c.status === "ready")
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        /* v8 ignore next -- 受控 Dialog 不会以 true 回调 */
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{running ? "批量去AI味处理中" : "批量去AI味结果"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {running && progress ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {done}/{total} 章（处理 {progress.processed} · 失败 {progress.failed} · 跳过 {progress.skipped}）
                </span>
                <span>{percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {progress.current ? (
                <div className="text-xs text-muted-foreground">
                  正在处理第 {progress.current.chapterNumber} 章…
                </div>
              ) : null}
            </div>
          ) : null}
          {!running && summary ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="text-xs text-muted-foreground">
                完成 {summary.processed} · 失败 {summary.failed.length} · 跳过 {summary.skipped} · 共 {summary.total} 章 · 耗时 {(summary.durationMs / 1000).toFixed(1)}s
              </div>
              {readyChapters.length > 0 ? (
                <div className="flex items-center justify-between rounded border border-border px-3 py-2">
                  <span>{readyChapters.length} 章待回填（Draft-first：确认后写回正式正文）</span>
                  <Button size="sm" onClick={onAcceptAll}>全部回填</Button>
                </div>
              ) : null}
              {chapters.length > 0 ? (
                <div className="max-h-56 overflow-y-auto rounded border border-border">
                  {chapters.map((chapter) => (
                    <div
                      key={chapter.chapterNumber}
                      className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                    >
                      <span>
                        第 {chapter.chapterNumber} 章 · {chapter.status}
                        {chapter.lastError ? <span className="text-destructive">（{chapter.lastError}）</span> : null}
                      </span>
                      {chapter.status === "ready" ? (
                        <span className="flex gap-1">
                          <Button size="sm" variant="outline" onClick={() => onRejectChapter(chapter.chapterNumber)}>拒绝</Button>
                          <Button size="sm" onClick={() => onAcceptChapter(chapter.chapterNumber)}>回填</Button>
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={onCancel}>中止</Button>
          ) : (
            <Button variant="outline" onClick={onClose}>关闭</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
