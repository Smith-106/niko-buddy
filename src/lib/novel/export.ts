/**
 * Novel 项目导出模块。
 * MIT licensed implementation.
 *
 * 将项目章节、快照、元数据导出到指定目录。
 */

import { readFile, writeFile, writeFileAtomic, listDirectory, createDirectory } from "@/commands/fs"
import { invoke } from "@tauri-apps/api/core"
import { normalizePath } from "@/lib/path-utils"
import { exportPdf, validateExportTarget } from "@/lib/export/pdf-client"
import { extractChapterNumber, flattenMdFilesBase } from "./chapter-utils"
import { parseChapterNumber } from "./chapter-meta"
import { parseFrontmatter } from "@/lib/frontmatter"
import { listSnapshots, loadSnapshot } from "./chapter-ingest"
import { loadCharacterStates } from "./character-state"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { loadCognitionState } from "./character-cognition"
import { buildInteractiveExport, type InteractiveStoryGraph } from "./interactive-film-graph"
import { logger, toErrorMessage } from "@/lib/utils"

/** 书稿导出范围与草稿包含配置（P1-04）。 */
export interface ManuscriptExportScope {
  mode?: "all" | "range"
  startChapter?: number | null
  endChapter?: number | null
  /** 默认 false（仅 final）；true 时包含非终稿章并标 【草稿】，绝不含 archived */
  includeDrafts?: boolean
}

/** 可导出章节统计快照（P1-04，供 ExportCenterView 展示与 PdfExportDialog 消费）。 */
export interface ExportableChaptersInspection {
  finalCount: number
  draftCount: number
  minChapter: number | null
  maxChapter: number | null
  totalWords: number
  /** path 为项目相对路径（如 "wiki/chapters/..."），兼容 PdfExportDialog */
  finalChapters: ReadonlyArray<{ chapterNumber: number; title: string; path: string }>
}

/** 书稿导出统一结果（TXT / PDF）。 */
export interface ManuscriptExportOutcome {
  success: boolean
  exportedPath: string
  chapterCount: number
  draftCount: number
  message: string
}

/** 纯文本 TXT 导出选项。 */
export interface TxtExportOptions extends ManuscriptExportScope {
  projectPath: string
  exportPath: string
  scope?: ManuscriptExportScope
  /** 默认 true（中文出版习惯：段首全角空格 \u3000\u3000） */
  firstLineIndent?: boolean
  /** 默认 true（写入 UTF-8 BOM \uFEFF，兼容 Windows 记事本） */
  includeBom?: boolean
}

/** 书稿 PDF 导出选项。 */
export interface PdfManuscriptExportOptions extends ManuscriptExportScope {
  projectPath: string
  exportPath: string
  scope?: ManuscriptExportScope
  title?: string
  author?: string
}

export interface InteractiveExportOptions {
  projectPath: string
  exportPath: string
  graph: InteractiveStoryGraph
}

/**
 * 64 号实施接线（P0-1 互动影游落盘）：把图导出为 `.ink` + 单文件 HTML。
 * 诊断 error 级（missing_start/dangling_edge/empty_choice）→ 不写脏文件；
 * warn 级（cycle_warn）仍写出（ink 允许 divert 回跳）。
 */
export async function exportInteractiveStory(
  options: InteractiveExportOptions,
): Promise<ExportResult> {
  const { exportPath, graph } = options
  const result = buildInteractiveExport(graph)
  const blocking = result.diagnostics.filter((d) =>
    d.code === "missing_start" || d.code === "dangling_edge" || d.code === "empty_choice",
  )
  if (blocking.length > 0) {
    return {
      success: false,
      exportedPath: exportPath,
      chapterCount: 0,
      message: `互动影游导出被诊断拦截：${blocking.map((b) => b.message).join("; ")}`,
    }
  }
  try {
    await createDirectory(exportPath)
    await writeFile(`${exportPath}/interactive.ink`, result.ink)
    await writeFile(`${exportPath}/interactive.html`, result.html)
    return {
      success: true,
      exportedPath: exportPath,
      chapterCount: graph.nodes.length,
      message: `互动影游已导出（${graph.nodes.length} 节点）`,
    }
  } catch (err) {
    return {
      success: false,
      exportedPath: exportPath,
      chapterCount: 0,
      message: `互动影游导出失败：${toErrorMessage(err)}`,
    }
  }
}

/**
 * 导出配置选项。
 * MIT licensed implementation.
 */
export interface ExportOptions extends ManuscriptExportScope {
  projectPath: string
  exportPath: string
  scope?: ManuscriptExportScope
  includeChapters?: boolean
  includeSnapshots?: boolean
  includeMeta?: boolean
}

/**
 * 导出结果。
 * MIT licensed implementation.
 */
export interface ExportResult {
  success: boolean
  exportedPath: string
  chapterCount: number
  message: string
}

interface ResolvedExportScope {
  mode: "all" | "range"
  startChapter: number | null
  endChapter: number | null
  includeDrafts: boolean
}

interface ScopedChapterItem {
  chapterNumber: number | null
  sortNum: number
  fileName: string
  relativePath: string
  baseTitle: string
  exportTitle: string
  body: string
  isFinal: boolean
  wordCount: number
}

function normalizePositiveBound(value?: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const floored = Math.floor(value)
  return floored >= 1 ? floored : null
}

function resolveExportScope(
  options?: (ManuscriptExportScope & { scope?: ManuscriptExportScope }) | undefined,
): ResolvedExportScope {
  const nested = options?.scope
  const startChapter = normalizePositiveBound(nested?.startChapter ?? options?.startChapter)
  const endChapter = normalizePositiveBound(nested?.endChapter ?? options?.endChapter)
  const explicitMode = nested?.mode ?? options?.mode
  const mode: "all" | "range" =
    explicitMode ?? (startChapter !== null || endChapter !== null ? "range" : "all")
  const includeDrafts = Boolean(nested?.includeDrafts ?? options?.includeDrafts ?? false)
  return { mode, startChapter, endChapter, includeDrafts }
}

/**
 * 纯函数：安全剥离 Markdown 标记生成纯文本（P1-04）。
 * 保留中文段落、标点与对话引号，移除标题井号、粗斜体、行内代码、链接语法、引用符与分割线。
 */
export function stripMarkdownForPlainText(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  if (!normalized.trim()) return ""

  const lines = normalized.split("\n")
  const cleanedLines: string[] = []
  let inFence = false

  for (const rawLine of lines) {
    if (/^[ \t]*```/.test(rawLine)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      cleanedLines.push(rawLine.trimEnd())
      continue
    }
    // 跳过纯分割线（--- / *** / ___）
    if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(rawLine)) {
      cleanedLines.push("")
      continue
    }
    let line = rawLine
      // 剥离引用前缀（含嵌套 >>）
      .replace(/^[ \t]*(?:>[ \t]?)+/, "")
      // 剥离 ATX 标题前缀
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "")
      // 剥离无序列表前缀
      .replace(/^[ \t]*[-*+][ \t]+/, "")
      // 图片 ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 链接 [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // 行内代码 `code` → code
      .replace(/`([^`]+)`/g, "$1")
      // 粗斜体 / 粗体 / 删除线
      .replace(/\*\*\*([\s\S]+?)\*\*\*/g, "$1")
      .replace(/\*\*([\s\S]+?)\*\*\*/g, "$1")
      .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
      .replace(/___([\s\S]+?)___/g, "$1")
      .replace(/__([\s\S]+?)__/g, "$1")
      .replace(/~~([\s\S]+?)~~/g, "$1")
      // 单星斜体
      .replace(/\*([^*\n]+)\*/g, "$1")
      // 单下划线斜体（仅在空白或行首尾边界处剥离，保护 foo_bar 标识符）
      .replace(/(^|[\s（(【\[「『“‘])_([^_\n]+)_(?=$|[\s，。！？；：、）)】\]」』”’.,!?;:])/g, "$1$2")
      .trim()

    cleanedLines.push(line)
  }

  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function chapterInExportRange(
  chapterNumber: number | null,
  scope: ResolvedExportScope,
): boolean {
  if (scope.mode !== "range") return true
  if (
    scope.startChapter !== null &&
    scope.endChapter !== null &&
    scope.startChapter > scope.endChapter
  ) {
    return false
  }
  if (chapterNumber === null) return false
  if (scope.startChapter !== null && chapterNumber < scope.startChapter) return false
  if (scope.endChapter !== null && chapterNumber > scope.endChapter) return false
  return true
}

/**
 * 统一章节扫描与数值排序加载器（修复 export.ts:133 与 L301 两处 chapter_number 字符串排序 Bug）。
 *
 * - 兼容数字与字符串型 `chapter_number`（经 `parseChapterNumber`），缺省回退文件名解析；
 * - 绝不含 `archived` 章节；
 * - 按数值升序（1 < 2 < 10）排序，无章号章节按文件名自然序排在末尾。
 */
async function loadAllNonArchivedChapters(projectPath: string): Promise<ScopedChapterItem[]> {
  const pp = normalizePath(projectPath)
  const rootPrefix = `${pp.replace(/\/+$/, "")}/`
  const chaptersDir = `${pp}/wiki/chapters`
  let files: { name: string; path: string }[] = []
  try {
    const tree = await listDirectory(chaptersDir)
    files = flattenMdFilesBase(tree)
  } catch (err) {
    logger.warn("Export", "list chapters directory failed (degraded to empty)", {
      chaptersDir,
      error: toErrorMessage(err),
    })
    files = []
  }

  // 并行 readFile + parseFrontmatter（Promise.all 并发读取）；最终按数值章号排序，
  // 输出顺序确定性不因并行完成顺序改变。
  const loaded = await Promise.all(
    files.map(async (file): Promise<ScopedChapterItem | null> => {
      try {
        const raw = await readFile(file.path)
        const parsed = parseFrontmatter(raw)
        const fm = parsed.frontmatter as Record<string, unknown> | null
        const statusRaw = typeof fm?.chapter_status === "string" ? fm.chapter_status.trim() : undefined
        // 绝不导出 archived 章节
        if (statusRaw === "archived") return null
        const isFinal = !statusRaw || statusRaw === "final"
        const fmNum = parseChapterNumber(fm?.chapter_number)
        const chapterNumber = fmNum ?? extractChapterNumber(file.name)
        const sortNum = chapterNumber ?? Number.POSITIVE_INFINITY
        const baseTitle =
          typeof fm?.title === "string" && fm.title.trim().length > 0
            ? fm.title.trim()
            : file.name.replace(/\.md$/i, "")
        const exportTitle = isFinal
          ? baseTitle
          : (baseTitle.startsWith("【草稿】") ? baseTitle : `【草稿】${baseTitle}`)
        const body = parsed.body.trim()
        const normPath = normalizePath(file.path)
        const relativePath = normPath.startsWith(rootPrefix)
          ? normPath.slice(rootPrefix.length)
          : normPath
        const wordCount = stripMarkdownForPlainText(body).replace(/\s+/g, "").length
        return {
          chapterNumber,
          sortNum,
          fileName: file.name,
          relativePath,
          baseTitle,
          exportTitle,
          body,
          isFinal,
          wordCount,
        }
      } catch (err) {
        logger.warn("Export", "skip unreadable chapter file during export scan", {
          path: file.path,
          error: toErrorMessage(err),
        })
        return null
      }
    }),
  )

  const chapters = loaded.filter((entry): entry is ScopedChapterItem => entry !== null)
  chapters.sort((a, b) => {
    if (a.sortNum !== b.sortNum) return a.sortNum - b.sortNum
    return a.fileName.localeCompare(b.fileName, "zh-Hans-CN", { numeric: true })
  })
  return chapters
}

async function loadScopedChapters(
  projectPath: string,
  scope?: ManuscriptExportScope,
): Promise<ScopedChapterItem[]> {
  const resolved = resolveExportScope(scope)
  if (
    resolved.mode === "range" &&
    resolved.startChapter !== null &&
    resolved.endChapter !== null &&
    resolved.startChapter > resolved.endChapter
  ) {
    return []
  }
  const all = await loadAllNonArchivedChapters(projectPath)
  return all.filter((ch) => {
    if (!ch.isFinal && !resolved.includeDrafts) return false
    return chapterInExportRange(ch.chapterNumber, resolved)
  })
}

/**
 * 一次扫描返回可导出章节统计（P1-04：供 ExportCenterView 展示与 PdfExportDialog 消费）。
 * `finalChapters[].path` 为项目相对路径（如 `"wiki/chapters/..."`）。
 */
export async function inspectExportableChapters(
  projectPath: string,
  scope?: ManuscriptExportScope,
): Promise<ExportableChaptersInspection> {
  try {
    const resolved = resolveExportScope(scope)
    if (
      resolved.mode === "range" &&
      resolved.startChapter !== null &&
      resolved.endChapter !== null &&
      resolved.startChapter > resolved.endChapter
    ) {
      return {
        finalCount: 0,
        draftCount: 0,
        minChapter: null,
        maxChapter: null,
        totalWords: 0,
        finalChapters: [],
      }
    }
    const all = await loadAllNonArchivedChapters(projectPath)
    const inRange = all.filter((ch) => chapterInExportRange(ch.chapterNumber, resolved))
    const finalList = inRange.filter((ch) => ch.isFinal)
    const draftList = inRange.filter((ch) => !ch.isFinal)
    const activeList = resolved.includeDrafts ? inRange : finalList
    const totalWords = activeList.reduce((sum, ch) => sum + ch.wordCount, 0)
    const rangeBasis = activeList.length > 0 ? activeList : inRange
    const validNumbers = rangeBasis
      .map((ch) => ch.chapterNumber)
      .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0)
    const minChapter = validNumbers.length > 0 ? Math.min(...validNumbers) : null
    const maxChapter = validNumbers.length > 0 ? Math.max(...validNumbers) : null
    return {
      finalCount: finalList.length,
      draftCount: draftList.length,
      minChapter,
      maxChapter,
      totalWords,
      finalChapters: finalList.map((ch) => ({
        chapterNumber: ch.chapterNumber ?? 0,
        title: ch.baseTitle,
        path: ch.relativePath,
      })),
    }
  } catch (err) {
    logger.warn("Export", "inspect exportable chapters failed (degraded to empty)", {
      projectPath,
      error: toErrorMessage(err),
    })
    return {
      finalCount: 0,
      draftCount: 0,
      minChapter: null,
      maxChapter: null,
      totalWords: 0,
      finalChapters: [],
    }
  }
}

/**
 * 导出整个 Novel 项目。
 * MIT licensed implementation.
 *
 * @param options - 导出配置选项
 * @returns 导出结果
 */
export async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const pp = normalizePath(options.projectPath)
  const {
    exportPath,
    includeChapters = true,
    includeSnapshots = true,
    includeMeta = true,
  } = options

  try {
    await createDirectory(exportPath)
    let chapterCount = 0

    if (includeChapters) {
      const chapters = await loadScopedChapters(pp, resolveExportScope(options))
      chapterCount = chapters.length
      const mergedContent = chapters
        .map((c) => `# ${c.exportTitle}\n\n${c.body}`)
        .join("\n\n---\n\n")
      await writeFile(`${exportPath}/complete-novel.md`, mergedContent)
    }

    if (includeSnapshots) {
      const snapshotsDir = `${exportPath}/snapshots`
      await createDirectory(snapshotsDir)
      try {
        const nums = await listSnapshots(pp)
        // 并行 loadSnapshot（Promise.all 保序）；按 num 依序写盘（padStart 文件名），
        // 输出顺序确定性不因并行完成顺序改变。
        const loaded = await Promise.all(
          nums.map(async (num) => {
            const snap = await loadSnapshot(pp, num)
            return { num, snap }
          }),
        )
        // PAT-IM1（ISS-20260709-024）：各快照写入不同文件，彼此独立 → 并行落盘。
        // 文件名由 num 决定，输出布局与写入完成顺序无关。
        await Promise.all(
          loaded.map(async ({ num, snap }) => {
            if (!snap) return
            await writeFile(
              `${snapshotsDir}/${String(num).padStart(3, "0")}.snapshot.json`,
              JSON.stringify(snap, null, 2),
            )
          }),
        )
      } catch (err) {
        logger.warn("Export", "export snapshots skipped (optional)", {
          error: toErrorMessage(err),
        })
      }
    }

    if (includeMeta) {
      const metaDir = `${exportPath}/meta`
      await createDirectory(metaDir)

      try {
        const chars = await loadCharacterStates(pp)
        await writeFile(`${metaDir}/character-states.json`, JSON.stringify(chars, null, 2))
      } catch (err) {
        logger.warn("Export", "export character-states skipped (optional)", {
          error: toErrorMessage(err),
        })
      }

      try {
        const foreshadows = await loadForeshadowingTracker(pp)
        await writeFile(`${metaDir}/foreshadowing-tracker.json`, JSON.stringify(foreshadows, null, 2))
      } catch (err) {
        logger.warn("Export", "export foreshadowing-tracker skipped (optional)", {
          error: toErrorMessage(err),
        })
      }

      try {
        const cognition = await loadCognitionState(pp)
        if (cognition) {
          await writeFile(`${metaDir}/cognition-state.json`, JSON.stringify(cognition, null, 2))
        }
      } catch (err) {
        logger.warn("Export", "export cognition-state skipped (optional)", {
          error: toErrorMessage(err),
        })
      }
    }

    return {
      success: true,
      exportedPath: exportPath,
      chapterCount,
      message: `导出完成：${chapterCount} 个章节`,
    }
  } catch (error) {
    const message = toErrorMessage(error)
    return { success: false, exportedPath: exportPath, chapterCount: 0, message }
  }
}

/**
 * DOCX 导出配置选项。
 * MIT licensed implementation.
 */
export interface DocxExportOptions extends ManuscriptExportScope {
  projectPath: string
  exportPath: string
  scope?: ManuscriptExportScope
}

/**
 * DOCX 导出结果。
 * MIT licensed implementation.
 */
export interface DocxExportResult {
  success: boolean
  exportedPath: string
  chapterCount: number
  message: string
}

/**
 * EPUB 书籍元数据（可选；缺省 title="Niko Buddy 导出"/language=zh-CN/identifier=新UUID）。
 */
export interface EbookExportMeta {
  title?: string
  author?: string
  language?: string
  identifier?: string
}

/**
 * EPUB 导出选项（54 号设计 ⑥）：与 DOCX 同形，复用章节加载逻辑。
 */
export interface EbookExportOptions extends ManuscriptExportScope {
  projectPath: string
  exportPath: string
  meta?: EbookExportMeta
  scope?: ManuscriptExportScope
}

/**
 * EPUB 导出结果（与 DocxExportResult 同形；别名保持旧导出类型不回归）。
 * MIT licensed implementation.
 */
export type EbookExportResult = DocxExportResult

/**
 * Load final-status chapters (wiki/chapters, `chapter_status: final`) ordered by
 * numeric chapter number. Shared by the Markdown/DOCX/EPUB/TXT/PDF exporters and
 * settings counter.
 */
async function loadFinalChapters(
  projectPath: string,
  scope?: ManuscriptExportScope,
): Promise<{ num: number; title: string; body: string; isFinal: boolean }[]> {
  const chapters = await loadScopedChapters(projectPath, scope)
  return chapters.map((ch) => ({
    num: ch.chapterNumber ?? 0,
    title: ch.exportTitle,
    body: ch.body,
    isFinal: ch.isFinal,
  }))
}

/**
 * Count final-status chapters in a novel project (0 when the project has
 * no chapters or the chapters directory is missing). Settings uses this to
 * disable the DOCX export button with an empty-state hint.
 */
export async function countFinalChapters(projectPath: string): Promise<number> {
  try {
    const chapters = await loadFinalChapters(projectPath)
    return chapters.length
  } catch (err) {
    logger.warn("Export", "count final chapters failed (degraded to 0)", {
      projectPath,
      error: toErrorMessage(err),
    })
    return 0
  }
}

/**
 * 将项目章节按范围导出为单个纯文本 `.txt` 文件（P1-04）。
 * 默认段首缩进 `\u3000\u3000` 并带 UTF-8 BOM（兼容 Windows 记事本）；经 `writeFileAtomic` 原子落盘。
 * 守 Draft-first：只读章节文件，不写回任何正式层或记忆。
 */
export async function exportNovelTxt(
  options: TxtExportOptions,
): Promise<ManuscriptExportOutcome> {
  const pp = normalizePath(options.projectPath)
  const { exportPath } = options
  const firstLineIndent = options.firstLineIndent ?? true
  const includeBom = options.includeBom ?? true

  try {
    const chapters = await loadScopedChapters(pp, resolveExportScope(options))
    if (chapters.length === 0) {
      return {
        success: false,
        exportedPath: exportPath,
        chapterCount: 0,
        draftCount: 0,
        message: "当前范围内没有可导出的章节",
      }
    }

    const blocks = chapters.map((ch) => {
      const plain = stripMarkdownForPlainText(ch.body)
      const paragraphs = plain
        .split(/\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => (firstLineIndent && !p.startsWith("\u3000") ? `\u3000\u3000${p}` : p))
      return paragraphs.length > 0 ? `${ch.exportTitle}\n\n${paragraphs.join("\n\n")}` : ch.exportTitle
    })

    const content = `${includeBom ? "\uFEFF" : ""}${blocks.join("\n\n\n")}\n`
    const normalizedOut = normalizePath(exportPath)
    const lastSlash = normalizedOut.lastIndexOf("/")
    if (lastSlash > 0) {
      await createDirectory(normalizedOut.slice(0, lastSlash))
    }
    await writeFileAtomic(exportPath, content)

    const draftCount = chapters.filter((ch) => !ch.isFinal).length
    return {
      success: true,
      exportedPath: exportPath,
      chapterCount: chapters.length,
      draftCount,
      message:
        draftCount > 0
          ? `TXT 导出完成：${chapters.length} 章（含 ${draftCount} 章草稿）`
          : `TXT 导出完成：${chapters.length} 章`,
    }
  } catch (error) {
    return {
      success: false,
      exportedPath: exportPath,
      chapterCount: 0,
      draftCount: 0,
      message: toErrorMessage(error),
    }
  }
}

/**
 * 将项目章节按范围导出为单个 `.pdf` 文件（P1-04）。
 * 复用既有 `@/lib/export/pdf-client`（`validateExportTarget` + `exportPdf`，零新增 Rust 命令）。
 * 守 Draft-first：只读章节文件，不写回任何正式层或记忆。
 */
export async function exportNovelPdf(
  options: PdfManuscriptExportOptions,
): Promise<ManuscriptExportOutcome> {
  const pp = normalizePath(options.projectPath)
  const { exportPath } = options

  try {
    const targetIssue = validateExportTarget(exportPath, pp)
    if (targetIssue !== null) {
      return {
        success: false,
        exportedPath: exportPath,
        chapterCount: 0,
        draftCount: 0,
        message: `PDF 导出目标路径不可用（${targetIssue}）`,
      }
    }

    const chapters = await loadScopedChapters(pp, resolveExportScope(options))
    if (chapters.length === 0) {
      return {
        success: false,
        exportedPath: exportPath,
        chapterCount: 0,
        draftCount: 0,
        message: "当前范围内没有可导出的章节",
      }
    }

    const bookTitle = options.title?.trim() || "小说书稿"
    const paragraphs: string[] = []
    if (options.author?.trim()) {
      paragraphs.push(`作者：${options.author.trim()}`)
    }
    for (const ch of chapters) {
      paragraphs.push(ch.exportTitle)
      const plain = stripMarkdownForPlainText(ch.body)
      for (const line of plain.split(/\n+/)) {
        const trimmed = line.trim()
        if (trimmed.length > 0) paragraphs.push(trimmed)
      }
    }

    const report = await exportPdf(pp, exportPath, bookTitle, paragraphs)
    const draftCount = chapters.filter((ch) => !ch.isFinal).length
    return {
      success: true,
      exportedPath: report.target || exportPath,
      chapterCount: chapters.length,
      draftCount,
      message:
        draftCount > 0
          ? `PDF 导出完成：${chapters.length} 章（含 ${draftCount} 章草稿），共 ${report.pages} 页`
          : `PDF 导出完成：${chapters.length} 章，共 ${report.pages} 页`,
    }
  } catch (error) {
    return {
      success: false,
      exportedPath: exportPath,
      chapterCount: 0,
      draftCount: 0,
      message: toErrorMessage(error),
    }
  }
}

/**
 * 将项目章节导出为单个 .docx 文件（Word 可打开）。
 *
 * 复用统一章节加载器（支持可选范围与含草稿标注），通过 Rust 端 `export_novel_docx` 命令
 * 生成 OOXML 并写盘。标题映射为 Heading1，正文按空行分段。
 *
 * 守 Draft-first：导出只读正式层，不写回任何内容。
 */
export async function exportNovelDocx(options: DocxExportOptions): Promise<DocxExportResult> {
  const pp = normalizePath(options.projectPath)
  const { exportPath } = options

  try {
    const chapters = await loadFinalChapters(pp, resolveExportScope(options))

    const result = await invoke<DocxExportResult>("export_novel_docx", {
      chapters: chapters.map((c) => ({ title: c.title, body: c.body })),
      exportPath,
    })
    return {
      success: result.success,
      exportedPath: result.exportedPath,
      chapterCount: result.chapterCount,
      message: result.message,
    }
  } catch (error) {
    const message = toErrorMessage(error)
    return { success: false, exportedPath: exportPath, chapterCount: 0, message }
  }
}

/**
 * 将项目章节导出为单个 .epub 文件（EPUB3 最小合规）。
 *
 * 复用统一章节加载器（支持可选范围与含草稿标注），通过 Rust 端 `export_novel_epub` 命令
 * 生成 EPUB3。严格只向 Rust 传入 `["chapters", "exportPath", "meta"]` 三键，绝不透传 scope。
 *
 * 守 Draft-first：导出只读正式层，不写回任何内容。
 */
export async function exportNovelEpub(options: EbookExportOptions): Promise<EbookExportResult> {
  const pp = normalizePath(options.projectPath)
  const { exportPath } = options

  try {
    const chapters = await loadFinalChapters(pp, resolveExportScope(options))

    const result = await invoke<EbookExportResult>("export_novel_epub", {
      chapters: chapters.map((c) => ({ title: c.title, body: c.body })),
      exportPath,
      meta: options.meta ?? null,
    })
    return {
      success: result.success,
      exportedPath: result.exportedPath,
      chapterCount: result.chapterCount,
      message: result.message,
    }
  } catch (error) {
    const message = toErrorMessage(error)
    return { success: false, exportedPath: exportPath, chapterCount: 0, message }
  }
}
/**
 * 定稿包出箱闭环（P0：对标 ANW finalization-repository 思想位，MIT 原生实现）。
 *
 * 编排：exportProject（md+快照+meta）→ exportNovelDocx → exportNovelEpub →
 * 写 MANIFEST.json 校验单（各件文件名+章节数+时间戳+成功标记）。
 * 任一步失败即停并返回已完成件清单（失败隔离，不写脏校验单）。
 * 守 Draft-first：只读正式层，不写回任何内容。
 */
export interface FinalizeManuscriptOptions extends ManuscriptExportScope {
  projectPath: string
  exportDir: string
  meta?: EbookExportMeta
  scope?: ManuscriptExportScope
}

export interface FinalizeManuscriptResult {
  success: boolean
  exportedDir: string
  chapterCount: number
  artifacts: string[]
  message: string
}

export async function finalizeManuscript(options: FinalizeManuscriptOptions): Promise<FinalizeManuscriptResult> {
  const dir = normalizePath(options.exportDir)
  const artifacts: string[] = []
  const resolvedScope = resolveExportScope(options)
  const scopeForward =
    options.scope ||
    options.mode !== undefined ||
    options.startChapter !== undefined ||
    options.endChapter !== undefined ||
    options.includeDrafts !== undefined
      ? { scope: resolvedScope }
      : {}
  try {
    await createDirectory(dir)
    const base = await exportProject({
      projectPath: options.projectPath,
      exportPath: `${dir}/project`,
      ...scopeForward,
    })
    if (!base.success) {
      return { success: false, exportedDir: dir, chapterCount: 0, artifacts, message: `出箱中止于项目导出：${base.message}` }
    }
    artifacts.push("project/complete-novel.md")
    const docx = await exportNovelDocx({
      projectPath: options.projectPath,
      exportPath: `${dir}/complete-novel.docx`,
      ...scopeForward,
    })
    if (!docx.success) {
      return { success: false, exportedDir: dir, chapterCount: base.chapterCount, artifacts, message: `出箱中止于 DOCX：${docx.message}` }
    }
    artifacts.push("complete-novel.docx")
    const epub = await exportNovelEpub({
      projectPath: options.projectPath,
      exportPath: `${dir}/complete-novel.epub`,
      meta: options.meta,
      ...scopeForward,
    })
    if (!epub.success) {
      return { success: false, exportedDir: dir, chapterCount: base.chapterCount, artifacts, message: `出箱中止于 EPUB：${epub.message}` }
    }
    artifacts.push("complete-novel.epub")
    const manifest = {
      version: 1,
      finalizedAt: new Date().toISOString(),
      chapterCount: base.chapterCount,
      artifacts,
    }
    await writeFile(`${dir}/MANIFEST.json`, JSON.stringify(manifest, null, 2))
    artifacts.push("MANIFEST.json")
    return { success: true, exportedDir: dir, chapterCount: base.chapterCount, artifacts, message: `定稿包出箱完成：${base.chapterCount} 章，${artifacts.length} 件` }
  } catch (error) {
    const message = toErrorMessage(error)
    return { success: false, exportedDir: dir, chapterCount: 0, artifacts, message }
  }
}
