import { describe, expect, it } from "vitest"
import type { ChatMessage } from "./llm-client"
import type { ContentBlock } from "./llm-providers"
import {
  estimateChatMessagesTokens,
  estimateRequestScaffoldTokens,
  trimChatMessagesToBudget,
  trimChatMessagesToTokenBudget,
} from "./chat-request-budget"
import { estimateMessagesTokens, estimateScaffoldTokens } from "./token-estimator"

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

  it("never trims the cacheControl-bearing system block (G7 world-rules zero-truncation)", () => {
    // 生产形态：稳定前缀（含 canonRules）以 cacheControl 块投递，动态段是第二个块。
    const stable = text(5_000, "s")
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          { type: "text", text: stable, cacheControl: true },
          { type: "text", text: text(4_000, "d") },
        ],
      },
      { role: "user", content: text(10_000) },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 3_000)

    // G7：缓存块（稳定前缀 + canonRules）逐字保留；可压缩的是非缓存动态块。
    // 历史行为是 Pass 3 整体裁掉 system（等价于规则被静默丢弃），已废弃。
    const blocks = trimmed[0]?.content as { text: string; cacheControl?: boolean }[]
    expect(blocks[0]?.text).toBe(stable)
    expect(blocks[0]?.cacheControl).toBe(true)
    // 动态块可被压到空（超额 11000 > 其自身 4000），但绝不反过来动缓存块。
    expect(blocks.length === 1 || (blocks[1]!.text.length ?? 0) < 4_000).toBe(true)
    expect(String(trimmed[1]?.content)).toHaveLength(10_000)
  })

  it("trims a text block to empty when the target length is zero", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: text(100, "s") },
      { role: "user", content: [{ type: "text", text: text(100) }] },
      { role: "user", content: "last" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 50)

    // 字符串形态 system 无 cacheControl 标记 → 不承载受保护缓存前缀，沿用通用裁剪。
    expect(trimmed[1]?.content).toEqual([])
    expect(String(trimmed[0]?.content)).toHaveLength(46)
  })

  it("system 动态块字符总数为 0 时跳过该消息（无可压缩空间 → 原样保留）", () => {
    // 可压缩集合非空（有一个动态块）但其字符数为 0 → 不能再压；该消息必须原样保留，
    // 超额交给上游报错，而不是把承载规则的缓存块丢掉。
    const stable = text(100, "s")
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          { type: "text", text: stable, cacheControl: true },
          { type: "text", text: "" },
        ],
      },
      { role: "user", content: text(1_000, "u") },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 200)

    expect(trimmed[0]).toBe(messages[0])
    const blocks = trimmed[0]?.content as ContentBlock[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ text: stable, cacheControl: true })
    // 超额无法消除 → 绝不静默丢掉规则
    expect(totalTextLength(trimmed)).toBe(1_100)
  })

  it("system 动态块为图片时按 dataBase64 计长度并整块丢弃（不按文本长度）", () => {
    const stable = text(100, "s")
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          { type: "text", text: stable, cacheControl: true },
          { type: "image", mediaType: "image/png", dataBase64: text(500, "i") },
        ],
      },
      { role: "user", content: text(1_000, "u") },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 200)

    const blocks = trimmed[0]?.content as ContentBlock[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ text: stable, cacheControl: true })
    expect(blocks.some((block) => block.type !== "text")).toBe(false)
  })

  it("Pass 3 兜底续压：缓存块不可压时仍会清空后续普通历史消息", () => {
    const stable = text(2_000, "s")
    const messages: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: stable, cacheControl: true }] },
      { role: "assistant", content: text(500, "a") },
      { role: "user", content: "继续" },
    ]

    const trimmed = trimChatMessagesToBudget(messages, 100)

    // 缓存块（世界规则）零截断；可压的只有普通历史消息
    const systemBlocks = trimmed[0]?.content as ContentBlock[]
    expect(systemBlocks).toHaveLength(1)
    expect(systemBlocks[0]).toMatchObject({ text: stable, cacheControl: true })
    expect(trimmed[1]?.content).toBe("")
    // 最后一条永不裁剪（保住当前意图）
    expect(String(trimmed[trimmed.length - 1]?.content)).toBe("继续")
  })
})

describe("estimate 转发器（v3 agent 兼容口径）", () => {
  it("estimateChatMessagesTokens 与估算器同值", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "你是写作助手。" },
      { role: "user", content: [
        { type: "text", text: "请续写第三章" },
        { type: "image", mediaType: "image/png", dataBase64: text(64, "i") },
      ] },
    ]

    const viaWrapper = estimateChatMessagesTokens(messages)

    expect(viaWrapper).toBe(estimateMessagesTokens(messages))
    expect(viaWrapper).toBeGreaterThan(0)
  })

  it("estimateRequestScaffoldTokens 与估算器同值（含 0 / 空入参）", () => {
    const tools = [{ type: "function", function: { name: "read_file", description: "读取文件", parameters: { type: "object" } } }]

    const viaWrapper = estimateRequestScaffoldTokens(tools)

    expect(viaWrapper).toBe(estimateScaffoldTokens(tools))
    expect(viaWrapper).toBeGreaterThan(0)
    expect(estimateRequestScaffoldTokens(undefined)).toBe(0)
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

  it("【G7 零截断】超额只能由 system 段承担时，system 内容也绝不被 Pass 3 兜底裁剪", () => {
    // 构造：system 段承载 canonRules 远超预算，其余消息全可丢。
    // 旧实现 Pass 3 无 system 守卫 → 会把 canonRules 裁成空串；
    // 修复后 system 段逐字保留，超额交给上游/runner 报错。
    const canonRules = ["## 硬性世界规则", "规则条目：不可违背的世界设定。".repeat(50)].join(String.fromCharCode(10))
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [{ type: "text", text: canonRules, cacheControl: true }],
      },
      { role: "user", content: "写第三章" },
    ]
    const trimmed = trimChatMessagesToBudget(messages, 200)
    const sys = trimmed.find((m) => m.role === "system")
    const blocks = sys?.content as { text: string; cacheControl?: boolean }[]
    // 缓存块零截断：规则一字不少（超额交给上游/runner 报可读错误）。
    expect(blocks[0]?.text).toBe(canonRules)
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
