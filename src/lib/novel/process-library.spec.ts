import { describe, it, expect } from "vitest"
import {
  createEmptyEncounterMatrixStore,
  appendMeetingEdge,
  findFirstMeeting,
  metBefore,
  encounterMatrixToContextText,
} from "./encounter-matrix"
import {
  createEmptyChapterSummariesStore,
  foldChapterSummary,
  upsertChapterSummary,
  recentChapterSummaries,
  chapterSummariesToContextText,
} from "./chapter-summaries"
import {
  createEmptyParticleLedgerStore,
  appendParticleEntry,
  currentParticleState,
  particleHistory,
  particleLedgerToContextText,
} from "./particle-ledger"
import { detectKnowledgeLeak, detectLostItem } from "./deterministic-continuity-engine"
import type { ChapterSnapshot } from "./chapter-ingest"

describe("encounter-matrix（character_matrix 谁见过谁）", () => {
  it("append 幂等：同 a/b/chapter 不重复", () => {
    let s = createEmptyEncounterMatrixStore()
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 3, context: "客栈", witnessedBy: [] })
    s = appendMeetingEdge(s, { a: "乙", b: "甲", chapter: 3, context: "客栈", witnessedBy: [] })
    expect(s.edges).toHaveLength(1)
  })

  it("findFirstMeeting 双向命中 + metBefore 按章过滤", () => {
    let s = createEmptyEncounterMatrixStore()
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 3, context: "客栈", witnessedBy: ["丙"] })
    s = appendMeetingEdge(s, { a: "甲", b: "丁", chapter: 7, context: "码头", witnessedBy: [] })
    expect(findFirstMeeting(s, "乙", "甲")).toBe(3)
    expect(metBefore(s, "甲", 5)).toEqual(["乙"])
    expect(metBefore(s, "甲", 8)).toEqual(["乙", "丁"])
  })

  it("ToContextText 渲染", () => {
    let s = createEmptyEncounterMatrixStore()
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 3, context: "客栈", witnessedBy: ["丙"] })
    const text = encounterMatrixToContextText(s)
    expect(text).toContain("第3章 甲 × 乙")
    expect(text).toContain("在场：丙")
    expect(encounterMatrixToContextText(createEmptyEncounterMatrixStore())).toBe("")
  })
})

describe("chapter-summaries（chapter_summaries stateDelta）", () => {
  const snapshot: ChapterSnapshot = {
    chapterId: "ch-5",
    chapterNumber: 5,
    summary: "主角抵达都城",
    characters: ["甲"],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: ["甲：抵达都城"],
    relationshipChanges: ["甲-乙：结盟"],
    knowledgeChanges: ["甲得知密道"],
    foreshadowingChanges: ["F-1：埋下玉佩伏笔"],
    newCanonFacts: ["都城有密道"],
    timelineEvents: [],
    conflicts: [],
    endingHook: "玉佩发光",
    graphNodes: [],
    graphEdges: [],
    itemDetails: { 玉佩: { holder: "甲", previousHolders: "", abilities: "", limitations: "", origin: "" } },
  }

  it("foldChapterSummary 从 snapshot 既有字段确定性 fold", () => {
    const entry = foldChapterSummary(snapshot)
    expect(entry.chapter).toBe(5)
    expect(entry.happened).toBe("主角抵达都城")
    expect(entry.stateChanges).toHaveLength(5) // character/relationship/knowledge/foreshadowing/item
    expect(entry.stateChanges[0]).toEqual({ kind: "character", entity: "甲", change: "甲：抵达都城" })
    expect(entry.keyReveals).toContain("甲得知密道")
    expect(entry.endingHook).toBe("玉佩发光")
  })

  it("upsert 按章替换 + 升序 + recent N", () => {
    let s = createEmptyChapterSummariesStore()
    s = upsertChapterSummary(s, foldChapterSummary({ ...snapshot, chapterNumber: 5 }))
    s = upsertChapterSummary(s, foldChapterSummary({ ...snapshot, chapterNumber: 3 }))
    s = upsertChapterSummary(s, foldChapterSummary({ ...snapshot, chapterNumber: 5, summary: "修订版" }))
    expect(s.entries.map((e) => e.chapter)).toEqual([3, 5])
    expect(s.entries[1].happened).toBe("修订版")
    expect(recentChapterSummaries(s, 1).map((e) => e.chapter)).toEqual([5])
  })

  it("ToContextText 渲染近 N 章", () => {
    let s = createEmptyChapterSummariesStore()
    s = upsertChapterSummary(s, foldChapterSummary(snapshot))
    const text = chapterSummariesToContextText(s, 3)
    expect(text).toContain("第5章")
    expect(text).toContain("[character] 甲")
    expect(chapterSummariesToContextText(createEmptyChapterSummariesStore())).toBe("")
  })
})

describe("particle-ledger（particle_ledger 金钱/伤势/功法）", () => {
  it("append 强不变量：无归属/无章号拒绝", () => {
    let s = createEmptyParticleLedgerStore()
    s = appendParticleEntry(s, { kind: "money", character: "甲", name: "银两", chapter: 2, delta: -50, state: "余 100", note: "买药" })
    const rejected = appendParticleEntry(s, { kind: "money", character: "", name: "银两", chapter: 2, delta: -50, state: "", note: "" })
    expect(rejected).toBe(s)
    expect(s.entries).toHaveLength(1)
  })

  it("currentParticleState 取最后一条 + history 全时序", () => {
    let s = createEmptyParticleLedgerStore()
    s = appendParticleEntry(s, { kind: "injury", character: "甲", name: "左臂", chapter: 4, delta: 1, state: "重伤", note: "中箭" })
    s = appendParticleEntry(s, { kind: "injury", character: "甲", name: "左臂", chapter: 6, delta: -1, state: "已愈", note: "敷药" })
    expect(currentParticleState(s, "甲", "injury")?.state).toBe("已愈")
    expect(particleHistory(s, "甲", "injury")).toHaveLength(2)
    expect(currentParticleState(s, "乙", "injury")).toBeNull()
  })

  it("ToContextText 渲染三类账本", () => {
    let s = createEmptyParticleLedgerStore()
    s = appendParticleEntry(s, { kind: "technique", character: "甲", name: "九阳功", chapter: 1, delta: 1, state: "一层", note: "入门" })
    const text = particleLedgerToContextText(s)
    expect(text).toContain("【功法账本】")
    expect(text).toContain("第1章 甲 九阳功 +1 → 一层")
    expect(particleLedgerToContextText(createEmptyParticleLedgerStore())).toBe("")
  })
})

describe("审计检测器（Grok 三口诀）", () => {
  it("detectKnowledgeLeak：他不该知道 → critical", () => {
    const findings = detectKnowledgeLeak({
      presentCharacters: ["甲"],
      doesNotKnow: { 甲: ["密道位置"] },
      metBefore: { 甲: [] },
      chapter: 5,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("knowledge_boundary")
    expect(findings[0].severity).toBe("critical")
    expect(findings[0].ref).toBe("character:甲")
  })

  it("detectKnowledgeLeak：无 forbidden 事实 → 无 finding", () => {
    expect(
      detectKnowledgeLeak({ presentCharacters: ["甲"], doesNotKnow: {}, metBefore: {}, chapter: 5 }),
    ).toHaveLength(0)
  })

  it("detectLostItem：孤儿引用 → warning；显式转移豁免", () => {
    const findings = detectLostItem({
      previousHolders: { 玉佩: "" },
      presentItems: ["玉佩"],
      explicitTransfers: {},
      chapter: 5,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("lost_item")
    expect(findings[0].severity).toBe("warning")

    const exempt = detectLostItem({
      previousHolders: { 玉佩: "" },
      presentItems: ["玉佩"],
      explicitTransfers: { 玉佩: "甲" },
      chapter: 5,
    })
    expect(exempt).toHaveLength(0)
  })

  it("detectLostItem：新物品/有主物品不误报", () => {
    expect(
      detectLostItem({ previousHolders: {}, presentItems: ["新剑"], explicitTransfers: {}, chapter: 5 }),
    ).toHaveLength(0)
    expect(
      detectLostItem({ previousHolders: { 玉佩: "甲" }, presentItems: ["玉佩"], explicitTransfers: {}, chapter: 5 }),
    ).toHaveLength(0)
  })

  it("detectLostItem：粒子矛盾（伤势已愈却再现）→ critical", () => {
    const findings = detectLostItem({
      previousHolders: {},
      presentItems: [],
      explicitTransfers: {},
      chapter: 7,
      particleStates: { 甲: { 左臂: "已愈" } },
      presentParticles: { 甲: ["左臂"] },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("lost_item")
    expect(findings[0].severity).toBe("critical")
    expect(findings[0].ref).toBe("particle:甲:左臂")
  })

  it("detectLostItem：粒子无账本记录/状态正常不误报", () => {
    expect(
      detectLostItem({
        previousHolders: {},
        presentItems: [],
        explicitTransfers: {},
        chapter: 7,
        particleStates: { 甲: { 左臂: "重伤" } },
        presentParticles: { 甲: ["左臂"] },
      }),
    ).toHaveLength(0)
    expect(
      detectLostItem({
        previousHolders: {},
        presentItems: [],
        explicitTransfers: {},
        chapter: 7,
        presentParticles: { 甲: ["左臂"] },
      }),
    ).toHaveLength(0)
  })
})
