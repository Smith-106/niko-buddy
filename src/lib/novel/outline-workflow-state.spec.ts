/** C4 冒烟覆盖：src/lib/novel/outline-workflow-state.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createInitialOutlineWorkflowState, canTransitionOutlineWorkflow, transitionOutlineWorkflow } from "./outline-workflow-state"
describe("outline-workflow-state.ts smoke", () => {
  it("createInitialOutlineWorkflowState() executes", async () => {
    await (createInitialOutlineWorkflowState() as unknown as Promise<unknown>)
  })
  it("exports canTransitionOutlineWorkflow", () => {
    expect(canTransitionOutlineWorkflow).toBeDefined()
  })
  it("exports transitionOutlineWorkflow", () => {
    expect(transitionOutlineWorkflow).toBeDefined()
  })
})
