import {
  AlertTriangle,
  Copy,
  FileQuestion,
  Lightbulb,
  MessageSquare,
  X,
  Check,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"
import type {
  ReviewRewriteEdit,
} from "@/lib/review-rewrite-plan"

export const typeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; labelKey: string; novelLabelKey: string; color: string }> = {
  contradiction: { icon: AlertTriangle, labelKey: "review.typeLabels.contradiction", novelLabelKey: "novel.review.typeLabels.contradiction", color: "text-warning" },
  duplicate: { icon: Copy, labelKey: "review.typeLabels.duplicate", novelLabelKey: "novel.review.typeLabels.duplicate", color: "text-chart-3" },
  "missing-page": { icon: FileQuestion, labelKey: "review.typeLabels.missingPage", novelLabelKey: "novel.review.typeLabels.missingPage", color: "text-chart-1" },
  confirm: { icon: MessageSquare, labelKey: "review.typeLabels.confirm", novelLabelKey: "novel.review.typeLabels.confirm", color: "text-foreground" },
  suggestion: { icon: Lightbulb, labelKey: "review.typeLabels.suggestion", novelLabelKey: "novel.review.typeLabels.suggestion", color: "text-success" },
}

export interface ReviewRewriteEditState extends ReviewRewriteEdit {
  status: "pending" | "ignored"
  editing: boolean
}

export function actionLooksLikeCreate(action: string): boolean {
  return action.startsWith("create:") || action.startsWith("new:") || action.includes("创建") || action.includes("新增")
}

export function detectPageType(action: string, itemType: string): "query" | "entity" | "concept" {
  if (action.includes("query") || action.includes("问题")) return "query"
  if (action.includes("entity") || action.includes("人物") || action.includes("地点") || action.includes("组织")) return "entity"
  if (action.includes("concept") || action.includes("设定") || action.includes("概念")) return "concept"
  /* v8 ignore next */
  if (itemType === "character" || itemType === "location" || itemType === "organization") return "entity"
  return "query"
}




/**
 * F-003 BreakerStatusBadge: 展示情绪账本熔断器三态 (tripped/armed/open)。
 * 复用 emotion-ledger getCircuitBreakerStatus, 机械层零 LLM。
 * tripped(红) / armed(黄) / open(绿), status=null 时不渲染。
 */
export function BreakerStatusBadge({ status }: { status: { status: "tripped" | "armed" | "open"; reason: string } | null }) {
  if (!status) return null
  const labelKey = `review.breakerStatus.${status.status}`
  const label = i18n.exists(labelKey) ? i18n.t(labelKey) : status.status
  const colorMap: Record<string, string> = {
    tripped: "bg-destructive/20 text-destructive border-destructive/40 dark:bg-destructive/30 dark:text-destructive",
    armed: "bg-warning/20 text-warning border-warning/40 dark:bg-warning/30 dark:text-warning",
    open: "bg-success/20 text-success border-success/40 dark:bg-success/30 dark:text-success",
  }
  return (
    <span
      title={status.reason}
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium leading-none ${colorMap[status.status]}`}
    >
      <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
        status.status === "tripped" ? "bg-destructive" : status.status === "armed" ? "bg-warning" : "bg-success"
      }`} aria-hidden="true" />
      {label}
    </span>
  )
}

export function ReviewCard({
  item,
  onResolve,
  onDismiss,
}: {
  item: ReviewItem
  onResolve: (id: string, action: string) => void
  onDismiss: (id: string) => void
}) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const config = typeConfig[item.type]
  const Icon = config.icon

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-colors ${
        item.resolved ? "border-success/30 bg-success/5" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
          <span className="text-xs text-muted-foreground">{t(novelMode ? config.novelLabelKey : config.labelKey)}</span>
          <span className="font-medium">{item.title}</span>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("common.dismiss")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">{item.description}</p>

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-3 text-xs text-muted-foreground">
          {t(novelMode ? "novel.review.pages" : "review.pages")}: {item.affectedPages.join(", ")}
        </div>
      )}

      {!item.resolved ? (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((opt) => (
            <Button
              key={opt.action}
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => onResolve(item.id, opt.action)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-success">
          <Check className="h-3 w-3" aria-hidden="true" />
          {item.resolvedAction}
        </div>
      )}
    </div>
  )
}

export function ReviewRewritePreviewDialog({
  open,
  edits,
  error,
  busy,
  busyId,
  onReplacementChange,
  onIgnoredChange,
  onRegenerateOne,
  onRegenerateAll,
  onIgnoreAll,
  onEditAll,
  onApply,
  onClose,
}: {
  open: boolean
  edits: ReviewRewriteEditState[]
  error: string | null
  busy: boolean
  busyId: string | null
  onReplacementChange: (editId: string, replacementText: string) => void
  onIgnoredChange: (editId: string, ignored: boolean) => void
  onRegenerateOne: (editId: string) => void
  onRegenerateAll: () => void
  onIgnoreAll: () => void
  onEditAll: () => void
  onApply: () => void
  onClose: () => void
}) {
  const activeCount = edits.filter((edit) => edit.status !== "ignored").length
  const hasPendingContent = edits.some((edit) => edit.status !== "ignored" && edit.replacementText.trim())
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("review.rewrite.title")}</DialogTitle>
          <DialogDescription>
            {t("review.rewrite.description")}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRegenerateAll} disabled={busy}>
            {t("review.rewrite.regenerateAll")}
          </Button>
          <Button variant="outline" size="sm" onClick={onIgnoreAll} disabled={busy || edits.length === 0}>
            {t("review.rewrite.ignoreAll")}
          </Button>
          <Button variant="outline" size="sm" onClick={onEditAll} disabled={busy || edits.length === 0}>
            {t("review.rewrite.editAll")}
          </Button>
          {busy && (
            <span className="text-xs text-muted-foreground">{t("review.rewrite.generating")}</span>
          )}
        </div>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {edits.length === 0 ? (
            <div className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
              {t("review.rewrite.waiting")}
            </div>
          ) : edits.map((edit, index) => {
            const ignored = edit.status === "ignored"
            const rowBusy = busyId === edit.id
            return (
              <div
                key={edit.id}
                className={`rounded-md border p-3 ${ignored ? "border-muted-foreground/20 bg-muted/40 italic" : "bg-background"}`}
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{t("review.rewrite.editLabel", { n: index + 1 })}</span>
                  {edit.note ? <span className="text-xs text-muted-foreground">{edit.note}</span> : null}
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRegenerateOne(edit.id)}
                      disabled={busy}
                      className="h-8 text-xs"
                    >
                      {rowBusy ? t("review.rewrite.generatingShort") : t("review.rewrite.regenerate")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onIgnoredChange(edit.id, !ignored)}
                      disabled={busy}
                      className="h-8 text-xs"
                    >
                      {ignored ? t("review.rewrite.restore") : t("review.rewrite.ignore")}
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="min-h-0 rounded-md border bg-destructive/70 p-3 text-sm leading-6 whitespace-pre-wrap text-destructive dark:bg-destructive/25 dark:text-destructive">
                    {edit.originalText}
                  </div>
                  <textarea
                    aria-label={t("review.rewrite.replacementLabel")}
                    value={edit.replacementText}
                    onChange={(event) => onReplacementChange(edit.id, event.target.value)}
                    disabled={busy || ignored}
                    className="min-h-32 rounded-md border bg-success/70 p-3 text-sm leading-6 text-success outline-none focus:border-ring disabled:opacity-70 dark:bg-success/25 dark:text-success"
                  />
                </div>
              </div>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={onApply} disabled={busy || !hasPendingContent || activeCount === 0}>
            {t("review.rewrite.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
