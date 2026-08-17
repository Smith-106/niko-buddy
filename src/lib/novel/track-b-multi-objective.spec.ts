import { describe, expect, it } from "vitest"
import {
  TRACK_B_DEFAULT_PROTECT,
  buildTrackBMultiObjectiveConstraint,
  createDefaultTrackBMultiObjectivePolicy,
  detectFix1Violation,
  evaluateTrackBCandidate,
  shouldAcceptTrackBPolishText,
} from "./track-b-multi-objective"

describe("buildTrackBMultiObjectiveConstraint", () => {
  it("mentions protect dims and FIX-1", () => {
    const s = buildTrackBMultiObjectiveConstraint()
    expect(s).toContain("多目标护栏")
    expect(s).toContain("character")
    expect(s).toContain("FIX-1")
    expect(s).toContain("overall≥9 不是交付标准")
  })
})

describe("detectFix1Violation", () => {
  it("flags Offer / 最终存活者", () => {
    expect(detectFix1Violation("无问题正文")).toBe(false)
    expect(detectFix1Violation("最终存活者是他")).toBe(true)
    expect(detectFix1Violation("the Offer is ready")).toBe(true)
  })

  it("tolerates nullish text via ?? ''", () => {
    expect(detectFix1Violation(undefined as unknown as string)).toBe(false)
    expect(detectFix1Violation(null as unknown as string)).toBe(false)
  })
})

describe("evaluateTrackBCandidate", () => {
  const policy = createDefaultTrackBMultiObjectivePolicy()

  it("rejects FIX-1 in after text", () => {
    const d = evaluateTrackBCandidate(
      { scores: { thrill: 5.8 } },
      { scores: { thrill: 7.0 } },
      "最终存活者揭晓",
      policy,
    )
    expect(d.accept).toBe(false)
    expect(d.fix1Violation).toBe(true)
  })

  it("rejects protect regression when thril lifts (wave3 pattern)", () => {
    const d = evaluateTrackBCandidate(
      { scores: { thrill: 5.8, pull: 7.6, character: 6.8 } },
      { scores: { thrill: 6.4, pull: 5.9, character: 4.8 } },
      "安全正文",
      policy,
    )
    expect(d.accept).toBe(false)
    expect(d.protectRegressions).toEqual(expect.arrayContaining(["pull", "character"]))
  })

  it("accepts thril lift without protect regression", () => {
    const d = evaluateTrackBCandidate(
      { scores: { thrill: 5.8, pull: 6.8, character: 5.0 } },
      { scores: { thrill: 6.4, pull: 6.9, character: 5.2 } },
      "安全正文",
      policy,
    )
    expect(d.accept).toBe(true)
  })

  it("rejects slop increase", () => {
    const d = evaluateTrackBCandidate(
      { scores: {}, slopPenalty: 0.1 },
      { scores: {}, slopPenalty: 0.3 },
      "安全",
      policy,
    )
    expect(d.accept).toBe(false)
    expect(d.reason).toMatch(/slop/)
  })

  it("ignores non-finite score deltas", () => {
    const d = evaluateTrackBCandidate(
      { scores: { thrill: NaN, pull: Infinity } },
      { scores: { thrill: 7.0, pull: 6.0 } },
      "安全正文",
      policy,
    )
    expect(d.accept).toBe(true)
    expect(d.liftDeltas).toEqual({})
    expect(d.protectRegressions).toEqual([])
  })

  it("does not flag regression when delta is below threshold", () => {
    const d = evaluateTrackBCandidate(
      { scores: { pull: 7.6 } },
      { scores: { pull: 7.55 } },
      "安全",
      policy,
    )
    expect(d.accept).toBe(true)
    expect(d.protectRegressions).toEqual([])
  })

  it("rejects protect regression even without lift evidence (anyLift false path)", () => {
    const d = evaluateTrackBCandidate(
      { scores: { thrill: 5.8, pull: 7.6, character: 6.8 } },
      { scores: { thrill: 5.2, pull: 5.9, character: 4.8 } },
      "安全正文",
      policy,
    )
    expect(d.accept).toBe(false)
    expect(d.protectRegressions).toEqual(expect.arrayContaining(["pull", "character"]))
    expect(d.reason).toMatch(/protected dimension regression/)
  })
})

describe("shouldAcceptTrackBPolishText", () => {
  it("accepts when slop flat and no FIX-1", () => {
    const d = shouldAcceptTrackBPolishText({
      beforeText: "a",
      afterText: "b",
      beforeSlop: 0.2,
      afterSlop: 0.2,
    })
    expect(d.accept).toBe(true)
  })
})

describe("defaults", () => {
  it("protect list includes character and pull", () => {
    expect(TRACK_B_DEFAULT_PROTECT).toContain("character")
    expect(TRACK_B_DEFAULT_PROTECT).toContain("pull")
  })
})

