/** C4 冒烟覆盖：src/lib/llm-usage.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { mergeLlmUsageSnapshot, addLlmUsage } from "./llm-usage"
describe("llm-usage.ts smoke", () => {
  it("exports mergeLlmUsageSnapshot", () => {
    expect(mergeLlmUsageSnapshot).toBeDefined()
  })
  it("exports addLlmUsage", () => {
    expect(addLlmUsage).toBeDefined()
  })
})
