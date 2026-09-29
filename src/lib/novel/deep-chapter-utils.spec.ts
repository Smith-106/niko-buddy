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
