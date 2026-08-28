/**
 * memory-rewrite.spec.ts — v2.7.3 记忆自动改写验收
 *
 * 覆盖：diff=0 字符级铁证 / 零直写 / 拒绝保留
 */
import { describe, expect, it } from "vitest"
import { diffZero, evaluateRewrite, type RewriteRecord } from "./memory-rewrite"

const rec = (id: string, original: string, replacements: Array<{ pos: number; len: number; text: string }>, output: string, state: "pending" | "ready" | "accepted" | "rejected" = "accepted"): RewriteRecord => ({ id, replacements, output, original, state })

describe("记忆改写 — diff=0 字符级铁证", () => {
  it("替换点外零增删 → diff=0 通过", () => {
    const r = rec("r1", "他走进房间。", [{ pos: 0, len: 1, text: "她" }], "她走进房间。")
    expect(diffZero(r)).toBe(true)
  })

  it("替换点外增删 → diff≠0 拒绝", () => {
    const r = rec("r2", "他走进房间。", [{ pos: 0, len: 1, text: "她" }], "她轻轻走进房间。")
    expect(diffZero(r)).toBe(false)
  })

  it("重叠替换 → 非法", () => {
    const r = rec("r3", "他走进房间。", [{ pos: 0, len: 1, text: "她" }, { pos: 0, len: 2, text: "他" }], "他走进房间。")
    expect(diffZero(r)).toBe(false)
  })
})

describe("记忆改写 — 闸门语义", () => {
  it("accepted 全 diff=0 且零直写 → 达标", () => {
    const records = [
      rec("r1", "他走进房间。", [{ pos: 0, len: 1, text: "她" }], "她走进房间。"),
      rec("r2", "天黑了。", [{ pos: 0, len: 1, text: "夜" }], "夜黑了。"),
    ]
    const res = evaluateRewrite(records)
    expect(res.diffZeroCount).toBe(2)
    expect(res.formalWrites).toBe(0)
    expect(res.passed).toBe(true)
  })

  it("accepted 但 diff≠0 → 直写正式层违规", () => {
    const records = [rec("r1", "他走进房间。", [{ pos: 0, len: 1, text: "她" }], "她轻轻走进房间。")]
    const res = evaluateRewrite(records)
    expect(res.formalWrites).toBe(1)
    expect(res.passed).toBe(false)
  })

  it("rejected 保留记忆（不降级不删除）", () => {
    const records = [rec("r1", "他走进房间。", [], "他走进房间。", "rejected")]
    const res = evaluateRewrite(records)
    expect(res.rejectedPreserved).toBe(1)
  })
})
