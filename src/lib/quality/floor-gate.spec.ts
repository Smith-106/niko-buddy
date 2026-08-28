/**
 * floor-gate.spec.ts — v2.6.8 D2 验收
 *
 * 覆盖：单维一票否决 / 只挡正文回填 / 小样本回退 / 门控优先级
 */
import { describe, expect, it } from "vitest"
import { evaluateFloorGate, verifyGatePriority, type FloorGateInput } from "./floor-gate"

const base: FloorGateInput = {
  chapterId: "ch1",
  scores: { thril: 8.5, pacing: 8.5, pull: 8.5, context: 8.5, consistency: 9.2, anti_ai: 8.8, quality: 8.8 },
  sampleCount: 40,
  isBackfill: true,
}

describe("D2 地板闸 — 单维一票否决", () => {
  it("全维达标通过", () => {
    expect(evaluateFloorGate(base).pass).toBe(true)
  })

  it("consistency<9.0 一票否决（P0 硬门）", () => {
    const r = evaluateFloorGate({ ...base, scores: { ...base.scores, consistency: 8.9 } })
    expect(r.pass).toBe(false)
    expect(r.vetoed).toContain("consistency")
  })

  it("anti_ai<8.5 否决（P1 硬门）", () => {
    const r = evaluateFloorGate({ ...base, scores: { ...base.scores, anti_ai: 8.4 } })
    expect(r.pass).toBe(false)
    expect(r.vetoed).toContain("anti_ai")
  })

  it("quality<8.5 否决且不得覆盖 P0", () => {
    const r = evaluateFloorGate({ ...base, scores: { ...base.scores, quality: 8.4 } })
    expect(r.pass).toBe(false)
    expect(r.vetoed).toContain("quality")
  })

  it("软维触地板仅记录（D5 复合触发）", () => {
    const r = evaluateFloorGate({ ...base, scores: { ...base.scores, thril: 7.9, pacing: 7.9 } })
    expect(r.pass).toBe(true) // 软维不单维否决
    expect(r.softBreached).toEqual(["thril", "pacing"])
  })
})

describe("D2 地板闸 — 只挡正文回填（守 Draft-first）", () => {
  it("草稿修正（isBackfill=false）不拦", () => {
    const r = evaluateFloorGate({ ...base, isBackfill: false, scores: { ...base.scores, consistency: 8.0 } })
    expect(r.pass).toBe(true)
  })

  it("正文回填（isBackfill=true）拦", () => {
    const r = evaluateFloorGate({ ...base, isBackfill: true, scores: { ...base.scores, consistency: 8.0 } })
    expect(r.pass).toBe(false)
  })
})

describe("D2 地板闸 — 小样本回退 + 优先级", () => {
  it("n<30 标记临时闸（P50 回退）", () => {
    const r = evaluateFloorGate({ ...base, sampleCount: 20 })
    expect(r.usedTemporaryGate).toBe(true)
  })

  it("门控优先级：P0 失败整体必非 PASS", () => {
    const fail = evaluateFloorGate({ ...base, scores: { ...base.scores, consistency: 8.0 } })
    const pass = evaluateFloorGate(base)
    expect(verifyGatePriority([fail, pass])).toBe(true)
    // 反向：若 P0 失败却 pass——违反优先级
    expect(verifyGatePriority([{ ...fail, pass: true }])).toBe(false)
  })
})
