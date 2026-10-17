import { createDirectory, fileExists, listDirectory, readFile, writeFile } from "@/commands/fs"
import { getFileName, getFileStem, normalizePath } from "@/lib/path-utils"
import { logger } from "@/lib/utils"
import { makeSafeFileSlug, yamlEscape } from "@/lib/wiki-filename"
import { defaultCanonDualWriteDeps } from "./canon-dual-write"
import type { IngestChapterOptions } from "./chapter-ingest"
import { isBareChapterLabel, resolveChapterTitle } from "./chapter-typography"
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
  failed: number
  cancelled: boolean
  errors: string[]
}

type IngestChapterDependency = (
  projectPath: string,
  chapterPath: string,
  reviewModel?: string,
  signal?: AbortSignal,
  options?: IngestChapterOptions,
) => Promise<{ snapshot: unknown | null; failReason?: string }>

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
      logger.error("Chapter Import", "failed to import chapter file", { path: candidate.path, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return imported
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
  let failed = 0

  for (const chapterPath of chapterPaths) {
    if (signal?.aborted) {
      return { completed, failed, cancelled: true, errors }
    }
    onProgress?.({ completed, total: chapterPaths.length, currentPath: chapterPath })
    try {
      const result = await ingestChapter(projectPath, chapterPath, reviewModel, undefined, {
        canonDualWriteDeps: defaultCanonDualWriteDeps(),
      })
      if (result.snapshot) {
        completed += 1
      } else {
        failed += 1
        errors.push(`${getFileName(chapterPath)}：${result.failReason ?? "提取失败"}`)
      }
    } catch (error) {
      failed += 1
      errors.push(`${getFileName(chapterPath)}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { completed, failed, cancelled: Boolean(signal?.aborted), errors }
}
