/** C4 冒烟覆盖：src/lib/reasoning-retry.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { hasUnreplayableToolAssistantReasoning, stripEmptyReasoningContent, isReasoningOnlyResponseError, isReasoningDisabled, withReasoningDisabled } from "./reasoning-retry"
describe("reasoning-retry.ts smoke", () => {
  it("exports hasUnreplayableToolAssistantReasoning", () => {
    expect(hasUnreplayableToolAssistantReasoning).toBeDefined()
  })
  it("exports stripEmptyReasoningContent", () => {
    expect(stripEmptyReasoningContent).toBeDefined()
  })
  it("exports isReasoningOnlyResponseError", () => {
    expect(isReasoningOnlyResponseError).toBeDefined()
  })
  it("exports isReasoningDisabled", () => {
    expect(isReasoningDisabled).toBeDefined()
  })
  it("exports withReasoningDisabled", () => {
    expect(withReasoningDisabled).toBeDefined()
  })
})
