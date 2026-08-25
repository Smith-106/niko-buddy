import { beforeEach, describe, expect, it, vi } from "vitest"
import { runFactCheck, verifyFactCheckLlm, type FactCheckResult } from "./fact-snapshot"
import { buildNameAliasMap } from "./book-analysis/alias-resolver"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { TemporalFact } from "./temporal-memory"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

// verifyFactCheckLlm 动态导入依赖的模块 mock（仅影响该函数的动态 import 路径）。
const llmMocks = vi.hoisted(() => ({
  resolveNovelModel: vi.fn(),
  streamChat: vi.fn(),
  combineAbortSignals: vi.fn(),
  hasUsableLlm: vi.fn(),
  wikiStoreGetState: vi.fn(),
}))

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (...args: unknown[]) => llmMocks.resolveNovelModel(...args),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => llmMocks.streamChat(...args),
  combineAbortSignals: (...args: unknown[]) => llmMocks.combineAbortSignals(...args),
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: (...args: unknown[]) => llmMocks.hasUsableLlm(...args),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => llmMocks.wikiStoreGetState() },
}))

const fakeLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 8000,
}

const fakeNovelConfig: NovelConfig = {
  reviewModel: "review-model",
} as unknown as NovelConfig

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

// ============================================================
// 规则引擎（legacy rule-engine）全路径覆盖
// ============================================================

function makeRuleSnapshot(chapter: number, overrides: Record<string, unknown> = {}): ChapterSnapshot {
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
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
  } as unknown as ChapterSnapshot
}

describe("runFactCheck — legacy rule engine", () => {
  it("returns empty report when fewer than 2 snapshots", async () => {
    const report = await runFactCheck([makeRuleSnapshot(1)])
    expect(report.results).toEqual([])
    expect(report.checkedChapterCount).toBe(1)
    expect(typeof report.ruleEngineTime).toBe("number")
  })

  it("detects character state jumps (blocking) via severity map", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { characterStateChanges: ["林晚：健康"] }),
      makeRuleSnapshot(2, { characterStateChanges: ["林晚：濒死"] }),
    ])
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({
      severity: "blocking",
      type: "character_jump",
      confidence: 1,
      chapters: [1, 2],
    })
  })

  it("does not flag small-delta severity-map state changes", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { characterStateChanges: ["林晚：受伤"] }),
      makeRuleSnapshot(2, { characterStateChanges: ["林晚：轻伤"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("flags unknown-state changes as medium with 0.7 confidence", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { characterStateChanges: ["林晚：平静"] }),
      makeRuleSnapshot(2, { characterStateChanges: ["林晚：紧张"] }),
    ])
    expect(report.results[0]).toMatchObject({
      severity: "medium",
      type: "character_jump",
      confidence: 0.7,
    })
  })

  it("ignores characters only present in the current chapter", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, {}),
      makeRuleSnapshot(2, { characterStateChanges: ["新人：健康"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("does not flag unchanged character states (equal prev/curr state)", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { characterStateChanges: ["林晚：健康"] }),
      makeRuleSnapshot(2, { characterStateChanges: ["林晚：健康"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("does not flag equal unknown states (outside severity map)", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { characterStateChanges: ["林晚：平静"] }),
      makeRuleSnapshot(2, { characterStateChanges: ["林晚：平静"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("parseStateChanges tolerates malformed entries", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { characterStateChanges: ["无冒号", "：空名", "名字："] }),
      makeRuleSnapshot(2, { characterStateChanges: [] }),
    ])
    expect(report.results).toEqual([])
  })

  it("detects item holder change without transfer event", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { itemDetails: { 锈钥匙: { holder: "林晚" } } }),
      makeRuleSnapshot(2, { itemDetails: { 锈钥匙: { holder: "阿宁" } } }),
    ])
    expect(report.results[0]).toMatchObject({ severity: "medium", type: "item_holder_change" })
  })

  it("accepts holder change when transfer event exists in prev or curr", async () => {
    const withPrevEvent = await runFactCheck([
      makeRuleSnapshot(1, { itemDetails: { 锈钥匙: { holder: "林晚" } }, events: ["阿宁夺取锈钥匙"] }),
      makeRuleSnapshot(2, { itemDetails: { 锈钥匙: { holder: "阿宁" } } }),
    ])
    expect(withPrevEvent.results).toEqual([])
    const withCurrEvent = await runFactCheck([
      makeRuleSnapshot(1, { itemDetails: { 锈钥匙: { holder: "林晚" } } }),
      makeRuleSnapshot(2, { itemDetails: { 锈钥匙: { holder: "阿宁" } }, events: ["阿宁获得锈钥匙"] }),
    ])
    expect(withCurrEvent.results).toEqual([])
  })

  it("skips holder checks when item is new or holder unchanged", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { itemDetails: {} }),
      makeRuleSnapshot(2, { itemDetails: { 新物: { holder: "林晚" }, 锈钥匙: { holder: "林晚" } } }),
    ])
    expect(report.results).toEqual([])
  })

  it("ignores item entries without a holder in the current snapshot", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { itemDetails: { 剑: { holder: "林晚" } } }),
      makeRuleSnapshot(2, { itemDetails: { 剑: {} } }),
    ])
    expect(report.results).toEqual([])
  })

  it("detects org leader flip without power-change event", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { organizationDetails: { 清辉阁: { leader: "掌门甲" } } }),
      makeRuleSnapshot(2, { organizationDetails: { 清辉阁: { leader: "掌门乙" } } }),
    ])
    expect(report.results[0]).toMatchObject({ severity: "medium", type: "org_flip" })
  })

  it("accepts org flip when power-change event exists", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { organizationDetails: { 清辉阁: { leader: "掌门甲" } }, events: ["清辉阁易主"] }),
      makeRuleSnapshot(2, { organizationDetails: { 清辉阁: { leader: "掌门乙" } }, events: ["清辉阁新主上任"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("accepts org flip when power-change keyword appears only in curr events (curr-side branch)", async () => {
    const report = await runFactCheck([
      // prev events 无夺权关键词 → prev.some 短路后 curr.some 必须执行
      makeRuleSnapshot(1, { organizationDetails: { 清辉阁: { leader: "掌门甲" } }, events: ["清辉阁更名"] }),
      makeRuleSnapshot(2, { organizationDetails: { 清辉阁: { leader: "掌门乙" } }, events: ["清辉阁新主上任"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("skips org checks when leader is unchanged, missing in prev, or absent in curr", async () => {
    const unchanged = await runFactCheck([
      makeRuleSnapshot(1, { organizationDetails: { 清辉阁: { leader: "掌门甲" } } }),
      makeRuleSnapshot(2, { organizationDetails: { 清辉阁: { leader: "掌门甲" } } }),
    ])
    expect(unchanged.results).toEqual([])
    const missingPrev = await runFactCheck([
      makeRuleSnapshot(1, { organizationDetails: { 清辉阁: { leader: "掌门甲" } } }),
      makeRuleSnapshot(2, { organizationDetails: { 新组织: { leader: "新主" } } }),
    ])
    expect(missingPrev.results).toEqual([])
    const noLeader = await runFactCheck([
      makeRuleSnapshot(1, { organizationDetails: { 清辉阁: { leader: "掌门甲" } } }),
      makeRuleSnapshot(2, { organizationDetails: { 清辉阁: {} } }),
    ])
    expect(noLeader.results).toEqual([])
  })

  it("detects timeline contradiction for exclusive pairs", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["第三天出发"] }),
      makeRuleSnapshot(2, { timelineEvents: ["第三天到达"] }),
    ])
    expect(report.results[0]).toMatchObject({ severity: "high", type: "timeline_conflict", confidence: 0.9 })
  })

  it("timeline: 死亡/出现 and 闭关/外出 and 开始/结束 pairs", async () => {
    const death = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["第二天死亡"] }),
      makeRuleSnapshot(2, { timelineEvents: ["第二天出现"] }),
    ])
    expect(death.results[0]!.type).toBe("timeline_conflict")
    const hermits = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["第五天闭关"] }),
      makeRuleSnapshot(2, { timelineEvents: ["第五天外出"] }),
    ])
    expect(hermits.results).toHaveLength(1)
    const ends = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["第十天开始大会"] }),
      makeRuleSnapshot(2, { timelineEvents: ["第十天结束大会"] }),
    ])
    expect(ends.results).toHaveLength(1)
  })

  it("timeline: same-time non-contradictory events and no-time-hint events pass", async () => {
    const none = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["第二天赶路"] }),
      makeRuleSnapshot(2, { timelineEvents: ["第二天宿营"] }),
    ])
    expect(none.results).toEqual([])
    const noHint = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["抵达旧城"] }),
      makeRuleSnapshot(2, { timelineEvents: ["离开旧城"] }),
    ])
    expect(noHint.results).toEqual([])
  })

  it("timeline: reverse pair direction (到达→出发) also contradicts", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { timelineEvents: ["第三天到达"] }),
      makeRuleSnapshot(2, { timelineEvents: ["第三天出发"] }),
    ])
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ type: "timeline_conflict" })
  })

  it("detects setting contradiction via negation/affirmation", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { newCanonFacts: ["林晚：是活人"] }),
      makeRuleSnapshot(2, { newCanonFacts: ["林晚：不再是活人"] }),
    ])
    expect(report.results[0]).toMatchObject({ severity: "high", type: "setting_conflict", confidence: 0.85 })
  })

  it("setting: different subjects are not compared; 没有/拥有 contradict too", async () => {
    const diffSubject = await runFactCheck([
      makeRuleSnapshot(1, { newCanonFacts: ["林晚：是活人"] }),
      makeRuleSnapshot(2, { newCanonFacts: ["阿宁：是活人"] }),
    ])
    expect(diffSubject.results).toEqual([])
    const neg = await runFactCheck([
      makeRuleSnapshot(1, { newCanonFacts: ["林晚：拥有佩剑"] }),
      makeRuleSnapshot(2, { newCanonFacts: ["林晚：没有佩剑"] }),
    ])
    expect(neg.results).toHaveLength(1)
  })

  it("detects relationship reversal without transition event", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:友好"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["林晚->沈微:敌对"] }),
    ])
    expect(report.results[0]).toMatchObject({ severity: "medium", type: "relationship_reversal", confidence: 0.75 })
  })

  it("accepts relationship reversal when transition event exists", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:信任"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["林晚->沈微:怀疑"], events: ["两人关系决裂"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("accepts relationship reversal when transition event exists only in prev (prev-side branch)", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:信任"], events: ["两人关系恶化"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["林晚->沈微:怀疑"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("skips relationship pairs absent in the previous chapter", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:友好"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["李四->王五:敌对"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("detects reversal in the reverse pair direction (仇恨→爱慕)", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:仇恨"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["林晚->沈微:爱慕"] }),
    ])
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ type: "relationship_reversal" })
  })

  it("parseRelationships tolerates malformed entries (no separator)", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:友好"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["无冒号条目"] }),
    ])
    expect(report.results).toEqual([])
  })

  it("relationship reversal via 爱慕/仇恨 pair walks earlier pairs false", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { relationshipChanges: ["林晚->沈微:爱慕"] }),
      makeRuleSnapshot(2, { relationshipChanges: ["林晚->沈微:仇恨"] }),
    ])
    expect(report.results).toHaveLength(1)
  })

  it("detects causality break for missing referenced cause", async () => {
    const report = await runFactCheck([
      makeRuleSnapshot(1, { events: ["前置事件甲"] }),
      makeRuleSnapshot(2, {
        events: ["今夜事件"],
        eventDetails: { 今夜事件: { cause: "见第1章：前置事件甲" } },
      }),
    ])
    expect(report.results[0]).toMatchObject({
      severity: "low",
      type: "causality_break",
      confidence: 0.5,
      chapters: [1, 2],
    })
  })

  it("causality: skips when prefix known, no 参考/见, no 第N章, empty prefix, or no details", async () => {
    const knownPrefix = await runFactCheck([
      makeRuleSnapshot(1, {}),
      makeRuleSnapshot(2, {
        events: ["今夜事件", "见第1章记录"],
        eventDetails: { 今夜事件: { cause: "见第1章：前置事件甲" } },
      }),
    ])
    expect(knownPrefix.results).toEqual([])
    const noRef = await runFactCheck([
      makeRuleSnapshot(1, {}),
      makeRuleSnapshot(2, { events: ["今夜事件"], eventDetails: { 今夜事件: { cause: "天气转凉" } } }),
    ])
    expect(noRef.results).toEqual([])
    const noChapter = await runFactCheck([
      makeRuleSnapshot(1, {}),
      makeRuleSnapshot(2, { events: ["今夜事件"], eventDetails: { 今夜事件: { cause: "参考前情" } } }),
    ])
    expect(noChapter.results).toEqual([])
    const emptyPrefix = await runFactCheck([
      makeRuleSnapshot(1, {}),
      makeRuleSnapshot(2, { events: ["今夜事件"], eventDetails: { 今夜事件: { cause: "：见第1章" } } }),
    ])
    expect(emptyPrefix.results).toEqual([])
    const noDetails = await runFactCheck([
      makeRuleSnapshot(1, {}),
      makeRuleSnapshot(2, { events: ["今夜事件"] }),
    ])
    expect(noDetails.results).toEqual([])
  })
})

describe("runFactCheck — temporal pass edge paths", () => {
  it("skips temporal pass when temporalFacts is an empty array", async () => {
    const report = await runFactCheck(
      [makeSnapshot(1, ["菜月昴：是活人"]), makeSnapshot(2, ["菜月昴：不再是活人"])],
      { temporalFacts: [] },
    )
    expect(report.results.filter((r) => r.temporalFactId !== undefined)).toEqual([])
  })

  it("skips raw facts without a parseable subject", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "f1", subject: "菜月昴", object: "是活人", validFrom: 1 }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["  "]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    expect(report.results.filter((r) => r.temporalFactId !== undefined)).toEqual([])
  })

  it("skips prior facts whose validFrom is not before the snapshot chapter", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "f1", subject: "菜月昴", object: "是活人", validFrom: 5 }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：不再是活人"]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    // prior.validFrom(5) >= snapshot.chapterNumber(5) → 不标记
    expect(report.results.filter((r) => r.temporalFactId === "f1")).toEqual([])
  })

  it("does not flag non-contradictory affirmation against a valid prior fact", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "f1", subject: "菜月昴", object: "是活人", validFrom: 1 }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：是活人"]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    expect(report.results.filter((r) => r.temporalFactId === "f1")).toEqual([])
  })

  it("matches subject with empty object via predicate fallback", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "f1", subject: "菜月昴", predicate: "不再活着", object: "", validFrom: 1 }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：不是活人"]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    const finding = report.results.find((r) => r.temporalFactId === "f1")
    expect(finding).toBeDefined()
    expect(finding!.evidenceA).toContain("菜月昴")
  })

  // ── 落点②：modality 门控（belief/hypothesis 不触发矛盾判定）──
  it("落点②: belief 模态的上游事实不触发矛盾判定（角色认为≠事实陈述）", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "fact-ch1-0", subject: "菜月昴", object: "是活人", validFrom: 1, modality: "belief" }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：不再是活人"]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    const temporalFindings = report.results.filter((r) => r.temporalFactId === "fact-ch1-0")
    expect(temporalFindings).toEqual([])
  })

  it("落点②: hypothesis 模态同样不触发矛盾判定", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "fact-ch1-0", subject: "菜月昴", object: "是活人", validFrom: 1, modality: "hypothesis" }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：不再是活人"]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    const temporalFindings = report.results.filter((r) => r.temporalFactId === "fact-ch1-0")
    expect(temporalFindings).toEqual([])
  })

  it("落点②: assertive 模态仍触发矛盾判定（对照，门控不误伤）", async () => {
    const temporalFacts: TemporalFact[] = [
      makeTemporalFact({ id: "fact-ch1-0", subject: "菜月昴", object: "是活人", validFrom: 1, modality: "assertive" }),
    ]
    const snapshots: ChapterSnapshot[] = [
      makeSnapshot(1, ["菜月昴：是活人"]),
      makeSnapshot(5, ["菜月昴：不再是活人"]),
    ]
    const report = await runFactCheck(snapshots, { temporalFacts })
    const temporalFindings = report.results.filter((r) => r.temporalFactId === "fact-ch1-0")
    expect(temporalFindings.length).toBeGreaterThanOrEqual(1)
  })
})

describe("verifyFactCheckLlm", () => {
  beforeEach(() => {
    for (const mock of Object.values(llmMocks)) mock.mockReset()
    llmMocks.resolveNovelModel.mockReturnValue(fakeLlmConfig)
    llmMocks.hasUsableLlm.mockReturnValue(true)
    llmMocks.wikiStoreGetState.mockReturnValue({ llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
  })

  function llmPendingResults(): FactCheckResult[] {
    return [
      {
        severity: "medium",
        type: "character_jump",
        message: "疑似跳变",
        evidenceA: "A",
        evidenceB: "B",
        chapters: [1, 2],
        confidence: 0.7,
        suggestion: "请确认",
      },
      {
        severity: "high",
        type: "setting_conflict",
        message: "疑似矛盾",
        evidenceA: "A2",
        evidenceB: "B2",
        chapters: [2, 3],
        confidence: 0.9,
        suggestion: "请核对",
      },
    ]
  }

  it("returns early for empty or all-certain results", async () => {
    const empty = await verifyFactCheckLlm([], {}, "p")
    expect(empty).toEqual([])
    const certain = await verifyFactCheckLlm([{ ...llmPendingResults()[0], confidence: 1 }], {}, "p")
    expect(certain[0].confidence).toBe(1)
    expect(llmMocks.streamChat).not.toHaveBeenCalled()
  })

  it("returns early when hasUsableLlm is false (no LLM call)", async () => {
    llmMocks.hasUsableLlm.mockReturnValue(false)
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
    expect(llmMocks.streamChat).not.toHaveBeenCalled()
  })

  it("applies verdict confidence + note via injected store", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([{ index: 1, adjustedConfidence: 0.95, note: "确属矛盾" }]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, { 1: "prev", 2: "curr" }, "p", {
      llmConfig: fakeLlmConfig,
      novelConfig: fakeNovelConfig,
    })
    expect(out[0].confidence).toBe(0.95)
    expect(out[0].suggestion).toContain("[LLM: 确属矛盾]")
    expect(llmMocks.wikiStoreGetState).not.toHaveBeenCalled()
  })

  it("falls back to wiki store when injectedStore is missing pieces", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([{ index: 1, adjustedConfidence: 0.8 }]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig })
    expect(llmMocks.wikiStoreGetState).toHaveBeenCalled()
    expect(results[0].confidence).toBe(0.8)
  })

  it("clamps adjustedConfidence into [0, 1]", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([
        { index: 1, adjustedConfidence: 1.5 },
        { index: 2, adjustedConfidence: -1 },
      ]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(results[0].confidence).toBe(1)
    expect(results[1].confidence).toBe(0)
  })

  it("keeps original confidence when adjustedConfidence is not a number", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([{ index: 1, note: "仅备注" }]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(results[0].confidence).toBe(0.7)
    expect(results[0].suggestion).toContain("[LLM: 仅备注]")
  })

  it("returns unchanged when response lacks a JSON array", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("模型没有给出数组")
      handlers.onDone()
    })
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
  })

  it("degrades to unverified when verdict JSON is malformed", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("[{bad json: ]")
      handlers.onDone()
    })
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
  })

  it("skips verdicts with non-numeric index or out-of-range index", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([
        { note: "无 index" },
        { index: 0, adjustedConfidence: 0.1 },
        { index: 99, adjustedConfidence: 0.2 },
        { index: 2, adjustedConfidence: 0.4 },
      ]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(results[0].confidence).toBe(0.7) // index 0 → idx -1 越界
    expect(results[1].confidence).toBe(0.4)
  })

  it("uses chapter content fragments and falls back to (无内容)", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([{ index: 1, adjustedConfidence: 0.5 }]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    await verifyFactCheckLlm(results, { 1: "只有第一章内容" }, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(results[0].confidence).toBe(0.5)
  })

  it("propagates stream errors and non-Error stream errors without throwing", async () => {
    llmMocks.streamChat.mockRejectedValueOnce(new Error("network down"))
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
    llmMocks.streamChat.mockRejectedValueOnce("string error")
    const out2 = await verifyFactCheckLlm(llmPendingResults(), {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out2).toHaveLength(2)
  })

  it("combines caller signal when provided", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([{ index: 1, adjustedConfidence: 0.9 }]))
      handlers.onDone()
    })
    const controller = new AbortController()
    await verifyFactCheckLlm(llmPendingResults(), {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig }, controller.signal)
    expect(llmMocks.combineAbortSignals).toHaveBeenCalled()
  })

  it("falls back to wiki store for llmConfig when only novelConfig is injected", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken(JSON.stringify([{ index: 1, adjustedConfidence: 0.6 }]))
      handlers.onDone()
    })
    const results = llmPendingResults()
    await verifyFactCheckLlm(results, {}, "p", { novelConfig: fakeNovelConfig })
    expect(llmMocks.wikiStoreGetState).toHaveBeenCalled()
    expect(results[0].confidence).toBe(0.6)
  })

  it("logs non-Error stream errors via onError without throwing", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
      handlers.onError?.("plain string error" as unknown as Error)
      handlers.onDone()
    })
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
  })

  it("logs Error-instance stream errors via onError without throwing", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
      handlers.onError?.(new Error("provider timeout"))
      handlers.onDone()
    })
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
  })

  it("returns unchanged when verdict JSON is not an array", async () => {
    llmMocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers: { onToken: (t: string) => void; onDone: () => void }) => {
      handlers.onToken("[123]")
      handlers.onDone()
    })
    const results = llmPendingResults()
    const out = await verifyFactCheckLlm(results, {}, "p", { llmConfig: fakeLlmConfig, novelConfig: fakeNovelConfig })
    expect(out).toBe(results)
  })
})

