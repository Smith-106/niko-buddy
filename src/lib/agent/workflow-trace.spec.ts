/** C4 冒烟覆盖：src/lib/agent/workflow-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { isWebResearchToolName, getWorkflowToolResultDisplay, getWorkflowToolDescription, buildAgentWorkflowSteps } from "./workflow-trace"
describe("workflow-trace.ts smoke", () => {
  it("exports isWebResearchToolName", () => {
    expect(isWebResearchToolName).toBeDefined()
  })
  it("exports getWorkflowToolResultDisplay", () => {
    expect(getWorkflowToolResultDisplay).toBeDefined()
  })
  it("exports getWorkflowToolDescription", () => {
    expect(getWorkflowToolDescription).toBeDefined()
  })
  it("exports buildAgentWorkflowSteps", () => {
    expect(buildAgentWorkflowSteps).toBeDefined()
  })
})
