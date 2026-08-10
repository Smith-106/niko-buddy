import { describe, expect, it } from "vitest"
import { applyMemoryOp, applyMemoryOps, planAddOpsFromCanonFacts } from "./memory-op"
import { queryFactsAt, type TemporalFact } from "./temporal-memory"

describe("memory-op", () => {
  it("ADD then queryFactsAt sees fact; DELETE invalidates", () => {
    const facts: TemporalFact[] = []
    const add = applyMemoryOp(facts, {
      kind: "ADD",
      fact: {
        subject: "白砚",
        predicate: "持有",
        object: "戒指",
        validFrom: 1,
        source: "chapter-1",
      },
    })
    expect(add.ok).toBe(true)
    expect(facts).toHaveLength(1)
    expect(queryFactsAt(2, "白砚", facts)).toHaveLength(1)

    const del = applyMemoryOp(facts, {
      kind: "DELETE",
      factId: add.factId,
      atChapter: 3,
    })
    expect(del.ok).toBe(true)
    expect(queryFactsAt(3, "白砚", facts)).toHaveLength(0)
    expect(queryFactsAt(2, "白砚", facts)).toHaveLength(1)
  })

  it("UPDATE mutates object; NOOP always ok; productHardGate false", () => {
    const facts: TemporalFact[] = [
      {
        id: "f1",
        subject: "A",
        predicate: "是",
        object: "旧",
        validFrom: 1,
        source: "t",
      },
    ]
    const u = applyMemoryOp(facts, {
      kind: "UPDATE",
      factId: "f1",
      fact: {
        subject: "A",
        predicate: "是",
        object: "新",
        validFrom: 1,
        source: "t",
      },
    })
    expect(u.ok).toBe(true)
    expect(facts[0]!.object).toBe("新")
    const n = applyMemoryOp(facts, { kind: "NOOP", note: "skip" })
    expect(n.ok).toBe(true)
    expect(n.productHardGate).toBe(false)
  })

  it("planAddOpsFromCanonFacts + batch apply", () => {
    const ops = planAddOpsFromCanonFacts(4, ["白砚：持有线索", "无窗会议室"])
    expect(ops).toHaveLength(2)
    const facts: TemporalFact[] = []
    const results = applyMemoryOps(facts, ops)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(facts).toHaveLength(2)
  })
})
