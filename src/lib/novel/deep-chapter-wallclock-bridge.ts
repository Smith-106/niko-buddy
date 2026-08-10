/**
 * P1 — bridge status.json stage_metrics → DeepChapterWallclockReport (soft).
 */
import {
  measureDeepChapterWallclock,
  type DeepChapterStageTiming,
  type DeepChapterWallclockReport,
} from "./deep-chapter-wallclock"
import type { StageMetricEntry } from "./novel-session-status"

export function recordDeepChapterWallclockFromStageMetrics(
  metrics: readonly StageMetricEntry[] | null | undefined,
): DeepChapterWallclockReport {
  const stages: DeepChapterStageTiming[] = (metrics ?? []).map((m) => ({
    stage: m.stage,
    durationMs: typeof m.latencyMs === "number" && Number.isFinite(m.latencyMs) ? m.latencyMs : 0,
    ok: m.partial === true ? false : true,
    note: m.partial ? "partial" : undefined,
  }))
  return measureDeepChapterWallclock(stages)
}
