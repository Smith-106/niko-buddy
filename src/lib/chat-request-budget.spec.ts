import { describe, expect, it } from "vitest"
import type { ChatMessage } from "./llm-client"
import type { ContentBlock } from "./llm-providers"
import { trimChatMessagesToBudget, trimChatMessagesToTokenBudget } from "./chat-request-budget"

function text(length: number, char = "x"): string {
  return char.repeat(length)
}

function totalTextLength(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + message.content.length
    return sum + message.content.reduce((inner, block) => inner + (block.type === "text" ? block.text.length : 0), 0)
  }, 0)
}

describe("trimChatMessagesToBudget", () => {
  it("keeps the system prompt and latest user request while dropping oldest long history first", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(1_000, "s") },
      { role: "user", content: "write chapter 39" },
      { role: "assistant", content: text(5_000, "a") },
      { role: "user", content: "write chapter 40" },
      { role: "assistant", content: text(5_000, "b") },
      { role: "user", content: "continue next chapter" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 6_200)

    expect(trimmed[0]).toBe(messages[0])
    expect(trimmed[trimmed.length - 1]).toBe(messages[messages.length - 1])
    expect(totalTextLength(trimmed)).toBeLessThanOrEqual(6_200)
    expect(trimmed).not.toContain(messages[1])
    expect(trimmed).not.toContain(messages[2])
    expect(trimmed).toContain(messages[4])
  })

  it("truncates oversized assistant history instead of dropping the current request", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(500, "s") },
      { role: "assistant", content: text(10_000, "a") },
      { role: "user", content: "continue next chapter" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 2_000)

    expect(trimmed[0]).toBe(messages[0])
    expect(trimmed[trimmed.length - 1]).toBe(messages[messages.length - 1])
    expect(totalTextLength(trimmed)).toBeLessThanOrEqual(2_000)
    expect(String(trimmed[1]?.content)).toContain("[history truncated]")
  })
})

describe("trimChatMessagesToBudget — full-coverage extensions", () => {
  it("returns empty messages unchanged", () => {
    expect(trimChatMessagesToBudget([], 1_000)).toEqual([])
  })

  it("returns messages unchanged for a non-finite budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }]
    expect(trimChatMessagesToBudget(messages, NaN)).toBe(messages)
    expect(trimChatMessagesToBudget(messages, Infinity)).toBe(messages)
  })

  it("returns messages unchanged for a non-positive budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }]
    expect(trimChatMessagesToBudget(messages, 0)).toBe(messages)
    expect(trimChatMessagesToBudget(messages, -5)).toBe(messages)
  })

  it("returns messages unchanged when they fit the budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }]
    expect(trimChatMessagesToBudget(messages, 1_000)).toBe(messages)
  })

  it("trims array content blocks from the tail, keeping small images and dropping oversized ones", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(100, "s") },
      {
        role: "user",
        content: [
          { type: "text", text: text(500) },
          { type: "image", mediaType: "image/png", dataBase64: text(40, "i") },
          { type: "image", mediaType: "image/png", dataBase64: text(100_000, "I") },
          { type: "text", text: text(30) },
        ],
      },
      { role: "user", content: "last" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 400)

    expect(totalTextLength(trimmed)).toBeLessThanOrEqual(400)
    const blocks = trimmed[1]?.content as ContentBlock[]
    expect(Array.isArray(blocks)).toBe(true)
    const imageBlocks = blocks.filter((block) => block.type !== "text")
    expect(imageBlocks).toHaveLength(1)
    expect(imageBlocks[0]?.dataBase64).toBe(text(40, "i"))
    expect(blocks[blocks.length - 1]?.type).toBe("text")
  })

  it("skips holes in block arrays while trimming", () => {
    const sparse = [
      { type: "text", text: text(500) },
      // eslint-disable-next-line no-sparse-arrays
      ,
      { type: "text", text: text(20) },
    ] as ContentBlock[]
    const messages: ChatMessage[] = [
      { role: "system", content: text(100, "s") },
      { role: "user", content: sparse },
      { role: "user", content: "last" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 300)

    expect(Array.isArray(trimmed[1]?.content)).toBe(true)
    expect(totalTextLength(trimmed)).toBeLessThanOrEqual(300)
  })

  it("preserves consecutive leading system messages while trimming history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(1_000, "s") },
      { role: "system", content: text(1_000, "s") },
      { role: "user", content: text(5_000) },
      { role: "user", content: "last" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 3_000)

    expect(trimmed[0]).toBe(messages[0])
    expect(trimmed[1]).toBe(messages[1])
    expect(trimmed[trimmed.length - 1]).toBe(messages[messages.length - 1])
    expect(totalTextLength(trimmed)).toBeLessThanOrEqual(3_000)
  })

  it("trims leading system messages in the final pass when nothing else can be dropped", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(5_000, "s") },
      { role: "user", content: text(10_000) },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 3_000)

    // The most recent user message is always preserved, even over budget.
    expect(trimmed).toHaveLength(2)
    expect(String(trimmed[0]?.content)).toBe("")
    expect(String(trimmed[1]?.content)).toHaveLength(10_000)
  })

  it("trims a text block to empty when the target length is zero", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(100, "s") },
      { role: "user", content: [{ type: "text", text: text(100) }] },
      { role: "user", content: "last" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 50)

    expect(trimmed[1]?.content).toEqual([])
    expect(String(trimmed[0]?.content)).toHaveLength(46)
  })
})

/**
 * P0 回归（2026-10-29）：trimChatMessagesToTokenBudget 的参数是 **token** 预算，
 * 但旧实现直接把它当 **字符** 预算传给字符裁剪器。
 *
 * runner.ts 传的是 `effectiveContext × 0.75`（token 数）。中文因 1 字符 ≈ 1 token
 * 碰巧接近；英文 4 字符/token，于是预算被用掉 1/4 就停手，**浪费约 4 倍上下文**。
 *
 * 注意：这组测试之前完全不存在——既有 11 例全部针对字符版 trimChatMessagesToBudget，
 * 真正被 runner 调用的 token 版零覆盖。这正是该 bug 能长期存在的原因。
 */
describe("trimChatMessagesToTokenBudget：token 语义（P0 回归）", () => {
  it("中文消息按 token 预算裁剪，不再被当作字符预算", async () => {
    const { estimateMessagesTokens } = await import("./token-estimator")
    const zh = "身体都是租的，你让我修仙？"
    const messages: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      content: `第${i}章：${zh.repeat(3)}`,
    }))

    const budget = 500
    const trimmed = trimChatMessagesToTokenBudget(messages, budget)
    const tokens = estimateMessagesTokens(trimmed)

    // 核心断言：裁剪后真的落在 token 预算内
    expect(tokens).toBeLessThanOrEqual(budget)
    // 且没有过度裁剪（旧实现会砍到远低于预算）
    expect(tokens).toBeGreaterThan(budget * 0.5)
    expect(trimmed.length).toBeLessThan(messages.length)
  })

  it("英文场景能用满预算（旧实现只用到约 1/4）", async () => {
    const { estimateMessagesTokens } = await import("./token-estimator")
    const messages: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      content: `Chapter ${i}: the body is rented and you want me to cultivate immortality.`,
    }))

    const budget = 400
    const trimmed = trimChatMessagesToTokenBudget(messages, budget)
    const tokens = estimateMessagesTokens(trimmed)

    expect(tokens).toBeLessThanOrEqual(budget)
    // 英文 4 字符/token，若能正确按 token 计，应能用掉预算的大部分
    expect(tokens).toBeGreaterThan(budget * 0.4)
  })

  it("未超预算时原样返回（不触发任何裁剪）", async () => {
    const { estimateMessagesTokens } = await import("./token-estimator")
    const messages: ChatMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "在的" },
    ]
    const budget = estimateMessagesTokens(messages) + 100
    expect(trimChatMessagesToTokenBudget(messages, budget)).toEqual(messages)
  })

  it("保留最新用户请求（裁剪不能丢掉当前意图）", async () => {
    const zh = "测".repeat(200)
    const messages: ChatMessage[] = [
      { role: "user", content: zh },
      { role: "assistant", content: zh },
      { role: "user", content: "最新问题：请回答这个" },
    ]
    const trimmed = trimChatMessagesToTokenBudget(messages, 300)
    const last = trimmed[trimmed.length - 1]
    expect(typeof last.content === "string" ? last.content : "").toContain("最新问题")
  })

  it("空数组与非正预算原样返回", () => {
    expect(trimChatMessagesToTokenBudget([], 100)).toEqual([])
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(100) }]
    expect(trimChatMessagesToTokenBudget(messages, 0)).toEqual(messages)
    expect(trimChatMessagesToTokenBudget(messages, -5)).toEqual(messages)
    expect(trimChatMessagesToTokenBudget(messages, Number.NaN)).toEqual(messages)
  })

  it("纯 ASCII 多消息场景按 token 预算裁剪（不再 1:1 等同字符）", async () => {
    const { estimateMessagesTokens } = await import("./token-estimator")
    // 4000 字符英文 ≈ 1000 token；多消息才能触发裁剪（最后一条永不裁，见下例）
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `a`.repeat(200),
    }))
    const trimmed = trimChatMessagesToTokenBudget(messages, 500)
    expect(estimateMessagesTokens(trimmed)).toBeLessThanOrEqual(500)
    // 旧实现把 500 当字符预算（约 125 token），新实现应用满预算
    expect(estimateMessagesTokens(trimmed)).toBeGreaterThan(200)
  })

  it("【设计约束】最后一条消息永不裁剪——保住用户当前意图，超限由 runner 报可读错误", async () => {
    const { estimateMessagesTokens } = await import("./token-estimator")
    // 字符裁剪器的三处循环都是 `i < next.length - 1`，刻意不碰最后一条。
    // 单条超大消息因此无法被裁剪，这是既有设计而非缺陷：
    // runner.ts 会抛「模型上下文不足……请缩短输入」而不是默默截断用户问题。
    const messages: ChatMessage[] = [{ role: "user", content: "a".repeat(4000) }]
    const trimmed = trimChatMessagesToTokenBudget(messages, 500)
    expect(trimmed).toEqual(messages)
    expect(estimateMessagesTokens(trimmed)).toBeGreaterThan(500)
  })
})
