/** C4 冒烟覆盖：src/lib/agent/tools/route-task.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createRouteTaskTool } from "./route-task"
describe("route-task.ts smoke", () => {
  it("exports createRouteTaskTool", () => {
    expect(createRouteTaskTool).toBeDefined()
  })

  it("execute 返回意图与置信度 JSON", async () => {
    const tool = createRouteTaskTool("继续写第八章")
    const out = JSON.parse((await tool.execute()) as string) as {
      intent: string
      confidence: number
    }
    expect(typeof out.intent).toBe("string")
    expect(typeof out.confidence).toBe("number")
  })
})
