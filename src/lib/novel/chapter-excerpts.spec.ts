/** C4 冒烟覆盖：src/lib/novel/chapter-excerpts.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { CHAPTER_BODY_EXCERPT_MAX_CHARS } from "./chapter-excerpts"
describe("chapter-excerpts.ts smoke", () => {
  it("exports CHAPTER_BODY_EXCERPT_MAX_CHARS", () => {
    expect(CHAPTER_BODY_EXCERPT_MAX_CHARS).toBeDefined()
  })
})
