/**
 * E-03 (run-execute-1, 双库架构蓝图) 验收② — fold 纯性 spec。
 *
 * 共识 C-3：fold 函数体内禁止隐式时钟（new Date）；时间戳只经显式 FoldContext.now
 * 写入；缺省保留输入 store 时间戳（新条目写 ""）→ 同输入同输出在无 ctx 时也成立。
 *
 * 覆盖：chapter-ingest 的 5 个 apply* fold + 3 个孤儿投影 fold
 * （encounter-matrix / chapter-summaries / particle-ledger）。
 */
import { describe, it, expect } from "vitest"
import {
  applyCharacterStateChangesToStore,
  applyForeshadowingChangesToStore,
  applyEmotionalArcsToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
} from "./chapter-ingest"
import { appendMeetingEdge, foldMeetingEdges, createEmptyEncounterMatrixStore } from "./encounter-matrix"
import { upsertChapterSummary, foldChapterSummary, createEmptyChapterSummariesStore } from "./chapter-summaries"
import { appendParticleEntry, foldParticleEntries, createEmptyParticleLedgerStore } from "./particle-ledger"
import { createEmptyCharacterStateStore } from "./character-state"
import { createEmptyForeshadowingStore } from "./foreshadowing-tracker"
import { createEmptyEmotionalArcStore } from "./emotional-arcs"
import { createEmptyResourceLedgerStore } from "./resource-ledger"
import { createEmptySubplotBoardStore } from "./subplot-board"
import type { ChapterSnapshot } from "./chapter-ingest"

const snapshot: ChapterSnapshot = {
  chapterId: "ch-5",
  chapterNumber: 5,
  summary: "主角抵达都城",
  characters: ["甲", "乙"],
  locations: [],
  organizations: [],
  items: [],
  events: ["甲与乙在客栈会面"],
  characterStateChanges: ["甲：受伤"],
  relationshipChanges: ["甲-乙：结盟"],
  knowledgeChanges: ["甲得知密道"],
  foreshadowingChanges: ["新增伏笔：玉佩"],
  newCanonFacts: ["都城有密道"],
  timelineEvents: [],
  conflicts: [],
  endingHook: "玉佩发光",
  graphNodes: [],
  graphEdges: [],
  itemDetails: { 玉佩: { holder: "甲", previousHolders: "", abilities: "", limitations: "", origin: "" } },
}

describe("E-03 fold 纯性（同输入同输出 + now 无关性）", () => {
  it("applyCharacterStateChangesToStore: 固定 now 双跑 deepEqual；无 ctx 保留输入时间戳", () => {
    const run = (now?: string) => {
      const store = createEmptyCharacterStateStore()
      store.lastUpdated = "input-ts"
      return applyCharacterStateChangesToStore(store, snapshot, undefined, now ? { now } : undefined)
    }
    const a = run("2026-09-04T00:00:00.000Z")
    const b = run("2026-09-04T00:00:00.000Z")
    expect(a).toEqual(b)
    // 无 ctx：保留输入 store 时间戳，新条目写 ""
    const c = run()
    expect(c.lastUpdated).toBe("input-ts")
    expect(c.characters[0].lastUpdatedAt).toBe("")
  })

  it("applyForeshadowingChangesToStore: 固定 now 双跑 deepEqual；无 ctx 保留", () => {
    const run = (now?: string) => {
      const store = createEmptyForeshadowingStore()
      store.lastUpdated = "input-ts"
      return applyForeshadowingChangesToStore(store, snapshot, now ? { now } : undefined)
    }
    expect(run("2026-09-04T00:00:00.000Z")).toEqual(run("2026-09-04T00:00:00.000Z"))
    expect(run().lastUpdated).toBe("input-ts")
  })

  it("applyEmotionalArcsToStore: 固定 now 双跑 deepEqual；无 ctx 保留", () => {
    const run = (now?: string) => {
      const store = createEmptyEmotionalArcStore()
      store.lastUpdated = "input-ts"
      return applyEmotionalArcsToStore(store, snapshot, undefined, now ? { now } : undefined)
    }
    expect(run("2026-09-04T00:00:00.000Z")).toEqual(run("2026-09-04T00:00:00.000Z"))
    expect(run().lastUpdated).toBe("input-ts")
  })

  it("applyResourceLedgerToStore: 固定 now 双跑 deepEqual；无 ctx 保留", () => {
    const run = (now?: string) => {
      const store = createEmptyResourceLedgerStore()
      store.lastUpdated = "input-ts"
      return applyResourceLedgerToStore(store, snapshot, undefined, now ? { now } : undefined)
    }
    expect(run("2026-09-04T00:00:00.000Z")).toEqual(run("2026-09-04T00:00:00.000Z"))
    expect(run().lastUpdated).toBe("input-ts")
  })

  it("applySubplotChangesToStore: 固定 now 双跑 deepEqual；无 ctx 保留", () => {
    const run = (now?: string) => {
      const store = createEmptySubplotBoardStore()
      store.lastUpdated = "input-ts"
      return applySubplotChangesToStore(store, snapshot, now ? { now } : undefined)
    }
    expect(run("2026-09-04T00:00:00.000Z")).toEqual(run("2026-09-04T00:00:00.000Z"))
    expect(run().lastUpdated).toBe("input-ts")
  })

  it("appendMeetingEdge: 同输入双跑 deepEqual；不同 now 不影响内容字段", () => {
    const edge = { a: "甲", b: "乙", chapter: 5, context: "", witnessedBy: [] as string[] }
    const s1 = appendMeetingEdge(createEmptyEncounterMatrixStore(), edge, { now: "T1" })
    const s2 = appendMeetingEdge(createEmptyEncounterMatrixStore(), edge, { now: "T2" })
    expect(s1.edges).toEqual(s2.edges)
    expect(s1.lastUpdated).toBe("T1")
    expect(s2.lastUpdated).toBe("T2")
  })

  it("upsertChapterSummary: 同输入双跑 deepEqual；无 ctx 保留输入时间戳", () => {
    const s1 = upsertChapterSummary(createEmptyChapterSummariesStore(), foldChapterSummary(snapshot), { now: "T" })
    const s2 = upsertChapterSummary(createEmptyChapterSummariesStore(), foldChapterSummary(snapshot), { now: "T" })
    expect(s1).toEqual(s2)
    const s3 = upsertChapterSummary(createEmptyChapterSummariesStore(), foldChapterSummary(snapshot))
    expect(s3.lastUpdated).toBe("")
  })

  it("appendParticleEntry: 同输入双跑 deepEqual；不同 now 不影响内容字段", () => {
    const entry = { kind: "money" as const, character: "甲", name: "银两", chapter: 5, delta: -50, state: "余 100", note: "" }
    const s1 = appendParticleEntry(createEmptyParticleLedgerStore(), entry, { now: "T1" })
    const s2 = appendParticleEntry(createEmptyParticleLedgerStore(), entry, { now: "T2" })
    expect(s1.entries).toEqual(s2.entries)
    expect(s1.lastUpdated).toBe("T1")
    expect(s2.lastUpdated).toBe("T2")
  })

  it("foldMeetingEdges / foldParticleEntries 是纯函数（无 IO 无时钟）", () => {
    const edges1 = foldMeetingEdges(snapshot, undefined)
    const edges2 = foldMeetingEdges(snapshot, undefined)
    expect(edges1).toEqual(edges2)
    expect(edges1.length).toBeGreaterThan(0)
    const p1 = foldParticleEntries(snapshot, undefined)
    const p2 = foldParticleEntries(snapshot, undefined)
    expect(p1).toEqual(p2)
  })
})

describe("E-03 幂等键（fold-rebuildable 前提）", () => {
  it("appendMeetingEdge: 同 a/b/chapter 跳过，跨章同对允许追加（三元组键）", () => {
    let s = createEmptyEncounterMatrixStore()
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 3, context: "", witnessedBy: [] })
    s = appendMeetingEdge(s, { a: "乙", b: "甲", chapter: 3, context: "", witnessedBy: [] })
    expect(s.edges).toHaveLength(1)
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 7, context: "", witnessedBy: [] })
    expect(s.edges).toHaveLength(2)
    expect(s.edges[1].chapter).toBe(7)
  })

  it("appendParticleEntry: 同 (kind,character,name,chapter) 跳过并保留首条", () => {
    let s = createEmptyParticleLedgerStore()
    const e1 = { kind: "money" as const, character: "甲", name: "银两", chapter: 2, delta: -50, state: "余 100", note: "买药" }
    const e2 = { ...e1, delta: -30, state: "余 120" }
    s = appendParticleEntry(s, e1)
    s = appendParticleEntry(s, e2)
    expect(s.entries).toHaveLength(1)
    expect(s.entries[0].delta).toBe(-50)
  })
})
