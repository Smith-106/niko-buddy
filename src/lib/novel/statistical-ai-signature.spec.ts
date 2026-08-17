import { describe, expect, it, vi } from "vitest"
import {
  formatStatisticalAiSignatureFragment,
  scoreStatisticalAiSignature,
} from "./statistical-ai-signature"

// 默认委托真实实现，仅特定用例注入缺失字段的返回值以覆盖 ?? 兜底分支
vi.mock("./avoid-ai-patterns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./avoid-ai-patterns")>()
  return {
    ...actual,
    analyzeAvoidAiPatterns: vi.fn((text: string, options?: unknown) =>
      actual.analyzeAvoidAiPatterns(text, options as never),
    ),
  }
})

vi.mock("./mechanical-slop-detector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mechanical-slop-detector")>()
  return {
    ...actual,
    slopScore: vi.fn((text: string) => actual.slopScore(text)),
  }
})

import { analyzeAvoidAiPatterns } from "./avoid-ai-patterns"
import { slopScore } from "./mechanical-slop-detector"

describe("statistical-ai-signature", () => {
  it("returns soft experimental score", () => {
    const sig = scoreStatisticalAiSignature("他走进房间，看见桌子上的钥匙。")
    expect(sig.productHardGate).toBe(false)
    expect(sig.experimental).toBe(true)
    expect(sig.score0to1).toBeGreaterThanOrEqual(0)
    expect(sig.score0to1).toBeLessThanOrEqual(1)
    expect(["low", "mid", "high"]).toContain(sig.band)
  })

  it("fragment empty for low band or soft for higher", () => {
    const sig = scoreStatisticalAiSignature(
      "In this sense, it is worth noting that we should further explore the aforementioned paradigm.",
    )
    const frag = formatStatisticalAiSignatureFragment(sig)
    if (sig.band === "low") expect(frag).toBe("")
    else expect(frag).toContain("Track B")
  })

  it("heavy AI boilerplate + Chinese slop lands in mid band and renders a non-empty fragment", () => {
    const text =
      "Furthermore, it is important to note that we must delve into this intricate tapestry of the paradigm. " +
      "显然事实上这一切似乎仿佛。目光交汇的瞬间空气凝固心中五味杂陈。然而但是不过可是。"
    const sig = scoreStatisticalAiSignature(text)
    expect(sig.score0to1).toBeGreaterThanOrEqual(0.33)
    expect(sig.band).toBe("mid")
    expect(formatStatisticalAiSignatureFragment(sig)).toContain("Track B")
  })

  it("extreme slop + uniform prose lands in high band", () => {
    const text =
      "In today's rapidly evolving digital landscape, it is crucial to delve into the intricate tapestry of innovation. " +
      "Furthermore, it is worth noting that organizations must leverage robust synergies to unlock seamless solutions. " +
      "Moreover, this paradigm shift underscores the importance of embracing a holistic approach. " +
      "Additionally, it should be noted that the ever-changing landscape demands agile frameworks. " +
      "In conclusion, we must navigate the complexities of this multifaceted ecosystem."
    const sig = scoreStatisticalAiSignature(text)
    expect(sig.band).toBe("high")
    expect(sig.score0to1).toBeGreaterThanOrEqual(0.66)
  })

  it("low sentence-length CV contributes lowCvRisk", () => {
    // 句长 3/3/4/4/4/4 → CV ∈ (0, 0.15), 触发 lowCvRisk=0.25
    const text = "他来了。他走了。他又来了。他又走了。他又来了。他又走了。"
    const sig = scoreStatisticalAiSignature(text)
    expect(sig.features.sentenceLengthCV).toBeGreaterThan(0)
    expect(sig.features.sentenceLengthCV).toBeLessThan(0.15)
  })

  it("baselineScores wiring: non-empty computes percentile, empty leaves it undefined", () => {
    const withBaseline = scoreStatisticalAiSignature(
      "Furthermore, it is important to note that we must delve into the tapestry.",
      { baselineScores: [10, 20, 30, 40, 50, 60, 70, 80, 90] },
    )
    expect(withBaseline.percentileInBaseline).toBeTypeOf("number")
    const emptyBaseline = scoreStatisticalAiSignature("她推开门。雨落在台阶上。", { baselineScores: [] })
    expect(emptyBaseline.percentileInBaseline).toBeUndefined()
  })

  it("nullish text tolerated via ?? '' (defensive branches)", () => {
    const sig = scoreStatisticalAiSignature(undefined as unknown as string)
    expect(sig.score0to1).toBeGreaterThanOrEqual(0)
  })

  it("falls back to score-derived probabilities when classProbabilities is absent", () => {
    // analyzeAvoidAiPatterns 返回无 classProbabilities 的结果 → aiProb 走 avoid.score / 100
    vi.mocked(analyzeAvoidAiPatterns).mockReturnValueOnce({
      schemaVersion: "avoid-ai-patterns/1.0",
      score: 40,
      label: "Unknown",
      issues: [],
      languageBias: "english-heavy",
      productHardGate: false,
    } as never)
    const sig = scoreStatisticalAiSignature("她推开门，雨落在台阶上。")
    expect(sig.features.aiClassProb).toBeCloseTo(0.4, 5)
    expect(sig.score0to1).toBeGreaterThanOrEqual(0)
  })

  it("treats a missing sentenceLengthCV as zero", () => {
    // slopScore 返回缺 sentenceLengthCV 的结果 → cv = 0 → lowCvRisk 不触发
    vi.mocked(slopScore).mockReturnValueOnce({
      tier1Hits: [],
      tier2Hits: [],
      tier3Hits: [],
      transitionOpenerRatio: 0,
      slopPenalty: 2,
      bypassCount: 0,
      zeroWidthCount: 0,
      homoglyphCount: 0,
    } as never)
    const sig = scoreStatisticalAiSignature("他来了。他走了。他又来了。")
    expect(sig.features.sentenceLengthCV).toBe(0)
    expect(sig.score0to1).toBeGreaterThanOrEqual(0)
  })
})
