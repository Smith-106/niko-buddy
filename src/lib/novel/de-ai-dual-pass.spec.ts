import { describe, expect, it } from "vitest"
import {
  formatDualPassPromptFragment,
  formatDualPassSummary,
  runDeAiDualPass,
} from "./de-ai-dual-pass"
import * as deAiRules from "./de-ai-rules"

/**
 * de-ai-dual-pass — F-009 迁移后契约测试。
 *
 * 真源: de-ai-rules.ts runDeAiDualPass (112 词分级两遍检测)。
 * de-ai-dual-pass.ts 仅为兼容重导出 (保持消费点模块路径)。
 */
describe("de-ai-dual-pass — F-009 分级两遍检测", () => {
  it("API 契约: 返回 DualPassResult (pass1 / dualPassRecheck / needsReview)", () => {
    const r = runDeAiDualPass("显然，这一切都毫无疑问。")
    expect(r).toHaveProperty("pass1")
    expect(r).toHaveProperty("dualPassRecheck")
    expect(r).toHaveProperty("needsReview")
    expect(r.pass1).toHaveProperty("hits")
    expect(r.pass1).toHaveProperty("highCount")
    expect(r.pass1).toHaveProperty("lowCount")
    expect(r.pass1).toHaveProperty("weakCount")
    expect(r.pass1).toHaveProperty("weightedScore")
    expect(r.dualPassRecheck).toHaveProperty("residual")
    expect(r.dualPassRecheck).toHaveProperty("cleared")
    expect(r.dualPassRecheck).toHaveProperty("residualRate")
    expect(r.dualPassRecheck).toHaveProperty("rewriteSuggestions")
  })

  it("两遍检测: 1A 高权重词改写后残留清零 (cleared > 0)", () => {
    // "显然" 是 1A weight 1.0 → simulateRewrite 生成替换并清除残留
    const r = runDeAiDualPass("显然，他赢了。")
    expect(r.pass1.highCount).toBe(1)
    expect(r.pass1.lowCount).toBe(0)
    expect(r.pass1.weakCount).toBe(0)
    expect(r.dualPassRecheck.cleared).toBe(1)
    expect(r.dualPassRecheck.residualRate).toBe(0)
    expect(r.dualPassRecheck.rewriteSuggestions.length).toBe(1)
    expect(r.dualPassRecheck.rewriteSuggestions[0]).toContain("显然")
    expect(r.needsReview).toBe(false)
  })

  it("1B 低权重词仅轻提示不替换 → 残留率 1.0 且 needsReview=true", () => {
    // "缓缓"/"点了点头" 均为 1B (weight 0.3-0.5), 不生成替换 → 残留
    const r = runDeAiDualPass("他缓缓点了点头。")
    expect(r.pass1.highCount).toBe(0)
    expect(r.pass1.lowCount).toBe(2)
    expect(r.dualPassRecheck.residual.length).toBe(2)
    expect(r.dualPassRecheck.residualRate).toBe(1)
    expect(r.needsReview).toBe(true)
    // 1B 只轻提示, 不含 "替换" 前缀
    expect(r.dualPassRecheck.rewriteSuggestions.every((s) => s.includes("轻提示"))).toBe(true)
  })

  it("3 弱提示词不标 residual 但计入 weightedScore", () => {
    const r = runDeAiDualPass("他不禁下意识地感到某种不安。")
    expect(r.pass1.highCount).toBe(0)
    expect(r.pass1.lowCount).toBe(0)
    expect(r.pass1.weakCount).toBe(3) // 不禁 / 下意识 / 某种
    expect(r.dualPassRecheck.residual.length).toBe(0)
    expect(r.dualPassRecheck.cleared).toBe(3)
    expect(r.dualPassRecheck.residualRate).toBe(0)
    expect(r.needsReview).toBe(false)
    expect(r.pass1.weightedScore).toBeCloseTo(0.3) // 3 × 0.1
  })

  it("weightedScore 加权公式: 1A×1.0 + 1B×0.4 + 3×0.1", () => {
    // 显然 (1A) + 缓缓 (1B) + 不禁 (3) → 弱提示按固定 0.1 计
    const r = runDeAiDualPass("显然，他缓缓地点头，不禁。")
    expect(r.pass1.highCount).toBe(1)
    expect(r.pass1.lowCount).toBe(1)
    expect(r.pass1.weakCount).toBe(1)
    expect(r.pass1.weightedScore).toBeCloseTo(1.5) // 1×1.0 + 1×0.4 + 1×0.1
  })

  it("空文本 / nullish 容错: 返回零值结构", () => {
    for (const input of ["", undefined as unknown as string, null as unknown as string]) {
      const r = runDeAiDualPass(input)
      expect(r.pass1.hits).toEqual([])
      expect(r.pass1.highCount).toBe(0)
      expect(r.pass1.weightedScore).toBe(0)
      expect(r.dualPassRecheck.residualRate).toBe(0)
      expect(r.needsReview).toBe(false)
    }
  })

  it("formatDualPassSummary 输出加权分与 Track B 软门标注", () => {
    const r = runDeAiDualPass("显然，这一切。")
    const summary = formatDualPassSummary(r)
    expect(summary).toContain("weighted=")
    expect(summary).toContain("Track B")
    expect(summary).toContain("F-009")
  })

  it("formatDualPassPromptFragment 含 De-AI dual-pass 标记与建议", () => {
    const r = runDeAiDualPass("显然，这一切都毫无疑问。")
    const frag = formatDualPassPromptFragment(r)
    expect(frag).toContain("De-AI dual-pass")
    expect(frag).toContain("F-009")
    expect(frag).toContain("加权分=")
    expect(frag).toContain("显然")
  })

  it("formatDualPassPromptFragment 无命中时返回空串; 有避用词时追加禁用词提示", () => {
    const clean = runDeAiDualPass("白昼。他推开门。")
    expect(formatDualPassPromptFragment(clean)).toBe("")
    expect(
      formatDualPassPromptFragment(clean, [{ word: "不禁", count: 1 }]),
    ).toContain("用户避用词（改写时禁止使用）：不禁")
  })

  it("兼容重导出: de-ai-dual-pass 与 de-ai-rules 同名函数为同一引用", () => {
    expect(runDeAiDualPass).toBe(deAiRules.runDeAiDualPass)
    expect(formatDualPassSummary).toBe(deAiRules.formatDualPassSummary)
    expect(formatDualPassPromptFragment).toBe(deAiRules.formatDualPassPromptFragment)
  })
})
