/** C4 冒烟覆盖：src/lib/agent/pipeline.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { filterPluginsByConfig, createPrePluginChain } from "./pipeline"
describe("pipeline.ts smoke", () => {
  it("exports filterPluginsByConfig", () => {
    expect(filterPluginsByConfig).toBeDefined()
  })
  it("exports createPrePluginChain", () => {
    expect(createPrePluginChain).toBeDefined()
  })
})
