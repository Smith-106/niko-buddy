import { describe, expect, it } from "vitest"
import { extractNumericFacts, runNumericFactCheck, checkOrdinalMonotonicity } from "./numeric-fact-checker"

describe("numeric-fact-checker (55 号设计 W2-5 / B-01)", () => {
  it("基数类: 同 subject 同单位不同值 → candidate_conflict (warn-only)", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "主角有 3 个随从。" },
      { chapter: 2, text: "主角有 5 个随从。" },
    ], ["主角"])
    const conflict = findings.find((f) => f.verdict === "candidate_conflict")
    expect(conflict).toBeDefined()
    expect(conflict!.ref).toBe("numeric:主角")
    expect(conflict!.severity).toBe("warning")
    expect(conflict!.evidence).toContain("values=3,5")
  })

  it("单位归一化: 1 公里 vs 1000 米 → 同值不报 (量纲换算)", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "他跑了 1 公里。" },
      { chapter: 2, text: "他跑了 1000 米。" },
    ], ["他"])
    expect(findings.filter((f) => f.verdict === "candidate_conflict")).toHaveLength(0)
  })

  it("不同 subject 同值 → 不报 (分组按 subject)", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "主角有 3 个随从。" },
      { chapter: 2, text: "配角有 5 个随从。" },
    ], ["主角", "配角"])
    expect(findings.filter((f) => f.verdict === "candidate_conflict")).toHaveLength(0)
  })

  it("序数类: 境界回退 → candidate_conflict; 递增 → 不报", () => {
    const facts = [
      ...extractNumericFacts("主角突破到练气三层。", 1, ["主角"]),
      ...extractNumericFacts("主角突破到练气五层。", 2, ["主角"]),
      ...extractNumericFacts("主角跌落回练气二层。", 3, ["主角"]),
    ]
    const findings = checkOrdinalMonotonicity(facts)
    const conflict = findings.find((f) => f.verdict === "candidate_conflict")
    expect(conflict).toBeDefined()
    expect(conflict!.message).toContain("回退")
    expect(conflict!.chapter).toBe(3)
  })

  it("无矛盾 → 空 findings (零误报)", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "主角有 3 个随从。" },
      { chapter: 2, text: "主角有 3 个随从。" },
    ], ["主角"])
    expect(findings).toHaveLength(0)
  })

  it("空输入 → 空 findings", () => {
    expect(runNumericFactCheck([])).toHaveLength(0)
    expect(extractNumericFacts("", 1)).toHaveLength(0)
  })
})

describe("W1 补强：中文数字多字序数解析与单调性", () => {
  it("十二层→二十层递增：ordinal 不报 conflict", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "主角突破到练气十二层。" },
      { chapter: 3, text: "主角已是练气二十层修为。" },
    ], ["主角"])
    expect(findings.filter((f) => f.verdict === "candidate_conflict")).toHaveLength(0)
  })

  it("二十层→十二层回退：ordinal candidate_conflict（warn-only）", () => {
    const findings = runNumericFactCheck([
      { chapter: 1, text: "主角已是练气二十层修为。" },
      { chapter: 3, text: "主角跌回练气十二层。" },
    ], ["主角"])
    const conflict = findings.find((f) => f.verdict === "candidate_conflict")
    expect(conflict).toBeDefined()
    expect(conflict!.ref).toBe("numeric:主角")
    expect(conflict!.severity).toBe("warning")
    expect(conflict!.chapter).toBe(3)
    expect(conflict!.evidence).toContain("ch1=二十")
    expect(conflict!.evidence).toContain("ch3=十二")
  })

  it("extractNumericFacts 中文数字序数抽取（kind=ordinal，不做量纲换算）", () => {
    const facts = extractNumericFacts("主角跌回练气十二层。", 3, ["主角"])
    const ord = facts.find((f) => f.kind === "ordinal")
    expect(ord).toBeDefined()
    expect(ord!.subject).toBe("主角")
    expect(ord!.unit).toBe("层")
    expect(ord!.rawValue).toBe("十二")
    expect(ord!.normalizedValue).toBe(12)
  })

  it("十百千位组合解析：三百二十五层 = 325", () => {
    const facts = extractNumericFacts("主角登上三百二十五层。", 1, ["主角"])
    const ord = facts.find((f) => f.kind === "ordinal")
    expect(ord).toBeDefined()
    expect(ord!.normalizedValue).toBe(325)
  })

  it("checkOrdinalMonotonicity 非序数事实直接忽略", () => {
    expect(checkOrdinalMonotonicity([
      { chapter: 1, subject: "主角", kind: "count", unit: "个", rawValue: "3", normalizedValue: 3 },
      { chapter: 2, subject: "主角", kind: "count", unit: "个", rawValue: "5", normalizedValue: 5 },
    ])).toEqual([])
  })
})
