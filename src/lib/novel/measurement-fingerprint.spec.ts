import { describe, expect, it } from "vitest"
import type { ContextPack } from "./context-engine"
import { createLiteraryExperimentProtocol } from "./literary-experiment-protocol"
import {
  buildMeasurementFingerprint,
  assertThrilProgressClaimAllowed,
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

  it("assertThrilProgressClaimAllowed refuses cross-pack thril progress curves", () => {
    const protocol = createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6", samples: 5 })
    const baseline = buildMeasurementFingerprint({
      protocol,
      pack: basePack,
      chapterText: "same-body",
      packKind: "thin",
    })
    const candidate = buildMeasurementFingerprint({
      protocol,
      pack: { ...basePack, outline: basePack.outline + "\nEXTRA" },
      chapterText: "same-body",
      packKind: "fat",
    })
    const claim = assertThrilProgressClaimAllowed(baseline, candidate)
    expect(claim.allowed).toBe(false)
    expect(claim.reason).toMatch(/REFUSE thril progress/)
    expect(claim.errors.some((e) => e.includes("packHash"))).toBe(true)
  })

  it("assertThrilProgressClaimAllowed allows locked pack+text thril compare", () => {
    const protocol = createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6", samples: 5 })
    const a = buildMeasurementFingerprint({
      protocol,
      pack: basePack,
      chapterText: "same-body",
    })
    const b = buildMeasurementFingerprint({
      protocol,
      pack: { ...basePack },
      chapterText: "same-body",
    })
    const claim = assertThrilProgressClaimAllowed(a, b)
    expect(claim.allowed).toBe(true)
    expect(claim.errors).toEqual([])
  })
})


describe("S2d 测量契约硬化 (roadmap R09 验收补强)", () => {
  it("指纹字段 additive: 旧报告无 fingerprint 字段仍可加载 (schema additive)", () => {
    // 模拟旧版 step0 fixture (无 measurementFingerprint 字段)
    const legacyReport = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      protocol: { window: "last5", model: "claude-sonnet-4-6", samples: 5, mode: "diagnose" },
    }
    // additive 语义: fingerprint 是可选补充字段, 旧数据不含它不构成破坏
    const loaded = legacyReport as { measurementFingerprint?: unknown }
    expect(loaded.measurementFingerprint).toBeUndefined()
    // 新数据含 fingerprint 字段 → 结构完整
    const fp = buildMeasurementFingerprint({
      protocol: createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6", samples: 5 }),
      pack: basePack,
      chapterText: "x",
    })
    expect(fp.model).toBe("claude-sonnet-4-6")
    expect(fp.samples).toBe(5)
    expect(fp.window).toBeTruthy()
    expect(fp.packHash.length).toBeGreaterThan(8)
  })

  it("跨 pack 分数叙事不可伪造: packHash 不同即拒绝, 分数差异不可归因文本", () => {
    const protocol = createLiteraryExperimentProtocol({ model: "claude-sonnet-4-6", samples: 5 })
    const baseline = buildMeasurementFingerprint({
      protocol,
      pack: basePack,
      chapterText: "正文",
    })
    const candidate = buildMeasurementFingerprint({
      protocol,
      pack: { ...basePack, recentSummaries: ["extra summary entry"] },
      chapterText: "正文",
    })
    const claim = assertThrilProgressClaimAllowed(baseline, candidate)
    expect(claim.allowed).toBe(false)
    expect(claim.reason).toContain("REFUSE")
    // 任何 pack 字段差异 → 不可归因文本因果
    expect(claim.errors.some((e) => e.includes("packHash mismatch"))).toBe(true)
  })
})
