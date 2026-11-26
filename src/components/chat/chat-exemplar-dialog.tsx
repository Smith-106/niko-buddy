// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { StyleExemplarMarkType, StyleExemplarRecord } from "@/commands/exemplar"

/**
 * chat-exemplar-dialog.tsx — M1-3 切片：exemplar 标记 Dialog 纯展示组件。
 *
 * 从 chat-panel.tsx（2732 行）剥出的内聚 UI 块：EPIC-001 / TASK-005 / ADR-29
 * exemplar 标记 UI（C-001 Draft-first 例外，用户标记锚点非自动生成）。
 * 零 store 访问、零 IO：状态与回调全部由父级经 useExemplarState 注入。
 */

export interface ExemplarMarkDialogProps {
  dialog: { open: boolean; text: string; chapterId: string }
  markType: StyleExemplarMarkType
  note: string
  count: number
  feedback: string
  list: StyleExemplarRecord[]
  deleteConfirmId: string | null
  t: (key: string, options?: Record<string, unknown>) => string
  onClose: () => void
  onMarkTypeChange: (markType: StyleExemplarMarkType) => void
  onNoteChange: (note: string) => void
  onDeleteRequest: (exemplarId: string) => void
  onDeleteCancel: () => void
  onDeleteConfirm: (exemplarId: string) => void
  onABScore: (score: number, variant: "enabled" | "disabled") => void
  onSubmit: () => void
}

export function ExemplarMarkDialog(props: ExemplarMarkDialogProps) {
  const {
    dialog, markType, note, count, feedback, list, deleteConfirmId, t,
    onClose, onMarkTypeChange, onNoteChange,
    onDeleteRequest, onDeleteCancel, onDeleteConfirm, onABScore, onSubmit,
  } = props
  const markTypeLabel = (kind: StyleExemplarMarkType): string => {
    if (kind === "voice") return t("chat.exemplarVoice", { defaultValue: "人物口吻与对话" })
    if (kind === "pacing") return t("chat.exemplarPacing", { defaultValue: "节奏与氛围" })
    return t("chat.exemplarStyle", { defaultValue: "文风与描写" })
  }
  return (
    /* EPIC-001 / TASK-005 / ADR-29: exemplar 标记 UI（C-001 Draft-first 例外，用户标记锚点非自动生成） */
    <Dialog open={dialog.open} onOpenChange={/* v8 ignore next */ (open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("chat.markExemplar")}</DialogTitle>
          <DialogDescription>
            {t("chat.exemplar.description", {
              defaultValue: "后续 AI 写作会自动参考你收藏的好段落，仅记录你手动挑选的范例，不会自动改写正文。",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/20 p-3 text-xs leading-6 text-foreground whitespace-pre-wrap">
          {dialog.text}
        </div>
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex items-center gap-2">
            <span className="w-20 text-muted-foreground">
              {t("chat.exemplar.categoryLabel", { defaultValue: "偏好标记" })}
            </span>
            <select
              className="rounded border bg-background px-2 py-1 text-xs"
              value={markType}
              onChange={(e) => onMarkTypeChange(e.target.value as StyleExemplarMarkType)}
            >
              <option value="style">{t("chat.exemplarStyle")}</option>
              <option value="voice">{t("chat.exemplarVoice")}</option>
              <option value="pacing">{t("chat.exemplarPacing")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("chat.exemplarNote")}</span>
            <textarea
              className="rounded border bg-background px-2 py-1 text-xs"
              rows={2}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder={t("chat.exemplarWhyPlaceholder")}
            />
          </label>
          <div className="text-muted-foreground">
            {t("chat.exemplar.savedCount", {
              count,
              defaultValue: `当前项目已收藏文风范例：${count} 条`,
            })}
          </div>
          {/* ③-6 审计修复：范例列表 + 删除按钮（二次确认） */}
          {list.length > 0 ? (
            <div className="max-h-32 overflow-y-auto rounded-md border bg-muted/10">
              <div className="sticky top-0 bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground">{t("chat.exemplarsMarked")}</div>
              {list.map((ex) => (
                <div key={ex.exemplarId} className="flex items-start gap-2 border-t px-2 py-1 text-xs first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-foreground">{ex.text.slice(0, 60)}{ex.text.length > 60 ? "…" : ""}</div>
                    <div className="text-muted-foreground">
                      {markTypeLabel(ex.markType)}{ex.chapterId !== "chat-selection" ? ` · ${ex.chapterId}` : ""}
                    </div>
                  </div>
                  {deleteConfirmId === ex.exemplarId ? (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => onDeleteConfirm(ex.exemplarId)}
                      >{t("chat.confirmDelete")}</Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={onDeleteCancel}
                      >{t("common.cancel")}</Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-xs"
                      onClick={() => onDeleteRequest(ex.exemplarId)}
                      title={t("chat.deleteExemplar")}
                      aria-label={t("chat.deleteExemplar")}
                    >{t("common.delete")}</Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          {feedback && (
            <div role="status" className="rounded bg-muted/40 px-2 py-1 text-xs text-foreground">{feedback}</div>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="self-center text-xs text-muted-foreground">
              {t("chat.exemplar.feedbackLabel", { defaultValue: "效果反馈：" })}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("chat.exemplar.feedbackEnabled", { defaultValue: "开启参考时" })}
            </span>
            {[1, 2, 3, 4, 5].map((s) => (
              <Button
                key={`en-${s}`}
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onABScore(s, "enabled")}
                title={t("chat.exemplarSlopScore")}
              >
                {s}★
              </Button>
            ))}
            <span className="ml-1 text-[11px] text-muted-foreground">
              {t("chat.exemplar.feedbackDisabled", { defaultValue: "关闭参考时" })}
            </span>
            {[1, 2, 3, 4, 5].map((s) => (
              <Button
                key={`dis-${s}`}
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onABScore(s, "disabled")}
                title={t("chat.slopOnlyScore")}
              >
                {s}★
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={onSubmit}>{t("chat.markAnchor")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
