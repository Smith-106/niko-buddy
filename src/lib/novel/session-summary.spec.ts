import { describe, it, expect } from "vitest"
import {
  buildSessionContextSummary,
  selectContextHistoryMessages,
  isSessionSummaryFresh,
  isLegacySessionContextSummary,
  normalizeSessionContextSummary,
} from "./session-summary"

const msgs = (): Array<{ role: string; content: string }> => [
  { role: "user", content: "写一个古代仙侠大纲，主角是孤儿。" },
  { role: "assistant", content: "好的，我建议分四卷：入门卷/成长卷/宗门卷/决战卷。" },
  { role: "user", content: "第一卷请突出修炼体系。主角从凡人开始。" },
  { role: "assistant", content: "收到。修炼体系按炼气→筑基→金丹递进。" },
]

describe("session-summary（context-hub 子件，niko-buddy 移植）", () => {
  it("buildSessionContextSummary 生成头尾摘要", () => {
    const s = buildSessionContextSummary({
      messages: msgs(),
      dependencyFingerprint: "fp-1",
      maxChars: 300,
    })
    expect(s.text).toContain("用户")
    expect(s.text).toContain("助手")
    expect(s.dependencyFingerprint).toBe("fp-1")
    expect(typeof s.updatedAt).toBe("number")
  })

  it("selectContextHistoryMessages：有摘要时只取近 2 条，无摘要全量", () => {
    const m = msgs()
    expect(selectContextHistoryMessages(m, "有摘要")).toHaveLength(2)
    expect(selectContextHistoryMessages(m, undefined)).toHaveLength(4)
  })

  it("isSessionSummaryFresh 按 fingerprint 判定新鲜度", () => {
    const s = buildSessionContextSummary({ messages: msgs(), dependencyFingerprint: "fp-1" })
    expect(isSessionSummaryFresh(s, "fp-1")).toBe(true)
    expect(isSessionSummaryFresh(s, "fp-2")).toBe(false)
    expect(isSessionSummaryFresh(undefined, "fp-1")).toBe(false)
  })

  it("isLegacySessionContextSummary 识别旧格式", () => {
    expect(isLegacySessionContextSummary("旧字符串摘要")).toBe(true)
    expect(isLegacySessionContextSummary({ text: "x", updatedAt: 1, dependencyFingerprint: "fp" })).toBe(false)
    expect(isLegacySessionContextSummary({ text: "x", updatedAt: 1 })).toBe(false)
    expect(isLegacySessionContextSummary(null)).toBe(false)
  })
})

describe("session-summary 增补：数组 content / 截断 / 归一化分支", () => {
  it("messageText 支持多模态数组 content：只取 text 类型块", () => {
    const s = buildSessionContextSummary({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "第一卷突出修炼体系" },
            { type: "image", text: "不应出现" },
            null,
            "裸字符串块忽略",
            { type: "text", text: 123 },
            { notype: true },
          ],
        },
      ],
      dependencyFingerprint: "fp-arr",
    })
    expect(s.text).toContain("第一卷突出修炼体系")
    expect(s.text).not.toContain("不应出现")
    expect(s.text).not.toContain("裸字符串块忽略")
  })

  it("messageText 非字符串非数组 content 按空处理", () => {
    const s = buildSessionContextSummary({
      messages: [
        { role: "user", content: 42 },
        { role: "assistant", content: "仍在的回复。" },
      ],
      dependencyFingerprint: "fp-num",
    })
    // 数字 content 产生空行被过滤，只剩助手行
    expect(s.text).not.toContain("用户")
    expect(s.text).toContain("助手")
  })

  it("超长全文：首行 + 近期共存时按 45/55 配额双向截断", () => {
    const longUser = `用户长目标。${"铺垫".repeat(100)}结尾标记。`
    const longAssistant = `助手长回复。${"细节".repeat(100)}收尾。`
    const s = buildSessionContextSummary({
      messages: [
        { role: "user", content: longUser },
        { role: "assistant", content: longAssistant },
      ],
      dependencyFingerprint: "fp-both",
      maxChars: 60,
    })
    expect(s.text.length).toBeLessThanOrEqual(61)
    expect(s.text).toContain("…")
    // 双向截断：首行留头（用户长目标）、近期留尾（收尾），中间被切掉
    expect(s.text).toContain("用户长目标")
    expect(s.text).toContain("收尾")
  })

  it("只有首行超长：走首行单截断", () => {
    const s = buildSessionContextSummary({
      messages: [{ role: "user", content: `开篇。${"字".repeat(200)}终。` }],
      dependencyFingerprint: "fp-first",
      maxChars: 20,
    })
    expect(s.text.length).toBeLessThanOrEqual(20)
    expect(s.text).toContain("用户")
  })

  it("只有近期超长（无用户消息）：走近期尾截断", () => {
    const s = buildSessionContextSummary({
      messages: [{ role: "assistant", content: `回复。${"字".repeat(200)}终。` }],
      dependencyFingerprint: "fp-recent",
      maxChars: 20,
    })
    expect(s.text.length).toBeLessThanOrEqual(20)
    // 近期尾截断：保留省略号 + 尾部（终。），头部被切掉
    expect(s.text.startsWith("…")).toBe(true)
    expect(s.text.endsWith("终。")).toBe(true)
  })

  it("maxChars 极小（1）且首行近期共存：退化到首行分支不断言崩溃", () => {
    const s = buildSessionContextSummary({
      messages: msgs(),
      dependencyFingerprint: "fp-tiny",
      maxChars: 1,
    })
    expect(s.text.length).toBeLessThanOrEqual(1)
  })

  it("空消息：全文为空直接返回空文本", () => {
    const s = buildSessionContextSummary({ messages: [], dependencyFingerprint: "fp-empty" })
    expect(s.text).toBe("")
  })

  it("非 user/assistant 角色被过滤；首个用户从近期中排除", () => {
    const s = buildSessionContextSummary({
      messages: [
        { role: "system", content: "系统提示词不应进摘要" },
        { role: "user", content: "第一问：世界观？" },
        { role: "user", content: "第二问：修炼体系？" },
        { role: "assistant", content: "答：炼气到金丹。" },
      ],
      dependencyFingerprint: "fp-roles",
      maxChars: 4000,
    })
    expect(s.text).not.toContain("系统提示词")
    // 首个用户只出现一次（首行），不重复进近期
    expect(s.text.match(/第一问/g)?.length).toBe(1)
    expect(s.text).toContain("第二问")
  })

  it("selectContextHistoryMessages：空白摘要按无摘要处理", () => {
    const m = msgs()
    expect(selectContextHistoryMessages(m, "   ")).toHaveLength(4)
    expect(selectContextHistoryMessages(m, "")).toHaveLength(4)
  })

  it("isSessionSummaryFresh：无指纹摘要判不新鲜", () => {
    expect(isSessionSummaryFresh({ text: "x", updatedAt: 1 }, "fp-1")).toBe(false)
    expect(isSessionSummaryFresh(undefined, "fp-1")).toBe(false)
  })

  it("isLegacySessionContextSummary：有 dependencies 无指纹判旧格式", () => {
    expect(isLegacySessionContextSummary({ text: "x", dependencies: ["a"] })).toBe(true)
    expect(isLegacySessionContextSummary({ text: 123, dependencies: ["a"] })).toBe(false)
    expect(
      isLegacySessionContextSummary({ text: "x", dependencyFingerprint: "fp", dependencies: ["a"] }),
    ).toBe(false)
    expect(isLegacySessionContextSummary(undefined)).toBe(false)
    expect(isLegacySessionContextSummary(42)).toBe(false)
  })

  it("normalizeSessionContextSummary：字符串直转", () => {
    expect(normalizeSessionContextSummary("旧字符串")).toEqual({ text: "旧字符串", updatedAt: 0 })
  })

  it("normalizeSessionContextSummary：非对象返回 undefined", () => {
    expect(normalizeSessionContextSummary(null)).toBeUndefined()
    expect(normalizeSessionContextSummary(undefined)).toBeUndefined()
    expect(normalizeSessionContextSummary(42)).toBeUndefined()
  })

  it("normalizeSessionContextSummary：缺 text 返回 undefined", () => {
    expect(normalizeSessionContextSummary({ updatedAt: 1 })).toBeUndefined()
    expect(normalizeSessionContextSummary({ text: 123 })).toBeUndefined()
  })

  it("normalizeSessionContextSummary：完整记录原样保留", () => {
    expect(
      normalizeSessionContextSummary({ text: "t", dependencyFingerprint: "fp", updatedAt: 77 }),
    ).toEqual({ text: "t", dependencyFingerprint: "fp", updatedAt: 77 })
  })

  it("normalizeSessionContextSummary：空指纹丢弃、非法时间归零", () => {
    expect(normalizeSessionContextSummary({ text: "t", dependencyFingerprint: "", updatedAt: 5 })).toEqual({
      text: "t",
      updatedAt: 5,
    })
    expect(normalizeSessionContextSummary({ text: "t", updatedAt: Number.NaN })).toEqual({
      text: "t",
      updatedAt: 0,
    })
    expect(normalizeSessionContextSummary({ text: "t", updatedAt: Number.POSITIVE_INFINITY })).toEqual({
      text: "t",
      updatedAt: 0,
    })
    expect(normalizeSessionContextSummary({ text: "t" })).toEqual({ text: "t", updatedAt: 0 })
  })
})

describe("session-summary 增补2：截断早退分支", () => {
  it("首行短、近期长：首行走不截断早退", () => {
    const s = buildSessionContextSummary({
      messages: [
        { role: "user", content: "短。" },
        { role: "assistant", content: `长回复。${"字".repeat(200)}终。` },
      ],
      dependencyFingerprint: "fp-early-first",
      maxChars: 30,
    })
    expect(s.text).toContain("用户：短。")
  })

  it("首行长、近期短：近期走不截断早退", () => {
    const s = buildSessionContextSummary({
      messages: [
        { role: "user", content: `长目标。${"字".repeat(200)}终。` },
        { role: "assistant", content: "短。" },
      ],
      dependencyFingerprint: "fp-early-recent",
      maxChars: 30,
    })
    expect(s.text).toContain("助手：短。")
  })

  it("maxChars 为 0/1 的近期单截断边界", () => {
    const onlyAssistant = [{ role: "assistant", content: `回复。${"字".repeat(50)}终。` }]
    const zero = buildSessionContextSummary({
      messages: onlyAssistant,
      dependencyFingerprint: "fp-zero",
      maxChars: 0,
    })
    expect(zero.text).toBe("")
    const one = buildSessionContextSummary({
      messages: onlyAssistant,
      dependencyFingerprint: "fp-one",
      maxChars: 1,
    })
    expect(one.text.length).toBeLessThanOrEqual(1)
  })
})
