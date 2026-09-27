/** C4 冒烟覆盖：src/lib/agent/context-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createContextTrace, setContextInfo, finishTrace } from "./context-trace"
describe("context-trace.ts smoke", () => {
  it("exports createContextTrace", () => {
    expect(createContextTrace).toBeDefined()
  })
  it("exports setContextInfo", () => {
    expect(setContextInfo).toBeDefined()
  })
  it("exports finishTrace", () => {
    expect(finishTrace).toBeDefined()
  })
})
