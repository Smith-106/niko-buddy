/**
 * independent-reproduce.spec.ts — v2.6.13 双门验收（独立复现）
 *
 * 覆盖：跨种子硬门 ≥9.0 / 换模型泛化补证
 */
import { describe, expect, it } from "vitest"
import { REPRODUCE_MIN_SEEDS, REPRODUCE_SCORE, evaluateIndependentReproduce } from "./independent-reproduce"

describe("双门 — 跨种子独立复现（硬门）", () => {
  it("≥3 seed 各中位 ≥9.0 → 硬门通过", () => {
    const r = evaluateIndependentReproduce(
      [
        [9.0, 9.1, 9.0],
        [9.0, 9.0, 9.2],
        [9.1, 9.0, 9.0],
      ],
      null,
    )
    expect(r.hardPass).toBe(true)
    expect(REPRODUCE_MIN_SEEDS).toBe(3)
    expect(REPRODUCE_SCORE).toBe(9.0)
  })

  it("种子不足（<3）→ 不通过", () => {
    expect(evaluateIndependentReproduce([[9.0, 9.0]], null).hardPass).toBe(false)
  })

  it("任一种子 <9.0 → 不通过", () => {
    const r = evaluateIndependentReproduce([[9.0, 9.0, 9.0], [9.0, 9.0, 9.0], [8.5, 8.5, 8.5]], null)
    expect(r.hardPass).toBe(false)
  })

  it("换模型仅作泛化补证（非硬门）", () => {
    const r = evaluateIndependentReproduce([[9.0, 9.0, 9.0], [9.0, 9.0, 9.0], [9.0, 9.0, 9.0]], 9.2)
    expect(r.crossModelMedian).toBe(9.2)
    expect(r.hardPass).toBe(true)
  })
})
