// M10-3 切片：dimension-review-adapter 结果解析 / 评分判定纯逻辑块（单轮收敛）。
// 内容：门控映射（DIM_TO_GATE_TYPE）/ 解析错误（DimParseError）/
// 结果解析（parseDimensionReviewResult，含 normalizeIssue / formatDimensionThinking /
// buildFailedDimensionResult）/ 评分归一（normalizeDimensionScore）/
// 档位校验（deriveScoreVerdict + validateDimensionScoreBand）/
// 最小返工集（minimalReworkSet + minimalReworkSetFromDimensionIssues）。
// 纯函数零 IO 零 LLM；仅复用原 adapter 已有依赖（@/lib/utils validateSeverity），未引入新依赖。
// dimension-review-adapter.ts 经同目录 import + re-export 保对外 import 面（符号名与签名不变）。

import { validateSeverity } from "@/lib/utils"
import type { NovelReviewResult } from "./review-adapter"
import type {
  DimensionReviewIssue,
  DimensionReviewResult,
  DimensionReviewStatus,
  SixReviewDimensionDefinition,
  SixReviewDimensionKey,
} from "./dimension-review-adapter"

/**
 * F-003 (ANL-010 R6): explicit 6-dim → review-`type` mapping.
 *
 * `resolveDecisionGateKey` in deep-chapter-generation.ts buckets a
 * NovelReviewResult into one of 3 gates (consistency / anti_ai / quality) by
 * matching its `type` string against CONSISTENCY_REVIEW_TYPES /
 * ANTI_AI_REVIEW_TYPES sets. A naive string-match would mis-bucket the
 * `character` DIMENSION (key "character") into the `quality` gate, because
 * CONSISTENCY_REVIEW_TYPES contains `character_consistency` — NOT `character`.
 * This mapping translates each of the 6 dimension keys into the review-`type`
 * string that lands it in the CORRECT gate, so the 6-dim fold composes with
 * the existing 18→3 fold instead of silently miscategorizing.
 *
 *   character       → character_consistency  (CONSISTENCY gate — NOT quality)
 *   continuity      → timeline               (CONSISTENCY gate)
 *   consistency     → consistency            (CONSISTENCY gate)
 *   pacing          → plot                   (quality gate)
 *   thrill          → plot                   (quality gate)
 *   pull            → plot                   (quality gate)
 */
export const DIM_TO_GATE_TYPE: Record<SixReviewDimensionKey, string> = {
  thrill: "plot",
  consistency: "consistency",
  pacing: "plot",
  character: "character_consistency",
  continuity: "timeline",
  pull: "plot",
}

/**
 * F-003: error class for malformed dimension-review JSON. Distinguishes a
 * SyntaxError (the model emitted non-JSON) from a runtime error so callers
 * can tell parse failures apart from stream/transport failures
 * (ISS-20260705-020 JSON.parse hardening).
 */
export class DimParseError extends Error {
  readonly raw: string
  readonly parseMessage: string
  constructor(raw: string, parseMessage: string) {
    super(`Dimension review JSON parse failed: ${parseMessage}`)
    this.name = "DimParseError"
    this.raw = raw
    this.parseMessage = parseMessage
  }
}

export function parseDimensionReviewResult(
  dimension: SixReviewDimensionDefinition,
  finalText: string,
  thinking: string,
): DimensionReviewResult {
  const jsonMatch = finalText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`${dimension.label}审查没有返回 JSON`)

  // F-003 (ISS-20260705-020): harden the unguarded JSON.parse. A SyntaxError
  // means the model emitted malformed JSON (truncation, code-fence leakage,
  // trailing prose) — wrap it in DimParseError so callers can distinguish a
  // parse failure from a runtime/stream failure. Non-SyntaxError throwables
  // are re-thrown unchanged.
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch (error) {
    /* v8 ignore next */
    if (error instanceof SyntaxError) {
      throw new DimParseError(jsonMatch[0], error.message)
    }
    throw error
  }
  const issues = Array.isArray(parsed.issues) ? parsed.issues : []
  return {
    dimensionKey: dimension.key,
    score: normalizeScore(parsed.score),
    status: validateStatus(parsed.status, issues.length),
    summary: String(parsed.summary || ""),
    thinking: formatDimensionThinking(dimension, thinking),
    issues: issues.map((item) => normalizeIssue(dimension.key, item as Record<string, unknown>)),
  }
}

function normalizeIssue(dimensionKey: SixReviewDimensionKey, item: Record<string, unknown>): DimensionReviewIssue {
  const evidence = String(item.evidence || "")
  return {
    severity: validateSeverity(item.severity),
    type: String(item.type || dimensionKey),
    dimensionKey,
    message: String(item.message || ""),
    evidence,
    relatedMemory: String(item.relatedMemory || ""),
    suggestion: String(item.suggestion || ""),
    impact: String(item.impact || ""),
    rewriteTarget: String(item.rewriteTarget || evidence),
  }
}

// M10-3 过渡公开导出：原 adapter 私有 helper，runDimensionStage 仍经此失败回退。
export function buildFailedDimensionResult(
  dimension: SixReviewDimensionDefinition,
  error: unknown,
): DimensionReviewResult {
  const message = error instanceof Error ? error.message : "未知错误"
  return {
    dimensionKey: dimension.key,
    score: 0,
    status: "error",
    summary: `${dimension.label}审查失败：${message}`,
    thinking: formatDimensionThinking(dimension, `审查失败：${message}`),
    issues: [{
      severity: "error",
      type: dimension.key,
      dimensionKey: dimension.key,
      message: `${dimension.label}审查失败：${message}`,
      evidence: "",
      relatedMemory: "",
      suggestion: "请检查模型设置后重新审查此维度。",
      impact: "该维度暂时没有可用审查结果。",
      rewriteTarget: "",
    }],
  }
}

export function formatDimensionThinking(dimension: SixReviewDimensionDefinition, content: string): string {
  return `## ${dimension.label}\n${content.trim()}`
}

/**
 * ISS-20260806-001: unify dimension scores on 0-10 (one decimal).
 * Legacy models / short-circuit paths that still emit 0-100 are folded via /10
 * when raw > 10.5 (same rule as step0 A/B calibration arm).
 */
export function normalizeDimensionScore(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(raw)) return 0
  const score = raw > 10.5 ? raw / 10 : raw
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10))
}

function normalizeScore(value: unknown): number {
  return normalizeDimensionScore(value)
}

// ── §GAP-88-02 评分↔档位一致性机械校验 ────────────────────────────────
// 档位行为定义（buildDimensionReviewPrompt 校准锚点）的机械镜像：
//   0-4 → error（硬伤）；5-6 → medium（及格但平淡）；7-8 → low（良级）；
//   9-10 → pass（可发表）。high 保留作 LLM 过渡态，score 落 5-8 均接受。
// 模型只打分不判刑：门控裁定（collectBlockingIssues / collectRepairIssues /
// deriveSixDimVerdict）最终只读 score 派生的 verdict，status 仅作 floor。

export type ScoreDerivedVerdict = "error" | "warning" | "info"

/** score 派生 verdict（系统裁定唯一口径，模型 status 不直接决定门控）。 */
export function deriveScoreVerdict(score: number): ScoreDerivedVerdict {
  if (!Number.isFinite(score)) return "error"
  if (score <= 4) return "error"
  if (score <= 6) return "warning"
  if (score < 8.5) return "warning"
  return "info"
}

/**
 * 校验 status 与 score 是否落在同一档位。返回 null 表示一致，否则返回
 * 描述不一致的 warning 级 NovelReviewResult（供调用方并入 reviewResults）。
 * high 为过渡态：score ∈ [5,8] 视为一致。
 */
export function validateDimensionScoreBand(
  dimensionKey: SixReviewDimensionKey,
  score: number,
  status: DimensionReviewStatus,
): import("./review-adapter").NovelReviewResult | null {
  const inBand = (s: number, lo: number, hi: number): boolean => s >= lo && s <= hi
  const consistent =
    status === "error" ? score <= 4
    : status === "medium" ? inBand(score, 4, 7)
    : status === "high" ? inBand(score, 5, 8)
    : status === "low" ? inBand(score, 6.5, 8.5)
    : inBand(score, 8.5, 10)
  if (consistent) return null
  return {
    severity: "warning",
    type: DIM_TO_GATE_TYPE[dimensionKey],
    message: `评分与档位不一致：${dimensionKey} status=${status} 但 score=${score}（模型又当运动员又当裁判嫌疑，裁定以 score 为准）`,
    evidence: "",
    relatedMemory: "score-band",
    suggestion: "以 score 派生 verdict 为准重审该维度。",
  }
}

function validateStatus(value: unknown, issueCount: number): DimensionReviewStatus {
  if (value === "error" || value === "high" || value === "medium" || value === "low" || value === "pass") {
    return value
  }
  return issueCount === 0 ? "pass" : "medium"
}

// ── §GAP-90-08 授权边界最小返工集（ainovel AffectedChapters 派生模式）────────
// 分析范围 ≠ 修改范围：返工集合只含“需要改”的章节，去重排序。
// RequiresChange 等价口径（QMAI 侧已有字段复用，无新概念）：
//   requiresChange 显式 true，或 rewriteTarget 非空（“建议 AI 修改时定位的
//   原文片段”，DimensionReviewIssue 已有字段），或 error 级且带章号。
// verdict=accept 等价（零 error 且无显式 requiresChange/rewriteTarget）→ 空集
// （ainovel：accept review 不得含 requires_change issue 同款语义）。
// 章号来源：continuityMeta.chapter（稳定跨检测 key 持有者）或调用方显式传入。
// 纯函数零 LLM。

/** 最小返工集候选（NovelReviewResult 的章号承载子集）。 */
export interface MinimalReworkIssue {
  severity: NovelReviewResult["severity"]
  chapter?: number
  rewriteTarget?: string
  requiresChange?: boolean
}

/**
 * 最小返工章节集合（升序去重）。缺章号的 issue 跳过（不伪造范围）。
 */
export function minimalReworkSet(issues: readonly MinimalReworkIssue[]): number[] {
  const set = new Set<number>()
  for (const issue of issues) {
    if (issue.chapter === undefined || !Number.isFinite(issue.chapter)) continue
    const needsChange =
      issue.requiresChange === true ||
      (typeof issue.rewriteTarget === "string" && issue.rewriteTarget.trim().length > 0) ||
      issue.severity === "error"
    if (needsChange) set.add(issue.chapter)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * DimensionReviewIssue[] 便捷重载：rewriteTarget 非空 / error 级 +
 * continuityMeta.chapter 并入最小返工集。
 */
export function minimalReworkSetFromDimensionIssues(
  issues: readonly DimensionReviewIssue[],
): number[] {
  return minimalReworkSet(
    issues.map((i) => ({
      severity: i.severity,
      chapter: i.continuityMeta?.chapter,
      rewriteTarget: i.rewriteTarget,
    })),
  )
}
