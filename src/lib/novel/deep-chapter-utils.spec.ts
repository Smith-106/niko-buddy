/** C4 冒烟覆盖：src/lib/novel/deep-chapter-utils.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { countChapterChars, assertNotAborted, sourceIndexFromCompactIndex, findRepeatedTailStart, trimForThinking, fallback, summaryText, severityLabel, formatContextThinking, formatReviewThinking, formatReviewIssueList, resolveGoldenThreeThinkingHints } from "./deep-chapter-utils"
describe("deep-chapter-utils.ts smoke", () => {
  it("exports countChapterChars", () => {
    expect(countChapterChars).toBeDefined()
  })
  it("exports assertNotAborted", () => {
    expect(assertNotAborted).toBeDefined()
  })
  it("exports sourceIndexFromCompactIndex", () => {
    expect(sourceIndexFromCompactIndex).toBeDefined()
  })
  it("exports findRepeatedTailStart", () => {
    expect(findRepeatedTailStart).toBeDefined()
  })
  it("exports trimForThinking", () => {
    expect(trimForThinking).toBeDefined()
  })
  it("exports fallback", () => {
    expect(fallback).toBeDefined()
  })
  it("exports summaryText", () => {
    expect(summaryText).toBeDefined()
  })
  it("exports severityLabel", () => {
    expect(severityLabel).toBeDefined()
  })
  // F4-6：thinking 格式化簇迁入后的行为单测
  it("formatContextThinking 含阶段1标题与章节目标", () => {
    const out = formatContextThinking(
      { chapterNumber: 3 } as never,
      { recentSummaries: ["a"], chapterGoal: "夺嫡", previousChapterEnding: "", characterStates: "", foreshadowingStates: "", timeline: "", mustAvoid: "", mustDo: "" } as never,
    )
    expect(out).toContain("阶段1：上下文分析")
    expect(out).toContain("第3章")
    expect(out).toContain("夺嫡")
  })
  it("formatReviewThinking 空结果 → 未发现阻断问题", () => {
    expect(formatReviewThinking([])).toContain("未发现阻断问题")
    const out = formatReviewThinking([{ type: "character_consistency", severity: "error", message: "人设崩UNIQUE-F46" } as never])
    expect(out).toContain("【角色命中记忆库报告】")
    expect(out).toContain("人设崩UNIQUE-F46")
  })
  it("formatReviewIssueList 编号+severity标签", () => {
    const out = formatReviewIssueList([{ severity: "warning", message: "节奏缓", evidence: "e", relatedMemory: "", suggestion: "" } as never])
    expect(out).toContain("1. [提醒] 节奏缓")
  })
  it("resolveGoldenThreeThinkingHints 未启用 → 空；启用 → 策略行", () => {
    expect(resolveGoldenThreeThinkingHints(undefined)).toEqual([])
    expect(resolveGoldenThreeThinkingHints({ enabled: true, targetChapter: 2 } as never)).toContain("黄金三章：已启用")
  })
})

describe("deep-chapter-utils 覆盖补齐", () => {
  it("countChapterChars 去除全部空白后计数", async () => {
    const { countChapterChars } = await import("./deep-chapter-utils")
    expect(countChapterChars("a b\nc\td")).toBe(4)
    expect(countChapterChars("")).toBe(0)
    expect(countChapterChars(" \n\t　")).toBe(0)
    expect(countChapterChars("林川 拔剑")).toBe(4)
  })

  it("assertNotAborted 未中止时静默、已中止时抛指定消息", async () => {
    const { assertNotAborted } = await import("./deep-chapter-utils")
    expect(() => assertNotAborted(undefined, "停")).not.toThrow()
    const calm = new AbortController()
    expect(() => assertNotAborted(calm.signal, "停")).not.toThrow()
    const fired = new AbortController()
    fired.abort()
    expect(() => assertNotAborted(fired.signal, "用户叫停UNIQUE")).toThrow("用户叫停UNIQUE")
  })

  it("sourceIndexFromCompactIndex 跳过空白对齐并处理越界", async () => {
    const { sourceIndexFromCompactIndex } = await import("./deep-chapter-utils")
    expect(sourceIndexFromCompactIndex("a b c", 0)).toBe(0)
    expect(sourceIndexFromCompactIndex("a b c", 1)).toBe(2)
    expect(sourceIndexFromCompactIndex("a b c", 2)).toBe(4)
    expect(sourceIndexFromCompactIndex("a b c", 9)).toBe(5)
    expect(sourceIndexFromCompactIndex("a\r\nb", 1)).toBe(3)
  })

  it("检测器多 chunk 累积后命中重复尾并返回 raw 坐标", async () => {
    const { createRepeatedTailDetector } = await import("./deep-chapter-utils")
    const detector = createRepeatedTailDetector({ minChars: 3, windowChars: 3, hitLimit: 2 })
    expect(detector.compactLength).toBe(0)
    detector.push("ab")
    detector.push("c ab")
    detector.push("cabc")
    expect(detector.compactLength).toBe("abcabcabc".length)
    // compact[3] 对应含空格原文的下标 4（空白跳过但占 raw 坐标）
    expect(detector.check()).toBe(4)
  })

  it("单次 push 整串同样命中且 raw 坐标无空白偏移", async () => {
    const { createRepeatedTailDetector } = await import("./deep-chapter-utils")
    const detector = createRepeatedTailDetector({ minChars: 3, windowChars: 3, hitLimit: 2 })
    detector.push("abcabcabc")
    expect(detector.check()).toBe(3)
  })

  it("检测器不足 minChars 时返回 null", async () => {
    const { createRepeatedTailDetector } = await import("./deep-chapter-utils")
    const detector = createRepeatedTailDetector({ minChars: 5, windowChars: 2, hitLimit: 2 })
    detector.push("ab")
    expect(detector.check()).toBeNull()
  })

  it("检测器尾部无复现时返回 null（命中不足上限）", async () => {
    const { createRepeatedTailDetector } = await import("./deep-chapter-utils")
    const detector = createRepeatedTailDetector({ minChars: 2, windowChars: 2, hitLimit: 3 })
    detector.push("abXXab")
    expect(detector.check()).toBeNull()
  })

  it("检测器 reset 后缓冲清空", async () => {
    const { createRepeatedTailDetector } = await import("./deep-chapter-utils")
    const detector = createRepeatedTailDetector({ minChars: 3, windowChars: 3, hitLimit: 2 })
    detector.push("abcabcabc")
    expect(detector.check()).toBe(3)
    detector.reset()
    expect(detector.compactLength).toBe(0)
    expect(detector.check()).toBeNull()
  })

  it("findRepeatedTailStart 命中返回起点、无重复返回 null", async () => {
    const { findRepeatedTailStart } = await import("./deep-chapter-utils")
    expect(findRepeatedTailStart("abcabcabc", { minChars: 3, windowChars: 3, hitLimit: 2 })).toBe(3)
    expect(findRepeatedTailStart("abcdef", { minChars: 2, windowChars: 2, hitLimit: 2 })).toBeNull()
    expect(findRepeatedTailStart("", { minChars: 3, windowChars: 3, hitLimit: 2 })).toBeNull()
  })

  it("trimForThinking 短文本原样、长文本截断并折叠空白", async () => {
    const { trimForThinking } = await import("./deep-chapter-utils")
    expect(trimForThinking("a  b\nc", 10)).toBe("a b c")
    expect(trimForThinking("短文本", 10)).toBe("短文本")
    expect(trimForThinking("x".repeat(20), 10)).toBe(`${"x".repeat(10)}...`)
  })

  it("fallback 空值回退、有效值截断到 180", async () => {
    const { fallback } = await import("./deep-chapter-utils")
    expect(fallback(null, "FB")).toBe("FB")
    expect(fallback(undefined, "FB")).toBe("FB")
    expect(fallback("", "FB")).toBe("FB")
    expect(fallback("   ", "FB")).toBe("FB")
    expect(fallback(" 有效 ", "FB")).toBe("有效")
    expect(fallback("y".repeat(200), "FB")).toBe(`${"y".repeat(180)}...`)
  })

  it("summaryText 空值返回暂无、有效值截断到 140", async () => {
    const { summaryText } = await import("./deep-chapter-utils")
    expect(summaryText(null)).toBe("暂无")
    expect(summaryText(undefined)).toBe("暂无")
    expect(summaryText("  ")).toBe("暂无")
    expect(summaryText("剧情推进")).toBe("剧情推进")
    expect(summaryText("z".repeat(200))).toBe(`${"z".repeat(140)}...`)
  })

  it("severityLabel 映射三档 severity、未知档回信息", async () => {
    const { severityLabel } = await import("./deep-chapter-utils")
    expect(severityLabel("error")).toBe("严重")
    expect(severityLabel("warning")).toBe("提醒")
    expect(severityLabel("info")).toBe("信息")
    expect(severityLabel("debug")).toBe("信息")
  })

  it("formatContextThinking 无章节号时标注从用户请求识别", async () => {
    const { formatContextThinking } = await import("./deep-chapter-utils")
    const out = formatContextThinking({} as never, {
      recentSummaries: [],
      chapterGoal: "",
      previousChapterEnding: "",
      characterStates: "",
      foreshadowingStates: "",
      timeline: "",
      mustAvoid: "",
      mustDo: "",
    } as never)
    expect(out).toContain("从用户请求中识别")
    expect(out).toContain("近期剧情：0 条")
  })

  it("formatReviewThinking 同时展示角色命中与其他问题并统计阻断数", async () => {
    const { formatReviewThinking } = await import("./deep-chapter-utils")
    const out = formatReviewThinking([
      { type: "character_consistency", severity: "warning", message: "人设漂移UNIQUE" },
      { type: "plot_hole", severity: "error", message: "伏笔未收UNIQUE" },
    ] as never)
    expect(out).toContain("2 个问题，其中阻断问题 1 个")
    expect(out).toContain("【角色命中记忆库报告】")
    expect(out).toContain("【其他审查问题】")
    expect(out).toContain("人设漂移UNIQUE")
    expect(out).toContain("伏笔未收UNIQUE")
  })

  it("formatReviewIssueList 渲染证据、记忆与建议行", async () => {
    const { formatReviewIssueList } = await import("./deep-chapter-utils")
    const out = formatReviewIssueList([{
      severity: "error",
      message: "战力崩坏UNIQUE",
      evidence: "第三章原文",
      relatedMemory: "境界设定",
      suggestion: "压回筑基",
    }] as never)
    expect(out).toContain("1. [严重] 战力崩坏UNIQUE")
    expect(out).toContain("证据：第三章原文")
    expect(out).toContain("相关记忆：境界设定")
    expect(out).toContain("建议：压回筑基")
  })

  it("resolveGoldenThreeThinkingHints 首章连带方向策略", async () => {
    const { resolveGoldenThreeThinkingHints } = await import("./deep-chapter-utils")
    const hints = resolveGoldenThreeThinkingHints({
      enabled: true,
      targetChapter: 1,
      outputMode: "first_chapter_with_directions",
    } as never)
    expect(hints).toContain("黄金三章：已启用")
    expect(hints.some((h) => h.includes("第2章、第3章写作方向"))).toBe(true)
  })
})
