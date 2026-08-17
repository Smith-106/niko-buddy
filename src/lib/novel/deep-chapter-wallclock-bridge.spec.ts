import { describe, expect, it } from "vitest"
import { recordDeepChapterWallclockFromStageMetrics } from "./deep-chapter-wallclock-bridge"
import type { StageMetricEntry } from "./novel-session-status"

describe("deep-chapter-wallclock-bridge (P1)", () => {
  it("maps stage_metrics latencyMs into wallclock report", () => {
    const metrics: StageMetricEntry[] = [
      { stage: "scene_breakdown", latencyMs: 120, timestamp: "t" },
      { stage: "write_llm", latencyMs: 5000, timestamp: "t2" },
    ]
    const r = recordDeepChapterWallclockFromStageMetrics(metrics)
    expect(r.totalMs).toBe(5120)
    expect(r.dominantStage).toBe("write_llm")
    expect(r.productHardGate).toBe(false)
  })

  it("handles null/undefined metrics and non-finite latencyMs", () => {
    const rNull = recordDeepChapterWallclockFromStageMetrics(null)
    expect(rNull.totalMs).toBe(0)
    expect(rNull.dominantStage).toBeUndefined()
    expect(rNull.stages).toEqual([])

    const rUndef = recordDeepChapterWallclockFromStageMetrics(undefined)
    expect(rUndef.totalMs).toBe(0)

    const rBad = recordDeepChapterWallclockFromStageMetrics([
      { stage: "pack", latencyMs: Number.NaN, timestamp: "t" },
      { stage: "ingest", latencyMs: undefined as unknown as number, timestamp: "t2" },
    ])
    // NaN 与 undefined latency → durationMs 0
    expect(rBad.stages).toEqual([
      { stage: "pack", durationMs: 0, ok: true, note: undefined },
      { stage: "ingest", durationMs: 0, ok: true, note: undefined },
    ])
  })

  it("flags partial metrics with ok=false and a partial note", () => {
    const r = recordDeepChapterWallclockFromStageMetrics([
      { stage: "six_dim", latencyMs: 300, timestamp: "t", partial: true },
    ])
    expect(r.stages[0].ok).toBe(false)
    expect(r.stages[0].note).toBe("partial")
  })
})
