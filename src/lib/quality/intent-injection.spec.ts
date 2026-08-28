/**
 * intent-injection.spec.ts — v2.6.8 D3 验收
 *
 * 覆盖：诊断表命中 / 伏笔受保护 / 剥离进 pending / 单射≠双向唯一
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_INTENT_SIGNALS,
  diagnoseIntent,
  isProtected,
  stripToPending,
} from "./intent-injection"

describe("D3 意图单射 — 诊断表命中", () => {
  it("意图→动作直译命中（剥离建议）", () => {
    const r = diagnoseIntent("她想离开，她走向门口。", DEFAULT_INTENT_SIGNALS, "instr-1")
    expect(r.some((d) => d.action === "strip_to_pending")).toBe(true)
  })

  it("对话后括注内心命中", () => {
    const r = diagnoseIntent("“我不去。”她心想。", DEFAULT_INTENT_SIGNALS, "instr-2")
    expect(r.some((d) => d.signalId === "inner-note-after-dialogue")).toBe(true)
  })

  it("同段重复意图动词命中", () => {
    const r = diagnoseIntent("她想离开，她想留下，她决定先想清楚。", DEFAULT_INTENT_SIGNALS, "instr-3")
    expect(r.some((d) => d.signalId === "repeated-intent-verb")).toBe(true)
  })

  it("干净文本零命中", () => {
    const r = diagnoseIntent("雨落在窗台上，他数着雨滴。", DEFAULT_INTENT_SIGNALS, "instr-4")
    expect(r).toHaveLength(0)
  })
})

describe("D3 意图单射 — 伏笔/铺垫受保护", () => {
  it("受保护类别命中 → 锁死（需作者解封）", () => {
    const r = diagnoseIntent("她想离开，她走向门口。[foreshadowing]", DEFAULT_INTENT_SIGNALS, "instr-5")
    expect(r.some((d) => d.action === "lock_protected")).toBe(true)
    expect(r.some((d) => d.action === "strip_to_pending")).toBe(false)
  })

  it("isProtected 判定", () => {
    expect(isProtected("[setup] 伏笔")).toBe(true)
    expect(isProtected("普通文本")).toBe(false)
  })
})

describe("D3 意图单射 — 剥离进 pending（不静默丢弃）", () => {
  it("剥离产出 pending 草稿（带证据指针）", () => {
    const r = diagnoseIntent("她想离开，她走向门口。", DEFAULT_INTENT_SIGNALS, "instr-6")
    const { pending } = stripToPending("她想离开，她走向门口。", r)
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0]).toContain("instr-6")
  })
})

describe("D3 意图单射 — 单射≠双向唯一（复调不压制）", () => {
  it("叙事→意图多射合法（同一段落承载多重意图不判违规）", () => {
    // 复调书写：一段承载多意图——诊断只出建议不拒绝
    const r = diagnoseIntent("她站在门口，雨声里想起母亲的话。", DEFAULT_INTENT_SIGNALS, "instr-7")
    expect(r.every((d) => d.action !== "reject")).toBe(true)
  })
})
