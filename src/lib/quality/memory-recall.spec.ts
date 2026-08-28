/**
 * memory-recall.spec.ts — v2.6.12 W2 验收
 *
 * 覆盖：召回→accept 口径（防刷量）/ 成功率统计 / 置信度过滤
 */
import { describe, expect, it } from "vitest"
import { RECALL_MIN_N, RECALL_SUCCESS_RATE, filterRecallCandidates, recallSuccessRate } from "./memory-recall"

describe("W2 记忆固化主动召回 — 成功率统计（召回→accept 防刷量）", () => {
  it("≥70% 达标（N≥30）", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      confidence: 0.8,
      status: i < 24 ? ("accepted" as const) : ("rejected" as const),
    }))
    const r = recallSuccessRate(items)
    expect(r.rate).toBe(0.8)
    expect(r.pass).toBe(true)
    expect(RECALL_SUCCESS_RATE).toBe(0.7)
  })

  it("展示不计数（pending 不计入分子）", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      confidence: 0.8,
      status: i < 10 ? ("accepted" as const) : ("pending" as const),
    }))
    const r = recallSuccessRate(items)
    expect(r.rate).toBe(10 / 30) // pending 展示不计数
    expect(r.pass).toBe(false)
  })

  it("样本不足不判（N<30）", () => {
    expect(recallSuccessRate([{ id: "m1", confidence: 0.8, status: "accepted" }]).pass).toBe(false)
    expect(RECALL_MIN_N).toBe(30)
  })
})

describe("W2 记忆固化主动召回 — 置信度过滤", () => {
  it("低置信度不打扰", () => {
    const items = filterRecallCandidates(
      [
        { id: "m1", confidence: 0.9 },
        { id: "m2", confidence: 0.3 },
      ],
      0.7,
    )
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("m1")
  })
})
