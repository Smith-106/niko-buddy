/** C4 冒烟覆盖：src/lib/novel/deep-chapter-utils.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { countChapterChars, assertNotAborted, sourceIndexFromCompactIndex, findRepeatedTailStart, trimForThinking, fallback, summaryText, severityLabel } from "./deep-chapter-utils"
describe("deep-chapter-utils.ts smoke", () => {
  it("exports countChapterChars", () => {
    expect(countChapterChars).toBeDefined()
  })
  it("exports assertNotAborted", () => {
    expect(assertNotAborted).toBeDefined()
  })
  it("exports sourceIndexFromCompactIndex", () => {
    expect(sourceIndexFromCompactIndex).toBeDefined()
  })
  it("exports findRepeatedTailStart", () => {
    expect(findRepeatedTailStart).toBeDefined()
  })
  it("exports trimForThinking", () => {
    expect(trimForThinking).toBeDefined()
  })
  it("exports fallback", () => {
    expect(fallback).toBeDefined()
  })
  it("exports summaryText", () => {
    expect(summaryText).toBeDefined()
  })
  it("exports severityLabel", () => {
    expect(severityLabel).toBeDefined()
  })
})
