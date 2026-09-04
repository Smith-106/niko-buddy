import { describe, expect, it } from "vitest"
import { computeEditImpact, type EditImpactEpisode } from "./edit-impact"

const episodes: EditImpactEpisode[] = [
  { id: "ep-1", chapter_number: 1, entity_id: "林晚" },
  { id: "ep-2", chapter_number: 2, entity_id: "林晚", reference_time: 1 },
  { id: "ep-3", chapter_number: 3, entity_id: "沈默", reference_time: 1 },
  { id: "ep-4", chapter_number: 4, entity_id: "林晚" },
]

describe("computeEditImpact (55 号设计覆盖度 100% M-nos-2)", () => {
  it("编辑实体 → 直接命中 = 该实体 POV 章节, 间接命中 = 引用其时间点的章节", () => {
    const r = computeEditImpact(episodes, { kind: "entity", id: "林晚" })
    expect(r.directChapters).toEqual([1, 2, 4])
    expect(r.indirectChapters).toEqual([3])
    expect(r.affectedChapters).toEqual([1, 2, 3, 4])
    expect(r.affectedEpisodes).toEqual(["ep-1", "ep-2", "ep-3", "ep-4"])
  })

  it("编辑章节 → 直接命中 = 该章节自身, 间接命中 = reference_time 指向它的章节", () => {
    const r = computeEditImpact(episodes, { kind: "chapter", number: 1 })
    expect(r.directChapters).toEqual([1])
    expect(r.indirectChapters).toEqual([2, 3])
    expect(r.affectedChapters).toEqual([1, 2, 3])
  })

  it("无引用 → 空数组 (零开销路径)", () => {
    const r = computeEditImpact(episodes, { kind: "entity", id: "不存在" })
    expect(r.affectedChapters).toEqual([])
    expect(r.affectedEpisodes).toEqual([])
  })

  it("空 episodes → 空数组", () => {
    const r = computeEditImpact([], { kind: "chapter", number: 1 })
    expect(r.affectedChapters).toEqual([])
  })

  it("去重升序: 同一章节多次命中只出现一次", () => {
    const eps: EditImpactEpisode[] = [
      { id: "a", chapter_number: 2, entity_id: "X", reference_time: 1 },
      { id: "b", chapter_number: 2, entity_id: "Y", reference_time: 1 },
    ]
    const r = computeEditImpact(eps, { kind: "chapter", number: 1 })
    expect(r.affectedChapters).toEqual([2])
    expect(r.affectedEpisodes).toEqual(["a", "b"])
  })
})
