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
import type { NovelReviewEntry, ReviewItem } from "@/stores/review-store"
import type { NovelReviewResult } from "@/lib/novel"
import type {
  ReviewRewriteEdit,
} from "@/lib/review-rewrite-plan"

export const typeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; labelKey: string; novelLabelKey: string; color: string }> = {
  contradiction: { icon: AlertTriangle, labelKey: "review.typeLabels.contradiction", novelLabelKey: "novel.review.typeLabels.contradiction", color: "text-warning-foreground" },
  duplicate: { icon: Copy, labelKey: "review.typeLabels.duplicate", novelLabelKey: "novel.review.typeLabels.duplicate", color: "text-chart-3" },
  "missing-page": { icon: FileQuestion, labelKey: "review.typeLabels.missingPage", novelLabelKey: "novel.review.typeLabels.missingPage", color: "text-chart-1" },
  confirm: { icon: MessageSquare, labelKey: "review.typeLabels.confirm", novelLabelKey: "novel.review.typeLabels.confirm", color: "text-foreground" },
  suggestion: { icon: Lightbulb, labelKey: "review.typeLabels.suggestion", novelLabelKey: "novel.review.typeLabels.suggestion", color: "text-success-foreground" },
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
    armed: "bg-warning/20 text-warning-foreground border-warning/40 dark:bg-warning/30 dark:text-warning-foreground",
    open: "bg-success/20 text-success-foreground border-success/40 dark:bg-success/30 dark:text-success-foreground",
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
        <div className="flex items-center gap-1 text-xs text-success-foreground">
          <Check className="h-3 w-3" aria-hidden="true" />
          {item.resolvedAction}
        </div>
      )}
    </div>
  )
}

const CONSISTENCY_GATE_TYPES = new Set([
  "timeline_consistency",
  "character_consistency",
  "setting_consistency",
  "foreshadowing_integrity",
  "plot_continuity",
  "causal_chain",
  "knowledge_boundary",
  "memory_consistency",
  "location_consistency",
  "ability_consistency",
  "subplot_resolution",
  "arc_structural",
  "canon_alignment",
  "secret_guarding",
  "emotional_arc_consistency",
  "consistency",
  "continuity",
  "contradiction",
  "canon_violation",
  "fact_conflict",
  "state_delta_light_check",
])

const ANTI_AI_GATE_TYPES = new Set([
  "slop_explanation",
  "slop_summary",
  "slop_mechanical",
  "slop_emotion_abstract",
  "statistical_ai_signature",
  "de_ai_residual",
  "behavioral_repetition",
  "formulaic_transition",
  "generic_description",
  "translationese",
  "anti_ai",
  "ai_style",
  "ai_tone",
])

const QUALITY_GATE_TYPES = new Set([
  "thrill_density",
  "reading_power",
  "pacing_tension",
  "dialogue_quality",
  "description_vividness",
  "emotional_impact",
  "structural_balance",
  "narrative_innovation",
  "consistency_of_voice",
  "scene_craft",
  "tension_curve",
  "worldbuilding_immersion",
  "quality",
])

type ReviewPriorityTier = "P0" | "P1" | "P2"

function classifyNovelReviewTier(type: string): ReviewPriorityTier {
  const normalized = type.trim().toLowerCase()
  if (QUALITY_GATE_TYPES.has(normalized)) return "P2"
  if (CONSISTENCY_GATE_TYPES.has(normalized)) return "P0"
  if (ANTI_AI_GATE_TYPES.has(normalized)) return "P1"
  if (
    normalized.includes("consistency") ||
    normalized.includes("continuity") ||
    normalized.includes("canon") ||
    normalized.includes("timeline") ||
    normalized.includes("foreshadow") ||
    normalized.includes("contradiction")
  ) {
    return "P0"
  }
  if (
    normalized.includes("anti_ai") ||
    normalized.includes("de_ai") ||
    normalized.includes("slop")
  ) {
    return "P1"
  }
  return "P2"
}

const TIER_RANK: Record<ReviewPriorityTier, number> = { P0: 0, P1: 1, P2: 2 }
const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 }

/**
 * 展示保存前审稿（pre-save review）挂入 reviewStore 的章节审稿条目，
 * 严格按门控优先级 Consistency(P0) > Anti-AI(P1) > Quality(P2) 排序，
 * 并提供「打开本章」与「标记已处理」（消除侧边栏幽灵红点）。
 */
export function NovelReviewEntryCard({
  entry,
  onOpenChapter,
  onDismiss,
}: {
  entry: NovelReviewEntry
  onOpenChapter: (chapterNumber: number) => void
  onDismiss: (id: string) => void
}) {
  const { t } = useTranslation()
  const sortedResults = [...entry.results].sort((a: NovelReviewResult, b: NovelReviewResult) => {
    const tierDiff =
      TIER_RANK[classifyNovelReviewTier(a.type)] - TIER_RANK[classifyNovelReviewTier(b.type)]
    if (tierDiff !== 0) return tierDiff
    return (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
  })

  return (
    <div
      data-testid={`novel-review-entry-${entry.id}`}
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="font-medium">
            {t("novel.review.chapterReviewTitle", { chapter: entry.chapterNumber })}
          </span>
          {entry.createdAt ? (
            <span className="text-xs text-muted-foreground">
              {entry.createdAt.slice(0, 16).replace("T", " ")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            data-testid={`novel-review-entry-open-${entry.id}`}
            onClick={() => onOpenChapter(entry.chapterNumber)}
          >
            {t("novel.review.openChapter")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            data-testid={`novel-review-entry-dismiss-${entry.id}`}
            onClick={() => onDismiss(entry.id)}
          >
            {t("novel.review.markResolved")}
          </Button>
        </div>
      </div>

      <ul className="space-y-1.5" data-testid={`novel-review-entry-findings-${entry.id}`}>
        {sortedResults.map((finding, index) => {
          const tier = classifyNovelReviewTier(finding.type)
          const tierLabelKey =
            tier === "P0"
              ? "novel.review.priorityP0"
              : tier === "P1"
                ? "novel.review.priorityP1"
                : "novel.review.priorityP2"
          const tierBadgeClass =
            tier === "P0"
              ? "border-destructive/40 bg-destructive/15 text-destructive"
              : tier === "P1"
                ? "border-warning/40 bg-warning/15 text-warning-foreground"
                : "border-border bg-muted text-muted-foreground"
          const dimKey = `review.results.dimension.${finding.type}`
          const dimLabel = i18n.exists(dimKey) ? i18n.t(dimKey) : finding.type
          return (
            <li
              key={`${entry.id}-${finding.type}-${index}`}
              data-testid={`novel-review-entry-finding-${entry.id}-${index}`}
              data-tier={tier}
              className="rounded border border-border/60 bg-background/80 p-2 text-xs"
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${tierBadgeClass}`}>
                  {t(tierLabelKey)}
                </span>
                <span className="font-medium text-foreground">{dimLabel}</span>
                <span className="text-muted-foreground">{finding.severity}</span>
              </div>
              <p className="text-foreground">{finding.message}</p>
              {finding.evidence ? (
                <p className="mt-1 italic text-muted-foreground">「{finding.evidence}」</p>
              ) : null}
              {finding.suggestion ? (
                <p className="mt-1 text-success-foreground">{finding.suggestion}</p>
              ) : null}
            </li>
          )
        })}
      </ul>
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
                    className="min-h-32 rounded-md border bg-success/70 p-3 text-sm leading-6 text-success-foreground outline-none focus:border-ring disabled:opacity-70 dark:bg-success/25 dark:text-success-foreground"
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
