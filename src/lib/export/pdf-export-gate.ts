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
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { normalizePath } from "@/lib/path-utils"

export const EXPORT_HISTORY_FILE = "export-history.json"
const EXPORT_HISTORY_VERSION = 1

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
}

interface ExportHistoryFile {
  version: number
  entries: PdfExportHistoryEntry[]
}

export function exportHistoryPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/${EXPORT_HISTORY_FILE}`
}

/** 重启读回：磁盘 JSON → 历史条目（门禁 9）。文件缺失/损坏返回空历史，不抛错。 */
export async function loadPdfExportHistory(projectPath: string): Promise<PdfExportHistoryEntry[]> {
  try {
    const raw = await readFile(exportHistoryPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<ExportHistoryFile>
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(
      (e): e is PdfExportHistoryEntry =>
        typeof e?.id === "string" && typeof e?.target === "string",
    )
  } catch {
    return []
  }
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
 * 确认导出通道：确认门 → 后端导出 → 成功后追加历史（失败不留完成记录，门禁 5）。
 * 同一目标同一内容重试返回既有记录（deduped，门禁 6）。
 */
export async function exportConfirmedChapterPdf(input: {
  projectPath: string
  chapterPath: string
  chapterTitle: string
  target: string
  paragraphs: string[]
  readChapterContent: () => Promise<string>
}): Promise<{ report: PdfExportReport; entry: PdfExportHistoryEntry }> {
  const targetIssue = validateExportTarget(input.target)
  if (targetIssue !== null) {
    throw new Error(`PDF_EXPORT_INVALID_TARGET: 导出目标不可用（${targetIssue}）`)
  }
  // 门禁 1：先过确认门，再碰 IPC。
  const { confirmedDigest } = await assertChapterFinalForExport(input.readChapterContent)
  const content = await input.readChapterContent()
  const { body, frontmatter } = parseFrontmatter(content)
  const contentDigest = (await computeCheckpointDigest(body)).slice(0, 16)
  // TOCTOU：确认门与导出之间章节内容不得变化，否则阻断（门禁 1/4）。
  if (confirmedDigest !== contentDigest) {
    throw new Error(
      "PDF_EXPORT_CONTENT_CHANGED: 确认门与导出之间章节内容发生变化，已阻断本次导出。请重新确认后再导出。",
    )
  }
  const chapterNumberRaw = (frontmatter ?? {})["chapter_number"]
  const chapterNumber =
    typeof chapterNumberRaw === "number" && Number.isFinite(chapterNumberRaw)
      ? chapterNumberRaw
      : typeof chapterNumberRaw === "string" && chapterNumberRaw.trim() !== "" && Number.isFinite(Number(chapterNumberRaw))
        ? Number(chapterNumberRaw)
        : null

  // 门禁 6：幂等键命中则直接返回既有记录（仍重新走后端？不——同一内容同一目标
  // 无需重复渲染，直接返回既有记录；内容变了则 digest 变，键不命中，正常导出）。
  const historyPath = exportHistoryPath(input.projectPath)
  const existing = await loadPdfExportHistory(input.projectPath)
  const id = `${input.target}::${contentDigest}`
  const hit = existing.find((e) => e.id === id)
  if (hit) {
    return {
      report: {
        target: hit.target,
        pages: hit.pages,
        paragraphs: input.paragraphs.length,
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
  } catch {
    // status.json 缺失不阻断导出（章节 final 即确认态），溯源字段留空。
  }

  const report = await exportPdf(
    input.projectPath,
    input.target,
    input.chapterTitle,
    input.paragraphs,
  )

  // 门禁 5：只有后端成功才落历史。
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
  const dir = historyPath.slice(0, historyPath.lastIndexOf("/"))
  await createDirectory(dir)
  const next: ExportHistoryFile = {
    version: EXPORT_HISTORY_VERSION,
    entries: [...existing, entry],
  }
  await writeFileAtomic(historyPath, JSON.stringify(next, null, 2))
  return { report, entry }
}
