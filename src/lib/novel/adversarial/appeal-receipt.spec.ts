/**
 * appeal-receipt.spec.ts — v2.6.5 D4 验收
 *
 * 覆盖：回执三块完整性 / 回执状态机（含 reject→draft 环回）/ 稳定性判定
 */
import { describe, expect, it } from "vitest"
import { ReceiptStateMachine, isStable, validateReceipt, type AppealReceipt } from "./appeal-receipt"

const receipt: AppealReceipt = {
  receiptId: "R-001",
  factorChain: ["thril = 张力3 + 悬疑2 + 情绪2"],
  baselineVersion: "v2.6.4",
  referenceAnchors: ["ch5 同类章节", "历史阈值表 §3"],
  verdict: "degraded",
  confidence: "medium",
  degradationNote: "无",
  plainSummary: "本章悬疑张力分来自三个子因子，与 v2.6.4 基线比对，判定为降级。",
}

describe("D4 申诉回执 — 三块完整性（缺任一块拒收）", () => {
  it("完整回执通过校验", () => {
    expect(validateReceipt(receipt)).toHaveLength(0)
  })

  it("因子链缺失 → 拒收（块1）", () => {
    const errors = validateReceipt({ ...receipt, factorChain: [] })
    expect(errors.join("; ")).toContain("因子链缺失")
  })

  it("基线版本缺失 → 拒收（块2）", () => {
    const errors = validateReceipt({ ...receipt, baselineVersion: "" })
    expect(errors.join("; ")).toContain("基线版本缺失")
  })

  it("对照锚点缺失 → 拒收（块3）", () => {
    const errors = validateReceipt({ ...receipt, referenceAnchors: [] })
    expect(errors.join("; ")).toContain("对照锚点缺失")
  })
})

describe("D4 回执状态机", () => {
  it("正常链：pending→ready→accepted", () => {
    const sm = new ReceiptStateMachine()
    sm.transition("ready")
    sm.transition("accepted")
    expect(sm.current).toBe("accepted")
  })

  it("reject→draft 环回（可重算）", () => {
    const sm = new ReceiptStateMachine()
    sm.transition("ready")
    sm.transition("rejected")
    sm.transition("draft")
    sm.transition("ready")
    expect(sm.current).toBe("ready")
  })

  it("非法迁移 throw（pending→accepted 不允许）", () => {
    const sm = new ReceiptStateMachine()
    expect(() => sm.transition("accepted")).toThrow(/非法迁移/)
  })

  it("终态 accepted 后不可再迁移", () => {
    const sm = new ReceiptStateMachine()
    sm.transition("ready")
    sm.transition("accepted")
    expect(() => sm.transition("draft")).toThrow(/非法迁移/)
  })
})

describe("D4 稳定性判定 — N≥3 且 |max-min|≤0.5", () => {
  it("N≥3 且差≤0.5 → 稳定", () => {
    expect(isStable([9.0, 9.1, 9.2])).toBe(true)
  })

  it("N<3 → 不稳定", () => {
    expect(isStable([9.0, 9.1])).toBe(false)
    expect(isStable([])).toBe(false)
  })

  it("差>0.5 → 不稳定", () => {
    expect(isStable([9.0, 9.1, 9.6])).toBe(false)
  })

  it("边界：差恰 0.5 → 稳定", () => {
    expect(isStable([9.0, 9.2, 9.5])).toBe(true)
  })
})
