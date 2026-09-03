import { describe, expect, it } from "vitest"
import {
  appendRecoveryDirectives,
  buildRecoveryDirectives,
  checkPer1kRecovery,
  countHanChars,
  diffPer1kProfile,
  isSmallSample,
  measurePer1kProfile,
  splitSentences,
  type Per1kDiff,
  type Per1kTargetProfile,
} from "./voiceprint-target-profile"

describe("53 P1-1 voiceprint-target-profile (中文 per-1k 度量)", () => {
  it("countHanChars / splitSentences 基础", () => {
    expect(countHanChars("你好，世界。")).toBe(4)
    expect(splitSentences("第一句。第二句！第三句？")).toHaveLength(3)
  })

  it("measurePer1kProfile 度量为纯函数且返回每千字率", () => {
    const text = "他仿佛看见了什么，缓缓抬起头来。不是逃避，而是直面。"
    const profile = measurePer1kProfile(text)
    const found = new Map(profile.map((m) => [m.metric, m.perK]))
    expect(profile.length).toBeGreaterThan(0)
    expect(found.get("abstract_crutch")).toBeGreaterThan(0) // 仿佛/缓缓
    expect(found.get("dialogue_ratio")).toBeDefined() // per-1k 刻度
    expect(found.get("short_sentence_ratio")).toBeDefined()
  })

  it("diffPer1kProfile: 欠靶 (under) / 超靶 (over) / 达标 (ok) / 未配置 (untargeted)", () => {
    const target: Per1kTargetProfile = {
      targets: { dash_density: 10, abstract_crutch: 5, sentence_initial_negation: 99 },
      tolerance: 0.25,
    }
    const current = [
      { metric: "dash_density", perK: 9 }, // ±25% 内 → ok
      { metric: "abstract_crutch", perK: 1 }, // < 3.75 → under
      { metric: "sentence_initial_negation", perK: 0 }, // 缺 → under
    ] as const
    const diffs = diffPer1kProfile(current as never, target)
    const byMetric = new Map(diffs.map((d) => [d.metric, d.status]))
    expect(byMetric.get("dash_density")).toBe("ok")
    expect(byMetric.get("abstract_crutch")).toBe("under")
    expect(byMetric.get("sentence_initial_negation")).toBe("under")
  })

  it("buildRecoveryDirectives: 欠靶 → 恢复指令含数值目标; 超靶 → 收敛指令; 守卫句恒在", () => {
    const diffs: Per1kDiff[] = [
      { metric: "abstract_crutch", currentPerK: 1, targetPerK: 5, ratio: -0.8, status: "under" },
      { metric: "dash_density", currentPerK: 30, targetPerK: 10, ratio: 2, status: "over" },
    ]
    const dir = buildRecoveryDirectives(diffs)
    expect(dir.restoration.some((r) => r.includes("欠靶恢复·抽象拐杖词") && r.includes("5"))).toBe(true)
    expect(dir.convergence.some((c) => c.includes("超靶收敛·破折号"))).toBe(true)
    expect(dir.wordCountGuard).toContain("±5%")
    expect(dir.text).toContain("±5%")
  })

  it("checkPer1kRecovery: 欠靶度量向 target 移动 → recovered; 未移动 → 不 recovered", () => {
    const target: Per1kTargetProfile = { targets: { abstract_crutch: 5 }, tolerance: 0.25 }
    const before = [{ metric: "abstract_crutch", perK: 1 }]
    const after = [{ metric: "abstract_crutch", perK: 3.5 }] // |3.5-5| < |1-5| → recovered
    const stalled = [{ metric: "abstract_crutch", perK: 0.5 }]
    const good = checkPer1kRecovery(before as never, after as never, target)
    const bad = checkPer1kRecovery(before as never, stalled as never, target)
    expect(good).toHaveLength(1)
    expect(good[0]!.recovered).toBe(true)
    expect(bad[0]!.recovered).toBe(false)
  })

  it("isSmallSample 噪声守卫 (minSampleChars)", () => {
    expect(isSmallSample("短文本。", 500)).toBe(true)
    expect(isSmallSample("很长的文本。".repeat(400), 500)).toBe(false)
  })
})

describe("53 P1-1 appendRecoveryDirectives 接线语义", () => {
  const fragment = "去AI味基线 fragment"
  const target: Per1kTargetProfile = { targets: { abstract_crutch: 40 }, tolerance: 0.25 }
  it("targetProfile 未配置 → fragment 逐字节不变 (零行为变更)", () => {
    expect(appendRecoveryDirectives(fragment, "正文内容若干。", undefined)).toBe(fragment)
  })
  it("欠靶 → 追加恢复指令段", () => {
    // 平实文本 (无抽象拐杖词) → abstract_crutch 欠靶
    const appended = appendRecoveryDirectives(fragment, "他推开门走了进去。她点了点头。", { ...target, minSampleChars: 10 })
    expect(appended).toContain("## 作者声纹恢复（目标画像）")
    expect(appended).toContain("欠靶恢复·抽象拐杖词")
    expect(appended).toContain("±5%")
  })
  it("小样本 (< minSampleChars) → 跳过恢复指令", () => {
    const appended = appendRecoveryDirectives(fragment, "短。", { ...target, minSampleChars: 500 })
    expect(appended).toBe(fragment)
  })
  it("达标 → 不追加恢复段", () => {
    const rich = "他仿佛看见什么，缓缓抬头。似乎听见了声音，隐约感觉到有人。".repeat(30)
    const appended = appendRecoveryDirectives(fragment, rich, { ...target, minSampleChars: 50, tolerance: 1.0 })
    expect(appended).toBe(fragment)
  })
})
