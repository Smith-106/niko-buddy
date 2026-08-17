import { describe, expect, it } from "vitest"
import { applyMemoryOp, applyMemoryOps, classifyMemoryAtomKind, planAddOpsFromCanonFacts } from "./memory-op"
import { queryFactsAt, type TemporalFact } from "./temporal-memory"

describe("memory-op", () => {
  it("ADD then queryFactsAt sees fact; DELETE invalidates", () => {
    const facts: TemporalFact[] = []
    const add = applyMemoryOp(facts, {
      kind: "ADD",
      fact: {
        subject: "白昼",
        predicate: "持有",
        object: "戒指",
        validFrom: 1,
        source: "chapter-1",
      },
    })
    expect(add.ok).toBe(true)
    expect(facts).toHaveLength(1)
    expect(queryFactsAt(2, "白昼", facts)).toHaveLength(1)

    const del = applyMemoryOp(facts, {
      kind: "DELETE",
      factId: add.factId,
      atChapter: 3,
    })
    expect(del.ok).toBe(true)
    expect(queryFactsAt(3, "白昼", facts)).toHaveLength(0)
    expect(queryFactsAt(2, "白昼", facts)).toHaveLength(1)
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
    const ops = planAddOpsFromCanonFacts(4, ["白昼：持有线索", "无窗会议室"])
    expect(ops).toHaveLength(2)
    const facts: TemporalFact[] = []
    const results = applyMemoryOps(facts, ops)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(facts).toHaveLength(2)
  })

  it("classifies L1 atom kinds on planAddOpsFromCanonFacts (S3)", () => {
    const ops = planAddOpsFromCanonFacts(5, [
      "白昼：持有戒指",
      "禁止：时间旅行",
      "码头决战爆发",
    ])
    expect(ops[0]!.atomKind).toBe("inventory")
    expect(ops[0]!.fact?.predicate).toBe("inventory")
    expect(ops[1]!.atomKind).toBe("constraint")
    expect(ops[2]!.atomKind).toBe("event")
    expect(ops.every((o) => o.note?.includes("atomKind"))).toBe(true)
  })

  it("classifyMemoryAtomKind covers preference / setting / relationship / state / other", () => {
    expect(classifyMemoryAtomKind("他偏好隐藏实力")).toBe("preference")
    expect(classifyMemoryAtomKind("本作世界观法则：灵气复苏")).toBe("setting")
    expect(classifyMemoryAtomKind("林晚与阿宁是师徒关系")).toBe("relationship")
    expect(classifyMemoryAtomKind("林晚陷入昏迷状态")).toBe("state")
    expect(classifyMemoryAtomKind("无分类的普通句子")).toBe("other")
    // 无 subject / object 时走 nullish 拼接分支
    expect(classifyMemoryAtomKind("装备", undefined, undefined)).toBe("inventory")
    expect(classifyMemoryAtomKind("禁止", undefined, undefined)).toBe("constraint")
  })

  it("applyMemoryOp error paths: ADD without fact / duplicate id / explicit id", () => {
    const facts: TemporalFact[] = []
    const noFact = applyMemoryOp(facts, { kind: "ADD" })
    expect(noFact.ok).toBe(false)
    expect(noFact.note).toContain("ADD requires fact payload")

    const add = applyMemoryOp(facts, {
      kind: "ADD",
      factId: "explicit-id",
      fact: { subject: "A", predicate: "是", object: "B", validFrom: 1, source: "t" },
    })
    expect(add.ok).toBe(true)
    expect(add.factId).toBe("explicit-id")
    expect(facts[0]!.id).toBe("explicit-id")

    const dup = applyMemoryOp(facts, {
      kind: "ADD",
      factId: "explicit-id",
      fact: { subject: "C", predicate: "是", object: "D", validFrom: 2, source: "t" },
    })
    expect(dup.ok).toBe(false)
    expect(dup.note).toContain("id already exists")

    const viaFactId = applyMemoryOp(facts, {
      kind: "ADD",
      fact: { id: "inner-id", subject: "E", predicate: "是", object: "F", validFrom: 3, source: "t" },
    })
    expect(viaFactId.ok).toBe(true)
    expect(viaFactId.factId).toBe("inner-id")
    expect(facts).toHaveLength(2)
  })

  it("applyMemoryOp NOOP without note uses 'noop' default", () => {
    const n = applyMemoryOp([], { kind: "NOOP" })
    expect(n.ok).toBe(true)
    expect(n.note).toBe("noop")
  })

  it("applyMemoryOp UPDATE error paths and partial field updates", () => {
    const facts: TemporalFact[] = [
      { id: "f1", subject: "A", predicate: "是", object: "旧", validFrom: 1, source: "t", confidence: 0.5 },
    ]
    const noId = applyMemoryOp(facts, { kind: "UPDATE", fact: { subject: "A" } as never })
    expect(noId.ok).toBe(false)
    expect(noId.note).toContain("UPDATE requires factId")

    const missing = applyMemoryOp(facts, { kind: "UPDATE", factId: "ghost" })
    expect(missing.ok).toBe(false)
    expect(missing.note).toContain("UPDATE target missing")

    const noFact = applyMemoryOp(facts, { kind: "UPDATE", factId: "f1" })
    expect(noFact.ok).toBe(true)

    const partial = applyMemoryOp(facts, {
      kind: "UPDATE",
      factId: "f1",
      fact: { subject: "A2", predicate: "拥有", confidence: 0.9 } as never,
    })
    expect(partial.ok).toBe(true)
    expect(facts[0]!.subject).toBe("A2")
    expect(facts[0]!.predicate).toBe("拥有")
    expect(facts[0]!.confidence).toBe(0.9)
    expect(facts[0]!.object).toBe("旧")

    // 仅提供部分字段：缺失的 subject/predicate 走 !== undefined 的 else 分支 → 原值保留
    const partialMissingFields = applyMemoryOp(facts, {
      kind: "UPDATE",
      factId: "f1",
      fact: { object: "再改", confidence: 0.4 } as never,
    })
    expect(partialMissingFields.ok).toBe(true)
    expect(facts[0]!.object).toBe("再改")
    expect(facts[0]!.subject).toBe("A2")
    expect(facts[0]!.predicate).toBe("拥有")
    expect(facts[0]!.confidence).toBe(0.4)
  })

  it("applyMemoryOp DELETE error paths and atChapter fallbacks", () => {
    const facts: TemporalFact[] = [
      { id: "f1", subject: "A", predicate: "是", object: "B", validFrom: 1, source: "t" },
    ]
    const noId = applyMemoryOp(facts, { kind: "DELETE" })
    expect(noId.ok).toBe(false)
    expect(noId.note).toContain("DELETE requires factId")

    const missing = applyMemoryOp(facts, { kind: "DELETE", factId: "ghost" })
    expect(missing.ok).toBe(false)

    // atChapter 缺省 → 走 op.fact?.validFrom
    const viaFactValidFrom = applyMemoryOp(facts, {
      kind: "DELETE",
      factId: "f1",
      fact: { validFrom: 2 } as never,
    })
    expect(viaFactValidFrom.ok).toBe(true)
    expect(facts[0]!.validUntil).toBe(2)
  })

  it("applyMemoryOp unknown kind hits default case", () => {
    const r = applyMemoryOp([], { kind: "WEIRD" as never })
    expect(r.ok).toBe(false)
    expect(r.note).toContain("unknown kind")
  })

  it("applyMemoryOps with empty ops returns empty results", () => {
    expect(applyMemoryOps([], [])).toEqual([])
  })

  it("planAddOpsFromCanonFacts tolerates undefined input and undefined entries", () => {
    const empty = planAddOpsFromCanonFacts(6, undefined as never)
    expect(empty).toEqual([])

    const withUndefined = planAddOpsFromCanonFacts(7, [undefined, null] as never)
    expect(withUndefined).toHaveLength(2)
    expect(withUndefined[0]!.fact?.subject).toBe("canon")
    expect(withUndefined[0]!.fact?.object).toBe("")
    expect(withUndefined[0]!.atomKind).toBe("other")
    expect(withUndefined[0]!.fact?.predicate).toBe("陈述")
  })

  it("planAddOpsFromCanonFacts free-text without colon bags under canon subject", () => {
    const ops = planAddOpsFromCanonFacts(8, ["纯自由文本", "林晚："])
    expect(ops[0]!.fact?.subject).toBe("canon")
    expect(ops[0]!.fact?.object).toBe("纯自由文本")
    // 冒号后无内容 → 整体按自由文本处理
    expect(ops[1]!.fact?.subject).toBe("canon")
  })
})
