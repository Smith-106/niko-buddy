import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"
import {
  factsFromCommittedSnapshots,
  getFactsAt,
  invalidateFact,
  queryFactsAt,
  recordSupersession,
  renderTemporalCanonBlock,
  rerankActiveEntitiesByTemporalFacts,
  resolveNegation,
  type TemporalFact,
} from "./temporal-memory"
import type { ContextEntity } from "./context-engine"

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

  it("folds alias names through the alias map", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", subject: "白砚", validFrom: 1 }),
      makeFact({ id: "b", subject: "苏未晞", validFrom: 1 }),
    ]
    const at5 = getFactsAt(5, "小白", facts, {
      canonical: "白砚",
      aliases: ["小白"],
    })
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

  it("narrows validUntil to the smallest validFrom across calls (ch7 then ch3)", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1 }),
      makeFact({ id: "new7", validFrom: 7 }),
      makeFact({ id: "new3", validFrom: 3 }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    expect(facts[0]!.validUntil).toBe(7)
    recordSupersession(facts[2]!, "old", facts)
    // Monotonic: 3 < 7 → narrows to 3 (never widens back to 7).
    expect(facts[0]!.validUntil).toBe(3)
  })

  it("is order-independent (ch3 then ch7 yields same validUntil=3)", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1 }),
      makeFact({ id: "new3", validFrom: 3 }),
      makeFact({ id: "new7", validFrom: 7 }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    expect(facts[0]!.validUntil).toBe(3)
    recordSupersession(facts[2]!, "old", facts)
    // 7 < 3 is false → no widening; validUntil stays at 3.
    expect(facts[0]!.validUntil).toBe(3)
  })

  it("reuses an existing supersedes array on the new fact", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1 }),
      makeFact({ id: "new", validFrom: 5, supersedes: ["earlier"] }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    expect(facts[1]!.supersedes).toEqual(["earlier", "old"])
  })

  it("does not duplicate an old fact id already in the supersedes chain", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "old", validFrom: 1 }),
      makeFact({ id: "new", validFrom: 5, supersedes: ["old"] }),
    ]
    recordSupersession(facts[1]!, "old", facts)
    expect(facts[1]!.supersedes).toEqual(["old"])
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

  it("narrows validUntil to the smallest validFrom across calls (ch7 then ch3)", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "negated", subject: "主角", object: "凡人", validFrom: 1 }),
      makeFact({ id: "neg7", subject: "主角", object: "非凡人", validFrom: 7 }),
      makeFact({ id: "neg3", subject: "主角", object: "非凡人", validFrom: 3 }),
    ]
    resolveNegation(facts[1]!, "negated", facts)
    expect(facts[0]!.validUntil).toBe(7)
    resolveNegation(facts[2]!, "negated", facts)
    // Monotonic: 3 < 7 → narrows to 3.
    expect(facts[0]!.validUntil).toBe(3)
  })

  it("is order-independent (ch3 then ch7 yields same validUntil=3)", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "negated", subject: "主角", object: "凡人", validFrom: 1 }),
      makeFact({ id: "neg3", subject: "主角", object: "非凡人", validFrom: 3 }),
      makeFact({ id: "neg7", subject: "主角", object: "非凡人", validFrom: 7 }),
    ]
    resolveNegation(facts[1]!, "negated", facts)
    expect(facts[0]!.validUntil).toBe(3)
    resolveNegation(facts[2]!, "negated", facts)
    // 7 < 3 is false → no widening; validUntil stays at 3.
    expect(facts[0]!.validUntil).toBe(3)
  })
})

describe("recordSupersession + resolveNegation cross-function order-independence", () => {
  it("mix: recordSupersession(@ch7) then resolveNegation(@ch3) settles validUntil=3", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "target", subject: "主角", object: "凡人", validFrom: 1 }),
      makeFact({ id: "sup7", subject: "主角", object: "剑修", validFrom: 7 }),
      makeFact({ id: "neg3", subject: "主角", object: "非凡人", validFrom: 3 }),
    ]
    recordSupersession(facts[1]!, "target", facts)
    expect(facts[0]!.validUntil).toBe(7)
    resolveNegation(facts[2]!, "target", facts)
    // resolveNegation @ch3 narrows 7 → 3 (monotonic, never widens).
    expect(facts[0]!.validUntil).toBe(3)
  })

  it("mix reverse: resolveNegation(@ch7) then recordSupersession(@ch3) settles validUntil=3", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "target", subject: "主角", object: "凡人", validFrom: 1 }),
      makeFact({ id: "sup3", subject: "主角", object: "剑修", validFrom: 3 }),
      makeFact({ id: "neg7", subject: "主角", object: "非凡人", validFrom: 7 }),
    ]
    resolveNegation(facts[2]!, "target", facts)
    expect(facts[0]!.validUntil).toBe(7)
    recordSupersession(facts[1]!, "target", facts)
    // recordSupersession @ch3 narrows 7 → 3 (monotonic, never widens).
    expect(facts[0]!.validUntil).toBe(3)
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

  it("renders facts without an object as subject-only lines", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "a", validFrom: 1, subject: "主角", predicate: "", object: "" }),
    ]
    const block = renderTemporalCanonBlock(2, facts)
    expect(block).toContain("- [第1章起] 主角")
    expect(block).not.toContain("：")
  })
})

describe("rerankActiveEntitiesByTemporalFacts", () => {
  function makeEntity(name: string, tags?: string[]): ContextEntity {
    return { entityId: `id-${name}`, name, type: "character", tags }
  }

  const facts: TemporalFact[] = [
    makeFact({ id: "f1", subject: "白砚", validFrom: 1 }),
    makeFact({ id: "f2", subject: "苏未晞", validFrom: 2 }),
  ]

  it("returns the original array when temporalFacts is null", () => {
    const entities = [makeEntity("白砚")]
    expect(rerankActiveEntitiesByTemporalFacts(entities, null, 5)).toBe(entities)
  })

  it("returns the original array when activeEntities is empty", () => {
    expect(rerankActiveEntitiesByTemporalFacts([], facts, 5)).toEqual([])
  })

  it("boosts fact-matching entities to rank 0 and keeps others stable", () => {
    const entities = [
      makeEntity("苏未晞", ["relevance:low"]),
      makeEntity("路人甲"),
      makeEntity("白砚", ["relevance:high"]),
    ]
    const reranked = rerankActiveEntitiesByTemporalFacts(entities, facts, 3)
    // 苏未晞 (hit + low) boosted to rank 0 and keeps original index; 白砚 (hit +
    // already rank 0) stays; 路人甲 (no hit, rank 1) stays last
    expect(reranked.map((e) => e.name)).toEqual(["苏未晞", "白砚", "路人甲"])
  })

  it("keeps non-matching rank-2 entities below boosted ones", () => {
    const entities = [
      makeEntity("路人乙", ["relevance:low"]),
      makeEntity("白砚"),
    ]
    const reranked = rerankActiveEntitiesByTemporalFacts(entities, facts, 3)
    expect(reranked.map((e) => e.name)).toEqual(["白砚", "路人乙"])
  })

  it("treats location:chapter tags as rank 0 without needing a fact hit", () => {
    const entities = [
      makeEntity("守山人", ["location:chapter-3"]),
      makeEntity("白砚", ["relevance:low"]),
    ]
    const reranked = rerankActiveEntitiesByTemporalFacts(entities, facts, 3)
    // 守山人 already rank 0 (location) and no fact hit → stays; 白砚 boosted
    expect(reranked.map((e) => e.name)).toEqual(["守山人", "白砚"])
  })

  it("does not boost entities with no matching facts", () => {
    const entities = [makeEntity("无关者", ["relevance:low"]), makeEntity("白砚")]
    const reranked = rerankActiveEntitiesByTemporalFacts(entities, facts, 3)
    expect(reranked.map((e) => e.name)).toEqual(["白砚", "无关者"])
  })
})

describe("invalidateFact / queryFactsAt", () => {
  it("queryFactsAt aliases getFactsAt", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 1 })]
    expect(queryFactsAt(2, undefined, facts).map((f) => f.id)).toEqual(
      getFactsAt(2, undefined, facts).map((f) => f.id),
    )
  })

  it("invalidates without deleting and excludes from later query", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 1 })]
    const r = invalidateFact(facts, "a", 4, "revoked")
    expect(r.ok).toBe(true)
    expect(facts[0]!.validUntil).toBe(4)
    expect(queryFactsAt(4, undefined, facts)).toEqual([])
    expect(queryFactsAt(3, undefined, facts).map((f) => f.id)).toEqual(["a"])
  })

  it("returns ok=false for missing id", () => {
    expect(invalidateFact([], "missing", 1).ok).toBe(false)
  })

  it("falls back to validFrom when the chapter is not finite", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 3 })]
    const r = invalidateFact(facts, "a", Number.NaN)
    expect(r.ok).toBe(true)
    expect(facts[0]!.validUntil).toBe(3)
  })

  it("does not widen an already-closed validUntil", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 1, validUntil: 2 })]
    invalidateFact(facts, "a", 4)
    expect(facts[0]!.validUntil).toBe(2)
  })

  it("records the note on success", () => {
    const facts: TemporalFact[] = [makeFact({ id: "a", validFrom: 1 })]
    const r = invalidateFact(facts, "a", 4, "soft revoke")
    expect(r).toEqual({ ok: true, note: "soft revoke" })
  })
})

describe("parseCanonFact (via factsFromCommittedSnapshots)", () => {
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

  it("parses the verb form 'subject 是 object'", () => {
    const facts = factsFromCommittedSnapshots([makeSnapshot(2, ["主角 是 剑修"])], undefined)
    expect(facts[0]).toMatchObject({ subject: "主角", predicate: "是", object: "剑修" })
  })

  it("falls back to whole-string subject for separator-less facts", () => {
    const facts = factsFromCommittedSnapshots([makeSnapshot(2, ["场景气氛压抑"])], undefined)
    expect(facts[0]!.subject).toBe("场景气氛压抑")
    expect(facts[0]!.predicate).toBe("")
    expect(facts[0]!.object).toBe("")
  })

  it("skips blank canon-fact strings", () => {
    const facts = factsFromCommittedSnapshots([makeSnapshot(2, ["   "])], undefined)
    expect(facts).toHaveLength(1) // still records one entry with empty subject
    expect(facts[0]!.subject).toBe("")
  })

  it("sorts snapshots by chapter number before folding", () => {
    const facts = factsFromCommittedSnapshots(
      [makeSnapshot(5, ["主角：巅峰"]), makeSnapshot(1, ["主角：凡人"])],
      undefined,
    )
    expect(facts.map((f) => f.validFrom)).toEqual([1, 5])
  })
})
