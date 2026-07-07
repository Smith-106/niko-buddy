import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"
import {
  factsFromCommittedSnapshots,
  getFactsAt,
  recordSupersession,
  renderTemporalCanonBlock,
  resolveNegation,
  type TemporalFact,
} from "./temporal-memory"

function makeFact(overrides: Partial<TemporalFact> & { id: string }): TemporalFact {
  return {
    subject: "主角",
    predicate: "是",
    object: "凡人",
    validFrom: 1,
    source: "chapter-1",
    ...overrides,
  }
}

describe("getFactsAt", () => {
  it("returns facts whose validFrom<=chapter and validUntil unset or >chapter", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", validFrom: 1 }),
      makeFact({ id: "b", validFrom: 3, subject: "配角" }),
      makeFact({ id: "c", validFrom: 2, validUntil: 4 }),
      makeFact({ id: "d", validFrom: 6 }),
    ]
    const at5 = getFactsAt(5, undefined, facts)
    const ids = at5.map((f) => f.id).sort()
    expect(ids).toEqual(["a", "b"])
  })

  it("excludes facts that have not yet become valid", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", validFrom: 1 }),
      makeFact({ id: "b", validFrom: 10 }),
    ]
    const at5 = getFactsAt(5, undefined, facts)
    expect(at5.map((f) => f.id)).toEqual(["a"])
  })

  it("filters by canonical subject", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", subject: "林云", validFrom: 1 }),
      makeFact({ id: "b", subject: "赵雪", validFrom: 1 }),
    ]
    const at5 = getFactsAt(5, "林云", facts)
    expect(at5.map((f) => f.id)).toEqual(["a"])
  })

  it("treats a fact with validUntil equal to chapter as no longer current", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", validFrom: 1, validUntil: 5 }),
    ]
    const at5 = getFactsAt(5, undefined, facts)
    expect(at5).toEqual([])
  })
})

describe("recordSupersession", () => {
  it("closes the old fact validUntil at the new fact validFrom and links the chain", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1 }),
      makeFact({ id: "new", validFrom: 5 }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    expect(facts[0]!.validUntil).toBe(5)
    expect(facts[1]!.supersedes).toEqual(["old"])
  })

  it("does not reopen an already-closed earlier window", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1, validUntil: 3 }),
      makeFact({ id: "new", validFrom: 5 }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    // validUntil stays at 3 (earlier close), new.supersedes still links.
    expect(facts[0]!.validUntil).toBe(3)
    expect(facts[1]!.supersedes).toEqual(["old"])
  })

  it("is a no-op when the old fact id is missing", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 1 })]
    recordSupersession(makeFact({ id: "b", validFrom: 5 }), "missing", facts)
    expect(facts[0]!.validUntil).toBeUndefined()
  })
})

describe("resolveNegation", () => {
  it("closes the negated fact and returns a NegationPair", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "negated", subject: "主角", object: "凡人", validFrom: 1 }),
      makeFact({ id: "negating", subject: "主角", object: "非凡人", validFrom: 4 }),
    ]
    const pair = resolveNegation(facts[1]!, "negated", facts, "narration contradiction")
    expect(pair).not.toBeNull()
    expect(pair!.negatingId).toBe("negating")
    expect(pair!.negatedId).toBe("negated")
    expect(pair!.resolvedAt).toBe(4)
    expect(pair!.note).toBe("narration contradiction")
    expect(facts[0]!.validUntil).toBe(4)
  })

  it("returns null when the negated fact id is missing", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 1 })]
    const pair = resolveNegation(makeFact({ id: "b", validFrom: 3 }), "missing", facts)
    expect(pair).toBeNull()
  })
})

describe("factsFromCommittedSnapshots", () => {
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
    }
  }

  it("folds newCanonFacts into TemporalFact[] with validFrom=chapterNumber", () => {
    const snapshots = [
      makeSnapshot(1, ["主角：凡人"]),
      makeSnapshot(3, ["主角：剑修"]),
    ]
    const facts = factsFromCommittedSnapshots(snapshots, undefined)
    expect(facts).toHaveLength(2)
    expect(facts[0]!.validFrom).toBe(1)
    expect(facts[0]!.subject).toBe("主角")
    expect(facts[0]!.object).toBe("凡人")
    expect(facts[1]!.validFrom).toBe(3)
    expect(facts[1]!.id).toContain("ch3")
  })

  it("skips snapshots whose snapshot projection is marked failed in the ledger", () => {
    const snapshots = [
      makeSnapshot(1, ["主角：凡人"]),
      makeSnapshot(2, ["主角：失踪"]),
    ]
    const ledger: ProjectionStatusLedger = {
      projections: { snapshot: "single_snapshot_idempotent" },
      chapters: {
        "2": {
          snapshot: {
            projection: "snapshot",
            category: "single_snapshot_idempotent",
            status: "failed",
            updated_at: "2026-01-01T00:00:00.000Z",
            last_error: "boom",
          },
        },
      },
    }
    const facts = factsFromCommittedSnapshots(snapshots, ledger)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.validFrom).toBe(1)
  })
})

describe("renderTemporalCanonBlock", () => {
  it("returns empty string when no facts are active", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 10 })]
    expect(renderTemporalCanonBlock(5, facts)).toBe("")
  })

  it("renders a protected-tier canon block with valid facts", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", validFrom: 1, subject: "主角", predicate: "是", object: "凡人" }),
      makeFact({ id: "b", validFrom: 3, validUntil: 5, subject: "配角", predicate: "位于", object: "凌霄殿" }),
    ]
    const block = renderTemporalCanonBlock(4, facts)
    expect(block).toContain("时序事实")
    expect(block).toContain("主角")
    expect(block).toContain("凡人")
    // 配角 fact (validUntil=5) is current at chapter 4, so included.
    expect(block).toContain("配角")
    // Already closed at 5? validUntil=5 > 4, so still included.
  })

  it("excludes superseded facts via getFactsAt", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1, subject: "主角", object: "凡人" }),
      makeFact({ id: "new", validFrom: 3, subject: "主角", object: "剑修" }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    const block = renderTemporalCanonBlock(4, facts)
    expect(block).toContain("剑修")
    expect(block).not.toContain("凡人")
  })
})
