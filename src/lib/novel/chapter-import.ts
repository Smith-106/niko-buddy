import { createDirectory, fileExists, listDirectory, readFile, writeFile, writeFileAtomic } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileName, getFileStem, normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { makeSafeFileSlug, yamlEscape } from "@/lib/wiki-filename"
import i18n from "@/i18n"
import { formatMemoryIngest, readBackMemoryIngest } from "./accept-draft-with-ingest"
import { splitNovelTextToChapters, type SplitNovelTextChapter } from "./book-analysis/analysis-engine"
import { defaultCanonDualWriteDeps } from "./canon-dual-write"
import type { IngestChapterOptions, IngestResult } from "./chapter-ingest"
import { parseChapterNumber } from "./chapter-meta"
import { isBareChapterLabel, resolveChapterTitle } from "./chapter-typography"
import { flattenMdFilesBase, invalidateChapterCache } from "./chapter-utils"
import type { FileNode } from "@/types/wiki"

export const CHAPTER_IMPORT_EXTENSIONS = ["txt", "md", "mdx", "doc", "docx"] as const

const CHAPTER_IMPORT_EXTENSION_SET = new Set<string>(CHAPTER_IMPORT_EXTENSIONS)

export interface ChapterImportCandidate {
  path: string
  name: string
}

export interface ImportedChapter {
  sourcePath: string
  path: string
  title: string
  chapterNumber: number
}

export interface ChapterImportFilenameMatch {
  chapterNumber: number
  titleSuffix: string
}

export interface ImportedChapterMemoryProgress {
  completed: number
  total: number
  currentPath: string | null
}

export interface ImportedChapterMemoryResult {
  completed: number
  pending: number
  partial: number
  failed: number
  cancelled: boolean
  errors: string[]
}

export interface WholeTxtPreviewResult {
  chapters: SplitNovelTextChapter[]
  totalWords: number
  warnings: string[]
}

export interface WholeTxtChapterImportOptions {
  /** false = 草稿 (draft)；true = 已定稿 (final)。严禁在导入函数内自动调 ingestChapter！ */
  finalForMemoryExtraction?: boolean
  rawText?: string
  /** 默认 "auto-offset"（顺延至 maxExisting + 1 起，绝不覆写/造同号冲突） */
  conflictStrategy?: "auto-offset" | "append-after-max" | "keep-detected"
  startChapterNumber?: number
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

export interface WholeTxtChapterImportResult {
  imported: ImportedChapter[]
  detectedCount: number
  skippedCount: number
  remappedCount: number
  warnings: string[]
}

type IngestChapterDependency = (
  projectPath: string,
  chapterPath: string,
  reviewModel?: string,
  signal?: AbortSignal,
  options?: IngestChapterOptions,
) => Promise<IngestResult>

function normalizeFullWidthDigits(value: string): string {
  /* v8 ignore next */
  return value.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
}

export function parseChineseInteger(value: string): number | null {
  const normalized = value.replace(/两/g, "二").replace(/[零〇]/g, "")
  if (!normalized) return 0
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
  let number = 0
  let hasValue = false

  for (const char of normalized) {
    if (digitMap[char] !== undefined) {
      number = digitMap[char]
      hasValue = true
      continue
    }
    const unit = unitMap[char]
    /* v8 ignore next */
    if (!unit) return null
    hasValue = true
    if (unit === 10000) {
      section = (section + (number || 1)) * unit
      total += section
      section = 0
    } else {
      section += (number || 1) * unit
    }
    number = 0
  }

  const result = total + section + number
  /* v8 ignore next */
  return hasValue && result > 0 ? result : null
}

export function extractImportedChapterNumber(text: string): number | null {
  const chapterMatch = matchChapterImportFilename(text)
  if (chapterMatch) return chapterMatch.chapterNumber

  const normalized = normalizeFullWidthDigits(text.normalize("NFKC"))

  const englishMatch = normalized.match(/chapter\s*[-_ ]*0*([0-9]+)/i)
  if (englishMatch?.[1]) return Number.parseInt(englishMatch[1], 10)

  const leadingNumberMatch = normalized.match(/^0*([0-9]{1,5})(?:\D|$)/)
  if (leadingNumberMatch?.[1]) return Number.parseInt(leadingNumberMatch[1], 10)

  return null
}

function parseChapterNumberToken(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10)
  return parseChineseInteger(raw)
}

export function matchChapterImportFilename(text: string): ChapterImportFilenameMatch | null {
  const stem = getFileStem(getFileName(text) || text)
  const normalized = normalizeFullWidthDigits(stem.normalize("NFKC"))

  const chapterPatterns = [
    /(?:^|[-_—–\s/\\])第\s*([0-9]+|[零〇一二三四五六七八九十百千万两]+)\s*[章节回]\s*[-_:：，、.。\s]*(.*)$/i,
    /(?:^|[-_—–\s/\\])chapter\s*[-_ ]*0*([0-9]+)\s*[-_:：，、.。\s]*(.*)$/i,
  ]

  for (const pattern of chapterPatterns) {
    const match = normalized.match(pattern)
    const rawNumber = match?.[1]
    if (!rawNumber) continue
    const chapterNumber = parseChapterNumberToken(rawNumber)
    if (!chapterNumber || chapterNumber <= 0) continue
    /* v8 ignore next -- 正则 (.*) 恒匹配，match[2] 恒为字符串 */
    const titleSuffix = cleanImportedChapterTitleSuffix(match[2] ?? "")
    return {
      chapterNumber,
      titleSuffix,
    }
  }

  return null
}

function chapterSortNumber(candidate: ChapterImportCandidate): number | null {
  return extractImportedChapterNumber(candidate.name) ?? extractImportedChapterNumber(candidate.path)
}

export function sortChapterImportCandidates(
  candidates: readonly ChapterImportCandidate[],
): ChapterImportCandidate[] {
  return [...candidates].sort((a, b) => {
    const aNumber = chapterSortNumber(a)
    const bNumber = chapterSortNumber(b)
    if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return aNumber - bNumber
    if (aNumber !== null && bNumber === null) return -1
    if (aNumber === null && bNumber !== null) return 1
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })
  })
}

function stripFrontmatter(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
}

function stripLeadingHeading(content: string): string {
  return content.replace(/^#\s+.+(?:\r?\n){1,2}/, "").trim()
}

function stripChapterPrefix(title: string): string {
  const matched = matchChapterImportFilename(title)
  if (matched) return matched.titleSuffix
  return cleanImportedChapterTitleSuffix(
    title
      .normalize("NFKC")
      .replace(/^第\s*(?:\d+|[零〇一二三四五六七八九十百千万两]+)\s*[章节回]\s*[-_:：，、.。]?\s*/, ""),
  )
}

function cleanImportedChapterTitleSuffix(title: string): string {
  return title
    .replace(/\.(txt|mdx?|docx?|rtf)$/i, "")
    .replace(/^[-_—–\s:：，、.。]+/, "")
    .trim()
}

function titleFromCandidate(candidate: ChapterImportCandidate, chapterNumber: number, body?: string): string {
  const stem = getFileStem(candidate.name).trim()
  const suffix = matchChapterImportFilename(candidate.name)?.titleSuffix || stripChapterPrefix(stem)
  if (suffix) return `第${chapterNumber}章 ${suffix}`
  // 文件名只有「第N章」时，从正文标题里找回章节名（resolveChapterTitle 只升级不降级）
  const fromBody = body ? resolveChapterTitle(body, "") : ""
  if (fromBody && !isBareChapterLabel(fromBody)) return fromBody
  return `第${chapterNumber}章`
}

export function buildImportedChapterMarkdown({
  title,
  chapterNumber,
  body,
  finalForMemoryExtraction,
  fingerprint,
}: {
  title: string
  chapterNumber: number
  body: string
  finalForMemoryExtraction: boolean
  fingerprint?: string
}): string {
  const cleanedBody = stripLeadingHeading(stripFrontmatter(body))
  return [
    "---",
    "type: chapter",
    `title: "${yamlEscape(title)}"`,
    `chapter_number: ${chapterNumber}`,
    `chapter_status: ${finalForMemoryExtraction ? "final" : "draft"}`,
    ...(fingerprint ? [`import_source_fingerprint: ${fingerprint}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    cleanedBody,
    "",
  ].join("\n")
}

function isChapterImportablePath(path: string): boolean {
  const fileName = getFileName(path)
  if (!fileName || fileName.startsWith(".")) return false
  /* v8 ignore next */
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : ""
  return CHAPTER_IMPORT_EXTENSION_SET.has(extension)
}

function collectImportableChapterFiles(nodes: readonly FileNode[]): ChapterImportCandidate[] {
  const files: ChapterImportCandidate[] = []
  for (const node of nodes) {
    if (node.name.startsWith(".")) continue
    if (node.is_dir) {
      if (node.children) files.push(...collectImportableChapterFiles(node.children))
      continue
    }
    if (isChapterImportablePath(node.path)) {
      files.push({ path: node.path, name: node.name })
    }
  }
  return files
}

export async function collectChapterImportCandidatesFromFolder(selectedFolder: string): Promise<ChapterImportCandidate[]> {
  const tree = await listDirectory(normalizePath(selectedFolder))
  return sortChapterImportCandidates(collectImportableChapterFiles(tree))
}

async function findImportByFingerprint(chaptersDir: string, stem: string, fingerprint: string): Promise<string | null> {
  for (let index = 0; index <= 99; index += 1) {
    const candidate = index === 0 ? `${chaptersDir}/${stem}.md` : `${chaptersDir}/${stem}-${index}.md`
    let exists = false
    try {
      exists = await fileExists(candidate)
    } catch {
      continue
    }
    if (!exists) {
      if (index === 0) continue
      return null
    }
    try {
      const existing = await readFile(candidate)
      if (extractImportFingerprint(existing) === fingerprint) return candidate
    } catch {
      continue
    }
  }
  return null
}

async function getUniqueChapterImportPath(chaptersDir: string, chapterNumber: number, title: string): Promise<string> {
  const safeSuffix = makeSafeFileSlug(stripChapterPrefix(title), "")
  const baseName = safeSuffix
    ? `chapter-${String(chapterNumber).padStart(3, "0")}-${safeSuffix}.md`
    : `chapter-${String(chapterNumber).padStart(3, "0")}.md`
  const firstPath = `${chaptersDir}/${baseName}`
  if (!(await fileExists(firstPath))) return firstPath

  const stem = baseName.replace(/\.md$/i, "")
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${chaptersDir}/${stem}-${index}.md`
    if (!(await fileExists(candidate))) return candidate
  }
  return `${chaptersDir}/${stem}-${Date.now()}.md`
}

export async function importChapterFiles(
  projectPath: string,
  sourcePaths: readonly string[],
  options: { finalForMemoryExtraction: boolean },
): Promise<ImportedChapter[]> {
  const candidates = sourcePaths
    .map((path) => ({ path: normalizePath(path), name: getFileName(path) }))
    .filter((candidate) => isChapterImportablePath(candidate.path))
  return importChapterCandidates(projectPath, candidates, options)
}

export async function importChapterFolder(
  projectPath: string,
  selectedFolder: string,
  options: { finalForMemoryExtraction: boolean },
): Promise<ImportedChapter[]> {
  const candidates = await collectChapterImportCandidatesFromFolder(selectedFolder)
  return importChapterCandidates(projectPath, candidates, options)
}

/**
 * 导入即副本幂等（R2：同一源文件内容指纹已落盘则跳过复写）。
 * 以“源路径 + 内容长度 + 首尾切片”做轻量指纹，写入目标 frontmatter 的
 * `import_source_fingerprint`；重入时命中指纹→跳过写盘并复用既有路径。
 * 纯 mechanical 层：零 LLM，仅读/写文件。
 */
export function buildImportFingerprint(sourcePath: string, content: string): string {
  const head = content.slice(0, 512)
  const tail = content.slice(-512)
  let h = 2166136261
  const s = `${sourcePath}
${content.length}
${head}
${tail}`
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, "0")}-${content.length}`
}

/** 从已落盘章节正文提取导入指纹（无则 null）。 */
export function extractImportFingerprint(markdown: string): string | null {
  const m = markdown.match(/^import_source_fingerprint:\s*(.+?)\s*$/m)
  return m ? m[1].trim() : null
}

async function importChapterCandidates(
  projectPath: string,
  candidates: readonly ChapterImportCandidate[],
  options: { finalForMemoryExtraction: boolean },
): Promise<ImportedChapter[]> {
  const pp = normalizePath(projectPath)
  const chaptersDir = `${pp}/wiki/chapters`
  await createDirectory(chaptersDir).catch(() => {})

  const imported: ImportedChapter[] = []
  const sorted = sortChapterImportCandidates(candidates)

  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index]
    const detectedNumber = chapterSortNumber(candidate)
    const chapterNumber = detectedNumber ?? index + 1
    try {
      const content = await readFile(candidate.path)
      // 正文标题可补全文件名缺失的章节名
      const title = titleFromCandidate(candidate, chapterNumber, content)
      const fingerprint = buildImportFingerprint(candidate.path, content)
      // 幂等：同指纹已落盘（任意 -N 后缀变体）→ 复用既有路径，不复写
      const stem = makeSafeFileSlug(stripChapterPrefix(title), "")
        ? `chapter-${String(chapterNumber).padStart(3, "0")}-${makeSafeFileSlug(stripChapterPrefix(title), "")}`
        : `chapter-${String(chapterNumber).padStart(3, "0")}`
      const hitPath = await findImportByFingerprint(chaptersDir, stem, fingerprint)
      if (hitPath) {
        imported.push({ sourcePath: candidate.path, path: hitPath, title, chapterNumber })
        continue
      }
      const targetPath = await getUniqueChapterImportPath(chaptersDir, chapterNumber, title)
      await writeFile(targetPath, buildImportedChapterMarkdown({
        title,
        chapterNumber,
        body: content,
        finalForMemoryExtraction: options.finalForMemoryExtraction,
        fingerprint,
      }))
      imported.push({ sourcePath: candidate.path, path: targetPath, title, chapterNumber })
    } catch (error) {
      logger.error("Chapter Import", "failed to import chapter file", { path: candidate.path, error: toErrorMessage(error) })
    }
  }

  return imported
}

async function collectExistingChapterNumbers(chaptersDir: string): Promise<{ usedNumbers: Set<number>; maxExisting: number }> {
  const usedNumbers = new Set<number>()
  let files: Array<{ name: string; path: string }> = []
  try {
    const tree = await listDirectory(chaptersDir)
    files = flattenMdFilesBase(tree)
  } catch (err) {
    logger.warn("Chapter Import", "list existing chapters dir skipped (non-fatal)", {
      chaptersDir,
      error: toErrorMessage(err),
    })
    return { usedNumbers, maxExisting: 0 }
  }

  await Promise.all(
    files.map(async (file) => {
      let num: number | null = null
      try {
        const raw = await readFile(file.path)
        const fm = parseFrontmatter(raw.replace(/^\uFEFF/, "")).frontmatter
        num = fm ? parseChapterNumber(fm.chapter_number) : null
      } catch (err) {
        logger.warn("Chapter Import", "read existing chapter for conflict check failed (non-fatal)", {
          path: file.path,
          error: toErrorMessage(err),
        })
      }
      if (num === null) {
        num = extractImportedChapterNumber(file.name)
      }
      if (num !== null && Number.isSafeInteger(num) && num >= 1) {
        usedNumbers.add(num)
      }
    }),
  )

  let maxExisting = 0
  for (const n of usedNumbers) {
    if (n > maxExisting) maxExisting = n
  }
  return { usedNumbers, maxExisting }
}

/**
 * 整本 TXT 拆章预览（P1-03：纯读零写，绝不触碰 book-analysis/library.json）。
 */
export async function previewWholeTxtChapters(
  sourcePath: string,
  options?: { rawText?: string },
): Promise<WholeTxtPreviewResult> {
  const raw = options?.rawText !== undefined ? options.rawText : await readFile(sourcePath)
  const chapters = splitNovelTextToChapters(raw)
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0)
  const warnings: string[] = []

  if (chapters.length === 0) {
    warnings.push("未识别到章节标题，请确认文件包含行首「第X章」或「Chapter X」等章节标记")
    return { chapters, totalWords, warnings }
  }

  const seenNumbers = new Map<number, number>()
  const duplicates = new Set<number>()
  let missingNumberCount = 0
  for (const ch of chapters) {
    if (ch.detectedChapterNumber === null) {
      missingNumberCount += 1
      continue
    }
    const count = (seenNumbers.get(ch.detectedChapterNumber) ?? 0) + 1
    seenNumbers.set(ch.detectedChapterNumber, count)
    if (count > 1) duplicates.add(ch.detectedChapterNumber)
  }

  if (duplicates.size > 0) {
    const sortedDups = [...duplicates].sort((a, b) => a - b)
    warnings.push(`检测到重复章号（第 ${sortedDups.join("、")} 章），导入时将按策略自动规避冲突`)
  }
  if (missingNumberCount > 0) {
    warnings.push(`有 ${missingNumberCount} 个章节未能解析出数字章号，导入时将按顺序自动编号`)
  }

  return { chapters, totalWords, warnings }
}

/**
 * 整本 TXT 拆章导入到 `wiki/chapters/`（P1-03）。
 *
 * - 默认 `conflictStrategy: "auto-offset"`：与既有章号冲突时自动顺延至 `maxExisting + 1` 起，
 *   绝不覆写既有章节，也绝不制造 `duplicateChapters`。
 * - 全部新章节经 `writeFileAtomic` 原子落盘，附规范 frontmatter 与 `import_source_fingerprint`。
 * - 严守 Draft-first：本函数只落盘章节文件，**绝不自动调用 `ingestChapter`**。
 */
export async function importWholeTxtNovel(
  projectPath: string,
  sourcePath: string,
  options: WholeTxtChapterImportOptions = {},
): Promise<WholeTxtChapterImportResult> {
  const pp = normalizePath(projectPath)
  const normSource = normalizePath(sourcePath)
  const chaptersDir = `${pp}/wiki/chapters`
  const finalForMemoryExtraction = options.finalForMemoryExtraction ?? false
  const conflictStrategy = options.conflictStrategy ?? "auto-offset"
  const raw = options.rawText !== undefined ? options.rawText : await readFile(sourcePath)
  const splitChapters = splitNovelTextToChapters(raw)
  const detectedCount = splitChapters.length
  const warnings: string[] = []

  if (detectedCount === 0) {
    return {
      imported: [],
      detectedCount: 0,
      skippedCount: 0,
      remappedCount: 0,
      warnings: ["未识别到可导入的章节标题"],
    }
  }

  try {
    await createDirectory(chaptersDir)
  } catch (err) {
    logger.warn("Chapter Import", "create chapters directory failed (continuing)", {
      chaptersDir,
      error: toErrorMessage(err),
    })
  }

  const { usedNumbers, maxExisting } = await collectExistingChapterNumbers(chaptersDir)
  const allocatedNumbers = new Set<number>(usedNumbers)
  const explicitStart =
    typeof options.startChapterNumber === "number" &&
    Number.isInteger(options.startChapterNumber) &&
    options.startChapterNumber >= 1
      ? options.startChapterNumber
      : null

  let appendCursor = Math.max(maxExisting + 1, explicitStart ?? 1)
  const allocateNextFree = (): number => {
    while (allocatedNumbers.has(appendCursor)) {
      appendCursor += 1
    }
    const picked = appendCursor
    appendCursor += 1
    return picked
  }

  const imported: ImportedChapter[] = []
  let skippedCount = 0
  let remappedCount = 0
  let completed = 0

  for (let i = 0; i < splitChapters.length; i += 1) {
    if (options.signal?.aborted) {
      warnings.push("整本导入已取消")
      break
    }

    const ch = splitChapters[i]!
    const preferredNumber =
      explicitStart !== null
        ? explicitStart + i
        : (ch.detectedChapterNumber ?? i + 1)

    let targetNumber: number
    if (conflictStrategy === "append-after-max") {
      targetNumber = allocateNextFree()
      if (ch.detectedChapterNumber === null || targetNumber !== ch.detectedChapterNumber) {
        remappedCount += 1
      }
    } else if (conflictStrategy === "keep-detected") {
      if (allocatedNumbers.has(preferredNumber)) {
        skippedCount += 1
        completed += 1
        warnings.push(`跳过冲突章号第 ${preferredNumber} 章（${ch.title}）`)
        options.onProgress?.(completed, detectedCount)
        continue
      }
      targetNumber = preferredNumber
    } else {
      // 默认 "auto-offset"：无冲突沿用 preferredNumber；有冲突顺延至 maxExisting + 1 起空闲位
      if (allocatedNumbers.has(preferredNumber)) {
        targetNumber = allocateNextFree()
        remappedCount += 1
      } else {
        targetNumber = preferredNumber
      }
    }

    const titleSuffix = stripChapterPrefix(ch.title)
    const normalizedTitle = titleSuffix ? `第${targetNumber}章 ${titleSuffix}` : `第${targetNumber}章`
    const fingerprint = buildImportFingerprint(`${normSource}#order-${ch.order}`, ch.body)

    try {
      const targetPath = await getUniqueChapterImportPath(chaptersDir, targetNumber, normalizedTitle)
      await writeFileAtomic(
        targetPath,
        buildImportedChapterMarkdown({
          title: normalizedTitle,
          chapterNumber: targetNumber,
          body: ch.body,
          finalForMemoryExtraction,
          fingerprint,
        }),
      )
      allocatedNumbers.add(targetNumber)
      if (targetNumber >= appendCursor) {
        appendCursor = targetNumber + 1
      }
      imported.push({
        sourcePath: normSource,
        path: targetPath,
        title: normalizedTitle,
        chapterNumber: targetNumber,
      })
    } catch (error) {
      skippedCount += 1
      warnings.push(`第 ${targetNumber} 章（${ch.title}）写入失败：${toErrorMessage(error)}`)
      logger.error("Chapter Import", "failed to import split chapter", {
        sourcePath: normSource,
        chapterNumber: targetNumber,
        error: toErrorMessage(error),
      })
    }

    completed += 1
    options.onProgress?.(completed, detectedCount)
  }

  if (remappedCount > 0) {
    warnings.push(`已自动重排 ${remappedCount} 个章节编号，避免与既有章节冲突`)
  }

  if (imported.length > 0) {
    invalidateChapterCache(projectPath)
  }

  return {
    imported,
    detectedCount,
    skippedCount,
    remappedCount,
    warnings,
  }
}

export async function runImportedChapterMemoryExtraction({
  projectPath,
  chapterPaths,
  signal,
  reviewModel,
  ingestChapter,
  onProgress,
}: {
  projectPath: string
  chapterPaths: readonly string[]
  signal?: AbortSignal
  reviewModel?: string
  ingestChapter: IngestChapterDependency
  onProgress?: (progress: ImportedChapterMemoryProgress) => void
}): Promise<ImportedChapterMemoryResult> {
  const errors: string[] = []
  let completed = 0
  let pending = 0
  let partial = 0
  let failed = 0

  for (const chapterPath of chapterPaths) {
    if (signal?.aborted) {
      return { completed, pending, partial, failed, cancelled: true, errors }
    }
    onProgress?.({ completed, total: chapterPaths.length, currentPath: chapterPath })
    try {
      const result = await ingestChapter(projectPath, chapterPath, reviewModel, signal, {
        canonDualWriteDeps: defaultCanonDualWriteDeps(),
      })
      if (signal?.aborted && result.failReason === "cancelled") break
      const memory = await readBackMemoryIngest(projectPath, chapterPath, result)
      if (memory.ingest === "ok") {
        completed += 1
      } else if (memory.ingest === "pending") {
        pending += 1
      } else if (memory.ingest === "partial") {
        partial += 1
      } else {
        failed += 1
        const reason = result.snapshot
          ? formatMemoryIngest(i18n.t.bind(i18n), memory)
          : result.failReason ?? "提取失败"
        errors.push(`${getFileName(chapterPath)}：${reason}`)
      }
    } catch (error) {
      failed += 1
      errors.push(`${getFileName(chapterPath)}：${toErrorMessage(error)}`)
    }
  }

  return { completed, pending, partial, failed, cancelled: Boolean(signal?.aborted), errors }
}
