import { describe, expect, it } from "vitest"
import type { ChatMessage } from "./llm-client"
import type { ContentBlock } from "./llm-providers"
import { trimChatMessagesToBudget } from "./chat-request-budget"

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
          { type: "image", dataBase64: text(40, "i") },
          { type: "image", dataBase64: text(100_000, "I") },
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
