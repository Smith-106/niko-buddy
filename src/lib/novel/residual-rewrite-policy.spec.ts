import { describe, expect, it } from "vitest"
import {
  RESIDUAL_OVERALL_MEDIAN_THRESHOLD,
  evaluateResidualRewritePolicy,
  isDensifyOrShortCompressBanned,
} from "./residual-rewrite-policy"

describe("residual-rewrite-policy", () => {
  it("uses 8.6 threshold constant", () => {
    expect(RESIDUAL_OVERALL_MEDIAN_THRESHOLD).toBe(8.6)
  })

  it("rejects densify_only when residual >= 8.6", () => {
    const d = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.8,
      mode: "densify_only",
    })
    expect(d.accept).toBe(false)
    expect(d.requiredMode).toBe("structure_thril_pacing")
    expect(d.productHardGate).toBe(false)
  })

  it("rejects short_compress when residual >= 8.6", () => {
    const d = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.75,
      mode: "short_compress",
    })
    expect(d.accept).toBe(false)
    expect(d.requiredMode).toBe("structure_thril_pacing")
  })

  it("accepts structure_thril_pacing length-preserving on residual", () => {
    const d = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.8,
      mode: "structure_thril_pacing",
      lengthPreserving: true,
    })
    expect(d.accept).toBe(true)
    expect(d.productHardGate).toBe(false)
  })

  it("rejects structure_thril_pacing when lengthPreserving false", () => {
    const d = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.8,
      mode: "structure_thril_pacing",
      lengthPreserving: false,
    })
    expect(d.accept).toBe(false)
  })

  it("allows densify_only below residual threshold", () => {
    const d = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.0,
      mode: "densify_only",
    })
    expect(d.accept).toBe(true)
    expect(d.residualBand).toBe("below_residual")
  })

  it("rejects micro_thril alone on residual high", () => {
    const d = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.8,
      mode: "micro_thril",
    })
    expect(d.accept).toBe(false)
  })

  it("isDensifyOrShortCompressBanned mirrors threshold", () => {
    expect(isDensifyOrShortCompressBanned(8.8)).toBe(true)
    expect(isDensifyOrShortCompressBanned(8.0)).toBe(false)
  })

  it("never sets productHardGate true", () => {
    for (const mode of [
      "densify_only",
      "short_compress",
      "structure_thril_pacing",
      "micro_thril",
      "other",
    ] as const) {
      const d = evaluateResidualRewritePolicy({
        residualOverallMedian: 8.9,
        mode,
        lengthPreserving: true,
      })
      expect(d.productHardGate).toBe(false)
    }
  })
})
