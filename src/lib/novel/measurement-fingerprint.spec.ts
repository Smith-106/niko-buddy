import { describe, expect, it } from "vitest"
import type { ContextPack } from "./context-engine"
import { createLiteraryExperimentProtocol } from "./literary-experiment-protocol"
import {
  buildMeasurementFingerprint,
  formatMeasurementFingerprintSummary,
  validateMeasurementFingerprintComparability,
} from "./measurement-fingerprint"

const basePack = {
  task: "六维审查第4章",
  chapterGoal: "goal",
  outline: "outline-body",
  recentSummaries: [],
  previousChapterEnding: "ending",
  characterStates: "chars",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "",
  foreshadowingStates: "",
  timeline: "",
  relatedSettings: "",
  canonRules: "FIX-1",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "",
  mustAvoid: "",
  nextChapterAdvice: "",
  revisionDirectives: "",
} satisfies ContextPack

describe("measurement-fingerprint M0", () => {
  it("is stable for identical pack+text+protocol", () => {
    const protocol = createLiteraryExperimentProtocol({ label: "t" })
    const a = buildMeasurementFingerprint({
      protocol,
      pack: basePack,
      chapterText: "正文ABC",
      packKind: "production-measurement",
    })
    const b = buildMeasurementFingerprint({
      protocol,
      pack: { ...basePack },
      chapterText: "正文ABC",
      packKind: "production-measurement",
    })
    expect(a.id).toBe(b.id)
    expect(a.packHash).toBe(b.packHash)
    expect(a.chapterTextHash).toBe(b.chapterTextHash)
  })

  it("changes packHash when outline changes (same text)", () => {
    const protocol = createLiteraryExperimentProtocol()
    const thin = buildMeasurementFingerprint({
      protocol,
      pack: basePack,
      chapterText: "same",
    })
    const fat = buildMeasurementFingerprint({
      protocol,
      pack: { ...basePack, outline: "outline-body" + "X".repeat(500) },
      chapterText: "same",
    })
    expect(thin.chapterTextHash).toBe(fat.chapterTextHash)
    expect(thin.packHash).not.toBe(fat.packHash)
    const errs = validateMeasurementFingerprintComparability(thin, fat)
    expect(errs.some((e) => e.includes("packHash mismatch"))).toBe(true)
  })

  it("refuses cross-model even with same pack", () => {
    const a = buildMeasurementFingerprint({
      protocol: createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6" }),
      pack: basePack,
      chapterText: "t",
    })
    const b = buildMeasurementFingerprint({
      protocol: createLiteraryExperimentProtocol({ model: "composer-2.5" }),
      pack: basePack,
      chapterText: "t",
    })
    expect(validateMeasurementFingerprintComparability(a, b).some((e) => e.includes("model"))).toBe(
      true,
    )
  })

  it("formatMeasurementFingerprintSummary is non-empty", () => {
    const fp = buildMeasurementFingerprint({
      protocol: createLiteraryExperimentProtocol(),
      pack: basePack,
      chapterText: "x",
    })
    expect(formatMeasurementFingerprintSummary(fp)).toContain("fp=")
    expect(formatMeasurementFingerprintSummary(fp)).toContain("pack=")
  })
})
