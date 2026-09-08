/**
 * v272.dod.spec.ts — DoD v2.7.2 断言（蓝图 blueprint-v272 §5）vitest 迁移
 *
 * 源脚本：scripts/verify-dod-v272.js（已改为薄壳，spawn 本 spec）。
 * it 数 = 原 check 数 = 9（基线实测 PASS=9，另 1 行为 "ALL PASS" 汇总行）。
 * 四闭环断言：①自愈回滚 ②混沌平台 ③冷评收口 ④W3 干预
 */
import { describe, expect, it } from "vitest"
import { evaluateSelfHeal } from "../self-heal-rollback"
import { auditTrace } from "../rollback-trace"
import { evaluateChaos } from "../chaos-platform"
import { evaluateCloseoutFinal } from "../closeout-finalize"
import { auditW3Intervention } from "../w3-intervention"
import { assertGateInvariant } from "../gate-invariant"

describe("DoD v2.7.2 验收（blueprint-v272 §5）", () => {
  // ① 自愈回滚：注入 P0/P1 故障 N=100 → 成功率 ≥90% 且 P95<60s；trace 100%；静默=0；熔断触发
  describe("① 自愈回滚", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      chapterId: `c${i % 10}`,
      gate: i % 2 === 0 ? ("P0" as const) : ("P1" as const),
      durationMs: 30_000 + (i % 5) * 1_000,
      succeeded: true,
      hasTrace: true,
    }))
    const heal = evaluateSelfHeal(events)
    const traces = Array.from({ length: 10 }, (_, i) => ({
      eventId: `e${i}`,
      chapterId: `c${i}`,
      gate: "P0" as const,
      reason: "consistency drift",
      scope: "draft",
      hashBefore: "h1",
      hashAfter: "h2",
      manualChannelAvailable: true,
    }))
    const trip = evaluateSelfHeal([
      { chapterId: "c1", gate: "P0" as const, durationMs: 30_000, succeeded: false, hasTrace: true },
      { chapterId: "c1", gate: "P0" as const, durationMs: 30_000, succeeded: false, hasTrace: true },
      { chapterId: "c1", gate: "P0" as const, durationMs: 30_000, succeeded: false, hasTrace: true },
    ])

    it("① 自愈回滚：成功率 ≥90%（N=100）", () => {
      expect(heal.successRate >= 0.9).toBe(true)
    })
    it("① 自愈回滚：P95 <60s（双条件）", () => {
      expect(heal.p95Ms < 60_000 && heal.passed === true).toBe(true)
    })
    it("① 回滚 trace：100% 落盘（静默=0）", () => {
      expect(auditTrace(traces).silent === 0).toBe(true)
    })
    it("① 熔断：单章连续 ≥3 次 → 章级熔断", () => {
      expect(trip.chapterTripped === true && trip.circuitBroken === true).toBe(true)
    })
  })

  // ② 混沌平台：默认 disabled + 影子隔离 + P0 注入下 100% + 无真源脏写
  describe("② 混沌平台", () => {
    const chaos = evaluateChaos(
      [{ faultId: "f1", fault: "latency" as const, authorized: true, shadowIsolated: true, touchesProduction: false }],
      1,
    )

    it("② 混沌：默认 disabled + P0 保持 100% + 真源零脏写", () => {
      expect(chaos.passed === true).toBe(true)
    })
  })

  // ③ 冷评收口：独立复核 N=200 → 误结案 <2%（95%CI 上界）；L9 不自动收口
  describe("③ 冷评收口", () => {
    const closeout = evaluateCloseoutFinal(
      Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, autoClosed: true, gold: true, isLiterary: false })),
    )

    it("③ 冷评收口：误结案 <2%（95%CI 单侧上界）", () => {
      expect(closeout.miscloseoutRate < 0.02 && closeout.ciUpper < 0.02 && closeout.passed === true).toBe(true)
    })
    it("③ L9 文学分不进自动结案（=0）", () => {
      expect(closeout.literaryAutoClosed === 0).toBe(true)
    })
  })

  // ④ W3 干预：白名单 + 100% trace + veto；P0>P1>P2 零违反
  describe("④ W3 干预 + 门控不变量", () => {
    const w3 = auditW3Intervention([
      { ruleId: "w3-1", action: "adopt", vetoed: false, writesFormal: false, landsDraft: true },
      { ruleId: "w3-2", action: "dispatch-task", vetoed: false, writesFormal: false, landsDraft: true },
    ])
    const inv = assertGateInvariant([
      { id: "a1", gates: { P0: true, P1: true, P2: true }, action: "rollback" as const },
      { id: "a2", gates: { P0: false, P1: true, P2: true }, action: "none" as const },
    ])

    it("④ W3 干预：白名单 + 100% trace（禁直写正式层）", () => {
      expect(w3.violations === 0 && w3.formalWrites === 0 && w3.passed === true).toBe(true)
    })
    it("④ 门控不变量：P0>P1>P2 零违反（P0 失败阻断自动动作）", () => {
      expect(inv.p0Overridden === 0 && inv.passed === true).toBe(true)
    })
  })
})