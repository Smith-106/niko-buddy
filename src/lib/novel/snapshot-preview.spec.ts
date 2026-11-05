/**
 * snapshot-preview.spec.ts — 快照预览纯函数簇直接覆盖
 *（20261105-ralph-coverage-100 分支专项：此前仅 chapter-ingest.behavior.spec
 * 间接覆盖 buildSnapshotMemorySyncPreview；projectSnapshotForImpact /
 * projectSnapshotToImpactStores 零直接调用，本文件补齐其全部 ??/if 分支。）
 */
import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  buildSnapshotMemorySyncPreview,
  projectSnapshotForImpact,
  projectSnapshotToImpactStores,
} from "./snapshot-preview"

function snap(over: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "ch-001",
    chapterNumber: 3,
    summary: "阿宁夜入皇宫",
    characters: ["阿宁", "李四"],
    locations: ["皇宫"],
    organizations: ["影卫"],
    items: ["青霜剑"],
    events: ["夜探"],
    characterStateChanges: ["阿宁：健康→重伤"],
    relationshipChanges: [],
    knowledgeChanges: ["阿宁知晓密道"],
    foreshadowingChanges: ["密道伏笔"],
    newCanonFacts: ["皇宫有密道"],
    timelineEvents: [],
    conflicts: [],
    endingHook: "悬念",
    graphNodes: [],
    graphEdges: [],
    ...over,
  } as ChapterSnapshot
}

describe("projectSnapshotForImpact", () => {
  it("null 快照 → 空串", () => {
    expect(projectSnapshotForImpact(null)).toBe("")
  })

  it("全字段快照 → 拼接全部投影面", () => {
    const text = projectSnapshotForImpact(snap())
    expect(text).toContain("阿宁夜入皇宫")
    expect(text).toContain("阿宁")
    expect(text).toContain("皇宫有密道")
    expect(text).toContain("密道伏笔")
    expect(text).toContain("健康→重伤")
  })

  it("空串字段被 filter(Boolean) 剔除", () => {
    const text = projectSnapshotForImpact(
      snap({
        summary: "",
        characters: ["阿宁"],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        newCanonFacts: [],
        characterStateChanges: [],
        foreshadowingChanges: [],
      }),
    )
    expect(text).toBe("阿宁")
  })

  it("全部可选面缺失 → 空串", () => {
    const text = projectSnapshotForImpact(
      snap({
        summary: undefined as unknown as string,
        characters: undefined as unknown as string[],
        locations: undefined as unknown as string[],
        organizations: undefined as unknown as string[],
        items: undefined as unknown as string[],
        events: undefined as unknown as string[],
        newCanonFacts: undefined as unknown as string[],
        characterStateChanges: undefined as unknown as string[],
        foreshadowingChanges: undefined as unknown as string[],
      }),
    )
    expect(text).toBe("")
  })
})

describe("projectSnapshotToImpactStores", () => {
  it("全字段快照 → 三 stores 映射正确", () => {
    const stores = projectSnapshotToImpactStores(snap())
    expect(stores.characters).toEqual([
      { id: "阿宁", characterName: "阿宁" },
      { id: "李四", characterName: "李四" },
    ])
    expect(stores.canonEdges).toHaveLength(1)
    expect(stores.canonEdges?.[0]).toMatchObject({
      id: "皇宫有密道",
      predicate: "皇宫有密道",
      edge_kind: "world_fact",
    })
    expect(stores.foreshadows).toHaveLength(1)
    expect(stores.foreshadows?.[0]).toMatchObject({
      id: "密道伏笔",
      status: "planted",
      plantedChapter: 3,
    })
  })

  it("三可选面缺失 → 三 stores 全空", () => {
    const stores = projectSnapshotToImpactStores(
      snap({
        characters: undefined as unknown as string[],
        newCanonFacts: undefined as unknown as string[],
        foreshadowingChanges: undefined as unknown as string[],
      }),
    )
    expect(stores.characters).toEqual([])
    expect(stores.canonEdges).toEqual([])
    expect(stores.foreshadows).toEqual([])
  })
})

describe("buildSnapshotMemorySyncPreview", () => {
  it("空分面显示「- 无」，非空分面列出条目", () => {
    const empty = buildSnapshotMemorySyncPreview(
      snap({
        characters: [],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        characterStateChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
      }),
    )
    expect(empty).toContain("人物状态：\n- 无")
    expect(empty).toContain("本次将同步以下内容")
    const full = buildSnapshotMemorySyncPreview(snap())
    expect(full).toContain("- 阿宁：健康→重伤")
    expect(full).toContain("- 阿宁")
  })
})
