import { describe, expect, it } from "vitest"
import {
  addFact,
  emptyFactsFile,
  expireFact,
  getFactsAt,
  isFactActive,
  loadFactsFile,
  recordEpisode,
  saveFactsFile,
  supersedeFact,
  projectToTemporalFacts,
  FactsFileShape,
} from "./facts-store"

function seedState(): FactsFileShape {
  let s = emptyFactsFile()
  s = addFact(s, { subject: "白砚", predicate: "持有", object: "轩辕剑", valid_at: 1, source: "test" })
  s = addFact(s, { subject: "苏未晞", predicate: "状态", object: "重伤", valid_at: 3, source: "test" })
  return s
}

describe("S1d facts 表 (graphiti 时间窗 schema, 文件真源)", () => {
  it("graphiti 字段契约: valid_at/invalid_at/expired_at/reference_time/episodes", () => {
    const s = seedState()
    const f = s.facts[0]!
    expect(f).toHaveProperty("valid_at", 1)
    expect(f).toHaveProperty("reference_time", 1)
    expect(f.episodes).toEqual([1])
    expect(f).toHaveProperty("invalid_at")
    expect(f).toHaveProperty("expired_at")
    expect(f.id).toMatch(/^fact-\d+$/)
  })

  it("getFactsAt 语义与 temporal-memory 一致 (valid_at<=ch<invalid_at)", () => {
    const s = seedState()
    expect(getFactsAt(1, undefined, s).map((f) => f.subject)).toEqual(["白砚"])
    expect(getFactsAt(2, undefined, s).map((f) => f.subject)).toEqual(["白砚"])
    expect(getFactsAt(3, undefined, s).map((f) => f.subject)).toEqual(["白砚", "苏未晞"])
    // subject 过滤
    expect(getFactsAt(3, "白砚", s)).toHaveLength(1)
  })

  it("supersedeFact 单调闭合 invalid_at + 记录取代链", () => {
    let s = seedState()
    const oldId = s.facts[0]!.id // 白砚持有轩辕剑 valid_at=1
    s = supersedeFact(s, oldId, { subject: "白砚", predicate: "持有", object: "断水剑", valid_at: 5, source: "test" }, 5)
    const old = s.facts.find((f) => f.id === oldId)!
    expect(old.invalid_at).toBe(5)
    const newFact = s.facts.find((f) => f.subject === "白砚" && f.object === "断水剑")!
    expect(newFact.supersedes).toEqual([oldId])
    // 第 4 章: 旧剑仍有效; 第 5 章: 新剑生效旧剑失效
    expect(getFactsAt(4, "白砚", s).map((f) => f.object)).toEqual(["轩辕剑"])
    expect(getFactsAt(5, "白砚", s).map((f) => f.object)).toEqual(["断水剑"])
    // 单调性: 再次闭合不扩大
    const closedAgain = supersedeFact(s, oldId, { subject: "白砚", predicate: "持有", object: "残剑", valid_at: 8, source: "test" }, 8)
    expect(closedAgain.facts.find((f) => f.id === oldId)!.invalid_at).toBe(5)
  })

  it("expireFact 软删除 (过期后不可见, 记录保留)", () => {
    let s = seedState()
    const id = s.facts[1]!.id // 苏未晞重伤 valid_at=3
    s = expireFact(s, id, 6)
    expect(getFactsAt(5, "苏未晞", s)).toHaveLength(1)
    expect(getFactsAt(6, "苏未晞", s)).toHaveLength(0)
    expect(s.facts.find((f) => f.id === id)!.expired_at).toBe(6)
    expect(isFactActive(s.facts[1]!, 5)).toBe(true)
    expect(isFactActive(s.facts[1]!, 6)).toBe(false)
  })

  it("recordEpisode 溯源去重合并", () => {
    let s = seedState()
    const ids = s.facts.map((f) => f.id)
    s = recordEpisode(s, 1, ids, "snap-1")
    s = recordEpisode(s, 1, [ids[0]!], "snap-1") // 重复不追加
    s = recordEpisode(s, 4, [ids[0]!])
    expect(s.episodes.find((e) => e.chapter === 1)!.fact_ids).toHaveLength(ids.length)
    expect(s.episodes.find((e) => e.chapter === 4)!.fact_ids).toEqual([ids[0]])
  })

  it("文件往返: save → load 保持完整 (文件真源可重建)", () => {
    let s = seedState()
    s = recordEpisode(s, 1, s.facts.map((f) => f.id))
    const raw = saveFactsFile(s)
    const loaded = loadFactsFile(raw)
    expect(loaded).toEqual(s)
    expect(loaded.schema_version).toBe("facts/1.0")
  })

  it("loadFactsFile 拒绝 schema 版本不匹配 (fail loud)", () => {
    expect(() => loadFactsFile('{"schema_version":"facts/0.9","facts":[]}')).toThrow(/schema_version/)
  })

  it("projectToTemporalFacts 投影与 temporal-memory 字段映射一致", () => {
    let s = seedState()
    const oldId = s.facts[0]!.id
    s = supersedeFact(s, oldId, { subject: "白砚", predicate: "持有", object: "断水剑", valid_at: 5, source: "test" }, 5)
    const projected = projectToTemporalFacts(s)
    const old = projected.find((f) => f.id === oldId)!
    expect(old.validFrom).toBe(1)
    expect(old.validUntil).toBe(5)
    const replaced = projected.find((f) => f.object === "断水剑")!
    expect(replaced.supersedes).toEqual([oldId])
    expect(replaced.source).toContain("facts:5")
  })

  it("id 单调递增 (next_id)", () => {
    const s = seedState()
    expect(s.facts.map((f) => f.id)).toEqual(["fact-1", "fact-2"])
    expect(s.next_id).toBe(3)
  })
})
