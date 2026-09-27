/** C4 冒烟覆盖：src/lib/novel/deep-chapter-resolve.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { resolveCurrentChapterLengthSpec, resolveWritingConfig, applyCachePrefix } from "./deep-chapter-resolve"
describe("deep-chapter-resolve.ts smoke", () => {
  it("exports resolveCurrentChapterLengthSpec", () => {
    expect(resolveCurrentChapterLengthSpec).toBeDefined()
  })
  it("exports resolveWritingConfig", () => {
    expect(resolveWritingConfig).toBeDefined()
  })
  it("exports applyCachePrefix", () => {
    expect(applyCachePrefix).toBeDefined()
  })
})
