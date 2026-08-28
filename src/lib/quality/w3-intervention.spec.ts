/**
 * w3-intervention.spec.ts — v2.7.2 W3 采纳自动干预验收
 *
 * 覆盖：白名单动作 / 禁直写正式层 / 100% trace（规则 ID + veto）
 */
import { describe, expect, it } from "vitest"
import { W3_WHITELIST, auditW3Intervention, type InterventionRecord } from "./w3-intervention"

const rec = (action: string, writesFormal = false, landsDraft = true, ruleId = "w3-1"): InterventionRecord => ({ ruleId, action, vetoed: false, writesFormal, landsDraft })

describe("W3 干预 — 白名单 + Draft-first", () => {
  it("白名单动作全落地 draft → 达标", () => {
    const records = W3_WHITELIST.map((a) => rec(a))
    const r = auditW3Intervention(records)
    expect(r.violations).toBe(0)
    expect(r.formalWrites).toBe(0)
    expect(r.traced).toBe(records.length)
    expect(r.passed).toBe(true)
  })

  it("白名单外动作 → 越权计数", () => {
    const r = auditW3Intervention([rec("rewrite-content")])
    expect(r.violations).toBe(1)
    expect(r.passed).toBe(false)
  })

  it("直写正式正文/记忆 → 违规", () => {
    const r = auditW3Intervention([rec("adopt", true)])
    expect(r.formalWrites).toBe(1)
    expect(r.passed).toBe(false)
  })
})
