/** C4 冒烟覆盖：src/lib/agent/task-breakpoint.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createTaskBreakpoint, updateBreakpointStage, saveTaskBreakpoint, loadTaskBreakpoint, clearTaskBreakpoint, buildBreakpointResumePrompt } from "./task-breakpoint"
describe("task-breakpoint.ts smoke", () => {
  it("exports createTaskBreakpoint", () => {
    expect(createTaskBreakpoint).toBeDefined()
  })
  it("exports updateBreakpointStage", () => {
    expect(updateBreakpointStage).toBeDefined()
  })
  it("exports saveTaskBreakpoint", () => {
    expect(saveTaskBreakpoint).toBeDefined()
  })
  it("exports loadTaskBreakpoint", () => {
    expect(loadTaskBreakpoint).toBeDefined()
  })
  it("exports clearTaskBreakpoint", () => {
    expect(clearTaskBreakpoint).toBeDefined()
  })
  it("exports buildBreakpointResumePrompt", () => {
    expect(buildBreakpointResumePrompt).toBeDefined()
  })
})
