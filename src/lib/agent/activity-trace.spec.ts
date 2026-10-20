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

describe("activityEventFromToolEvent — sourceRefs 窄化（四-15 行为锁）", () => {
  const base = {
    type: "result" as const,
    callId: "c1",
    name: "web_search",
    params: {},
    timestamp: 1,
  }
  it("params.sources 字符串数组 → web refs", () => {
    const ev = activityEventFromToolEvent({ ...base, params: { sources: ["指南 https://example.com/a"] } })
    expect(ev.sourceRefs).toEqual([{ title: "指南", path: "https://example.com/a", type: "web" }])
  })
  it("result JSON results 数组 → web refs", () => {
    const ev = activityEventFromToolEvent({
      ...base,
      result: JSON.stringify({ results: [{ url: "https://example.com/b", title: "B" }] }),
    })
    expect(ev.sourceRefs).toEqual([{ title: "B", path: "https://example.com/b", type: "web" }])
  })
  it("垃圾 result → sourceRefs undefined（不崩）", () => {
    const ev = activityEventFromToolEvent({ ...base, result: "not json at all" })
    expect(ev.sourceRefs).toBeUndefined()
  })
  it("result 数组 JSON → sourceRefs undefined（非对象守卫）", () => {
    const ev = activityEventFromToolEvent({ ...base, result: "[1,2]" })
    expect(ev.sourceRefs).toBeUndefined()
  })
})
