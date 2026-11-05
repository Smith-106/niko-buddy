/** C4 冒烟覆盖：src/lib/llm-usage.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { mergeLlmUsageSnapshot, addLlmUsage } from "./llm-usage"
describe("llm-usage.ts smoke", () => {
  it("exports mergeLlmUsageSnapshot", () => {
    expect(mergeLlmUsageSnapshot).toBeDefined()
  })
  it("exports addLlmUsage", () => {
    expect(addLlmUsage).toBeDefined()
  })
})

describe("llm-usage 逐字段合并语义", () => {
  it("两侧都缺失时返回 undefined（不凭空造出用量对象）", () => {
    expect(mergeLlmUsageSnapshot(undefined, undefined)).toBeUndefined()
    expect(addLlmUsage(undefined, undefined)).toBeUndefined()
  })

  it("只有单侧存在时逐字段照抄，并返回新对象（调用方后续改写不串味）", () => {
    const next = { inputTokens: 3, outputTokens: 4 }
    const merged = mergeLlmUsageSnapshot(undefined, next)
    expect(merged).toEqual({ inputTokens: 3, outputTokens: 4 })
    expect(merged).not.toBe(next)

    const current = { totalTokens: 7, cacheWriteInputTokens: 2 }
    const kept = addLlmUsage(current, undefined)
    expect(kept).toEqual({ totalTokens: 7, cacheWriteInputTokens: 2 })
    expect(kept).not.toBe(current)
  })

  it("同一字段两侧都有：snapshot 取较大值，不回退已累计的用量", () => {
    const merged = mergeLlmUsageSnapshot(
      { inputTokens: 10, totalTokens: 5 },
      { inputTokens: 3, totalTokens: 9 },
    )
    expect(merged).toEqual({ inputTokens: 10, totalTokens: 9 })
  })

  it("同一字段两侧都有：add 求和；仅单侧出现的字段原样保留", () => {
    const merged = addLlmUsage(
      { inputTokens: 2, cachedInputTokens: 5 },
      { inputTokens: 3, outputTokens: 4 },
    )
    expect(merged).toEqual({ inputTokens: 5, cachedInputTokens: 5, outputTokens: 4 })
  })

  it("两侧字段完全互不相交时也不丢字段（空并集不触发提前返回）", () => {
    expect(mergeLlmUsageSnapshot({ cachedInputTokens: 1 }, { cacheWriteInputTokens: 2 })).toEqual({
      cachedInputTokens: 1,
      cacheWriteInputTokens: 2,
    })
  })
})
