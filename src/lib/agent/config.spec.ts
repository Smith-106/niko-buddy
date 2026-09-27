/** C4 冒烟覆盖：src/lib/agent/config.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { providerUsesTextToolCalls, modelSupportsTools, isFunctionCallingEnabled, effectiveToolsEnabled, buildAgentConfig } from "./config"
describe("config.ts smoke", () => {
  it("exports providerUsesTextToolCalls", () => {
    expect(providerUsesTextToolCalls).toBeDefined()
  })
  it("exports modelSupportsTools", () => {
    expect(modelSupportsTools).toBeDefined()
  })
  it("exports isFunctionCallingEnabled", () => {
    expect(isFunctionCallingEnabled).toBeDefined()
  })
  it("exports effectiveToolsEnabled", () => {
    expect(effectiveToolsEnabled).toBeDefined()
  })
  it("exports buildAgentConfig", () => {
    expect(buildAgentConfig).toBeDefined()
  })
})
