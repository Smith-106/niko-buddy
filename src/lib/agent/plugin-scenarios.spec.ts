/** C4 冒烟覆盖：src/lib/agent/plugin-scenarios.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_SCENARIO_CONFIGS, getScenarioConfig } from "./plugin-scenarios"
describe("plugin-scenarios.ts smoke", () => {
  it("exports DEFAULT_SCENARIO_CONFIGS", () => {
    expect(DEFAULT_SCENARIO_CONFIGS).toBeDefined()
  })
  it("exports getScenarioConfig", () => {
    expect(getScenarioConfig).toBeDefined()
  })
})

describe("getScenarioConfig", () => {
  it("按场景返回对应配置（review 禁用两个插件）", () => {
    expect(getScenarioConfig("review").disabledPlugins).toEqual(["soul_dialog", "confidence_gate"])
    expect(getScenarioConfig("outline_gen").disabledPlugins).toEqual(["soul_dialog"])
    expect(getScenarioConfig("general").disabledPlugins).toBeUndefined()
  })
})
