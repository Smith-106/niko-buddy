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

  it("percentileRank returns 50 when the sample contains no finite numbers", () => {
    expect(percentileRank(5, [NaN, Infinity])).toBe(50)
  })

  it("valueAtPercentile returns 0 for all-non-finite sample and clamps p", () => {
    expect(valueAtPercentile([NaN], 50)).toBe(0)
    expect(valueAtPercentile([1, 2, 3], 200)).toBe(3) // clamp to 100
    expect(valueAtPercentile([1, 2, 3], -10)).toBe(1) // clamp to 0
    expect(valueAtPercentile([10], 50)).toBe(10)
  })

  it("calibrateThresholds honors custom percentile opts and marks n<5 uncalibrated", () => {
    const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const bands = calibrateThresholds(sample, { p50: 25, p90: 75, p95: 99 })
    expect(bands.p50).toBe(valueAtPercentile(sample, 25))
    expect(bands.p90).toBe(valueAtPercentile(sample, 75))
    expect(bands.p95).toBe(valueAtPercentile(sample, 99))

    const small = calibrateThresholds([1, 2])
    expect(small.calibrated).toBe(false)
    expect(small.note).toContain("uncalibrated")
  })

  it("selfTestChineseFprProxy handles empty humanish (fpr=0) and empty aish (tpr=0)", () => {
    const emptyHuman = selfTestChineseFprProxy([], [1, 2, 3])
    expect(emptyHuman.fprAtP90).toBe(0)
    expect(emptyHuman.humanN).toBe(0)

    const emptyAi = selfTestChineseFprProxy([1, 2, 3], [])
    expect(emptyAi.tprAtP90).toBe(0)
    expect(emptyAi.aiN).toBe(0)
  })
})
