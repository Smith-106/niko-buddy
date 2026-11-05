import { describe, expect, it } from "vitest"
import { embed, cosineSimilarity } from "./embedding-client"

describe("embedding-client（v2 降级 stub + 余弦相似度）", () => {
  it("embed 抛错并提示降级为启发式判定", async () => {
    await expect(embed("任意文本")).rejects.toThrow("降级为启发式判定")
  })

  it("cosineSimilarity：同向向量为 1、反向为 -1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it("cosineSimilarity：正交向量为 0、空/零向量为 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([], [1, 2])).toBe(0)
    expect(cosineSimilarity([1, 2], [])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0)
  })

  it("cosineSimilarity：不等长按缺失补 0、部分重叠给中间值", () => {
    expect(cosineSimilarity([1, 1], [1])).toBeCloseTo(1 / Math.SQRT2)
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3, 4])).toBeLessThan(1)
  })
})
