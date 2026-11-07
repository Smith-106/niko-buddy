/**
 * full-window-drift-gate.spec.ts — v2.6.11 D5 验收
 *
 * 覆盖：滑窗漂移 / 整章重检 / 零误杀
 */
import { describe, expect, it } from "vitest"
import { WINDOW_DRIFT_THRESHOLD, evaluateFullWindowDrift, verifyZeroFalseKill, type FullWindowDriftResult } from "./full-window-drift-gate"

describe("D5 全文窗漂移门 — 滑窗漂移", () => {
  it("平稳序列无漂移", () => {
    const r = evaluateFullWindowDrift([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    expect(r.triggered).toBe(false)
  })

  it("窗间漂移超阈 → 整章重检", () => {
    const r = evaluateFullWindowDrift([0.5, 0.5, 0.5, 1.0, 1.0, 1.0])
    expect(r.triggered).toBe(true)
    expect(r.chaptersToRecheck.length).toBeGreaterThan(0)
  })

  it("阈值冻结 0.15", () => {
    expect(WINDOW_DRIFT_THRESHOLD).toBe(0.15)
  })

  it("短序列（<窗大小）安全", () => {
    const r = evaluateFullWindowDrift([0.5, 0.5])
    expect(r.triggered).toBe(false)
  })
})

describe("D5 全文窗漂移门 — 合法手法零误杀", () => {
  it("闪回/POV 切换/时间跳跃/梦境零误杀", () => {
    const legal = [
      [0.5, 0.52, 0.48, 0.51, 0.5, 0.49], // 闪回（小幅波动）
      [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], // POV 切换（平稳）
      [0.49, 0.5, 0.51, 0.5, 0.49, 0.5], // 时间跳跃
    ]
    expect(verifyZeroFalseKill(legal, evaluateFullWindowDrift)).toBe(true)
  })
})

describe("verifyZeroFalseKill 误杀检测", () => {
  it("合法样本被门判为漂移 → 返回 false（存在误杀）", () => {
    const gate = (_s: number[]): FullWindowDriftResult => ({
      driftedWindows: [{ start: 1, drift: 1 }],
      chaptersToRecheck: [1],
      triggered: true,
    })
    expect(verifyZeroFalseKill([[1, 2, 3]], gate)).toBe(false)
  })
})
