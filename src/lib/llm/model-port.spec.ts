/** C4 冒烟覆盖：src/lib/llm/model-port.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ModelPort, defaultModelPort } from "./model-port"
describe("model-port.ts smoke", () => {
  it("exports ModelPort", () => {
    expect(ModelPort).toBeDefined()
  })
  it("exports defaultModelPort", () => {
    expect(defaultModelPort).toBeDefined()
  })
})
