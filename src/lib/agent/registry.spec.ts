/** C4 冒烟覆盖：src/lib/agent/registry.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ToolRegistry } from "./registry"
describe("registry.ts smoke", () => {
  it("exports ToolRegistry", () => {
    expect(ToolRegistry).toBeDefined()
  })
})

describe("ToolRegistry 全量行为", () => {
  const tool = (name: string, category: string) => ({ name, category }) as never

  it("register/get/has/list/listByCategory/clear 全链", () => {
    const registry = new ToolRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.has("read")).toBe(false)
    expect(registry.get("read")).toBeUndefined()

    registry.register(tool("read", "fs"))
    registry.register(tool("write", "fs"))
    registry.register(tool("plan", "meta"))

    expect(registry.has("read")).toBe(true)
    expect(registry.get("read")).toMatchObject({ name: "read" })
    expect(registry.list().map((t) => t.name)).toEqual(["read", "write", "plan"])
    expect(registry.listByCategory("fs" as never).map((t) => t.name)).toEqual(["read", "write"])

    registry.clear()
    expect(registry.list()).toEqual([])
    expect(registry.has("read")).toBe(false)
  })
})
