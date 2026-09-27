/** C4 冒烟覆盖：src/lib/novel/outline-intent-clarity.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { classifyDirectOutlineGenerationRequest, shouldAutoFollowUpGeneration, parseIntentClarity, parseIntentClarityProtocol, buildIntentAnalysisPrompt, buildIntentPhaseSystemRules, stripStructuredMarkers } from "./outline-intent-clarity"
describe("outline-intent-clarity.ts smoke", () => {
  it("exports classifyDirectOutlineGenerationRequest", () => {
    expect(classifyDirectOutlineGenerationRequest).toBeDefined()
  })
  it("exports shouldAutoFollowUpGeneration", () => {
    expect(shouldAutoFollowUpGeneration).toBeDefined()
  })
  it("exports parseIntentClarity", () => {
    expect(parseIntentClarity).toBeDefined()
  })
  it("exports parseIntentClarityProtocol", () => {
    expect(parseIntentClarityProtocol).toBeDefined()
  })
  it("exports buildIntentAnalysisPrompt", () => {
    expect(buildIntentAnalysisPrompt).toBeDefined()
  })
  it("exports buildIntentPhaseSystemRules", () => {
    expect(buildIntentPhaseSystemRules).toBeDefined()
  })
  it("exports stripStructuredMarkers", () => {
    expect(stripStructuredMarkers).toBeDefined()
  })
})
