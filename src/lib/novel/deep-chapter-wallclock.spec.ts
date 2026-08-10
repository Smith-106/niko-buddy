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
})
