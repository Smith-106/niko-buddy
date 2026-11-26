/**
 * export-center-view.tsx — 导出中心视图（全格式书稿导出 + 持久导出历史）。
 *
 * ## 职责
 *   - 书稿导出入口：TXT（.txt）/ Word（.docx）/ EPUB（.epub）/ 整本 PDF（.pdf）+ 单章精细 PDF 入口；
 *   - 支持起止章节范围筛选、显式草稿包含开关（带醒目警示，绝不修改章节状态）与 TXT 排版选项；
 *   - 持久化导出历史（`.novel/export-history.json` 的 `manuscriptExports` 字段）+ 一键打开所在文件夹；
 *   - 与 `BackupExportView`（项目备份包：zip + SHA-256）严格区分：本视图只做书稿只读导出，不写回正文。
 *
 * ## 数据源（全部经 barrel `@/lib/novel` 与 shared 层 `@/lib/export/pdf-export-gate`）
 *   - `inspectExportableChapters(projectPath, scope?)`
 *   - `exportNovelTxt` / `exportNovelDocx` / `exportNovelEpub` / `exportNovelPdf`
 *   - `loadManuscriptExportHistory` / `appendManuscriptExportHistory`
 *
 * 中文 UI；导出只读，绝不写回任何正文或记忆（Draft-first）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, FileDown, FileText, FolderOpen, History, Loader2 } from "lucide-react"
import { fileExists, openFileLocation, openProjectFolder, readFile } from "@/commands/fs"
import {
  exportNovelDocx,
  exportNovelEpub,
  exportNovelPdf,
  exportNovelTxt,
  inspectExportableChapters,
  type DocxExportOptions,
  type DocxExportResult,
  type EbookExportOptions,
  type EbookExportResult,
  type ExportableChaptersInspection,
  type ManuscriptExportOutcome,
  type ManuscriptExportScope,
  type PdfManuscriptExportOptions,
  type TxtExportOptions,
} from "@/lib/novel"
import {
  appendManuscriptExportHistory,
  loadManuscriptExportHistory,
  type ManuscriptExportHistoryEntry,
} from "@/lib/export/pdf-export-gate"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { toast } from "@/lib/toast"
import { toErrorMessage } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PdfExportDialog } from "@/components/export/PdfExportDialog"

export type ExportCenterSnapshot = ExportableChaptersInspection

const EMPTY_SNAPSHOT: ExportCenterSnapshot = {
  finalCount: 0,
  draftCount: 0,
  minChapter: null,
  maxChapter: null,
  totalWords: 0,
  finalChapters: [],
}

/** 装载：可导出章节统计快照（底层失败一律降级为空快照，按钮按实态禁用）。 */
export async function loadExportCenterSnapshot(projectPath: string): Promise<ExportCenterSnapshot> {
  try {
    return await inspectExportableChapters(projectPath)
  } catch (err) {
    void err
    return EMPTY_SNAPSHOT
  }
}

export type ManuscriptExportFormat = "TXT" | "DOCX" | "EPUB" | "PDF"

export interface ExportCenterActions {
  readonly exportTxt?: (options: TxtExportOptions) => Promise<ManuscriptExportOutcome>
  readonly exportDocx: (options: DocxExportOptions) => Promise<DocxExportResult>
  readonly exportEpub: (options: EbookExportOptions) => Promise<EbookExportResult>
  readonly exportPdf?: (options: PdfManuscriptExportOptions) => Promise<ManuscriptExportOutcome>
}

const DEFAULT_EXPORT_ACTIONS: Required<ExportCenterActions> = {
  exportTxt: exportNovelTxt,
  exportDocx: exportNovelDocx,
  exportEpub: exportNovelEpub,
  exportPdf: exportNovelPdf,
}

export interface ManuscriptExportHistoryStore {
  readonly load: (projectPath: string) => Promise<ManuscriptExportHistoryEntry[]>
  readonly append: (
    projectPath: string,
    entry: ManuscriptExportHistoryEntry,
  ) => Promise<ManuscriptExportHistoryEntry[]>
}

const DEFAULT_HISTORY_STORE: ManuscriptExportHistoryStore = {
  load: loadManuscriptExportHistory,
  append: appendManuscriptExportHistory,
}

export type ManuscriptExportRecord = ManuscriptExportHistoryEntry

const FORMAT_EXTENSION: Record<ManuscriptExportFormat, string> = {
  TXT: "txt",
  DOCX: "docx",
  EPUB: "epub",
  PDF: "pdf",
}

export function manuscriptExportPath(
  projectPath: string,
  folderName: string,
  baseName: string,
  format: ManuscriptExportFormat,
): string {
  // 目录支持绝对路径（目录选择器回填）与项目内相对目录；绝对路径直接拼接文件名。
  const trimmedFolder = folderName.trim()
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmedFolder) || trimmedFolder.startsWith("/")
  const folder = isAbsolute
    ? trimmedFolder.replace(/[\\/]+$/, "")
    : trimmedFolder.replace(/[\\/]/g, "") || "exports"
  const base = baseName.trim().replace(/[\\/]/g, "") || "complete-novel"
  const ext = FORMAT_EXTENSION[format]
  if (isAbsolute && folder !== "") return `${folder}/${base}.${ext}`
  return `${projectPath}/${folder}/${base}.${ext}`
}

function parseOptionalPositiveInt(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const num = Number.parseInt(trimmed, 10)
  return Number.isFinite(num) && num >= 1 ? num : null
}

function sortHistoryDesc(entries: readonly ManuscriptExportHistoryEntry[]): ManuscriptExportHistoryEntry[] {
  return [...entries].sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))
}

export interface ExportCenterViewProps {
  /** 项目根路径（统计、默认导出路径与持久导出历史均由此派生）。 */
  readonly projectPath: string
  /** 显式注入导出动作（测试优先；缺省为真实 barrel 导出函数）。 */
  readonly actions?: ExportCenterActions
  /** 显式注入持久化历史读写（测试优先；缺省为 pdf-export-gate）。 */
  readonly historyStore?: ManuscriptExportHistoryStore
  /** 同名检测。缺省读磁盘；测试可注入。 */
  readonly fileExists?: (path: string) => Promise<boolean>
  /** 目录选择器。缺省走 pickDirectory；测试可注入返回绝对路径或 null（取消）。 */
  readonly pickDirectory?: () => Promise<string | null>
  /** 打开所在文件夹动作（测试可注入；缺省走 openFileLocation 降级 openProjectFolder）。 */
  readonly openLocation?: (path: string) => Promise<void>
}

export function ExportCenterView({
  projectPath,
  actions = DEFAULT_EXPORT_ACTIONS,
  historyStore = DEFAULT_HISTORY_STORE,
  fileExists: fileExistsImpl = fileExists,
  pickDirectory: pickDirectoryImpl,
  openLocation,
}: ExportCenterViewProps) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ExportCenterSnapshot | null>(null)
  const [loading, setLoading] = useState(projectPath !== "")
  const [exporting, setExporting] = useState<ManuscriptExportFormat | null>(null)
  const [records, setRecords] = useState<readonly ManuscriptExportRecord[]>([])
  const [folderName, setFolderName] = useState("exports")
  const [baseName, setBaseName] = useState("complete-novel")
  const [pendingOverwrite, setPendingOverwrite] = useState<ManuscriptExportFormat | null>(null)

  // 范围与选项配置
  const [startChapterInput, setStartChapterInput] = useState("")
  const [endChapterInput, setEndChapterInput] = useState("")
  const [includeDrafts, setIncludeDrafts] = useState(false)
  const [firstLineIndent, setFirstLineIndent] = useState(true)
  const [includeBom, setIncludeBom] = useState(true)

  // 单章精细排版 PDF 弹窗状态
  const [selectedSingleChapterPath, setSelectedSingleChapterPath] = useState("")
  const [singlePdfDialog, setSinglePdfDialog] = useState<{
    open: boolean
    title: string
    chapterPath: string
    paragraphs: string[]
  }>({ open: false, title: "", chapterPath: "", paragraphs: [] })

  const resolvedActions: Required<ExportCenterActions> = {
    exportTxt: actions.exportTxt ?? DEFAULT_EXPORT_ACTIONS.exportTxt,
    exportDocx: actions.exportDocx,
    exportEpub: actions.exportEpub,
    exportPdf: actions.exportPdf ?? DEFAULT_EXPORT_ACTIONS.exportPdf,
  }

  useEffect(() => {
    if (projectPath === "") {
      setSnapshot(null)
      setRecords([])
      setSelectedSingleChapterPath("")
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void Promise.all([
      loadExportCenterSnapshot(projectPath),
      historyStore.load(projectPath).catch((err) => {
        void err
        return [] as ManuscriptExportHistoryEntry[]
      }),
    ])
      .then(([result, history]) => {
        if (cancelled) return
        setSnapshot(result)
        setRecords(sortHistoryDesc(history))
        setSelectedSingleChapterPath((prev) => {
          if (prev && result.finalChapters.some((ch) => ch.path === prev)) return prev
          return result.finalChapters[0]?.path ?? ""
        })
      })
      .catch((err) => {
        void err
        if (!cancelled) {
          setSnapshot(EMPTY_SNAPSHOT)
          setRecords([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [historyStore, projectPath])

  const startChapter = parseOptionalPositiveInt(startChapterInput)
  const endChapter = parseOptionalPositiveInt(endChapterInput)
  const rangeInvalid =
    startChapter !== null && endChapter !== null && startChapter > endChapter

  const exportableCount = snapshot
    ? snapshot.finalCount + (includeDrafts ? snapshot.draftCount : 0)
    : 0
  const canExport = snapshot !== null && exportableCount > 0 && !rangeInvalid && exporting === null

  function buildScope(): ManuscriptExportScope {
    const hasRange = startChapter !== null || endChapter !== null
    return {
      mode: hasRange ? "range" : "all",
      startChapter,
      endChapter,
      includeDrafts,
    }
  }

  async function recordHistory(entry: ManuscriptExportHistoryEntry) {
    try {
      const updated = await historyStore.append(projectPath, entry)
      setRecords(sortHistoryDesc(updated))
    } catch (err) {
      void err
      // 落盘历史失败不覆盖本次导出反馈，仍保留内存展示
      setRecords((current) => sortHistoryDesc([...current, entry]))
    }
  }

  async function handleExport(format: ManuscriptExportFormat, confirmed = false) {
    if (exporting !== null || projectPath === "" || rangeInvalid) return
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
    const scope = buildScope()
    const exportedAt = new Date().toISOString()
    const id = `${format}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      let exportedPath = exportPath
      let chapterCount = 0
      let draftCount = 0
      let success = false
      let message = ""

      if (format === "TXT") {
        const res = await resolvedActions.exportTxt({
          projectPath,
          exportPath,
          scope,
          startChapter,
          endChapter,
          includeDrafts,
          firstLineIndent,
          includeBom,
        })
        exportedPath = res.exportedPath
        chapterCount = res.chapterCount
        draftCount = res.draftCount
        success = res.success
        message = res.message
      } else if (format === "PDF") {
        const res = await resolvedActions.exportPdf({
          projectPath,
          exportPath,
          scope,
          startChapter,
          endChapter,
          includeDrafts,
        })
        exportedPath = res.exportedPath
        chapterCount = res.chapterCount
        draftCount = res.draftCount
        success = res.success
        message = res.message
      } else if (format === "DOCX") {
        const res = await resolvedActions.exportDocx({
          projectPath,
          exportPath,
          scope,
          startChapter,
          endChapter,
          includeDrafts,
        })
        exportedPath = res.exportedPath
        chapterCount = res.chapterCount
        draftCount = includeDrafts ? (snapshot?.draftCount ?? 0) : 0
        success = res.success
        message = res.message
      } else {
        const res = await resolvedActions.exportEpub({
          projectPath,
          exportPath,
          scope,
          startChapter,
          endChapter,
          includeDrafts,
        })
        exportedPath = res.exportedPath
        chapterCount = res.chapterCount
        draftCount = includeDrafts ? (snapshot?.draftCount ?? 0) : 0
        success = res.success
        message = res.message
      }

      await recordHistory({
        id,
        format,
        path: exportedPath,
        chapterCount,
        draftCount,
        includeDrafts,
        startChapter,
        endChapter,
        success,
        message,
        exportedAt,
      })
    } catch (err) {
      await recordHistory({
        id,
        format,
        path: exportPath,
        chapterCount: 0,
        draftCount: 0,
        includeDrafts,
        startChapter,
        endChapter,
        success: false,
        message: toErrorMessage(err),
        exportedAt,
      })
    } finally {
      setExporting(null)
    }
  }

  async function handleOpenFolder(recordPath: string) {
    try {
      if (openLocation) {
        await openLocation(recordPath)
        return
      }
      await openFileLocation(recordPath)
    } catch (primaryErr) {
      try {
        await openProjectFolder(projectPath)
      } catch (fallbackErr) {
        toast.error(
          t("novel.exportCenter.openFolderFailed", {
            message: toErrorMessage(fallbackErr || primaryErr),
            defaultValue: `无法打开导出目录：${toErrorMessage(fallbackErr || primaryErr)}`,
          }),
        )
      }
    }
  }

  async function handleOpenSingleChapterPdf() {
    if (!snapshot || !projectPath) return
    const target = snapshot.finalChapters.find((ch) => ch.path === selectedSingleChapterPath)
      ?? snapshot.finalChapters[0]
    if (!target) return
    const fullPath = isAbsolutePath(target.path)
      ? normalizePath(target.path)
      : `${normalizePath(projectPath).replace(/\/+$/, "")}/${normalizePath(target.path).replace(/^\/+/, "")}`
    try {
      const raw = await readFile(fullPath)
      const { body } = parseFrontmatter(raw)
      const paragraphs = body
        .split(/\r?\n+/)
        .map((line) => line.trim().replace(/^#{1,6}\s+/, "").trim())
        .filter((line) => line.length > 0)
      setSinglePdfDialog({
        open: true,
        title: target.title || `第 ${target.chapterNumber} 章`,
        chapterPath: target.path,
        paragraphs,
      })
    } catch (err) {
      toast.error(
        t("novel.exportCenter.readChapterFailed", {
          message: toErrorMessage(err),
          defaultValue: `读取章节内容失败：${toErrorMessage(err)}`,
        }),
      )
    }
  }

  return (
    <section data-testid="export-center-view" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <FileDown className="h-4 w-4" aria-hidden="true" />
        {t("novel.exportCenter.title", { defaultValue: "导出中心（书稿导出）" })}
      </h2>
      <p className="text-xs text-muted-foreground">
        {t("novel.exportCenter.subtitle", {
          defaultValue:
            "将书稿导出为 TXT、Word、EPUB 或 PDF 阅读文件；导出仅读取章节内容，不会改写正式正文或状态。项目数据备份请前往备份恢复页面。",
        })}
      </p>

      {loading ? (
        <p data-testid="export-center-loading" className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t("novel.exportCenter.loading", { defaultValue: "正在统计可导出章节…" })}
        </p>
      ) : snapshot === null ? (
        <p data-testid="export-center-empty" className="text-xs text-muted-foreground">
          {t("novel.exportCenter.noProject", { defaultValue: "未指定项目路径" })}
        </p>
      ) : (
        <>
          <div data-testid="export-center-status" className="rounded-md border border-border bg-background px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                {t("novel.exportCenter.finalCountLabel", { defaultValue: "已定稿章节：" })}
                <span data-testid="export-center-count" className="font-medium text-foreground">
                  {snapshot.finalCount}
                </span>{" "}
                章
              </span>
              <span>
                {t("novel.exportCenter.draftCountLabel", { defaultValue: "草稿章节：" })}
                <span data-testid="export-center-draft-count" className="font-medium text-foreground">
                  {snapshot.draftCount}
                </span>{" "}
                章
              </span>
              {snapshot.minChapter !== null && snapshot.maxChapter !== null ? (
                <span>
                  {t("novel.exportCenter.chapterSpan", {
                    min: snapshot.minChapter,
                    max: snapshot.maxChapter,
                    defaultValue: `章节号范围：第 ${snapshot.minChapter} - ${snapshot.maxChapter} 章`,
                  })}
                </span>
              ) : null}
              {snapshot.totalWords > 0 ? (
                <span>
                  {t("novel.exportCenter.totalWords", {
                    words: snapshot.totalWords.toLocaleString(),
                    defaultValue: `约 ${snapshot.totalWords.toLocaleString()} 字`,
                  })}
                </span>
              ) : null}
            </div>
            {exportableCount === 0 ? (
              <p data-testid="export-center-no-chapters" className="mt-1 text-xs text-muted-foreground">
                {snapshot.draftCount > 0
                  ? t("novel.exportCenter.noFinalHasDrafts", {
                      defaultValue:
                        "暂无已定稿章节；可先将章节标记为已定稿，或勾选下方「包含未定稿草稿（仅供审阅）」后再导出。",
                    })
                  : t("novel.exportCenter.noChapters", {
                      defaultValue: "暂无可导出的已定稿章节（章节目录缺失或尚无终稿章节），导出按钮已禁用。",
                    })}
              </p>
            ) : null}
          </div>

          {/* 导出配置区：目录/文件名 + 章节范围 + 草稿开关 + TXT 选项 */}
          <div className="flex flex-col gap-2.5 rounded-md border border-border bg-background px-3 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Label htmlFor="export-folder-name" className="text-xs font-normal text-muted-foreground">
                  {t("novel.exportCenter.folderLabel", { defaultValue: "目录" })}
                </Label>
                <input
                  id="export-folder-name"
                  data-testid="export-folder-name"
                  value={folderName}
                  onChange={(event) => {
                    setFolderName(event.target.value)
                    setPendingOverwrite(null)
                  }}
                  className="w-32 rounded border border-border bg-background px-2 py-1 text-foreground"
                />
                <button
                  type="button"
                  data-testid="export-pick-directory"
                  className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
                  onClick={() =>
                    void (async () => {
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
                    })()
                  }
                >
                  {t("novel.exportCenter.pickDirectory", { defaultValue: "选择…" })}
                </button>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Label htmlFor="export-file-name" className="text-xs font-normal text-muted-foreground">
                  {t("novel.exportCenter.fileNameLabel", { defaultValue: "文件名" })}
                </Label>
                <input
                  id="export-file-name"
                  data-testid="export-file-name"
                  value={baseName}
                  onChange={(event) => {
                    setBaseName(event.target.value)
                    setPendingOverwrite(null)
                  }}
                  className="w-40 rounded border border-border bg-background px-2 py-1 text-foreground"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="export-start-chapter" className="text-xs font-normal text-muted-foreground">
                  {t("novel.exportCenter.startChapter", { defaultValue: "起始章号" })}
                </Label>
                <input
                  id="export-start-chapter"
                  data-testid="export-start-chapter"
                  type="number"
                  min={1}
                  placeholder={t("novel.exportCenter.allPlaceholder", { defaultValue: "全部" })}
                  value={startChapterInput}
                  onChange={(e) => setStartChapterInput(e.target.value)}
                  className="w-20 rounded border border-border bg-background px-2 py-1 text-foreground"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="export-end-chapter" className="text-xs font-normal text-muted-foreground">
                  {t("novel.exportCenter.endChapter", { defaultValue: "结束章号" })}
                </Label>
                <input
                  id="export-end-chapter"
                  data-testid="export-end-chapter"
                  type="number"
                  min={1}
                  placeholder={t("novel.exportCenter.allPlaceholder", { defaultValue: "全部" })}
                  value={endChapterInput}
                  onChange={(e) => setEndChapterInput(e.target.value)}
                  className="w-20 rounded border border-border bg-background px-2 py-1 text-foreground"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  id="export-include-drafts"
                  data-testid="export-include-drafts"
                  type="checkbox"
                  checked={includeDrafts}
                  onChange={(e) => setIncludeDrafts(e.target.checked)}
                  className="rounded border-border"
                />
                <Label htmlFor="export-include-drafts" className="cursor-pointer text-xs font-normal text-foreground">
                  {t("novel.exportCenter.includeDrafts", { defaultValue: "包含未定稿草稿（标明【草稿】）" })}
                </Label>
              </div>
            </div>

            {rangeInvalid ? (
              <p role="alert" data-testid="export-range-error" className="text-xs text-destructive">
                {t("novel.exportCenter.rangeInvalid", { defaultValue: "起始章号不能大于结束章号，请修正后再导出。" })}
              </p>
            ) : null}

            {includeDrafts ? (
              <div
                role="alert"
                data-testid="export-include-drafts-alert"
                className="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {t("novel.exportCenter.includeDraftsWarning", {
                    defaultValue: "当前包含未定稿章节，导出仅供审阅，不会改变章节正式状态。",
                  })}
                </span>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-4 border-t border-border/50 pt-2 text-muted-foreground">
              <span className="font-medium text-foreground">
                {t("novel.exportCenter.txtOptionsLabel", { defaultValue: "TXT 选项：" })}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  id="export-txt-indent"
                  data-testid="export-txt-indent"
                  type="checkbox"
                  checked={firstLineIndent}
                  onChange={(e) => setFirstLineIndent(e.target.checked)}
                  className="rounded border-border"
                />
                <Label htmlFor="export-txt-indent" className="cursor-pointer text-xs font-normal text-muted-foreground">
                  {t("novel.exportCenter.txtFirstLineIndent", { defaultValue: "段首空两格缩进" })}
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  id="export-txt-bom"
                  data-testid="export-txt-bom"
                  type="checkbox"
                  checked={includeBom}
                  onChange={(e) => setIncludeBom(e.target.checked)}
                  className="rounded border-border"
                />
                <Label htmlFor="export-txt-bom" className="cursor-pointer text-xs font-normal text-muted-foreground">
                  {t("novel.exportCenter.txtIncludeBom", { defaultValue: "写入 UTF-8 BOM（兼容记事本）" })}
                </Label>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground" data-testid="export-target-path">
            {t("novel.exportCenter.targetPathHint", {
              docxPath: manuscriptExportPath(projectPath, folderName, baseName, "DOCX"),
              epubPath: manuscriptExportPath(projectPath, folderName, baseName, "EPUB"),
              defaultValue: `将按格式写入 ${manuscriptExportPath(projectPath, folderName, baseName, "DOCX")} / ${manuscriptExportPath(projectPath, folderName, baseName, "EPUB")} 等路径，同名文件会先要求确认。`,
            })}
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
                {t("novel.exportCenter.confirmOverwrite", { defaultValue: "确认覆盖" })}
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => setPendingOverwrite(null)}
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="export-txt-button"
              disabled={!canExport}
              onClick={() => void handleExport("TXT")}
              className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              {exporting === "TXT"
                ? t("novel.exportCenter.exportingTxt", { defaultValue: "正在导出 TXT…" })
                : t("novel.exportCenter.exportTxt", { defaultValue: "导出 TXT（.txt）" })}
            </button>
            <button
              type="button"
              data-testid="export-docx-button"
              disabled={!canExport}
              onClick={() => void handleExport("DOCX")}
              className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              {exporting === "DOCX"
                ? t("novel.exportCenter.exportingDocx", { defaultValue: "正在导出 Word…" })
                : t("novel.exportCenter.exportDocx", { defaultValue: "导出 Word（.docx）" })}
            </button>
            <button
              type="button"
              data-testid="export-epub-button"
              disabled={!canExport}
              onClick={() => void handleExport("EPUB")}
              className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              {exporting === "EPUB"
                ? t("novel.exportCenter.exportingEpub", { defaultValue: "正在导出 EPUB…" })
                : t("novel.exportCenter.exportEpub", { defaultValue: "导出 EPUB（.epub）" })}
            </button>
            <button
              type="button"
              data-testid="export-pdf-button"
              disabled={!canExport}
              onClick={() => void handleExport("PDF")}
              className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              {exporting === "PDF"
                ? t("novel.exportCenter.exportingPdf", { defaultValue: "正在导出整本 PDF…" })
                : t("novel.exportCenter.exportPdf", { defaultValue: "导出整本 PDF（.pdf）" })}
            </button>
          </div>

          {/* 单章精选 PDF 精细排版入口 */}
          {snapshot.finalChapters.length > 0 ? (
            <div
              data-testid="export-single-pdf-card"
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Label htmlFor="export-single-chapter-select" className="text-xs font-medium text-foreground">
                {t("novel.exportCenter.singleChapterPdfLabel", { defaultValue: "单章 PDF 导出（精细排版）：" })}
              </Label>
              <select
                id="export-single-chapter-select"
                data-testid="export-single-chapter-select"
                value={selectedSingleChapterPath}
                onChange={(e) => setSelectedSingleChapterPath(e.target.value)}
                className="max-w-xs rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
              >
                {snapshot.finalChapters.map((ch) => (
                  <option key={ch.path} value={ch.path}>
                    {`第 ${ch.chapterNumber} 章 · ${ch.title}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="export-single-pdf-button"
                onClick={() => void handleOpenSingleChapterPdf()}
                className="rounded border border-border px-2.5 py-1 text-xs hover:bg-accent"
              >
                {t("novel.exportCenter.openSinglePdf", { defaultValue: "导出该章 PDF…" })}
              </button>
            </div>
          ) : null}

          <div className="rounded-md border border-border bg-background px-3 py-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <History className="h-3.5 w-3.5" aria-hidden="true" />
              {t("novel.exportCenter.historyTitle", {
                count: records.length,
                defaultValue: `导出历史记录（持久保存，共 ${records.length} 条）`,
              })}
            </p>
            {records.length === 0 ? (
              <p data-testid="export-history-empty" className="mt-1 text-xs text-muted-foreground">
                {t("novel.exportCenter.historyEmpty", { defaultValue: "暂无导出记录" })}
              </p>
            ) : (
              <ul data-testid="export-history-list" className="mt-1.5 flex flex-col gap-1.5">
                {records.map((record) => (
                  <li
                    key={record.id}
                    data-testid={`export-record-${record.success ? "success" : "failure"}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                  >
                    <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">{record.format}</span>
                    <span className="font-mono text-foreground">{record.path}</span>
                    <span>
                      {record.success
                        ? t("novel.exportCenter.recordSuccess", {
                            count: record.chapterCount,
                            defaultValue: `成功（${record.chapterCount} 章）`,
                          })
                        : t("novel.exportCenter.recordFailure", {
                            message: record.message,
                            defaultValue: `失败：${record.message}`,
                          })}
                    </span>
                    {record.includeDrafts ? (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning-foreground">
                        {t("novel.exportCenter.recordIncludedDrafts", { defaultValue: "含草稿" })}
                      </span>
                    ) : null}
                    {record.success ? (
                      <button
                        type="button"
                        data-testid="export-open-folder-button"
                        onClick={() => void handleOpenFolder(record.path)}
                        className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
                      >
                        <FolderOpen className="h-3 w-3" aria-hidden="true" />
                        {t("novel.exportCenter.openFolder", { defaultValue: "打开所在文件夹" })}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Dialog
            open={singlePdfDialog.open}
            onOpenChange={(open) => setSinglePdfDialog((prev) => ({ ...prev, open }))}
          >
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>
                  {t("novel.exportCenter.singlePdfDialogTitle", {
                    title: singlePdfDialog.title,
                    defaultValue: `单章精细 PDF 导出 · ${singlePdfDialog.title}`,
                  })}
                </DialogTitle>
              </DialogHeader>
              <PdfExportDialog
                projectPath={projectPath}
                title={singlePdfDialog.title}
                paragraphs={singlePdfDialog.paragraphs}
                chapterPath={singlePdfDialog.chapterPath}
              />
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  )
}
