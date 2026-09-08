/**
 * v274.dod.spec.ts — DoD v2.7.4 断言（蓝图 blueprint-v274 §5）vitest 迁移
 *
 * 源脚本：scripts/verify-dod-v274.js（已改为薄壳，spawn 本 spec）。
 * it 数 = 原 check 数 = 11（基线实测 PASS=11，另 1 行为 "ALL PASS" 汇总行）。
 * 三闭环断言：①维度收敛 ②跨模型泛化 ③跨语言泛化
 *
 * ⚠️ 证据性质声明（2026-09-07，67 号交付）：本 spec 输入全部为硬编码/公式合成数据
 * （base/current 由 5+3*(i%3)+(j%2) 生成、五模型分数硬编码、crossLang F1 写死），
 * 仅证明四个纯函数（dimension-converge / variance-regression / cross-model-bias /
 * cross-lang-f1）的代码契约未被改坏（防 ADR-19 机械层纯函数回归），
 * **不是 v2.7.4 stretch 四指标的达成证据**。四指标实测状态见
 * docs/qmai-codex-delivery/67-stretch-gate-disclosure-20260907.md。
 */
import { describe, expect, it } from "vitest"
import { evaluateConvergence } from "../dimension-converge"
import { evaluateRecallRegression } from "../variance-regression"
import { evaluateCrossModel } from "../cross-model-bias"
import { evaluateCrossLang } from "../cross-lang-f1"

describe("DoD v2.7.4 验收（blueprint-v274 §5）", () => {
  // ① 维度收敛：中位方差降 ≥15% 且核心维 ≤3 且 Track B 保留（归一化对照 + 双门互锁）
  describe("① 维度收敛", () => {
    const dims = ["thril", "pacing", "pull", "consistency", "antiAi", "quality"] as const
    const ch = (id: string, scores: Record<string, number>) => ({ chapterId: id, scores })
    const base = Array.from({ length: 6 }, (_, i) =>
      ch(`b${i}`, Object.fromEntries(dims.map((d, j) => [d, 5 + 3 * (i % 3) + (j % 2)] as const))),
    )
    const current = Array.from({ length: 6 }, (_, i) =>
      ch(`c${i}`, Object.fromEntries(dims.map((d, j) => [d, 5 + 1 * (i % 3) + (j % 2)] as const))),
    )
    const conv = evaluateConvergence(base, current, "v2.7.3-7006868f")
    const recall = evaluateRecallRegression(19, 20, 19, 20, "v2.7.3-7006868f")

    it("① 维度收敛：中位方差降 ≥15%", () => {
      expect(conv.varianceReduction >= 0.15).toBe(true)
    })
    it("① 归一化对照：维度数归一化降幅 ≥15%（防裁剪伪影）", () => {
      expect(conv.normalizedReduction >= 0.15).toBe(true)
    })
    it("① 核心维 ≤3 且 Track B 六维保留", () => {
      expect(conv.coreDims.length <= 3 && conv.trackBDims === 6).toBe(true)
    })
    it("① 基线版本锁定（v2.7.3-7006868f）", () => {
      expect(conv.baselineVersion.length > 0).toBe(true)
    })
    it("① 收敛达标判定", () => {
      expect(conv.passed === true).toBe(true)
    })
    it("① 双门互锁：负向集召回 ≥ 基线−2%（不掩检测退化）", () => {
      expect(recall.regression <= 0.02 && recall.passed === true).toBe(true)
    })
    it("① 召回基线版本锁定", () => {
      expect(recall.baselineVersion.length > 0).toBe(true)
    })
  })

  // ② 跨模型泛化：同文同窗 pairwise Δ中位 ≤0.5 且无单维 >0.7
  describe("② 跨模型泛化", () => {
    const cm = evaluateCrossModel([
      { modelId: "a", scores: { thril: 8, pacing: 7, pull: 8 } },
      { modelId: "b", scores: { thril: 8.3, pacing: 7.2, pull: 8.1 } },
      { modelId: "c", scores: { thril: 7.8, pacing: 7.1, pull: 8.2 } },
      { modelId: "d", scores: { thril: 8.1, pacing: 6.9, pull: 7.9 } },
      { modelId: "e", scores: { thril: 8.2, pacing: 7.0, pull: 8.0 } },
    ])

    it("② 跨模型：pairwise Δ中位 ≤0.5（N≥5 同窗）", () => {
      expect(cm.medianDelta <= 0.5 && cm.passed === true).toBe(true)
    })
    it("② 跨模型：无单维偏差 >0.7", () => {
      expect(cm.maxDimDelta <= 0.7).toBe(true)
    })
  })

  // ③ 跨语言泛化：F1 ≥ 源域锁定基线×95%；P0>P1>P2 不变量
  describe("③ 跨语言泛化", () => {
    const cl = evaluateCrossLang(0.9, "v2.7.3-7006868f", [
      { lang: "en", f1: 0.88 },
      { lang: "ja", f1: 0.9 },
    ])

    it("③ 跨语言：F1 ≥ 源域锁定基线×95%（每语言独立）", () => {
      expect(cl.passed === true && cl.langs.every((l) => l.passed)).toBe(true)
    })
    it("③ 基线版本锁定（git commit 快照）", () => {
      expect(cl.baselineVersion.length > 0).toBe(true)
    })
  })
})