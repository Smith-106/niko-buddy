/**
 * chaos-platform.spec.ts — v2.7.2 混沌平台验收
 *
 * 覆盖：默认 disabled / 影子隔离 / 双人授权 / P0 保持 100% / 真源零脏写
 */
import { describe, expect, it } from "vitest"
import { evaluateChaos, type ChaosInjection } from "./chaos-platform"

const inj = (id: string, authorized = true, isolated = true, touchesProduction = false): ChaosInjection => ({ faultId: id, fault: "latency", authorized, shadowIsolated: isolated, touchesProduction })

describe("混沌平台 — 受控注入", () => {
  it("默认 disabled + 全授权 + 影子隔离 + P0 100% → 达标", () => {
    const r = evaluateChaos([inj("f1"), inj("f2"), inj("f3")], 1)
    expect(r.defaultDisabled).toBe(true)
    expect(r.p0Retained).toBe(1)
    expect(r.sourceDirtyWrites).toBe(0)
    expect(r.unauthorizedCount).toBe(0)
    expect(r.passed).toBe(true)
  })

  it("未授权注入 → 不达标", () => {
    const r = evaluateChaos([inj("f1", false)], 1)
    expect(r.unauthorizedCount).toBe(1)
    expect(r.passed).toBe(false)
  })

  it("触碰生产真源 → 脏写计数（必须=0）", () => {
    const r = evaluateChaos([inj("f1", true, true, true)], 1)
    expect(r.sourceDirtyWrites).toBe(1)
    expect(r.passed).toBe(false)
  })

  it("P0 保持率 <100% → 不达标", () => {
    const r = evaluateChaos([inj("f1")], 0.98)
    expect(r.p0Retained).toBe(0.98)
    expect(r.passed).toBe(false)
  })
})
