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

describe("de-ai-preserve-lock（增补：重叠剪枝 / 空锁报告 / verify 缺失面）", () => {
  it("引用区间包含数字时只锁内层片段：重叠外层剪枝，原文仍可字节级还原", () => {
    const raw = "他说：“2026年就走。”"
    const lock = lockProtectedSpans(raw)

    // 内层数字先入锁 → 包裹它的整句引用（“2026年就走。”）因区间重叠被剪枝；
    // 不重叠的对白标签仍独立入锁
    expect(lock.spans.map((s) => s.kind)).toEqual(["number", "dialogueTemplate"])
    expect(lock.spans.map((s) => s.original)).toEqual(["2026年", "他说："])
    // 引用未被整体替换（外层剪枝后引号保留在掩码文本里）
    expect(lock.maskedText).toBe("⟦LOCK1⟧“⟦LOCK0⟧就走。”")
    expect(lock.restore(lock.maskedText)).toBe(raw)
    expect(lock.verify(lock.restore(lock.maskedText))).toEqual({ restored: true, missing: [] })
  })

  it("改写丢失保护片段时 verify 报告缺失项与 restored=false", () => {
    const lock = lockProtectedSpans("白砚在2026年赶到 https://a.b/c")
    const broken = lock.maskedText.replace("⟦LOCK0⟧", "")
    const check = lock.verify(broken)
    expect(check.restored).toBe(false)
    expect(check.missing).toContain(lock.spans[0].original)
    expect(check.missing.length).toBeGreaterThanOrEqual(1)
  })

  it("无可保护片段时 maskedText 原样返回、报告为空串、指令回退通用文案", () => {
    const raw = "这里不需要保护任何东西。"
    const lock = lockProtectedSpans(raw)
    expect(lock.spans).toEqual([])
    expect(lock.maskedText).toBe(raw)
    expect(preserveLockToText(lock)).toBe("")
    expect(buildPreserveDirective(lock.spans)).toContain("不增删剧情事实")
  })
})
