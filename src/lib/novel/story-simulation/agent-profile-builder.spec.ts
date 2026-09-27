/** C4 冒烟覆盖：src/lib/novel/story-simulation/agent-profile-builder.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { buildAgents, getVisibleEvents, formatTimelineEvent, buildAgentContext } from "./agent-profile-builder"
describe("agent-profile-builder.ts smoke", () => {
  it("exports buildAgents", () => {
    expect(buildAgents).toBeDefined()
  })
  it("exports getVisibleEvents", () => {
    expect(getVisibleEvents).toBeDefined()
  })
  it("exports formatTimelineEvent", () => {
    expect(formatTimelineEvent).toBeDefined()
  })
  it("exports buildAgentContext", () => {
    expect(buildAgentContext).toBeDefined()
  })
})
