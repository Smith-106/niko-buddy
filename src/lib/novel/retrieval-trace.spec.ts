import { describe, expect, it } from "vitest"
import {
  auditRetrievalTraces,
  createRetrievalTrace,
  markHitUsed,
  type RetrievalTraceEntry,
} from "./retrieval-trace"

function trace(id: string, hits: Array<{ sourceId: string; score: number }>): RetrievalTraceEntry {
  return createRetrievalTrace({
    traceId: id,
    chapter: 5,
    query: "主角动机",
    channel: "hybrid",
    hits: hits.map((h) => ({ ...h, sourceType: "memory" as const })),
    latencyMs: 12,
  })
}

describe("retrieval-trace（吸收累积残余：RAG 检索追踪审计模式）", () => {
  it("createRetrievalTrace：hits 初始 used=false；留痕字段齐备", () => {
    const t = trace("t1", [{ sourceId: "m1", score: 0.9 }])
    expect(t.hits[0]).toMatchObject({ sourceId: "m1", score: 0.9, used: false })
    expect(t.query).toBe("主角动机")
    expect(t.recordedAt).toBeTruthy()
  })

  it("markHitUsed：定位标记采用（纯函数不改输入）", () => {
    const t = trace("t1", [{ sourceId: "m1", score: 0.9 }, { sourceId: "m2", score: 0.5 }])
    const marked = markHitUsed([t], "t1", "m1")
    expect(marked[0].hits[0].used).toBe(true)
    expect(marked[0].hits[1].used).toBe(false)
    expect(t.hits[0].used).toBe(false)
  })

  it("auditRetrievalTraces：采用率与低分采用信号", () => {
    const traces = [
      trace("t1", [{ sourceId: "m1", score: 0.9 }, { sourceId: "m2", score: 0.3 }]),
      trace("t2", [{ sourceId: "m3", score: 0.8 }]),
    ]
    // 中位分 0.8（全体 [0.3,0.8,0.9]）；采用 m1(0.9 高分) 与 m2(0.3 低分) → lowScoreUsed=1
    let staged = markHitUsed(traces, "t1", "m1")
    staged = markHitUsed(staged, "t1", "m2")
    const audit = auditRetrievalTraces(staged)
    expect(audit.totalTraces).toBe(2)
    expect(audit.totalHits).toBe(3)
    expect(audit.usedHits).toBe(2)
    expect(audit.hitUtilization).toBeCloseTo(2 / 3)
    expect(audit.lowScoreUsed).toBe(1)
  })

  it("空输入安全：零命中率/零低分", () => {
    expect(auditRetrievalTraces([])).toEqual({
      totalTraces: 0,
      totalHits: 0,
      usedHits: 0,
      hitUtilization: 0,
      lowScoreUsed: 0,
    })
  })

  it("确定性：同输入双跑全等", () => {
    const traces = markHitUsed([trace("t1", [{ sourceId: "m1", score: 0.9 }])], "t1", "m1")
    expect(JSON.stringify(auditRetrievalTraces(traces))).toBe(JSON.stringify(auditRetrievalTraces(traces)))
  })
})
