/**
 * 拆书分析引擎 - 主入口（精简版）
 * 专注于：章节拆分 → 角色提取 → Skill 生成
 */

import type { LlmConfig } from "@/stores/wiki-store"
import type {
  BookAnalysisMetadata,
  BookAnalysisProgress,
  ChapterSelectionState,
} from "./types"
import { createDirectory, writeFile, readFile, listDirectory } from "@/commands/fs"
import { normalizePath, joinPath } from "@/lib/path-utils"
import { fingerprintFileSample } from "./content-fingerprint"
import { findBookLibraryEntry, upsertBookLibraryEntry } from "./library-store"
import { logger, toErrorMessage } from "@/lib/utils"

export interface SplitNovelTextChapter {
  /** 1-based 顺序序号 */
  order: number
  /** 从标题识别到的章号（未识别时为 null） */
  detectedChapterNumber: number | null
  /** 规范化章节标题（不含多余前后空白） */
  title: string
  /** 去掉首行重复标题后的正文 */
  body: string
  /** 正文字数（去空白统计） */
  wordCount: number
  /** 前 120 字摘要预览 */
  preview: string
}

const WHOLE_TEXT_CHAPTER_HEADING_RE =
  /^[ \t\u3000]*(?:第[ \t\u3000]*([零〇一二三四五六七八九十百千万两0-9\uff10-\uff19]+)[ \t\u3000]*[章节回]|chapter[ \t\u3000]*[-_]?[ \t\u3000]*0*([0-9\uff10-\uff19]+))(?:(?:[ \t\u3000]+|[:：、·.．—–\-][ \t\u3000]*)([^\r\n]*))?[ \t\u3000]*$/gim

function normalizeFullWidthDigitsForSplit(value: string): string {
  return value.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
}

function parseChineseChapterNumberForSplit(value: string): number | null {
  const normalized = value.replace(/两/g, "二").replace(/[零〇]/g, "")
  if (!normalized) return null
  const digitMap: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
  }
  let total = 0
  let section = 0
  let current = 0
  let hasValue = false
  for (const ch of normalized) {
    if (digitMap[ch] !== undefined) {
      current = digitMap[ch]
      hasValue = true
      continue
    }
    const unit = unitMap[ch]
    if (!unit) return null
    hasValue = true
    if (unit === 10000) {
      section = (section + (current || 1)) * unit
      total += section
      section = 0
    } else {
      section += (current || 1) * unit
    }
    current = 0
  }
  const result = total + section + current
  return hasValue && Number.isSafeInteger(result) && result >= 1 ? result : null
}

function parseDetectedChapterNumber(rawToken: string | undefined): number | null {
  if (!rawToken) return null
  const ascii = normalizeFullWidthDigitsForSplit(rawToken.trim())
  if (/^\d+$/.test(ascii)) {
    const parsed = Number.parseInt(ascii, 10)
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
  }
  return parseChineseChapterNumberForSplit(ascii)
}

/**
 * 纯函数整本 TXT 拆章（P1-03：零 IO、零写 library.json，供预览与整本导入共用）。
 * 剥离首部 UTF-8 BOM 并统一 CRLF → LF；识别行首中英文/全角/多分隔符章节标题，
 * 严防正文行内误切。
 */
export function splitNovelTextToChapters(rawText: string): SplitNovelTextChapter[] {
  const normalized = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  if (!normalized.trim()) return []

  const matches = Array.from(normalized.matchAll(WHOLE_TEXT_CHAPTER_HEADING_RE))
  if (matches.length === 0) return []

  const chapters: SplitNovelTextChapter[] = []
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!
    const title = match[0].trim()
    const bodyStart = match.index! + match[0].length
    const bodyEnd = matches[i + 1]?.index ?? normalized.length
    const body = normalized.slice(bodyStart, bodyEnd).trim()
    const wordCount = body.replace(/\s+/g, "").length
    const preview = body.replace(/\s+/g, " ").trim().slice(0, 120)
    const detectedChapterNumber = parseDetectedChapterNumber(match[1] ?? match[2])
    chapters.push({
      order: i + 1,
      detectedChapterNumber,
      title,
      body,
      wordCount,
      preview,
    })
  }
  return chapters
}

export interface SplitChaptersInput {
  sourcePath: string
  projectPath: string
  llmConfig: LlmConfig
  onProgress?: (progress: {
    stage: string
    stageLabel: string
    completed: number
    total: number
    percentage: number
    currentItem?: string
  }) => void
  signal?: AbortSignal
}

export interface SplitChaptersResult {
  success: boolean
  bookId: string
  bookPath: string
  metadata: BookAnalysisMetadata
  chapters: Array<{
    id: string
    title: string
    order: number
    wordCount: number
    path: string
  }>
}

/**
 * 创建拆书分析目录结构
 */
async function createAnalysisDirectories(projectPath: string, bookId: string): Promise<string> {
  const bookPath = normalizePath(joinPath(projectPath, "book-analysis", bookId))

  await createDirectory(normalizePath(joinPath(projectPath, "book-analysis")))
  await createDirectory(bookPath)
  await createDirectory(joinPath(bookPath, "chapters"))
  await createDirectory(joinPath(bookPath, "characters"))
  await createDirectory(joinPath(bookPath, "skills"))

  return bookPath
}

/**
 * 读取并拆分小说章节
 */
export async function splitNovelIntoChapters(
  sourcePath: string,
  projectPath: string,
  _llmConfig: LlmConfig,
  onProgress?: (progress: Partial<BookAnalysisProgress>) => void,
  signal?: AbortSignal
): Promise<SplitChaptersResult> {
  // 生成 bookId - 顶部声明一次（feature/book-analysis-reuse）
  const now = Date.now()

  onProgress?.({
    stage: "reading_file",
    stageLabel: "读取文件中",
    completed: 0,
    total: 100,
    percentage: 0,
  })

  // 读取源文件 + 算指纹（feature/book-analysis-reuse：先读后算 hash）
  let content: string
  try {
    content = await readFile(sourcePath)
  } catch (error) {
    throw new Error(`读取文件失败: ${toErrorMessage(error)}`)
  }
  const contentHash = fingerprintFileSample(content)
  const normalizedSource = normalizePath(sourcePath)

  // 查重（feature/book-analysis-reuse）：命中则复用 bookId，跳过目录创建
  const existing = await findBookLibraryEntry(projectPath, normalizedSource, contentHash)
  let bookId: string
  let bookPath: string
  if (existing) {
    bookId = existing.bookId
    bookPath = normalizePath(joinPath(projectPath, "book-analysis", bookId))
    onProgress?.({
      stage: "reading_file",
      stageLabel: "复用历史分析",
      completed: 10,
      total: 100,
      percentage: 10,
    })
  } else {
    bookId = `book-${now}`
    bookPath = await createAnalysisDirectories(projectPath, bookId)
  }

  if (signal?.aborted) {
    throw new Error("用户取消分析")
  }

  onProgress?.({
    stage: "splitting_chapters",
    stageLabel: existing ? "复用章节中" : "识别章节中",
    completed: 10,
    total: 100,
    percentage: 10,
  })

  const splitChapters = splitNovelTextToChapters(content)

  if (splitChapters.length === 0) {
    throw new Error("未能识别到章节标记，请确保小说文件包含\"第X章\"格式的章节标题")
  }

  const chapters: Array<{
    id: string
    title: string
    order: number
    wordCount: number
    path: string
  }> = []

  const totalChapters = splitChapters.length
  let totalWords = 0

  for (let i = 0; i < splitChapters.length; i++) {
    if (signal?.aborted) {
      throw new Error("用户取消分析")
    }

    const split = splitChapters[i]!
    const title = split.title
    const chapterContent = split.body ? `${title}\n${split.body}` : title
    const wordCount = chapterContent.length
    totalWords += wordCount

    const chapterId = `ch-${String(i + 1).padStart(4, "0")}`
    const chapterPath = joinPath(bookPath, "chapters", `${chapterId}.md`)

    // 生成 markdown 格式
    const markdown = `---
id: ${chapterId}
title: ${title}
order: ${i + 1}
wordCount: ${wordCount}
---

${chapterContent}
`

    await writeFile(chapterPath, markdown)

    chapters.push({
      id: chapterId,
      title,
      order: i + 1,
      wordCount,
      path: chapterPath,
    })

    // 更新进度
    const progress = Math.floor(10 + (i + 1) / totalChapters * 20)
    onProgress?.({
      stage: "splitting_chapters",
      stageLabel: "拆分章节中",
      completed: i + 1,
      total: totalChapters,
      percentage: progress,
      currentItem: title,
    })
  }

  // 提取书名（从文件名或第一章）
  const sourceFileName = sourcePath.split(/[/\\]/).pop()?.replace(/\.txt$/i, "") || "未命名作品"
  const bookTitle = sourceFileName

  // 保存元数据（feature/book-analysis-reuse：复用时保留原 createdAt）
  const metadata: BookAnalysisMetadata = {
    title: bookTitle,
    author: undefined,
    totalChapters: chapters.length,
    totalWords,
    sourceType: "file",
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  }

  await writeFile(
    joinPath(bookPath, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  )

  // 注册到 library（feature/book-analysis-reuse）
  await upsertBookLibraryEntry(projectPath, {
    bookId,
    sourcePath: normalizedSource,
    contentHash,
    title: bookTitle,
    totalChapters: chapters.length,
    totalWords,
    charactersCount: existing?.charactersCount ?? 0,
    skillsCount: existing?.skillsCount ?? 0,
    status: "completed",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })

  onProgress?.({
    stage: "splitting_chapters",
    stageLabel: "章节拆分完成",
    completed: totalChapters,
    total: totalChapters,
    percentage: 30,
  })

  return {
    success: true,
    bookId,
    bookPath,
    metadata,
    chapters,
  }
}

/**
 * 读取已拆分的章节列表
 */
export async function loadChapterList(bookPath: string): Promise<ChapterSelectionState[]> {
  const chaptersDir = joinPath(bookPath, "chapters")

  try {
    const files = await listDirectory(chaptersDir)
    const chapters: ChapterSelectionState[] = []

    // 只处理 .md 文件
    const mdFiles = files.filter((f) => f.name.endsWith(".md") && !f.is_dir)

    // PAT-IM1（ISS-20260709-024）：章节文件彼此独立，并行读取后按原顺序回填。
    const chapterContents = await Promise.all(
      mdFiles.map((file) => readFile(file.path).catch(() => null)),
    )
    for (const [fileIndex, file] of mdFiles.entries()) {
      try {
        const content = chapterContents[fileIndex]
        if (content === null) continue

        // 解析 frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1]
          const idMatch = frontmatter.match(/id:\s*(.+)/)
          const titleMatch = frontmatter.match(/title:\s*(.+)/)
          const orderMatch = frontmatter.match(/order:\s*(\d+)/)
          const wordCountMatch = frontmatter.match(/wordCount:\s*(\d+)/)

          if (idMatch && titleMatch && orderMatch) {
            chapters.push({
              chapterId: idMatch[1].trim(),
              title: titleMatch[1].trim(),
              order: parseInt(orderMatch[1], 10),
              wordCount: wordCountMatch ? parseInt(wordCountMatch[1], 10) : 0,
              selected: false,
              analyzed: false,
            })
          }
        }
      } catch (err) {
        logger.error("Analysis Engine", `Failed to read chapter ${file.path}`, { error: toErrorMessage(err) })
      }
    }

    // 按顺序排序
    chapters.sort((a, b) => a.order - b.order)

    return chapters
  } catch (error) {
    logger.error("Analysis Engine", "Failed to load chapter list", { error: toErrorMessage(error) })
    return []
  }
}

/**
 * 读取元数据
 */
export async function loadMetadata(bookPath: string): Promise<BookAnalysisMetadata | null> {
  try {
    const metadataPath = joinPath(bookPath, "metadata.json")
    const content = await readFile(metadataPath)
    return JSON.parse(content) as BookAnalysisMetadata
  } catch (error) {
    logger.error("Analysis Engine", "Failed to load metadata", { error: toErrorMessage(error) })
    return null
  }
}
