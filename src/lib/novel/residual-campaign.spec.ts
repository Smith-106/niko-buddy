import { describe, expect, it } from "vitest"
import {
  RESIDUAL_CAMPAIGN_ORDER,
  RESIDUAL_FREEZE_CHAPTERS,
  RESIDUAL_PACING_REGRESSION_THRESHOLD,
  WAVE8_RESIDUAL_HOLD_MEDIANS,
  evaluateResidualKeep,
  isResidualCampaignChapter,
  resolveResidualCampaignFields,
} from "./residual-campaign"

describe("residual-campaign product opt-in", () => {
  it("defaults fail-open when disabled", () => {
    expect(
      resolveResidualCampaignFields({
        enabled: false,
        chapterNumber: 5,
      }),
    ).toBeNull()
  })

  it("M4: Wave8 holds are live 8.8 for residual chapters, 9.0 frozen", () => {
    expect(WAVE8_RESIDUAL_HOLD_MEDIANS[1]).toBe(8.8)
    expect(WAVE8_RESIDUAL_HOLD_MEDIANS[2]).toBe(8.8)
    expect(WAVE8_RESIDUAL_HOLD_MEDIANS[3]).toBe(8.8)
    expect(WAVE8_RESIDUAL_HOLD_MEDIANS[5]).toBe(8.8)
    expect(WAVE8_RESIDUAL_HOLD_MEDIANS[4]).toBe(9.0)
    expect(WAVE8_RESIDUAL_HOLD_MEDIANS[6]).toBe(9.0)
  })

  it("resolves live hold median for Ch5 residual_high", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 5,
    })
    expect(r).not.toBeNull()
    expect(r!.residualOverallMedian).toBe(WAVE8_RESIDUAL_HOLD_MEDIANS[5])
    expect(r!.residualRewriteMode).toBe("structure_thril_pacing")
    expect(r!.residualLengthPreserving).toBe(true)
    expect(r!.residualBand).toBe("residual_high")
    expect(r!.chapterStructurePlan.beats.length).toBeGreaterThan(0)
    expect(r!.keepGate).toBe("seal_stretch")
    expect(r!.productHardGate).toBe(false)
  })

  it("freezes Ch4/Ch6 by default (policy A)", () => {
    expect(
      resolveResidualCampaignFields({ enabled: true, chapterNumber: 4 }),
    ).toBeNull()
    expect(
      resolveResidualCampaignFields({ enabled: true, chapterNumber: 6 }),
    ).toBeNull()
    expect(RESIDUAL_FREEZE_CHAPTERS.has(4)).toBe(true)
  })

  it("includeFreeze allows Ch4 with at_nine band", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 4,
      config: { residualCampaignIncludeFreezeChapters: true },
    })
    expect(r).not.toBeNull()
    expect(r!.frozen).toBe(true)
    expect(r!.residualBand).toBe("at_nine")
  })

  it("resolves null when chapter number is missing or invalid", () => {
    expect(resolveResidualCampaignFields({ enabled: true, chapterNumber: null })).toBeNull()
    expect(resolveResidualCampaignFields({ enabled: true, chapterNumber: 0 })).toBeNull()
    expect(resolveResidualCampaignFields({ enabled: true, chapterNumber: Number.NaN })).toBeNull()
  })

  it("falls back to the threshold hold for chapters outside the hold table", () => {
    const r = resolveResidualCampaignFields({ enabled: true, chapterNumber: 7 })
    expect(r!.residualOverallMedian).toBe(8.6)
  })

  it("maps below-threshold median to below_residual", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 1,
      config: { residualCampaignOverallMedian: 8.0 },
    })
    expect(r!.residualBand).toBe("below_residual")
  })

  it("P4 campaign order is Ch5→Ch2→Ch1→Ch3", () => {
    expect([...RESIDUAL_CAMPAIGN_ORDER]).toEqual([5, 2, 1, 3])
    expect(isResidualCampaignChapter(5)).toBe(true)
    expect(isResidualCampaignChapter(4)).toBe(false)
  })

  it("override median works", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 2,
      config: { residualCampaignOverallMedian: 8.7 },
    })
    expect(r!.residualOverallMedian).toBe(8.7)
  })

  it("M3: test_control gate maps 9.2 median to seal_pass_below_test_control", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 1,
      config: {
        residualCampaignOverallMedian: 9.2,
        residualCampaignKeepGate: "test_control",
      },
    })
    expect(r!.keepGate).toBe("test_control")
    expect(r!.residualBand).toBe("seal_pass_below_test_control")
    expect(r!.l9Disposition).toBe("seal_pass_below_test_control")
  })

  it("M3: test_control_pass when median ≥ 9.5", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 1,
      config: {
        residualCampaignOverallMedian: 9.6,
        residualCampaignKeepGate: "test_control",
      },
    })
    expect(r!.residualBand).toBe("test_control_pass")
    expect(r!.l9Disposition).toBe("test_control_pass")
  })

  it("M1: dim-aware plan honors weak thrill for Ch2", () => {
    const r = resolveResidualCampaignFields({
      enabled: true,
      chapterNumber: 2,
      config: {
        residualCampaignDimMedians: { thrill: 8.1, pacing: 8.3 },
      },
    })
    expect(r!.chapterStructurePlan.notes?.[0]).toMatch(/emphasis=thril/)
  })

  it("M1: dim-aware plan paces Ch5 pacing-safe", () => {
    const r = resolveResidualCampaignFields({ enabled: true, chapterNumber: 5 })
    expect(r!.chapterStructurePlan.notes?.[0]).toMatch(/emphasis=pacing_safe/)
    expect(r!.chapterStructurePlan.beats[2].purpose).toBe("agency_turn")
  })
})

describe("evaluateResidualKeep (M2 pacing KEEP + dual-threshold)", () => {
  it("rollback_overall below hold", () => {
    const e = evaluateResidualKeep({ overallMedian: 8.5, holdMedian: 8.8 })
    expect(e.disposition).toBe("rollback_overall")
    expect(e.accept).toBe(false)
    expect(e.productHardGate).toBe(false)
  })

  it("rollback_pacing when pacing drop ≥ threshold despite overall ≥ hold", () => {
    const e = evaluateResidualKeep({
      overallMedian: 8.9,
      holdMedian: 8.8,
      pacingBefore: 8.4,
      pacingAfter: 8.0,
    })
    expect(e.disposition).toBe("rollback_pacing")
    expect(e.accept).toBe(false)
    expect(e.pacingDelta).toBeCloseTo(-0.4)
    expect(e.pacingDelta!).toBeLessThanOrEqual(-RESIDUAL_PACING_REGRESSION_THRESHOLD)
  })

  it("keep under seal gate at 8.9/8.8 with no pacing data", () => {
    const e = evaluateResidualKeep({ overallMedian: 8.9, holdMedian: 8.8 })
    expect(e.disposition).toBe("keep")
    expect(e.accept).toBe(true)
    expect(e.l9Disposition).toBe("below_seal")
  })

  it("continue_polish under test_control at 9.2", () => {
    const e = evaluateResidualKeep({
      overallMedian: 9.2,
      holdMedian: 8.8,
      keepGate: "test_control",
    })
    expect(e.disposition).toBe("continue_polish")
    expect(e.accept).toBe(true)
    expect(e.l9Disposition).toBe("seal_pass_below_test_control")
  })

  it("keep under test_control at 9.5", () => {
    const e = evaluateResidualKeep({
      overallMedian: 9.5,
      holdMedian: 8.8,
      keepGate: "test_control",
    })
    expect(e.disposition).toBe("keep")
    expect(e.l9Disposition).toBe("test_control_pass")
  })

  it("isResidualCampaignChapter accepts campaign chapters and rejects others", () => {
    expect(isResidualCampaignChapter(2)).toBe(true)
    expect(isResidualCampaignChapter(1)).toBe(true)
    expect(isResidualCampaignChapter(9)).toBe(false)
    expect(isResidualCampaignChapter(null)).toBe(false)
    expect(isResidualCampaignChapter(Number.NaN)).toBe(false)
  })

  it("rollback_overall for non-finite medians", () => {
    const e = evaluateResidualKeep({ overallMedian: Number.NaN, holdMedian: 8.8 })
    expect(e.disposition).toBe("rollback_overall")
    expect(e.reason).toContain("not finite")
    const e2 = evaluateResidualKeep({ overallMedian: 8.9, holdMedian: Number.NaN })
    expect(e2.disposition).toBe("rollback_overall")
  })

  it("honors an explicit pacingRegressionThreshold", () => {
    const e = evaluateResidualKeep({
      overallMedian: 8.9,
      holdMedian: 8.8,
      pacingBefore: 8.3,
      pacingAfter: 8.1,
      pacingRegressionThreshold: 0.15,
    })
    expect(e.disposition).toBe("rollback_pacing")
    expect(e.pacingDelta).toBeCloseTo(-0.2)
  })

  it("small pacing wobble below threshold does not rollback", () => {
    const e = evaluateResidualKeep({
      overallMedian: 8.9,
      holdMedian: 8.8,
      pacingBefore: 8.3,
      pacingAfter: 8.15,
    })
    expect(e.disposition).toBe("keep")
  })
})
