/**
 * v270.dod.spec.ts — DoD v2.7.0 断言（蓝图 blueprint-v270 §5）vitest 迁移
 *
 * 源脚本：scripts/verify-dod-v270.js（已改为薄壳，spawn 本 spec）。
 * it 数 = 原 check 数 = 11（基线实测 PASS=11，另 1 行为 "ALL PASS" 汇总行）。
 * 三闭环断言：①解耦证明 ②换模型硬门 ③冷评自动结案
 */
import { describe, expect, it } from "vitest"
import { evaluateDecoupling } from "../gate-decoupling"
import { evaluateModelSwitch, verifyZeroMissed } from "../model-switch-gate"
import { verifyVersionLock } from "../version-lock"
import { evaluateAutoCloseout } from "../auto-closeout"
import { buildAuditReport } from "../audit-report"
import { guardDraft } from "../draft-guard"

describe("DoD v2.7.0 验收（blueprint-v270 §5）", () => {
  // ① 解耦证明：注入 3 模型评分 → 决策级一致率 ≥95%（CI≥90%）且翻转=0
  describe("① 解耦证明", () => {
    const trio = (v: "pass" | "fail") => [
      { model: "m1", verdict: v },
      { model: "m2", verdict: v },
      { model: "m3", verdict: v },
    ]
    const decoupling = evaluateDecoupling(Array.from({ length: 40 }, () => trio("pass")))

    it("① 解耦证明：决策级一致率 ≥95%", () => {
      expect(decoupling.rate >= 0.95).toBe(true)
    })
    it("① 解耦证明：95%CI 下限 ≥90%", () => {
      expect(decoupling.ciLower >= 0.9).toBe(true)
    })
    it("① 解耦证明：结论翻转=0（红线）", () => {
      expect(decoupling.flips === 0 && decoupling.proven === true).toBe(true)
    })
  })

  // ② 换模型硬门：注入模型变更 → 触发 100% 且漏报=0
  describe("② 换模型硬门", () => {
    const fp = (model: string, version = "1.0", weight = "w1") => ({ model, version, weightHash: weight })
    const samples = Array.from({ length: 20 }, (_, i) => ({ baseline: fp("m1"), current: fp(`m${i + 2}`) }))

    it("② 换模型硬门：注入变更全触发（漏报=0）", () => {
      expect(verifyZeroMissed(samples).pass === true).toBe(true)
    })
    it("② 换模型硬门：权重哈希变更触发", () => {
      expect(evaluateModelSwitch(fp("m1", "1.0", "w1"), fp("m1", "1.0", "w2")).triggered === true).toBe(true)
    })
  })

  // ③ 冷评自动结案：P0/P1 自动 + P2 回退 + 兜底 ≤10% + 审计完整
  describe("③ 冷评自动结案", () => {
    const chapters = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      gates: { p0: true, p1: true, p2: true },
      p2Score: 9,
      p2Sigma: 0.5,
    }))
    const closeout = evaluateAutoCloseout(chapters)
    const audit = buildAuditReport(
      Array.from({ length: 20 }, (_, i) => ({
        chapterId: `c${i}`,
        verdict: "pass",
        gateDetail: "p0 ok; p1 ok; p2 9.0",
        buildHash: "h1",
        modelId: "m1",
        closedBy: "auto",
      })),
    )

    it("③ 冷评自动结案率 ≥90%（零人工）", () => {
      expect(closeout.autoRate >= 0.9 && closeout.passed === true).toBe(true)
    })
    it("③ 兜底率 ≤10%", () => {
      expect(closeout.fallbackRate <= 0.1).toBe(true)
    })
    it("③ 审计报告 100% 完整（可追溯）", () => {
      expect(audit.complete === true).toBe(true)
    })
  })

  // 补充：版本锁 + Draft-first 守卫
  describe("补充：版本锁 + Draft-first", () => {
    const lock = (bundle: string, binary: string) => ({
      artifacts: { bundle, binary },
      config: { prompt: "p1", temperature: "0.7", weights: "w1" },
    })

    it("版本锁：哈希一致不阻断", () => {
      expect(verifyVersionLock(lock("h1", "h2"), lock("h1", "h2")).blocked === false).toBe(true)
    })
    it("版本锁：失配 fail-fast", () => {
      expect(verifyVersionLock(lock("h1", "h2"), lock("h1-x", "h2")).blocked === true).toBe(true)
    })
    it("Draft-first：结案只落 pending/ready", () => {
      expect(guardDraft("pending").allowed === true && guardDraft("formal").allowed === false).toBe(true)
    })
  })
})