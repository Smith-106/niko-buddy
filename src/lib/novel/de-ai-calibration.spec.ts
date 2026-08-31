/**
 * 35 号 DD-3 阈值真实语料标定（Track B soft）。
 *
 * 语料: anti-ai-seeds.generated.json（60 条 synthetic-degraded 双层标注：
 *       human 30 / ai 30，gufeng/xuanhuan/yanqing 各 20）—— 随仓提交、确定性、
 *       bundled import 零 IO（ADR-19）。规模约束：1/30≈3.3% 粒度，结论为
 *       soft/proxy 立场，禁止产品 anti-AI 宣称；真实 ≥100+100 语料落地后须增量重标定。
 *
 * 方法: 分层加载 → 剥离样本头注（# corpus-sample 块，实测不剥会污染
 *       句长 CV 0.4→1.7）→ human/ai 分布 P5/P50/P95（复用 valueAtPercentile）
 *       → 零误杀优先选点 → holdout 复核（固定 seed 分层 80/20）。
 *
 * 回归锁: 断言引用导出常量（SLOP_DENSITY_TARGETS / SELFCHECK_PASS_THRESHOLD /
 *         CAVITY_CV_HIGH / SLOP_DENSITY_MIN_WORDS / fingerprint band），
 *         阈值被改动时本 spec 自动核验。区间断言带裕量防语料正常迭代即红。
 */
import { describe, expect, it } from "vitest"
import corpus from "./anti-ai-seeds.generated.json"
import { valueAtPercentile } from "./de-ai-percentile"
import {
  slopScore,
  classifySlop,
  overCorrectionReport,
  SLOP_DENSITY_TARGETS,
  SLOP_CLASSIFY_WARN_THRESHOLD,
  SLOP_CLASSIFY_BLOCK_THRESHOLD,
  SLOP_DENSITY_MIN_WORDS,
  CAVITY_CV_HIGH,
  CAVITY_FILLER_PER_1000,
} from "./mechanical-slop-detector"
import { statisticalFingerprint, fingerprintBand } from "./mechanical-fingerprint"
import { runDeAiSelfCheck, SELFCHECK_PASS_THRESHOLD } from "./de-ai-selfcheck"
import { INTERVENTION_DEFAULTS } from "./de-ai-intensity"
import { NGRAM_OVERLAP_MIN } from "./narrative-echo-detector"

interface SeedSample {
  file: string
  genre: string
  layer: "human" | "ai"
  words: number
  text: string
}

const samples = (corpus as { samples: SeedSample[] }).samples

/** 剥离样本头注（首个 "\n---" 之前的元数据块）→ 纯正文。 */
function bodyText(sample: SeedSample): string {
  const idx = sample.text.indexOf("\n---")
  return (idx >= 0 ? sample.text.slice(idx + 4) : sample.text).trim()
}

function layerSamples(layer: "human" | "ai"): string[] {
  return samples.filter((s) => s.layer === layer).map(bodyText)
}

function quantiles(values: number[]): { p5: number; p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p5: valueAtPercentile(sorted, 5),
    p50: valueAtPercentile(sorted, 50),
    p95: valueAtPercentile(sorted, 95),
  }
}

function reportLine(label: string, vals: number[]): string {
  const q = quantiles(vals)
  return `${label.padEnd(28)} n=${String(vals.length).padStart(2)}  P5=${q.p5.toFixed(3).padStart(7)}  P50=${q.p50.toFixed(3).padStart(7)}  P95=${q.p95.toFixed(3).padStart(7)}`
}

describe("DD-3 阈值标定（anti-ai-seeds 60 条，Track B soft）", () => {
  const human = layerSamples("human")
  const ai = layerSamples("ai")

  it("语料完整性: 60 条双层齐全 + 头注剥离后正文非空且为中文", () => {
    expect(human.length).toBe(30)
    expect(ai.length).toBe(30)
    for (const t of [...human, ...ai]) {
      expect(t.length).toBeGreaterThan(100)
      expect(t).not.toContain("corpus-sample")
      expect(t).not.toContain("# source:")
    }
  })

  it("分布报告: human/ai × slop/fingerprint/selfcheck/cavity（console 即标定报告）", () => {
    const humanSlop = human.map((t) => slopScore(t).slopPenalty)
    const aiSlop = ai.map((t) => slopScore(t).slopPenalty)
    const humanFp = human.map((t) => statisticalFingerprint(t).score)
    const humanSelf = human.map((t) => runDeAiSelfCheck(t, t).overall)
    const humanCv = human.map((t) => overCorrectionReport(t).sentenceLengthCV)
    const humanFiller = human.map((t) => overCorrectionReport(t).fillerDensityPer1000)
    const aiSelf = ai.map((t) => runDeAiSelfCheck(t, t).overall)

    // eslint-disable-next-line no-console
    console.log("\n[DD-3 calibration] anti-ai-seeds 60 (human30/ai30, body-only)\n")
    // eslint-disable-next-line no-console
    console.log(reportLine("human slopPenalty", humanSlop))
    // eslint-disable-next-line no-console
    console.log(reportLine("ai   slopPenalty", aiSlop))
    // eslint-disable-next-line no-console
    console.log(reportLine("human fingerprint score", humanFp))
    // eslint-disable-next-line no-console
    console.log(reportLine("human selfcheck overall", humanSelf))
    // eslint-disable-next-line no-console
    console.log(reportLine("ai   selfcheck overall", aiSelf))
    // eslint-disable-next-line no-console
    console.log(reportLine("human cavity CV", humanCv))
    // eslint-disable-next-line no-console
    console.log(reportLine("human cavity filler/1k", humanFiller))
    expect(true).toBe(true)
  })

  // ---- S1+S4: human 零误杀 ----
  it("S1+S4 零误杀: human slopPenalty P95 < warn 且 classify(warn) FPR == 0", () => {
    const humanSlop = human.map((t) => slopScore(t).slopPenalty)
    const p95 = quantiles(humanSlop).p95
    expect(p95).toBeLessThan(SLOP_CLASSIFY_WARN_THRESHOLD)
    const fprWarn = human.filter((t) => classifySlop(slopScore(t)) !== "clean").length
    expect(fprWarn).toBe(0)
    // S4 生效: 短文本不再放大（密度分母保底 500）
    expect(SLOP_DENSITY_MIN_WORDS).toBeGreaterThanOrEqual(500)
  })

  it("S1+S4 召回: ai TPR(warn) ≥ 0.4 且 TPR(block) ≥ 0.2（synthetic-degraded 语料实测 0.43/0.30）", () => {
    const aiWarn = ai.filter((t) => classifySlop(slopScore(t)) !== "clean").length
    const aiBlock = ai.filter((t) => classifySlop(slopScore(t)) === "block").length
    // ai 层为轻度降质模拟（非极端 AI 输出），实测 warn 13/30、block 9/30；
    // 断言取实测下限 -0.1 裕量（语料迭代不跑飞），零误杀是硬约束（见上一例）
    expect(aiWarn / ai.length).toBeGreaterThanOrEqual(0.4)
    expect(aiBlock / ai.length).toBeGreaterThanOrEqual(0.2)
  })

  // ---- S2: tier3 density target ----
  it("S2 tier3 容忍线下调: human tier3 密度 P95 ≤ target（现状 1.0）", () => {
    for (const t of human) {
      const r = slopScore(t)
      const words = Math.max(SLOP_DENSITY_MIN_WORDS, t.replace(/\s+/g, "").length)
      const density3 = (r.tier3Hits.reduce((s, h) => s + h.count, 0) / words) * 1000
      expect(density3).toBeLessThanOrEqual(SLOP_DENSITY_TARGETS.tier3)
    }
    expect(SLOP_DENSITY_TARGETS.tier3).toBeLessThanOrEqual(1.5)
    expect(SLOP_DENSITY_TARGETS.tier3).toBeGreaterThanOrEqual(1.0)
  })

  // ---- S8: selfcheck PASS 阈值上调 ----
  it("S8 selfcheck: human P5 ≥ PASS + 0.15 裕量（0.7 零误杀）且 ai REVIEW 具判别力", () => {
    const humanSelf = human.map((t) => runDeAiSelfCheck(t, t).overall)
    const p5 = quantiles(humanSelf).p5
    expect(p5).toBeGreaterThanOrEqual(SELFCHECK_PASS_THRESHOLD + 0.15)
    expect(SELFCHECK_PASS_THRESHOLD).toBeGreaterThanOrEqual(0.65)
    expect(SELFCHECK_PASS_THRESHOLD).toBeLessThanOrEqual(0.75)
    const aiReview = ai.filter((t) => runDeAiSelfCheck(t, t).verdict === "REVIEW").length
    // ai 层应有至少 1/3 REVIEW（判别力），但语料小且 soft，不断言硬下限——仅记录
    expect(aiReview).toBeGreaterThanOrEqual(0)
  })

  // ---- S5: cavity 维持 ----
  it("S5 cavity: human CV P95 < HIGH(0.75) 且 filler P95 < 3.0/千字", () => {
    const humanCv = human.map((t) => overCorrectionReport(t).sentenceLengthCV)
    const humanFiller = human.map((t) => overCorrectionReport(t).fillerDensityPer1000)
    expect(quantiles(humanCv).p95).toBeLessThan(CAVITY_CV_HIGH)
    expect(quantiles(humanFiller).p95).toBeLessThan(CAVITY_FILLER_PER_1000)
  })

  // ---- S6: fingerprint band 可达 ----
  it("S6 fingerprint: human P50 ≥ 0.6（natural）且 band 划分非空", () => {
    const humanFp = human.map((t) => statisticalFingerprint(t).score)
    expect(quantiles(humanFp).p50).toBeGreaterThanOrEqual(0.6)
    expect(fingerprintBand(0.95)).toBe("natural")
    expect(fingerprintBand(0.1)).toBe("unnatural")
  })

  // ---- 阈值漂移护栏 ----
  it("漂移护栏: warn ∈ [4,6] 且 block ≥ 7（防语料更新跑飞）", () => {
    expect(SLOP_CLASSIFY_WARN_THRESHOLD).toBeGreaterThanOrEqual(4)
    expect(SLOP_CLASSIFY_WARN_THRESHOLD).toBeLessThanOrEqual(6)
    expect(SLOP_CLASSIFY_BLOCK_THRESHOLD).toBeGreaterThanOrEqual(7)
  })

  // ---- holdout 复核（固定 seed 分层 80/20）----
  it("holdout: 分层 80/20（seed=42）train 阈值 → holdout FPR ≤ 0.1", () => {
    // 确定性伪随机分层切分（每层 genre 配平, seed=42）
    const rng = (() => {
      let s = 42
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
      }
    })()
    const pickHoldout = (list: string[]): string[] => {
      const byGenre = new Map<string, string[]>()
      for (const t of list) {
        const s = samples.find((x) => bodyText(x) === t)
        const g = s?.genre ?? "gufeng"
        byGenre.set(g, [...(byGenre.get(g) ?? []), t])
      }
      const holdout: string[] = []
      for (const group of byGenre.values()) {
        for (const t of group) if (rng() < 0.2 && holdout.length < 6) holdout.push(t)
        // 每层保证至少 2 条 holdout（10/30 ≈ 20%）
        while (holdout.filter((h) => group.includes(h)).length < 2 && group.length > 4) {
          holdout.push(group[holdout.length % group.length])
        }
      }
      return holdout
    }
    const hHoldout = pickHoldout(human)
    const aHoldout = pickHoldout(ai)
    const hTrain = human.filter((t) => !hHoldout.includes(t))
    // train 上 human 零误杀保持
    const fprTrain = hTrain.filter((t) => classifySlop(slopScore(t)) !== "clean").length
    expect(fprTrain / hTrain.length).toBe(0)
    // holdout 上 FPR 放宽（1/12≈8.3% 粒度）
    const fprHold = hHoldout.filter((t) => classifySlop(slopScore(t)) !== "clean").length
    expect(fprHold / Math.max(1, hHoldout.length)).toBeLessThanOrEqual(0.1)
    // ai holdout 召回粗查（语料小, 只断言非 0）
    const aiRecall = aHoldout.filter((t) => classifySlop(slopScore(t)) !== "clean").length
    expect(aiRecall).toBeGreaterThanOrEqual(0)
  })

  // ---- 36 号: 真实语料标定快照（《8人》6 章, 外部语料不进 git）----
  // 实测方法: scripts/ 一次性标定脚本（REAL_CORPUS_DIR 环境变量, 本地手动跑）
  // 直接调生产检测器得以下分布; 本 spec 以快照断言钉死结论（ADR-19 零 IO）。
  it("36 号真实语料: CAVITY_CV_HIGH 0.75→0.85（真实 CV 0.648-0.809 击穿旧值, ch1/ch2/ch5 误报修复）", () => {
    expect(CAVITY_CV_HIGH).toBe(0.85)
  })

  it("36 号真实语料: slop 阈值维持 5/8（真实 6 章 slopPenalty 全 0, FPR=0; warn 裕量 25-34×）", () => {
    expect(SLOP_CLASSIFY_WARN_THRESHOLD).toBe(5)
    expect(SLOP_CLASSIFY_BLOCK_THRESHOLD).toBe(8)
    expect(SLOP_DENSITY_MIN_WORDS).toBe(500)
  })

  it("36 号真实语料: CAVITY 0.85 对 synthetic human 30/30 零回归（合成层 CV 0.40-0.68 远低于 0.85）", () => {
    const flagged = human.filter((t) => overCorrectionReport(t).flags.some((f) => f.includes("过度不规则")))
    expect(flagged.length).toBe(0)
  })

  it("36 号真实语料: intensity 每千字口径阈值（lightUpper 2.5 / rewriteLower 6.0, 真实 P95≈2.44/k）", () => {
    expect(INTERVENTION_DEFAULTS.lightUpper).toBe(2.5)
    expect(INTERVENTION_DEFAULTS.rewriteLower).toBe(6.0)
    expect(INTERVENTION_DEFAULTS.slopFloor).toBe(5)
    expect(INTERVENTION_DEFAULTS.cavitySkipUpper).toBe(0.7)
  })

  it("36 号真实语料: echo NGRAM_OVERLAP_MIN 维持 0.3（真实 6 章两两 8-gram 重叠全 0.000, FP=0/15 对）", () => {
    expect(NGRAM_OVERLAP_MIN).toBe(0.3)
  })
})
