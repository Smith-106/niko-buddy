/**
 * J14 历史检索纵切面 — 导出历史派生视图 + 反查上下文。
 *
 * 定位：**不新建第二套历史模型**，只把 `.novel/export-history.json`（真源，
 * #43 已落地）读成「可展示/可反查」的派生视图。真源仍是磁盘 JSON 与章节
 * Markdown；本模块只投影，不写历史、不建索引、不创建 Run/资产/导出。
 *
 * 硬门禁映射：
 * - 「PDF 反查确认版本/Run/源资产」：`resolveExportProvenance` 把一条
 *   `PdfExportHistoryEntry` 展开成 { confirmedVersion / run / sourceAsset /
 *   project / output }，供 UI 恢复完整业务上下文（不只打开文件）。
 * - 「历史记录状态 ≠ 索引状态」：`ExportHistoryStatus` 描述的是**历史记录**
 *   自身的可达性，与搜索索引（FTS/Vector ready/stale/failed）完全分离——
 *   索引失败不代表历史失效。
 * - 「源缺失保留历史 + 明确显示 sourceMissing」：派生状态 `source_missing`
 *   由「记录上的 `sourceMissing` 标记 ∪ 源文件实时不存在」共同得出；
 *   如实反映当前文件态（源恢复后派生回 `available`，不 stuck 在旧快照）。
 * - 「不只用路径当身份」：`resolveSourceAsset` 用 `chapter_number`（稳定次键）
 *   重连 + `chapterPath` 定位双键；源章节重命名/移动后仍能经 chapter_number
 *   找回，避免路径断裂即历史失联。
 * - 「重启后追溯一致」：所有派生都从磁盘真源重算（export-history.json +
 *   实时 fileExists），无内存态；重启后同一查询得到一致追溯关系。
 * - 「不创建重复 Run/资产/导出」：本模块零写操作。
 */

import { fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  loadPdfExportHistory,
  type PdfExportHistoryEntry,
} from "./pdf-export-gate"

// ── 历史记录状态（独立于搜索索引状态） ─────────────────────────────────────
/**
 * 单条导出记录的可达性。语义对齐建议模型：
 *   available           — 源资产与导出产物都在
 *   source_missing      — 源章节缺失（删除/移走/重命名后未重连）
 *   output_missing      — PDF 产物（target）缺失
 *   partially_available — 源在但产物缺失，或反之的混合中间态
 *                         （当前模型下等价 output_missing；保留以兼容
 *                          未来"多产物/部分产物"形态）
 *   invalid             — 记录字段残缺，无法构成完整溯源链
 */
export type ExportHistoryStatus =
  | "available"
  | "source_missing"
  | "output_missing"
  | "partially_available"
  | "invalid"

/** 源资产解析结果：双键（稳定 chapter_number + 定位 chapterPath）。 */
export interface ResolvedSourceAsset {
  /** 记录中的章节路径（定位信息，非唯一身份）。 */
  chapterPath: string
  /** 记录中的章节号（重命名/移动后的重连次键）。 */
  chapterNumber: number | null
  /** 源文件当前是否存在于记录的 chapterPath。 */
  existsAtRecordedPath: boolean
  /** 经 chapter_number 重连到的实际路径（重命名后），找不到则 null。 */
  resolvedPath: string | null
  /** 源当前是否可达（记录路径存在 或 经 chapter_number 重连成功）。 */
  reachable: boolean
}

/** 一条导出记录的完整反查上下文（供 UI 恢复业务上下文）。 */
export interface ExportProvenance {
  /** 导出记录幂等键（target::contentDigest）。 */
  exportId: string
  /** 确认版本身份：导出时快照 digest（PDF → 确认版本）。 */
  confirmedVersion: {
    confirmedDigest: string
    contentDigest: string
  }
  /** Run 溯源：导出时 status.json 会话字段（缺失则为空串，不伪造）。 */
  run: {
    sessionId: string
    conversationId: string
    userRequest: string
    /** 该记录的 Run 身份是否完整（sessionId 非空）。 */
    resolvable: boolean
  }
  /** 源章节资产（双键重连）。 */
  sourceAsset: ResolvedSourceAsset
  /** 产物（PDF）。 */
  output: {
    target: string
    exists: boolean
    pages: number
    bytesWritten: number
    font: string
    exportedAt: string
  }
  /** 派生状态。 */
  status: ExportHistoryStatus
  /** 项目归属（导出记录所在项目根）。 */
  projectPath: string
}

/** 展示用视图条目：原始记录 + 派生状态 + 反查上下文。 */
export interface ExportHistoryViewEntry {
  entry: PdfExportHistoryEntry
  provenance: ExportProvenance
  status: ExportHistoryStatus
}

// ── 内部：字段完整性校验 ────────────────────────────────────────────────────
function isStructurallyValid(e: PdfExportHistoryEntry): boolean {
  return (
    typeof e.id === "string" && e.id.length > 0 &&
    typeof e.target === "string" && e.target.length > 0 &&
    typeof e.chapterPath === "string" &&
    typeof e.contentDigest === "string" &&
    typeof e.confirmedDigest === "string"
  )
}

/**
 * 源资产解析：先按记录 chapterPath 检测；若不存在则按 chapter_number 在
 * QM/chapters（与 legacy wiki/chapters）下重连。重命名/移动后仍可找回。
 */
async function resolveSourceAsset(
  projectPath: string,
  e: PdfExportHistoryEntry,
  chapterFileExists: (absPath: string) => Promise<boolean>,
): Promise<ResolvedSourceAsset> {
  const pp = normalizePath(projectPath)
  const recordedAbs = `${pp}/${e.chapterPath}`
  const existsAtRecordedPath = await chapterFileExists(recordedAbs)

  let resolvedPath: string | null = existsAtRecordedPath ? e.chapterPath : null

  // 记录路径失效 → 用稳定次键 chapter_number 在章节目录下重连。
  if (resolvedPath === null && e.chapterNumber !== null) {
    const num = e.chapterNumber
    const pad3 = String(num).padStart(3, "0")
    const candidates = [
      `QM/chapters/chapter-${pad3}.md`,
      `wiki/chapters/chapter-${pad3}.md`,
    ]
    for (const rel of candidates) {
      if (await chapterFileExists(`${pp}/${rel}`)) {
        resolvedPath = rel
        break
      }
    }
  }

  return {
    chapterPath: e.chapterPath,
    chapterNumber: e.chapterNumber,
    existsAtRecordedPath,
    resolvedPath,
    reachable: existsAtRecordedPath || resolvedPath !== null,
  }
}

/**
 * 反查：把一条导出记录展开成完整溯源上下文。零写操作。
 *
 * @param projectPath 项目根
 * @param entry       export-history.json 单条记录
 * @param deps        可注入 IO（测试用）：章节/产物存在性检测
 */
export async function resolveExportProvenance(
  projectPath: string,
  entry: PdfExportHistoryEntry,
  deps?: {
    chapterFileExists?: (absPath: string) => Promise<boolean>
    outputFileExists?: (absPath: string) => Promise<boolean>
  },
): Promise<ExportProvenance> {
  const pp = normalizePath(projectPath)
  const chapterFileExists = deps?.chapterFileExists ?? fileExists
  const outputFileExists = deps?.outputFileExists ?? fileExists

  if (!isStructurallyValid(entry)) {
    return {
      exportId: entry.id ?? "",
      confirmedVersion: {
        confirmedDigest: entry.confirmedDigest ?? "",
        contentDigest: entry.contentDigest ?? "",
      },
      run: {
        sessionId: entry.sessionId ?? "",
        conversationId: entry.conversationId ?? "",
        userRequest: entry.userRequest ?? "",
        resolvable: false,
      },
      sourceAsset: {
        chapterPath: entry.chapterPath ?? "",
        chapterNumber: entry.chapterNumber ?? null,
        existsAtRecordedPath: false,
        resolvedPath: null,
        reachable: false,
      },
      output: {
        target: entry.target ?? "",
        exists: false,
        pages: entry.pages ?? 0,
        bytesWritten: entry.bytesWritten ?? 0,
        font: entry.font ?? "",
        exportedAt: entry.exportedAt ?? "",
      },
      status: "invalid",
      projectPath: pp,
    }
  }

  const sourceAsset = await resolveSourceAsset(pp, entry, chapterFileExists)

  // 产物存在性：target 是相对项目根的路径。
  const outputAbs = `${pp}/${entry.target}`
  const outputExists = await outputFileExists(outputAbs)

  // 派生状态：sourceMissing 标记 ∪ 实时不可达 → source_missing。
  const sourceMissing = entry.sourceMissing === true || !sourceAsset.reachable
  const status: ExportHistoryStatus = sourceMissing
    ? "source_missing"
    : !outputExists
      ? "output_missing"
      : "available"

  return {
    exportId: entry.id,
    confirmedVersion: {
      confirmedDigest: entry.confirmedDigest,
      contentDigest: entry.contentDigest,
    },
    run: {
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      userRequest: entry.userRequest,
      resolvable: entry.sessionId !== "",
    },
    sourceAsset,
    output: {
      target: entry.target,
      exists: outputExists,
      pages: entry.pages,
      bytesWritten: entry.bytesWritten,
      font: entry.font,
      exportedAt: entry.exportedAt,
    },
    status,
    projectPath: pp,
  }
}

/**
 * 派生视图：读 `.novel/export-history.json` → 逐条反查 + 派生状态。
 * 返回按导出时间倒序（最新在前）。重启后从磁盘重算，结果一致（门禁 9）。
 */
export async function loadExportHistoryView(
  projectPath: string,
  deps?: {
    chapterFileExists?: (absPath: string) => Promise<boolean>
    outputFileExists?: (absPath: string) => Promise<boolean>
  },
): Promise<ExportHistoryViewEntry[]> {
  const entries = await loadPdfExportHistory(projectPath)
  const view: ExportHistoryViewEntry[] = []
  for (const entry of entries) {
    const provenance = await resolveExportProvenance(projectPath, entry, deps)
    view.push({ entry, provenance, status: provenance.status })
  }
  // 最新导出在前（exportedAt ISO 字符串字典序即时间序）。
  view.sort((a, b) => b.entry.exportedAt.localeCompare(a.entry.exportedAt))
  return view
}
