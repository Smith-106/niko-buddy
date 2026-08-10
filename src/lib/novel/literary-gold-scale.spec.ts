import { describe, expect, it } from "vitest"
import type { StyleExemplar } from "./style-exemplars-loader"
import {
  DEFAULT_GOLD_TARGET_SCORE,
  GOLD_THRILL_BANDS,
  assessGoldScaleReadiness,
  formatGoldScalePromptBlock,
  mergeGoldAnchorsWithExemplars,
  normalizeGoldAnchorsFile,
  type LiteraryGoldAnchor,
} from "./literary-gold-scale"

const baseEx = (markType: StyleExemplar["markType"], text: string): StyleExemplar => ({
  exemplarId: `id-${markType}-${text.length}`,
  chapterId: "4",
  text,
  markType,
  createdAt: "2026-08-09",
})

describe("literary-gold-scale", () => {
  it("humanGoldFloor is 9-band", () => {
    expect(GOLD_THRILL_BANDS.humanGoldFloor).toBe(9)
    expect(DEFAULT_GOLD_TARGET_SCORE).toBe(9)
  })

  it("normalizeGoldAnchorsFile defaults targetScore to 9", () => {
    const f = normalizeGoldAnchorsFile({
      schemaVersion: "literary-gold-scale/1.0",
      anchors: [{ id: "a1", dimension: "thrill", text: "x".repeat(30), status: "human_confirmed" }],
    })
    expect(f.anchors).toHaveLength(1)
    expect(f.anchors[0].targetScore).toBe(9)
    expect(f.anchors[0].status).toBe("human_confirmed")
  })

  it("readiness false without human_confirmed thrill", () => {
    const r = assessGoldScaleReadiness({
      anchors: [{ id: "p", dimension: "thrill", targetScore: 9, text: "y".repeat(40), status: "provisional" }],
      exemplars: [baseEx("style", "only style")],
    })
    expect(r.readyForThrill9Calibration).toBe(false)
    expect(r.readyForThrill8Calibration).toBe(false)
    expect(r.targetBand).toBe(9)
    expect(r.warnings.some((w) => w.includes("thril≥9") || w.includes("uncalibrated"))).toBe(true)
  })

  it("readiness true with 3 human_confirmed thrill", () => {
    const anchors: LiteraryGoldAnchor[] = [1, 2, 3].map((i) => ({
      id: `h${i}`,
      dimension: "thrill",
      targetScore: 9,
      text: `human gold thril segment number ${i} with enough length`,
      status: "human_confirmed",
    }))
    const r = assessGoldScaleReadiness({ anchors })
    expect(r.readyForThrill9Calibration).toBe(true)
    expect(r.readyForThrill8Calibration).toBe(true)
    expect(r.humanConfirmedThrillCount).toBe(3)
    expect(r.promptHint).toContain("thril≈9")
  })

  it("formatGoldScalePromptBlock prefers human_confirmed and mentions 9-band", () => {
    const anchors: LiteraryGoldAnchor[] = [
      { id: "p", dimension: "thrill", targetScore: 9, text: "provisional text here long enough", status: "provisional" },
      { id: "h", dimension: "thrill", targetScore: 9, text: "confirmed human thril gold text long enough", status: "human_confirmed" },
    ]
    const block = formatGoldScalePromptBlock(anchors)
    expect(block).toContain("human_confirmed")
    expect(block).toContain("confirmed human thril")
    expect(block).toContain("9")
    expect(block).not.toContain("provisional text")
  })

  it("mergeGoldAnchorsWithExemplars imports thrill exemplars at target 9", () => {
    const merged = mergeGoldAnchorsWithExemplars(
      [],
      [baseEx("thrill", "thrill exemplar text long enough for import"), baseEx("style", "style only")],
    )
    const thrill = merged.find((a) => a.source === "exemplar_import" && a.dimension === "thrill")
    expect(thrill?.targetScore).toBe(9)
  })
})
