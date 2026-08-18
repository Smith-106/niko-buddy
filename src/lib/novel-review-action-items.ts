import type { NovelReviewResult } from "@/lib/novel/review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"
import { buildDashboardIssueId } from "@/lib/dashboard-issue-actions"
import { scoreReviewResults } from "@/lib/novel/review-scoring"
import { buildReviewScoringOptions } from "@/lib/user-memory/injector"
import type { UserMemoryStore } from "@/lib/user-memory/types"

export type NovelReviewActionSeverity = "blocking" | "high" | "medium" | "low"

export interface NovelReviewActionItem {
  id: string
  severity: NovelReviewActionSeverity
  reviewSeverity: NovelReviewResult["severity"]
  source: "review"
  message: string
  detail: string
  evidence?: string
  secondaryEvidence?: string
  suggestion?: string
  targetPath: string
  /**
   * 连续性 finding 透传元数据 (G2 DD-1/DD-3): 仅 consistency_mechanical finding 携带,
   * 供 review-view dismiss UI 消费 (调 dismissFinding 写 override store)。ref 作稳定
   * 跨检测 dismiss key (非 id — id 含 message/evidence 跨检测会变)。subtype==='data_gap'
   * 时 UI 隐藏 dismiss 按钮 (info 级禁 dismiss, DD-5 双守)。additive 可选, 非连续性
   * finding undefined 零行为变更。
   */
  continuityMeta?: {
    subtype: string
    ref: string
    chapter: number
    missingField?: string
  }
}

export function mapNovelReviewActionSeverity(severity: NovelReviewResult["severity"]): NovelReviewActionSeverity {
  switch (severity) {
    case "error": return "high"
    case "warning": return "medium"
    case "info": return "low"
    default: return "medium"
  }
}

export function buildNovelReviewActionItem(targetPath: string, result: NovelReviewResult): NovelReviewActionItem {
  return {
    id: buildDashboardIssueId(["review", targetPath, result.type, result.message, result.evidence]),
    severity: mapNovelReviewActionSeverity(result.severity),
    reviewSeverity: result.severity,
    source: "review",
    message: result.message,
    detail: result.type,
    evidence: result.evidence,
    suggestion: result.suggestion,
    targetPath,
    // G2 DD-1: 透传 continuityMeta (continuity finding 携带, LLM 审查 result 无此字段 → undefined 零行为变更)
    ...(result.continuityMeta ? { continuityMeta: result.continuityMeta } : {}),
  }
}

export function buildVisibleNovelReviewActionItems(
  targetPath: string | null | undefined,
  results: NovelReviewResult[],
  ignored: Record<string, true>,
): NovelReviewActionItem[] {
  if (!targetPath) return []
  return results
    .map((result) => buildNovelReviewActionItem(targetPath, result))
    .filter((item) => !ignored[item.id])
}

export function buildVisibleNovelReviewActionItemsForScoreDimensions(
  targetPath: string | null | undefined,
  results: NovelReviewResult[],
  ignored: Record<string, true>,
  scoreDimensionKeys: string[],
  userMemoryStore?: UserMemoryStore,
): NovelReviewActionItem[] {
  if (scoreDimensionKeys.length === 0) {
    return buildVisibleNovelReviewActionItems(targetPath, results, ignored)
  }

  const allowed = new Set(scoreDimensionKeys)
  const scopedResults: NovelReviewResult[] = []
  // 用户校准门控：仅当存在用户维度/严重度覆盖时才传 options（无偏好时逐字节回退旧行为）
  const opts = userMemoryStore ? buildReviewScoringOptions(userMemoryStore) : undefined
  const scoringOptions = opts && (opts.dimensionWeights || opts.severityDeductions) ? opts : undefined
  for (const dimension of scoreReviewResults(results, scoringOptions).dimensions) {
    if (allowed.has(dimension.key)) {
      scopedResults.push(...dimension.issues)
    }
  }
  return buildVisibleNovelReviewActionItems(targetPath, scopedResults, ignored)
}

export function buildVisibleNovelReviewActionItemsForDimensionResults(
  targetPath: string | null | undefined,
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> | null | undefined,
  ignored: Record<string, true>,
  dimensionKey: SixReviewDimensionKey,
): NovelReviewActionItem[] {
  if (!targetPath) return []
  const result = dimensionResults?.[dimensionKey]
  if (!result) return []

  return result.issues
    .map((issue) => ({
      ...buildNovelReviewActionItem(targetPath, issue),
      detail: issue.dimensionKey,
      secondaryEvidence: issue.rewriteTarget || issue.evidence,
    }))
    .filter((item) => !ignored[item.id])
}
