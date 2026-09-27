/** C4 冒烟覆盖：src/lib/agent/mcp-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { appendMcpCallTrace } from "./mcp-trace"
describe("mcp-trace.ts smoke", () => {
  it("exports appendMcpCallTrace", () => {
    expect(appendMcpCallTrace).toBeDefined()
  })
})
