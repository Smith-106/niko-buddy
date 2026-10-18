/**
 * asset-linkage-audit.spec.ts — 联动诊断的**可失败**行为证据。
 *
 * 覆盖五条契约：①一致时零冲突 ②改 note 但产物仍旧 → 恰好一条 drift
 * ③快照有关系、状态空 → snapshot_relation_not_in_state ④图谱键缺/多各一条、不传则整面 N/A
 * ⑤函数无副作用（不改入参）。
 */
import { describe, expect, it } from "vitest"

import { auditAssetLinkage } from "./asset-linkage-audit"
import { buildLibraryArtifact } from "./asset-library"
import { deriveRelationshipEntries } from "./setting-projection"
import type { CharacterState } from "./character-state"

type Person = Pick<
  CharacterState,
  "characterName" | "relationships" | "currentLocation" | "status" | "equipment" | "abilities" | "lastUpdatedChapter" | "lastUpdatedAt"
>

const STUB = {
  currentLocation: "北门",
  status: "active",
  equipment: [] as string[],
  abilities: [] as string[],
  lastUpdatedChapter: 3,
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
}

const PEOPLE: Person[] = [
  { ...STUB, characterName: "甲", relationships: { 乙: "盟友，共守北门" } },
  { ...STUB, characterName: "乙", relationships: { 甲: "盟友，共守北门" } },
]

function artifactFor(characters: readonly Person[]) {
  const artifact = buildLibraryArtifact({
    libraryId: "relationship_edge",
    generatorVersion: "spec",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: deriveRelationshipEntries({ characters }),
  })
  return { contentHash: artifact.contentHash, entryCount: artifact.entries.length }
}

const COVERING_LINE = { chapterNumber: 3, text: "甲与乙结盟，共守北门" }

describe("①一致：零冲突", () => {
  it("产物 hash 与状态复算一致 + 快照行被状态覆盖 → conflicts 为空", () => {
    const result = auditAssetLinkage({
      characters: PEOPLE,
      relationshipArtifact: artifactFor(PEOPLE),
      snapshotRelationLines: [COVERING_LINE],
    })
    expect(result.conflicts).toEqual([])
    expect(result.derivedEdgeCount).toBe(2)
    expect(result.artifactEdgeCount).toBe(2)
  })
})

describe("②产物陈旧：恰好一条 drift（不返回修好的新产物）", () => {
  it("改 note、产物仍旧 → 一条 relationship_edge_drift，left/right 是对不上的两个 hash", () => {
    const stale = artifactFor(PEOPLE)
    const changed: Person[] = [
      { ...STUB, characterName: "甲", relationships: { 乙: "反目，北门已破" } },
      { ...STUB, characterName: "乙", relationships: { 甲: "反目，北门已破" } },
    ]
    const result = auditAssetLinkage({
      characters: changed,
      relationshipArtifact: stale,
      snapshotRelationLines: [],
    })
    const drift = result.conflicts.filter((c) => c.code === "relationship_edge_drift")
    expect(drift).toHaveLength(1)
    expect(drift[0]!.left).not.toBe(drift[0]!.right)
    expect(drift[0]!.right).toBe(stale.contentHash)
    // 文案必须说清「条数相同 = 内容不同」，不能一律说条数不一致
    expect(drift[0]!.detail).toContain("内容字段不同")
    expect(drift[0]!.detail).not.toContain("条数也不同")
    // 契约：不返回所谓「已修复」的产物
    expect(result).not.toHaveProperty("artifact")
    expect(Object.keys(result).sort()).toEqual([
      "artifactEdgeCount",
      "conflicts",
      "derivedEdgeCount",
      "na",
    ])
  })

  it("产物缺失 → 不是 drift，na 说明属提取缺口且 artifactEdgeCount=null（不写 0）", () => {
    const result = auditAssetLinkage({
      characters: PEOPLE,
      relationshipArtifact: null,
      snapshotRelationLines: [],
    })
    expect(result.conflicts.some((c) => c.code === "relationship_edge_drift")).toBe(false)
    expect(result.artifactEdgeCount).toBeNull()
    expect(result.na.some((line) => line.includes("提取缺口"))).toBe(true)
  })
})

describe("③快照有关系、状态没回填（生产回归锁）", () => {
  it("同行短描述不得盖住长描述的缺口（P1 回归锁）", () => {
    const result = auditAssetLinkage({
      characters: [
        {
          ...STUB,
          characterName: "甲",
          relationships: { 乙: "友", 丙: "宿敌多年，势不两立" },
        },
        { ...STUB, characterName: "丙", relationships: {} },
      ],
      relationshipArtifact: null,
      snapshotRelationLines: [{ chapterNumber: 6, text: "甲与乙决裂，丙旁观" }],
    })
    expect(result.conflicts.some((c) => c.code === "snapshot_relation_not_in_state")).toBe(true)
  })

  it("删标点后粘出的假短语不算覆盖（「共守，北门失守」≠「共守北门」）", () => {
    const result = auditAssetLinkage({
      characters: [{ ...STUB, characterName: "甲", relationships: { 乙: "共守北门" } }],
      relationshipArtifact: null,
      snapshotRelationLines: [{ chapterNumber: 8, text: "甲与乙共守，北门失守" }],
    })
    expect(result.conflicts.some((c) => c.code === "snapshot_relation_not_in_state")).toBe(true)
  })

  it("关系描述过短（<4 字）→ 记 N/A 不计冲突（缺证据 ≠ 缺回填）", () => {
    const result = auditAssetLinkage({
      characters: [{ ...STUB, characterName: "甲", relationships: { 乙: "友" } }],
      relationshipArtifact: null,
      snapshotRelationLines: [{ chapterNumber: 4, text: "甲与乙结盟" }],
    })
    expect(result.conflicts.some((c) => c.code === "snapshot_relation_not_in_state")).toBe(false)
    expect(result.na.some((line) => line.includes("过短"))).toBe(true)
  })

  it("所有角色 relationships 为空 → 一条 snapshot_relation_not_in_state，原文保留", () => {
    const result = auditAssetLinkage({
      characters: [{ ...STUB, characterName: "甲", relationships: {} }],
      relationshipArtifact: null,
      snapshotRelationLines: [COVERING_LINE],
    })
    const hits = result.conflicts.filter((c) => c.code === "snapshot_relation_not_in_state")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.right).toBe(COVERING_LINE.text)
    expect(hits[0]!.left).toBe("第 3 章")
  })

  it("只有同名无内容交集不算覆盖（避免同名不同事被当成已回填）", () => {
    const result = auditAssetLinkage({
      characters: [{ ...STUB, characterName: "甲", relationships: { 乙: "同事，见过一面" } }],
      relationshipArtifact: null,
      snapshotRelationLines: [{ chapterNumber: 9, text: "甲与乙断交" }],
    })
    expect(result.conflicts.some((c) => c.code === "snapshot_relation_not_in_state")).toBe(true)
  })
})

describe("④图谱边对账：缺/多各一条，不传则 N/A", () => {
  const base = {
    characters: PEOPLE,
    relationshipArtifact: null,
    snapshotRelationLines: [] as { chapterNumber: number; text: string }[],
  }

  it("应有未有 → graph_edge_missing；现有不应有 → graph_edge_unbacked，且完整键不丢段", () => {
    const missingKey = "character:甲->ALLY->character:乙"
    const unbackedKey = "character:甲->ENEMY->character:丙"
    const result = auditAssetLinkage({
      ...base,
      graphEdgeKeys: [unbackedKey],
      snapshotGraphEdgeKeys: [missingKey],
    })
    const missing = result.conflicts.filter((c) => c.code === "graph_edge_missing")
    const unbacked = result.conflicts.filter((c) => c.code === "graph_edge_unbacked")
    expect(missing).toHaveLength(1)
    expect(unbacked).toHaveLength(1)
    // 三段键（含关系语义层）不得被截断成 "character:甲 -> ALLY"
    expect(missing[0]!.left).toBe(missingKey)
    expect(missing[0]!.right).toBe(missingKey)
    expect(unbacked[0]!.left).toBe(unbackedKey)
  })

  it("只传一个图谱参数 → 整面 N/A，两类边码都不出现", () => {
    const result = auditAssetLinkage({ ...base, graphEdgeKeys: ["a->b->c"] })
    expect(result.conflicts.some((c) => c.code.startsWith("graph_edge"))).toBe(false)
    expect(result.na.some((line) => line.includes("图谱边"))).toBe(true)
  })
})

describe("⑤无副作用 + 永不误报的面", () => {
  it("入参深度不变（检测不写关系、不改数组）", () => {
    const characters: Person[] = [{ ...STUB, characterName: "甲", relationships: { 乙: "盟友" } }]
    const before = JSON.stringify(characters)
    auditAssetLinkage({
      characters,
      relationshipArtifact: null,
      snapshotRelationLines: [COVERING_LINE],
      graphEdgeKeys: [],
      snapshotGraphEdgeKeys: [],
    })
    expect(JSON.stringify(characters)).toBe(before)
  })

  it("kind=unknown 且 hash 一致时零冲突；na 明确写清语义不猜", () => {
    const result = auditAssetLinkage({
      characters: PEOPLE,
      relationshipArtifact: artifactFor(PEOPLE),
      snapshotRelationLines: [COVERING_LINE],
    })
    // 输入里的 note 只有自由文本、kind 恒 unknown：一致时不应有任何冲突
    expect(result.conflicts).toHaveLength(0)
    expect(result.na.some((line) => line.includes("unknown"))).toBe(true)
  })

  it("审计复算 ≡ deriveRelationshipEntries（含超长 entryId 必须跳过，不抛）", () => {
    const longName = "-".repeat(80)
    const characters: Person[] = [
      { ...STUB, characterName: "甲", relationships: { 乙: "盟友，共守北门", [longName]: "不该入边" } },
      { ...STUB, characterName: "乙", relationships: { 甲: "盟友，共守北门" } },
    ]
    const expected = deriveRelationshipEntries({ characters })
    let result: ReturnType<typeof auditAssetLinkage> | null = null
    expect(() => {
      result = auditAssetLinkage({
        characters,
        relationshipArtifact: null,
        snapshotRelationLines: [],
      })
    }).not.toThrow()
    // entryCount 与迁移入口同口径（超长 id 被跳过 → 少一条）
    expect(result!.derivedEdgeCount).toBe(expected.length)
    expect(expected.length).toBeLessThan(3)
    // 条目深比较：复算出的正是迁移入口那一份（顺序、字段都一致）
    const direct = auditAssetLinkage({
      characters,
      relationshipArtifact: {
        contentHash: buildLibraryArtifact({
          libraryId: "relationship_edge",
          generatorVersion: "spec",
          generatedAt: "2026-01-01T00:00:00.000Z",
          entries: expected,
        }).contentHash,
        entryCount: expected.length,
      },
      snapshotRelationLines: [],
    })
    expect(direct.conflicts).toHaveLength(0)
    // 迁移入口不带 projectId（本诊断也不带）：条目里不应出现 projectId 键
    expect(expected.every((e) => !("projectId" in e))).toBe(true)
  })
})
