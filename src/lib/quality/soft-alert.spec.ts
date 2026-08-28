/**
 * soft-alert.spec.ts — v2.7.1 写作流保护验收
 *
 * 覆盖：软告警不阻断 / 判定理由透明
 */
import { describe, expect, it } from "vitest"
import { softAlert } from "./soft-alert"

describe("软告警 — 不阻断写作流", () => {
  it("D3 命中 → 草稿标记/侧栏，绝不阻断", () => {
    const r = softAlert("嵌入漂移 0.62（语义改写族）")
    expect(r.channel).toBe("draft-mark")
    expect(r.blocksWriting).toBe(false)
  })

  it("可切侧栏通道", () => {
    expect(softAlert("越狱指令覆盖", true).channel).toBe("sidebar")
  })

  it("判定理由透明可查", () => {
    const r = softAlert("一致性探针事实锚点偏离")
    expect(r.reason.length).toBeGreaterThan(0)
  })
})
