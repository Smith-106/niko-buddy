/**
 * mutation-watershed.spec.ts — v2.6.12 测试 W3 验收
 *
 * 覆盖：变异 kill score / 有效变异口径（余弦 <0.85）/ 风格变异不计门
 */
import { describe, expect, it } from "vitest"
import { MUTATION_SCORE, MUTATION_SIMILARITY, mutationKillScore } from "./mutation-watershed"

describe("测试 W3 变异分水岭 — kill score", () => {
  it("有效变异 kill ≥80% 达标", () => {
    const mutants = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      similarity: 0.5, // 有效变异（<0.85）
      killed: i < 8,
    }))
    const r = mutationKillScore(mutants)
    expect(r.score).toBe(0.8)
    expect(r.pass).toBe(true)
    expect(MUTATION_SCORE).toBe(0.8)
  })

  it("风格变异（相似度 ≥0.85）不计门", () => {
    const mutants = [
      { id: "m1", similarity: 0.9, killed: false }, // 风格变异——不计
      { id: "m2", similarity: 0.5, killed: true },
      { id: "m3", similarity: 0.5, killed: true },
    ]
    const r = mutationKillScore(mutants)
    expect(r.score).toBe(1) // 仅有效变异计
    expect(MUTATION_SIMILARITY).toBe(0.85)
  })

  it("无有效变异 → 不达标", () => {
    expect(mutationKillScore([{ id: "m1", similarity: 0.9, killed: true }]).pass).toBe(false)
  })
})
