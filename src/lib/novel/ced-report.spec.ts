import { describe, expect, it } from "vitest"
import {
  computeCedReport,
  estimateWordCount,
  formatCedReportPromptFragment,
  mapFindingTypeToCedDimension,
} from "./ced-report"
import type { ContinuityFinding } from "./deterministic-continuity-engine"

function finding(
  partial: Partial<ContinuityFinding> & { type: ContinuityFinding["type"] },
): ContinuityFinding {
  if (partial.type === "data_gap") {
    return {
      type: "data_gap",
      subtype: "data_gap",
      severity: partial.severity ?? "info",
      ref: partial.ref ?? "gap:x",
      message: partial.message ?? "missing",
      chapter: partial.chapter ?? 4,
      missingField: "lastSeenChapter",
    }
  }
  return {
    type: partial.type,
    subtype: "consistency_mechanical",
    severity: partial.severity ?? "warning",
    ref: partial.ref ?? "ref:x",
    message: partial.message ?? "msg",
    chapter: partial.chapter ?? 4,
  }
}

describe("ced-report", () => {
  it("maps finding types to dimensions", () => {
    expect(mapFindingTypeToCedDimension("absent_character")).toBe("characterization")
    expect(mapFindingTypeToCedDimension("overdue_thread")).toBe("timeline")
    expect(mapFindingTypeToCedDimension("data_gap")).toBe("factual")
  })

  it("estimates CJK-heavy text without zero", () => {
    expect(estimateWordCount("她打开了门。雨打在台阶上。")).toBeGreaterThan(0)
  })

  it("computes density and never sets product hard gate", () => {
    const findings: ContinuityFinding[] = [
      finding({ type: "absent_character", severity: "critical" }),
      finding({ type: "overdue_thread", severity: "warning" }),
      finding({ type: "data_gap", severity: "info" }),
    ]
    const report = computeCedReport({
      findings,
      wordCountEstimate: 1000,
      styleIssueCount: 2,
    })
    expect(report.productHardGate).toBe(false)
    expect(report.dimensions.characterization.count).toBe(1)
    expect(report.dimensions.timeline.count).toBe(1)
    expect(report.dimensions.factual.count).toBe(1)
    expect(report.dimensions.style.count).toBe(2)
    expect(report.densityPer10k).toBeGreaterThan(0)
    expect(report.summaryLine).toContain("not product hard gate")
    expect(formatCedReportPromptFragment(report)).toContain("CED")
  })

  it("returns clean summary when no findings", () => {
    const report = computeCedReport({ findings: [], wordCountEstimate: 500 })
    expect(report.totalFindings).toBe(0)
    expect(formatCedReportPromptFragment(report)).toBe("")
  })
})
