// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * segment-summary.ts — 段摘要滚动最小版（B2 中期改进）。
 *
 * 背景（P0-4）：50 章+远期记忆无滚动压缩，campaign-memory 只带上一章
 * （1500/800/400），related-chapters 至多 5 条反查，必超预算截断/遗忘。
 * 本模块提供最小滚动单位：每 SEGMENT_SIZE 章一段，按章号分组，
 * 取每段首尾拼摘要输入，供后续 LLM 压缩或直接拼入 carryover。
 *
 * 机械层：纯函数（零 IO / 零时钟 / 零模型调用）+ 薄持久层
 * （.novel/segment-summaries.json 经 writeFileAtomic，读失败回 {}）。
 * 默认安全：load 失败降级为空对象，调用侧直通不断链；
 * save 失败吞掉（best-effort，不抛）。
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/** 段大小（章数）：每 10 章一段，segmentIndex = floor((chapter-1)/10)。 */
export const SEGMENT_SIZE = 10

/** 运行期落盘相对路径（ADR-16：每项目运行期数据在 `.novel/`）。 */
export const SEGMENT_SUMMARIES_FILE = ".novel/segment-summaries.json"

/** 段摘要表：key = String(segmentIndex)，value = 该段摘要文本。 */
export type SegmentSummaries = Record<string, string>

/** 段摘要输入的最小章单元。 */
export interface SegmentChapterInput {
  /** 章号（1-based）。 */
  chapterNumber: number
  /** 本章摘要/正文片段（调用侧已截断，原文原样拼）。 */
  summary: string
}

/**
 * 章号 → 段索引（纯函数）。
 * 非法章号（<1/非有限）归 0 段，避免负索引污染分组。
 */
export function segmentIndexForChapter(chapterNumber: number): number {
  if (!Number.isFinite(chapterNumber) || chapterNumber < 1) return 0
  return Math.floor((Math.floor(chapterNumber) - 1) / SEGMENT_SIZE)
}

/**
 * 段索引 → 章号区间（纯函数，1-based 闭区间）。
 */
export function segmentRange(segmentIndex: number): { startChapter: number; endChapter: number } {
  const idx = Number.isFinite(segmentIndex) && segmentIndex >= 0 ? Math.floor(segmentIndex) : 0
  return {
    startChapter: idx * SEGMENT_SIZE + 1,
    endChapter: (idx + 1) * SEGMENT_SIZE,
  }
}

/**
 * 按章号分组（纯函数，不突变入参）。
 * @returns Map<segmentIndex, 按章号升序的章号列表>。
 */
export function groupChapterNumbersBySegment(
  chapterNumbers: readonly number[],
): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (const n of chapterNumbers) {
    const idx = segmentIndexForChapter(n)
    const list = groups.get(idx)
    if (list) {
      list.push(n)
    } else {
      groups.set(idx, [n])
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a - b)
  }
  return groups
}

/**
 * 取每段首尾拼摘要输入（纯函数）。
 *
 * - 按章号分组（SEGMENT_SIZE=10）；
 * - 每段只取首章与尾章的 summary 拼入（单章段只取一次）；
 * - 空输入（含全空白 summary）返回 ""（调用侧据此跳过注入）。
 */
export function buildSegmentSummaryInput(chapters: readonly SegmentChapterInput[]): string {
  const valid = chapters.filter(
    (c) =>
      Number.isFinite(c.chapterNumber) &&
      c.chapterNumber >= 1 &&
      typeof c.summary === "string" &&
      c.summary.trim().length > 0,
  )
  if (valid.length === 0) return ""

  const bySegment = new Map<number, SegmentChapterInput[]>()
  for (const c of valid) {
    const idx = segmentIndexForChapter(c.chapterNumber)
    const list = bySegment.get(idx)
    if (list) {
      list.push(c)
    } else {
      bySegment.set(idx, [c])
    }
  }
  const ordered = [...bySegment.entries()].sort((a, b) => a[0] - b[0])
  const lines: string[] = []
  for (const [idx, list] of ordered) {
    const sorted = [...list].sort((a, b) => a.chapterNumber - b.chapterNumber)
    const { startChapter, endChapter } = segmentRange(idx)
    const head = sorted[0]
    const tail = sorted[sorted.length - 1]
    if (sorted.length === 1 || head.chapterNumber === tail.chapterNumber) {
      lines.push(`【段${idx} 第${startChapter}-${endChapter}章】第${head.chapterNumber}章：${head.summary}`)
    } else {
      lines.push(
        `【段${idx} 第${startChapter}-${endChapter}章】首第${head.chapterNumber}章：${head.summary}｜尾第${tail.chapterNumber}章：${tail.summary}`,
      )
    }
  }
  return lines.join("\n")
}

/**
 * 取最新段摘要文本（纯函数，只读）。
 * 空表/null/undefined → ""（调用侧直通）。
 */
export function getLatestSegmentSummaryText(
  store: SegmentSummaries | null | undefined,
): string {
  if (!store || typeof store !== "object") return ""
  const keys = Object.keys(store)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  if (keys.length === 0) return ""
  const latest = store[String(keys[keys.length - 1])]
  return typeof latest === "string" ? latest : ""
}

/** 段摘要运行期路径：`{projectPath}/.novel/segment-summaries.json`。 */
export function segmentSummariesFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${SEGMENT_SUMMARIES_FILE}`
}

/**
 * 加载段摘要表。文件缺失/不可读/JSON 非法 → {}（降级直通，不抛）。
 */
export async function loadSegmentSummaries(projectPath: string): Promise<SegmentSummaries> {
  try {
    const raw = await readFile(segmentSummariesFilePath(projectPath))
    if (!raw || raw.trim().length === 0) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: SegmentSummaries = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 保存段摘要表（best-effort：写失败吞掉，不抛，不断链）。
 */
export async function saveSegmentSummaries(
  projectPath: string,
  data: SegmentSummaries,
): Promise<void> {
  try {
    const pp = normalizePath(projectPath)
    await createDirectory(`${pp}/.novel`)
    await writeFileAtomic(segmentSummariesFilePath(pp), JSON.stringify(data, null, 2))
  } catch {
    // best-effort：段摘要丢失仅影响远期记忆 richness，不阻断战役
  }
}
