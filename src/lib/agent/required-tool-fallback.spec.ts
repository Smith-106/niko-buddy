/** C4 冒烟覆盖：src/lib/agent/required-tool-fallback.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { isRequiredToolExecutionFulfilled, executeRequiredToolFallback } from "./required-tool-fallback"
describe("required-tool-fallback.ts smoke", () => {
  it("exports isRequiredToolExecutionFulfilled", () => {
    expect(isRequiredToolExecutionFulfilled).toBeDefined()
  })
  it("exports executeRequiredToolFallback", () => {
    expect(executeRequiredToolFallback).toBeDefined()
  })
})
