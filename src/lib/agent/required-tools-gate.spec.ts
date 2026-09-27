/** C4 冒烟覆盖：src/lib/agent/required-tools-gate.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { missingRequiredToolsOnce, shouldBlockFinalWithoutRequiredTools, buildRequiredToolNudgeMessage, RequiredToolsNotCalledError, RequiredToolFallbackError, resolveRequiredToolsOnce } from "./required-tools-gate"
describe("required-tools-gate.ts smoke", () => {
  it("exports missingRequiredToolsOnce", () => {
    expect(missingRequiredToolsOnce).toBeDefined()
  })
  it("exports shouldBlockFinalWithoutRequiredTools", () => {
    expect(shouldBlockFinalWithoutRequiredTools).toBeDefined()
  })
  it("exports buildRequiredToolNudgeMessage", () => {
    expect(buildRequiredToolNudgeMessage).toBeDefined()
  })
  it("exports RequiredToolsNotCalledError", () => {
    expect(RequiredToolsNotCalledError).toBeDefined()
  })
  it("exports RequiredToolFallbackError", () => {
    expect(RequiredToolFallbackError).toBeDefined()
  })
  it("exports resolveRequiredToolsOnce", () => {
    expect(resolveRequiredToolsOnce).toBeDefined()
  })
})
