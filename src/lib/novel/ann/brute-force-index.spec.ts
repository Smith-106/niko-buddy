/** C4 冒烟覆盖：src/lib/novel/ann/brute-force-index.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createExactAnnIndex } from "./brute-force-index"
import { AnnIndexError } from "./ann-index"
describe("brute-force-index.ts smoke", () => {
  it("exports createExactAnnIndex", () => {
    expect(createExactAnnIndex).toBeDefined()
  })
})

describe("createExactAnnIndex 边界", () => {
  it("余弦度量下零向量相似度为 0（不产生 NaN）", () => {
    const index = createExactAnnIndex({ metric: "cosine" })
    index.build([
      { id: "zero", values: [0, 0, 0] },
      { id: "one", values: [1, 0, 0] },
    ])
    const hits = index.search({ values: [1, 0, 0], k: 2 })
    const zero = hits.find((h) => h.id === "zero")
    expect(zero?.score).toBe(0)
    expect(Number.isNaN(zero?.score ?? NaN)).toBe(false)
  })

  it("非法向量 → 抛 AnnIndexError（不静默丢弃）", () => {
    const index = createExactAnnIndex()
    expect(() => index.build([{ id: "bad", values: "not-an-array" } as never])).toThrow(AnnIndexError)
  })
})
