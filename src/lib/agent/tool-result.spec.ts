/** C4 冒烟覆盖：src/lib/agent/tool-result.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_TOOL_RESULT_CONTEXT_LIMIT, isToolErrorResult, keepsFullToolResultForModel, formatToolResultForModel } from "./tool-result"
describe("tool-result.ts smoke", () => {
  it("exports DEFAULT_TOOL_RESULT_CONTEXT_LIMIT", () => {
    expect(DEFAULT_TOOL_RESULT_CONTEXT_LIMIT).toBeDefined()
  })
  it("exports isToolErrorResult", () => {
    expect(isToolErrorResult).toBeDefined()
  })
  it("exports keepsFullToolResultForModel", () => {
    expect(keepsFullToolResultForModel).toBeDefined()
  })
  it("exports formatToolResultForModel", () => {
    expect(formatToolResultForModel).toBeDefined()
  })
})
