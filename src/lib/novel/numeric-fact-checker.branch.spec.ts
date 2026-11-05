/**
 * numeric-fact-checker.branch.spec.ts — 分支覆盖专项（覆盖率战役第九批）。
 * 增补 numeric-fact-checker.spec.ts 未覆盖的可达臂：畸形数值跳过、阿拉伯数字序数、
 * 未知主语双路径、金额/度量标签。另有 7 个分支确证不可达，见交付报告。
 */
import { describe, expect, it } from "vitest"
import { extractNumericFacts, runNumericFactCheck } from "./numeric-fact-checker"

describe("numeric-fact-checker 可达分支补齐", () => {
  it("畸形数值（Number 非有限）跳过：1.2.3 元 → 无事实", () => {
    expect(extractNumericFacts("主角有 1.2.3 元。", 1, ["主角"])).toEqual([])
  })

  it("阿拉伯数字序数：3 层 → kind ordinal（includes 真臂）", () => {
    const facts = extractNumericFacts("主角登上 3 层。", 1, ["主角"])
    expect(facts).toHaveLength(1)
    expect(facts[0]!.kind).toBe("ordinal")
    expect(facts[0]!.subject).toBe("主角")
    expect(facts[0]!.normalizedValue).toBe(3)
  })

  it("未知主语（基数路径）：无主语文本 → 未知", () => {
    const facts = extractNumericFacts("3 个随从。", 1, ["主角"])
    expect(facts).toHaveLength(1)
    expect(facts[0]!.subject).toBe("未知")
    expect(facts[0]!.rawValue).toBe("3")
  })

  it("未知主语（中文数字路径）：无主语境界 → 未知", () => {
    const facts = extractNumericFacts("练气十二层。", 1, ["主角"])
    expect(facts).toHaveLength(1)
    expect(facts[0]!.kind).toBe("ordinal")
    expect(facts[0]!.subject).toBe("未知")
    expect(facts[0]!.rawValue).toBe("十二")
  })

  it("金额标签臂：3 元 vs 5 元 → 金额 candidate_conflict", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "主角有 3 元。" },
      { chapter: 2, text: "主角有 5 元。" },
    ], ["主角"])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.verdict).toBe("candidate_conflict")
    expect(findings[0]!.message).toContain("金额")
    expect(findings[0]!.evidence).toContain("kind=money")
  })

  it("度量标签臂：1 公里 vs 2 公里 → 度量 candidate_conflict", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "他跑了 1 公里。" },
      { chapter: 2, text: "他跑了 2 公里。" },
    ], ["他"])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.verdict).toBe("candidate_conflict")
    expect(findings[0]!.message).toContain("度量")
    expect(findings[0]!.evidence).toContain("kind=measure")
  })
})
