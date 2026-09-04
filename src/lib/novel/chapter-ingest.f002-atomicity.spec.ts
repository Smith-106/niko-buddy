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
    // 锚点式定位：从 runProjection 定义处取 200 行作为 projection region。
    // 原硬编码 slice(550, 748) 因顶部新增 import 行位移而漂移（52 号报告
    // 终验回归），改为锚点后对新增 import/导出行免疫。
    const runProjectionIdx = src.findIndex((l) => l.includes("const runProjection = async"))
    expect(runProjectionIdx).toBeGreaterThan(-1)
    const region = src.slice(runProjectionIdx, runProjectionIdx + 200)
    const catchLines = region.filter((line) => /^\s*\}?\s*catch\b/.test(line))
    expect(catchLines.length).toBeLessThanOrEqual(3)
    // The 7 post-commit projection segments are gone — replaced by runProjection.
    expect(region.some((l) => l.includes("runProjection"))).toBe(true)
    expect(region.some((l) => l.includes("ProjectionStatusLedger") || l.includes("projectionLedger"))).toBe(true)
  })

  it("character-state.ts 经 createAtomicJsonStore 工厂原子写（E-03 迁移，ANL-010 C5 语义保留）", () => {
    const src = readSource("character-state.ts")
    // E-03 (run-execute-1): 直写迁移到工厂 — 原子写由 createAtomicJsonStore
    // 内部 writeFileAtomic (temp+fsync+rename) 保证，模块自身不再直接 import。
    expect(src).toMatch(/createAtomicJsonStore/)
    expect(src).not.toMatch(/writeFileAtomic/)
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFile\b[^}]*\}/)
  })

  it("foreshadowing-tracker.ts 经 createAtomicJsonStore 工厂原子写（E-03 迁移，ANL-010 C5 语义保留）", () => {
    const src = readSource("foreshadowing-tracker.ts")
    expect(src).toMatch(/createAtomicJsonStore/)
    expect(src).not.toMatch(/writeFileAtomic/)
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
