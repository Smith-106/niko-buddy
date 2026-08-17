import { describe, expect, it } from "vitest"
import {
  CHAPTER_WINDOW_OMISSION_MARK,
  DEFAULT_REVIEW_CHAPTER_MAX_CHARS,
  resolveReviewChapterMaxChars,
  sliceChapterForReview,
} from "./chapter-window"

describe("chapter-window (expand-measure-window)", () => {
  it("returns short content unchanged", () => {
    expect(sliceChapterForReview("abc", 100)).toBe("abc")
  })

  it("default max is 16000", () => {
    expect(resolveReviewChapterMaxChars(undefined, {})).toBe(DEFAULT_REVIEW_CHAPTER_MAX_CHARS)
    expect(DEFAULT_REVIEW_CHAPTER_MAX_CHARS).toBe(16_000)
  })

  it("honors REVIEW_CHAPTER_MAX_CHARS env", () => {
    expect(resolveReviewChapterMaxChars(undefined, { REVIEW_CHAPTER_MAX_CHARS: "12000" })).toBe(12_000)
  })

  it("head+tail keeps both ends when over budget", () => {
    const head = "H".repeat(100)
    const mid = "M".repeat(500)
    const tail = "T".repeat(100)
    const full = head + mid + tail
    const out = sliceChapterForReview(full, 250)
    expect(out.length).toBeLessThanOrEqual(250)
    expect(out.startsWith("H")).toBe(true)
    expect(out.endsWith("T")).toBe(true)
    expect(out).toContain(CHAPTER_WINDOW_OMISSION_MARK.trim())
    // middle-only mass should be reduced (not full mid preserved)
    expect(out.includes(mid)).toBe(false)
  })

  it("ch1-sized text with max 8000 includes a synthetic ending marker", () => {
    const body = "OPEN" + "x".repeat(9000) + "CHAPTER_END_HOOK"
    const out = sliceChapterForReview(body, 8000)
    expect(out.includes("OPEN")).toBe(true)
    expect(out.includes("CHAPTER_END_HOOK")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(8000)
  })

  it("ignores invalid env values and falls back to the default", () => {
    expect(resolveReviewChapterMaxChars(undefined, { REVIEW_CHAPTER_MAX_CHARS: "abc" })).toBe(DEFAULT_REVIEW_CHAPTER_MAX_CHARS)
    expect(resolveReviewChapterMaxChars(undefined, { REVIEW_CHAPTER_MAX_CHARS: "0" })).toBe(DEFAULT_REVIEW_CHAPTER_MAX_CHARS)
    expect(resolveReviewChapterMaxChars(undefined, { REVIEW_CHAPTER_MAX_CHARS: "" })).toBe(DEFAULT_REVIEW_CHAPTER_MAX_CHARS)
  })

  it("clamps env value to the [2000, 200000] production floor/cap", () => {
    expect(resolveReviewChapterMaxChars(undefined, { REVIEW_CHAPTER_MAX_CHARS: "10" })).toBe(2_000)
    expect(resolveReviewChapterMaxChars(undefined, { REVIEW_CHAPTER_MAX_CHARS: "99999999" })).toBe(200_000)
  })

  it("explicit overrides bypass the floor but still cap at 200000 and floor fractional values", () => {
    expect(resolveReviewChapterMaxChars(10, {})).toBe(10)
    expect(resolveReviewChapterMaxChars(500_000, {})).toBe(200_000)
    expect(resolveReviewChapterMaxChars(12.9, {})).toBe(12)
    expect(resolveReviewChapterMaxChars(0, {})).toBe(DEFAULT_REVIEW_CHAPTER_MAX_CHARS)
    expect(resolveReviewChapterMaxChars(Number.NaN, {})).toBe(DEFAULT_REVIEW_CHAPTER_MAX_CHARS)
  })

  it("falls back to pure head truncation when the budget cannot fit the omission mark", () => {
    const body = "A".repeat(100)
    const out = sliceChapterForReview(body, 20)
    expect(out.length).toBe(20)
    expect(out).toBe("A".repeat(20))
    expect(out).not.toContain("中间正文已省略")
  })
})
