import { describe, expect, it } from "vitest"
import {
  applyWikiUpdatePatch,
  buildChapterIngestOutput,
  type SharedWikiState,
  type WikiUpdatePatch,
} from "./chapter-ingest-output"
import type { ChapterSnapshot } from "./chapter-ingest"

function makeSnapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "chapter-1",
    chapterNumber: 1,
    chapterTitle: "第1章 夜",
    summary: "章节摘要",
    characters: ["阿宁"],
    characterAliases: { 阿宁: ["宁"] },
    locations: ["码头"],
    organizations: ["商会"],
    items: ["断水剑"],
    events: ["大战"],
    characterStateChanges: ["阿宁：受伤"],
    relationshipChanges: ["阿宁与苏未晞友好"],
    knowledgeChanges: ["阿宁知道秘密"],
    foreshadowingChanges: ["新增：黑剑-主角佩剑"],
    newCanonFacts: ["阿宁是主角"],
    timelineEvents: ["第三天：阿宁抵达码头"],
    conflicts: ["对峙"],
    endingHook: "结尾钩子",
    graphNodes: ["角色:阿宁", "chapter:1"],
    graphEdges: ["阿宁->出场于->码头"],
    characterDetails: { 阿宁: { identity: "主角", faction: "无", goals: "复仇", arcChange: "成长" } },
    locationDetails: { 码头: { region: "东城", type: "港口", controller: "商会", hiddenInfo: "密道" } },
    organizationDetails: { 商会: { leader: "陈老板", members: "若干", goals: "垄断", resources: "银两" } },
    itemDetails: { 断水剑: { holder: "阿宁", previousHolders: "老掌门", abilities: "断水", limitations: "认主", origin: "祖传" } },
    eventDetails: { 大战: { cause: "夺剑", process: "激战", relatedForeshadowing: "黑剑", relatedConflicts: "对峙", followUpItems: "疗伤" } },
    sourceType: "chapter",
    sourceSequence: 1,
    revision: 1,
    snapshotId: "chapter-1-r1",
    ...overrides,
  }
}

describe("buildChapterIngestOutput", () => {
  it("builds all five output sections with defaults", () => {
    const output = buildChapterIngestOutput(makeSnapshot())
    expect(output.snapshotWikiFields.chapterNumber).toBe(1)
    expect(output.snapshotWikiFields.title).toBe("第1章")
    expect(output.snapshotWikiFields.canonStatus).toBe("confirmed")
    expect(output.snapshotWikiFields.summary).toBe("章节摘要")
    expect(output.snapshotWikiFields.endingHook).toBe("结尾钩子")
    expect(output.snapshotWikiFields.volume).toBe("")
    expect(output.wikiUpdatePatch.sharedWiki).toBe(true)
    expect(output.wikiUpdatePatch.entries.length).toBeGreaterThan(5)
    expect(output.graphDerivation.nodes.length).toBeGreaterThan(0)
    expect(output.graphDerivation.edges.length).toBeGreaterThan(0)
    expect(output.searchIndexText.documentId).toBe("chapter:1")
    expect(output.searchIndexText.sections.length).toBeGreaterThan(0)
    expect(output.vectorIndexText.documentId).toBe("chapter:1")
    expect(output.vectorIndexText.chunks.length).toBeGreaterThan(0)
  })

  it("honors options: title, volume, chapterGoal, endingState, outlineNodeIds, sourceQuotes, now", () => {
    const output = buildChapterIngestOutput(makeSnapshot(), {
      title: "自定义标题",
      volume: "第一卷",
      chapterGoal: "引入冲突",
      endingState: "对峙升级",
      outlineNodeIds: ["outline-1"],
      sourceQuotes: ["原文引用"],
      now: "2026-06-09T00:00:00.000Z",
    })
    expect(output.snapshotWikiFields.title).toBe("自定义标题")
    expect(output.snapshotWikiFields.volume).toBe("第一卷")
    expect(output.snapshotWikiFields.chapterGoal).toBe("引入冲突")
    expect(output.snapshotWikiFields.endingState).toBe("对峙升级")
    expect(output.snapshotWikiFields.outlineNodeIds).toEqual(["outline-1"])
    expect(output.snapshotWikiFields.sourceQuotes).toEqual(["原文引用"])
    expect(output.snapshotWikiFields.createdAt).toBe("2026-06-09T00:00:00.000Z")
    expect(output.wikiUpdatePatch.entries[0]!.sources[0]!.evidence).toBe("原文引用")
  })

  it("canonicalizes characters before building fields (aliases collapse)", () => {
    const snapshot = makeSnapshot({
      characters: ["阿宁", "宁"],
      characterAliases: { 阿宁: ["宁"] },
    })
    const output = buildChapterIngestOutput(snapshot)
    const characterEntries = output.wikiUpdatePatch.entries.filter((e) => e.entryType === "character")
    expect(characterEntries.map((e) => e.entryId)).toEqual(["character:阿宁"])
    expect(characterEntries[0]!.fields.aliases).toEqual(["宁"])
    expect(characterEntries[0]!.fields.appearanceChapters).toEqual([1])
    expect(characterEntries[0]!.fields.currentState).toBe("受伤")
    expect(characterEntries[0]!.fields.relationshipSummary).toEqual(["阿宁与苏未晞友好"])
    expect(characterEntries[0]!.fields.cognition).toEqual({ knows: ["秘密"], doesNotKnow: [] })
    expect(characterEntries[0]!.fields.identity).toBe("主角")
  })

  it("builds entry fields for locations, organizations, items and events", () => {
    const output = buildChapterIngestOutput(makeSnapshot())
    const entries = output.wikiUpdatePatch.entries
    const location = entries.find((e) => e.entryType === "location")!
    expect(location.fields).toMatchObject({
      name: "码头",
      relatedChapters: [1],
      keyEvents: ["大战"],
      stateChanges: ["第三天：阿宁抵达码头"],
      region: "东城",
    })
    const org = entries.find((e) => e.entryType === "organization")!
    expect(org.fields).toMatchObject({ name: "商会", relatedChapters: [1], currentState: "", leader: "陈老板" })
    const item = entries.find((e) => e.entryType === "item")!
    expect(item.fields).toMatchObject({ name: "断水剑", relatedChapters: [1], relatedEvents: ["大战"], holder: "阿宁" })
    const event = entries.find((e) => e.entryType === "event")!
    expect(event.fields).toMatchObject({
      name: "大战",
      chapterNumber: 1,
      participants: ["阿宁"],
      locations: ["码头"],
      organizations: ["商会"],
      result: "章节摘要",
      impacts: ["阿宁：受伤"],
      cause: "夺剑",
    })
  })

  it("builds foreshadowing/secret/conflict/timeline/canon-rule entries", () => {
    const output = buildChapterIngestOutput(makeSnapshot())
    const entries = output.wikiUpdatePatch.entries
    const foreshadowing = entries.find((e) => e.entryType === "foreshadowing")!
    expect(foreshadowing.entryId).toBe("foreshadowing:黑剑-主角佩剑")
    expect(foreshadowing.fields.status).toBe("created")
    expect(foreshadowing.fields.evidence).toBe("新增：黑剑-主角佩剑")

    const secret = entries.find((e) => e.entryType === "secret")!
    expect(secret.fields.content).toBe("阿宁知道秘密")
    expect(secret.fields.cognition).toEqual({ subject: "阿宁", content: "秘密" })

    const conflict = entries.find((e) => e.entryType === "conflict")!
    expect(conflict.fields).toMatchObject({ name: "对峙", chapterNumber: 1, participants: ["阿宁"] })

    const timeline = entries.find((e) => e.entryType === "timeline")!
    expect(timeline.fields.timePoint).toBe("第三天")
    expect(timeline.fields.eventSummary).toBe("第三天：阿宁抵达码头")

    const canon = entries.find((e) => e.entryType === "canon-rule")!
    expect(canon.fields).toMatchObject({ rule: "阿宁是主角", sourceChapter: 1, constraintStrength: "confirmed" })
  })

  it("foreshadowing status resolves advanced/resolved by prefix", () => {
    const snapshot = makeSnapshot({
      foreshadowingChanges: ["推进：黑剑", "回收：旧案"],
      knowledgeChanges: [],
      conflicts: [],
      timelineEvents: [],
    })
    const output = buildChapterIngestOutput(snapshot)
    const entries = output.wikiUpdatePatch.entries.filter((e) => e.entryType === "foreshadowing")
    expect(entries.find((e) => e.entryId.includes("黑剑"))!.fields.status).toBe("advanced")
    expect(entries.find((e) => e.entryId.includes("旧案"))!.fields.status).toBe("resolved")
  })

  it("deduplicates graph nodes by id and keeps parsed + derived nodes", () => {
    const snapshot = makeSnapshot({
      graphNodes: ["角色:阿宁", "角色:阿宁", "location:码头", "bogus-node"],
    })
    const output = buildChapterIngestOutput(snapshot)
    const ids = output.graphDerivation.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("character:阿宁")
    expect(ids).toContain("location:码头")
    expect(ids).toContain("chapter:1")
  })

  it("parses graph edges with type/relation normalization and dedupe", () => {
    const snapshot = makeSnapshot({
      graphEdges: ["阿宁->出场于->码头", "阿宁 -> 持有 -> 断水剑", "阿宁->未知关系->码头"],
    })
    const output = buildChapterIngestOutput(snapshot)
    const relations = output.graphDerivation.edges.map((e) => e.relation)
    expect(relations).toContain("APPEARS_IN")
    expect(relations).toContain("HAS_ITEM")
    // unknown relation falls back to AFFECTS (SEC-004)
    expect(relations).toContain("AFFECTS")
    expect(output.graphDerivation.edges.every((e) => e.sourceRef.chapterNumber === 1)).toBe(true)
  })

  it("search index sections filter out blank content", () => {
    const snapshot = makeSnapshot({
      summary: "有摘要",
      characters: [],
      characterAliases: undefined,
      locations: [],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      conflicts: [],
      timelineEvents: [],
      newCanonFacts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
    })
    const output = buildChapterIngestOutput(snapshot)
    expect(output.searchIndexText.sections.map((s) => s.name)).toEqual(["摘要"])
    expect(output.vectorIndexText.chunks.map((c) => c.kind)).toEqual(["summary"])
  })
})

describe("applyWikiUpdatePatch", () => {
  it("creates state from undefined and tracks chapter entry ids", () => {
    const patch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        { entryId: "chapter:1", entryType: "chapter", title: "第1章", mergeStrategy: "merge-by-entry-id", fields: { summary: "s" }, sources: [{ chapterNumber: 1, snapshotId: "chapter-1-r1" }] },
      ],
    }
    const state = applyWikiUpdatePatch(undefined, patch)
    expect(state.sharedWiki).toBe(true)
    expect(state.chapterWikiIds).toEqual(["chapter:1"])
    expect(state.entries["chapter:1"]!.title).toBe("第1章")
  })

  it("merges into an existing state without mutating it", () => {
    const existing: SharedWikiState = {
      sharedWiki: true,
      entries: {
        "character:阿宁": {
          entryId: "character:阿宁",
          entryType: "character",
          title: "阿宁",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "阿宁", appearanceChapters: [1] },
          sources: [{ chapterNumber: 1, snapshotId: "chapter-1-r1" }],
        },
      },
      chapterWikiIds: [],
      isolatedChapterWikiIds: [],
    }
    const patch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:阿宁",
          entryType: "character",
          title: "阿宁",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "阿宁", appearanceChapters: [2], aliases: ["宁"] },
          sources: [{ chapterNumber: 2, snapshotId: "chapter-2-r1" }],
        },
      ],
    }
    const state = applyWikiUpdatePatch(existing, patch)
    expect(state.entries["character:阿宁"]!.fields.appearanceChapters).toEqual([1, 2])
    expect(state.entries["character:阿宁"]!.sources).toHaveLength(2)
    // original state untouched
    expect(existing.entries["character:阿宁"]!.fields.appearanceChapters).toEqual([1])
    expect(existing.entries["character:阿宁"]!.sources).toHaveLength(1)
  })

  it("deep-merges nested record fields and skips empty string values", () => {
    const existing: SharedWikiState = {
      sharedWiki: true,
      entries: {
        "character:阿宁": {
          entryId: "character:阿宁",
          entryType: "character",
          title: "阿宁",
          mergeStrategy: "merge-by-entry-id",
          fields: { details: { identity: "主角", faction: "旧" }, name: "阿宁" },
          sources: [],
        },
      },
      chapterWikiIds: [],
      isolatedChapterWikiIds: [],
    }
    const patch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:阿宁",
          entryType: "character",
          title: "阿宁",
          mergeStrategy: "merge-by-entry-id",
          fields: { details: { faction: "新" }, name: "" },
          sources: [],
        },
      ],
    }
    const state = applyWikiUpdatePatch(existing, patch)
    expect(state.entries["character:阿宁"]!.fields.details).toEqual({ identity: "主角", faction: "新" })
    // empty string did not overwrite
    expect(state.entries["character:阿宁"]!.fields.name).toBe("阿宁")
  })

  it("keeps chapterWikiIds unique across repeated chapter entries", () => {
    const patch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        { entryId: "chapter:1", entryType: "chapter", title: "第1章", mergeStrategy: "merge-by-entry-id", fields: {}, sources: [] },
        { entryId: "chapter:1", entryType: "chapter", title: "第1章", mergeStrategy: "merge-by-entry-id", fields: {}, sources: [] },
      ],
    }
    const state = applyWikiUpdatePatch(undefined, patch)
    expect(state.chapterWikiIds).toEqual(["chapter:1"])
  })

  it("mergeSources dedupes by (chapterNumber, snapshotId, evidence) triple", () => {
    const existing: SharedWikiState = {
      sharedWiki: true,
      entries: {
        "character:阿宁": {
          entryId: "character:阿宁",
          entryType: "character",
          title: "阿宁",
          mergeStrategy: "merge-by-entry-id",
          fields: {},
          sources: [{ chapterNumber: 1, snapshotId: "chapter-1-r1" }],
        },
      },
      chapterWikiIds: [],
      isolatedChapterWikiIds: [],
    }
    const patch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:阿宁",
          entryType: "character",
          title: "阿宁",
          mergeStrategy: "merge-by-entry-id",
          fields: {},
          // duplicate triple: chapterNumber+snapshotId+evidence all match -> skipped
          sources: [{ chapterNumber: 1, snapshotId: "chapter-1-r1" }],
        },
      ],
    }
    const state = applyWikiUpdatePatch(existing, patch)
    expect(state.entries["character:阿宁"]!.sources).toHaveLength(1)
  })

  it("mergeSources keeps distinct snapshotIds and evidence values with the same chapterNumber", () => {
    const patch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:甲",
          entryType: "character",
          title: "甲",
          mergeStrategy: "merge-by-entry-id",
          fields: {},
          sources: [
            { chapterNumber: 1, snapshotId: "chapter-1-r1" },
            { chapterNumber: 1, snapshotId: "chapter-1-r2" },
            { chapterNumber: 1, snapshotId: "chapter-1-r2", evidence: "引文" },
          ],
        },
      ],
    }
    const state = applyWikiUpdatePatch(undefined, patch)
    expect(state.entries["character:甲"]!.sources).toHaveLength(3)
  })

  it("cognition flips for doesNotKnow changes and changes without 知道", () => {
    const snapshot = makeSnapshot({
      knowledgeChanges: ["阿宁不知道真相", "纯叙述记录"],
    })
    const output = buildChapterIngestOutput(snapshot)
    const characterEntry = output.wikiUpdatePatch.entries.find((e) => e.entryType === "character")!
    expect(characterEntry.fields.cognition).toEqual({ knows: [], doesNotKnow: ["真相"] })
    const secretEntries = output.wikiUpdatePatch.entries.filter((e) => e.entryType === "secret")
    const plain = secretEntries.find((e) => e.fields.content === "纯叙述记录")!
    expect(plain.fields.cognition).toEqual({ content: "纯叙述记录" })
  })

  it("builds character entries without aliases and skips missing detail records", () => {
    const snapshot = makeSnapshot({
      characters: ["无别名角色"],
      characterAliases: undefined,
      characterDetails: undefined,
      locationDetails: undefined,
      organizationDetails: undefined,
      itemDetails: undefined,
      eventDetails: undefined,
      characterStateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      timelineEvents: [],
      conflicts: [],
      newCanonFacts: [],
    })
    const output = buildChapterIngestOutput(snapshot)
    const characterEntry = output.wikiUpdatePatch.entries.find((e) => e.entryType === "character")!
    expect(characterEntry.fields).not.toHaveProperty("aliases")
    expect(characterEntry.fields.currentState).toBe("")
    expect(characterEntry.fields.cognition).toEqual({ knows: [], doesNotKnow: [] })
    expect(characterEntry.fields).not.toHaveProperty("identity")

    // entry names NOT present in the corresponding details record exercise the `?? {}` guards
    const locationEntry = output.wikiUpdatePatch.entries.find((e) => e.entryType === "location")!
    expect(locationEntry.fields).not.toHaveProperty("region")
    const orgEntry = output.wikiUpdatePatch.entries.find((e) => e.entryType === "organization")!
    expect(orgEntry.fields).not.toHaveProperty("leader")
    const itemEntry = output.wikiUpdatePatch.entries.find((e) => e.entryType === "item")!
    expect(itemEntry.fields).not.toHaveProperty("holder")
    const eventEntry = output.wikiUpdatePatch.entries.find((e) => e.entryType === "event")!
    expect(eventEntry.fields).not.toHaveProperty("cause")
  })
})
