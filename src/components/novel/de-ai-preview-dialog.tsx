import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MonacoDiffEditor } from "./monaco-diff-editor"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { DeAiMode, DeAiDetectResult, DeAiSpanApplyResult } from "@/lib/novel/de-ai-adapter"
import { DEFAULT_DE_AI_MODE } from "@/lib/novel/de-ai-adapter"

export interface DeAiPreviewDialogProps {
  open: boolean
  sourceContent: string
  candidateContent: string
  mode?: DeAiMode
  detectResult?: DeAiDetectResult | null
  editResult?: DeAiSpanApplyResult | null
  processing?: boolean
  onModeChange?: (mode: DeAiMode) => void
  onApply: () => void
  onSaveDraft: () => void
  onClose: () => void
}

export function DeAiPreviewDialog({
  open,
  sourceContent,
  candidateContent,
  mode,
  detectResult,
  editResult,
  processing = false,
  onModeChange,
  onApply,
  onSaveDraft,
  onClose,
}: DeAiPreviewDialogProps) {
  const { t } = useTranslation()
  const currentMode = mode ?? DEFAULT_DE_AI_MODE

  const hasFailed = Boolean(editResult && !editResult.ok)
  const failedCount = editResult && !editResult.ok ? editResult.failed.length : 0
  const appliedCount = editResult ? editResult.applied.length : 0

  const hitsCount = detectResult?.hits?.length ?? 0
  const slopPenalty = detectResult?.slopPenalty ?? 0
  const slopClass = detectResult?.slopClass ?? "clean"

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4">
            <DialogTitle>{t("novel.deai.preview")}</DialogTitle>
            <div
              className="flex items-center gap-1 rounded-lg bg-muted p-1 text-xs"
              role="tablist"
              aria-label={t("novel.deai.mode")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={currentMode === "detect"}
                data-testid="de-ai-mode-detect"
                disabled={processing}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  currentMode === "detect"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onModeChange?.("detect")}
              >
                {t("novel.deai.modeDetect")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentMode === "rewrite"}
                data-testid="de-ai-mode-rewrite"
                disabled={processing}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  currentMode === "rewrite"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onModeChange?.("rewrite")}
              >
                {t("novel.deai.modeRewrite")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentMode === "edit"}
                data-testid="de-ai-mode-edit"
                disabled={processing}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  currentMode === "edit"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onModeChange?.("edit")}
              >
                {t("novel.deai.modeEdit")}
              </button>
            </div>
          </div>
        </DialogHeader>

        {processing ? (
          <div className="flex h-96 flex-col items-center justify-center gap-2 text-muted-foreground">
            <div className="text-sm font-medium">{t("novel.deai.processing")}</div>
          </div>
        ) : currentMode === "detect" ? (
          <div className="flex flex-col gap-3 py-1">
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <span className="font-medium">
                {hitsCount > 0
                  ? t("novel.deai.findingsSummary", { count: hitsCount, penalty: slopPenalty.toFixed(1) })
                  : t("novel.deai.noFindings")}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase",
                  slopClass === "clean" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
                  slopClass === "warn" && "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
                  slopClass === "block" && "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
                )}
              >
                {slopClass}
              </span>
            </div>

            {hitsCount > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs font-semibold text-muted-foreground">
                  {t("novel.deai.detectHitsTitle")} ({hitsCount})
                </div>
                <div className="max-h-36 overflow-y-auto rounded-md border divide-y text-xs">
                  {detectResult!.hits.map((hit) => (
                    <div key={hit.id} className="flex items-center justify-between px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-rose-600 dark:text-rose-400">「{hit.term}」</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{hit.category}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Tier {hit.tier}</span>
                      </div>
                      <span className="text-muted-foreground text-[11px]">{hit.suggestion}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-semibold text-muted-foreground">
                {t("novel.deai.detectMarkedPreview")}
              </div>
              <div
                data-testid="de-ai-marked-preview"
                className="h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs font-mono leading-relaxed select-text"
              >
                {detectResult?.markedText || sourceContent}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {currentMode === "edit" && editResult && (
              <div
                data-testid="de-ai-edit-status"
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2 text-xs",
                  hasFailed
                    ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
                    : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
                )}
              >
                <span className="font-medium">
                  {hasFailed
                    ? t("novel.deai.editConflictNotice", { failed: failedCount })
                    : t("novel.deai.editsSummary", { applied: appliedCount, failed: 0 })}
                </span>
                {hasFailed && (
                  <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                    ({failedCount} 处冲突)
                  </span>
                )}
              </div>
            )}
            <MonacoDiffEditor
              original={sourceContent}
              modified={candidateContent}
              height={currentMode === "edit" && editResult ? 440 : 480}
            />
          </div>
        )}

        {currentMode === "detect" ? (
          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <span className="text-xs text-muted-foreground" data-testid="de-ai-detect-notice">
              {t("novel.deai.detectNoWriteNotice")}
            </span>
            <Button variant="outline" onClick={onClose} data-testid="de-ai-close">
              {t("common.close", "关闭")}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button variant="outline" onClick={onClose} data-testid="de-ai-cancel">
              {t("common.cancel", "取消")}
            </Button>
            <Button
              variant="outline"
              disabled={currentMode === "edit" && hasFailed}
              onClick={onSaveDraft}
              data-testid="de-ai-save-draft"
            >
              {t("novel.deai.saveDraft")}
            </Button>
            <Button
              disabled={currentMode === "edit" && hasFailed}
              onClick={onApply}
              data-testid="de-ai-apply"
            >
              {t("novel.deai.replaceBody")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
