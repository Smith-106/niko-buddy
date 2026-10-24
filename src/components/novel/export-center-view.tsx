/**
 * export-center-view.tsx — 导出中心视图（书稿导出）。
 *
 * ## 职责
 *   - 书稿导出入口：Word（.docx）/ EPUB（.epub）+ 本次会话导出记录；
 *   - 与 `BackupExportView`（T34c 项目备份包：status.json + drafts + LanceDB
 *     快照，zip + SHA-256）严格区分：本视图只做书稿（final 章节 → 阅读格式），
 *     不碰备份包。
 *
 * ## 数据源（全部经 barrel `@/lib/novel`，已 grep 确认存在）
 *   - `countFinalChapters(projectPath)`（`wiki/chapters` 下 final 章节计数，
 *     缺失/不可读 → 0；计数为 0 时导出按钮 disabled）；
 *   - `exportNovelDocx({ projectPath, exportPath })`（Rust `export_novel_docx`）；
 *   - `exportNovelEpub({ projectPath, exportPath, meta? })`（Rust `export_novel_epub`）。
 *
 * ## 缺口记录（2026-10-19）
 *   - 仓库内无 PDF 导出函数：PDF 按钮 disabled + 诚实文案，不伪造入口。
 *   - 导出历史仅为本次会话内存记录（不落盘），文案已明确说明。
 *   - 默认导出路径为展示用约定（`{projectPath}/exports/...`），点击前如实展示。
 *
 * 中文 UI；导出只读正式层，不写回任何内容（Draft-first）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { FileDown, History, Loader2 } from "lucide-react"
import { fileExists } from "@/commands/fs"
import {
  countFinalChapters,
  exportNovelDocx,
  exportNovelEpub,
  type DocxExportResult,
  type EbookExportResult,
} from "@/lib/novel"

export interface ExportCenterSnapshot {
  readonly finalCount: number
}

/** 装载：final 章节计数（底层失败一律归 0，按钮 disabled + 诚实文案）。 */
export async function loadExportCenterSnapshot(projectPath: string): Promise<ExportCenterSnapshot> {
  try {
    return { finalCount: await countFinalChapters(projectPath) }
  } catch {
    return { finalCount: 0 }
  }
}

export type ManuscriptExportFormat = "DOCX" | "EPUB"

export interface ExportCenterActions {
  readonly exportDocx: (options: {
    readonly projectPath: string;
    readonly exportPath: string;
  }) => Promise<DocxExportResult>
  readonly exportEpub: (options: {
    readonly projectPath: string;
    readonly exportPath: string;
  }) => Promise<EbookExportResult>
}

const DEFAULT_EXPORT_ACTIONS: ExportCenterActions = {
  exportDocx: exportNovelDocx,
  exportEpub: exportNovelEpub,
}

export interface ManuscriptExportRecord {
  readonly format: ManuscriptExportFormat
  readonly path: string
  readonly success: boolean
  readonly message: string
}

export function manuscriptExportPath(projectPath: string, folderName: string, baseName: string, format: ManuscriptExportFormat): string {
  // B 波 B3：目录支持绝对路径（目录选择器回填）与项目内相对目录；绝对路径直接拼接文件名。
  const trimmedFolder = folderName.trim()
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmedFolder) || trimmedFolder.startsWith("/")
  const folder = isAbsolute ? trimmedFolder.replace(/[\\/]+$/, "") : trimmedFolder.replace(/[\\/]/g, "") || "exports"
  const base = baseName.trim().replace(/[\\/]/g, "") || "complete-novel"
  const ext = format === "DOCX" ? "docx" : "epub"
  if (isAbsolute && folder !== "") return `${folder}/${base}.${ext}`
  return `${projectPath}/${folder}/${base}.${ext}`
}

export interface ExportCenterViewProps {
  /** 项目根路径（计数与默认导出路径均由此派生）。 */
  readonly projectPath: string
  /** 显式注入导出动作（测试优先；缺省为真实 barrel 导出函数）。 */
  readonly actions?: ExportCenterActions
  /** 同名检测。缺省读磁盘；测试可注入。 */
  readonly fileExists?: (path: string) => Promise<boolean>
  /** 目录选择器。缺省走 pickDirectory；测试可注入返回绝对路径或 null（取消）。 */
  readonly pickDirectory?: () => Promise<string | null>
}

export function ExportCenterView({
  projectPath,
  actions = DEFAULT_EXPORT_ACTIONS,
  fileExists: fileExistsImpl = fileExists,
  pickDirectory: pickDirectoryImpl,
}: ExportCenterViewProps) {
  const [snapshot, setSnapshot] = useState<ExportCenterSnapshot | null>(null)
  const [loading, setLoading] = useState(projectPath !== "")
  const [exporting, setExporting] = useState<ManuscriptExportFormat | null>(null)
  const [records, setRecords] = useState<readonly ManuscriptExportRecord[]>([])
  const [folderName, setFolderName] = useState("exports")
  const [baseName, setBaseName] = useState("complete-novel")
  const [pendingOverwrite, setPendingOverwrite] = useState<ManuscriptExportFormat | null>(null)

  useEffect(() => {
    if (projectPath === "") {
      setSnapshot(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void loadExportCenterSnapshot(projectPath)
      .then((result) => {
        if (!cancelled) setSnapshot(result)
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ finalCount: 0 })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  async function handleExport(format: ManuscriptExportFormat, confirmed = false) {
    if (exporting !== null || projectPath === "") return
    const exportPath = manuscriptExportPath(projectPath, folderName, baseName, format)
    if (!confirmed) {
      let occupied = true
      try {
        occupied = await fileExistsImpl(exportPath)
      } catch {
        occupied = true
      }
      if (occupied) {
        setPendingOverwrite(format)
        return
      }
    }
    setPendingOverwrite(null)
    setExporting(format)
    try {
      const result =
        format === "DOCX"
          ? await actions.exportDocx({ projectPath, exportPath })
          : await actions.exportEpub({ projectPath, exportPath })
      setRecords((current) => [
        ...current,
        { format, path: result.exportedPath, success: result.success, message: result.message },
      ])
    } catch (err) {
      // 真实导出函数内部已 catch 转失败结果；此处兜底调用方注入动作的抛错。
      setRecords((current) => [
        ...current,
        {
          format,
          path: exportPath,
          success: false,
          message: err instanceof Error && err.message ? err.message : String(err),
        },
      ])
    } finally {
      setExporting(null)
    }
  }

  const canExport = snapshot !== null && snapshot.finalCount > 0 && exporting === null

  return (
    <section data-testid="export-center-view" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <FileDown className="h-4 w-4" />
        导出中心（书稿导出）
      </h2>
      <p className="text-xs text-muted-foreground">
        只做书稿导出（final 章节 → Word/EPUB）；项目备份包请走备份导出视图。导出只读正式层，不写回任何内容。
      </p>

      {loading ? (
        <p data-testid="export-center-loading" className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在统计可导出章节…
        </p>
      ) : snapshot === null ? (
        <p data-testid="export-center-empty" className="text-xs text-muted-foreground">
          未指定项目路径
        </p>
      ) : (
        <>
          <div data-testid="export-center-status" className="rounded-md border border-border bg-background px-3 py-2">
            <p className="text-xs text-muted-foreground">
              可导出 final 章节：<span data-testid="export-center-count">{snapshot.finalCount}</span> 章
            </p>
            {snapshot.finalCount === 0 ? (
              <p data-testid="export-center-no-chapters" className="mt-1 text-xs text-muted-foreground">
                暂无可导出的 final 章节（章节目录缺失或尚无终稿章节），导出按钮已禁用。
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              目录
              <input
                data-testid="export-folder-name"
                value={folderName}
                onChange={(event) => {
                  setFolderName(event.target.value)
                  setPendingOverwrite(null)
                }}
                className="w-28 rounded border border-border bg-background px-2 py-1 text-foreground"
              />
              <button
                type="button"
                data-testid="export-pick-directory"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => void (async () => {
                  try {
                    const pick = pickDirectoryImpl ?? (await import("@/lib/platform")).pickDirectory
                    const dir = await pick()
                    if (dir) {
                      setFolderName(dir)
                      setPendingOverwrite(null)
                    }
                  } catch {
                    /* 目录选择取消/失败时静默保留手输目录 */
                  }
                })()}
              >
                选择…
              </button>
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              文件名
              <input
                data-testid="export-file-name"
                value={baseName}
                onChange={(event) => {
                  setBaseName(event.target.value)
                  setPendingOverwrite(null)
                }}
                className="w-40 rounded border border-border bg-background px-2 py-1 text-foreground"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="export-target-path">
            将写到 {manuscriptExportPath(projectPath, folderName, baseName, "DOCX")} 或{" "}
            {manuscriptExportPath(projectPath, folderName, baseName, "EPUB")}。同名文件会先要求确认。
          </p>
          {pendingOverwrite !== null ? (
            <div data-testid="export-overwrite-confirm" className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <p className="text-xs text-foreground">
                已有同名文件，继续会覆盖 {manuscriptExportPath(projectPath, folderName, baseName, pendingOverwrite)}
              </p>
              <button
                type="button"
                data-testid="export-overwrite-confirm-button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => void handleExport(pendingOverwrite, true)}
              >
                确认覆盖
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => setPendingOverwrite(null)}
              >
                取消
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="export-docx-button"
              disabled={!canExport}
              onClick={() => void handleExport("DOCX")}
              className="rounded border border-border px-3 py-1.5 text-xs"
            >
              {exporting === "DOCX" ? "正在导出 Word…" : "导出 Word（.docx）"}
            </button>
            <button
              type="button"
              data-testid="export-epub-button"
              disabled={!canExport}
              onClick={() => void handleExport("EPUB")}
              className="rounded border border-border px-3 py-1.5 text-xs"
            >
              {exporting === "EPUB" ? "正在导出 EPUB…" : "导出 EPUB（.epub）"}
            </button>
            <button
              type="button"
              data-testid="export-pdf-button"
              disabled
              title="仓库内无 PDF 导出函数，该入口尚未接入"
              className="rounded border border-border px-3 py-1.5 text-xs opacity-50"
            >
              导出 PDF（尚未接入）
            </button>
          </div>
          <div className="rounded-md border border-border bg-background px-3 py-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <History className="h-3.5 w-3.5" />
              本次会话导出记录（不落盘，共 {records.length} 条）
            </p>
            {records.length === 0 ? (
              <p data-testid="export-history-empty" className="mt-1 text-xs text-muted-foreground">
                本次会话暂无导出记录
              </p>
            ) : (
              <ul data-testid="export-history-list" className="mt-1 flex flex-col gap-1">
                {records.map((record, index) => (
                  <li
                    key={`${record.format}-${record.path}-${index}`}
                    data-testid={`export-record-${record.success ? "success" : "failure"}`}
                    className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">{record.format}</span>
                    <span className="font-mono">{record.path}</span>
                    <span>{record.success ? "成功" : `失败：${record.message}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
