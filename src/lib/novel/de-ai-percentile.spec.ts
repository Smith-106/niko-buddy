import { describe, expect, it } from "vitest"
import {
  calibrateThresholds,
  percentileRank,
  selfTestChineseFprProxy,
  valueAtPercentile,
} from "./de-ai-percentile"

describe("de-ai-percentile", () => {
  it("percentileRank midrank and edges", () => {
    expect(percentileRank(5, [])).toBe(50)
    expect(percentileRank(3, [3])).toBe(100)
    expect(percentileRank(1, [3])).toBe(0)
    const sample = [1, 2, 3, 4, 5]
    expect(percentileRank(3, sample)).toBeCloseTo(50, 5)
    expect(percentileRank(5, sample)).toBeGreaterThan(80)
  })

  it("calibrateThresholds and FPR proxy", () => {
    const human = [1, 2, 2, 3, 4, 5, 6, 7, 8, 9]
    const bands = calibrateThresholds(human)
    expect(bands.productHardGate).toBe(false)
    expect(bands.calibrated).toBe(true)
    expect(valueAtPercentile(human, 50)).toBeLessThanOrEqual(bands.p90)
    const ai = [8, 9, 9, 10, 10]
    const proxy = selfTestChineseFprProxy(human, ai)
    expect(proxy.experimental).toBe(true)
    expect(proxy.productHardGate).toBe(false)
    expect(proxy.tprAtP90).toBeGreaterThanOrEqual(proxy.fprAtP90)
  })
})
