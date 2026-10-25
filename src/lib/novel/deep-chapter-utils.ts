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
 * ISS-20260709-047: 增量重复尾检测器（compact 缓冲跨次复用）。
 *
 * 改前 findRepeatedTailStart 每次调用都从整串重建 compact（两次全串 regex +
 * 全串 indexOf 计数），在 collectModelText 的每-token 回调里是 O(N) 重建 × O(N)
 * 扫描 = O(N²/window) 总量。检测器把 compact（含 compact→raw 坐标映射）做成
 * append-only 增量缓冲：push 只处理新增 chunk（O(new)），check 与改前完全同一
 * 计数流程（同 tail 取法、同非重叠步进、同 hitLimit 早停），返回的 raw 坐标与
 * sourceIndexFromCompactIndex 逐元素一致。调用方每 token push + 门控 check，
 * 彻底消灭逐次全串重建。
 */
export interface RepeatedTailDetector {
  /** 只读：当前缓冲 compact 长度（供调用方门控/断言）。 */
  readonly compactLength: number
  /** 喂入新增原文（token/整串均可；空白字符边界无关，可任意切分）。 */
  push(rawChunk: string): void
  /** 与改前 findRepeatedTailStart 同语义检测，返回 raw 坐标系起点或 null。 */
  check(): number | null
  /** 清空缓冲（含坐标映射与 raw 长度）。 */
  reset(): void
}

export function createRepeatedTailDetector(opts: {
  minChars: number
  windowChars: number
  hitLimit: number
}): RepeatedTailDetector {
  let compactChars: string[] = []
  let compactToRaw: number[] = []
  let rawLength = 0
  return {
    get compactLength(): number {
      return compactChars.length
    },
    push(rawChunk: string): void {
      for (let i = 0; i < rawChunk.length; i += 1) {
        const ch = rawChunk[i]
        // 空白跳过（\r\n 跨 chunk 配对不影响：两者最终都被整体移除）。
        if (/\s/.test(ch)) {
          rawLength += 1
          continue
        }
        compactChars.push(ch)
        compactToRaw.push(rawLength)
        rawLength += 1
      }
    },
    check(): number | null {
      const compact = compactChars.join("")
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
          // 与 sourceIndexFromCompactIndex(content, first + windowChars) 同值：
          // compact[target] 对应第 target+1 个非空白字符的 raw 下标。
          const target = first + opts.windowChars
          return target < compactToRaw.length ? compactToRaw[target] : rawLength
        }
        searchIndex = found + Math.max(1, tail.length)
      }
      return null
    },
    reset(): void {
      compactChars = []
      compactToRaw = []
      rawLength = 0
    },
  }
}

/**
 * 重复尾检测：紧凑串末尾 REPEAT_WINDOW_CHARS 窗口在全文出现 ≥REPEAT_HIT_LIMIT
 * 次 → 返回重复起点（原 content 坐标系）。无 → null。
 *
 * ISS-20260709-047：本函数现委托增量检测器（单次 push + check），计数流程、
 * 步进、早停、坐标回落与改前逐字一致，纯函数签名与评分语义零变化。
 */
export function findRepeatedTailStart(
  content: string,
  opts: { minChars: number; windowChars: number; hitLimit: number },
): number | null {
  const detector = createRepeatedTailDetector(opts)
  detector.push(content)
  return detector.check()
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
