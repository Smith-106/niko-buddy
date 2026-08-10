import { describe, expect, it } from "vitest"
import type { ContextPack } from "./context-engine"
import {
  LITERARY_EXPERIMENT_DEFAULT_MODEL,
  LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL,
  bandForMedian,
  buildProductionStep0Fixture,
  compareLiteraryExperimentSnapshots,
  createLiteraryExperimentProtocol,
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
})

describe("bandForMedian", () => {
  it("maps calibration bands", () => {
    expect(bandForMedian(8.5, 5)).toBe("reviewer_bias_dominant")
    expect(bandForMedian(5.3, 5)).toBe("text_gap_dominant")
    expect(bandForMedian(7.8, 5)).toBe("mixed_zone")
    expect(bandForMedian(9, 3)).toBe("insufficient_samples")
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
