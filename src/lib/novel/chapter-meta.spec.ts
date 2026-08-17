import { describe, expect, it } from "vitest"
import {
  isChapterPage,
  isFinalChapter,
  isOutlinePage,
  normalizeChapterStatus,
  parseChapterMeta,
  parseChapterNumber,
  updateChapterStatus,
} from "./chapter-meta"

describe("parseChapterNumber", () => {
  it("accepts finite numbers", () => {
    expect(parseChapterNumber(3)).toBe(3)
    expect(parseChapterNumber(0)).toBe(0)
    expect(parseChapterNumber(-2)).toBe(-2)
  })

  it("parses numeric strings after trimming", () => {
    expect(parseChapterNumber(" 12 ")).toBe(12)
    expect(parseChapterNumber("0")).toBe(0)
    expect(parseChapterNumber("-4")).toBe(-4)
  })

  it("rejects non-finite numbers, empty/whitespace strings and non-numeric values", () => {
    expect(parseChapterNumber(Number.NaN)).toBeNull()
    expect(parseChapterNumber(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseChapterNumber("")).toBeNull()
    expect(parseChapterNumber("   ")).toBeNull()
    expect(parseChapterNumber("abc")).toBeNull()
    expect(parseChapterNumber(null)).toBeNull()
    expect(parseChapterNumber(undefined)).toBeNull()
    expect(parseChapterNumber({})).toBeNull()
  })
})

describe("normalizeChapterStatus", () => {
  it("passes through valid statuses", () => {
    for (const status of ["outline", "draft", "revised", "final", "archived"]) {
      expect(normalizeChapterStatus(status)).toBe(status)
    }
  })

  it("falls back to draft for invalid / non-string values", () => {
    expect(normalizeChapterStatus("bogus")).toBe("draft")
    expect(normalizeChapterStatus(42)).toBe("draft")
    expect(normalizeChapterStatus(undefined)).toBe("draft")
    expect(normalizeChapterStatus(null)).toBe("draft")
    expect(normalizeChapterStatus("FINAL")).toBe("draft")
  })
})

describe("parseChapterMeta", () => {
  it("parses chapter number, status and outline type", () => {
    const meta = parseChapterMeta({
      chapter_number: 5,
      chapter_status: "final",
      outline_type: "chapter-outline",
    })
    expect(meta).toEqual({ chapterNumber: 5, status: "final", outlineType: "chapter-outline" })
  })

  it("accepts a string chapter_number and defaults status/outlineType", () => {
    const meta = parseChapterMeta({ chapter_number: "7" })
    expect(meta).toEqual({ chapterNumber: 7, status: "draft", outlineType: undefined })
  })

  it("returns null when chapter number is missing or invalid", () => {
    expect(parseChapterMeta({})).toBeNull()
    expect(parseChapterMeta({ chapter_number: "not-a-number" })).toBeNull()
  })
})

describe("isChapterPage / isOutlinePage / isFinalChapter", () => {
  it("detects chapter pages by type or chapter_number", () => {
    expect(isChapterPage({ type: "chapter" })).toBe(true)
    expect(isChapterPage({ chapter_number: 3 })).toBe(true)
    expect(isChapterPage({})).toBe(false)
    expect(isChapterPage({ type: "outline" })).toBe(false)
  })

  it("detects outline pages by type or outline_type", () => {
    expect(isOutlinePage({ type: "outline" })).toBe(true)
    expect(isOutlinePage({ outline_type: "volume-outline" })).toBe(true)
    expect(isOutlinePage({ outline_type: "story-outline" })).toBe(true)
    expect(isOutlinePage({})).toBe(false)
    expect(isOutlinePage({ type: "chapter" })).toBe(false)
  })

  it("checks final status via normalizeChapterStatus", () => {
    expect(isFinalChapter({ chapter_status: "final" })).toBe(true)
    expect(isFinalChapter({ chapter_status: "draft" })).toBe(false)
    expect(isFinalChapter({})).toBe(false)
  })
})

describe("updateChapterStatus", () => {
  it("rewrites frontmatter chapter_status and preserves body", () => {
    const content = `---\nchapter_number: 2\nchapter_status: draft\ntitle: "第2章"\n---\n\n# 第2章\n\n正文内容\n`
    const updated = updateChapterStatus(content, "final")
    expect(updated).toContain("chapter_status: final")
    // yaml.dump quotes the string-typed number from parseFrontmatter
    expect(updated).toContain("chapter_number: '2'")
    expect(updated).toContain("正文内容")
    expect(updated.startsWith("---\n")).toBe(true)
  })

  it("adds chapter_status when the file has no frontmatter fields to carry over", () => {
    const updated = updateChapterStatus("# 只有正文\n\n段落", "revised")
    expect(updated).toContain("chapter_status: revised")
    expect(updated).toContain("段落")
  })
})
