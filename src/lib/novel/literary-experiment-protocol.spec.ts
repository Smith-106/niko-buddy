import { describe, expect, it } from "vitest"
import type { ContextPack } from "./context-engine"
import {
  L9_OVERALL_STRETCH_MEDIAN,
  L9_OVERALL_TEST_CONTROL_MEDIAN,
  L9_ROLE,
  L9_TEST_CONTROL_ROLE,
  LITERARY_EXPERIMENT_DEFAULT_MODEL,
  LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL,
  bandForMedian,
  buildProductionStep0Fixture,
  classifyL9OverallMedian,
  compareLiteraryExperimentSnapshots,
  createLiteraryExperimentProtocol,
  meetsL9OverallGate,
  snapshotFromStep0Results,
  validateLiteraryExperimentComparability,
} from "./literary-experiment-protocol"

const thinPack = {
  task: "六维审查第4章",
  chapterGoal: "g",
  outline: "o",
  recentSummaries: [],
  previousChapterEnding: "",
  characterStates: "",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "",
  foreshadowingStates: "",
  timeline: "",
  relatedSettings: "",
  canonRules: "",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "",
  mustAvoid: "",
  nextChapterAdvice: "",
  revisionDirectives: "",
} satisfies ContextPack

describe("createLiteraryExperimentProtocol", () => {
  it("locks default model, N=5, full window, no product hard gate", () => {
    const p = createLiteraryExperimentProtocol({ label: "ch4-wave3" })
    expect(p.model).toBe(LITERARY_EXPERIMENT_DEFAULT_MODEL)
    expect(p.samples).toBe(LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL)
    expect(p.window).toBe("full_chapter")
    expect(p.productHardGate).toBe(false)
    expect(p.overallGe9IsShipCriterion).toBe(false)
    expect(p.mode).toBe("NEW_only")
    expect(p.label).toBe("ch4-wave3")
  })

  it("notes smoke when samples < seal minimum", () => {
    const p = createLiteraryExperimentProtocol({ samples: 3 })
    expect(p.samples).toBe(3)
    expect(p.notes?.some((n) => n.includes("smoke"))).toBe(true)
  })

  it("locks L9 overall>=9 as manuscript stretch not Track A hard gate", () => {
    expect(L9_OVERALL_STRETCH_MEDIAN).toBe(9)
    expect(L9_ROLE).toBe("manuscript_milestone_stretch")
    const p = createLiteraryExperimentProtocol()
    expect(p.overallGe9IsShipCriterion).toBe(false)
    expect(p.productHardGate).toBe(false)
    expect(p.notes?.some((n) => n.includes(L9_ROLE))).toBe(true)
  })

  it("locks dual threshold: test control 9.5 above seal stretch 9.0", () => {
    expect(L9_OVERALL_TEST_CONTROL_MEDIAN).toBe(9.5)
    expect(L9_OVERALL_TEST_CONTROL_MEDIAN).toBeGreaterThan(L9_OVERALL_STRETCH_MEDIAN)
    expect(L9_TEST_CONTROL_ROLE).toBe("campaign_test_control")
    const p = createLiteraryExperimentProtocol()
    expect(p.notes?.some((n) => n.includes(String(L9_OVERALL_TEST_CONTROL_MEDIAN)))).toBe(true)
    expect(p.notes?.some((n) => n.includes(L9_TEST_CONTROL_ROLE))).toBe(true)
    expect(p.productHardGate).toBe(false)
    expect(p.overallGe9IsShipCriterion).toBe(false)
  })

  it("clamps samples to [1,10], truncates fractional input", () => {
    expect(createLiteraryExperimentProtocol({ samples: 25 }).samples).toBe(10)
    expect(createLiteraryExperimentProtocol({ samples: 0 }).samples).toBe(1)
    expect(createLiteraryExperimentProtocol({ samples: 3.7 }).samples).toBe(3)
    expect(createLiteraryExperimentProtocol({ samples: Number.NaN }).samples).toBe(
      LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL,
    )
  })

  it("falls back to default model when trimmed model is blank", () => {
    const p = createLiteraryExperimentProtocol({ model: "   " })
    expect(p.model).toBe(LITERARY_EXPERIMENT_DEFAULT_MODEL)
  })

  it("preserves caller notes alongside frozen protocol notes", () => {
    const p = createLiteraryExperimentProtocol({ notes: ["my-note"] })
    expect(p.notes?.includes("my-note")).toBe(true)
    expect(p.notes?.some((n) => n.includes("Do not compare medians across different models"))).toBe(true)
  })
})

describe("classifyL9OverallMedian / meetsL9OverallGate", () => {
  it("classifies below seal, seal-only, and test-control bands", () => {
    expect(classifyL9OverallMedian(8.8, 5)).toBe("below_seal")
    expect(classifyL9OverallMedian(9.0, 5)).toBe("seal_pass_below_test_control")
    expect(classifyL9OverallMedian(9.2, 5)).toBe("seal_pass_below_test_control")
    expect(classifyL9OverallMedian(9.5, 5)).toBe("test_control_pass")
    expect(classifyL9OverallMedian(9.7, 5)).toBe("test_control_pass")
    expect(classifyL9OverallMedian(9.5, 3)).toBe("insufficient_samples")
  })

  it("meets seal stretch at 9.0 but test control only at 9.5", () => {
    expect(meetsL9OverallGate(9.0, "seal_stretch", 5)).toBe(true)
    expect(meetsL9OverallGate(9.0, "test_control", 5)).toBe(false)
    expect(meetsL9OverallGate(9.5, "test_control", 5)).toBe(true)
    expect(meetsL9OverallGate(9.5, "seal_stretch", 5)).toBe(true)
    expect(meetsL9OverallGate(8.8, "seal_stretch", 5)).toBe(false)
    expect(meetsL9OverallGate(9.5, "test_control", 3)).toBe(false)
  })

  it("treats null / NaN medians as below seal", () => {
    expect(classifyL9OverallMedian(null, 5)).toBe("below_seal")
    expect(classifyL9OverallMedian(undefined, 5)).toBe("below_seal")
    expect(classifyL9OverallMedian(Number.NaN, 5)).toBe("below_seal")
    expect(meetsL9OverallGate(null, "seal_stretch", 5)).toBe(false)
    expect(meetsL9OverallGate(Number.NaN, "test_control", 5)).toBe(false)
  })
})

describe("validateLiteraryExperimentComparability", () => {
  it("rejects cross-model compare", () => {
    const a = createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6" })
    const b = createLiteraryExperimentProtocol({ model: "composer-2.5" })
    const errs = validateLiteraryExperimentComparability(a, b)
    expect(errs.some((e) => e.includes("model mismatch"))).toBe(true)
  })

  it("accepts identical seal protocols", () => {
    const a = createLiteraryExperimentProtocol()
    const b = createLiteraryExperimentProtocol()
    expect(validateLiteraryExperimentComparability(a, b)).toEqual([])
  })

  it("rejects window / mode / samples mismatches and sub-seal sample counts", () => {
    const base = createLiteraryExperimentProtocol({ samples: 5 })
    const win = createLiteraryExperimentProtocol({ samples: 5 }) as typeof base
    ;(win as { window: string }).window = "chapter_window"
    expect(validateLiteraryExperimentComparability(base, win).some((e) => e.includes("window mismatch"))).toBe(true)

    const mode = createLiteraryExperimentProtocol({ samples: 5, mode: "AB_old_new" })
    expect(validateLiteraryExperimentComparability(base, mode).some((e) => e.includes("mode mismatch"))).toBe(true)

    const samples = createLiteraryExperimentProtocol({ samples: 6 })
    expect(validateLiteraryExperimentComparability(base, samples).some((e) => e.includes("samples mismatch"))).toBe(true)

    const subSeal = createLiteraryExperimentProtocol({ samples: 3 })
    const errs = validateLiteraryExperimentComparability(base, subSeal)
    expect(errs.some((e) => e.includes("below seal minimum"))).toBe(true)
  })
})

describe("bandForMedian", () => {
  it("maps calibration bands", () => {
    expect(bandForMedian(8.5, 5)).toBe("reviewer_bias_dominant")
    expect(bandForMedian(5.3, 5)).toBe("text_gap_dominant")
    expect(bandForMedian(7.8, 5)).toBe("mixed_zone")
    expect(bandForMedian(9, 3)).toBe("insufficient_samples")
    expect(bandForMedian(8.4, 5)).toBe("reviewer_bias_dominant")
    expect(bandForMedian(7.5, 5)).toBe("text_gap_dominant")
  })

  it("treats null / NaN medians as mixed zone (unverdictable)", () => {
    expect(bandForMedian(null, 5)).toBe("mixed_zone")
    expect(bandForMedian(undefined, 5)).toBe("mixed_zone")
    expect(bandForMedian(Number.NaN, 5)).toBe("mixed_zone")
  })
})

describe("compareLiteraryExperimentSnapshots", () => {
  const protocol = createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6", samples: 5 })

  it("flags multi-objective conflict when thril up and pull/character down", () => {
    const before = {
      model: "claude-sonnet-4-6",
      samples: 5,
      medians: { thrill: 5.8, pull: 7.6, character: 6.8, pacing: 5.8, consistency: 3.8, continuity: 4.8 },
      overallMedian: 5.8,
    }
    const after = {
      model: "claude-sonnet-4-6",
      samples: 5,
      medians: { thrill: 6.4, pull: 5.9, character: 4.8, pacing: 5.8, consistency: 3.8, continuity: 3.8 },
      overallMedian: 5.3,
    }
    const r = compareLiteraryExperimentSnapshots(before, after, protocol)
    expect(r.thrilDelta).toBe(0.6)
    expect(r.pullDelta).toBe(-1.7)
    expect(r.characterDelta).toBe(-2)
    expect(r.multiObjectiveConflict).toBe(true)
    expect(r.protectedRegressions).toEqual(expect.arrayContaining(["pull", "character"]))
  })

  it("no conflict when thril up without protected regression", () => {
    const before = {
      model: "claude-sonnet-4-6",
      samples: 5,
      medians: { thrill: 5.8, pull: 6.8, character: 4.8 },
    }
    const after = {
      model: "claude-sonnet-4-6",
      samples: 5,
      medians: { thrill: 6.4, pull: 6.8, character: 5.0 },
    }
    const r = compareLiteraryExperimentSnapshots(before, after, protocol)
    expect(r.multiObjectiveConflict).toBe(false)
  })

  it("warns on snapshot model mismatch and deviation from protocol model", () => {
    const before = { model: "grok-4.6", samples: 5, medians: { thrill: 6.0 } }
    const after = { model: "other-model", samples: 5, medians: { thrill: 6.5 } }
    const r = compareLiteraryExperimentSnapshots(before, after, protocol)
    expect(r.warnings.some((w) => w.includes("snapshot model mismatch"))).toBe(true)
    expect(r.warnings.some((w) => w.includes("differs from protocol.model"))).toBe(true)
  })

  it("warns when snapshot sample counts differ from protocol", () => {
    const before = { model: "claude-sonnet-4-6", samples: 3, medians: { thrill: 6.0 } }
    const after = { model: "claude-sonnet-4-6", samples: 5, medians: { thrill: 6.5 } }
    const r = compareLiteraryExperimentSnapshots(before, after, protocol)
    expect(r.warnings.some((w) => w.includes("sample count differs"))).toBe(true)
  })

  it("yields null deltas when dimension medians are missing", () => {
    const before = { model: "claude-sonnet-4-6", samples: 5, medians: {} }
    const after = { model: "claude-sonnet-4-6", samples: 5, medians: {} }
    const r = compareLiteraryExperimentSnapshots(before, after, protocol)
    expect(r.thrilDelta).toBeNull()
    expect(r.pullDelta).toBeNull()
    expect(r.characterDelta).toBeNull()
    expect(r.overallDelta).toBeNull()
    expect(r.multiObjectiveConflict).toBe(false)
    expect(r.protectedRegressions).toEqual([])
  })

  it("uses custom protect dimensions and regression threshold", () => {
    const before = { model: "claude-sonnet-4-6", samples: 5, medians: { thrill: 5.0, pacing: 8.0 } }
    const after = { model: "claude-sonnet-4-6", samples: 5, medians: { thrill: 6.0, pacing: 7.0 } }
    const r = compareLiteraryExperimentSnapshots(before, after, protocol, {
      protectDimensions: ["pacing"],
      regressionThreshold: 0.8,
    })
    expect(r.multiObjectiveConflict).toBe(true)
    expect(r.protectedRegressions).toEqual(["pacing"])
  })
})

describe("buildProductionStep0Fixture + snapshotFromStep0Results", () => {
  it("embeds protocol and full chapterText", () => {
    const fx = buildProductionStep0Fixture({
      projectPath: "E:/写作/8人",
      chapter: 4,
      chapterText: "正文" + "甲".repeat(100),
      pack: thinPack,
      protocol: createLiteraryExperimentProtocol({ label: "post-wave3" }),
      generatedAt: "2026-08-09T00:00:00.000Z",
    })
    expect(fx.packKind).toBe("production-measurement")
    expect(fx.protocol.model).toBe(LITERARY_EXPERIMENT_DEFAULT_MODEL)
    expect(fx.diagnosis.product_hard_gate).toBe(false)
    expect(fx.diagnosis.same_model_required).toBe(true)
    expect(fx.sampleChars).toBe(fx.chapterText.length)
    expect(fx.chapterText.startsWith("正文")).toBe(true)
  })

  it("snapshotFromStep0Results reads newMedian", () => {
    const snap = snapshotFromStep0Results({
      model: "claude-sonnet-4-6",
      samples: 5,
      results: {
        thrill: { newMedian: 6.4, new: [6.4, 6.4, 6.4, 6.4, 6.4] },
        pull: { newMedian: 5.9 },
      },
      verdict: { overallNewMedian: 5.3 },
      remeasure: { label: "post-wave3" },
    })
    expect(snap.medians.thrill).toBe(6.4)
    expect(snap.medians.pull).toBe(5.9)
    expect(snap.overallMedian).toBe(5.3)
    expect(snap.label).toBe("post-wave3")
  })

  it("snapshotFromStep0Results computes median from raw new values (even + odd counts)", () => {
    const snap = snapshotFromStep0Results({
      results: {
        thrill: { new: [6.4, 5.2, 8.0, 7.0] },
        pull: { new: [6.0, 7.0, 8.0] },
      },
    })
    // 5.2,6.4,7.0,8.0 → even → (6.4+7.0)/2
    expect(snap.medians.thrill).toBe(6.7)
    // 6,7,8 → odd → 7
    expect(snap.medians.pull).toBe(7)
  })

  it("snapshotFromStep0Results filters nulls and defaults model/samples", () => {
    const snap = snapshotFromStep0Results({
      results: {
        thrill: { new: [6.4, null, Number.NaN] },
        pacing: { new: [] },
      },
    })
    expect(snap.medians.thrill).toBe(6.4)
    expect(snap.medians.pacing).toBeUndefined()
    expect(snap.model).toBe("unknown")
    expect(snap.samples).toBe(0)
    expect(snap.medians.consistency).toBeUndefined()
  })

  it("snapshotFromStep0Results tolerates absent results and new-less entries", () => {
    const noResults = snapshotFromStep0Results({})
    expect(noResults.medians).toEqual({})
    expect(noResults.overallMedian).toBeUndefined()

    const emptyEntry = snapshotFromStep0Results({ results: { thrill: {} } })
    expect(emptyEntry.medians.thrill).toBeUndefined()
  })
})



describe("buildProductionStep0Fixture measurementFingerprint", () => {
  it("embeds M0 fingerprint", () => {
    const f = buildProductionStep0Fixture({
      projectPath: "/p",
      chapter: 4,
      chapterText: "正文样本",
      pack: thinPack,
    })
    expect(f.measurementFingerprint.schemaVersion).toBe("measurement-fingerprint/1.0")
    expect(f.measurementFingerprint.packHash).toMatch(/^[0-9a-f]{16}$/)
    expect(f.measurementFingerprint.chapterTextHash).toMatch(/^[0-9a-f]{16}$/)
    expect(f.windowNote).toContain("fp=")
  })
})
