import { describe, expect, it } from "vitest"
import { canPromoteFactToGraph, createFactRecord, type FactRecord } from "./fact-model"

describe("createFactRecord", () => {
  it("fills defaults for an empty partial", () => {
    const fact = createFactRecord({})
    expect(fact).toEqual({
      fact_id: "fact:test",
      fact_type: "event",
      subject_id: "entity:test",
      predicate: "does",
      object_id_or_value: "value:test",
      time_scope: "chapter",
      chapter_ref: "ch-1@v1",
      evidence_anchor: "p1:s1",
      confidence: 0.8,
      canon_status: "candidate",
    })
  })

  it("respects provided fields", () => {
    const fact = createFactRecord({
      fact_id: "fact-42",
      fact_type: "character",
      subject_id: "entity:su",
      predicate: "持有",
      object_id_or_value: "轩辕剑",
      time_scope: "ch3",
      chapter_ref: "ch-3@v1",
      evidence_anchor: "p12:s3",
      confidence: 0.95,
      canon_status: "verified",
    })
    expect(fact.fact_id).toBe("fact-42")
    expect(fact.fact_type).toBe("character")
    expect(fact.subject_id).toBe("entity:su")
    expect(fact.predicate).toBe("持有")
    expect(fact.object_id_or_value).toBe("轩辕剑")
    expect(fact.time_scope).toBe("ch3")
    expect(fact.chapter_ref).toBe("ch-3@v1")
    expect(fact.evidence_anchor).toBe("p12:s3")
    expect(fact.confidence).toBe(0.95)
    expect(fact.canon_status).toBe("verified")
  })

  it("accepts partial field overrides without touching others", () => {
    const fact = createFactRecord({ fact_id: "fact-1", confidence: 0 })
    expect(fact).toMatchObject({ fact_id: "fact-1", confidence: 0 })
    expect(fact.canon_status).toBe("candidate")
    expect(fact.fact_type).toBe("event")
  })
})

describe("canPromoteFactToGraph", () => {
  it("returns true only for verified facts", () => {
    const base: FactRecord = createFactRecord({})
    expect(canPromoteFactToGraph({ ...base, canon_status: "verified" })).toBe(true)
    expect(canPromoteFactToGraph({ ...base, canon_status: "candidate" })).toBe(false)
    expect(canPromoteFactToGraph({ ...base, canon_status: "rejected" })).toBe(false)
    expect(canPromoteFactToGraph({ ...base, canon_status: "pending_review" })).toBe(false)
  })
})
