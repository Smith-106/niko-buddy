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
import { detectKnowledgeLeak, detectLostItem, detectForeshadowingConfiscation } from "./deterministic-continuity-engine"
import type { ContinuityFinding } from "./deterministic-continuity-engine"
import type { ChapterSnapshot } from "./chapter-ingest"

describe("encounter-matrix（character_matrix 谁见过谁）", () => {
  it("append 幂等：同 a/b/chapter 不重复", () => {
    let s = createEmptyEncounterMatrixStore()
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 3, context: "客栈", witnessedBy: [] })
    s = appendMeetingEdge(s, { a: "乙", b: "甲", chapter: 3, context: "客栈", witnessedBy: [] })
    expect(s.edges).toHaveLength(1)
  })

  it("E-03 幂等键修复：跨章同对允许追加（(a,b,chapter) 三元组）", () => {
    let s = createEmptyEncounterMatrixStore()
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 3, context: "客栈", witnessedBy: [] })
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 7, context: "码头", witnessedBy: [] })
    expect(s.edges).toHaveLength(2)
    expect(s.edges.map((e) => e.chapter)).toEqual([3, 7])
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

  it("E-03 幂等键修复：同 (kind,character,name,chapter) 跳过并保留首条", () => {
    let s = createEmptyParticleLedgerStore()
    const e1 = { kind: "money" as const, character: "甲", name: "银两", chapter: 2, delta: -50, state: "余 100", note: "买药" }
    s = appendParticleEntry(s, e1)
    s = appendParticleEntry(s, { ...e1, delta: -30, state: "余 120" })
    expect(s.entries).toHaveLength(1)
    expect(s.entries[0].delta).toBe(-50)
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
  it("detectKnowledgeLeak：正文符号命中 → critical（证据充分）", () => {
    const findings = detectKnowledgeLeak({
      presentCharacters: ["甲"],
      doesNotKnow: { 甲: ["密道位置"] },
      metBefore: { 甲: [] },
      chapter: 5,
      chapterBody: "甲说出了密道位置，众人皆惊。",
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("knowledge_boundary")
    expect(findings[0].severity).toBe("critical")
    expect(findings[0].ref).toBe("character:甲")
  })

  it("detectKnowledgeLeak：chapterFacts 通道命中 → critical（NFKC 归一）", () => {
    const findings = detectKnowledgeLeak({
      presentCharacters: ["甲"],
      doesNotKnow: { 甲: ["密道位置"] },
      metBefore: { 甲: [] },
      chapter: 5,
      chapterFacts: ["甲 知晓 密 道 位 置"],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("knowledge_boundary")
    expect(findings[0].severity).toBe("critical")
  })

  it("detectKnowledgeLeak：台账有禁知事实但无证据 → info + data_gap（验收⑤不妄断）", () => {
    const findings = detectKnowledgeLeak({
      presentCharacters: ["甲"],
      doesNotKnow: { 甲: ["密道位置"] },
      metBefore: { 甲: [] },
      chapter: 5,
      chapterBody: "甲在集市闲逛，毫无异常。",
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("data_gap")
    expect(findings[0].severity).toBe("info")
    // discriminated union 收窄：missingField 仅存在于 DataGapFinding
    const gap = findings[0] as Extract<ContinuityFinding, { subtype: "data_gap" }>
    expect(gap.missingField).toBe("leak_evidence")
  })

  it("detectKnowledgeLeak：无证据通道输入 → 全部降级 info（不妄断 critical）", () => {
    const findings = detectKnowledgeLeak({
      presentCharacters: ["甲"],
      doesNotKnow: { 甲: ["密道位置"] },
      metBefore: { 甲: [] },
      chapter: 5,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("data_gap")
    expect(findings[0].severity).toBe("info")
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

  it("detectLostItem：粒子矛盾（伤势已愈却再现）→ critical（缺省 ledger 源）", () => {
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

  it("detectLostItem：粒子矛盾 text 源 → 降级 warning（验收⑤证据分级）", () => {
    const findings = detectLostItem({
      previousHolders: {},
      presentItems: [],
      explicitTransfers: {},
      chapter: 7,
      particleStates: { 甲: { 左臂: "已愈" } },
      presentParticles: { 甲: ["左臂"] },
      particleEvidence: { 甲: { 左臂: "text" } },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("lost_item")
    expect(findings[0].severity).toBe("warning")
  })

  it("detectLostItem：粒子词表收敛 — 裸「无」不误报，无X 形态命中", () => {
    expect(
      detectLostItem({
        previousHolders: {},
        presentItems: [],
        explicitTransfers: {},
        chapter: 7,
        particleStates: { 甲: { 左臂: "无" } },
        presentParticles: { 甲: ["左臂"] },
      }),
    ).toHaveLength(0)
    const prefixHit = detectLostItem({
      previousHolders: {},
      presentItems: [],
      explicitTransfers: {},
      chapter: 7,
      particleStates: { 甲: { 左臂: "无碍" } },
      presentParticles: { 甲: ["左臂"] },
    })
    expect(prefixHit).toHaveLength(1)
    expect(prefixHit[0].severity).toBe("critical")
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

  it("detectForeshadowingConfiscation：超长未收 → 没收候选 warning（不阻断）", () => {
    const findings = detectForeshadowingConfiscation({
      items: [{
        id: "F-001",
        name: "密道钥匙",
        description: "",
        status: "planted",
        plantedChapter: 1,
        advancedChapters: [],
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      }],
      currentChapter: 25,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("unresolved_foreshadowing")
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].evidence).toBe("confiscated:F-001")
  })

  it("detectForeshadowingConfiscation：关联角色死亡 → 没收候选 warning", () => {
    const findings = detectForeshadowingConfiscation({
      items: [{
        id: "F-002",
        name: "遗书",
        description: "",
        status: "planted",
        plantedChapter: 2,
        advancedChapters: [],
        relatedCharacters: ["乙"],
        relatedEvents: [],
        notes: "",
      }],
      currentChapter: 6,
      deadCharacters: ["乙"],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].evidence).toBe("confiscated:F-002")
  })

  it("detectForeshadowingConfiscation：陈化未收 → warning；normal/abandoned/resolved 不产 finding", () => {
    const stale = detectForeshadowingConfiscation({
      items: [{
        id: "F-003",
        name: "旧伤",
        description: "",
        status: "planted",
        plantedChapter: 1,
        advancedChapters: [],
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      }],
      currentChapter: 6,
    })
    expect(stale).toHaveLength(1)
    expect(stale[0].severity).toBe("warning")
    expect(stale[0].evidence).toBe("stale:F-003")

    const quiet = detectForeshadowingConfiscation({
      items: [
        { id: "F-004", name: "新伏笔", description: "", status: "planted", plantedChapter: 5, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        { id: "F-005", name: "已弃", description: "", status: "abandoned", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        { id: "F-006", name: "已收", description: "", status: "resolved", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
      currentChapter: 6,
    })
    expect(quiet).toHaveLength(0)
  })

  it("detectForeshadowingConfiscation：缺 plantedChapter → info + data_gap（不妄断）", () => {
    const findings = detectForeshadowingConfiscation({
      items: [{
        id: "F-007",
        name: "谜团",
        description: "",
        status: "planted",
        plantedChapter: 0,
        advancedChapters: [],
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      }],
      currentChapter: 6,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("unresolved_foreshadowing")
    expect(findings[0].subtype).toBe("data_gap")
    expect(findings[0].severity).toBe("info")
    const gap = findings[0] as Extract<ContinuityFinding, { subtype: "data_gap" }>
    expect(gap.missingField).toBe("plantedChapter")
  })
})
