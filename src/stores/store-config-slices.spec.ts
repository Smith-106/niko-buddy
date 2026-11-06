/**
 * store-config-slices.spec.ts — C6 步骤① 切片选择器契约的行为锁。
 *
 * 契约（见模块注释）：选择器是**只读消费**入口——返回的引用必须是 store 里那一个
 * 配置对象的同一引用（不 clone、不投影），否则消费者会被迫整 store 订阅并可能
 * 写回副本造成第二真源。
 */
import { describe, expect, it } from "vitest"
import type { LlmConfig, SearchApiConfig, SourceWatchConfig } from "./wiki-store"
import { selectLlmSlice, selectSearchSlice, selectSourceWatchSlice } from "./store-config-slices"
import type { ConfigSliceReadable } from "./store-config-slices"

const LLM = { provider: "custom", apiKey: "k", model: "m" } as unknown as LlmConfig
const SEARCH = { provider: "tavily", apiKey: "s" } as unknown as SearchApiConfig
const SOURCE_WATCH = { enabled: true, intervalMinutes: 30 } as unknown as SourceWatchConfig

const store = {
  llmConfig: LLM,
  searchApiConfig: SEARCH,
  embeddingConfig: {} as ConfigSliceReadable["embeddingConfig"],
  sourceWatchConfig: SOURCE_WATCH,
} satisfies ConfigSliceReadable

describe("配置切片选择器", () => {
  it("selectLlmSlice 返回 store 的同一 LLM 配置引用（零拷贝）", () => {
    expect(selectLlmSlice(store)).toBe(LLM)
  })

  it("selectSearchSlice 返回 store 的同一搜索配置引用", () => {
    const slice = selectSearchSlice(store)
    expect(slice).toBe(SEARCH)
    expect(slice.provider).toBe("tavily")
  })

  it("selectSourceWatchSlice 返回 store 的同一盯盘配置引用", () => {
    const slice = selectSourceWatchSlice(store)
    expect(slice).toBe(SOURCE_WATCH)
    // 零拷贝：切片就是 store 里那个对象（键集与顺序一并透传，未做投影）
    expect(Object.keys(slice)).toEqual(Object.keys(SOURCE_WATCH))
  })

  it("三个选择器互不串台（各自取对应字段）", () => {
    const picked = [
      selectLlmSlice(store) as unknown,
      selectSearchSlice(store) as unknown,
      selectSourceWatchSlice(store) as unknown,
    ]
    expect(new Set(picked.map((v) => JSON.stringify(v))).size).toBe(3)
  })
})
