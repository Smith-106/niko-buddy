/**
 * self-heal-rollback.spec.ts — v2.7.2 双门自愈回滚验收
 *
 * 覆盖：成功率 ≥90% / P95<60s / 静默=0 / 熔断（章级 3 + 波级 10）
 */
import { describe, expect, it } from "vitest"
import { CHAPTER_CIRCUIT_BREAK, HEAL_P95_MS, HEAL_SUCCESS_RATE, WAVE_CIRCUIT_BREAK, circuitState, evaluateSelfHeal, type RollbackEvent } from "./self-heal-rollback"

const ev = (chapterId: string, gate: "P0" | "P1" | "P2", durationMs: number, succeeded = true, hasTrace = true): RollbackEvent => ({ chapterId, gate, durationMs, succeeded, hasTrace })

describe("双门自愈回滚 — 成功率/P95 双条件", () => {
  it("注入 100 次 P0/P1 故障 → ≥90% 且 P95<60s 且静默=0", () => {
    const events = Array.from({ length: 100 }, (_, i) => ev(`c${i % 10}`, i % 2 === 0 ? "P0" : "P1", 30_000 + (i % 5) * 1_000))
    const r = evaluateSelfHeal(events)
    expect(r.successRate).toBe(1)
    expect(r.p95Ms).toBeLessThan(HEAL_P95_MS)
    expect(r.silentCount).toBe(0)
    expect(r.passed).toBe(true)
    expect(HEAL_SUCCESS_RATE).toBe(0.9)
  })

  it("成功率不足 → 不达标", () => {
    const events = Array.from({ length: 100 }, (_, i) => ev(`c${i % 10}`, "P0", 30_000, i < 50))
    const r = evaluateSelfHeal(events)
    expect(r.successRate).toBe(0.5)
    expect(r.passed).toBe(false)
  })

  it("P2 不自动回滚（跳过不计分母）", () => {
    const events = [ev("c1", "P2", 30_000, false)]
    const r = evaluateSelfHeal(events)
    expect(r.successRate).toBe(0) // 无 P0/P1 事件
  })
})

describe("双门自愈回滚 — 熔断", () => {
  it("单章连续 ≥3 次失败 → 章级熔断", () => {
    expect(CHAPTER_CIRCUIT_BREAK).toBe(3)
    const events = [ev("c1", "P0", 30_000, false), ev("c1", "P0", 30_000, false), ev("c1", "P0", 30_000, false)]
    const r = evaluateSelfHeal(events)
    expect(r.chapterTripped).toBe(true)
    expect(r.circuitBroken).toBe(true)
  })

  it("单波累计 ≥10 次 → 波级熔断", () => {
    expect(WAVE_CIRCUIT_BREAK).toBe(10)
    const events = Array.from({ length: 10 }, (_, i) => ev(`c${i}`, "P1", 30_000, true))
    const r = evaluateSelfHeal(events)
    expect(r.waveTripped).toBe(true)
    expect(r.circuitBroken).toBe(true)
  })

  it("熔断三态：open（冷却中）→ half-open（试探）→ closed（成功恢复）", () => {
    expect(circuitState(true, 1_000, null).state).toBe("open")
    expect(circuitState(true, 600_000, null).state).toBe("half-open")
    expect(circuitState(true, 600_000, true).state).toBe("closed")
    expect(circuitState(true, 600_000, false).state).toBe("open")
  })
})
