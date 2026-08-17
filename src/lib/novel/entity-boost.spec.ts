import { describe, expect, it } from "vitest"
import { applyEntityBoost, normalizeEntityNames, reorderByEntityBoost } from "./entity-boost"

describe("normalizeEntityNames", () => {
  it("trims, lowercases, dedupes, drops short tokens", () => {
    expect(normalizeEntityNames([" 阿宁 ", "阿宁", "a", "Li", "li"])).toEqual(["阿宁", "li"])
  })
})

describe("applyEntityBoost", () => {
  const hits = [
    { id: "a", score: 1, text: "天气不错" },
    { id: "b", score: 1, text: "阿宁走进房间" },
    { id: "c", score: 1.2, text: "路人甲" },
  ]

  it("boosts hits that mention entities", () => {
    const ranked = applyEntityBoost(hits, ["阿宁"], 0.4)
    expect(ranked[0]!.id).toBe("b")
    expect(ranked[0]!.score).toBeCloseTo(1.4)
  })

  it("with empty entities only sorts by original score", () => {
    const ranked = applyEntityBoost(hits, [], 0.4)
    expect(ranked[0]!.id).toBe("c")
    expect(ranked.map((r) => r.id)).toEqual(["c", "a", "b"])
  })

  it("weight 0 does not boost", () => {
    const ranked = applyEntityBoost(hits, ["阿宁"], 0)
    expect(ranked.find((r) => r.id === "b")!.score).toBe(1)
  })

  it("caps multi-entity boost at 3 matches", () => {
    const multi = [{ id: "m", score: 0, text: "alpha beta gamma delta" }]
    const ranked = applyEntityBoost(multi, ["alpha", "beta", "gamma", "delta"], 0.5)
    expect(ranked[0]!.score).toBeCloseTo(1.5)
  })
})

describe("reorderByEntityBoost", () => {
  it("moves entity-matching items earlier", () => {
    const items = [
      { title: "天气", snippet: "晴" },
      { title: "人物", snippet: "阿宁出场" },
      { title: "地点", snippet: "码头" },
    ]
    // weight > base rank gap (n-index) so boosted mid item can overtake first
    const reordered = reorderByEntityBoost(items, ["阿宁"], 2)
    expect(reordered[0]!.snippet).toContain("阿宁")
  })

  it("no-op when boost disabled via empty entities", () => {
    const items = [{ title: "a" }, { title: "b" }]
    expect(reorderByEntityBoost(items, [], 0.4)).toEqual(items)
  })

  it("no-op for empty hit lists and empty item lists", () => {
    expect(applyEntityBoost([], ["阿宁"], 0.4)).toEqual([])
    expect(reorderByEntityBoost([], ["阿宁"], 0.4)).toEqual([])
  })

  it("treats non-finite weight as zero (sorts by original score only)", () => {
    const ranked = applyEntityBoost([{ id: "a", score: 1, text: "阿宁" }], ["阿宁"], Number.NaN)
    expect(ranked[0]).toEqual({ id: "a", score: 1 })
  })

  it("reorderByEntityBoost respects explicit numeric scores", () => {
    const items = [
      { title: "a", score: 100 },
      { title: "阿宁在屋顶", score: 1 },
    ]
    // weight must exceed the score gap for the boosted item to overtake
    const reordered = reorderByEntityBoost(items, ["阿宁"], 100)
    expect(reordered[0]!.title).toBe("阿宁在屋顶")
  })

  it("reorderByEntityBoost no-ops when weight is not positive", () => {
    const items = [{ title: "阿宁在屋顶" }, { title: "b" }]
    expect(reorderByEntityBoost(items, ["阿宁"], 0)).toBe(items)
    expect(reorderByEntityBoost(items, ["阿宁"], -1)).toBe(items)
  })
})
