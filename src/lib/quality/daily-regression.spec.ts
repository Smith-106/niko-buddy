/**
 * daily-regression.spec.ts — v2.7.1 在线持续回归验收
 *
 * 覆盖：连续 0 回退天数 / 回退阻断 / 检出或误报任一触发
 */
import { describe, expect, it } from "vitest"
import { REGRESSION_MIN_DAYS, evaluateRegression } from "./daily-regression"

const day = (day: number, detect = 0.95, fp = 0.03, regressed = false) => ({ day, detectRate: detect, falsePositiveRate: fp, regressed })

describe("在线持续回归 — 0 回退门禁", () => {
  it("连续 3 日全 PASS → 0 回退达标", () => {
    const r = evaluateRegression([day(1), day(2), day(3)])
    expect(r.cleanDays).toBe(3)
    expect(r.zeroRegression).toBe(true)
    expect(REGRESSION_MIN_DAYS).toBe(3)
  })

  it("检出跌破 90% → 回退阻断", () => {
    const r = evaluateRegression([day(1), day(2, 0.85), day(3)])
    expect(r.blocked).toBe(true)
    expect(r.zeroRegression).toBe(false)
  })

  it("误报超 5% → 回退阻断", () => {
    const r = evaluateRegression([day(1), day(2, 0.95, 0.08)])
    expect(r.blocked).toBe(true)
  })

  it("连续 4 日无回退 → 达标（窗口性 0 回退）", () => {
    const r = evaluateRegression([day(1), day(2), day(3), day(4)])
    expect(r.cleanDays).toBe(4)
    expect(r.zeroRegression).toBe(true)
  })
})
