import { describe, expect, it } from "vitest"
import {
  lockProtectedSpans,
  buildPreserveDirective,
  preserveLockToText,
} from "./de-ai-preserve-lock"

describe("de-ai-preserve-lock — P1-2 改写前锁定关键内容", () => {
  it("URL 被锁 + 还原", () => {
    const lock = lockProtectedSpans("详情见 https://example.com/doc 继续。")
    expect(lock.spans.some((s) => s.kind === "url")).toBe(true)
    expect(lock.maskedText).not.toContain("https://")
    expect(lock.maskedText).toContain("⟦LOCK")
    const restored = lock.restore(lock.maskedText)
    expect(restored).toContain("https://example.com/doc")
  })

  it("数字/日期被锁", () => {
    const lock = lockProtectedSpans("他在2026年3月15日收到 500 元。")
    const nums = lock.spans.filter((s) => s.kind === "number")
    expect(nums.length).toBeGreaterThanOrEqual(2)
    expect(lock.maskedText).not.toContain("2026")
  })

  it("角色名被锁 (长名优先)", () => {
    const lock = lockProtectedSpans("白砚看向苏未晞。")
    const names = lock.spans.filter((s) => s.kind === "characterName")
    expect(names.length).toBe(2)
    const restored = lock.restore(lock.maskedText)
    expect(restored).toContain("白砚看向苏未晞")
  })

  it("时间词被锁", () => {
    const lock = lockProtectedSpans("三更时分，他起身。")
    expect(lock.spans.some((s) => s.kind === "timePhrase")).toBe(true)
    expect(lock.restore(lock.maskedText)).toContain("三更时分")
  })

  it("引用被锁", () => {
    const lock = lockProtectedSpans("他说：“这件事不能改。”")
    const q = lock.spans.filter((s) => s.kind === "quote")
    expect(q.length).toBeGreaterThan(0)
    expect(lock.restore(lock.maskedText)).toContain("这件事不能改")
  })

  it("对白标签被锁", () => {
    const lock = lockProtectedSpans("他沉声道：\"别走。\"")
    const d = lock.spans.filter((s) => s.kind === "dialogueTemplate")
    expect(d.length).toBeGreaterThan(0)
    expect(lock.restore(lock.maskedText)).toContain("他沉声道")
  })

  it("restore 对完全未改写的输出幂等", () => {
    const lock = lockProtectedSpans("白砚在2026年说：\"好。\" 链接 https://a.b/c")
    const restored = lock.restore(lock.maskedText)
    expect(restored).toBe("白砚在2026年说：\"好。\" 链接 https://a.b/c")
  })

  it("placeholder 顺序编号连续", () => {
    const lock = lockProtectedSpans("2026年 白砚 参见 https://x.com 苏未晞 三更时分")
    const tokens = lock.spans.map((s) => s.token)
    expect(tokens).toEqual(tokens.map((_, i) => `⟦LOCK${i}⟧`))
  })

  it("buildPreserveDirective 空/有 spans", () => {
    expect(buildPreserveDirective([])).toContain("不增删剧情事实")
    const lock = lockProtectedSpans("白砚 2026年")
    const directive = buildPreserveDirective(lock.spans)
    expect(directive).toContain("数字/日期")
    expect(directive).toContain("角色名")
    expect(directive).toContain("⟦LOCK")
  })

  it("preserveLockToText 摘要", () => {
    const lock = lockProtectedSpans("白砚 2026年 https://a.b")
    const t = preserveLockToText(lock)
    expect(t).toContain("spans")
  })
})
