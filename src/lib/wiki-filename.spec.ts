import { describe, expect, it } from "vitest"
import {
  makeChapterFileStem,
  makeChapterFileName,
  makeDefaultChapterTitle,
  makeQueryFileName,
  makeQuerySlug,
  makeSafeFileSlug,
  yamlEscape,
} from "./wiki-filename"

describe("makeQuerySlug", () => {
  it("lowercases, hyphenates whitespace and keeps letters/digits", () => {
    expect(makeQuerySlug("Hello World")).toBe("hello-world")
    expect(makeQuerySlug("  多  个 空格  ")).toBe("多-个-空格")
  })

  it("normalizes NFKC full-width forms", () => {
    expect(makeQuerySlug("Ｈｅｌｌｏ　Ｗｏｒｌｄ")).toBe("hello-world")
  })

  it("strips punctuation and symbols, collapsing repeated dashes", () => {
    expect(makeQuerySlug("C++ Guide!! (2024)")).toBe("c-guide-2024")
    expect(makeQuerySlug("a - b -- c")).toBe("a-b-c")
  })

  it("keeps CJK characters", () => {
    expect(makeQuerySlug("默会知识")).toBe("默会知识")
  })

  it("trims leading/trailing dashes", () => {
    expect(makeQuerySlug("- leading dash -")).toBe("leading-dash")
  })

  it("truncates to 50 chars", () => {
    const long = makeQuerySlug("x".repeat(80))
    expect(long.length).toBe(50)
    expect(long).toBe("x".repeat(50))
  })

  it("falls back to 'query' when nothing survives", () => {
    expect(makeQuerySlug("!!!")).toBe("query")
    expect(makeQuerySlug("   ")).toBe("query")
  })
})

describe("makeQueryFileName", () => {
  it("builds slug-date-time filename with colon-free UTC time", () => {
    const now = new Date("2026-03-05T08:09:10.000Z")
    const result = makeQueryFileName("Hello World", now)
    expect(result).toEqual({
      slug: "hello-world",
      date: "2026-03-05",
      time: "080910",
      fileName: "hello-world-2026-03-05-080910.md",
    })
  })

  it("defaults to the current time", () => {
    const before = new Date()
    const result = makeQueryFileName("Query")
    const after = new Date()
    expect(result.fileName).toMatch(/^query-\d{4}-\d{2}-\d{2}-\d{6}\.md$/)
    const parsed = result.fileName.slice("query-".length, -3) // drop ".md"
    // fileName is built from `now` captured inside the function, which must
    // fall between the snapshots taken around the call.
    expect(parsed >= isoSlice(before)).toBe(true)
    expect(parsed <= isoSlice(after)).toBe(true)
  })
})

function isoSlice(d: Date): string {
  const iso = d.toISOString()
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}`
}

describe("makeSafeFileSlug", () => {
  it("replaces path-hostile characters with dashes", () => {
    expect(makeSafeFileSlug('a\\b/c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j")
  })

  it("keeps dots, underscores and dashes, preserving case", () => {
    expect(makeSafeFileSlug("My File_v2.1.md")).toBe("My-File_v2.1.md")
  })

  it("normalizes NFKC and collapses repeated dashes", () => {
    expect(makeSafeFileSlug("Ｆｕｌｌ  --  Ｗｉｄｔｈ")).toBe("Full-Width")
  })

  it("truncates to 80 chars", () => {
    const slug = makeSafeFileSlug("y".repeat(120))
    expect(slug.length).toBe(80)
  })

  it("falls back to 'untitled' or the custom fallback when empty", () => {
    expect(makeSafeFileSlug("///")).toBe("untitled")
    expect(makeSafeFileSlug("///", "custom")).toBe("custom")
  })
})

describe("makeDefaultChapterTitle", () => {
  it("produces 第N章-名称 when a name is given", () => {
    expect(makeDefaultChapterTitle(3, "初遇")).toBe("第3章-初遇")
  })

  it("strips a chapter-number prefix from the name", () => {
    expect(makeDefaultChapterTitle(4, "第4章 初见")).toBe("第4章-初见")
    expect(makeDefaultChapterTitle(5, "第五章：重逢")).toBe("第5章-重逢")
    expect(makeDefaultChapterTitle(6, "第 12 节.深潜")).toBe("第6章-深潜")
  })

  it("falls back to bare 第N章 when the name is empty", () => {
    expect(makeDefaultChapterTitle(7, "")).toBe("第7章")
    expect(makeDefaultChapterTitle(8)).toBe("第8章")
  })

  it("clamps chapter numbers below 1 and truncates floats", () => {
    expect(makeDefaultChapterTitle(0, "零")).toBe("第1章-零")
    expect(makeDefaultChapterTitle(-3, "负")).toBe("第1章-负")
    expect(makeDefaultChapterTitle(2.9, "浮点")).toBe("第2章-浮点")
  })
})

describe("makeChapterFileStem / makeChapterFileName", () => {
  it("prefixes 第N章 when a positive finite chapter number is given", () => {
    expect(makeChapterFileStem("初遇", 3)).toBe("第3章-初遇")
    expect(makeChapterFileStem("第3章 初遇", 3)).toBe("第3章-初遇")
  })

  it("sanitizes the name part into a safe slug", () => {
    expect(makeChapterFileStem("A/B: C?", 2)).toBe("第2章-A-B-C")
  })

  it("returns bare 第N章 when the cleaned name is empty", () => {
    expect(makeChapterFileStem("第1章", 1)).toBe("第1章")
  })

  it("falls back to makeSafeFileSlug for non-positive / missing chapter numbers", () => {
    expect(makeChapterFileStem("My Chapter", 0)).toBe("My-Chapter")
    expect(makeChapterFileStem("My Chapter", -1)).toBe("My-Chapter")
    expect(makeChapterFileStem("My Chapter")).toBe("My-Chapter")
    expect(makeChapterFileStem("My Chapter", null)).toBe("My-Chapter")
  })

  it("appends the .md extension via makeChapterFileName", () => {
    expect(makeChapterFileName("初遇", 3)).toBe("第3章-初遇.md")
    expect(makeChapterFileName("My Chapter", 0)).toBe("My-Chapter.md")
  })
})

describe("yamlEscape", () => {
  it("escapes backslashes and double quotes", () => {
    expect(yamlEscape('a\\b')).toBe("a\\\\b")
    expect(yamlEscape('say "hi"')).toBe('say \\"hi\\"')
    expect(yamlEscape('both "\\"')).toBe('both \\"\\\\\\"')
  })

  it("leaves plain text untouched", () => {
    expect(yamlEscape("plain text")).toBe("plain text")
  })
})
