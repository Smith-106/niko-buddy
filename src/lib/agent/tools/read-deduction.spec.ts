/** read-deduction.spec.ts — 读取失败必须返回可读错误文案，不向上抛。 */
import { describe, expect, it } from "vitest"

import { createReadDeductionTool } from "./read-deduction"

describe("createReadDeductionTool", () => {
  it("读取失败 → 返回带名称的错误文案（不抛出）", async () => {
    const tool = createReadDeductionTool("/sim", async () => {
      throw new Error("ENOENT")
    })
    const out = await tool.execute({ name: "推演A" }, {} as never)
    expect(String(out)).toContain("无法读取推演室内容")
    expect(String(out)).toContain("推演A")
  })

  it("path 优先于 name 拼接", async () => {
    let seen = ""
    const tool = createReadDeductionTool("/sim", async (p: string) => {
      seen = p
      return "内容"
    })
    const out = await tool.execute({ name: "推演A", path: "/abs/x.json" }, {} as never)
    expect(String(out)).toBe("内容")
    expect(seen).toBe("/abs/x.json")
  })
})
