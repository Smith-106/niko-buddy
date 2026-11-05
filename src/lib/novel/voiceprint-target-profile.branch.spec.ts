import { describe, expect, it } from "vitest"
import {
  appendRecoveryDirectives,
  buildRecoveryDirectives,
  checkPer1kRecovery,
  countHanChars,
  diffPer1kProfile,
  measurePer1kProfile,
  splitSentences,
  type Per1kMetricKey,
  type Per1kTargetProfile,
} from "./voiceprint-target-profile"

/**
 * voiceprint-target-profile 分支覆盖补齐（Ralph 覆盖率战役）。
 * 只增补：覆盖既有 spec 未走到的条件分支另一侧，每例均断言可观察行为。
 */
describe("voiceprint-target-profile 分支补齐", () => {
  it("splitSentences 空输入返回空数组", () => {
    expect(splitSentences("")).toEqual([])
  })

  it("countHanChars 无汉字文本返回 0", () => {
    expect(countHanChars("hello, 123! ...")).toBe(0)
  })

  it("measurePer1kProfile 无汉字文本返回空画像", () => {
    expect(measurePer1kProfile("")).toEqual([])
    expect(measurePer1kProfile("... !!! ???")).toEqual([])
  })

  it("diffPer1kProfile 缺省 tolerance 走默认 0.25", () => {
    const target = { targets: { dash_density: 10 } } as unknown as Per1kTargetProfile
    expect(target.tolerance).toBeUndefined()
    const diffs = diffPer1kProfile([{ metric: "dash_density", perK: 1 }] as never, target)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.status).toBe("under")
  })

  it("diffPer1kProfile 缺失度量回落 0；targetPerK=0 时 ratio=0 且状态 ok", () => {
    const target = { targets: { dash_density: 0, abstract_crutch: 5 }, tolerance: 0.25 } as unknown as Per1kTargetProfile
    // current 为空：dash 缺失回落 0（但 targetPerK=0 → 双条件皆假 → ok）；
    // abstract 缺失回落 0 → else-if 欠靶。
    const diffs = diffPer1kProfile([], target)
    const byMetric = new Map(diffs.map((d) => [d.metric, d]))
    expect(byMetric.get("dash_density")!.status).toBe("ok")
    expect(byMetric.get("dash_density")!.ratio).toBe(0)
    expect(byMetric.get("abstract_crutch")!.status).toBe("under")
    expect(byMetric.get("abstract_crutch")!.currentPerK).toBe(0)
  })

  it("diffPer1kProfile 超靶 over 分支", () => {
    const target = { targets: { dash_density: 10 }, tolerance: 0.25 } as unknown as Per1kTargetProfile
    const diffs = diffPer1kProfile([{ metric: "dash_density", perK: 30 }] as never, target)
    expect(diffs[0]!.status).toBe("over")
  })

  it("buildRecoveryDirectives 未知度量标签回退 + 无示例度量空括号 + ok 态跳过", () => {
    const unknownMetric = "__custom_metric__" as unknown as Per1kMetricKey
    const dir = buildRecoveryDirectives([
      { metric: unknownMetric, currentPerK: 1, targetPerK: 5, ratio: -0.8, status: "under" },
      { metric: "short_sentence_ratio", currentPerK: 1, targetPerK: 9, ratio: -0.89, status: "under" },
      { metric: "dash_density", currentPerK: 10, targetPerK: 10, ratio: 0, status: "ok" },
    ])
    // 未知度量：标签回退为度量键本身
    expect(dir.restoration.some((r) => r.includes("__custom_metric__"))).toBe(true)
    // short_sentence_ratio 无恢复示例：无括号后缀
    const shortLine = dir.restoration.find((r) => r.includes("短句占比"))!
    expect(shortLine).toBeTruthy()
    expect(shortLine).not.toContain("（")
    // ok 态：既不进恢复也不进收敛
    expect(dir.restoration).toHaveLength(2)
    expect(dir.convergence).toHaveLength(0)
    expect(dir.text).toContain("±5%")
  })

  it("checkPer1kRecovery 跳过非欠靶度量；缺失映射回落 0", () => {
    const target = { targets: { dash_density: 10, abstract_crutch: 5 }, tolerance: 0.25 } as unknown as Per1kTargetProfile
    // dash 9 在 ±25% 内 → ok → 跳过；abstract 缺失 → 欠靶，before/after 映射皆缺失回落 0
    const results = checkPer1kRecovery(
      [{ metric: "dash_density", perK: 9 }] as never,
      [] as never,
      target,
    )
    expect(results).toHaveLength(1)
    expect(results[0]!.metric).toBe("abstract_crutch")
    expect(results[0]!.beforePerK).toBe(0)
    expect(results[0]!.afterPerK).toBe(0)
    expect(results[0]!.recovered).toBe(false)
  })

  it("appendRecoveryDirectives 缺省 minSampleChars 走默认 500 守卫", () => {
    const fragment = "基线 fragment"
    const target = { targets: { abstract_crutch: 40 }, tolerance: 0.25 } as unknown as Per1kTargetProfile
    expect(target.minSampleChars).toBeUndefined()
    // 2 汉字 < 默认 500 → 小样本跳过，fragment 逐字节不变
    expect(appendRecoveryDirectives(fragment, "短。", target)).toBe(fragment)
  })
})
