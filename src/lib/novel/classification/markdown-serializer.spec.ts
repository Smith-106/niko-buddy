/** C4 冒烟覆盖：src/lib/novel/classification/markdown-serializer.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { serializeClassificationToMarkdown, deserializeClassificationFromMarkdown, generateDefaultClassificationMarkdown } from "./markdown-serializer"
describe("markdown-serializer.ts smoke", () => {
  it("exports serializeClassificationToMarkdown", () => {
    expect(serializeClassificationToMarkdown).toBeDefined()
  })
  it("exports deserializeClassificationFromMarkdown", () => {
    expect(deserializeClassificationFromMarkdown).toBeDefined()
  })
  it("generateDefaultClassificationMarkdown() executes", async () => {
    await (generateDefaultClassificationMarkdown() as unknown as Promise<unknown>)
  })
})
