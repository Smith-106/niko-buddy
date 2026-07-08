import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createEmptySubplotBoardStore,
  subplotBoardToContextText,
  type SubplotBoardStore,
} from "./subplot-board"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("R4 SubplotBoard projection (S4 / ANL-013)", () => {
  it("uses writeFileAtomic (S3 F-002 crash-safety contract)", () => {
    const src = readSource("subplot-board.ts")
    expect(src).toMatch(/writeFileAtomic/)
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFile\b[^}]*\}/)
  })

  it("registered as single_snapshot_idempotent in PROJECTION_CATEGORIES (ARCH-002)", () => {
    // ARCH-002 / ISS-20260708-006: subplot_board commits an EMPTY store
    // (no snapshot subplot field wired yet — LLM-extract extension out of
    // scope), so it is single_snapshot_idempotent (re-run = same empty
    // state), NOT fold_rebuildable (there is nothing to fold). Re-classify
    // to fold_rebuildable when a snapshot subplot field is added.
    const src = readSource("projection-status-ledger.ts")
    expect(src).toMatch(/subplot_board:\s*"single_snapshot_idempotent"/)
    expect(src).not.toMatch(/subplot_board:\s*"fold_rebuildable"/)
  })

  it("is a character-state SAME-LAYER sibling, NOT a Truth Files module (ANL-013 C4)", () => {
    const src = readSource("subplot-board.ts")
    expect(src).not.toMatch(/truth\.files|TruthFiles/i)
    expect(src).toMatch(/C4|ADR-26|A23/)
  })

  it("distinct from foreshadowing-tracker (subplot = 支线剧情进度, not 埋设-回收)", () => {
    const src = readSource("subplot-board.ts")
    // The projection must NOT reuse the foreshadowing plant/advance/resolve
    // vocabulary — subplot has its own status set.
    expect(src).toMatch(/"proposed" \| "active" \| "paused" \| "resolved"/)
    expect(src).toMatch(/progress/)
  })

  it("createEmptySubplotBoardStore seeds an empty store with ISO timestamp", () => {
    const store = createEmptySubplotBoardStore()
    expect(store.items).toEqual([])
    expect(store.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("subplotBoardToContextText returns '' for an empty store (backward compatible)", () => {
    expect(subplotBoardToContextText(createEmptySubplotBoardStore())).toBe("")
  })

  it("subplotBoardToContextText excludes resolved subplots (mirrors foreshadowing unresolved-only filter)", () => {
    const store: SubplotBoardStore = {
      items: [
        { id: "sp-1", title: "商会暗线", status: "active", startChapter: 2, relatedCharacters: ["甲"], summary: "调查商会走私", progress: ["发现账本"], notes: "" },
        { id: "sp-2", title: "旧案", status: "resolved", startChapter: 1, resolvedChapter: 6, relatedCharacters: [], summary: "了结旧案", progress: [], notes: "" },
        { id: "sp-3", title: "宫廷阴谋", status: "paused", startChapter: 4, relatedCharacters: ["乙", "丙"], summary: "宫廷权力斗争", progress: ["潜伏"], notes: "" },
      ],
      lastUpdated: new Date().toISOString(),
    }
    const text = subplotBoardToContextText(store)
    expect(text).toContain("商会暗线")
    expect(text).toContain("宫廷阴谋")
    expect(text).not.toContain("旧案")
    // Latest progress entry is injected.
    expect(text).toContain("发现账本")
  })
})
