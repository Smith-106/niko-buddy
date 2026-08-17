// aura-match.spec.ts
// 拆书角色 aura 匹配工具（book-analysis/aura-match.ts）覆盖补齐
// 目标：s/l/b/f 100%（aura-adapter.spec.ts 不直接 import 本模块）
import { describe, expect, it } from "vitest"
import { bookAnalysisAuraKey, isSameBookAnalysisCharacterAura } from "./aura-match"
import type { CharacterAura } from "@/lib/novel/character-aura"

function baseAura(overrides: Partial<CharacterAura> = {}): CharacterAura {
  return {
    id: "aura-1",
    name: "白砚",
    category: "拆书角色",
    sourceNote: "《雾隐长安》角色",
    builtIn: false,
    ...overrides,
  } as CharacterAura
}

describe("book-analysis/aura-match", () => {
  it("bookAnalysisAuraKey 拼接 trim 后的书题与角色名 (\\u0000 分隔)", () => {
    expect(bookAnalysisAuraKey(" 雾隐长安 ", " 白砚 ")).toBe("雾隐长安\u0000白砚")
    expect(bookAnalysisAuraKey("雾隐长安", "白砚")).toBe("雾隐长安\u0000白砚")
  })

  it("builtIn 灵魂永远不算拆书角色 aura", () => {
    const aura = baseAura({ builtIn: true })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(false)
  })

  it("category 不在拆书角色集合内返回 false", () => {
    const aura = baseAura({ category: "自定义灵魂" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(false)
  })

  it("category 为乱码变体（鎷嗕功瑙掕壊）仍命中", () => {
    const aura = baseAura({ category: "鎷嗕功瑙掕壊" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(true)
  })

  it("角色名不一致返回 false", () => {
    const aura = baseAura({ name: "王迦" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(false)
  })

  it("category 为 undefined/null 时走 ?? \"\" 回退并返回 false", () => {
    const aura = baseAura({ category: undefined })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(false)
    const auraNull = baseAura({ category: null as unknown as string })
    expect(isSameBookAnalysisCharacterAura(auraNull, "雾隐长安", "白砚")).toBe(false)
  })

  it("四个文本字段都不含书题时返回 false", () => {
    const aura = baseAura({ sourceNote: "无书题", corpus: "", notes: "", generationPrompt: "" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(false)
  })

  it("sourceNote 含书题即命中", () => {
    const aura = baseAura({ sourceNote: "出自《雾隐长安》" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(true)
  })

  it("corpus 含书题即命中", () => {
    const aura = baseAura({ sourceNote: "", corpus: "《雾隐长安》摘录" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(true)
  })

  it("generationPrompt 含书题即命中", () => {
    const aura = baseAura({ sourceNote: "", notes: "", generationPrompt: "《雾隐长安》生成" })
    expect(isSameBookAnalysisCharacterAura(aura, "雾隐长安", "白砚")).toBe(true)
  })
})
