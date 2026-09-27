/** C4 冒烟覆盖：src/lib/agent/activity-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createAgentActivityEvent, createStageStartedEvent, appendAgentActivityEvent, applyAgentActivityEvent, summarizeAgentStage, getDefaultOpenAgentStageId, prepareAgentStagesForDisplay, settleRunningAgentStages, activityEventFromToolEvent, resolveAgentStageTitle } from "./activity-trace"
describe("activity-trace.ts smoke", () => {
  it("exports createAgentActivityEvent", () => {
    expect(createAgentActivityEvent).toBeDefined()
  })
  it("exports createStageStartedEvent", () => {
    expect(createStageStartedEvent).toBeDefined()
  })
  it("exports appendAgentActivityEvent", () => {
    expect(appendAgentActivityEvent).toBeDefined()
  })
  it("exports applyAgentActivityEvent", () => {
    expect(applyAgentActivityEvent).toBeDefined()
  })
  it("exports summarizeAgentStage", () => {
    expect(summarizeAgentStage).toBeDefined()
  })
  it("exports getDefaultOpenAgentStageId", () => {
    expect(getDefaultOpenAgentStageId).toBeDefined()
  })
  it("exports prepareAgentStagesForDisplay", () => {
    expect(prepareAgentStagesForDisplay).toBeDefined()
  })
  it("exports settleRunningAgentStages", () => {
    expect(settleRunningAgentStages).toBeDefined()
  })
  it("exports activityEventFromToolEvent", () => {
    expect(activityEventFromToolEvent).toBeDefined()
  })
  it("exports resolveAgentStageTitle", () => {
    expect(resolveAgentStageTitle).toBeDefined()
  })
})
