import { describe, expect, it } from "vitest"
import { applyEmotionalArcsToStore, applyForeshadowingChangesToStore } from "./chapter-ingest"
import type { ChapterSnapshot, CharacterDetail } from "./chapter-ingest"
import { appendMeetingEdge, createEmptyEncounterMatrixStore, foldMeetingEdges } from "./encounter-matrix"
import { appendParticleEntry, createEmptyParticleLedgerStore, foldParticleEntries } from "./particle-ledger"
import { truthStoreHash } from "./projection-store"
import { createEmptyEmotionalArcStore } from "./emotional-arcs"
import { createEmptyForeshadowingStore } from "./foreshadowing-tracker"
import type { NameAliasMap } from "./book-analysis/types"

/**
 * ISS-20260709-021: fold idempotency regression tests.
 *
 * CORR-104 (foreshadow) + CORR-103 (emotional arc) require that re-folding
 * the same committed snapshot over a store that already holds this chapter's
 * entry MUST update-in-place, NOT append a duplicate. Otherwise live re-ingest
 * (re-running ingestChapter over an already-ingested snapshot, e.g. after a
 * partial-projection repair) diverges from a clean rebuild (which folds each
 * snapshot exactly once via rebuildFromCommittedSnapshot), and ids/counts
 * drift/collide. These tests lock the fold-rebuildable contract at the pure
 * fold-function level (no LLM, no FS — the helpers are pure store-mutators).
 */
describe("ISS-20260709-021 fold idempotency — CORR-103/104 re-ingest does not duplicate", () => {
  describe("CORR-104 applyForeshadowingChangesToStore", () => {
    it("re-folding the same 'add' snapshot updates in place (no duplicate, stable id)", () => {
      const snapshot: ChapterSnapshot = {
        chapterId: "ch-1",
        chapterNumber: 1,
        summary: "",
        characters: [],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        characterStateChanges: [],
        relationshipChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: ["新增伏笔:旧钥匙-主角从老人处得到的旧钥匙"],
        newCanonFacts: [],
        timelineEvents: [],
        conflicts: [],
        endingHook: "",
        graphNodes: [],
        graphEdges: [],
      }

      // First fold: plants fs-1-1.
      const store = createEmptyForeshadowingStore()
      applyForeshadowingChangesToStore(store, snapshot)
      expect(store.items).toHaveLength(1)
      expect(store.items[0].id).toBe("fs-1-1")
      expect(store.items[0].name).toBe("旧钥匙")
      expect(store.items[0].plantedChapter).toBe(1)

      // Re-fold the SAME snapshot (simulates live re-ingest over an already-
      // ingested chapter). CORR-104: MUST update description in place, NOT
      // append fs-1-2. Length stays 1, id stays fs-1-1.
      applyForeshadowingChangesToStore(store, snapshot)
      expect(store.items).toHaveLength(1)
      expect(store.items[0].id).toBe("fs-1-1")
      expect(store.items[0].description).toBe("主角从老人处得到的旧钥匙")
    })

    it("re-folding with an updated description mutates the existing entry (re-ingest drift fix)", () => {
      const baseSnapshot: ChapterSnapshot = {
        chapterId: "ch-1",
        chapterNumber: 1,
        summary: "",
        characters: [],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        characterStateChanges: [],
        relationshipChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: ["新增伏笔:族谱-族谱缺页"],
        newCanonFacts: [],
        timelineEvents: [],
        conflicts: [],
        endingHook: "",
        graphNodes: [],
        graphEdges: [],
      }

      const store = createEmptyForeshadowingStore()
      applyForeshadowingChangesToStore(store, baseSnapshot)
      expect(store.items).toHaveLength(1)

      // Re-ingest the same chapter with a richer description (LLM re-extracted
      // with more context). Same name+plantedChapter key → update in place.
      const richerSnapshot: ChapterSnapshot = {
        ...baseSnapshot,
        foreshadowingChanges: ["新增伏笔:族谱-祠堂族谱缺页，疑被人换走"],
      }
      applyForeshadowingChangesToStore(store, richerSnapshot)
      expect(store.items).toHaveLength(1)
      expect(store.items[0].description).toBe("祠堂族谱缺页，疑被人换走")
    })

    it("captures the LLM resolution detail into notes on resolve (CORR-105)", () => {
      const store = createEmptyForeshadowingStore()
      store.items.push({
        id: "fs-1-1", name: "旧钥匙", description: "", status: "planted", plantedChapter: 1,
        advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "",
      })
      const snapshot: ChapterSnapshot = {
        chapterId: "ch-1", chapterNumber: 1, summary: "", characters: [], locations: [],
        organizations: [], items: [], events: [], characterStateChanges: [],
        relationshipChanges: [], knowledgeChanges: [],
        foreshadowingChanges: ["回收伏笔:旧钥匙-钥匙掉进了祠堂水井"],
        newCanonFacts: [], timelineEvents: [], conflicts: [], endingHook: "",
        graphNodes: [], graphEdges: [],
      }
      applyForeshadowingChangesToStore(store, snapshot)
      expect(store.items[0].status).toBe("resolved")
      expect(store.items[0].resolvedChapter).toBe(1)
      expect(store.items[0].notes).toContain("[第1章回收] 钥匙掉进了祠堂水井")
    })

    it("folding two distinct chapters produces two distinct-keyed items (no false dedup)", () => {
      const ch1: ChapterSnapshot = {
        chapterId: "ch-1", chapterNumber: 1, summary: "", characters: [], locations: [],
        organizations: [], items: [], events: [], characterStateChanges: [],
        relationshipChanges: [], knowledgeChanges: [],
        foreshadowingChanges: ["新增伏笔:钥匙-旧钥匙"],
        newCanonFacts: [], timelineEvents: [], conflicts: [], endingHook: "",
        graphNodes: [], graphEdges: [],
      }
      const ch2: ChapterSnapshot = {
        chapterId: "ch-2", chapterNumber: 2, summary: "", characters: [], locations: [],
        organizations: [], items: [], events: [], characterStateChanges: [],
        relationshipChanges: [], knowledgeChanges: [],
        foreshadowingChanges: ["新增伏笔:钥匙-新钥匙线索"],
        newCanonFacts: [], timelineEvents: [], conflicts: [], endingHook: "",
        graphNodes: [], graphEdges: [],
      }

      const store = createEmptyForeshadowingStore()
      applyForeshadowingChangesToStore(store, ch1)
      applyForeshadowingChangesToStore(store, ch2)
      // Same name "钥匙" but DIFFERENT plantedChapter (1 vs 2) → NOT a dedup
      // key collision; both items survive (CORR-104 keys on (name, plantedChapter)).
      expect(store.items).toHaveLength(2)
      expect(store.items.map(i => i.plantedChapter).sort()).toEqual([1, 2])
    })
  })

  describe("CORR-103 applyEmotionalArcsToStore", () => {
    it("re-folding the same snapshot's beat updates in place (no duplicate)", () => {
      const details: Record<string, CharacterDetail> = {
        "主角": { identity: "谨慎", faction: "族人", goals: "查族谱", arcChange: "决意-0.7-发现族谱缺页后决意追查" },
      }
      const snapshot: ChapterSnapshot = {
        chapterId: "ch-1", chapterNumber: 1, summary: "", characters: ["主角"],
        locations: [], organizations: [], items: [], events: [],
        characterStateChanges: [], relationshipChanges: [], knowledgeChanges: [],
        foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [],
        conflicts: [], endingHook: "", graphNodes: [], graphEdges: [],
        characterDetails: details,
      }

      // No alias maps needed — canonical name falls back to rawName when
      // resolveMatchingMap returns undefined (single-character scene).
      const aliasMaps: readonly NameAliasMap[] = []

      // First fold: plants one beat for (主角, ch1).
      const store = createEmptyEmotionalArcStore()
      applyEmotionalArcsToStore(store, snapshot, aliasMaps)
      expect(store.beats).toHaveLength(1)
      expect(store.beats[0].character).toBe("主角")
      expect(store.beats[0].chapterNumber).toBe(1)

      // Re-fold the SAME snapshot (live re-ingest). CORR-103: MUST update the
      // existing beat in place, NOT append a duplicate. Length stays 1.
      applyEmotionalArcsToStore(store, snapshot, aliasMaps)
      expect(store.beats).toHaveLength(1)
      expect(store.beats[0].character).toBe("主角")
      expect(store.beats[0].chapterNumber).toBe(1)
    })

    it("folding two chapters for the same character yields two beats (keyed by chapter)", () => {
      const details1: Record<string, CharacterDetail> = {
        "主角": { identity: "", faction: "", goals: "", arcChange: "惊-0.5-初见族谱缺页" },
      }
      const details2: Record<string, CharacterDetail> = {
        "主角": { identity: "", faction: "", goals: "", arcChange: "决意-0.8-决定追查到底" },
      }
      const ch1: ChapterSnapshot = {
        chapterId: "ch-1", chapterNumber: 1, summary: "", characters: ["主角"],
        locations: [], organizations: [], items: [], events: [],
        characterStateChanges: [], relationshipChanges: [], knowledgeChanges: [],
        foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [],
        conflicts: [], endingHook: "", graphNodes: [], graphEdges: [],
        characterDetails: details1,
      }
      const ch2: ChapterSnapshot = {
        chapterId: "ch-2", chapterNumber: 2, summary: "", characters: ["主角"],
        locations: [], organizations: [], items: [], events: [],
        characterStateChanges: [], relationshipChanges: [], knowledgeChanges: [],
        foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [],
        conflicts: [], endingHook: "", graphNodes: [], graphEdges: [],
        characterDetails: details2,
      }

      const store = createEmptyEmotionalArcStore()
      const aliasMaps: readonly NameAliasMap[] = []
      applyEmotionalArcsToStore(store, ch1, aliasMaps)
      applyEmotionalArcsToStore(store, ch2, aliasMaps)
      // Same character, DIFFERENT chapterNumber → two beats (CORR-103 keys on
      // (character, chapterNumber)). Re-folding ch1 after ch2 must NOT touch
      // ch2's beat.
      expect(store.beats).toHaveLength(2)
      applyEmotionalArcsToStore(store, ch1, aliasMaps)
      expect(store.beats).toHaveLength(2)
    })
  })
})

describe("P2-IMP-09 同章修订 re-ingest → live==replay 等值（encounter/particle 两投影）", () => {
  // live：同一章先后两次 ingest（内容修订，同键）；replay：从 committed（修订后）
  // 快照序列一次性 fold。同键 upsert 末条胜保证两次 ingest 的 live 与单次 fold 的
  // replay 哈希等值（truthStoreHash 即 truth_fold_drift 的可执行定义）。
  const aliasMaps: readonly NameAliasMap[] = []
  const foldCtx = { now: "2026-09-05T00:00:00.000Z" }

  function snapshotWith(overrides: Partial<ChapterSnapshot>): ChapterSnapshot {
    return {
      chapterId: "ch-1",
      chapterNumber: 1,
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
    }
  }

  it("encounter-matrix：同章修订（同键内容变）→ live==replay 等值且不重复", async () => {
    const v1 = snapshotWith({ characters: ["甲", "乙"] })
    // 修订：同章新增共现角色 → (甲,乙,1) 同键但 witnessedBy 内容变
    const v2 = snapshotWith({ characters: ["甲", "乙", "丙"] })

    let live = createEmptyEncounterMatrixStore()
    for (const edge of foldMeetingEdges(v1, aliasMaps)) live = appendMeetingEdge(live, edge, foldCtx)
    for (const edge of foldMeetingEdges(v2, aliasMaps)) live = appendMeetingEdge(live, edge, foldCtx)

    let replay = createEmptyEncounterMatrixStore()
    for (const edge of foldMeetingEdges(v2, aliasMaps)) replay = appendMeetingEdge(replay, edge, foldCtx)

    expect(live.edges).toHaveLength(3)
    expect(replay.edges).toHaveLength(3)
    // 同键 (甲,乙,1) 被修订内容（witnessedBy=[丙]）末条胜覆盖，不再残留旧内容
    expect(live.edges.find((e) => e.a === "甲" && e.b === "乙")?.witnessedBy).toEqual(["丙"])
    expect(await truthStoreHash(live)).toBe(await truthStoreHash(replay))
  })

  it("particle-ledger：同章修订（同键内容变）→ live==replay 等值且不重复", async () => {
    const v1 = snapshotWith({ characterStateChanges: ["林墨：受伤-左臂已服丹药，次日好转，痛缓"] })
    // 修订：同 key（injury,林墨,name=前12字,chapter1）state 尾段变化
    const v2 = snapshotWith({ characterStateChanges: ["林墨：受伤-左臂已服丹药，次日好转，痊愈"] })

    let live = createEmptyParticleLedgerStore()
    for (const entry of foldParticleEntries(v1, aliasMaps)) live = appendParticleEntry(live, entry, foldCtx)
    for (const entry of foldParticleEntries(v2, aliasMaps)) live = appendParticleEntry(live, entry, foldCtx)

    let replay = createEmptyParticleLedgerStore()
    for (const entry of foldParticleEntries(v2, aliasMaps)) replay = appendParticleEntry(replay, entry, foldCtx)

    expect(live.entries).toHaveLength(1)
    expect(replay.entries).toHaveLength(1)
    expect(live.entries[0].state).toContain("痊愈")
    expect(await truthStoreHash(live)).toBe(await truthStoreHash(replay))
  })

  it("同章无修订 re-ingest（内容没变）→ no-op，live==replay 仍等值", async () => {
    const v1 = snapshotWith({ characters: ["甲", "乙"] })
    let live = createEmptyEncounterMatrixStore()
    for (const edge of foldMeetingEdges(v1, aliasMaps)) live = appendMeetingEdge(live, edge, foldCtx)
    for (const edge of foldMeetingEdges(v1, aliasMaps)) live = appendMeetingEdge(live, edge, foldCtx)
    let replay = createEmptyEncounterMatrixStore()
    for (const edge of foldMeetingEdges(v1, aliasMaps)) replay = appendMeetingEdge(replay, edge, foldCtx)
    expect(live.edges).toHaveLength(1)
    expect(await truthStoreHash(live)).toBe(await truthStoreHash(replay))
  })
})
