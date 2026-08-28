/**
 * adversarial-corpus.spec.ts — v2.7.1 对抗样本库验收
 *
 * 覆盖：扩库 ≥2× / 真阳性抽检 ≥95% / 向量族覆盖 ≥5
 */
import { describe, expect, it } from "vitest"
import { CORPUS_MIN_SAMPLE, CORPUS_MULTIPLIER, CORPUS_PRECISION, evaluateCorpus } from "./adversarial-corpus"

const s = (id: string, family: "rewrite" | "style-transfer" | "watermark-strip" | "semantic-rephrase" | "jailbreak" | "role-hijack" | "prefix-inject", positive = true) => ({ id, family, labeledPositive: positive })

describe("对抗样本库 — 扩库 ≥2×", () => {
  it("基线 90 → 180+ 且覆盖 7 族 → 达标", () => {
    const families: Array<"rewrite" | "style-transfer" | "watermark-strip" | "semantic-rephrase" | "jailbreak" | "role-hijack" | "prefix-inject"> = ["rewrite", "style-transfer", "watermark-strip", "semantic-rephrase", "jailbreak", "role-hijack", "prefix-inject"]
    const samples = families.flatMap((f) => Array.from({ length: 30 }, (_, i) => s(`${f}-${i}`, f)))
    const r = evaluateCorpus(samples, 90, samples)
    expect(r.total).toBe(210)
    expect(r.multiplier).toBeGreaterThanOrEqual(CORPUS_MULTIPLIER)
    expect(r.familyCount).toBe(7)
    expect(r.passed).toBe(true)
  })

  it("扩库不足 2× → 不达标", () => {
    const r = evaluateCorpus(Array.from({ length: 100 }, (_, i) => s(`r${i}`, "rewrite")), 90, [])
    expect(r.multiplier).toBeLessThan(CORPUS_MULTIPLIER)
    expect(r.passed).toBe(false)
  })

  it("真阳性抽检 ≥95%（样本 ≥50）", () => {
    expect(CORPUS_PRECISION).toBe(0.95)
    expect(CORPUS_MIN_SAMPLE).toBe(50)
    const samples = Array.from({ length: 60 }, (_, i) => s(`r${i}`, "rewrite", i < 54))
    const r = evaluateCorpus(samples, 30, samples)
    expect(r.precision).toBe(0.9)
    expect(r.passed).toBe(false) // 90% < 95%
  })
})
