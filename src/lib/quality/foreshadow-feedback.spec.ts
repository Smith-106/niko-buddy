/**
 * foreshadow-feedback.spec.ts — v2.6.10 D3 验收（观测）
 *
 * 覆盖：dry-run / 锚点摘要限长 / 守 Draft-first
 */
import { describe, expect, it } from "vitest"
import { ANCHOR_SUMMARY_MAX, buildFeedbackPayload, validateFeedback } from "./foreshadow-feedback"

describe("D3 伏笔回灌 — 观测通道（dry-run）", () => {
  it("dry-run 标记（不写正式正文）", () => {
    const r = buildFeedbackPayload("玉簪", "第一章埋下玉簪", { chapter: 1, sentence: 10 })
    expect(r.dryRun).toBe(true)
  })

  it("锚点摘要≤200 字合规", () => {
    const r = validateFeedback({ key: "玉簪", anchorSummary: "短摘要", plantedAt: { chapter: 1, sentence: 10 } })
    expect(r.ok).toBe(true)
  })

  it("摘要超限拒绝（禁灌旧全文）", () => {
    const r = validateFeedback({ key: "玉簪", anchorSummary: "长".repeat(ANCHOR_SUMMARY_MAX + 1), plantedAt: { chapter: 1, sentence: 10 } })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("锚点摘要超限")
  })
})
