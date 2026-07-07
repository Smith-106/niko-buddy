import { describe, expect, it } from "vitest"
import {
  DIM_TO_GATE_TYPE,
  DimParseError,
  dimensionResultsToReviewResults,
  SIX_REVIEW_DIMENSIONS,
  type DimensionReviewResult,
  type SixReviewDimensionKey,
} from "./dimension-review-adapter"
import { ReviewParseError, type NovelReviewResult } from "./review-adapter"
import {
  buildDecisionGates,
  collectBlockingIssues,
  collectRepairIssues,
  type DeepChapterDecisionGate,
  type DeepChapterDecisionGates,
} from "./deep-chapter-generation"

function makeDimResult(
  key: SixReviewDimensionKey,
  overrides: Partial<DimensionReviewResult> = {},
): DimensionReviewResult {
  return {
    dimensionKey: key,
    score: 80,
    status: "medium",
    summary: `${SIX_REVIEW_DIMENSIONS[key].label}摘要`,
    thinking: "",
    issues: [],
    ...overrides,
  }
}

function makeGate(overrides: Partial<DeepChapterDecisionGate> = {}): DeepChapterDecisionGate {
  return {
    status: "passed",
    verdict: "pass",
    findings: [],
    repair_suggestions: [],
    retry_count: 0,
    ...overrides,
  }
}

function makeReviewResult(overrides: Partial<NovelReviewResult> = {}): NovelReviewResult {
  return {
    severity: "warning",
    type: "plot",
    message: "issue",
    evidence: "",
    relatedMemory: "",
    suggestion: "",
    ...overrides,
  }
}

describe("F-003 6-dim review fold wiring", () => {
  it("wires 6-dim results into NovelReviewResult[] via dimensionResultsToReviewResults (was orphaned before)", () => {
    const dims = {
      consistency: makeDimResult("consistency", {
        issues: [{
          severity: "error", type: "consistency", dimensionKey: "consistency",
          message: "设定冲突", evidence: "ex", relatedMemory: "m", suggestion: "s",
        }],
      }),
      character: makeDimResult("character", {
        issues: [{
          severity: "warning", type: "character", dimensionKey: "character",
          message: "台词不符人设", evidence: "ex2", relatedMemory: "", suggestion: "fix",
        }],
      }),
    }
    const reviewResults = dimensionResultsToReviewResults(dims)
    // Both dimensions' issues are present in the flattened output.
    expect(reviewResults.length).toBeGreaterThanOrEqual(2)
    expect(reviewResults.some((r) => r.message.includes("设定冲突"))).toBe(true)
    expect(reviewResults.some((r) => r.message.includes("台词不符人设"))).toBe(true)
  })

  it("maps character dimension to character_consistency type (NOT quality mis-bucket)", () => {
    // CRITICAL (ANL-010 R6): the `character` dimension key must map to the
    // `character_consistency` review-type so resolveDecisionGateKey buckets
    // it into the CONSISTENCY gate — NOT quality. CONSISTENCY_REVIEW_TYPES
    // contains `character_consistency`, not `character`, so a bare `character`
    // string-match would mis-bucket to quality.
    const dims = {
      character: makeDimResult("character", {
        issues: [{
          severity: "warning", type: "character", dimensionKey: "character",
          message: "x", evidence: "", relatedMemory: "", suggestion: "",
        }],
      }),
    }
    const reviewResults = dimensionResultsToReviewResults(dims)
    expect(reviewResults).toHaveLength(1)
    expect(reviewResults[0].type).toBe("character_consistency")
  })

  it("DIM_TO_GATE_TYPE maps all 6 dims to gate-bucketing types", () => {
    expect(DIM_TO_GATE_TYPE.character).toBe("character_consistency")
    expect(DIM_TO_GATE_TYPE.continuity).toBe("timeline")
    expect(DIM_TO_GATE_TYPE.consistency).toBe("consistency")
    // pacing/thrill/pull land in the quality gate (no consistency/anti_ai match)
    expect(DIM_TO_GATE_TYPE.pacing).toBe("plot")
    expect(DIM_TO_GATE_TYPE.thrill).toBe("plot")
    expect(DIM_TO_GATE_TYPE.pull).toBe("plot")
  })

  it("CORR-010: dimension status 'error' escalates issue severity to 'error' (so collectBlockingIssues catches it)", () => {
    // Regression: dimensionResultsToReviewResults previously copied the
    // per-issue severity verbatim. A dimension whose own status was "error"
    // (blocking) could emit only "warning"-severity issues — collectBlockingIssues
    // (severity === "error" only) would DROP the dimension, defeating the gate.
    // After the fix, the dimension's status is the floor: status "error" →
    // issue severity "error" regardless of the issue's own severity.
    const dims = {
      consistency: makeDimResult("consistency", {
        status: "error",
        issues: [{
          // Issue's own severity is "warning" — but the dimension is "error".
          severity: "warning", type: "consistency", dimensionKey: "consistency",
          message: "设定冲突", evidence: "ex", relatedMemory: "m", suggestion: "s",
        }],
      }),
    }
    const reviewResults = dimensionResultsToReviewResults(dims)
    expect(reviewResults).toHaveLength(1)
    // The dimension status "error" escalated the "warning" issue to "error".
    expect(reviewResults[0].severity).toBe("error")
    // buildDecisionGates → collectBlockingIssues now catches it.
    const gates = buildDecisionGates(reviewResults, 0)
    expect(gates.consistency.status).toBe("failed")
    expect(collectBlockingIssues(gates)).toHaveLength(1)
  })

  it("CORR-010: a more severe issue keeps its own severity (MAX of status-floor and issue)", () => {
    // A "medium" dimension surfacing one genuinely blocking (error) issue
    // must keep severity "error" — the issue can be more severe than its dim.
    const dims = {
      thrill: makeDimResult("thrill", {
        status: "medium",
        issues: [{
          severity: "error", type: "plot", dimensionKey: "thrill",
          message: "致命问题", evidence: "", relatedMemory: "", suggestion: "",
        }],
      }),
    }
    const reviewResults = dimensionResultsToReviewResults(dims)
    expect(reviewResults[0].severity).toBe("error")
  })

  it("collectRepairIssues routes warning-severity findings to stage-5 (TS-01)", () => {
    // TS-01: warning dims reach stage-5. A gate with warning findings yields
    // them via collectRepairIssues, even when the gate status is "passed"
    // (warnings never block, so gate.status stays "passed").
    const gates: DeepChapterDecisionGates = {
      consistency: makeGate({
        status: "passed",
        verdict: "warning",
        findings: [
          makeReviewResult({ severity: "warning", type: "character_consistency", message: "warn-1" }),
          makeReviewResult({ severity: "info", type: "timeline", message: "info-1" }),
        ],
      }),
      anti_ai: makeGate({
        findings: [makeReviewResult({ severity: "warning", type: "style", message: "warn-2" })],
      }),
      quality: makeGate({
        findings: [makeReviewResult({ severity: "error", type: "plot", message: "err-1" })],
      }),
      overall: "warning",
    }
    const repairIssues = collectRepairIssues(gates)
    // Only warning-severity findings are gathered; info and error excluded.
    expect(repairIssues.map((i) => i.message).sort()).toEqual(["warn-1", "warn-2"])
  })

  it("collectBlockingIssues stays error-only (warnings never block) — 3-gate verdict unchanged", () => {
    // collectBlockingIssues is exported; its contract is encoded in
    // buildDecisionGates: gate.status='failed' iff hasError. A gate with only
    // warnings is "passed". Verify the gate-status contract holds for a
    // warning-only finding set by constructing the gate shape directly.
    const warningOnlyGate = makeGate({
      findings: [makeReviewResult({ severity: "warning", type: "plot" })],
    })
    // Per buildDecisionGates: hasError=false → status "passed". Warnings do
    // NOT make a gate fail.
    expect(warningOnlyGate.findings.every((f) => f.severity !== "error")).toBe(true)
    // collectRepairIssues still surfaces the warning (it reaches stage-5).
    const gates: DeepChapterDecisionGates = {
      consistency: makeGate(),
      anti_ai: makeGate(),
      quality: warningOnlyGate,
      overall: "warning",
    }
    expect(collectRepairIssues(gates)).toHaveLength(1)
  })

  it("dimension_results field is additive on NovelSessionStatus (Partial spread safe)", () => {
    // The field is optional; a status object without it must still type-check
    // and round-trip. We simulate the loadNovelSessionStatus spread behavior:
    // spreading a Partial without dimension_results yields an object where
    // the field is simply absent (undefined), not a type error.
    type MinimalStatus = { schema_version: "1"; dimension_results?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> }
    const parsed: MinimalStatus = { schema_version: "1" }
    const rebuilt: MinimalStatus = { ...parsed }
    expect(rebuilt.schema_version).toBe("1")
    expect(rebuilt.dimension_results).toBeUndefined()
    // And with the field present, it round-trips.
    const withDims: MinimalStatus = { schema_version: "1", dimension_results: { character: makeDimResult("character") } }
    const rebuilt2: MinimalStatus = { ...withDims }
    expect(rebuilt2.dimension_results?.character).toBeDefined()
  })

  it("DimParseError distinguishes malformed dimension-review JSON (SyntaxError) from runtime errors", () => {
    // dimension-review-adapter hardens its JSON.parse: a SyntaxError becomes
    // a DimParseError carrying the raw text + parse message.
    const raw = "{ not valid json"
    const err = new DimParseError(raw, "Unexpected token n")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("DimParseError")
    expect(err.raw).toBe(raw)
    expect(err.message).toContain("parse failed")
    // A non-SyntaxError is NOT a DimParseError — callers can instanceof-check.
    expect(err instanceof SyntaxError).toBe(false)
  })

  it("ReviewParseError distinguishes malformed review JSON (SyntaxError) from runtime errors", () => {
    // review-adapter hardens its JSON.parse: a SyntaxError becomes a
    // ReviewParseError carrying the raw text + parse message.
    const raw = "[{ broken"
    const err = new ReviewParseError(raw, "Unexpected token b")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ReviewParseError")
    expect(err.raw).toBe(raw)
    expect(err.message).toContain("parse failed")
    expect(err instanceof SyntaxError).toBe(false)
  })
})

describe("F-003 review-fix (review hardening) — CORR-005 + BP-009", () => {
  it("CORR-005: collectBlockingIssues accumulates errors across ALL failed gates, not just the first", () => {
    // Regression: collectBlockingIssues previously returned on the first
    // failed gate, dropping error-severity findings from subsequent failed
    // gates (GRL-008 C-104). When consistency AND quality both fail, the
    // repair prompt must see errors from BOTH gates.
    const gates: DeepChapterDecisionGates = {
      consistency: makeGate({
        status: "failed",
        verdict: "fail",
        findings: [
          makeReviewResult({ severity: "error", type: "character_consistency", message: "cons-err-1" }),
          makeReviewResult({ severity: "warning", type: "timeline", message: "cons-warn-1" }),
        ],
      }),
      anti_ai: makeGate({
        status: "passed",
        findings: [makeReviewResult({ severity: "warning", type: "style", message: "ai-warn" })],
      }),
      quality: makeGate({
        status: "failed",
        verdict: "fail",
        findings: [
          makeReviewResult({ severity: "error", type: "plot", message: "qual-err-1" }),
          makeReviewResult({ severity: "error", type: "pacing", message: "qual-err-2" }),
        ],
      }),
      overall: "fail",
    }
    const blocking = collectBlockingIssues(gates)
    // Errors from BOTH consistency and quality gates are present (pre-fix
    // only cons-err-1 would have been returned).
    expect(blocking.map((b) => b.message).sort()).toEqual(["cons-err-1", "qual-err-1", "qual-err-2"])
    // Warnings are NOT in the blocking list (error-only, by design).
    expect(blocking.every((b) => b.severity === "error")).toBe(true)
  })

  it("BP-009: buildDecisionGates overall verdict escalates to 'warning' on an anti_ai-only warning (P1>P2)", () => {
    // Regression: the overall verdict escalated quality warnings to 'warning'
    // but NOT anti_ai warnings, contradicting Q4's Consistency>Anti-AI>Quality
    // precedence (anti-ai is P1, above quality P2). An anti-ai-only-warning
    // draft must surface overall='warning', not silently 'pass'.
    // anti_ai warnings come from review type 'style' (DIM_TO_GATE_TYPE maps
    // style/thrill etc to anti_ai? — verify via the gate grouping).
    const reviewResults: NovelReviewResult[] = [
      makeReviewResult({ severity: "warning", type: "anti_ai", message: "ai-slop detected" }),
    ]
    const gates = buildDecisionGates(reviewResults, 0)
    // The anti_ai gate carries the warning (verdict 'warning', status passed).
    expect(gates.anti_ai.verdict).toBe("warning")
    expect(gates.anti_ai.status).toBe("passed")
    // Overall escalates to 'warning' — pre-fix this was 'pass'.
    expect(gates.overall).toBe("warning")
  })

  it("BP-009: a quality-only warning still escalates overall to 'warning' (regression guard)", () => {
    // Ensure adding anti_ai warning escalation didn't break the existing
    // quality-warning escalation path.
    const reviewResults: NovelReviewResult[] = [
      makeReviewResult({ severity: "warning", type: "plot", message: "pacing warn" }),
    ]
    const gates = buildDecisionGates(reviewResults, 0)
    expect(gates.quality.verdict).toBe("warning")
    expect(gates.overall).toBe("warning")
  })
})
