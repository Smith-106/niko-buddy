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

// ── 波1 检索可解释包（共识计划模块 12） ──────────────────────────────────────

import {
  buildSlotManifest,
  counterfactualReplay,
  computeQueryHash,
  markHitRejection,
} from "./retrieval-trace"

describe("波1 检索可解释包：queryHash / corpusFilter / modelId", () => {
  it("createRetrievalTrace additive 字段透传；旧调用缺省不填（向后兼容）", () => {
    const t = createRetrievalTrace({
      traceId: "t2",
      chapter: 1,
      query: "伏笔回收",
      channel: "hybrid",
      hits: [],
      latencyMs: 5,
      queryHash: computeQueryHash("伏笔回收"),
      modelId: "m1",
      corpusFilter: { authoritativeOnly: true },
    })
    expect(t.queryHash).toBe(computeQueryHash("伏笔回收"))
    expect(t.modelId).toBe("m1")
    expect(t.corpusFilter).toEqual({ authoritativeOnly: true })
    const legacy = trace("t3", [])
    expect(legacy.queryHash).toBeUndefined()
    expect(legacy.modelId).toBeUndefined()
    expect(legacy.slotManifest).toBeUndefined()
  })

  it("computeQueryHash 确定性（同查询恒同键）", () => {
    expect(computeQueryHash("主角动机")).toBe(computeQueryHash("主角动机"))
    expect(computeQueryHash("a")).not.toBe(computeQueryHash("ab"))
  })
})

describe("波1 slot-manifest（上下文装配显式契约）", () => {
  it("槽位→条目映射，确定性字典序规范化", () => {
    const hits = [
      { sourceId: "wiki/a", score: 0.9 },
      { sourceId: "canon/fact-1", score: 0.8 },
      { sourceId: "recent/ch3", score: 0.7 },
    ]
    const manifest = buildSlotManifest(
      [
        { slot: "canon_facts", sourceIds: ["canon/fact"] },
        { slot: "wiki", sourceIds: ["canon/fact", "wiki/a"] },
        { slot: "recent_chapters", sourceIds: ["recent/ch3"] },
      ],
      hits,
      { canon_facts: 2000, wiki: 5000 },
    )
    const slots = manifest.map((m) => m.slot)
    expect(slots).toEqual([...slots].sort())
    const wikiEntries = manifest.filter((m) => m.slot === "wiki")
    expect(wikiEntries.map((m) => m.sourceId)).toEqual(["canon/fact", "wiki/a"])
    expect(manifest.find((m) => m.slot === "wiki" && m.sourceId === "wiki/a")?.score).toBe(0.9)
    expect(manifest.find((m) => m.slot === "canon_facts")?.charBudget).toBe(2000)
    expect(manifest.find((m) => m.slot === "recent_chapters")?.charBudget).toBeUndefined()
  })

  it("缺分命中计 0（manifest 恒完备，不因缺分缺条）", () => {
    const manifest = buildSlotManifest([{ slot: "s1", sourceIds: ["unknown-src"] }], [])
    expect(manifest).toEqual([{ slot: "s1", sourceId: "unknown-src", score: 0, charBudget: undefined }])
  })
})

describe("波1 落选原因（rejections 结构化）", () => {
  it("markHitRejection：未采用命中补 rejection；已采用不覆盖", () => {
    const t = trace("t1", [{ sourceId: "m1", score: 0.9 }, { sourceId: "m2", score: 0.2 }])
    const used = markHitUsed([t], "t1", "m1")
    const rejected = markHitRejection(used, "t1", "m2", { reason: "low_rank" })
    expect(rejected[0].hits[0].used).toBe(true)
    expect(rejected[0].hits[0].rejection).toBeUndefined()
    expect(rejected[0].hits[1].rejection).toEqual({ reason: "low_rank" })
    // 纯函数不改输入
    expect(t.hits[1].rejection).toBeUndefined()
  })
})

describe("波1 反事实重放（超越点：剔除条目 → P0 verdict 是否翻转）", () => {
  it("verdict 翻转候选 → 决定性；不翻转 → 非决定性", () => {
    const result = counterfactualReplay({
      baselineP0Verdict: "pass",
      candidates: [
        { removedSourceId: "canon/fact-1", p0VerdictAfterRemoval: "fail" },
        { removedSourceId: "wiki/style-9", p0VerdictAfterRemoval: "pass" },
      ],
    })
    expect(result.decisiveSourceIds).toEqual(["canon/fact-1"])
    expect(result.nonDecisiveSourceIds).toEqual(["wiki/style-9"])
  })

  it("基线 fail 下剔除后 pass 同样判定为决定性", () => {
    const r = counterfactualReplay({
      baselineP0Verdict: "fail",
      candidates: [{ removedSourceId: "poison/doc", p0VerdictAfterRemoval: "pass" }],
    })
    expect(r.decisiveSourceIds).toEqual(["poison/doc"])
  })

  it("空候选 → 双空清单", () => {
    const r = counterfactualReplay({ baselineP0Verdict: "pass", candidates: [] })
    expect(r.decisiveSourceIds).toEqual([])
    expect(r.nonDecisiveSourceIds).toEqual([])
  })
})
