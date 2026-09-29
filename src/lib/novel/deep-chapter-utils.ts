/**
 * deep-chapter-utils — 章节生成纯工具函数子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 deep-chapter-generation.ts 抽出的无模块依赖纯函数：字符串格式化/
 * 截断/重复尾检测/字符计数/中止断言/severity 标签。主文件只做编排——
 * 这些工具函数独立可测、可复用，不再埋在 3000 行编排体里。
 */

/** 章节字符数（去空白后）。 */
export function countChapterChars(content: string): number {
  return content.replace(/\s+/g, "").length
}

/** 中止断言：signal.aborted → 抛 USER_ABORT_MESSAGE。 */
export function assertNotAborted(signal: AbortSignal | undefined, abortMessage: string): void {
  if (signal?.aborted) throw new Error(abortMessage)
}

/**
 * 紧凑索引 → 原内容索引（跳过空白字符对齐坐标系）。
 * findRepeatedTailStart 内部用：compact 是无空白串，返回的 index 需落回原
 * content 坐标系（\r\n 不扰 seen 计数）。
 */
export function sourceIndexFromCompactIndex(content: string, compactIndex: number): number {
  let seen = 0
  for (let index = 0; index < content.length; index += 1) {
    if (/\s/.test(content[index])) continue
    seen += 1
    if (seen > compactIndex) return index
  }
  return content.length
}

/**
 * 重复尾检测：紧凑串末尾 REPEAT_WINDOW_CHARS 窗口在全文出现 ≥REPEAT_HIT_LIMIT
 * 次 → 返回重复起点（原 content 坐标系）。无 → null。
 */
export function findRepeatedTailStart(
  content: string,
  opts: { minChars: number; windowChars: number; hitLimit: number },
): number | null {
  const normalized = content.replace(/\r\n/g, "\n")
  const compact = normalized.replace(/\s+/g, "")
  if (compact.length < opts.minChars) return null

  const tail = compact.slice(-opts.windowChars)
  const first = compact.indexOf(tail)
  if (first === -1 || first >= compact.length - opts.windowChars) return null

  let hits = 0
  let searchIndex = 0
  while (true) {
    const found = compact.indexOf(tail, searchIndex)
    if (found === -1) break
    hits += 1
    if (hits >= opts.hitLimit) {
      // 返回 RAW content 坐标系（:1886 slices raw content；CRLF→LF 归一会切早 N 字符）。
      return sourceIndexFromCompactIndex(content, first + opts.windowChars)
    }
    searchIndex = found + Math.max(1, tail.length)
  }
  return null
}

/** thinking 文本截断（ISS-20260712-ARCH-1: 供 deep-chapter-task-brief 复用）。 */
export function trimForThinking(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...`
}

/** 文本回退：空 → fallbackText，非空 → trimForThinking(180)。 */
export function fallback(value: string | null | undefined, fallbackText: string): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimForThinking(trimmed, 180) : fallbackText
}

/** 摘要文本：空 → 「暂无」，非空 → trimForThinking(140)。 */
export function summaryText(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimForThinking(trimmed, 140) : "暂无"
}

/** severity → 中文标签。 */
export function severityLabel(severity: "error" | "warning" | "info" | string): string {
  if (severity === "error") return "严重"
  if (severity === "warning") return "提醒"
  return "信息"
}

// F4-6（Round-4 评估）：thinking 格式化簇自 deep-chapter-generation.ts 迁入
//（巨石拆分第 6 步）。仅 type-only 依赖主链类型（编译期擦除，无运行时循环）；
// formatStageThinking 引自 chapter-utils（leaf，无循环）。
import { formatStageThinking } from "./chapter-utils"
import type { ContextPack } from "./context-engine"
import type { DeepChapterGenerationInput } from "./deep-chapter-generation"
import type { GoldenThreeChapterRequest } from "./golden-three-chapters"
import type { NovelReviewResult } from "./review-adapter"

export function formatContextThinking(input: DeepChapterGenerationInput, pack: ContextPack): string {
  const recentSummaries = Array.isArray(pack.recentSummaries) ? pack.recentSummaries : []
  const goldenThreeHints = resolveGoldenThreeThinkingHints(input.goldenThreeChapter)
  return formatStageThinking(
    "阶段1：上下文分析",
    [
      ...goldenThreeHints,
      input.chapterNumber ? `目标章节：第${input.chapterNumber}章` : "目标章节：从用户请求中识别",
      `章节目标：${fallback(pack.chapterGoal, "未读取到明确章节目标")}`,
      `上一章结尾：${fallback(pack.previousChapterEnding, "未读取到上一章结尾")}`,
      `近期剧情：${recentSummaries.length} 条`,
      `人物状态：${summaryText(pack.characterStates)}`,
      `伏笔状态：${summaryText(pack.foreshadowingStates)}`,
      `时间线：${summaryText(pack.timeline)}`,
      `禁止违背：${fallback(pack.mustAvoid, "暂无明确禁止项")}`,
      `必须完成：${fallback(pack.mustDo, "暂无明确必做项")}`,
    ].join("\n"),
  )
}

export function formatReviewThinking(reviewResults: NovelReviewResult[]): string {
  if (reviewResults.length === 0) {
    return formatStageThinking("阶段4：AI审稿", "未发现阻断问题。")
  }
  const characterIssues = reviewResults.filter((item) => item.type === "character_consistency")
  const otherIssues = reviewResults.filter((item) => item.type !== "character_consistency")
  const errorCount = reviewResults.filter((item) => item.severity === "error").length
  const sections: string[] = [
    `发现 ${reviewResults.length} 个问题，其中阻断问题 ${errorCount} 个。`,
  ]

  // 角色命中记忆库报告（单独展示 character_consistency 类型的问题）
  if (characterIssues.length > 0) {
    sections.push("")
    sections.push("【角色命中记忆库报告】")
    sections.push(formatReviewIssueList(characterIssues))
  }

  // 其他问题
  if (otherIssues.length > 0) {
    sections.push("")
    sections.push("【其他审查问题】")
    sections.push(formatReviewIssueList(otherIssues))
  }

  return formatStageThinking("阶段4：AI审稿", sections.join("\n"))
}

export function formatReviewIssueList(reviewResults: NovelReviewResult[]): string {
  return reviewResults
    .map((item, index) => [
      `${index + 1}. [${severityLabel(item.severity)}] ${item.message}`,
      item.evidence ? `   - 证据：${item.evidence}` : "",
      item.relatedMemory ? `   - 相关记忆：${item.relatedMemory}` : "",
      item.suggestion ? `   - 建议：${item.suggestion}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n")
}

export function resolveGoldenThreeThinkingHints(goldenThreeChapter?: GoldenThreeChapterRequest): string[] {
  if (!goldenThreeChapter?.enabled || !goldenThreeChapter.targetChapter) return []
  if (goldenThreeChapter.outputMode === "first_chapter_with_directions") {
    return [
      "黄金三章：已启用",
      "执行策略：当前按黄金三章规则生成第1章正文，并在正文后给出第2章、第3章写作方向。",
    ]
  }
  return [
    "黄金三章：已启用",
    `执行策略：当前按黄金三章规则生成第${goldenThreeChapter.targetChapter}章正文。`,
  ]
}
