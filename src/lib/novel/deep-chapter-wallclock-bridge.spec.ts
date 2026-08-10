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
})
