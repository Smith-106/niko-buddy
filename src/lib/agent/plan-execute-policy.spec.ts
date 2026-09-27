/** C4 冒烟覆盖：src/lib/agent/plan-execute-policy.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { WRITING_INTENTS, shouldRequirePlan, buildPlanExecutePolicyPrompt } from "./plan-execute-policy"
describe("plan-execute-policy.ts smoke", () => {
  it("exports WRITING_INTENTS", () => {
    expect(WRITING_INTENTS).toBeDefined()
  })
  it("exports shouldRequirePlan", () => {
    expect(shouldRequirePlan).toBeDefined()
  })
  it("exports buildPlanExecutePolicyPrompt", () => {
    expect(buildPlanExecutePolicyPrompt).toBeDefined()
  })
})
