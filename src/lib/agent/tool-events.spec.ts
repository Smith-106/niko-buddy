/** C4 冒烟覆盖：src/lib/agent/tool-events.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { applyAgentToolEvent, settleRunningAgentToolCalls, activityEventFromAgentToolEvent, applyAgentToolActivityEvent } from "./tool-events"
describe("tool-events.ts smoke", () => {
  it("exports applyAgentToolEvent", () => {
    expect(applyAgentToolEvent).toBeDefined()
  })
  it("exports settleRunningAgentToolCalls", () => {
    expect(settleRunningAgentToolCalls).toBeDefined()
  })
  it("exports activityEventFromAgentToolEvent", () => {
    expect(activityEventFromAgentToolEvent).toBeDefined()
  })
  it("exports applyAgentToolActivityEvent", () => {
    expect(applyAgentToolActivityEvent).toBeDefined()
  })
})
