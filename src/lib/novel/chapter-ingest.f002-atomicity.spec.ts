import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("F-002 ingest atomicity — structural invariants (grep-verifiable)", () => {
  it("commits the snapshot before projecting and persists projection deltas in finally", () => {
    const ingest = readSource("chapter-ingest.ts")
    const projections = readSource("chapter-ingest-projections.ts")
    expect(ingest).toMatch(/const commitResult[^=]*= await commitIngestSnapshot\([\s\S]*?if \(commitResult\.status !== "committed"\)[\s\S]*?return runIngestProjections\(/)
    expect(projections).toMatch(/Object\.entries\(PROJECTION_REGISTRY\)[\s\S]*?await runProjection\(projection,/)
    expect(projections).toMatch(/\} finally \{[\s\S]*?await saveProjectionLedgerWithSingleRetry\(pp, projectionDelta\)/)
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
    // W3 拆分后 rebuildFromCommittedSnapshot 迁至 chapter-ingest-fold-registry.ts，
    // 不变量（vector+graph 全覆盖）不变，故聚合两文件扫描。
    const src = [
      readSource("chapter-ingest.ts"),
      readSource("chapter-ingest-fold-registry.ts"),
    ].join("\\n")
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
