import { describe, expect, it } from "vitest"
import { buildNameAliasMap, applyCanonicalNames, matchesAnyAlias, type NameAliasMap } from "./alias-resolver"

describe("alias-resolver", () => {
  it("builds map with canonical + merged aliases", () => {
    const m = buildNameAliasMap("许七安", ["大郎", "许哥", "许银锣", "大郎"])
    expect(m.canonical).toBe("许七安")
    expect(m.aliases).toEqual(expect.arrayContaining(["大郎", "许哥", "许银锣"]))
    expect(m.aliases).not.toContain("许七安")
    expect(new Set(m.aliases).size).toBe(m.aliases.length) // 去重
  })

  it("rejects self-alias (canonical repeated in aliases)", () => {
    const m = buildNameAliasMap("林动", ["林动", "小动"])
    expect(m.canonical).toBe("林动")
    expect(m.aliases).toEqual(["小动"])
  })

  it("rejects too-long aliases", () => {
    const long = "a".repeat(21) // 21 个 ASCII > 20
    const m = buildNameAliasMap("A", [long, "ok"])
    expect(m.aliases).toEqual(["ok"])
  })

  it("rejects pure-punctuation alias", () => {
    const m = buildNameAliasMap("A", ["...", "ok", "？"])
    expect(m.aliases).toEqual(["ok"])
  })

  it("trims whitespace and collapses spaces", () => {
    const m = buildNameAliasMap("A", ["  B  ", "C D", " C\tD "])
    expect(m.aliases).toEqual(["B", "CD"])
  })

  it("applyCanonicalNames replaces all aliases", () => {
    const m = buildNameAliasMap("许七安", ["大郎", "许银锣"])
    const text = "大郎走进了城门，许银锣对他说："
    const out = applyCanonicalNames(text, m)
    expect(out).toBe("许七安走进了城门，许七安对他说：")
  })

  it("matchesAnyAlias returns true for canonical or any alias", () => {
    const m = buildNameAliasMap("萧炎", ["萧哥哥", "炎儿"])
    expect(matchesAnyAlias("萧炎一拳", m)).toBe(true)
    expect(matchesAnyAlias("萧哥哥笑了", m)).toBe(true)
    expect(matchesAnyAlias("林修", m)).toBe(false)
  })

  it("ignores alias that normalizes to empty string (isValidAlias !s guard)", () => {
    const m = buildNameAliasMap("白砚", ["   ", "王迦"])
    // 纯空白 alias 规范化后为空串, isValidAlias 返回 false, 不入表
    expect(m.aliases).toEqual(["王迦"])
  })

  it("applyCanonicalNames skips empty-string aliases in a hand-built map", () => {
    // applyCanonicalNames 对 aliasMap.aliases 中的空串执行 `if (!alias) continue`
    const m: NameAliasMap = { canonical: "白砚", aliases: ["", "王迦"] }
    expect(applyCanonicalNames("白砚与王迦同行", m)).toBe("白砚与白砚同行")
  })
})
