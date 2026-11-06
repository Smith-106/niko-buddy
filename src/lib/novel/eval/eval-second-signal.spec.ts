/**
 * eval-second-signal.spec.ts — L3 第二信号源（零 LLM 机械层）验证。
 *
 * 覆盖：义务三元组抽取（former/superseded 类字段）、生成段存在性比对、
 * runSecondSignal 显式 SKIP（C7：无义务字段/生成正文缺失不伪造）。
 */
import { describe, it, expect } from "vitest"
import type { TemporalFact } from "../temporal-memory"
import type { CanonFact } from "../canon-graph-client"
import {
  extractObligationsFromTemporalFacts,
  extractObligationsFromCanonFacts,
  extractObligationsFromContextPack,
  compareObligationsToGenerated,
  runSecondSignal,
  secondSignalReportSchema,
} from "./eval-second-signal"
import type { ContextPack } from "../context-engine"

function temporalFact(overrides: Partial<TemporalFact> = {}): TemporalFact {
  return {
    id: "f-1",
    subject: "墨渊",
    predicate: "状态",
    object: "重伤",
    validFrom: 1,
    source: "chapter-1",
    ...overrides,
  }
}

function canonFact(overrides: Partial<CanonFact> = {}): CanonFact {
  return {
    id: "c-1",
    sourceId: "墨渊",
    targetId: "重伤",
    predicate: "状态",
    edgeKind: "attribute",
    archived: false,
    ...overrides,
  }
}

function emptyPack(): ContextPack {
  return {
    task: "eval",
    chapterGoal: "",
    outline: "",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }
}

describe("extractObligationsFromTemporalFacts", () => {
  it("former flag → former=true obligation", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact({ former: true })])
    expect(ob).toHaveLength(1)
    expect(ob[0].former).toBe(true)
    expect(ob[0].source).toBe("formerFacts")
  })

  it("validUntil closed → former=true obligation", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact({ validUntil: 3 })])
    expect(ob[0].former).toBe(true)
  })

  it("current fact → former=false", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact()])
    expect(ob[0].former).toBe(false)
    expect(ob[0].source).toBe("temporalFacts")
  })

  it("null/empty → []", () => {
    expect(extractObligationsFromTemporalFacts(null)).toEqual([])
    expect(extractObligationsFromTemporalFacts([])).toEqual([])
  })
})

describe("extractObligationsFromCanonFacts", () => {
  it("archived → former=true", () => {
    const ob = extractObligationsFromCanonFacts([canonFact({ archived: true })])
    expect(ob[0].former).toBe(true)
  })

  it("invalidAt closed → former=true", () => {
    const ob = extractObligationsFromCanonFacts([canonFact({ invalidAt: 5 })])
    expect(ob[0].former).toBe(true)
  })

  it("current edge → former=false", () => {
    const ob = extractObligationsFromCanonFacts([canonFact()])
    expect(ob[0].former).toBe(false)
  })
})

describe("extractObligationsFromContextPack", () => {
  it("merges formerFacts + temporalFacts and dedupes", () => {
    const former = temporalFact({ id: "f-1", former: true })
    const current = temporalFact({ id: "f-2", validFrom: 2, object: "痊愈" })
    const pack = { ...emptyPack(), formerFacts: [former], temporalFacts: [former, current] }
    const ob = extractObligationsFromContextPack(pack)
    // 去重后 f-1 仅一次，f-2 一次
    expect(ob).toHaveLength(2)
  })

  it("no obligation fields → []", () => {
    expect(extractObligationsFromContextPack(emptyPack())).toEqual([])
  })
})

describe("compareObligationsToGenerated", () => {
  it("former obligation referenced in generated text → warning", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact({ former: true })])
    const warnings = compareObligationsToGenerated(ob, "墨渊 依旧 重伤，被搀扶离开。")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe("superseded_fact_referenced")
  })

  it("former obligation absent → no warning", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact({ former: true })])
    expect(compareObligationsToGenerated(ob, "天色已晚。")).toEqual([])
  })

  it("non-former obligation never warns", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact()])
    expect(compareObligationsToGenerated(ob, "墨渊 状态 重伤")).toEqual([])
  })
})

describe("runSecondSignal (C7 explicit SKIP)", () => {
  it("no generated text → skip with reason", () => {
    const r = runSecondSignal(
      extractObligationsFromTemporalFacts([temporalFact({ former: true })]),
      undefined,
    )
    expect(r.status).toBe("skip")
    expect(r.skipReason).toContain("生成段正文缺失")
    expect(r.warnings).toEqual([])
  })

  it("no obligations → skip with reason", () => {
    const r = runSecondSignal([], "墨渊 状态 重伤")
    expect(r.status).toBe("skip")
    expect(r.skipReason).toContain("无义务三元组候选")
  })

  it("both present → run with warnings", () => {
    const ob = extractObligationsFromTemporalFacts([temporalFact({ former: true })])
    const r = runSecondSignal(ob, "墨渊 依旧 重伤")
    expect(r.status).toBe("run")
    expect(r.warnings).toHaveLength(1)
    expect(secondSignalReportSchema.safeParse(r).success).toBe(true)
  })
})

describe("extractObligationsFromCanonFacts 空输入", () => {
  it("facts 为 null / undefined → 空数组（不伪造义务三元组）", () => {
    expect(extractObligationsFromCanonFacts(null)).toEqual([])
    expect(extractObligationsFromCanonFacts(undefined)).toEqual([])
  })

  it("空数组走 length===0 早退", () => {
    expect(extractObligationsFromCanonFacts([])).toEqual([])
  })
})

describe("compareObligationsToGenerated 缺失端点剪枝", () => {
  it("subject/object 为空串的义务不产生 warning（正文 includes('') 恒真，必须剪掉）", () => {
    const warnings = compareObligationsToGenerated(
      [
        { subject: "", predicate: "状态", object: "重伤", former: true, source: "temporalFacts" },
        { subject: "墨渊", predicate: "状态", object: "", former: true, source: "temporalFacts" },
      ],
      "墨渊 现在 已经 重伤 复原",
    )
    expect(warnings).toEqual([])
  })

  it("对照：端点齐全时同一正文仍会告警（证明上例是被剪枝而非正文不命中）", () => {
    const warnings = compareObligationsToGenerated(
      [{ subject: "墨渊", predicate: "状态", object: "重伤", former: true, source: "temporalFacts" }],
      "墨渊 现在 已经 重伤 复原",
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe("superseded_fact_referenced")
  })
})
