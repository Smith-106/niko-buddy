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

describe("toOpenAITools virtual 工具过滤", () => {
  it("过滤 category === virtual 的虚拟工具，仅保留模型可调用工具", () => {
    const tools = toOpenAITools([
      {
        name: "load_context",
        description: "虚拟工具",
        category: "virtual",
        parameters: {},
        execute: async () => "ok",
      },
      {
        name: "route_task",
        description: "虚拟工具",
        category: "virtual",
        parameters: {},
        execute: async () => "ok",
      },
      {
        name: "read_chapter",
        description: "读取章节",
        category: "read",
        parameters: { name: { type: "string", description: "章节名", required: true } },
        execute: async () => "ok",
      },
    ])
    expect(tools.map((tool) => tool.function.name)).toEqual(["read_chapter"])
  })
})
