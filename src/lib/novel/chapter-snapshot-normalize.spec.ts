import { describe, expect, it } from "vitest"
import {
  buildAliasMapsFromSnapshot,
  buildSnapshotRevisionId,
  ensureSnapshotIdentity,
  inferSnapshotSourceSequence,
  inferSnapshotSourceType,
  normalizeChapterSnapshot,
  normalizeEntityFlags,
  normalizePositiveInteger,
  normalizeSnapshotAliasRecord,
  normalizeSnapshotDetailRecord,
  normalizeSnapshotList,
  normalizeSnapshotText,
  normalizeValidationWarnings,
} from "./chapter-snapshot-normalize"
import type { ChapterSnapshot } from "./chapter-ingest"

describe("normalizeSnapshotText", () => {
  it("keeps strings and stringifies numbers/booleans, everything else becomes empty", () => {
    expect(normalizeSnapshotText("abc")).toBe("abc")
    expect(normalizeSnapshotText(42)).toBe("42")
    expect(normalizeSnapshotText(true)).toBe("true")
    expect(normalizeSnapshotText(null)).toBe("")
    expect(normalizeSnapshotText(undefined)).toBe("")
    expect(normalizeSnapshotText({})).toBe("")
    expect(normalizeSnapshotText([])).toBe("")
  })
})

describe("normalizePositiveInteger", () => {
  it("returns positive integers only", () => {
    expect(normalizePositiveInteger(5)).toBe(5)
    expect(normalizePositiveInteger("7")).toBe(7)
    expect(normalizePositiveInteger(0)).toBeUndefined()
    expect(normalizePositiveInteger(-3)).toBeUndefined()
    // parseChapterNumber accepts any finite positive number (integer check is not applied)
    expect(normalizePositiveInteger(1.5)).toBe(1.5)
    expect(normalizePositiveInteger("abc")).toBeUndefined()
    expect(normalizePositiveInteger(null)).toBeUndefined()
    expect(normalizePositiveInteger(Number.NaN)).toBeUndefined()
  })
})

describe("normalizeSnapshotList", () => {
  it("normalizes array items, trims and drops empties", () => {
    expect(normalizeSnapshotList([" a ", " b", "", 3, null, "  "])).toEqual(["a", "b", "3"])
  })

  it("wraps a single value into a list", () => {
    expect(normalizeSnapshotList("solo")).toEqual(["solo"])
    expect(normalizeSnapshotList(9)).toEqual(["9"])
  })

  it("returns empty list for empty/absent values", () => {
    expect(normalizeSnapshotList(undefined)).toEqual([])
    expect(normalizeSnapshotList("")).toEqual([])
    expect(normalizeSnapshotList("   ")).toEqual([])
    expect(normalizeSnapshotList({})).toEqual([])
  })
})

describe("normalizeSnapshotAliasRecord", () => {
  it("builds a trimmed alias record, dropping empty aliases and names", () => {
    expect(normalizeSnapshotAliasRecord({ " 菜月昴 ": [" 昴 ", ""], "": ["x"] })).toEqual({ 菜月昴: ["昴"] })
  })

  it("returns undefined for absent / non-object / empty record", () => {
    expect(normalizeSnapshotAliasRecord(undefined)).toBeUndefined()
    expect(normalizeSnapshotAliasRecord("x")).toBeUndefined()
    expect(normalizeSnapshotAliasRecord([])).toBeUndefined()
    expect(normalizeSnapshotAliasRecord({ a: [] })).toBeUndefined()
  })
})

describe("buildAliasMapsFromSnapshot", () => {
  it("builds NameAliasMap entries from characterAliases, skipping blank canonical names", () => {
    const maps = buildAliasMapsFromSnapshot({
      characterAliases: { 菜月昴: ["昴"], "": ["x"] },
    } as unknown as ChapterSnapshot)
    expect(maps).toBeDefined()
    expect(maps!.map((m) => m.canonical)).toEqual(["菜月昴"])
  })

  it("returns undefined when no aliases", () => {
    expect(buildAliasMapsFromSnapshot({} as unknown as ChapterSnapshot)).toBeUndefined()
    expect(buildAliasMapsFromSnapshot({ characterAliases: {} } as unknown as ChapterSnapshot)).toBeUndefined()
    // null-valued alias entry exercises the `aliases ?? []` guard
    const withNull = buildAliasMapsFromSnapshot({ characterAliases: { 菜月昴: null } } as unknown as ChapterSnapshot)
    expect(withNull).toBeDefined()
  })
})

describe("normalizeEntityFlags / normalizeValidationWarnings / normalizeSnapshotDetailRecord", () => {
  it("normalizes entity flags to booleans", () => {
    expect(normalizeEntityFlags({ a: 1, b: 0, "": true })).toEqual({ a: true, b: false })
    expect(normalizeEntityFlags(undefined)).toBeUndefined()
    expect(normalizeEntityFlags("x")).toBeUndefined()
  })

  it("normalizes validation warnings, keeping only known types with messages", () => {
    expect(normalizeValidationWarnings([
      { type: "entity_new", message: " 新角色: 阿宁 " },
      { type: "canon_conflict", message: "冲突" },
      { type: "bogus", message: "忽略" },
      { message: "no type" },
      null,
      "string",
    ])).toEqual([
      { type: "entity_new", message: "新角色: 阿宁" },
      { type: "canon_conflict", message: "冲突" },
    ])
    expect(normalizeValidationWarnings([{ type: "entity_new", message: "  " }])).toBeUndefined()
    expect(normalizeValidationWarnings("nope")).toBeUndefined()
  })

  it("passes through detail records as-is", () => {
    const details = { 阿宁: { identity: "主角" } }
    expect(normalizeSnapshotDetailRecord(details)).toBe(details)
    expect(normalizeSnapshotDetailRecord(null)).toBeUndefined()
    expect(normalizeSnapshotDetailRecord([])).toBeUndefined()
  })
})

describe("normalizeChapterSnapshot", () => {
  it("returns null for non-object payloads", () => {
    expect(normalizeChapterSnapshot(null)).toBeNull()
    expect(normalizeChapterSnapshot("x")).toBeNull()
    expect(normalizeChapterSnapshot([])).toBeNull()
    expect(normalizeChapterSnapshot(undefined)).toBeNull()
  })

  it("normalizes a full payload into a ChapterSnapshot", () => {
    const snapshot = normalizeChapterSnapshot({
      chapterId: "chapter-3",
      chapterNumber: "3",
      chapterTitle: "第3章 夜",
      summary: "摘要",
      characters: ["阿宁"],
      characterAliases: { 阿宁: ["宁"] },
      locations: ["码头"],
      organizations: ["商会"],
      items: ["剑"],
      events: ["大战"],
      characterStateChanges: ["阿宁：受伤"],
      relationshipChanges: [],
      knowledgeChanges: ["阿宁知道秘密"],
      foreshadowingChanges: ["新增：黑剑-伏笔"],
      newCanonFacts: ["阿宁是主角"],
      timelineEvents: ["第三天：出发"],
      conflicts: ["对峙"],
      endingHook: "钩子",
      graphNodes: ["角色:阿宁"],
      graphEdges: ["阿宁->出场于->码头"],
      sourceType: "chapter",
      sourceSequence: 3,
      revision: 2,
      snapshotId: "chapter-3-r2",
      supersedes: "chapter-3-r1",
      isHistorical: false,
      entityIsNew: { 阿宁: true },
      validationWarnings: [{ type: "entity_new", message: "新角色" }],
      memorySyncedAt: "2026-06-09T00:00:00.000Z",
      characterDetails: { 阿宁: { identity: "主角" } },
      itemDetails: { 剑: { holder: "阿宁" } },
    } as unknown as Record<string, unknown>, { chapterId: "chapter-3", chapterNumber: 3 })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.chapterId).toBe("chapter-3")
    expect(snapshot!.chapterNumber).toBe(3)
    expect(snapshot!.summary).toBe("摘要")
    expect(snapshot!.characters).toEqual(["阿宁"])
    expect(snapshot!.characterAliases).toEqual({ 阿宁: ["宁"] })
    expect(snapshot!.sourceType).toBe("chapter")
    expect(snapshot!.revision).toBe(2)
    expect(snapshot!.entityIsNew).toEqual({ 阿宁: true })
    expect(snapshot!.validationWarnings).toEqual([{ type: "entity_new", message: "新角色" }])
    expect(snapshot!.characterDetails).toEqual({ 阿宁: { identity: "主角" } })
  })

  it("applies fallback chapterId/chapterNumber and rejects invalid sourceType", () => {
    const snapshot = normalizeChapterSnapshot({ summary: "s" }, { chapterId: "chapter-9", chapterNumber: 9 })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.chapterId).toBe("chapter-9")
    expect(snapshot!.chapterNumber).toBe(9)
    expect(snapshot!.sourceType).toBeUndefined()

    const weird = normalizeChapterSnapshot({ chapterNumber: 2, sourceType: "bogus" }, { chapterId: "x", chapterNumber: 2 })
    expect(weird!.sourceType).toBeUndefined()
  })

  it("derives default chapterId from chapterNumber", () => {
    const snapshot = normalizeChapterSnapshot({ chapterNumber: 4 })
    expect(snapshot!.chapterId).toBe("chapter-4")
  })

  it("falls back to 0 when chapterNumber is missing entirely and no fallback is provided", () => {
    const snapshot = normalizeChapterSnapshot({ summary: "s" })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.chapterNumber).toBe(0)
    expect(snapshot!.chapterId).toBe("chapter-0")
  })
})

describe("identity helpers", () => {
  it("infers source type and sequence from sign/magnitude of chapterNumber", () => {
    expect(inferSnapshotSourceType({ chapterNumber: 5 })).toBe("chapter")
    expect(inferSnapshotSourceType({ chapterNumber: -2 })).toBe("outline")
    expect(inferSnapshotSourceSequence({ chapterNumber: -12 })).toBe(12)
    expect(inferSnapshotSourceSequence({ chapterNumber: 7 })).toBe(7)
  })

  it("builds snapshot revision ids", () => {
    expect(buildSnapshotRevisionId({ chapterId: "chapter-1" }, 3)).toBe("chapter-1-r3")
  })

  it("ensureSnapshotIdentity fills defaults and honors overrides", () => {
    const base = {
      chapterId: "chapter-1",
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
    } as unknown as ChapterSnapshot

    const identified = ensureSnapshotIdentity(base)
    expect(identified.sourceType).toBe("chapter")
    expect(identified.sourceSequence).toBe(1)
    expect(identified.revision).toBe(1)
    expect(identified.snapshotId).toBe("chapter-1-r1")
    expect(identified.isHistorical).toBe(false)

    const overridden = ensureSnapshotIdentity(base, {
      sourceType: "outline",
      sourceSequence: 9,
      revision: 4,
      snapshotId: "outline-9-r4",
      supersedes: "old",
      isHistorical: true,
    })
    expect(overridden.sourceType).toBe("outline")
    expect(overridden.sourceSequence).toBe(9)
    expect(overridden.revision).toBe(4)
    expect(overridden.supersedes).toBe("old")
    expect(overridden.isHistorical).toBe(true)

    const preserved = ensureSnapshotIdentity({ ...base, sourceType: "outline", sourceSequence: 3, revision: 2, snapshotId: "id", supersedes: "s", isHistorical: true })
    expect(preserved.sourceType).toBe("outline")
    expect(preserved.sourceSequence).toBe(3)
    expect(preserved.revision).toBe(2)
    expect(preserved.supersedes).toBe("s")
    expect(preserved.isHistorical).toBe(true)
  })
})
