import { describe, expect, it } from "vitest"
import { measureDeepChapterWallclock } from "./deep-chapter-wallclock"

describe("deep-chapter-wallclock (S6)", () => {
  it("sums stages and flags llm-dominant write stage", () => {
    const r = measureDeepChapterWallclock([
      { stage: "pack", durationMs: 12 },
      { stage: "write_llm", durationMs: 8200 },
      { stage: "six_dim", durationMs: 900 },
      { stage: "ingest", durationMs: 40 },
    ])
    expect(r.totalMs).toBe(12 + 8200 + 900 + 40)
    expect(r.dominantStage).toBe("write_llm")
    expect(r.llmLikelyDominant).toBe(true)
    expect(r.productHardGate).toBe(false)
    expect(r.summaryLine).toContain("wallclock")
  })

  it("reports no dominant stage when every stage is invalid", () => {
    const r = measureDeepChapterWallclock([
      { stage: "pack", durationMs: Number.NaN },
      { stage: "write", durationMs: -5 },
    ])
    expect(r.totalMs).toBe(0)
    expect(r.stages).toEqual([])
    expect(r.dominantStage).toBeUndefined()
    expect(r.llmLikelyDominant).toBe(false)
    expect(r.summaryLine).toContain("llmLikelyDominant=false")
    expect(r.summaryLine).not.toContain("dominant=")
  })

  it("marks llmLikelyDominant=false when a non-llm stage dominates", () => {
    const r = measureDeepChapterWallclock([
      { stage: "ingest", durationMs: 7000 },
      { stage: "write_llm", durationMs: 100 },
    ])
    expect(r.dominantStage).toBe("ingest")
    expect(r.llmLikelyDominant).toBe(false)
    expect(r.summaryLine).toContain("dominant=ingest(7000ms)")
    expect(r.summaryLine).toContain("llmLikelyDominant=false")
  })
})
