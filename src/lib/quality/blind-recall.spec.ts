/**
 * blind-recall.spec.ts — v2.6.10 D1 验收
 *
 * 覆盖：命中判定 / 命中率 / 距离衰减
 */
import { describe, expect, it } from "vitest"
import { RECALL_HIT_RATE, computeDistanceDecay, computeRecallHitRate, isRecallHit } from "./blind-recall"

describe("D1 盲测复述 — 命中判定（口径冻结）", () => {
  it("要点召回率≥70% 记命中", () => {
    expect(isRecallHit(7, 10)).toBe(true)
    expect(isRecallHit(6, 10)).toBe(false)
  })

  it("空要点不命中", () => {
    expect(isRecallHit(0, 0)).toBe(false)
  })
})

describe("D1 盲测复述 — 命中率（≥95%）", () => {
  it("达标：命中率≥95%", () => {
    const samples = Array.from({ length: 50 }, () => ({ hit: 8, total: 10 }))
    const r = computeRecallHitRate(samples)
    expect(r.hitRate).toBe(1)
    expect(r.pass).toBe(true)
  })

  it("不达标：命中率<95%", () => {
    const samples = Array.from({ length: 50 }, () => ({ hit: 5, total: 10 }))
    const r = computeRecallHitRate(samples)
    expect(r.pass).toBe(false)
  })

  it("阈值冻结 0.95", () => {
    expect(RECALL_HIT_RATE).toBe(0.95)
  })
})

describe("D1 盲测复述 — 距离衰减（长程记忆）", () => {
  it("跨章距离衰减曲线（5/10/30 章）", () => {
    const decay = computeDistanceDecay([
      { distance: 5, samples: Array.from({ length: 10 }, () => ({ hit: 9, total: 10 })) },
      { distance: 10, samples: Array.from({ length: 10 }, () => ({ hit: 8, total: 10 })) },
      { distance: 30, samples: Array.from({ length: 10 }, () => ({ hit: 7, total: 10 })) },
    ])
    expect(decay).toHaveLength(3)
    expect(decay[0].distance).toBe(5)
    expect(decay[2].hitRate).toBeGreaterThan(0.5)
  })
})
