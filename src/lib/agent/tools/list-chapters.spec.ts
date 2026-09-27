/** C4 冒烟覆盖：src/lib/agent/tools/list-chapters.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createListChaptersTool } from "./list-chapters"
describe("list-chapters.ts smoke", () => {
  it("exports createListChaptersTool", () => {
    expect(createListChaptersTool).toBeDefined()
  })
})
