import { describe, expect, it } from "vitest"
import {
  runDeAiSelfCheck,
  selfCheckToText,
  SELFCHECK_PASS_THRESHOLD,
  SELFCHECK_WEIGHTS,
} from "./de-ai-selfcheck"

const CLEAN_TEXT = "他推开门，夜风卷着雨丝扑在脸上。走廊尽头那盏灯还亮着，像一只不肯闭上的眼睛。他没说话，只是把伞轻轻放在墙边。"

const SLOP_TEXT = "这一切显然都是事实，实际上毫无疑问。与此同时，他感到复杂而微妙。然而，心中五味杂陈，时间一分一秒过去。"

describe("de-ai-selfcheck — 4-pass 自检 (P1-3)", () => {
  it("干净文本 → PASS 且综合分高", () => {
    const r = runDeAiSelfCheck(CLEAN_TEXT, CLEAN_TEXT)
    expect(r.verdict).toBe("PASS")
    expect(r.overall).toBeGreaterThanOrEqual(SELFCHECK_PASS_THRESHOLD)
    expect(r.productHardGate).toBe(false)
  })

  it("slop 文本 → REVIEW", () => {
    const r = runDeAiSelfCheck(SLOP_TEXT, SLOP_TEXT)
    expect(r.overall).toBeLessThan(SELFCHECK_PASS_THRESHOLD)
    expect(r.verdict).toBe("REVIEW")
  })

  it("改写后改善 → fingerprintDelta.improved", () => {
    const r = runDeAiSelfCheck(SLOP_TEXT, CLEAN_TEXT)
    expect(r.fingerprintDelta.improved).toBe(true)
    expect(r.summary).toContain("PASS")
  })

  it("7 维齐全且权重和为 1", () => {
    const r = runDeAiSelfCheck(CLEAN_TEXT, CLEAN_TEXT)
    expect(r.dimensions.length).toBe(7)
    expect(r.dimensions.map((d) => d.dimension)).toEqual([
      "词汇", "句式", "对白", "叙事", "心理", "场景", "节奏",
    ])
    const w = Object.values(SELFCHECK_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(w).toBeCloseTo(1, 5)
  })

  it("selfCheckToText 输出关键信息", () => {
    const r = runDeAiSelfCheck(CLEAN_TEXT, CLEAN_TEXT)
    const t = selfCheckToText(r)
    expect(t).toContain("overall=")
    expect(t).toContain("指纹 delta")
    expect(t).toContain("Track B soft")
  })
})
