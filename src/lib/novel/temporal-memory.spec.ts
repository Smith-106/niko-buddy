import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"
import {
  factsFromCommittedSnapshots,
  fromCanonGraph,
  getFactsAt,
  invalidateFact,
  queryFactsAt,
  recordSupersession,
  renderTemporalCanonBlock,
  rerankActiveEntitiesByTemporalFacts,
  resolveNegation,
  type TemporalFact,
} from "./temporal-memory"
import type { CanonFact } from "./canon-graph-client"
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

  // ── A/D 落点①：belief 认知标记 + former/retcon 溯源标记 ──
  it("A/D: belief 模态渲染「X 认为…」认知标记（非事实陈述）", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "b", validFrom: 1, subject: "主角", predicate: "持有", object: "轩辕剑", modality: "belief" }),
    ]
    const block = renderTemporalCanonBlock(2, facts)
    expect(block).toContain("主角认为")
    expect(block).toContain("持有 轩辕剑")
    expect(block).toContain("[第1章起]")
  })

  it("A/D: former 带溯源标记（recordedRevision → 第N版修订前成立）", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "f", validFrom: 1, subject: "主角", predicate: "是", object: "凡人", former: true, recordedRevision: 2 }),
    ]
    // validUntil 未设 → 在 ch2 仍 active（former 标记由 includeInvalidated 路径产生，此处仅验溯源标记渲染）
    const block = renderTemporalCanonBlock(2, facts)
    expect(block).toContain("第2版修订前成立")
  })

  it("A/D: retconned 模态渲染溯源标记（无 recordedRevision 用空戳）", () => {
    const facts: TemporalFact[] = [
      makeFact({ id: "r", validFrom: 1, subject: "主角", predicate: "是", object: "凡人", modality: "retconned" }),
    ]
    const block = renderTemporalCanonBlock(2, facts)
    expect(block).toContain("修订前成立")
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


// ════════════════════════════════════════════════════════════════════════════
// T25 (A-04.4/F-13): fromCanonGraph — canon 图投影 → TemporalFact 视图转换
// （默认仍走 factsFromCommittedSnapshots 折叠，本视图仅在迁移态 ≥ dual 使用）
// ════════════════════════════════════════════════════════════════════════════

function makeCanonFact(overrides: Partial<CanonFact> & { id: string }): CanonFact {
  return {
    sourceId: "主角",
    targetId: "轩辕剑",
    predicate: "OWNS",
    edgeKind: "world_fact",
    archived: false,
    ...overrides,
  }
}

describe("fromCanonGraph (T25)", () => {
  it("maps projected CanonFact fields onto the TemporalFact window model", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "e1", validAt: 3, invalidAt: 9, confidence: 0.9 }),
    ])
    expect(facts).toEqual([
      {
        id: "e1",
        subject: "主角",
        predicate: "OWNS",
        object: "轩辕剑",
        validFrom: 3,
        validUntil: 9,
        source: "canon-graph:e1",
        confidence: 0.9,
      },
    ])
  })

  it("falls back validFrom to sourceChapter then 0, and drops absent windows", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "e2", sourceChapter: 5 }),
      makeCanonFact({ id: "e3" }),
    ])
    const byId = new Map(facts.map((f) => [f.id, f]))
    const bySourceChapter = byId.get("e2")!
    const timeless = byId.get("e3")!
    expect(bySourceChapter.validFrom).toBe(5)
    expect(bySourceChapter.validUntil).toBeUndefined()
    expect(bySourceChapter.confidence).toBeUndefined()
    // 无任何时态锚点 → 从第 0 章起恒真（保守）。
    expect(timeless.validFrom).toBe(0)
    expect(timeless.validUntil).toBeUndefined()
  })

  it("skips archived edges and dedupes repeated ids", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "e1" }),
      makeCanonFact({ id: "e1", predicate: "AT" }), // 同 id 去重
      makeCanonFact({ id: "e2", archived: true }), // 归档边非权威
      makeCanonFact({ id: "e3" }),
    ])
    expect(facts.map((f) => f.id)).toEqual(["e1", "e3"])
  })

  it("folds the subject through the alias map (same semantics as the fold path)", () => {
    const facts = fromCanonGraph(
      [makeCanonFact({ id: "e1", sourceId: "小白" })],
      { canonical: "白砚", aliases: ["小白"] },
    )
    expect(facts[0]!.subject).toBe("白砚")
  })

  it("sorts output by (validFrom, id) regardless of input order — deterministic view", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "b2", validAt: 4 }),
      makeCanonFact({ id: "a9", validAt: 1 }),
      makeCanonFact({ id: "a1", validAt: 1 }),
    ])
    expect(facts.map((f) => f.id)).toEqual(["a1", "a9", "b2"])
  })

  it("stays a pure VIEW: output feeds getFactsAt / renderTemporalCanonBlock unchanged", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "e-live", validAt: 1 }),
      makeCanonFact({ id: "e-dead", targetId: "凌霄殿", validAt: 2, invalidAt: 5 }),
    ])
    // 第 6 章有效事实：live 在、dead 已关闭 —— 与 fold 路径同款时态查询语义。
    expect(getFactsAt(6, undefined, facts).map((f) => f.id)).toEqual(["e-live"])
    const block = renderTemporalCanonBlock(6, facts)
    expect(block).toContain("[第1章起] 主角：OWNS 轩辕剑")
    expect(block).not.toContain("凌霄殿")
  })

  // ── C (方案 X / include_invalidated)：former 打标 —— P0 护栏回归保护 ──
  it("C: includeInvalidated=true 时 invalidAt<=chapter 的边保留并打 former:true（曾以为召回）", () => {
    const facts = fromCanonGraph(
      [
        makeCanonFact({ id: "e-live", validAt: 1 }),
        makeCanonFact({ id: "e-dead", targetId: "凌霄殿", validAt: 2, invalidAt: 5 }),
      ],
      undefined,
      { chapter: 6, includeInvalidated: true },
    )
    const byId = new Map(facts.map((f) => [f.id, f]))
    expect(facts).toHaveLength(2) // 两条都保留（include_invalidated 召回已失效窗口）
    expect(byId.get("e-live")!.former).toBeUndefined() // 仍有效（无 invalidAt）→ 不打标
    expect(byId.get("e-dead")!.former).toBe(true) // invalidAt 5 <= 6 → former
  })

  it("C: 缺省 opts 时 former 恒 undefined（旧行为字节级不变）", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "e-dead", validAt: 2, invalidAt: 5 }),
    ])
    expect(facts[0]!.former).toBeUndefined()
  })

  it("C: includeInvalidated=true 但 invalidAt>chapter（仍有效）→ 不打 former 标记", () => {
    const facts = fromCanonGraph(
      [makeCanonFact({ id: "e-open", targetId: "凌霄殿", validAt: 2, invalidAt: 10 })],
      undefined,
      { chapter: 6, includeInvalidated: true },
    )
    expect(facts[0]!.former).toBeUndefined() // invalidAt 10 > 6 → 仍有效，非 former
  })

  // ── A/D: recordedRevision + modality 透传（落点①/消费链闭环）──
  it("A/D: 透传 recordedRevision 与 modality（canon 边新字段经 fromCanonGraph 入 TemporalFact）", () => {
    const facts = fromCanonGraph([
      makeCanonFact({ id: "e-belief", recordedRevision: 4, modality: "belief" }),
      makeCanonFact({ id: "e-assert", recordedRevision: 7, modality: "assertive" }),
    ])
    const byId = new Map(facts.map((f) => [f.id, f]))
    expect(byId.get("e-belief")!.modality).toBe("belief")
    expect(byId.get("e-belief")!.recordedRevision).toBe(4)
    expect(byId.get("e-assert")!.modality).toBe("assertive")
    expect(byId.get("e-assert")!.recordedRevision).toBe(7)
  })
})
