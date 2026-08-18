import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createEmptyEmotionalArcStore,
  emotionalArcsToContextText,
  loadEmotionalArcs,
  saveEmotionalArcs,
  type EmotionalArcStore,
} from "./emotional-arcs"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async () => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
}))

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("R4 EmotionalArcs projection (S4 / ANL-013)", () => {
  it("uses writeFileAtomic (S3 F-002 crash-safety contract, same as character-state.ts)", () => {
    const src = readSource("emotional-arcs.ts")
    expect(src).toMatch(/writeFileAtomic/)
    // No non-atomic writeFile import for writes.
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFile\b[^}]*\}/)
  })

  it("registered as fold_rebuildable in PROJECTION_CATEGORIES (S3 F-002)", () => {
    const src = readSource("projection-status-ledger.ts")
    expect(src).toMatch(/emotional_arc:\s*"fold_rebuildable"/)
  })

  it("is a character-state SAME-LAYER sibling, NOT a Truth Files module (ANL-013 C4)", () => {
    const src = readSource("emotional-arcs.ts")
    // Forbidden: no truth-files layer立项.
    expect(src).not.toMatch(/truth\.files|TruthFiles/i)
    // Required: the C4 no-dual-truth-source anchor is documented.
    expect(src).toMatch(/C4|ADR-26|A23/)
  })

  it("createEmptyEmotionalArcStore seeds an empty store with ISO timestamp", () => {
    const store = createEmptyEmotionalArcStore()
    expect(store.beats).toEqual([])
    expect(store.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("emotionalArcsToContextText returns '' for an empty store (backward compatible)", () => {
    expect(emotionalArcsToContextText(createEmptyEmotionalArcStore())).toBe("")
  })

  it("emotionalArcsToContextText emits only the LATEST beat per character (canon-current)", () => {
    const store: EmotionalArcStore = {
      beats: [
        { character: "昴", chapterNumber: 3, emotion: "怒", intensity: 0.5, trigger: "背叛", notes: "" },
        { character: "昴", chapterNumber: 7, emotion: "决意", intensity: 0.9, trigger: "誓言", notes: "" },
        { character: "艾米莉亚", chapterNumber: 5, emotion: "哀", intensity: 0.7, trigger: "失去", notes: "" },
      ],
      lastUpdated: new Date().toISOString(),
    }
    const text = emotionalArcsToContextText(store)
    // 昴's ch3 beat is superseded by ch7 — only 决意 should appear.
    expect(text).toContain("昴：决意")
    expect(text).not.toContain("昴：怒")
    expect(text).toContain("艾米莉亚：哀")
  })

  it("emotionalArcsToContextText omits trigger clause when empty", () => {
    const store: EmotionalArcStore = {
      beats: [{ character: "X", chapterNumber: 1, emotion: "惊", intensity: 0.2, trigger: "", notes: "" }],
      lastUpdated: new Date().toISOString(),
    }
    expect(emotionalArcsToContextText(store)).toBe("- X：惊（强度0.20）")
  })

  it("emotionalArcsToContextText keeps the existing beat when a later record has an older chapter", () => {
    const store: EmotionalArcStore = {
      beats: [
        { character: "昴", chapterNumber: 7, emotion: "决意", intensity: 0.9, trigger: "誓言", notes: "" },
        { character: "昴", chapterNumber: 3, emotion: "怒", intensity: 0.5, trigger: "背叛", notes: "" },
      ],
      lastUpdated: new Date().toISOString(),
    }
    const text = emotionalArcsToContextText(store)
    // 乱序回写的老章节 beat 不覆盖最新 beat
    expect(text).toContain("昴：决意")
    expect(text).not.toContain("昴：怒")
  })

  it("saveEmotionalArcs persists via atomic store", async () => {
    await saveEmotionalArcs("E:/Novel", createEmptyEmotionalArcStore())
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/.novel/emotional-arcs.json",
      expect.stringContaining("\"beats\": []"),
    )
  })

  it("loadEmotionalArcs falls back to empty store and parses persisted data", async () => {
    fsMocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    expect((await loadEmotionalArcs("E:/Novel")).beats).toEqual([])
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ beats: [{ character: "A", chapterNumber: 1 }], lastUpdated: "t" }),
    )
    const store = await loadEmotionalArcs("E:/Novel")
    expect(store.beats).toHaveLength(1)
    fsMocks.readFile.mockResolvedValueOnce("{corrupt")
    expect((await loadEmotionalArcs("E:/Novel")).beats).toEqual([])
  })

  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
  })
})
