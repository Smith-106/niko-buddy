/**
 * fdr-monitor.spec.ts — v2.6.11 D2 验收（观测）
 *
 * 覆盖：EWMA 平滑 / 超限告警 / 观测不挡
 */
import { describe, expect, it } from "vitest"
import { FDR_BUDGET, monitorFdr } from "./fdr-monitor"

describe("D2 FDR 监控 — EWMA 控制图（观测）", () => {
  it("低 FDR 无告警", () => {
    const r = monitorFdr([0.01, 0.02, 0.03, 0.02])
    expect(r.alert).toBe(false)
  })

  it("超限告警（EWMA>0.05）", () => {
    const r = monitorFdr([0.1, 0.12, 0.11, 0.13])
    expect(r.alert).toBe(true)
    expect(FDR_BUDGET).toBe(0.05)
  })

  it("观测通道标记（非硬门）", () => {
    const r = monitorFdr([0.01])
    expect(r.observationOnly).toBe(true)
  })
})
