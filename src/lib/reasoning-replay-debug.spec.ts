/** C4 冒烟覆盖：src/lib/reasoning-replay-debug.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { logReasoningReplay, isReasoningContentRequiredError, summarizeReasoningReplayRisk, formatReasoningReplayRiskForError } from "./reasoning-replay-debug"
describe("reasoning-replay-debug.ts smoke", () => {
  it("exports logReasoningReplay", () => {
    expect(logReasoningReplay).toBeDefined()
  })
  it("exports isReasoningContentRequiredError", () => {
    expect(isReasoningContentRequiredError).toBeDefined()
  })
  it("exports summarizeReasoningReplayRisk", () => {
    expect(summarizeReasoningReplayRisk).toBeDefined()
  })
  it("exports formatReasoningReplayRiskForError", () => {
    expect(formatReasoningReplayRiskForError).toBeDefined()
  })
})
