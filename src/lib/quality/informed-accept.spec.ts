/**
 * informed-accept.spec.ts — v2.6.12 W1 验收
 *
 * 覆盖：理由卡生成 / 可回溯锚点 / 接受率统计
 */
import { describe, expect, it } from "vitest"
import { INFORMED_ACCEPT_RATE, INFORMED_ACCEPT_MIN_N, buildReasonCard, informedAcceptRate } from "./informed-accept"

describe("W1 知情接受理由一键 — 理由卡", () => {
  it("理由卡可回溯（每条都有锚点）", () => {
    const card = buildReasonCard([
      { gate: "consistency", anchor: "ch3:para12", evidence: "人物名一致" },
      { gate: "anti_ai", anchor: "ch3:para15", evidence: "无 AI 痕迹" },
    ])
    expect(card.traceable).toBe(true)
    expect(card.reasons).toHaveLength(2)
  })

  it("缺锚点 → 不可回溯（防虚假归因）", () => {
    const card = buildReasonCard([{ gate: "consistency", anchor: "", evidence: "无证据" }])
    expect(card.traceable).toBe(false)
  })
})

describe("W1 知情接受理由一键 — 接受率统计", () => {
  it("≥90% 达标（N≥50）", () => {
    const r = informedAcceptRate(48, 50)
    expect(r.rate).toBe(0.96)
    expect(r.pass).toBe(true)
    expect(INFORMED_ACCEPT_RATE).toBe(0.9)
  })

  it("样本不足不判（N<50）", () => {
    expect(informedAcceptRate(10, 10).pass).toBe(false)
    expect(INFORMED_ACCEPT_MIN_N).toBe(50)
  })

  it("低于 90% 不达标", () => {
    expect(informedAcceptRate(40, 50).pass).toBe(false)
  })
})
