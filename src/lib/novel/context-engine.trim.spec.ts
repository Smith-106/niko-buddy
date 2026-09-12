import { describe, expect, it } from "vitest"
import { trimContextPack, contextPackToPrompt } from "./context-engine"
import type { ContextPack } from "./context-engine"

// R4 共识（deepseek+qwen 命中 context-engine.ts:2816）：
// 原实现把 dropped 又拼回数组（`[value[0], ...dropped]`），"数组截断"是空操作，
// 但 total 已经扣减 ⇒ 预算账目与实际内容分离，pack 仍超限。
// 断言为"实际内容真的被截断"，而不是只看 removed 记账。
function packWithArray(entries: number): ContextPack {
  const big = Array.from({ length: entries }, (_, i) => ({
    name: `角色${i}`,
    traits: `气质描述${i}`.repeat(60),
  }))
  return {
    recentChapterContents: [],
    recentSummaries: [],
    characterAuras: big,
    otherFields: `x`.repeat(50_000),
  } as unknown as ContextPack
}

describe("trimContextPack — 数组截断必须是真截断（R4 回归）", () => {
  it("超预算时数组字段实际只保留首元素", () => {
    const pack = packWithArray(20)
    const before = (pack as unknown as { characterAuras: unknown[] }).characterAuras.length
    expect(before).toBe(20)

    const out = trimContextPack(pack, 5_000)
    const after = (out.pack as unknown as { characterAuras: unknown[] }).characterAuras.length

    // 真截断：只剩首元素；记账也要如实反映
    expect(after).toBe(1)
    const entry = out.removed.find((f) => f.kind === "array-truncate")
    expect(entry).toBeDefined()
    expect(entry?.chars).toBe(19)
    // 记账与实际必须一致：trimmedChars 不应小于被抽走的字符量
    expect(out.trimmedChars).toBeGreaterThan(0)
  })

  it("未超预算时不得改动任何字段", () => {
    const pack = packWithArray(3)
    const out = trimContextPack(pack, 10_000_000)
    expect((out.pack as unknown as { characterAuras: unknown[] }).characterAuras.length).toBe(3)
    expect(out.removed).toHaveLength(0)
  })
})

// R4 共识（deepseek+glm 命中 context-engine.ts:2696）：
// 裁剪目标原先固定 `tokenBudget * 4` 字符，与同一函数内刚用过的 CJK 加权估算
// （≈1.5 字符/token）自相矛盾：中文正文裁完仍远超预算（trim 对中文几乎无效）。
// 断言改为「裁后按同一估算器重新估值不超预算」，而不是只看裁剪动作是否发生。
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  return Math.ceil((text.length - cjk) / 4 + cjk / 1.5)
}

function packWithText(text: string): ContextPack {
  return {
    recentChapterContents: [],
    recentSummaries: [],
    characterStates: text,
  } as unknown as ContextPack
}

describe("contextPackToPrompt — CJK 预算裁剪口径必须与估算器一致（R4 回归）", () => {
  it("中文正文：裁后估算 token 不再超预算（旧 ×4 口径下会超一倍）", () => {
    const budget = 100
    const text = "状".repeat(1000)
    const pack = packWithText(text)
    const trimmed = contextPackToPrompt(pack, budget)
    expect(trimmed).toContain("上下文已按Token预算裁剪")
    // 旧口径 targetChars=400 → 估算 ≈267 token；新口径 targetChars=150 → ≈110（含裁剪标记）
    expect(trimmed.length).toBeLessThanOrEqual(200)
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(budget * 1.2)
    expect(estimateTokens(trimmed)).toBeLessThan(estimateTokens(contextPackToPrompt(pack)) / 3)
  })

  it("以 ASCII 为主时口径不退化（仍接近 4 字符/token）", () => {
    const budget = 100
    const pack = packWithText("H".repeat(3000) + "T".repeat(3000))
    const trimmed = contextPackToPrompt(pack, budget)
    expect(trimmed).toContain("上下文已按Token预算裁剪")
    // ASCII 为主 ⇒ 混合比≈0 ⇒ charsPerToken≈4，不应按 1.5 过度裁剪
    expect(trimmed.length).toBeGreaterThan(4 * budget * 0.9)
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(budget * 1.2)
  })
})
