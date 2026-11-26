// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { WikiReader } from "@/components/editor/wiki-reader"
import { diffLines, type ChapterDraft, type LineDiffEntry } from "@/lib/novel"

export interface DraftPreviewDiffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "preview" | "diff"
  draft: ChapterDraft | null
  /** 目标正式章路径（diff 模式下展示）。 */
  targetPath?: string | null
  /** 目标正式章当前磁盘全文（null/undefined 表示目标文件尚不存在）。 */
  existingContent?: string | null
  /** 正在读取目标正式章时为 true。 */
  loading?: boolean
  /** 读取目标正式章失败时的错误说明。 */
  error?: string | null
}

/**
 * 草稿正文预览与覆盖对比弹窗（P0-04 / R2-U02）。
 *
 * 仅从 `@/lib/novel` barrel 导入 `diffLines`（遵守 ESLint boundaries），
 * 支持「预览正文」与覆盖前「查看覆盖对比 (Diff)」两种模式，零写盘副作用。
 */
export function DraftPreviewDiffDialog({
  open,
  onOpenChange,
  mode,
  draft,
  targetPath = null,
  existingContent = null,
  loading = false,
  error = null,
}: DraftPreviewDiffDialogProps) {
  const { t } = useTranslation()

  const wordCount = useMemo(
    () => (draft ? draft.content.replace(/\s/g, "").length : 0),
    [draft],
  )

  const diffEntries = useMemo<LineDiffEntry[]>(() => {
    if (mode !== "diff" || !draft || existingContent === null || existingContent === undefined) {
      return []
    }
    return diffLines(existingContent, draft.content)
  }, [mode, draft, existingContent])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col"
        data-testid="draft-preview-diff-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "preview"
              ? t("mainControl.draftPreviewTitle")
              : t("mainControl.draftDiffTitle")}
            {draft ? ` · ${draft.chapterName}` : ""}
          </DialogTitle>
          <DialogDescription>
            {draft ? t("mainControl.draftWords", { count: wordCount }) : ""}
            {mode === "diff" && targetPath ? ` · ${targetPath}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/20 p-3 text-xs">
          {!draft ? null : mode === "preview" ? (
            <div data-testid="draft-preview-body">
              <WikiReader body={draft.content} />
            </div>
          ) : loading ? (
            <div
              className="flex items-center justify-center gap-2 py-8 text-muted-foreground"
              data-testid="draft-diff-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>{t("common.loading")}</span>
            </div>
          ) : error ? (
            <div
              role="alert"
              data-testid="draft-diff-error"
              className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive"
            >
              {error}
            </div>
          ) : existingContent === null || existingContent === undefined ? (
            <div className="space-y-2" data-testid="draft-diff-new-file">
              <p className="rounded border border-primary/30 bg-primary/5 px-2 py-1 text-primary">
                {t("mainControl.draftDiffNewFileHint")}
              </p>
              <WikiReader body={draft.content} />
            </div>
          ) : diffEntries.length === 0 ? (
            <p
              className="py-6 text-center text-muted-foreground"
              data-testid="draft-diff-no-changes"
            >
              {t("mainControl.draftDiffNoChanges")}
            </p>
          ) : (
            <div className="space-y-2" data-testid="draft-diff-body">
              <p className="font-medium text-muted-foreground" data-testid="draft-diff-count">
                {t("mainControl.draftDiffChangedLines", { count: diffEntries.length })}
              </p>
              <ul className="space-y-1.5 font-mono text-xs">
                {diffEntries.map((entry) => (
                  <li
                    key={entry.line}
                    data-testid={`draft-diff-line-${entry.line}`}
                    className="overflow-hidden rounded border border-border/70 bg-background"
                  >
                    <div className="border-b border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                      L{entry.line}
                    </div>
                    {entry.before !== "" ? (
                      <div className="whitespace-pre-wrap break-words bg-destructive/10 px-2 py-1 text-destructive">
                        - {entry.before}
                      </div>
                    ) : null}
                    {entry.after !== "" ? (
                      <div className="whitespace-pre-wrap break-words bg-success/10 px-2 py-1 text-success-foreground">
                        + {entry.after}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
