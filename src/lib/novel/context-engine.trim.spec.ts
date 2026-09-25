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

// §GAP-103(f): trimContextPack 须 honor excludeOutline（与 contextPackToPrompt 同语义）。
// 默认 falsy/缺省时 prompt 含 outline（字节级等价旧实现）；true 时两路径均跳过 outline。
function packWithOutline(): ContextPack {
  return {
    task: "任务正文",
    outline: "大纲正文UNIQUE-OUTLINE-103",
    soulDoc: "灵魂文档",
    recentChapterContents: [],
    recentSummaries: [],
  } as unknown as ContextPack
}

describe("trimContextPack — excludeOutline 与 contextPackToPrompt 同语义（§GAP-103(f)）", () => {
  it("缺省/undefined/空对象：prompt 含 outline（字节级等价旧实现）", () => {
    const pack = packWithOutline()
    expect(trimContextPack(pack, 10_000_000).prompt).toContain("大纲正文UNIQUE-OUTLINE-103")
    expect(trimContextPack(pack, 10_000_000, undefined).prompt).toContain("大纲正文UNIQUE-OUTLINE-103")
    expect(trimContextPack(pack, 10_000_000, {}).prompt).toContain("大纲正文UNIQUE-OUTLINE-103")
  })

  it("excludeOutline=true：under-budget 与 trim 后两路径 prompt 均跳过 outline", () => {
    const pack = packWithOutline()
    const under = trimContextPack(pack, 10_000_000, { excludeOutline: true })
    expect(under.prompt).not.toContain("大纲正文UNIQUE-OUTLINE-103")
    expect(under.prompt).toContain("任务正文")
    const over = trimContextPack(
      { ...pack, otherFields: "x".repeat(50_000) } as unknown as ContextPack,
      5_000,
      { excludeOutline: true },
    )
    expect(over.prompt ?? "").not.toContain("大纲正文UNIQUE-OUTLINE-103")
  })

  it("RV-004 组合面：excludeOutline=true 且超预算裁剪触发时不抛错且 prompt 无 outline", () => {
    const pack = {
      task: "任务正文",
      outline: "大纲正文UNIQUE-OUTLINE-103",
      soulDoc: "灵魂文档",
      searchResults: "索".repeat(30_000),
      graphSearchResults: "图".repeat(30_000),
      recentChapterContents: ["正".repeat(30_000)],
    } as unknown as ContextPack
    const before = JSON.stringify(pack).length
    const out = trimContextPack(pack, 5_000, { excludeOutline: true })
    expect(out.prompt ?? "").not.toContain("大纲正文UNIQUE-OUTLINE-103")
    expect(out.prompt ?? "").toContain("任务正文")
    expect(out.prompt ?? "").toContain("灵魂文档")
    expect(out.removed.length).toBeGreaterThan(0)
    // F5-04 partition 不变量：记账与实际一致，removed/保留互斥且并集为输入。
    expect(out.originalChars).toBe(before)
    expect(out.finalChars).toBe(JSON.stringify(out.pack).length)
    expect(out.trimmedChars).toBe(before - (out.finalChars ?? 0))
    const removedLabels = out.trimmedFields ?? []
    expect(new Set(removedLabels).size).toBe(removedLabels.length)
    // 预算口径（字符数）：记账均以 JSON 字符长度量；超预算后裁剪量的确推进（final < original）。
    expect(out.finalChars ?? before).toBeLessThan(before)
    // 力学如实记录（best-effort 非硬达标）：每字段至多截断至 2000 字符 / 数组留首元素，
    // 一轮穷尽后仍可超预算 — 本组合即如此（final 34139 > 预算 5000），但删减确已发生。
    // drop 序真实生效：序值 10/20 的两检索段被截断至 2000 字符（soulDoc 序值 180 未轮到故保留）。
    expect(out.pack.searchResults as string).toHaveLength(2000)
    expect(out.pack.graphSearchResults as string).toHaveLength(2000)
    expect(out.pack.soulDoc as string).toBe("灵魂文档")
  })

  it("RV-009 量纲归一化：budgetUnit 缺省 chars 时为恒等变换（字节级等价）", () => {
    const pack = packWithOutline()
    const a = trimContextPack(pack, 5_000)
    const b = trimContextPack(pack, 5_000, { budgetUnit: "chars" })
    expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack))
    expect(a.removed).toEqual(b.removed)
  })

  it("RV-009 量纲归一化：budgetUnit tokens 时预算按 CJK 加权换算放大（修正过度裁剪）", () => {
    const pack = {
      task: "任务正文",
      outline: "大纲正文UNIQUE-OUTLINE-103",
      soulDoc: "灵魂文档",
      searchResults: "索".repeat(30_000),
      graphSearchResults: "图".repeat(30_000),
      recentChapterContents: ["正".repeat(30_000)],
    } as unknown as ContextPack
    // 中文包 chars/token ≈ 1.5：5000 tokens 换算后 ≈ 7500+ 字符 > 5000 字符预算，
    // 故 tokens 路径裁剪量必须 ≤ chars 路径裁剪量（预算更大，删得更少）。
    const byChars = trimContextPack(pack, 5_000, { excludeOutline: true })
    const byTokens = trimContextPack(pack, 5_000, { excludeOutline: true, budgetUnit: "tokens" })
    expect(byTokens.finalChars ?? 0).toBeGreaterThanOrEqual(byChars.finalChars ?? 0)
    expect(byTokens.removed.length).toBeLessThanOrEqual(byChars.removed.length)
  })

  it("RV-014 退化输入：空包 tokens 归一化不产生 NaN（回退 ASCII 口径）", () => {
    // RV-023/RV-024：空包判据用结构判据（零可裁剪字段）而非长度哨兵 —
    // originalChars==2 只是 "{}" 序列化的附带事实（美化输出即变），不作分类依据。
    // RV-032 非空真守卫：originalChars>0 之外的恒等断言无内容可保时空真 —
    // 此处为空包场景，故断言 removed 空 + final==original，且 originalChars 如实为序列化长度。
    const pack = {} as unknown as ContextPack
    const out = trimContextPack(pack, 5_000, { budgetUnit: "tokens" })
    expect(out.removed).toEqual([])
    expect(out.originalChars).toBe(JSON.stringify(pack).length)
    expect(out.originalChars ?? 0).toBeGreaterThan(0) // 非空真守卫：序列化信封非空
    expect(out.finalChars).toBe(out.originalChars)
  })

  it("RV-019 非空未裁剪：removed 空但 originalChars>0 且 final==original", () => {
    const pack = packWithOutline()
    const out = trimContextPack(pack, 10_000_000, { budgetUnit: "tokens" })
    expect(out.removed).toEqual([])
    expect(out.originalChars ?? 0).toBeGreaterThan(0)
    expect(out.finalChars).toBe(out.originalChars)
  })

  it("excludeOutline=false：prompt 含 outline", () => {
    const pack = packWithOutline()
    expect(trimContextPack(pack, 10_000_000, { excludeOutline: false }).prompt).toContain(
      "大纲正文UNIQUE-OUTLINE-103",
    )
  })
})
