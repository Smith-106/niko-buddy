/**
 * foreshadow-diff.spec.ts — v2.6.10 D4 验收
 *
 * 覆盖：差分集合运算 / P0 判定 / 机械可判
 */
import { describe, expect, it } from "vitest"
import { diffForeshadows, evaluateForeshadowP0, verifyMechanicalP0, crossSegmentDiff } from "./foreshadow-diff"

describe("D4 伏笔差分 — 集合运算（纯函数机械可判）", () => {
  it("无违规：全部回收", () => {
    const d = diffForeshadows(["玉簪", "阿明"], ["玉簪", "阿明"], ["玉簪", "阿明"])
    expect(d.violations).toHaveLength(0)
  })

  it("悬挂伏笔 → P0 违规", () => {
    const d = diffForeshadows(["玉簪"], ["玉簪"], [])
    expect(d.dangling).toContain("玉簪")
    expect(d.violations).toContain("玉簪")
  })

  it("消失伏笔（断链）→ P0 违规", () => {
    const d = diffForeshadows(["玉簪", "阿明"], ["玉簪"], ["玉簪"])
    expect(d.removed).toContain("阿明")
    expect(d.violations).toContain("阿明")
  })

  it("新增伏笔不违规（已回收）", () => {
    const d = diffForeshadows(["玉簪"], ["玉簪", "新伏笔"], ["玉簪", "新伏笔"])
    expect(d.added).toContain("新伏笔")
    expect(d.violations).toHaveLength(0)
  })
})

describe("D4 伏笔差分 — P0 判定（Quality 不得覆盖）", () => {
  it("违规=0 → P0 通过", () => {
    const d = diffForeshadows(["玉簪"], ["玉簪"], ["玉簪"])
    const r = evaluateForeshadowP0(d)
    expect(r.pass).toBe(true)
    expect(r.qualityOverride).toBe(false)
  })

  it("违规>0 → P0 失败（qualityOverride 恒 false）", () => {
    const d = diffForeshadows(["玉簪"], ["玉簪"], [])
    const r = evaluateForeshadowP0(d)
    expect(r.pass).toBe(false)
    expect(r.qualityOverride).toBe(false)
  })

  it("机械可判（纯函数——零 LLM）", () => {
    expect(verifyMechanicalP0()).toBe(true)
  })

  it("跨段差分：段落级 diff 补行级盲区（人设漂移检测）", () => {
    const r = crossSegmentDiff(["阿明性格沉稳", "阿明沉默寡言"], ["阿明性格沉稳"])
    expect(r.removedSegments).toContain("阿明沉默寡言")
    expect(r.addedSegments).toHaveLength(0)
  })
})
