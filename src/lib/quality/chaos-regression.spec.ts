/**
 * chaos-regression.spec.ts — v2.6.12 测试 W3 验收
 *
 * 覆盖：故障注入判定 / 白名单豁免 / 0 阻断级失败
 */
import { describe, expect, it } from "vitest"
import { evaluateChaosRegression } from "./chaos-regression"

describe("测试 W3 专项/混沌回归 — 故障注入", () => {
  it("0 阻断级失败 → 通过", () => {
    const r = evaluateChaosRegression([
      { target: "memory", blockingFailure: false, whitelisted: false },
      { target: "ipc", blockingFailure: false, whitelisted: false },
    ])
    expect(r.pass).toBe(true)
  })

  it("白名单豁免已知抖动", () => {
    const r = evaluateChaosRegression([
      { target: "lancedb", blockingFailure: true, whitelisted: true }, // 已知抖动——豁免
    ])
    expect(r.blockingFailures).toBe(0)
    expect(r.pass).toBe(true)
  })

  it("非豁免阻断级失败 → 回归失败", () => {
    const r = evaluateChaosRegression([
      { target: "memory", blockingFailure: true, whitelisted: false },
    ])
    expect(r.blockingFailures).toBe(1)
    expect(r.pass).toBe(false)
  })
})
