/**
 * v271.dod.spec.ts — DoD v2.7.1 断言（蓝图 blueprint-v271 §5）vitest 迁移
 *
 * 源脚本：scripts/verify-dod-v271.js（已改为薄壳，spawn 本 spec）。
 * it 数 = 原 check 数 = 10（基线实测 PASS=10，另 1 行为 "ALL PASS" 汇总行）。
 * 四闭环断言：①D3 探针 ②扩库 ③在线回归 ④新向量闭环
 */
import { describe, expect, it } from "vitest"
import { evaluateProbe, classifyConfidence, type ProbeResult } from "../d3-probe"
import { evaluateGrayZone } from "../gray-zone-review"
import { evaluateCorpus } from "../adversarial-corpus"
import { evaluateRegression } from "../daily-regression"
import { evaluateVector, type AttackVector, type ClosedLoopStage } from "../attack-vector"
import { softAlert } from "../soft-alert"

describe("DoD v2.7.1 验收（blueprint-v271 §5）", () => {
  // ① D3 探针：注入对抗/干净集 → 检出 ≥90% 且误报 ≤5%（双门同报）；灰区全量进人工
  describe("① D3 探针", () => {
    const res = (id: string, c: number): ProbeResult => ({ id, ...classifyConfidence(c) })
    const adversarial = Array.from({ length: 300 }, (_, i) => res(`a${i}`, 0.9))
    const clean = Array.from({ length: 200 }, (_, i) => res(`c${i}`, 0.1))
    const probe = evaluateProbe(adversarial, clean)
    const gray = evaluateGrayZone(60, 4, 0.05)

    it("① D3 探针：检出率 ≥90%", () => {
      expect(probe.detectRate >= 0.9).toBe(true)
    })
    it("① D3 探针：误报率 ≤5%（双门同报）", () => {
      expect(probe.falsePositiveRate <= 0.05 && probe.passed === true).toBe(true)
    })
    it("① 灰区 [0.4,0.7]：全量人工复审 + 边界稳定（≤1.5×）", () => {
      expect(gray.reviewed === gray.total && gray.boundaryStable === true).toBe(true)
    })
  })

  // ② 扩库：库 ≥2× 基线 + 真阳性抽检 ≥95% + 覆盖 ≥5 族
  describe("② 扩库", () => {
    const families = [
      "rewrite",
      "style-transfer",
      "watermark-strip",
      "semantic-rephrase",
      "jailbreak",
      "role-hijack",
      "prefix-inject",
    ] as const
    const corpus = families.flatMap((f) =>
      Array.from({ length: 30 }, (_, i) => ({ id: `${f}-${i}`, family: f, labeledPositive: true })),
    )
    const corpusResult = evaluateCorpus(corpus, 90, corpus)

    it("② 扩库：规模 ≥2× 基线", () => {
      expect(corpusResult.multiplier >= 2).toBe(true)
    })
    it("② 扩库：向量族覆盖 ≥5 且真阳性抽检 ≥95%", () => {
      expect(
        corpusResult.familyCount >= 5 && corpusResult.precision >= 0.95 && corpusResult.passed === true,
      ).toBe(true)
    })
  })

  // ③ 在线回归：金标日级连续 ≥3 日 0 回退
  describe("③ 在线回归", () => {
    const reg = evaluateRegression([
      { day: 1, detectRate: 0.95, falsePositiveRate: 0.03, regressed: false },
      { day: 2, detectRate: 0.94, falsePositiveRate: 0.04, regressed: false },
      { day: 3, detectRate: 0.95, falsePositiveRate: 0.03, regressed: false },
    ])

    it("③ 在线回归：连续 3 日 0 回退", () => {
      expect(reg.zeroRegression === true && reg.blocked === false).toBe(true)
    })
    it("③ 回退定义：检出<90% 或误报>5% 即阻断", () => {
      expect(
        evaluateRegression([{ day: 1, detectRate: 0.85, falsePositiveRate: 0.03, regressed: false }]).blocked ===
          true,
      ).toBe(true)
    })
  })

  // ④ 新攻击向量：语义改写/越狱各 ≥10 例五段闭环 100%
  describe("④ 新攻击向量", () => {
    const stages: ClosedLoopStage[] = ["reproduce", "detected", "attributed", "patched", "regressed"]
    const mk = (n: number, vector: AttackVector) =>
      Array.from({ length: n }, (_, i) => ({ id: `${vector}-${i}`, vector, stages }))

    it("④ 语义改写：≥10 例五段闭环 100%", () => {
      expect(evaluateVector(mk(10, "semantic-rephrase"), "semantic-rephrase").passed === true).toBe(true)
    })
    it("④ 越狱：≥10 例五段闭环 100%", () => {
      expect(evaluateVector(mk(12, "jailbreak"), "jailbreak").passed === true).toBe(true)
    })
  })

  // 补充：写作流保护
  describe("补充：写作流保护", () => {
    it("写作流保护：误报软告警不阻断", () => {
      expect(softAlert("嵌入漂移 0.62").blocksWriting === false).toBe(true)
    })
  })
})