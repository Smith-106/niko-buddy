/** C4 冒烟覆盖：src/lib/agent/tool-evidence-ledger.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { ToolEvidenceLedger } from "./tool-evidence-ledger"
describe("tool-evidence-ledger.ts smoke", () => {
  it("exports ToolEvidenceLedger", () => {
    expect(ToolEvidenceLedger).toBeDefined()
  })

  it("params 含数组与多键对象时指纹稳定（键序无关）", () => {
    const ledger = new ToolEvidenceLedger(100)
    const a = ledger.format("read", { tags: ["x", "y"], beta: 1, alpha: 2 }, "ok")
    // stableValue 递归处理数组并按键名排序，故键序不同的等价入参命中同一去重槽
    const b = ledger.format("read", { alpha: 2, tags: ["x", "y"], beta: 1 }, "ok")
    expect(a).toContain("ok")
    expect(b).toContain("本次结果与先前相同")
  })
})
