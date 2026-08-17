import { describe, expect, it } from "vitest"
import { applyEmotionalArcsToStore, applyForeshadowingChangesToStore } from "./chapter-ingest"
import type { ChapterSnapshot, CharacterDetail } from "./chapter-ingest"
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
