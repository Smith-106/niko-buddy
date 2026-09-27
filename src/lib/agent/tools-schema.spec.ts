/** C4 冒烟覆盖：src/lib/agent/tools-schema.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { toOpenAITools } from "./tools-schema"
describe("tools-schema.ts smoke", () => {
  it("exports toOpenAITools", () => {
    expect(toOpenAITools).toBeDefined()
  })
})
