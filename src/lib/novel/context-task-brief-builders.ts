// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// context-task-brief-builders.ts — F4-2 (Round-2 评估)：任务简报组装纯函数簇。
//
// 从 context-engine.ts（2937 行巨石）拆出的第二个纯函数子模块：章节号提取、
// 回看章节选择、伏笔信号合并、chapterGoal/mustDo/mustAvoid/nextChapterAdvice
// 组装、joinNonEmpty。仅依赖 i18n + outline-helpers（chapterLabels/
// includesChapterMarker），零依赖 context-engine；context-engine 经 re-export
// 保持既有 import 面不变（spec 与 context-data-sources 不动——后者仍经由
// context-engine re-export 消费，无需改 import）。

import i18n from "@/i18n"
import { chapterLabels, includesChapterMarker } from "./context-engine-outline-helpers"

export function extractChapterNumberFromTask(task: string): number | undefined {
  const patterns = [
    /第\s*(\d+)\s*章/i,
    /chapter\s*(\d+)/i,
    /ch\.?\s*(\d+)/i,
  ]
  for (const pattern of patterns) {
    const match = task.match(pattern)
    if (match) {
      const value = Number(match[1])
      // COR (odyssey-review): bound the chapter number to avoid pathological
      // task text (e.g. "第999999999章") driving downstream loops/scans.
      if (Number.isFinite(value) && value > 0 && value < 100000) return value
    }
  }
  return undefined
}

export function selectLookbackChapterNumbers(chapterNumber: number, lookback: number): number[] {
  const result: number[] = []
  for (let current = chapterNumber - 1; current >= 1 && result.length < lookback; current -= 1) {
    result.push(current)
  }
  return result
}

export function mergeForeshadowingSignals(signals: string[], searchResults: string): string {
  const normalized = signals
    .map((signal) => signal.trim())
    .filter(Boolean)

  if (normalized.length === 0 && !searchResults.trim()) return ""

  const unresolved = normalized.filter(signal => /未回收|未解决|新增伏笔/i.test(signal))
  const repeated = unresolved.filter(signal => {
    const keyword = signal.split(/[：:]/)[0]?.trim()
    return keyword && searchResults.includes(keyword)
  })

  const sections = [normalized.join("\n")]
  if (repeated.length > 0) {
    const names = repeated
      .map(signal => signal.split(/[：:]/)[0]?.trim())
      .filter(Boolean)
    sections.push(`以下伏笔近期反复出现，但尚未明显推进，需注意是否在本章继续铺设或回收：${Array.from(new Set(names)).join("、")}`)
  }
  return sections.filter(Boolean).join("\n\n")
}

export function extractChapterGoal(outline: string, chapterNumber?: number): string {
  if (!chapterNumber || !outline) return ""
  const cleaned = outline.replace(/^---[\s\S]*?---\s*/m, "").trim()
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const compact = trimmed.replace(/\s+/g, "")
    for (const label of chapterLabels(chapterNumber)) {
      if (compact.includes(label)) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const rest = trimmed.replace(new RegExp(`^#*\\s*${escapedLabel}[：:、\\s-]*`), "").trim()
        return (rest || cleaned).slice(0, 2500)
      }
    }
    const englishMatch = trimmed.match(new RegExp(`^#*\\s*Chapter\\s*${chapterNumber}[：:\\s-]*(.+)?$`, "i"))
    if (englishMatch) {
      return ((englishMatch[1] ?? "").trim() || cleaned).slice(0, 2500)
    }
  }
  if (includesChapterMarker(cleaned, chapterNumber)) return cleaned.slice(0, 2500)
  return ""
}

export function buildChapterGoal(outline: string, chapterOutline: string, chapterNumber?: number): string {
  const parts: string[] = []
  const fromOutline = extractChapterGoal(outline, chapterNumber)
  const fromChapterOutline = extractChapterGoal(chapterOutline, chapterNumber)
  if (fromOutline) parts.push(fromOutline)
  if (fromChapterOutline && !parts.includes(fromChapterOutline)) parts.push(fromChapterOutline)
  return parts.join("\n")
}

export function buildMustDo(chapterGoal: string, previousChapterEnding: string, foreshadowingStates: string): string {
  const items: string[] = []
  chapterGoal.split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => items.push(`- ${line}`))
  if (previousChapterEnding.trim()) {
    items.push(i18n.t("novel.contextPack.mustDo.previousChapterEnding", { value: previousChapterEnding.trim() }))
  }
  if (foreshadowingStates.trim()) {
    const firstForeshadowing = foreshadowingStates.split("\n").find(Boolean)
    /* v8 ignore next */
    if (firstForeshadowing) {
      items.push(i18n.t("novel.contextPack.mustDo.foreshadowing", { value: firstForeshadowing.trim() }))
    }
  }
  return items.join("\n")
}

/**
 * C（方案 X 全做 M+）P0 护栏：buildMustAvoid 仅接收 (canonRules, timeline, characterStates)，
 * **刻意不含** `formerFacts`。失效事实若被纳入"避免违背"，语义将倒置（把已推翻信息当当前
 * 真值去"避免违背"）——故 former 事实只走独立分块（FIELD_CONFIGS.formerFacts），绝不入此。
 */
export function buildMustAvoid(canonRules: string, timeline: string, characterStates: string): string {
  const items: string[] = []
  if (canonRules.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.canonRules", { value: canonRules.trim() }))
  if (timeline.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.timeline", { value: timeline.trim() }))
  if (characterStates.trim()) items.push(i18n.t("novel.contextPack.mustAvoid.characterStates", { value: characterStates.trim() }))
  return items.join("\n")
}

export interface NextChapterAdviceInput {
  chapterGoal: string
  recentSummaries: string[]
  previousChapterEnding: string
  foreshadowingStates: string
  timeline: string
  searchResults: string
}

export function buildNextChapterAdvice(input: NextChapterAdviceInput): string {
  const advice: string[] = []
  if (input.previousChapterEnding.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.previousChapterEnding", { value: input.previousChapterEnding.trim() }))
  }
  if (input.chapterGoal.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.chapterGoal", { value: input.chapterGoal.trim() }))
  }
  if (input.foreshadowingStates.trim()) {
    const firstForeshadowing = input.foreshadowingStates.split("\n").find(Boolean)
    /* v8 ignore next */
    if (firstForeshadowing) {
      advice.push(i18n.t("novel.contextPack.nextChapterAdvice.foreshadowing", { value: firstForeshadowing.trim() }))
    }
  }
  if (input.timeline.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.timeline", { value: input.timeline.trim() }))
  }
  if (input.searchResults.trim()) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.searchResults", { value: input.searchResults.trim() }))
  }
  if (input.recentSummaries.length > 0) {
    advice.push(i18n.t("novel.contextPack.nextChapterAdvice.recentSummaries", { value: input.recentSummaries.slice(-2).join("；") }))
  }
  return advice.join("\n")
}

export function joinNonEmpty(parts: string[], separator: string): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(separator)
}
