/**
 * S6 — deep-chapter stage wall-clock aggregation (soft diagnostics).
 * Not a product hard gate; thril irrelevant.
 */

export interface DeepChapterStageTiming {
  stage: string
  durationMs: number
  ok?: boolean
  note?: string
}

export interface DeepChapterWallclockReport {
  schemaVersion: "deep-chapter-wallclock/1.0"
  totalMs: number
  stages: DeepChapterStageTiming[]
  /** Dominant stage name when known. */
  dominantStage?: string
  llmLikelyDominant: boolean
  productHardGate: false
  summaryLine: string
}

/**
 * Aggregate stage timings (e.g. pack / write / six-dim / ingest) into a report.
 * Pure: callers supply measured durations.
 */
export function measureDeepChapterWallclock(
  stages: readonly DeepChapterStageTiming[],
): DeepChapterWallclockReport {
  const cleaned = stages.filter((s) => Number.isFinite(s.durationMs) && s.durationMs >= 0)
  const totalMs = cleaned.reduce((a, s) => a + s.durationMs, 0)
  let dominant: DeepChapterStageTiming | undefined
  for (const s of cleaned) {
    if (!dominant || s.durationMs > dominant.durationMs) dominant = s
  }
  const llmHints = /llm|write|stream|six.?dim|review|generate/i
  const llmLikelyDominant = dominant ? llmHints.test(dominant.stage) : false
  return {
    schemaVersion: "deep-chapter-wallclock/1.0",
    totalMs,
    stages: cleaned.map((s) => ({ ...s })),
    dominantStage: dominant?.stage,
    llmLikelyDominant,
    productHardGate: false,
    summaryLine: [
      `wallclock totalMs=${totalMs}`,
      dominant ? `dominant=${dominant.stage}(${dominant.durationMs}ms)` : "",
      llmLikelyDominant ? "llmLikelyDominant=true" : "llmLikelyDominant=false",
      "not product hard gate",
    ]
      .filter(Boolean)
      .join(" | "),
  }
}
