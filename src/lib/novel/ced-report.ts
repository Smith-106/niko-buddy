/**
 * CED soft report (Wave A KPI) — Consistency Error Density style diagnostics.
 *
 * Inspired by ConStory-Bench dimensional consistency (industry reference).
 * Maps existing zero-LLM ContinuityFinding[] into coarse dimensions + density.
 *
 * Track A/B: productHardGate is always false. This never overrides Consistency
 * hard gates; use for notes / soft prompts / measurement only.
 */
import type { ContinuityFinding } from "./deterministic-continuity-engine"

export const CED_REPORT_SCHEMA = "ced-report/1.0" as const

/** Coarse dimensions aligned to industry Timeline / Character / World / Factual / Style. */
export type CedDimension =
  | "timeline"
  | "characterization"
  | "world"
  | "factual"
  | "style"

export interface CedDimBucket {
  dimension: CedDimension
  count: number
  /** Severity-weighted count: critical=1, warning=0.5, info=0.25 */
  weighted: number
  findingTypes: string[]
}

export interface CedEvidenceItem {
  dimension: CedDimension
  type: string
  severity: string
  ref: string
  message: string
  chapter: number
}

export interface CedReport {
  schemaVersion: typeof CED_REPORT_SCHEMA
  /** Approximate word count used for density (CJK-friendly: chars/2 floor). */
  wordCountEstimate: number
  /** Errors per 10k words (weighted). */
  densityPer10k: number
  /** Raw finding count after mapping. */
  totalFindings: number
  dimensions: Record<CedDimension, CedDimBucket>
  evidence: CedEvidenceItem[]
  productHardGate: false
  /** One-line soft summary for logs / skill notes. */
  summaryLine: string
}

const EMPTY_DIM = (d: CedDimension): CedDimBucket => ({
  dimension: d,
  count: 0,
  weighted: 0,
  findingTypes: [],
})

function severityWeight(severity: string): number {
  if (severity === "critical") return 1
  if (severity === "warning") return 0.5
  return 0.25
}

/**
 * Map continuity finding types → CED dimensions.
 * data_gap → factual (instrument gap, not world-rule).
 * style is reserved for optional external slop counts (not continuity).
 */
export function mapFindingTypeToCedDimension(type: string): CedDimension {
  switch (type) {
    case "overdue_thread":
    case "unresolved_foreshadowing":
    case "dormant_thread":
      return "timeline"
    case "absent_character":
    case "dead_character_state":
      return "characterization"
    case "data_gap":
      return "factual"
    default:
      return "world"
  }
}

/** CJK-aware rough word estimate: Latin words + CJK chars/2. */
export function estimateWordCount(text: string): number {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  if (!t) return 0
  const cjk = (t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  const latin = t
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length
  return Math.max(1, latin + Math.floor(cjk / 2))
}

export interface ComputeCedReportInput {
  findings: readonly ContinuityFinding[]
  /** Chapter or pack text for density denominator. */
  textForWordCount?: string
  /** Override word count if text unavailable. */
  wordCountEstimate?: number
  /** Extra style-dimension pseudo counts (e.g. mechanical slop hits). */
  styleIssueCount?: number
  maxEvidence?: number
}

/**
 * Build CED soft report from continuity findings (+ optional style counts).
 */
export function computeCedReport(input: ComputeCedReportInput): CedReport {
  const maxEvidence = input.maxEvidence ?? 24
  const dimensions: Record<CedDimension, CedDimBucket> = {
    timeline: EMPTY_DIM("timeline"),
    characterization: EMPTY_DIM("characterization"),
    world: EMPTY_DIM("world"),
    factual: EMPTY_DIM("factual"),
    style: EMPTY_DIM("style"),
  }

  const evidence: CedEvidenceItem[] = []
  let weightedTotal = 0

  for (const f of input.findings ?? []) {
    const dimension = mapFindingTypeToCedDimension(f.type)
    const bucket = dimensions[dimension]
    bucket.count += 1
    const w = severityWeight(f.severity)
    bucket.weighted += w
    weightedTotal += w
    if (!bucket.findingTypes.includes(f.type)) bucket.findingTypes.push(f.type)
    if (evidence.length < maxEvidence) {
      evidence.push({
        dimension,
        type: f.type,
        severity: f.severity,
        ref: f.ref,
        message: f.message,
        chapter: f.chapter,
      })
    }
  }

  const styleN = Math.max(0, Math.floor(input.styleIssueCount ?? 0))
  if (styleN > 0) {
    dimensions.style.count += styleN
    dimensions.style.weighted += styleN * 0.25
    weightedTotal += styleN * 0.25
    if (!dimensions.style.findingTypes.includes("style_soft_count")) {
      dimensions.style.findingTypes.push("style_soft_count")
    }
  }

  const wordCountEstimate =
    typeof input.wordCountEstimate === "number" && input.wordCountEstimate > 0
      ? Math.floor(input.wordCountEstimate)
      : estimateWordCount(input.textForWordCount ?? "")

  const denom = Math.max(wordCountEstimate, 50)
  const densityPer10k = (weightedTotal / denom) * 10_000

  const totalFindings = (input.findings?.length ?? 0) + styleN
  const dimParts = (Object.keys(dimensions) as CedDimension[])
    .filter((d) => dimensions[d].count > 0)
    .map((d) => `${d}=${dimensions[d].count}`)
    .join(" ")

  const summaryLine = [
    `CED soft: densityPer10k=${densityPer10k.toFixed(2)}`,
    `findings=${totalFindings}`,
    `words~${wordCountEstimate}`,
    dimParts || "clean",
    "not product hard gate",
  ].join(" ")

  return {
    schemaVersion: CED_REPORT_SCHEMA,
    wordCountEstimate,
    densityPer10k,
    totalFindings,
    dimensions,
    evidence,
    productHardGate: false,
    summaryLine,
  }
}

/** Prompt fragment for Track B soft inject; empty when clean. */
export function formatCedReportPromptFragment(report: CedReport, maxLines = 8): string {
  if (report.totalFindings === 0) return ""
  const lines = report.evidence.slice(0, maxLines).map(
    (e) => `- [${e.dimension}/${e.severity}] ${e.type} ${e.ref}: ${e.message}`,
  )
  return [
    "【Track A/B 旁路 · CED 一致性密度软报告（非 thril 硬门；不覆盖 Consistency 裁决）】",
    report.summaryLine,
    ...lines,
    "优先修复时间线/人设缺席/逾期伏笔；勿为抬 thril 牺牲 Consistency。",
  ].join("\n")
}
