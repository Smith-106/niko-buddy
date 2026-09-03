/**
 * plateau-stop.spec.ts — 51 号报告 G6 plateau 停止准则 spec 锁定.
 *
 * 覆盖: detectPlateau 纯函数（连续 2 轮 delta<阈值→true / 非连续→false /
 * 空单元素→false / 阈值 0→false）+ SlopHistoryTracker 滑窗记账。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import { detectPlateau, SlopHistoryTracker, DEFAULT_PLATEAU_CONFIG } from "./plateau-stop"

describe("detectPlateau（G6 纯函数）", () => {
  it("连续 2 轮 delta<epsilon → plateau=true", () => {
    const r = detectPlateau([0.5, 0.3, 0.1], { window: 2, epsilon: 0.3 })
    expect(r.plateau).toBe(true)
    expect(r.delta).toBeLessThan(0.3)
  })

  it("仅 1 轮 delta<阈值 → false（非连续不触发）", () => {
    const r = detectPlateau([0.5, 0.4, 0.05], { window: 2, epsilon: 0.3 })
    expect(r.plateau).toBe(false)
  })

  it("history 长度 < window+1 → false（防早停）", () => {
    expect(detectPlateau([], DEFAULT_PLATEAU_CONFIG).plateau).toBe(false)
    expect(detectPlateau([0.1], DEFAULT_PLATEAU_CONFIG).plateau).toBe(false)
    expect(detectPlateau([0.1, 0.2], { window: 2, epsilon: 0.5 }).plateau).toBe(false)
  })

  it("epsilon=0 → 永不触发（退化为纯 retry 上限，兼容旧行为）", () => {
    expect(detectPlateau([0.1, 0.1, 0.1], { window: 2, epsilon: 0 }).plateau).toBe(false)
  })

  it("默认配置 window=2/epsilon=0.5 下 delta 计算正确", () => {
    const r = detectPlateau([1.0, 0.6, 0.2], DEFAULT_PLATEAU_CONFIG)
    expect(r.window).toBe(2)
    expect(r.delta).toBe(0.4)
    expect(r.plateau).toBe(true)
  })
})

describe("SlopHistoryTracker（G6 滑窗记账）", () => {
  it("push 后 evaluate 与 detectPlateau 等价", () => {
    const t = new SlopHistoryTracker()
    t.push(0.5)
    t.push(0.3)
    t.push(0.1)
    expect(t.evaluate({ window: 2, epsilon: 0.3 }).plateau).toBe(true)
    expect(t.size).toBe(3)
  })

  it("单轮不触发（防首轮早停）", () => {
    const t = new SlopHistoryTracker()
    t.push(0.5)
    expect(t.evaluate(DEFAULT_PLATEAU_CONFIG).plateau).toBe(false)
  })
})
