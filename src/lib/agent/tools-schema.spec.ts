/** C4 冒烟覆盖：src/lib/agent/tools-schema.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { toOpenAITools } from "./tools-schema"
describe("tools-schema.ts smoke", () => {
  it("exports toOpenAITools", () => {
    expect(toOpenAITools).toBeDefined()
  })
})

describe("toOpenAITools enum 参数", () => {
  it("带 enum 的参数把枚举值写进 schema", () => {
    const tools = toOpenAITools([
      {
        name: "pick",
        description: "选择",
        parameters: { mode: { type: "string", description: "模式", required: true, enum: ["a", "b"] } },
      } as never,
    ])
    const props = tools[0]?.function.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.mode?.enum).toEqual(["a", "b"])
    expect(tools[0]?.function.parameters.required).toEqual(["mode"])
  })
})
