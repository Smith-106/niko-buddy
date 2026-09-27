/** C4 冒烟覆盖：src/lib/agent/runner.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ModelDoesNotSupportToolsError, AgentRunner } from "./runner"
describe("runner.ts smoke", () => {
  it("exports ModelDoesNotSupportToolsError", () => {
    expect(ModelDoesNotSupportToolsError).toBeDefined()
  })
  it("exports AgentRunner", () => {
    expect(AgentRunner).toBeDefined()
  })
})
