/** C4 冒烟覆盖：src/lib/agent/tool-call-parser.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { accumulateToolCalls, parseTextToolCalls } from "./tool-call-parser"
describe("tool-call-parser.ts smoke", () => {
  it("exports accumulateToolCalls", () => {
    expect(accumulateToolCalls).toBeDefined()
  })
  it("exports parseTextToolCalls", () => {
    expect(parseTextToolCalls).toBeDefined()
  })
})
