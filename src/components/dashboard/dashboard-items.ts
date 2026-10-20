import type { NovelReviewResult, FactCheckResult } from "@/lib/novel"
import type { LintResult } from "@/lib/lint"
import { getFileStem } from "@/lib/path-utils"
import type { DashboardIssueAnchor } from "@/lib/dashboard-issue-actions"

export type DashSeverity = "blocking" | "high" | "medium" | "low"

export interface DashItem {
  id: string
  severity: DashSeverity
  source: "review" | "lint" | "factcheck"
  message: string
  detail: string
  evidence?: string
  secondaryEvidence?: string
  suggestion?: string
  targetPath?: string | null
  targetChapterNumber?: number
}

export interface RewriteDialogState {
  mode: "replace" | "insert_before"
  item: DashItem
  targetPath: string
  anchor: DashboardIssueAnchor | null
  sourceContent: string
  candidateContent: string
}

export const FACT_CHECK_TYPE_LABEL_KEYS: Record<FactCheckResult["type"], string> = {
  character_jump: "dashboard.factCheckType.character_jump",
  location_conflict: "dashboard.factCheckType.location_conflict",
  item_holder_change: "dashboard.factCheckType.item_holder_change",
  org_flip: "dashboard.factCheckType.org_flip",
  timeline_conflict: "dashboard.factCheckType.timeline_conflict",
  setting_conflict: "dashboard.factCheckType.setting_conflict",
  relationship_reversal: "dashboard.factCheckType.relationship_reversal",
  causality_break: "dashboard.factCheckType.causality_break",
}

export const DEBT_LEVEL_LABEL_KEYS: Record<"critical" | "warning", string> = {
  critical: "dashboard.debtLevel.critical",
  warning: "dashboard.debtLevel.warning",
}

export function mapReviewSeverity(severity: NovelReviewResult["severity"]): DashSeverity {
  switch (severity) {
    case "error": return "high"
    case "warning": return "medium"
    case "info": return "low"
    default: return "medium"
  }
}

export function mapLintSeverity(severity: LintResult["severity"]): DashSeverity {
  switch (severity) {
    case "warning": return "medium"
    case "info": return "low"
    default: return "medium"
  }
}

export function mapFactCheckSeverity(severity: FactCheckResult["severity"]): DashSeverity {
  switch (severity) {
    case "blocking": return "blocking"
    case "high": return "high"
    case "medium": return "medium"
    case "low": return "low"
    default: return "medium"
  }
}

export function extractChapterNumberFromTargetPath(targetPath: string | null | undefined): number | null {
  /* v8 ignore next */
  if (!targetPath) return null
  const stem = getFileStem(targetPath)
  const match = stem.match(/^(\d{1,4})(?:\D|$)/)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

export function formatDashItemDetail(item: DashItem): string {
  if (item.source === "factcheck" && item.detail in FACT_CHECK_TYPE_LABEL_KEYS) {
    return FACT_CHECK_TYPE_LABEL_KEYS[item.detail as FactCheckResult["type"]]
  }
  return item.detail
}

