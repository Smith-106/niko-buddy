import { describe, expect, it } from "vitest"
import { formatDualPassSummary, runDeAiDualPass } from "./de-ai-dual-pass"

describe("de-ai-dual-pass", () => {
  it("scores clean-ish text without hard gate", () => {
    const r = runDeAiDualPass("白昼。他推开门，看见旧钥匙。")
    expect(r.productHardGate).toBe(false)
    expect(r.track).toBe("B")
    expect(r.pass1.combinedScore).toBeGreaterThanOrEqual(0)
    expect(r.pass2.remediationNotes.length).toBeGreaterThan(0)
    expect(formatDualPassSummary(r)).toContain("Track B")
  })

  it("attaches percentile when baseline provided", () => {
    const r = runDeAiDualPass("总之，值得注意的是，在这个意义上，我们需要进一步探讨。", {
      baselineScores: [5, 10, 15, 20, 25, 30, 40, 50, 60, 70],
    })
    expect(r.pass1.percentileInBaseline).toBeTypeOf("number")
    expect(r.productHardGate).toBe(false)
  })

  it("mechanical-slop block/warn pushes 机械腔 remediation note and slopReportToText fragment", () => {
    const r = runDeAiDualPass("显然事实上这一切似乎仿佛。目光交汇的瞬间空气凝固心中五味杂陈。然而但是不过。")
    expect(r.pass1.slopClass).toBe("block")
    expect(r.pass2.remediationNotes.some((n) => n.includes("机械腔"))).toBe(true)
    expect(r.pass2.promptFragment).toContain("机械 slop 检测")
    expect(formatDualPassSummary(r)).toContain("slop=block")
  })

  it("English avoid-ai boilerplate pushes avoid-ai remediation note", () => {
    const r = runDeAiDualPass(
      "Furthermore, it is important to note that we must delve into the intricate tapestry of this paradigm.",
    )
    expect(r.pass2.remediationNotes.some((n) => n.includes("avoid-ai patterns soft"))).toBe(true)
  })

  it("high percentile vs baseline pushes relative-percentile note", () => {
    const r = runDeAiDualPass("显然事实上这一切似乎仿佛。目光交汇的瞬间空气凝固心中五味杂陈。", {
      baselineScores: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    })
    expect(r.pass1.percentileInBaseline).toBeGreaterThanOrEqual(90)
    expect(r.pass2.remediationNotes.some((n) => n.includes("相对基线分位"))).toBe(true)
    expect(formatDualPassSummary(r)).toContain("pct=")
  })

  it("nullish text is tolerated via ?? '' (defensive branch)", () => {
    const r = runDeAiDualPass(undefined as unknown as string)
    expect(r.pass1.combinedScore).toBeGreaterThanOrEqual(0)
    // avoidWords 存在时 scanAvoidWords 内的 text ?? "" 同样容错
    const withWords = runDeAiDualPass(undefined as unknown as string, { avoidWords: ["不禁"] })
    expect(withWords.pass1.avoidWordsHits).toBeUndefined()
  })

  it("Wave 4: 不传 avoidWords 时报告与旧版字节一致（additive-only）", () => {
    const baseline = runDeAiDualPass("他不禁深吸一口气。")
    const withEmpty = runDeAiDualPass("他不禁深吸一口气。", { avoidWords: [] })
    const withBlank = runDeAiDualPass("他不禁深吸一口气。", { avoidWords: ["  ", ""] })
    expect(withEmpty).toEqual(baseline)
    expect(withBlank).toEqual(baseline)
    expect(baseline.pass1.avoidWordsHits).toBeUndefined()
  })

  it("Wave 4: avoidWords 命中 → avoidWordsHits + remediation note + promptFragment 禁用词提示", () => {
    const r = runDeAiDualPass("他不禁深吸一口气，不禁感到恍惚。", { avoidWords: ["不禁", "仿佛"] })
    expect(r.pass1.avoidWordsHits).toEqual([{ word: "不禁", count: 2 }])
    expect(r.pass2.remediationNotes.some((n) => n.includes("用户避用词命中：不禁×2"))).toBe(true)
    expect(r.pass2.promptFragment).toContain("用户避用词（改写时禁止使用）：不禁")
  })

  it("Wave 4: avoidWords 无命中 → 无 avoidWordsHits 且无禁用词提示", () => {
    const r = runDeAiDualPass("白昼。他推开门。", { avoidWords: ["不禁"] })
    expect(r.pass1.avoidWordsHits).toBeUndefined()
    expect(r.pass2.promptFragment).not.toContain("用户避用词")
  })
})
