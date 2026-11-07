/**
 * blind-triple-edit.spec.ts — v2.6.10 D5 验收（观测）
 *
 * 覆盖：视角分裂 / 共识收敛率 / 观测不挡
 */
import { describe, expect, it } from "vitest"
import { CONSENSUS_THRESHOLD, EDITOR_PERSPECTIVES, consensusRate, evaluateTripleEdit } from "./blind-triple-edit"

describe("D5 双盲三编辑 — 视角分裂（防同源污染）", () => {
  it("三视角齐全（structure/voice/continuity）", () => {
    expect(EDITOR_PERSPECTIVES).toEqual(["structure", "voice", "continuity"])
  })

  it("共识收敛率：同源产出高共识", () => {
    expect(consensusRate("abc", "abc", "abc")).toBe(1)
  })

  it("共识收敛率：异源产出低共识", () => {
    const r = consensusRate("abcde", "vwxyz", "12345")
    expect(r).toBeLessThan(CONSENSUS_THRESHOLD)
  })

  it("观测通道标记（不挡结案）", () => {
    const r = evaluateTripleEdit({ structure: "a", voice: "b", continuity: "c" })
    expect(r.observationOnly).toBe(true)
  })
})

describe("consensusRate 空串", () => {
  it("任一侧为空串 → 相似度 0（不比空）", () => {
    // a 为空 → 含 a 的两对 minLen=0 跳过，仅 b/c 相同贡献 1/3
    expect(consensusRate("", "abc", "abc")).toBeCloseTo(1 / 3, 10)
  })
})
