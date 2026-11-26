import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { DeAiBatchProgress, DeAiBatchSummary } from "@/lib/novel"
import { useTranslation } from "react-i18next"

export interface DeAiBatchChapterRow {
  chapterNumber: number
  status: string
  lastError?: string
  /** P1-3 规则自检摘要（Track B soft 诊断，非门；persona LLM 评审见章节工具栏“多视角评审”）。 */
  selfCheckSummary?: string
}

export interface DeAiBatchDialogProps {
  open: boolean
  running: boolean
  /** 批量回填/拒绝动作进行中（锁关窗并禁用动作按钮）。 */
  busy?: boolean
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
  busy = false,
  progress,
  summary,
  chapters,
  onCancel,
  onAcceptAll,
  onAcceptChapter,
  onRejectChapter,
  onClose,
}: DeAiBatchDialogProps) {
  const { t } = useTranslation()
  const total = progress?.total ?? summary?.total ?? 0
  const done = progress?.done ?? 0
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const readyChapters = chapters.filter((c) => c.status === "ready")
  const locked = running || busy
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        /* v8 ignore next -- 受控 Dialog 不会以 true 回调 */
        if (!next && !locked) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!locked}>
        <DialogHeader>
          <DialogTitle>
            {running
              ? t("novel.deai.batchRunningTitle", { defaultValue: "批量去AI味处理中" })
              : t("novel.deai.batchResultTitle", { defaultValue: "批量去AI味结果" })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {running && progress ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {t("novel.deai.batchProgressSummary", {
                    done,
                    total,
                    processed: progress.processed,
                    failed: progress.failed,
                    skipped: progress.skipped,
                    defaultValue: `${done}/${total} 章（处理 ${progress.processed} · 失败 ${progress.failed} · 跳过 ${progress.skipped}）`,
                  })}
                </span>
                <span>{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={t("novel.deai.batchProgressLabel", { defaultValue: "批量去AI味进度" })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {progress.current ? (
                <div className="text-xs text-muted-foreground">
                  {t("novel.deai.batchProcessingChapter", {
                    chapter: progress.current.chapterNumber,
                    defaultValue: `正在处理第 ${progress.current.chapterNumber} 章…`,
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          {!running && summary ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="text-xs text-muted-foreground">
                {t("novel.deai.batchSummary", {
                  processed: summary.processed,
                  failed: summary.failed.length,
                  skipped: summary.skipped,
                  total: summary.total,
                  seconds: (summary.durationMs / 1000).toFixed(1),
                  defaultValue: `完成 ${summary.processed} · 失败 ${summary.failed.length} · 跳过 ${summary.skipped} · 共 ${summary.total} 章 · 耗时 ${(summary.durationMs / 1000).toFixed(1)}s`,
                })}
              </div>
              {readyChapters.length > 0 ? (
                <div className="flex items-center justify-between rounded border border-border px-3 py-2">
                  <span>
                    {t("novel.deai.batchReadyNotice", {
                      count: readyChapters.length,
                      defaultValue: `${readyChapters.length} 章待回填（Draft-first：确认后写回正式正文）`,
                    })}
                  </span>
                  <Button size="sm" disabled={locked} onClick={onAcceptAll}>{t("novel.deai.fillAll")}</Button>
                </div>
              ) : null}
              {chapters.length > 0 ? (
                <div className="max-h-56 overflow-y-auto rounded border border-border">
                  {chapters.map((chapter) => (
                    <div
                      key={chapter.chapterNumber}
                      className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                    >
                      <span title={chapter.selfCheckSummary ?? undefined}>
                        第 {chapter.chapterNumber} 章 · {chapter.status}
                        {chapter.lastError ? <span className="text-destructive">（{chapter.lastError}）</span> : null}
                        {chapter.selfCheckSummary ? (
                          <span className="text-muted-foreground"> · 自检{chapter.selfCheckSummary}</span>
                        ) : null}
                      </span>
                      {chapter.status === "ready" ? (
                        <span className="flex gap-1">
                          <Button size="sm" variant="outline" disabled={locked} onClick={() => onRejectChapter(chapter.chapterNumber)}>
                            {t("novel.deai.reject", { defaultValue: "拒绝" })}
                          </Button>
                          <Button size="sm" disabled={locked} onClick={() => onAcceptChapter(chapter.chapterNumber)}>{t("novel.deai.fillBack")}</Button>
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
            <Button variant="outline" onClick={onCancel}>{t("novel.deai.abort")}</Button>
          ) : (
            <Button variant="outline" disabled={locked} onClick={onClose}>
              {t("common.close", { defaultValue: "关闭" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
