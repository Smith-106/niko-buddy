/**
 * conformal-gate.spec.ts — v2.6.9 D2 验收
 *
 * 覆盖：split conformal 阈值 / BH 校正 / 经验 FDR 实测 / 最小窗兜底
 */
import { describe, expect, it } from "vitest"
import {
  CALIBRATION_SPLIT_VERSION,
  CONFORMAL_MIN_WINDOW,
  FDR_BUDGET,
  benjaminiHochberg,
  calibrationSplitHash,
  conformalThreshold,
  evaluateConformalGate,
  nonconformityScore,
} from "./conformal-gate"

describe("D2 保角门 — split conformal 阈值", () => {
  it("1−α 分位阈值", () => {
    const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    const t = conformalThreshold(scores, 0.05)
    expect(t).toBeGreaterThan(0.9)
  })

  it("残差式 nonconformity（对漂移鲁棒）", () => {
    expect(nonconformityScore(0.8, 0.5)).toBeCloseTo(0.3)
    expect(nonconformityScore(0.5, 0.5)).toBe(0)
  })

  it("校准 split 版本固定 + hash 确定性", () => {
    expect(CALIBRATION_SPLIT_VERSION).toBe("calib-split-v1-20260828")
    expect(calibrationSplitHash([0.1, 0.2, 0.3])).toBe(calibrationSplitHash([0.1, 0.2, 0.3]))
  })
})

describe("D2 保角门 — BH 校正（FDR≤0.05）", () => {
  it("显著 p 值被拒绝", () => {
    const rejected = benjaminiHochberg([0.001, 0.01, 0.5, 0.8])
    expect(rejected[0]).toBe(true)
    expect(rejected[1]).toBe(true)
    expect(rejected[2]).toBe(false)
  })

  it("全不显著：无拒绝", () => {
    const rejected = benjaminiHochberg([0.2, 0.3, 0.4])
    expect(rejected.every((r) => !r)).toBe(true)
  })
})

describe("D2 保角门 — 经验 FDR 实测（非 nominal）", () => {
  it("FDR≤0.05 通过（经验实测）", () => {
    const cal = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    const r = evaluateConformalGate(cal, [0.95, 0.98, 0.2, 0.3], [true, true, false, false], 200)
    expect(r.pass).toBe(true)
    expect(r.empiricalFdr).toBeLessThanOrEqual(FDR_BUDGET)
  })

  it("FDR 超预算：fail", () => {
    const cal = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    // 大量假阳性（真人被误判——测试分超阈值 1.0）
    const r = evaluateConformalGate(cal, [1.1, 1.2, 1.3, 1.4], [false, false, false, false], 200)
    expect(r.pass).toBe(false)
    expect(r.empiricalFdr).toBe(1)
  })

  it("最小窗兜底（N<200 触发）", () => {
    const cal = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    const r = evaluateConformalGate(cal, [0.95], [true], 50)
    expect(r.windowFallback).toBe(true)
    expect(CONFORMAL_MIN_WINDOW).toBe(200)
  })
})
