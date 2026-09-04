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
