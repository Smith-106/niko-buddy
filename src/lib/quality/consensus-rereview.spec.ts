/**
 * consensus-rereview.spec.ts — v2.6.13 共识复核验收
 *
 * 覆盖：7 方向中位 ≥9.5 / 单方向不过即失败
 */
import { describe, expect, it } from "vitest"
import { CONSENSUS_REREVIEW, evaluateConsensusRereview } from "./consensus-rereview"

describe("7 方向共识分复核", () => {
  it("全方向 ≥9.5 → 通过", () => {
    const r = evaluateConsensusRereview({
      dev: [[9.5, 9.6], [9.5, 9.5]],
      writing: [[9.6, 9.5], [9.5, 9.6]],
    })
    expect(r.passed).toBe(true)
    expect(CONSENSUS_REREVIEW).toBe(9.5)
  })

  it("单方向 <9.5 → 失败", () => {
    const r = evaluateConsensusRereview({
      dev: [[9.5, 9.6], [9.5, 9.5]],
      editing: [[8.5, 8.6], [8.5, 8.5]],
    })
    expect(r.directionMedians.editing).toBeLessThan(9.5)
    expect(r.passed).toBe(false)
  })
})
