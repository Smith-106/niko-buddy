/**
 * PDF 导出确认门 + 导出历史（#43 / F-J12-02 / F-J12-03 闭环）。
 *
 * 硬门禁映射：
 * - 门禁 1（导出必须是用户明确确认的版本）：`assertChapterFinalForExport`
 *   在调用后端前强制断言章节磁盘内容 `chapter_status === "final"`，
 *   非 final 直接抛错，绝不触碰 IPC。导出层自身绑定确认版本，
 *   而不是依赖调用方"记得先检查"。
 * - 门禁 7（来源和版本追踪）：`exportConfirmedChapterPdf` 把每次成功导出的
 *   溯源链（项目 / 会话-Run / 输入章节 / 确认版本摘要 / 导出目标）持久化到
 *   `.novel/export-history.json`。Rust 侧 PDF 元数据不可写——已验证
 *   pdfium-render 0.9 仅暴露 `metadata()` 读 API（`document.rs:280`），
 *   无任何元数据 `set_*` 写 API，因此溯源载体为“导出历史 JSON”，
 *   并在审计文档如实记录（不向 PDF 内虚构元数据）。
 * - 门禁 9（重启恢复）：历史文件是普通磁盘 JSON，`loadPdfExportHistory`
 *   即重启读回；无第二份会话状态（沿用 `.novel/` + 原子写纪律）。
 * - 门禁 5（失败不留完成产物）：记录只在后端返回成功报告后追加；
 *   失败/取消抛错，不写历史。
 * - 门禁 6（重试幂等）：幂等键 = `target + contentDigest`；同一目标同一
 *   内容重试返回既有记录并标记 `deduped: true`，不产生重复条目。
 *
 * 只做单章单 PDF；不扩多格式/批量/云上传/模板市场（门禁 12）。
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { exportPdf, validateExportTarget, LINE_HEIGHT_RATIO, type PdfExportReport } from "./pdf-client"
import { computeCheckpointDigest } from "@/lib/novel/checkpoint-digest"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isFinalChapter } from "@/lib/novel/chapter-meta"
import { withProjectLock } from "@/lib/novel/novel-locks"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { normalizePath } from "@/lib/path-utils"

export const EXPORT_HISTORY_FILE = "export-history.json"
const EXPORT_HISTORY_VERSION = 1
const MAX_MANUSCRIPT_EXPORT_HISTORY = 200

/** 书稿导出中心持久化历史条目（P1-04，与单章确认 PDF 历史共存于 `.novel/export-history.json`）。 */
export interface ManuscriptExportHistoryEntry {
  id: string
  format: "TXT" | "DOCX" | "EPUB" | "PDF"
  path: string
  chapterCount: number
  draftCount: number
  includeDrafts: boolean
  startChapter: number | null
  endChapter: number | null
  success: boolean
  message: string
  exportedAt: string
}

/** 单条导出记录：项目 → 会话(Run) → 输入章节 → 确认版本 → PDF 的完整溯源链。 */
export interface PdfExportHistoryEntry {
  /** 幂等键：target + contentDigest。 */
  id: string
  /** 导出目标（用户选择，数据区之外）。 */
  target: string
  /** 输入章节路径（项目内，如 QM/chapters/chapter-001.md）。 */
  chapterPath: string
  /** 导出时章节正文摘要（sha256 hex 前 16）。 */
  contentDigest: string
  /** 用户确认版本：chapter_status final 快照的摘要（与 contentDigest 同源绑定）。 */
  confirmedDigest: string
  /** 章节元数据：chapter_number / title。 */
  chapterNumber: number | null
  chapterTitle: string
  /** 会话溯源：status.json session_id / conversation_id / user_request（缺失则为空串，不伪造）。 */
  sessionId: string
  conversationId: string
  userRequest: string
  /** 后端回执：pages / bytes / font。 */
  pages: number
  bytesWritten: number
  font: string
  exportedAt: string
  /** 重试命中既有记录时为 true（不产生重复条目，门禁 6）。 */
  deduped?: boolean
  /**
   * 门禁 8：源章节被删除后，历史保留溯源但标记源缺失（而非静默删除记录或
   * 误认为仍指向现存资产）。由 `markExportHistorySourceMissing` 写入。
   */
  sourceMissing?: boolean
}

interface ExportHistoryFile {
  version: number
  entries: PdfExportHistoryEntry[]
  manuscriptExports?: ManuscriptExportHistoryEntry[]
}

export function exportHistoryPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/${EXPORT_HISTORY_FILE}`
}

function exportHistoryLockKey(projectPath: string): string {
  return `export-history:${normalizePath(projectPath)}`
}

function isValidManuscriptExportEntry(value: unknown): value is ManuscriptExportHistoryEntry {
  if (!value || typeof value !== "object") return false
  const e = value as Partial<ManuscriptExportHistoryEntry>
  return (
    typeof e.id === "string" &&
    (e.format === "TXT" || e.format === "DOCX" || e.format === "EPUB" || e.format === "PDF") &&
    typeof e.path === "string" &&
    typeof e.chapterCount === "number" &&
    typeof e.draftCount === "number" &&
    typeof e.includeDrafts === "boolean" &&
    (e.startChapter === null || typeof e.startChapter === "number") &&
    (e.endChapter === null || typeof e.endChapter === "number") &&
    typeof e.success === "boolean" &&
    typeof e.message === "string" &&
    typeof e.exportedAt === "string"
  )
}

async function readExportHistoryFile(projectPath: string): Promise<ExportHistoryFile> {
  try {
    const raw = await readFile(exportHistoryPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<ExportHistoryFile>
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (e): e is PdfExportHistoryEntry =>
            typeof e?.id === "string" && typeof e?.target === "string",
        )
      : []
    const manuscriptExports = Array.isArray(parsed.manuscriptExports)
      ? parsed.manuscriptExports.filter(isValidManuscriptExportEntry)
      : undefined
    return {
      version: EXPORT_HISTORY_VERSION,
      entries,
      ...(manuscriptExports !== undefined ? { manuscriptExports } : {}),
    }
  } catch (err) {
    // 历史文件缺失或损坏时视为空历史，避免阻塞导出启动。
    void err
    return { version: EXPORT_HISTORY_VERSION, entries: [] }
  }
}

async function writeExportHistoryFile(projectPath: string, file: ExportHistoryFile): Promise<void> {
  const historyPath = exportHistoryPath(projectPath)
  const dir = historyPath.slice(0, historyPath.lastIndexOf("/"))
  await createDirectory(dir)
  const payload: ExportHistoryFile = {
    version: EXPORT_HISTORY_VERSION,
    entries: file.entries,
    ...(file.manuscriptExports !== undefined ? { manuscriptExports: file.manuscriptExports } : {}),
  }
  await writeFileAtomic(historyPath, JSON.stringify(payload, null, 2))
}

/** 重启读回：磁盘 JSON → 历史条目（门禁 9）。文件缺失/损坏返回空历史，不抛错。 */
export async function loadPdfExportHistory(projectPath: string): Promise<PdfExportHistoryEntry[]> {
  const file = await readExportHistoryFile(projectPath)
  return file.entries
}

/** 读取书稿导出中心持久化历史（`.novel/export-history.json` 的 `manuscriptExports` 视图）。 */
export async function loadManuscriptExportHistory(
  projectPath: string,
): Promise<ManuscriptExportHistoryEntry[]> {
  const file = await readExportHistoryFile(projectPath)
  return file.manuscriptExports ?? []
}

/** 追加一条书稿导出历史（持 `export-history:${pp}` 锁并保留 `entries` 字段，返回更新后的完整列表）。 */
export async function appendManuscriptExportHistory(
  projectPath: string,
  entry: ManuscriptExportHistoryEntry,
): Promise<ManuscriptExportHistoryEntry[]> {
  return withProjectLock(exportHistoryLockKey(projectPath), async () => {
    const file = await readExportHistoryFile(projectPath)
    const prev = file.manuscriptExports ?? []
    const nextList = [...prev.filter((e) => e.id !== entry.id), entry].slice(
      -MAX_MANUSCRIPT_EXPORT_HISTORY,
    )
    await writeExportHistoryFile(projectPath, {
      ...file,
      manuscriptExports: nextList,
    })
    return nextList
  })
}

/**
 * 门禁 8：删除源资产时必须明确导出历史如何处理。
 * 策略=保留溯源、标记 `sourceMissing`：删除章节本体时不得连带抹掉“谁导出过
 * 该章节的哪个版本”的审计记录，但也必须把条目标为源缺失，避免重启后被误读
 * 为仍指向现存资产。返回值=被标记的条数（0 表示该章节无历史或已全部缺失）。
 */
export async function markExportHistorySourceMissing(input: {
  projectPath: string
  chapterPath: string
}): Promise<number> {
  return withProjectLock(exportHistoryLockKey(input.projectPath), async () => {
    const file = await readExportHistoryFile(input.projectPath)
    if (file.entries.length === 0) return 0
    let marked = 0
    const nextEntries = file.entries.map((e) => {
      if (e.chapterPath === input.chapterPath && e.sourceMissing !== true) {
        marked += 1
        return { ...e, sourceMissing: true }
      }
      return e
    })
    if (marked === 0) return 0
    await writeExportHistoryFile(input.projectPath, {
      ...file,
      entries: nextEntries,
    })
    return marked
  })
}

/**
 * 门禁 1 确认门：章节磁盘内容必须 `chapter_status === "final"`。
 * 返回确认版本摘要（正文 sha256 前 16，供溯源绑定）。非 final 抛错，绝不调用 IPC。
 */
export async function assertChapterFinalForExport(
  readChapterContent: () => Promise<string>,
): Promise<{ confirmedDigest: string }> {
  const content = await readChapterContent()
  const { frontmatter, body } = parseFrontmatter(content)
  if (!isFinalChapter((frontmatter ?? {}) as Record<string, unknown>)) {
    throw new Error(
      "PDF_EXPORT_NOT_CONFIRMED: 仅允许导出用户已确认的正式版本（chapter_status=final）。请先完成审核确认。",
    )
  }
  const confirmedDigest = (await computeCheckpointDigest(body)).slice(0, 16)
  return { confirmedDigest }
}

/**
 * 从已通过确认门与 TOCTOU 校验的磁盘正文派生 PDF 段落。
 * 忽略调用方传入的任意段落数组，确保导出内容与磁盘 `chapter_status=final` 正文同源。
 */
export function deriveVerifiedExportParagraphs(body: string): string[] {
  return body
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^#{1,6}\s+/, "").trim())
    .filter((line) => line.length > 0)
}

/**
 * 确认导出通道：确认门 → 后端导出 → 成功后追加历史（失败不留完成记录，门禁 5）。
 * 同一目标同一内容重试返回既有记录（deduped，门禁 6）。
 */
export async function exportConfirmedChapterPdf(input: {
  projectPath: string
  chapterPath: string
  chapterTitle: string
  target: string
  /** 仅作历史调用签名兼容保留；实际导出段落恒由已校验的磁盘正文派生。 */
  paragraphs?: string[]
  readChapterContent: () => Promise<string>
}): Promise<{ report: PdfExportReport; entry: PdfExportHistoryEntry }> {
  const targetIssue = validateExportTarget(input.target, input.projectPath)
  if (targetIssue !== null) {
    throw new Error(`PDF_EXPORT_INVALID_TARGET: 导出目标不可用（${targetIssue}）`)
  }
  // 门禁 1：先过确认门，再碰 IPC。
  const { confirmedDigest } = await assertChapterFinalForExport(input.readChapterContent)
  const content = await input.readChapterContent()
  const { body, frontmatter } = parseFrontmatter(content)
  if (!isFinalChapter((frontmatter ?? {}) as Record<string, unknown>)) {
    throw new Error(
      "PDF_EXPORT_NOT_CONFIRMED: 确认门与导出之间章节状态不再为 final，已阻断本次导出。请重新确认后再导出。",
    )
  }
  const contentDigest = (await computeCheckpointDigest(body)).slice(0, 16)
  // TOCTOU：确认门与导出之间章节内容不得变化，否则阻断（门禁 1/4）。
  if (confirmedDigest !== contentDigest) {
    throw new Error(
      "PDF_EXPORT_CONTENT_CHANGED: 确认门与导出之间章节内容发生变化，已阻断本次导出。请重新确认后再导出。",
    )
  }
  const verifiedParagraphs = deriveVerifiedExportParagraphs(body)
  if (verifiedParagraphs.length === 0) {
    throw new Error("PDF_EXPORT_EMPTY_BODY: 已确认章节正文为空，无法导出 PDF。")
  }
  const chapterNumberRaw = (frontmatter ?? {})["chapter_number"]
  const chapterNumber =
    typeof chapterNumberRaw === "number" && Number.isFinite(chapterNumberRaw)
      ? chapterNumberRaw
      : typeof chapterNumberRaw === "string" && chapterNumberRaw.trim() !== "" && Number.isFinite(Number(chapterNumberRaw))
        ? Number(chapterNumberRaw)
        : null

  // 门禁 6：幂等键命中则直接返回既有记录（同一内容同一目标无需重复渲染）。
  const existing = await loadPdfExportHistory(input.projectPath)
  const id = `${input.target}::${contentDigest}`
  const hit = existing.find((e) => e.id === id)
  if (hit) {
    return {
      report: {
        target: hit.target,
        pages: hit.pages,
        paragraphs: verifiedParagraphs.length,
        font: hit.font,
        line_height_ratio: LINE_HEIGHT_RATIO,
        bytes_written: hit.bytesWritten,
      },
      entry: { ...hit, deduped: true },
    }
  }

  // 会话溯源：能读到就带上，读不到留空串（不伪造 Run 身份）。
  let sessionId = ""
  let conversationId = ""
  let userRequest = ""
  try {
    const status = await loadNovelSessionStatus(input.projectPath)
    if (status) {
      sessionId = status.session_id ?? ""
      conversationId = status.current_task?.conversation_id ?? ""
      userRequest = status.current_task?.user_request ?? ""
    }
  } catch (err) {
    // status.json 缺失不阻断导出（章节 final 即确认态），溯源字段留空。
    void err
  }

  const report = await exportPdf(
    input.projectPath,
    input.target,
    input.chapterTitle,
    verifiedParagraphs,
  )

  // 门禁 5：只有后端成功才落历史；持 export-history 锁重读最新文件以保留并发写入的 manuscriptExports。
  const entry: PdfExportHistoryEntry = {
    id,
    target: report.target,
    chapterPath: input.chapterPath,
    contentDigest,
    confirmedDigest,
    chapterNumber,
    chapterTitle: input.chapterTitle,
    sessionId,
    conversationId,
    userRequest,
    pages: report.pages,
    bytesWritten: report.bytes_written,
    font: report.font,
    exportedAt: new Date().toISOString(),
  }
  await withProjectLock(exportHistoryLockKey(input.projectPath), async () => {
    const latest = await readExportHistoryFile(input.projectPath)
    const entries = latest.entries.some((e) => e.id === entry.id)
      ? latest.entries
      : [...latest.entries, entry]
    await writeExportHistoryFile(input.projectPath, {
      ...latest,
      entries,
    })
  })
  return { report, entry }
}
