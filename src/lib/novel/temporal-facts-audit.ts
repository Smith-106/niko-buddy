/**
 * Temporal facts non-empty audit (mid-loop).
 *
 * temporalFactsEnabled may be true while pack.temporalFacts is still empty
 * (no snapshots / mid-chapter soft path). That is a soft instrument gap, not
 * Track A FAIL.
 */
import type { TemporalFact } from "./temporal-memory"

export const TEMPORAL_FACTS_AUDIT_SCHEMA = "temporal-facts-audit/1.0" as const

export type TemporalFactsAuditLevel = "ok" | "disabled" | "empty_soft" | "skipped_ch1"

export interface TemporalFactsAuditStatus {
  schemaVersion: typeof TEMPORAL_FACTS_AUDIT_SCHEMA
  level: TemporalFactsAuditLevel
  enabled: boolean
  chapterNumber: number
  factCount: number
  /** Soft gap should surface in pack.gaps when true. */
  shouldRecordGap: boolean
  message: string
  productHardGate: false
}

export function auditTemporalFactsStatus(options: {
  enabled: boolean
  chapterNumber: number
  facts: TemporalFact[] | null | undefined
  /** Chapters below this skip empty audit (default 2 = mid-chapter). */
  minChapterForEmptyAudit?: number
}): TemporalFactsAuditStatus {
  const chapterNumber = Number.isFinite(options.chapterNumber) ? Math.trunc(options.chapterNumber) : 0
  const minCh = options.minChapterForEmptyAudit ?? 2
  const factCount = Array.isArray(options.facts) ? options.facts.length : 0
  const base = {
    schemaVersion: TEMPORAL_FACTS_AUDIT_SCHEMA,
    enabled: options.enabled === true,
    chapterNumber,
    factCount,
    productHardGate: false as const,
  }

  if (!options.enabled) {
    return {
      ...base,
      level: "disabled",
      shouldRecordGap: false,
      message: "temporalFactsEnabled=false — audit skipped",
    }
  }
  if (chapterNumber > 0 && chapterNumber < minCh) {
    return {
      ...base,
      level: "skipped_ch1",
      shouldRecordGap: false,
      message: `chapter ${chapterNumber} < ${minCh} — empty temporal audit not required`,
    }
  }
  if (factCount > 0) {
    return {
      ...base,
      level: "ok",
      shouldRecordGap: false,
      message: `temporal facts ok: ${factCount}`,
    }
  }
  return {
    ...base,
    level: "empty_soft",
    shouldRecordGap: chapterNumber >= minCh,
    message:
      `temporalFactsEnabled but zero facts for chapter ${chapterNumber} (soft) — ` +
      "mid-chapter continuity may lack episode edges; not Track A FAIL",
  }
}

/** One-line audit for logs / status (Wave A). */
export function formatTemporalAuditLine(status: TemporalFactsAuditStatus): string {
  return [
    `temporal-audit: level=${status.level}`,
    `facts=${status.factCount}`,
    `ch=${status.chapterNumber}`,
    status.message,
    "productHardGate=false",
  ].join(" | ")
}

/** Gap payload compatible with ContextGap shape (caller sets type/reason). */
export function temporalEmptySoftGapRef(chapterNumber: number): string {
  return `temporal-facts:empty-while-enabled:ch${chapterNumber}`
}

