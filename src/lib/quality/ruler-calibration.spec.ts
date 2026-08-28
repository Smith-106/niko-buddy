/**
 * ruler-calibration.spec.ts — v2.6.9 D4 验收（观测通道）
 *
 * 覆盖：ECE / 单调性 / 观测不挡
 */
import { describe, expect, it } from "vitest"
import { calibrateRuler, expectedCalibrationError, isCalibrationMonotonic } from "./ruler-calibration"

describe("D4 标尺可信性 — ECE（观测通道）", () => {
  it("完美校准：ECE 低（小样本分箱近似）", () => {
    const conf = [0.9, 0.8, 0.7, 0.6]
    const labels = [true, true, true, true]
    expect(expectedCalibrationError(conf, labels)).toBeLessThan(0.3)
  })

  it("空输入：ECE=0", () => {
    expect(expectedCalibrationError([], [])).toBe(0)
  })

  it("观测通道标记（不挡结案）", () => {
    const r = calibrateRuler([0.9, 0.8], [true, true])
    expect(r.observationOnly).toBe(true)
  })
})

describe("D4 标尺可信性 — 校准曲线单调", () => {
  it("单调曲线通过", () => {
    expect(
      isCalibrationMonotonic([
        { confidence: 0.3, accuracy: 0.4 },
        { confidence: 0.6, accuracy: 0.7 },
        { confidence: 0.9, accuracy: 0.95 },
      ]),
    ).toBe(true)
  })

  it("非单调曲线拒绝", () => {
    expect(
      isCalibrationMonotonic([
        { confidence: 0.3, accuracy: 0.7 },
        { confidence: 0.6, accuracy: 0.4 },
      ]),
    ).toBe(false)
  })
})
