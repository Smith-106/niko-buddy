import { describe, expect, it } from "vitest"
import { evaluateGateA } from "./eval-gates"
import { DEFAULT_THRESHOLDS } from "./eval-metrics"
import type { AggregateResult, LayerResult } from "./eval-schema"

function layer(
  name: "L1" | "L2" | "L3",
  pass: boolean,
  score: number,
): LayerResult {
  return { layer: name, pass, score, detail: {} }
}

function agg(l1: LayerResult, l2: LayerResult, l3: LayerResult): AggregateResult {
  return { overall: l1.pass && l2.pass && l3.pass, layers: { L1: l1, L2: l2, L3: l3 }, verdict: "test" }
}

const allPass = () =>
  agg(
    layer("L1", true, 0.97),
    layer("L2", true, 0.995),
    layer("L3", true, 0.0),
  )

describe("evaluateGateA", () => {
  it("三层全过 → pass 且 gate 恒为 A、无理由", () => {
    const v = evaluateGateA(allPass())
    expect(v).toEqual({ pass: true, gate: "A", reasons: [] })
  })

  it("L2（P0 一致性硬门）失败 → 不通过且理由含 L2 分数与阈值", () => {
    const v = evaluateGateA(agg(layer("L1", true, 0.97), layer("L2", false, 0.5), layer("L3", true, 0.0)))
    expect(v.pass).toBe(false)
    expect(v.gate).toBe("A")
    expect(v.reasons).toHaveLength(1)
    expect(v.reasons[0]).toContain("L2=0.5000")
    expect(v.reasons[0]).toContain(String(DEFAULT_THRESHOLDS.l2Min))
    expect(v.reasons[0]).toContain("P0")
  })

  it("L1 失败 → 理由含 L1 分数与阈值", () => {
    const v = evaluateGateA(agg(layer("L1", false, 0.9), layer("L2", true, 0.995), layer("L3", true, 0.0)))
    expect(v.pass).toBe(false)
    expect(v.reasons).toHaveLength(1)
    expect(v.reasons[0]).toContain("L1=0.9000")
    expect(v.reasons[0]).toContain(String(DEFAULT_THRESHOLDS.l1Min))
  })

  it("L3 失败（毒化率超限）→ 理由含 L3 分数与上限", () => {
    const v = evaluateGateA(agg(layer("L1", true, 0.97), layer("L2", true, 0.995), layer("L3", false, 0.05)))
    expect(v.pass).toBe(false)
    expect(v.reasons).toHaveLength(1)
    expect(v.reasons[0]).toContain("L3=0.0500")
    expect(v.reasons[0]).toContain(String(DEFAULT_THRESHOLDS.l3Max))
  })

  it("三层齐失败 → 三条理由按 L2/L1/L3 固定顺序", () => {
    const v = evaluateGateA(agg(layer("L1", false, 0.1), layer("L2", false, 0.2), layer("L3", false, 0.3)))
    expect(v.pass).toBe(false)
    expect(v.reasons).toHaveLength(3)
    expect(v.reasons[0]).toContain("L2=")
    expect(v.reasons[1]).toContain("L1=")
    expect(v.reasons[2]).toContain("L3=")
  })

  it("分数保留 4 位小数（门控文案精度锁定）", () => {
    const v = evaluateGateA(agg(layer("L1", false, 1 / 3), layer("L2", true, 1), layer("L3", true, 0)))
    expect(v.reasons[0]).toContain("L1=0.3333")
  })
})
