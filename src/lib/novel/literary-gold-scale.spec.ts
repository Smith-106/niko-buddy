import { describe, expect, it, vi } from "vitest"
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

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
}))

vi.mock("./style-exemplars-loader", () => ({
  loadStyleExemplars: vi.fn(),
}))

import { readFile } from "@/commands/fs"
import { loadStyleExemplars } from "./style-exemplars-loader"
import {
  loadGoldScaleMaterials,
  loadLiteraryGoldAnchors,
} from "./literary-gold-scale"

const mockedReadFile = vi.mocked(readFile)
const mockedLoadStyleExemplars = vi.mocked(loadStyleExemplars)

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

  it("normalizeGoldAnchorsFile returns empty anchors for non-object raw", () => {
    expect(normalizeGoldAnchorsFile(null)).toEqual({
      schemaVersion: "literary-gold-scale/1.0",
      anchors: [],
    })
    expect(normalizeGoldAnchorsFile("junk").anchors).toHaveLength(0)
    expect(normalizeGoldAnchorsFile({ anchors: "not-an-array" }).anchors).toHaveLength(0)
  })

  it("normalizeGoldAnchorsFile skips invalid items and defaults missing fields", () => {
    const f = normalizeGoldAnchorsFile({
      schemaVersion: "literary-gold-scale/1.0",
      projectNote: "note",
      anchors: [
        null,
        { text: "   " },
        {
          id: "a2",
          dimension: "not-a-dim",
          targetScore: "high",
          text: "valid text",
          status: "bogus",
          chapterId: 42,
          note: "n",
          createdAt: "2026-01-01",
          source: "human",
        },
        { id: "a3", dimension: "pull", targetScore: 8, text: "text", status: "rejected" },
      ],
    })
    expect(f.projectNote).toBe("note")
    expect(f.anchors).toHaveLength(2)
    expect(f.anchors[0].dimension).toBe("thrill")
    expect(f.anchors[0].targetScore).toBe(9)
    expect(f.anchors[0].status).toBe("provisional")
    expect(f.anchors[0].chapterId).toBe("42")
    expect(f.anchors[0].createdAt).toBe("2026-01-01")
    expect(f.anchors[0].source).toBe("human")
    expect(f.anchors[1].dimension).toBe("pull")
    expect(f.anchors[1].targetScore).toBe(8)
    expect(f.anchors[1].status).toBe("rejected")
  })

  it("goldAnchorsFromExemplars imports pull exemplars and falls back id to index", () => {
    const merged = mergeGoldAnchorsWithExemplars(
      [],
      [
        { ...baseEx("pull", "pull exemplar text long enough"), exemplarId: "" as string },
      ],
    )
    const pull = merged.find((a) => a.dimension === "pull")
    expect(pull?.source).toBe("exemplar_import")
    expect(pull?.note).toContain("imported from style-exemplars")
  })

  it("warns when there is no thrill gold text at all", () => {
    const r = assessGoldScaleReadiness({ anchors: [], exemplars: [] })
    expect(r.warnings.some((w) => w.includes("no thrill gold text"))).toBe(true)
  })

  it("ignores thrill anchors with very short text", () => {
    const r = assessGoldScaleReadiness({
      anchors: [
        {
          id: "short",
          dimension: "thrill",
          targetScore: 9,
          text: "short",
          status: "human_confirmed",
        },
      ],
    })
    expect(r.humanConfirmedThrillCount).toBe(0)
  })

  it("formatGoldScalePromptBlock returns empty when no anchors match the dimension", () => {
    expect(formatGoldScalePromptBlock([])).toBe("")
    expect(
      formatGoldScalePromptBlock([
        { id: "p", dimension: "pull", targetScore: 9, text: "pull text", status: "provisional" },
      ]),
    ).toBe("")
  })

  it("formatGoldScalePromptBlock honors options and truncates long text", () => {
    const block = formatGoldScalePromptBlock(
      [
        {
          id: "long",
          dimension: "pull",
          targetScore: 9,
          text: "x".repeat(500),
          status: "provisional",
        },
      ],
      { dimension: "pull", max: 1, maxChars: 20 },
    )
    expect(block).toContain("pull")
    expect(block).toContain("provisional")
    expect(block).toContain("…")
    expect(block).toContain("x".repeat(20))
  })

  it("mergeGoldAnchorsWithExemplars dedupes by text prefix", () => {
    const fileAnchor: LiteraryGoldAnchor = {
      id: "file",
      dimension: "thrill",
      targetScore: 9,
      text: "same text prefix shared by exemplar".padEnd(90, "x"),
      status: "human_confirmed",
    }
    const merged = mergeGoldAnchorsWithExemplars(
      [fileAnchor],
      [baseEx("thrill", fileAnchor.text)],
    )
    expect(merged).toHaveLength(1)
  })

  it("loadLiteraryGoldAnchors parses the on-disk file", async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        anchors: [{ id: "a", dimension: "thrill", text: "some gold text here", status: "human_confirmed" }],
      }),
    )
    const anchors = await loadLiteraryGoldAnchors("C:/proj")
    expect(anchors).toHaveLength(1)
    expect(mockedReadFile).toHaveBeenCalledWith(expect.stringContaining("literary-gold-anchors.json"))
  })

  it("loadLiteraryGoldAnchors returns empty on read or parse failure", async () => {
    mockedReadFile.mockRejectedValueOnce(new Error("missing"))
    expect(await loadLiteraryGoldAnchors("C:/proj")).toEqual([])
    mockedReadFile.mockResolvedValueOnce("{corrupt json")
    expect(await loadLiteraryGoldAnchors("C:/proj")).toEqual([])
  })

  it("loadGoldScaleMaterials merges file anchors with exemplars", async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ anchors: [{ id: "a", dimension: "thrill", text: "file gold text", status: "human_confirmed" }] }),
    )
    mockedLoadStyleExemplars.mockResolvedValueOnce([baseEx("thrill", "exemplar gold text long enough")])
    const materials = await loadGoldScaleMaterials("C:/proj")
    expect(materials.anchors).toHaveLength(1)
    expect(materials.exemplars).toHaveLength(1)
    expect(materials.merged).toHaveLength(2)
  })

  it("loadGoldScaleMaterials tolerates exemplar load failure", async () => {
    mockedReadFile.mockResolvedValueOnce("{corrupt")
    mockedLoadStyleExemplars.mockRejectedValueOnce(new Error("boom"))
    const materials = await loadGoldScaleMaterials("C:/proj")
    expect(materials.anchors).toEqual([])
    expect(materials.exemplars).toEqual([])
    expect(materials.merged).toEqual([])
  })

  it("normalizeGoldAnchorsFile fills defaults when fields are absent", () => {
    const f = normalizeGoldAnchorsFile({
      anchors: [{ text: "some text here" }, { text: "status text", status: "" }, { id: "no-text" }],
    })
    expect(f.anchors).toHaveLength(2)
    expect(f.anchors[0].id).toBe("gold-1")
    expect(f.anchors[0].dimension).toBe("thrill")
    expect(f.anchors[0].status).toBe("provisional")
    expect(f.anchors[1].status).toBe("provisional")
  })

  it("assessGoldScaleReadiness defaults missing inputs", () => {
    const r = assessGoldScaleReadiness({})
    expect(r.minHumanConfirmedRequired).toBe(3)
    expect(r.humanConfirmedThrillCount).toBe(0)
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

