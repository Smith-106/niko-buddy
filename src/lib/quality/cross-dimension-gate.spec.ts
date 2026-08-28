/**
 * cross-dimension-gate.spec.ts — v2.6.11 D4 验收
 *
 * 覆盖：矛盾矩阵 / 多信号一致才判 AI / 单维命中降级灰区
 */
import { describe, expect, it } from "vitest"
import { evaluateCrossDimension } from "./cross-dimension-gate"

describe("D4 跨维交叉门 — 矛盾矩阵", () => {
  it("无矛盾 → human", () => {
    const r = evaluateCrossDimension({ thril: 8.0, pacing: 8.0, pull: 8.0, context: 8.0, consistency: 9.0, anti_ai: 8.0 })
    expect(r.contradictions).toHaveLength(0)
    expect(r.verdict).toBe("human")
  })

  it("单维矛盾 → gray（不杀）", () => {
    const r = evaluateCrossDimension({ thril: 9.0, pacing: 6.0, pull: 8.0, context: 8.0, consistency: 9.0, anti_ai: 8.0 })
    expect(r.contradictions).toHaveLength(1)
    expect(r.verdict).toBe("gray")
  })

  it("多信号一致矛盾（≥2）→ ai", () => {
    const r = evaluateCrossDimension({ thril: 9.0, pacing: 6.0, pull: 9.0, context: 5.0, consistency: 9.0, anti_ai: 8.0 })
    expect(r.contradictions.length).toBeGreaterThanOrEqual(2)
    expect(r.verdict).toBe("ai")
  })
})
