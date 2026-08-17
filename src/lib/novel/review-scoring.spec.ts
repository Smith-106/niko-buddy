import { describe, expect, it } from "vitest"
import {
  scoreReviewResults,
  CALIBRATED_DIMENSION_WEIGHTS,
  CALIBRATED_SEVERITY_DEDUCTION,
  type DimensionScore,
} from "./review-scoring"
import type { NovelReviewResult } from "./review-adapter"

const makeResult = (overrides: Partial<NovelReviewResult> = {}): NovelReviewResult => ({
  severity: "warning",
  type: "plot",
  message: "问题描述",
  evidence: "正文证据足够长",
  relatedMemory: "",
  suggestion: "",
  ...overrides,
})

const dim = (dims: DimensionScore[], key: string): DimensionScore =>
  dims.find((d) => d.key === key)!

describe("review-scoring 全口径", () => {
  it("校准常量", () => {
    expect(CALIBRATED_DIMENSION_WEIGHTS).toEqual({
      plot: 0.116,
      character: 0.190,
      world: 0.050,
      pacing: 0.190,
      facts: 0.353,
      compliance: 0.101,
    })
    expect(CALIBRATED_SEVERITY_DEDUCTION).toEqual({
      error: 26,
      warning: 13,
      info: 7,
    })
  })

  it("空结果: 六维 100 分 / totalScore 100 / excellent / 无 anti-hallucination 警告 (默认关)", () => {
    const report = scoreReviewResults([])
    expect(report.dimensions).toHaveLength(6)
    expect(report.dimensions.map((d) => d.key)).toEqual([
      "plot", "character", "world", "pacing", "facts", "compliance",
    ])
    for (const d of report.dimensions) {
      expect(d.score).toBe(100)
      expect(d.issueCount).toBe(0)
      expect(d.issues).toEqual([])
    }
    expect(dim(report.dimensions, "plot").weight).toBe(0.2)
    expect(dim(report.dimensions, "character").labelKey).toBe("novel.scoring.dimension.character")
    expect(report.totalScore).toBe(100)
    expect(report.totalIssues).toBe(0)
    expect(report.severity).toBe("excellent")
    expect(report.antiHallucinationWarnings).toEqual([])
  })

  it("默认扣分: error 20 / warning 10 / info 5, 归入对应维度", () => {
    const report = scoreReviewResults([
      makeResult({ severity: "error", type: "是否人设崩坏" }),
      makeResult({ severity: "warning", type: "是否人设崩坏" }),
      makeResult({ severity: "info", type: "是否时间线错误" }),
    ])
    expect(dim(report.dimensions, "character").score).toBe(100 - 20 - 10) // 70
    expect(dim(report.dimensions, "character").issueCount).toBe(2)
    expect(dim(report.dimensions, "facts").score).toBe(95)
    expect(dim(report.dimensions, "facts").issueCount).toBe(1)
    // 100*0.2 + 70*0.15 + 100*0.1 + 100*0.15 + 95*0.25 + 100*0.15 = 94.25
    expect(report.totalScore).toBe(94)
    expect(report.totalIssues).toBe(3)
    expect(report.severity).toBe("fair")
  })

  it("未知 severity 走 5 分兜底扣分", () => {
    const report = scoreReviewResults([
      makeResult({ severity: "critical" as NovelReviewResult["severity"], type: "是否人设崩坏" }),
    ])
    expect(dim(report.dimensions, "character").score).toBe(95)
  })

  it("未知 type 归入 facts 维度", () => {
    const report = scoreReviewResults([
      makeResult({ type: "totally_unknown_type" }),
      makeResult({ type: "zzz" }),
    ])
    expect(dim(report.dimensions, "facts").issueCount).toBe(2)
  })

  it("resolveTypeLabel 关键词映射落到正确维度", () => {
    const cases: Array<[string, string]> = [
      // 直接命中 REVIEW_DIMENSION_MAP
      ["是否违背总大纲", "plot"],
      ["是否缺少章节钩子", "pacing"],
      ["style", "pacing"], // "style" 直接键
      // character/consistency → 人设崩坏
      ["character_consistency", "character"],
      ["consistency_mechanical", "character"],
      // timeline → 时间线 → facts
      ["timeline", "facts"],
      // plot/outline → 章节目标 → plot
      ["plot", "plot"],
      ["outline_violation", "plot"],
      // setting/world → 能力体系 → world
      ["setting", "world"],
      ["world_build", "world"],
      // foreshadowing → 伏笔 → facts
      ["foreshadowing", "facts"],
      // style 关键词 → 剧情水文 → plot
      ["style_issue", "plot"],
      // 兜底 → facts
      ["misc", "facts"],
    ]
    for (const [type, expectedDim] of cases) {
      const report = scoreReviewResults([makeResult({ type })])
      expect(dim(report.dimensions, expectedDim).issueCount).toBe(1)
    }
  })

  it("自定义 severityDeductions 覆盖默认", () => {
    const report = scoreReviewResults(
      [makeResult({ severity: "error", type: "是否人设崩坏" })],
      { severityDeductions: { error: 26 } },
    )
    expect(dim(report.dimensions, "character").score).toBe(74)
  })

  it("空 options 对象: 无覆盖时走默认权重/扣分", () => {
    const report = scoreReviewResults(
      [makeResult({ severity: "error", type: "是否人设崩坏" })],
      {},
    )
    expect(dim(report.dimensions, "character").score).toBe(80)
    expect(dim(report.dimensions, "character").weight).toBe(0.15)
    expect(report.totalScore).toBe(97) // 100 - 0.15*20
  })

  it("自定义 dimensionWeights 参与总分, 未提供维度用默认", () => {
    const report = scoreReviewResults([], { dimensionWeights: { plot: 1.0 } })
    expect(dim(report.dimensions, "plot").weight).toBe(1.0)
    expect(dim(report.dimensions, "character").weight).toBe(0.15)
    // 全部 100 分, 权重和 = 1.0 + 0.15+0.1+0.15+0.25+0.15 = 1.8 → 180
    expect(report.totalScore).toBe(180)
  })

  it("enableAntiHallucination: 证据缺失 / 过短 / 确定性词汇过度推断", () => {
    const report = scoreReviewResults(
      [
        makeResult({ evidence: "" }),
        makeResult({ evidence: "短" }),
        makeResult({ message: "他必然会来", evidence: "他果然来了" }),
        makeResult({ message: "他必然会来", evidence: "他说必然来" }),
        makeResult({ message: "这绝对是错误", evidence: "文中明确写道" }),
      ],
      { enableAntiHallucination: true },
    )
    const w = report.antiHallucinationWarnings
    expect(w.some((x) => x.includes("证据缺失"))).toBe(true)
    expect(w.filter((x) => x.includes("证据缺失"))).toHaveLength(2)
    expect(w.some((x) => x.includes("过度推断") && x.includes("必然"))).toBe(true)
    expect(w.some((x) => x.includes("过度推断") && x.includes("绝对"))).toBe(true)
    // 证据中包含该词 → 不警告
    expect(w.filter((x) => x.includes("必然") && x.includes("他说必然来"))).toHaveLength(0)
  })

  it("antiHallucination 默认关闭", () => {
    const report = scoreReviewResults([makeResult({ evidence: "" })])
    expect(report.antiHallucinationWarnings).toEqual([])
  })

  it("long message 截断到 40 字符", () => {
    const longMsg = "长".repeat(100)
    const report = scoreReviewResults(
      [makeResult({ message: longMsg, evidence: "" })],
      { enableAntiHallucination: true },
    )
    const w = report.antiHallucinationWarnings[0]
    expect(w).toContain("长".repeat(40))
  })

  it("classifySeverity: 0 excellent / 1-2 good / 3-7 fair / 8+ poor", () => {
    const mk = (n: number) => Array.from({ length: n }, () => makeResult())
    expect(scoreReviewResults(mk(0)).severity).toBe("excellent")
    expect(scoreReviewResults(mk(1)).severity).toBe("good")
    expect(scoreReviewResults(mk(2)).severity).toBe("good")
    expect(scoreReviewResults(mk(3)).severity).toBe("fair")
    expect(scoreReviewResults(mk(7)).severity).toBe("fair")
    expect(scoreReviewResults(mk(8)).severity).toBe("poor")
  })

  it("issue 对象原样透传进维度 issues", () => {
    const issue = makeResult({ type: "是否能力体系崩坏", message: "原文" })
    const report = scoreReviewResults([issue])
    expect(dim(report.dimensions, "world").issues[0]).toBe(issue)
  })
})
