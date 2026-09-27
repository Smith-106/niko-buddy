/** C4 冒烟覆盖：src/lib/novel/outline-next-step.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { isRecommendationForbidden, parseNextStep, extractNextStep, cleanNextStepArtifacts, buildNextStepPromptSuffix } from "./outline-next-step"
describe("outline-next-step.ts smoke", () => {
  it("exports isRecommendationForbidden", () => {
    expect(isRecommendationForbidden).toBeDefined()
  })
  it("exports parseNextStep", () => {
    expect(parseNextStep).toBeDefined()
  })
  it("exports extractNextStep", () => {
    expect(extractNextStep).toBeDefined()
  })
  it("exports cleanNextStepArtifacts", () => {
    expect(cleanNextStepArtifacts).toBeDefined()
  })
  it("buildNextStepPromptSuffix() executes", async () => {
    await (buildNextStepPromptSuffix() as unknown as Promise<unknown>)
  })
})
