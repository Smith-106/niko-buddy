/** C4 冒烟覆盖：src/lib/agent/workflow-mode.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_AI_WORKFLOW_MODE, DEFAULT_OUTLINE_WORKFLOW_MODE, isAiWorkflowMode, isOutlineWorkflowMode, resolveAiWorkflowMode, resolveOutlineWorkflowMode, getWorkflowModeLabel } from "./workflow-mode"
describe("workflow-mode.ts smoke", () => {
  it("exports DEFAULT_AI_WORKFLOW_MODE", () => {
    expect(DEFAULT_AI_WORKFLOW_MODE).toBeDefined()
  })
  it("exports DEFAULT_OUTLINE_WORKFLOW_MODE", () => {
    expect(DEFAULT_OUTLINE_WORKFLOW_MODE).toBeDefined()
  })
  it("exports isAiWorkflowMode", () => {
    expect(isAiWorkflowMode).toBeDefined()
  })
  it("exports isOutlineWorkflowMode", () => {
    expect(isOutlineWorkflowMode).toBeDefined()
  })
  it("exports resolveAiWorkflowMode", () => {
    expect(resolveAiWorkflowMode).toBeDefined()
  })
  it("exports resolveOutlineWorkflowMode", () => {
    expect(resolveOutlineWorkflowMode).toBeDefined()
  })
  it("exports getWorkflowModeLabel", () => {
    expect(getWorkflowModeLabel).toBeDefined()
  })

  it("isOutlineWorkflowMode 只认 fast/standard", () => {
    expect(isOutlineWorkflowMode("fast")).toBe(true)
    expect(isOutlineWorkflowMode("standard")).toBe(true)
    expect(isOutlineWorkflowMode("deep")).toBe(false)
    expect(isOutlineWorkflowMode(null)).toBe(false)
  })

  it("resolveOutlineWorkflowMode：fast 保留，其余回退默认", () => {
    expect(resolveOutlineWorkflowMode("fast")).toBe("fast")
    expect(resolveOutlineWorkflowMode("standard")).toBe(DEFAULT_OUTLINE_WORKFLOW_MODE)
    expect(resolveOutlineWorkflowMode(undefined)).toBe(DEFAULT_OUTLINE_WORKFLOW_MODE)
  })
})
