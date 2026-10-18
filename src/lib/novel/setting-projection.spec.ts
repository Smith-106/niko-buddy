/** setting-projection：零新真源只读投影（自由文本关系如实呈现 + 缺口计数）。 */
import { describe, expect, it } from "vitest"

import { projectSettingState } from "./setting-projection"
import type { CharacterState } from "./character-state"

function character(partial: Partial<CharacterState> & { characterName: string }): CharacterState {
  return {
    currentLocation: "",
    status: "",
    equipment: [],
    abilities: [],
    relationships: {},
    lastUpdatedChapter: 1,
    lastUpdatedAt: "2026-10-18T00:00:00.000Z",
    ...partial,
  }
}

describe("projectSettingState", () => {
  it("关系自由文本 → 有向边；空文本关系被丢弃", () => {
    const projection = projectSettingState({
      characters: [
        character({
          characterName: "林砚",
          currentLocation: "青石镇",
          relationships: { 苏晚: "师徒", 赵九: "   " },
          lastUpdatedChapter: 7,
        }),
      ],
    })
    expect(projection.edges).toHaveLength(1)
    expect(projection.edges[0]).toEqual({ from: "林砚", to: "苏晚", description: "师徒", lastChapter: 7 })
    expect(projection.cast[0]?.relationCount).toBe(1)
  })

  it("无关系角色的缺口单独计数（不显示 0 条关系假装完整）", () => {
    const projection = projectSettingState({
      characters: [
        character({ characterName: "A", relationships: {} }),
        character({ characterName: "B", relationships: { C: "敌对" } }),
      ],
    })
    expect(projection.cast).toHaveLength(2)
    expect(projection.charactersWithoutRelations).toBe(1)
  })

  it("isAlive 缺失 → null（不猜存活），明确 false 才表示已退场", () => {
    const projection = projectSettingState({
      characters: [
        character({ characterName: "A" }),
        character({ characterName: "B", isAlive: false }),
      ],
    })
    const byName = Object.fromEntries(projection.cast.map((row) => [row.name, row]))
    expect(byName.A?.isAlive).toBeNull()
    expect(byName.B?.isAlive).toBe(false)
  })

  it("空 store → 空投影（不造角色）", () => {
    const projection = projectSettingState({ characters: [] })
    expect(projection.cast).toEqual([])
    expect(projection.edges).toEqual([])
    expect(projection.charactersWithoutRelations).toBe(0)
  })

  it("输出稳定排序（同输入两次结果一致）", () => {
    const characters = [character({ characterName: "Z" }), character({ characterName: "A" })]
    expect(projectSettingState({ characters }).cast.map((r) => r.name)).toEqual(["A", "Z"])
  })
})

// ── Wave 3B：自由文本关系 → 有 schema 的关系边（确定性、幂等、不猜语义）──
import { RELATIONSHIP_EDGE_ENTRY_SCHEMA, computeLibraryHash, stableStringify } from "./asset-library"
import { buildRelationshipLibraryArtifact, deriveRelationshipEntries, relationshipEntryId } from "./setting-projection"

describe("deriveRelationshipEntries（Wave 3B）", () => {
  it("自由文本 → 边，kind 一律 unknown、原文落 note（不猜师徒/敌对）", () => {
    const edges = deriveRelationshipEntries({
      characters: [character({ characterName: "林砚", relationships: { 苏晚: "师徒" } })],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: "林砚", to: "苏晚", kind: "unknown", note: "师徒" })
    // 强度真源没有 → 不得编数字
    expect(edges[0]?.strength).toBeUndefined()
    expect(() => RELATIONSHIP_EDGE_ENTRY_SCHEMA.parse(edges[0])).not.toThrow()
  })

  it("幂等：同真源两次推导逐字节一致（含 entryId 排序）", () => {
    const store = {
      characters: [
        character({ characterName: "B", relationships: { A: "敌对" } }),
        character({ characterName: "A", relationships: { C: "盟友", B: "敌对" } }),
      ],
    }
    const first = deriveRelationshipEntries(store)
    const second = deriveRelationshipEntries(store)
    expect(stableStringify(first)).toBe(stableStringify(second))
    expect(first.map((e) => e.entryId)).toEqual([
      relationshipEntryId("A", "B"),
      relationshipEntryId("A", "C"),
      relationshipEntryId("B", "A"),
    ])
  })

  it("互惠关系是两条有向边（不自动对称推断）", () => {
    const edges = deriveRelationshipEntries({
      characters: [character({ characterName: "A", relationships: { B: "盟友" } })],
    })
    expect(edges.filter((e) => e.from === "B")).toHaveLength(0)
  })

  it("空文本/空名字的关系丢弃（不造边、不造空 entryId）", () => {
    const edges = deriveRelationshipEntries({
      characters: [
        character({ characterName: "A", relationships: { B: "   ", "": "x" } }),
        character({ characterName: "  ", relationships: { C: "y" } }),
      ],
    })
    expect(edges).toEqual([])
  })

  it("库产物守恒 hash 可重算，且与既有五库口径独立", () => {
    const artifact = buildRelationshipLibraryArtifact(
      { characters: [character({ characterName: "A", relationships: { B: "盟友" } })] },
      { generatedAt: "2026-10-18T00:00:00.000Z" },
    )
    expect(artifact.libraryId).toBe("relationship_edge")
    expect(artifact.contentHash).toBe(computeLibraryHash(`relationship_edge:${stableStringify(artifact.entries)}`))
    expect(Object.isFrozen(artifact.entries)).toBe(true)
  })

  it("schema 拒绝非法写入（多余字段/越界强度/未知 kind）", () => {
    const base = { entryId: "rel:A->B", from: "A", to: "B", kind: "unknown" as const }
    expect(() => RELATIONSHIP_EDGE_ENTRY_SCHEMA.parse({ ...base, extra: 1 })).toThrow()
    expect(() => RELATIONSHIP_EDGE_ENTRY_SCHEMA.parse({ ...base, strength: 101 })).toThrow()
    expect(() => RELATIONSHIP_EDGE_ENTRY_SCHEMA.parse({ ...base, strength: 50.5 })).toThrow()
    expect(() => RELATIONSHIP_EDGE_ENTRY_SCHEMA.parse({ ...base, kind: "soulmate" })).toThrow()
    expect(() => RELATIONSHIP_EDGE_ENTRY_SCHEMA.parse({ ...base, from: "" })).toThrow()
  })
})

describe("Wave 3B 审查回归：hash 可移植性 + entryId 碰撞", () => {
  it("名字里带 -> 不产生 entryId 碰撞（两条边都保留）", () => {
    const edges = deriveRelationshipEntries({
      characters: [
        character({ characterName: "甲->乙", relationships: { 丙: "x" } }),
        character({ characterName: "甲", relationships: { "乙->丙": "y" } }),
      ],
    })
    expect(edges).toHaveLength(2)
    expect(new Set(edges.map((e) => e.entryId)).size).toBe(2)
    expect(edges.map((e) => e.entryId)).toEqual([
      relationshipEntryId("甲->乙", "丙"),
      relationshipEntryId("甲", "乙->丙"),
    ])
  })

  it("中文边按码点排序：与 zh 拼音序相反，证明实现不是 localeCompare", () => {
    const store = {
      characters: [
        character({ characterName: "张", relationships: { 甲: "a" } }),
        character({ characterName: "李", relationships: { 甲: "b" } }),
      ],
    }
    const ids = deriveRelationshipEntries(store).map((e) => e.entryId)
    // 码点：张 U+5F20 < 李 U+674E → 张 在前
    expect(ids.map((id) => decodeURIComponent(id))).toEqual(["rel:张->甲", "rel:李->甲"])
    // zh 拼音序（li < zhang）与码点序相反：若实现退回 localeCompare，上面一条即红
    const zhOrder = [...ids].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    expect(zhOrder).not.toEqual(ids)
    // hash 只由码点序决定
    expect(
      computeLibraryHash(`relationship_edge:${stableStringify(deriveRelationshipEntries(store))}`),
    ).toBe(buildRelationshipLibraryArtifact(store, { generatedAt: "2026-10-18T00:00:00.000Z" }).contentHash)
  })

  it("超长 entryId 被跳过而不是让整库构建抛错", () => {
    const long = "x".repeat(120)
    const edges = deriveRelationshipEntries({
      characters: [character({ characterName: long, relationships: { [long]: "y" } })],
    })
    expect(edges).toEqual([])
    expect(() => buildRelationshipLibraryArtifact({ characters: [character({ characterName: long, relationships: { [long]: "y" } })] })).not.toThrow()
  })
})
