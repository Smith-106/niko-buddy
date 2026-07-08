import { describe, expect, it } from "vitest"
import { runFactCheck, type FactCheckResult } from "./fact-snapshot"
import { buildNameAliasMap } from "./book-analysis/alias-resolver"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { TemporalFact } from "./temporal-memory"

/**
 * TASK-004 (CORR-004): verify checkTemporalConsistency threads the aliasMap
 * through resolveCanonicalName so an alias authored at chapter N matches a
 * canonical fact still valid at that chapter. Previously the pass used an
 * inline NFKC-only resolver, so "昴" (alias) failed to match "菜月昴"
 * (canonical) → false negative, real contradiction missed.
 */

function makeSnapshot(chapter: number, canonFacts: string[]): ChapterSnapshot {
  return {
    chapterId: `chapter-${chapter}`,
    chapterNumber: chapter,
    summary: "",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: canonFacts,
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    sourceType: "chapter",
    sourceSequence: chapter,
    revision: 1,
  } as unknown as ChapterSnapshot
}

function makeTemporalFact(overrides: Partial<TemporalFact> & { id: string }): TemporalFact {
  return {
    subject: "菜月昴",
    predicate: "状态",
    object: "是活人",
    validFrom: 1,
    source: "chapter-1",
    ...overrides,
  }
}

describe("runFactCheck — temporal consistency alias matching (CORR-004)", () => {
  it("matches alias '昴' against canonical '菜月昴' when aliasMap is provided", async () => {
    // Temporal fact authored at ch1: 菜月昴 is alive (canonical subject).
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "fact-ch1-0", subject: "菜月昴", object: "是活人", validFrom: 1 }),
    ]
    // Snapshot at ch5 authors a new canon fact using the ALIAS "昴" that
    // contradicts the still-valid alive fact (negation "不再" vs affirmation "是").
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["昴：不再是活人"]),
    ]
    const aliasMap = buildNameAliasMap("菜月昴", ["昴"])

    const report = await runFactCheck(snapshots, { temporalFacts, aliasMap })

    // The temporal pass must surface the contradiction: alias "昴" matches
    // canonical "菜月昴" via the alias map, the alive fact is still valid at
    // ch5, and "不再" negates "是". Without aliasMap this was a false negative.
    const temporalFindings = report.results.filter((r) => r.temporalFactId === "fact-ch1-0")
    expect(temporalFindings.length).toBeGreaterThanOrEqual(1)
    const finding = temporalFindings[0] as FactCheckResult
    expect(finding.type).toBe("setting_conflict")
    expect(finding.severity).toBe("high")
    expect(finding.chapters).toEqual([1, 5])
  })

  it("returns no temporal finding without aliasMap when alias != canonical (legacy false-negative preserved)", async () => {
    // Same facts as above, but NO aliasMap. "昴" does not NFKC-fold to
    // "菜月昴", so the subject filter does not match → no temporal finding.
    // This documents the pre-CORR-004 behavior (false negative) and proves
    // the aliasMap option is additive: absent → legacy NFKC-only path.
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "fact-ch1-0", subject: "菜月昴", object: "是活人", validFrom: 1 }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["昴：不再是活人"]),
    ]

    const report = await runFactCheck(snapshots, { temporalFacts })

    const temporalFindings = report.results.filter((r) => r.temporalFactId === "fact-ch1-0")
    expect(temporalFindings).toEqual([])
  })

  it("aliasMap=undefined preserves legacy rule-engine behavior (no temporal pass without temporalFacts)", async () => {
    // No temporalFacts → temporal pass never runs, regardless of aliasMap.
    // Confirms backward compatibility: existing callers passing no options
    // are unaffected.
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：不再是活人"]),
    ]

    const report = await runFactCheck(snapshots)

    // Rule engine's checkSettingConflict may still fire, but NO finding
    // carries a temporalFactId (the temporal pass did not run).
    const temporalFindings = report.results.filter((r) => r.temporalFactId !== undefined)
    expect(temporalFindings).toEqual([])
  })
})
