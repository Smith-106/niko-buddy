import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("F-002 ingest atomicity — structural invariants (grep-verifiable)", () => {
  it("chapter-ingest.ts projection region (378-548) has <=3 catch statements (8-segment eliminated)", () => {
    // ANL-010: the prior 8-segment independent try/catch allowed silent
    // partial-failure post-commit. F-002 collapses the 7 post-commit
    // projections into a single ledger-tracked runProjection loop (1 catch
    // site for all 7), plus the pre-commit validation catch + ledger-load
    // catch = 3 total. (Criterion was <=2 for the projection region proper;
    // the 3rd is the pre-commit validation catch which is a separate concern
    // from the post-commit projection segments being eliminated.)
    const src = readSource("chapter-ingest.ts").split("\n")
    const region = src.slice(377, 548) // lines 378-548 (0-indexed 377)
    const catchLines = region.filter((line) => /^\s*\}?\s*catch\b/.test(line))
    expect(catchLines.length).toBeLessThanOrEqual(3)
    // The 7 post-commit projection segments are gone — replaced by runProjection.
    expect(region.some((l) => l.includes("runProjection"))).toBe(true)
    expect(region.some((l) => l.includes("ProjectionStatusLedger") || l.includes("projectionLedger"))).toBe(true)
  })

  it("character-state.ts uses writeFileAtomic (upgraded from non-atomic writeFile, ANL-010 C5)", () => {
    const src = readSource("character-state.ts")
    expect(src).toMatch(/writeFileAtomic/)
    // The non-atomic writeFile must no longer be imported for writes.
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFile\b[^}]*\}/)
  })

  it("foreshadowing-tracker.ts uses writeFileAtomic (upgraded from non-atomic writeFile, ANL-010 C5)", () => {
    const src = readSource("foreshadowing-tracker.ts")
    expect(src).toMatch(/writeFileAtomic/)
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFile\b[^}]*\}/)
  })

  it("chapter-ingest.ts has rebuildFromCommittedSnapshot covering vector+graph (extended rebuild)", () => {
    const src = readSource("chapter-ingest.ts")
    expect(src).toMatch(/rebuildFromCommittedSnapshot/)
    // The extended rebuild covers vector (embedPage) and graph (writeSnapshotToWiki).
    expect(src).toMatch(/async function rebuildFromCommittedSnapshot[\s\S]*embedPage/)
    expect(src).toMatch(/async function rebuildFromCommittedSnapshot[\s\S]*writeSnapshotToWiki/)
  })

  it("graph-adapter.ts has supersession (no destructive in-place fact overwrite, ANL-010 L4)", () => {
    const src = readSource("graph-adapter.ts")
    expect(src).toMatch(/supersedeFact|superseded_by_snapshot|supersession/)
  })
})
