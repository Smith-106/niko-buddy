/**
 * model-switch-gate.spec.ts — v2.7.0 换模型硬门验收
 *
 * 覆盖：触发 100% / 漏报=0 / 指纹变更检测
 */
import { describe, expect, it } from "vitest"
import { evaluateModelSwitch, verifyZeroMissed } from "./model-switch-gate"

const fp = (model: string, version = "1.0", weight = "w1") => ({ model, version, weightHash: weight })

describe("换模型硬门 — 触发 100%", () => {
  it("模型变更 → 触发", () => {
    const r = evaluateModelSwitch(fp("m1"), fp("m2"))
    expect(r.changed).toBe(true)
    expect(r.triggered).toBe(true)
  })

  it("权重哈希变更 → 触发", () => {
    const r = evaluateModelSwitch(fp("m1", "1.0", "w1"), fp("m1", "1.0", "w2"))
    expect(r.triggered).toBe(true)
  })

  it("无变更 → 不触发（无漏报）", () => {
    const r = evaluateModelSwitch(fp("m1"), fp("m1"))
    expect(r.triggered).toBe(false)
    expect(r.missed).toBe(0)
  })
})

describe("换模型硬门 — 漏报=0 硬断言", () => {
  it("注入 20 个变更样本全触发 → 漏报=0", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ baseline: fp("m1"), current: fp(`m${i + 2}`) }))
    const r = verifyZeroMissed(samples)
    expect(r.missed).toBe(0)
    expect(r.pass).toBe(true)
  })
})
