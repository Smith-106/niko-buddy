/**
 * p0-lock.spec.ts — v2.6.11 D7 验收
 *
 * 覆盖：状态机 LOCKED / D8 归并 / 显式 close / 锁死范围
 */
import { describe, expect, it } from "vitest"
import { closeLockedItem, evaluateP0Lock, verifyLockScope, verifyNoQualityOverride } from "./p0-lock"

describe("D7 P0 锁死 — 状态机", () => {
  it("无 P0 失败 → UNLOCKED", () => {
    const r = evaluateP0Lock([], [])
    expect(r.state).toBe("UNLOCKED")
    expect(r.blocked).toBe(false)
  })

  it("任一 P0 失败 → LOCKED + BLOCK", () => {
    const r = evaluateP0Lock(["consistency"], [])
    expect(r.state).toBe("LOCKED")
    expect(r.blocked).toBe(true)
  })

  it("锁触发输出集 = P0 ∪ D8 未清（禁止静默清零）", () => {
    const r = evaluateP0Lock(["consistency"], ["q0-item-1"])
    expect(r.lockedItems).toContain("consistency")
    expect(r.lockedItems).toContain("q0-item-1")
  })
})

describe("D7 P0 锁死 — 显式 close（不得隐式清零）", () => {
  it("显式 close 才缩减", () => {
    const ctx = { p0Failures: ["consistency"], q0Pending: ["q0-item-1"] }
    const after = closeLockedItem(ctx, "consistency")
    expect(after.p0Failures).toHaveLength(0)
    expect(after.q0Pending).toContain("q0-item-1") // 未列名项不得隐式清零
  })
})

describe("D7 P0 锁死 — 严格限定 P0", () => {
  it("锁死范围不扩至 P1/P2", () => {
    expect(verifyLockScope(["consistency"], ["consistency", "anti_ai"])).toBe(true)
    expect(verifyLockScope(["quality"], ["consistency"])).toBe(false)
  })

  it("对抗性负向：Quality 高分不得解锁（逃生通道测试）", () => {
    const lock = evaluateP0Lock(["consistency"], [])
    expect(verifyNoQualityOverride(lock, 9.5)).toBe(true) // 锁死仍 BLOCK
  })
})
