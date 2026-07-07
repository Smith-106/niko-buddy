import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createEmptyResourceLedgerStore,
  resourceLedgerToContextText,
  type ResourceLedgerStore,
} from "./resource-ledger"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("R4 ResourceLedger projection (S4 / ANL-013)", () => {
  it("uses writeFileAtomic (S3 F-002 crash-safety contract)", () => {
    const src = readSource("resource-ledger.ts")
    expect(src).toMatch(/writeFileAtomic/)
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFile\b[^}]*\}/)
  })

  it("registered as fold_rebuildable in PROJECTION_CATEGORIES (S3 F-002)", () => {
    const src = readSource("projection-status-ledger.ts")
    expect(src).toMatch(/resource_ledger:\s*"fold_rebuildable"/)
  })

  it("is a character-state SAME-LAYER sibling, NOT a Truth Files module (ANL-013 C4)", () => {
    const src = readSource("resource-ledger.ts")
    expect(src).not.toMatch(/truth\.files|TruthFiles/i)
    expect(src).toMatch(/C4|ADR-26|A23/)
  })

  it("distinct from graph item node — tracks归属转移时序, not just item-as-graph-node", () => {
    const src = readSource("resource-ledger.ts")
    // Must carry a transfer history (时序账本), not just a current holder.
    expect(src).toMatch(/transferHistory/)
    expect(src).toMatch(/ResourceTransfer/)
    expect(src).toMatch(/currentHolder/)
  })

  it("createEmptyResourceLedgerStore seeds an empty store with ISO timestamp", () => {
    const store = createEmptyResourceLedgerStore()
    expect(store.entries).toEqual([])
    expect(store.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("resourceLedgerToContextText returns '' for an empty store (backward compatible)", () => {
    expect(resourceLedgerToContextText(createEmptyResourceLedgerStore())).toBe("")
  })

  it("resourceLedgerToContextText emits current holder + transfer/acquire chapter", () => {
    const store: ResourceLedgerStore = {
      entries: [
        {
          item: "轩辕剑",
          currentHolder: "昊天",
          acquiredChapter: 2,
          transferHistory: [
            { fromChapter: 2, fromHolder: "", toHolder: "云飞" },
            { fromChapter: 8, fromHolder: "云飞", toHolder: "昊天" },
          ],
        },
        {
          item: "无主之物",
          currentHolder: "",
          acquiredChapter: 1,
          transferHistory: [],
        },
      ],
      lastUpdated: new Date().toISOString(),
    }
    const text = resourceLedgerToContextText(store)
    expect(text).toContain("轩辕剑：持有者 昊天")
    expect(text).toContain("第8章转手")
    expect(text).toContain("无主之物：无主")
  })
})
