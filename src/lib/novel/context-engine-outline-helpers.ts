/**
 * context-engine-outline-helpers — 大纲读取纯辅助函数子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 context-engine.ts 抽出的无重依赖纯函数：FileNode 树扁平化/frontmatter
 * 章号读取/中文数字章号/章标签/章标记检测。主文件只做编排——这些工具独立
 * 可测可复用，不依赖 tieredSlice/searchWiki（避免循环依赖）。
 */

import { parseFrontmatter } from "@/lib/frontmatter"
import type { FileNode } from "@/types/wiki"

/** FileNode 树 → 扁平 .md 文件列表（递归子目录）。 */
export function flattenOutlineMarkdownFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) files.push(...flattenOutlineMarkdownFiles(node.children))
      continue
    }
    if (node.name.toLowerCase().endsWith(".md")) files.push(node)
  }
  return files
}

/**
 * 来源优先级：story-outline.md → 其他正式大纲 → 仅存备份。
 * 显式稳定分组保留每组的输入顺序与对象身份；有正式来源时不混入备份。
 */
export function groupOutlineSources<T extends { path: string }>(sources: T[]): T[][] {
  const canonical: T[] = []
  const regular: T[] = []
  const backups: T[] = []
  for (const source of sources) {
    const name = source.path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? ""
    if (name === "story-outline.md") canonical.push(source)
    else if (/(?:^|[._-])(?:backup|bak)(?:[._-]|$)/i.test(name)) backups.push(source)
    else regular.push(source)
  }
  return canonical.length || regular.length
    ? [canonical, regular].filter((group) => group.length > 0)
    : backups.length ? [backups] : []
}

/** 三个 reader 共享的稳定来源选择；必须先选来源，再按 IO 上限截断。 */
export function selectOutlineSources<T extends { path: string }>(sources: T[]): T[] {
  return groupOutlineSources(sources).flat()
}

/** frontmatter.chapter_number → number（number|可转number的string，>0 有效）。 */
export function readFrontmatterChapterNumber(content: string): number | undefined {
  const raw = parseFrontmatter(content).frontmatter?.chapter_number
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** 数字 → 中文数字章号（1→一, 10→十, 11→十一, 20→二十, 100→百, 101→百零一）。 */
export function numberToChineseChapter(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
  if (value <= 10) {
    if (value === 10) return "十"
    return digits[value] ?? String(value)
  }
  if (value < 20) return `十${digits[value - 10]}`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return `${digits[tens]}十${ones === 0 ? "" : digits[ones]}`
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100)
    const rest = value % 100
    if (rest === 0) return `${digits[hundreds]}百`
    if (rest < 10) return `${digits[hundreds]}百零${digits[rest]}`
    return `${digits[hundreds]}百${numberToChineseChapter(rest)}`
  }
  return String(value)
}

/** 章号 → 中英双标签 [第N章, 第中文N章]。 */
export function chapterLabels(chapterNumber: number): string[] {
  return [`第${chapterNumber}章`, `第${numberToChineseChapter(chapterNumber)}章`]
}

// PERF (odyssey-review): memoize the per-chapterNumber RegExp. includesChapterMarker
// is called per-candidate inside pickChapterOutlineByNumber's candidates.find —
// compiling `new RegExp` 160×/build is wasteful.
const chapterMarkerRegexCache = new Map<number, RegExp>()

/** 文本是否含章标记（紧凑串含 第N章/第中文N章，或 chapter\s*N 词边界）。 */
export function includesChapterMarker(text: string, chapterNumber: number): boolean {
  const compact = text.replace(/\s+/g, "")
  if (chapterLabels(chapterNumber).some((label) => compact.includes(label))) return true
  let re = chapterMarkerRegexCache.get(chapterNumber)
  if (!re) {
    re = new RegExp(`chapter\\s*${chapterNumber}\\b`, "i")
    chapterMarkerRegexCache.set(chapterNumber, re)
  }
  return re.test(text)
}
