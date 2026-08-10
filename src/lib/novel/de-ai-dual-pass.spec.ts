import { describe, expect, it } from "vitest"
import { formatDualPassSummary, runDeAiDualPass } from "./de-ai-dual-pass"

describe("de-ai-dual-pass", () => {
  it("scores clean-ish text without hard gate", () => {
    const r = runDeAiDualPass("白昼。他推开门，看见旧钥匙。")
    expect(r.productHardGate).toBe(false)
    expect(r.track).toBe("B")
    expect(r.pass1.combinedScore).toBeGreaterThanOrEqual(0)
    expect(r.pass2.remediationNotes.length).toBeGreaterThan(0)
    expect(formatDualPassSummary(r)).toContain("Track B")
  })

  it("attaches percentile when baseline provided", () => {
    const r = runDeAiDualPass("总之，值得注意的是，在这个意义上，我们需要进一步探讨。", {
      baselineScores: [5, 10, 15, 20, 25, 30, 40, 50, 60, 70],
    })
    expect(r.pass1.percentileInBaseline).toBeTypeOf("number")
    expect(r.productHardGate).toBe(false)
  })
})
