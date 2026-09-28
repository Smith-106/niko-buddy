// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 大纲自动解构分发器 (Outline to Chapter Skeletons Generator)
 *
 * 核心设计目标：
 * 1. 结构化解析：从小说总纲、卷大纲或分章细纲 Markdown 文本中自动识别章节编号、章节标题与剧情概要。
 * 2. 批量铺排骨架：在 wiki/chapters/ 目录下自动批量创建预定章节骨架（chapter-xxx.md）。
 * 3. 守护现有成果：默认跳过已存在的章节文件（!overwriteExisting），杜绝误覆盖作者已写正文。
 * 4. 契约规范：骨架章节采用符合规范的 Frontmatter（chapter_status: "planned"），无缝接入后续任务路由与分章计划。
 */

import { createDirectory, fileExists, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { yamlEscape } from "@/lib/wiki-filename"
import { parseChineseInteger } from "./chapter-import"

export interface UnpackedOutlineChapter {
  chapterNumber: number
  title: string
  summary: string
}

export interface UnpackOutlineOptions {
  projectPath: string
  outlineContent: string
  overwriteExisting?: boolean
  chapterDir?: string
}

export interface UnpackOutlineResult {
  totalParsed: number
  createdCount: number
  skippedCount: number
  createdFiles: string[]
  chapters: UnpackedOutlineChapter[]
}

function parseChapterNumberToken(raw: string): number | null {
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10)
  }
  return parseChineseInteger(trimmed)
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^[:：\-—_、，,\s]+/, "")
    .replace(/[*_#`]/g, "")
    .trim()
}

/**
 * 从大纲文本中解析章节结构
 */
export function parseOutlineToChapters(outlineText: string): UnpackedOutlineChapter[] {
  if (!outlineText || !outlineText.trim()) {
    return []
  }

  const lines = outlineText.split(/\r?\n/)
  const chapters: UnpackedOutlineChapter[] = []
  let currentChapter: UnpackedOutlineChapter | null = null
  const seenNumbers = new Set<number>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentChapter && currentChapter.summary) {
        currentChapter.summary += "\n"
      }
      continue
    }

    const isMdHeader = /^#{1,6}\s+/.test(trimmed)
    const isBulletOrBold = /^(?:\*{2}|[-*+]\s+|\d+\.\s+)/.test(trimmed)
    const chapterMatch = trimmed.match(
      /^(?:#{1,6}\s+|\*{2}|[-*+]\s+|\d+\.\s+)?(?:第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章节回]|Chapter\s*([0-9]+))[:：\s]*(.*)$/i,
    )

    let isHeading = false
    let chNum: number | null = null

    if (chapterMatch) {
      const rawNum = chapterMatch[1] || chapterMatch[2]
      chNum = parseChapterNumberToken(rawNum)
      if (chNum && chNum > 0) {
        if (isMdHeader || isBulletOrBold) {
          isHeading = true
        } else if (trimmed.length <= 50 && !trimmed.endsWith("。") && !trimmed.endsWith("；")) {
          isHeading = true
        }
      }
    }

    if (isHeading && chNum && !seenNumbers.has(chNum)) {
      if (currentChapter) {
        currentChapter.summary = currentChapter.summary.trim()
        chapters.push(currentChapter)
      }
      seenNumbers.add(chNum)
      const rawTitle = chapterMatch![3] || ""
      const titleSuffix = cleanTitle(rawTitle)
      currentChapter = {
        chapterNumber: chNum,
        title: titleSuffix || `第${chNum}章`,
        summary: "",
      }
    } else if (currentChapter) {
      currentChapter.summary = currentChapter.summary
        ? `${currentChapter.summary}\n${line}`
        : line
    }
  }

  if (currentChapter) {
    currentChapter.summary = currentChapter.summary.trim()
    chapters.push(currentChapter)
  }

  return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/**
 * 将大纲解构并批量写入章节骨架文件
 */
export async function unpackOutlineToChapterFiles(
  options: UnpackOutlineOptions,
): Promise<UnpackOutlineResult> {
  const {
    projectPath,
    outlineContent,
    overwriteExisting = false,
  } = options

  const pp = normalizePath(projectPath)
  const targetDir = options.chapterDir ? normalizePath(options.chapterDir) : `${pp}/wiki/chapters`

  await createDirectory(targetDir)

  const parsedChapters = parseOutlineToChapters(outlineContent)
  const createdFiles: string[] = []
  let createdCount = 0
  let skippedCount = 0

  const now = new Date().toISOString()

  for (const ch of parsedChapters) {
    const fileName = `chapter-${String(ch.chapterNumber).padStart(3, "0")}.md`
    const filePath = `${targetDir}/${fileName}`

    const exists = await fileExists(filePath)
    if (exists && !overwriteExisting) {
      skippedCount++
      continue
    }

    const frontmatter = [
      "---",
      "type: chapter",
      `chapter_number: ${ch.chapterNumber}`,
      "chapter_status: planned",
      `title: "${yamlEscape(ch.title)}"`,
      `created: ${now}`,
      "---",
      "",
    ].join("\n")

    const bodyContent = [
      `# 第${ch.chapterNumber}章 ${ch.title}`,
      "",
      ch.summary ? ch.summary : "（待根据大纲细化剧情起草）",
      "",
    ].join("\n")

    const fullContent = `${frontmatter}${bodyContent}`
    await writeFileAtomic(filePath, fullContent)

    createdCount++
    createdFiles.push(filePath)
  }

  return {
    totalParsed: parsedChapters.length,
    createdCount,
    skippedCount,
    createdFiles,
    chapters: parsedChapters,
  }
}
