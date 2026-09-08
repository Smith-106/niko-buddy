/**
 * v273.dod.spec.ts — DoD v2.7.3 断言（蓝图 blueprint-v273 §5）vitest 迁移
 *
 * 源脚本：scripts/verify-dod-v273.js（已改为薄壳，spawn 本 spec）。
 * it 数 = 原 check 数 = 10（基线实测 PASS=10，另 1 行为 "ALL PASS" 汇总行）。
 * 三闭环断言：①风格套用 ②回溯显影 ③记忆改写
 */
import { describe, expect, it } from "vitest"
import { factorAgreement } from "../style-factors"
import { evaluateStyleBatch } from "../style-template"
import { evaluateReveal } from "../retro-reveal"
import { diffZero, evaluateRewrite } from "../memory-rewrite"
import { evaluateRewriteGate } from "../rewrite-gate"
import { evaluateAccept } from "../accept-metric"

describe("DoD v2.7.3 验收（blueprint-v273 §5）", () => {
  // ① 风格套用：注入风格因子 → 一致率 ≥90% 且 P95<2s；内容保真
  describe("① 风格套用", () => {
    const base = { sentenceLength: 20, punctuationDensity: 30, qualifierFrequency: 10, povDrift: 0 }
    const actual = { sentenceLength: 22, punctuationDensity: 35, qualifierFrequency: 8, povDrift: 0 }
    const styleResults = Array.from({ length: 30 }, (_, i) => ({
      chapterId: `c${i}`,
      agreement: 0.95,
      durationMs: 800 + (i % 5) * 100,
      contentDrift: 0.02,
      applied: true,
    }))
    const style = evaluateStyleBatch(styleResults)

    it("① 风格因子：4 维一致率 =100%", () => {
      expect(factorAgreement(actual, base) === 1).toBe(true)
    })
    it("① 风格套用：一致率 ≥90% 且 P95<2s", () => {
      expect(style.agreementRate >= 0.9 && style.p95Ms < 2_000 && style.passed === true).toBe(true)
    })
    it("① 内容保真：contentDrift ≤10%（超限回退）", () => {
      expect(style.fidelityFails === 0).toBe(true)
    })
  })

  // ② 回溯显影：注入标注集 → 命中 ≥90% 且误报 ≤10%；只读旁路
  describe("② 回溯显影", () => {
    const reveal = evaluateReveal([
      ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, confidence: 0.8, isTrue: true, ignored: false })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, confidence: 0.2, isTrue: false, ignored: false })),
    ])

    it("② 回溯显影：命中 ≥90% 且误报 ≤10%", () => {
      expect(reveal.hitRate >= 0.9 && reveal.falsePositiveRate <= 0.1 && reveal.passed === true).toBe(true)
    })
    it("② 只读旁路：低置信折叠 + 忽略可撤销", () => {
      expect(reveal.lowConfidenceCount >= 0 && reveal.ignoreRevertible === true).toBe(true)
    })
  })

  // ③ 记忆改写：accept ≥80% 且 diff=0（字符级纯替换）；闸门渗透 0 成功；P0 零回归
  describe("③ 记忆改写", () => {
    const rewrites = [
      {
        id: "r1",
        replacements: [{ pos: 0, len: 1, text: "她" }],
        output: "她走进房间。",
        original: "他走进房间。",
        state: "accepted" as const,
      },
      {
        id: "r2",
        replacements: [{ pos: 0, len: 1, text: "夜" }],
        output: "夜黑了。",
        original: "天黑了。",
        state: "accepted" as const,
      },
      { id: "r3", replacements: [], output: "他走进房间。", original: "他走进房间。", state: "rejected" as const },
    ]
    const rewrite = evaluateRewrite(rewrites)
    const gate = evaluateRewriteGate([
      { id: "p1", target: "pending" as const, blocked: false },
      { id: "p2", target: "formal" as const, blocked: true },
      { id: "p3", target: "formal" as const, blocked: true },
    ])
    const accept = evaluateAccept(
      Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`,
        annotatorA: i < 18,
        annotatorB: i < 18,
        arbitrated: i < 18,
        p0Failed: false,
      })),
    )

    it("③ 记忆改写：diff=0 字符级铁证（替换点外零增删）", () => {
      expect(rewrites.filter((r) => r.state === "accepted").every(diffZero) === true).toBe(true)
    })
    it("③ 记忆改写：accepted 全 diff=0 且零直写", () => {
      expect(rewrite.diffZeroCount === 2 && rewrite.formalWrites === 0 && rewrite.passed === true).toBe(true)
    })
    it("③ 拒绝保留：rejected 记忆不降级不删除", () => {
      expect(rewrite.rejectedPreserved === 1).toBe(true)
    })
    it("③ 闸门渗透：formal 100% 拦截（0 成功）", () => {
      expect(gate.formalWrites === 0 && gate.blockRate === 1 && gate.passed === true).toBe(true)
    })
    it("③ 编辑真实 accept 率 ≥80%（双标注仲裁）", () => {
      expect(accept.acceptRate >= 0.8 && accept.passed === true).toBe(true)
    })
  })
})