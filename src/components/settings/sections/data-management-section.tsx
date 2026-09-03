// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  Download,
  Upload,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  FileText,
  BookOpen,
  Database,
  Trash2,
  RefreshCw,
} from "lucide-react"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { Button } from "@/components/ui/button"
import { exportBackup, cancelBackup } from "@/lib/backup/export"
import { importBackup } from "@/lib/backup/import"
import { exportNovelDocx, exportNovelEpub, countFinalChapters, type DocxExportResult, type EbookExportResult } from "@/lib/novel/export"
import { countVectorChunks, legacyVectorRowCount, dropLegacyVectorTable } from "@/lib/embedding"
import { useWikiStore } from "@/stores/wiki-store"
import type {
  ExportResult,
  ImportResult,
  ImportStrategy,
  BackupProgressPayload,
} from "@/lib/backup/types"

/** Format byte count into a human-readable file size string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Data management section: export and import full application backups.
 * Supports full-overwrite and global-only import strategies.
 */
export function DataManagementSection() {
  const { t } = useTranslation()
  const currentProject = useWikiStore((s) => s.project)
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importStrategy, setImportStrategy] = useState<ImportStrategy>("full")
  const [progress, setProgress] = useState<BackupProgressPayload | null>(null)
  const [isExportingDocx, setIsExportingDocx] = useState(false)
  const [docxResult, setDocxResult] = useState<DocxExportResult | null>(null)
  const [docxProgress, setDocxProgress] = useState<{ current: number; total: number } | null>(null)
  const [isExportingEpub, setIsExportingEpub] = useState(false)
  const [epubResult, setEpubResult] = useState<EbookExportResult | null>(null)
  const [epubProgress, setEpubProgress] = useState<{ current: number; total: number } | null>(null)
  const [finalChapterCount, setFinalChapterCount] = useState<number | null>(null)
  const [vectorStats, setVectorStats] = useState<{ chunks: number; legacyRows: number } | null>(null)
  const [vectorLoading, setVectorLoading] = useState(false)
  const [cleaningLegacy, setCleaningLegacy] = useState(false)

  // DOCX export progress subscription (audit ③-4): the Rust side emits
  // "docx-export-progress" {current, total} per chapter while exporting.
  useEffect(() => {
    let unlistenDocx: UnlistenFn | undefined
    let unlistenEpub: UnlistenFn | undefined
    let cancelled = false
    void (async () => {
      try {
        unlistenDocx = await listen<{ current: number; total: number }>("docx-export-progress", (event) => {
          if (!cancelled) setDocxProgress(event.payload)
        })
        unlistenEpub = await listen<{ current: number; total: number }>("epub-export-progress", (event) => {
          if (!cancelled) setEpubProgress(event.payload)
        })
      } catch {
        // 非 Tauri 环境（vite 预览）无事件通道，进度条直接不显示。
      }
    })()
    return () => {
      cancelled = true
      unlistenDocx?.()
      unlistenEpub?.()
    }
  }, [])

  // Count final chapters so the DOCX export button can show an empty-state
  // hint and disable before the user starts an empty export.
  useEffect(() => {
    let cancelled = false
    if (!currentProject?.path) {
      setFinalChapterCount(null)
      return
    }
    void countFinalChapters(currentProject.path).then((count) => {
      if (!cancelled) setFinalChapterCount(count)
    })
    return () => {
      cancelled = true
    }
  }, [currentProject?.path])

  const loadVectorStats = useCallback(async () => {
    if (!currentProject?.path) {
      setVectorStats(null)
      return
    }
    setVectorLoading(true)
    try {
      const [chunks, legacyRows] = await Promise.all([
        countVectorChunks(currentProject.path),
        legacyVectorRowCount(currentProject.path),
      ])
      setVectorStats({ chunks, legacyRows })
    } catch {
      setVectorStats(null)
    } finally {
      setVectorLoading(false)
    }
  }, [currentProject?.path])

  useEffect(() => {
    void loadVectorStats()
  }, [loadVectorStats])

  async function handleCleanLegacy() {
    if (!currentProject?.path) return
    if (!window.confirm(t("settings.sections.dataManagement.vectorCleanConfirm", { defaultValue: "确定清理遗留（legacy）向量表？此操作不可恢复。" }))) return
    if (!window.confirm(t("settings.sections.dataManagement.vectorCleanConfirm2", { defaultValue: "再次确认：将删除 legacy 向量行并触发重建，继续吗？" }))) return
    setCleaningLegacy(true)
    try {
      await dropLegacyVectorTable(currentProject.path)
      await loadVectorStats()
    } finally {
      setCleaningLegacy(false)
    }
  }

  const handleProgress = useCallback((payload: BackupProgressPayload) => {
    setProgress(payload)
  }, [])

  async function handleExport() {
    setIsExporting(true)
    setExportResult(null)
    setProgress(null)
    try {
      const result = await exportBackup(handleProgress)
      setExportResult(result)
    } catch (err) {
      setExportResult({
        success: false,
        warnings: [],
        fileCount: 0,
        totalSize: 0,
        error: String(err),
      })
    } finally {
      setIsExporting(false)
      setProgress((p) => (p && p.stage === "done" ? p : null))
    }
  }

  async function handleImport() {
    setIsImporting(true)
    setImportResult(null)
    setProgress(null)
    try {
      const result = await importBackup(importStrategy, undefined, handleProgress)
      setImportResult(result)
    } catch (err) {
      setImportResult({
        success: false,
        appState: null,
        localStorageData: null,
        projects: [],
        warnings: [],
        error: String(err),
      })
    } finally {
      setIsImporting(false)
      setProgress((p) => (p && p.stage === "done" ? p : null))
    }
  }

  async function handleExportDocx() {
    /* v8 ignore next -- 按钮在无 project 时 disabled，守卫不可达 */
    if (!currentProject?.path) return
    setIsExportingDocx(true)
    setDocxResult(null)
    setDocxProgress(null)
    try {
      const result = await exportNovelDocx({
        projectPath: currentProject.path,
        exportPath: `${currentProject.path}/complete-novel.docx`,
      })
      setDocxResult(result)
    } catch (err) {
      setDocxResult({
        success: false,
        exportedPath: "",
        chapterCount: 0,
        message: String(err),
      })
    } finally {
      setIsExportingDocx(false)
      setDocxProgress(null)
    }
  }

  async function handleExportEpub() {
    /* v8 ignore next -- 按钮在无 project 时 disabled，守卫不可达 */
    if (!currentProject?.path) return
    setIsExportingEpub(true)
    setEpubResult(null)
    setEpubProgress(null)
    try {
      const result = await exportNovelEpub({
        projectPath: currentProject.path,
        exportPath: `${currentProject.path}/complete-novel.epub`,
      })
      setEpubResult(result)
    } catch (err) {
      setEpubResult({
        success: false,
        exportedPath: "",
        chapterCount: 0,
        message: String(err),
      })
    } finally {
      setIsExportingEpub(false)
      setEpubProgress(null)
    }
  }

  const isBusy = isExporting || isImporting

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.dataManagement.title", { defaultValue: "数据管理" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.dataManagement.description", {
            defaultValue: "备份和恢复你的所有数据，包括模型配置、AI对话、小说内容、大纲、记忆库、拆书结果等。",
          })}
        </p>
      </div>

      {/* Progress bar */}
      {progress && isBusy && (
        <div className="rounded-lg border p-4 space-y-2">
          <p className="text-sm font-medium">{progress.message}</p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{
                width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {progress.current} / {progress.total}
          </p>
        </div>
      )}

      {/* Export card */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5 text-primary" />
          <h3 className="font-medium">
            {t("settings.sections.dataManagement.exportTitle", { defaultValue: "导出备份" })}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.dataManagement.exportDescription", {
            defaultValue: "将所有数据打包为一个 zip 文件，用于重装系统前备份。包含：全局配置、所有项目数据、UI偏好。",
          })}
        </p>
        <Button onClick={handleExport} disabled={isBusy}>
          {isExporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.dataManagement.exporting", { defaultValue: "导出中..." })}
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              {t("settings.sections.dataManagement.exportButton", { defaultValue: "导出备份" })}
            </>
          )}
        </Button>
        {isExporting && (
          <Button variant="outline" onClick={() => void cancelBackup()}>
            {t("settings.sections.dataManagement.cancelExport", { defaultValue: "取消导出" })}
          </Button>
        )}
        {exportResult && (
          <div className="text-sm space-y-1">
            {exportResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p>{t("settings.sections.dataManagement.exportSuccess", { defaultValue: "导出成功" })}</p>
                  <p className="text-muted-foreground">
                    {t("settings.sections.dataManagement.fileCount", {
                      defaultValue: "共 {{count}} 个文件，{{size}}",
                      count: exportResult.fileCount,
                      size: formatSize(exportResult.totalSize),
                    })}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{exportResult.error}</p>
              </div>
            )}
            {exportResult.warnings.length > 0 && (
              <div className="text-yellow-600 text-xs space-y-1">
                {exportResult.warnings.map((w, i) => (
                  <p key={i}>⚠ {w}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Novel DOCX export card */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" />
          <h3 className="font-medium">
            {t("settings.sections.dataManagement.docxExportTitle", { defaultValue: "导出小说 Word 文档" })}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.dataManagement.docxExportDescription", {
            defaultValue: "将当前项目的 final 状态章节导出为单个 .docx 文件（Word 可打开），用于投稿或离线阅读。",
          })}
        </p>
        <Button onClick={() => void handleExportDocx()} disabled={isBusy || isExportingDocx || !currentProject?.path || finalChapterCount === 0}>
          {isExportingDocx ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.dataManagement.docxExporting", { defaultValue: "导出中..." })}
            </>
          ) : (
            <>
              <FileText className="mr-2 h-4 w-4" />
              {t("settings.sections.dataManagement.docxExportButton", { defaultValue: "导出 Word 文档" })}
            </>
          )}
        </Button>
        {!currentProject?.path && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.dataManagement.docxNoProject", { defaultValue: "请先打开项目" })}
          </p>
        )}
        {currentProject?.path && finalChapterCount === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.dataManagement.docxEmptyChapters", { defaultValue: "章节为空：没有 final 状态章节可导出" })}
          </p>
        )}
        {docxProgress && docxProgress.total > 0 && (
          <div className="space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round((docxProgress.current / docxProgress.total) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.dataManagement.docxExportProgress", {
                defaultValue: "{{current}} / {{total}}",
                current: docxProgress.current,
                total: docxProgress.total,
              })}
            </p>
          </div>
        )}
        {docxResult && (
          <div className="text-sm space-y-1">
            {docxResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p>{t("settings.sections.dataManagement.docxExportSuccess", { defaultValue: "导出成功" })}</p>
                  <p className="text-muted-foreground">
                    {t("settings.sections.dataManagement.docxExportCount", {
                      defaultValue: "共 {{count}} 个章节",
                      count: docxResult.chapterCount,
                    })}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{docxResult.message}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Novel EPUB export card（54 号设计 ⑥） */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <h3 className="font-medium">
            {t("settings.sections.dataManagement.epubExportTitle", { defaultValue: "导出小说 EPUB 电子书" })}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.dataManagement.epubExportDescription", {
            defaultValue: "将当前项目的 final 状态章节导出为单个 .epub 文件（EPUB3 最小合规），可用于阅读器 / 投稿渠道。",
          })}
        </p>
        <Button onClick={() => void handleExportEpub()} disabled={isBusy || isExportingEpub || !currentProject?.path || finalChapterCount === 0}>
          {isExportingEpub ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.dataManagement.epubExporting", { defaultValue: "导出中..." })}
            </>
          ) : (
            <>
              <BookOpen className="mr-2 h-4 w-4" />
              {t("settings.sections.dataManagement.epubExportButton", { defaultValue: "导出 EPUB 电子书" })}
            </>
          )}
        </Button>
        {!currentProject?.path && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.dataManagement.epubNoProject", { defaultValue: "请先打开项目" })}
          </p>
        )}
        {currentProject?.path && finalChapterCount === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.dataManagement.epubEmptyChapters", { defaultValue: "章节为空：没有 final 状态章节可导出" })}
          </p>
        )}
        {epubProgress && epubProgress.total > 0 && (
          <div className="space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round((epubProgress.current / epubProgress.total) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.dataManagement.epubExportProgress", {
                defaultValue: "{{current}} / {{total}}",
                current: epubProgress.current,
                total: epubProgress.total,
              })}
            </p>
          </div>
        )}
        {epubResult && (
          <div className="text-sm space-y-1">
            {epubResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p>{t("settings.sections.dataManagement.epubExportSuccess", { defaultValue: "导出成功" })}</p>
                  <p className="text-muted-foreground">
                    {t("settings.sections.dataManagement.docxExportCount", {
                      defaultValue: "共 {{count}} 个章节",
                      count: epubResult.chapterCount,
                    })}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{epubResult.message}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Vector store card — 向量库统计与 legacy 清理（audit ①-5） */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <h3 className="font-medium">
            {t("settings.sections.dataManagement.vectorTitle", { defaultValue: "向量库" })}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.dataManagement.vectorDescription", {
            defaultValue: "统计当前项目已索引的向量 chunk 数与遗留（legacy）行数；可清理 legacy 表后重新索引。",
          })}
        </p>
        {!currentProject?.path ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.sections.dataManagement.vectorNoProject", { defaultValue: "请先打开项目" })}
          </p>
        ) : vectorLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("settings.sections.dataManagement.vectorLoading", { defaultValue: "加载中…" })}
          </div>
        ) : (
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-md bg-muted/50 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {t("settings.sections.dataManagement.vectorChunksLabel", { defaultValue: "已索引 chunk" })}
              </div>
              <div className="font-medium">{vectorStats?.chunks ?? "—"}</div>
            </div>
            <div className="rounded-md bg-muted/50 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {t("settings.sections.dataManagement.vectorLegacyLabel", { defaultValue: "legacy 行" })}
              </div>
              <div className="font-medium">{vectorStats?.legacyRows ?? "—"}</div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void handleCleanLegacy()}
            disabled={!currentProject?.path || cleaningLegacy || !vectorStats || vectorStats.legacyRows === 0}
          >
            {cleaningLegacy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("settings.sections.dataManagement.vectorCleaning", { defaultValue: "清理中..." })}
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                {t("settings.sections.dataManagement.vectorCleanButton", { defaultValue: "清理 legacy 表" })}
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadVectorStats()}
            disabled={vectorLoading || !currentProject?.path}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("settings.sections.dataManagement.vectorRefresh", { defaultValue: "刷新" })}
          </Button>
        </div>
      </div>

      {/* Import card */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-primary" />
          <h3 className="font-medium">
            {t("settings.sections.dataManagement.importTitle", { defaultValue: "导入备份" })}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.sections.dataManagement.importDescription", {
            defaultValue: "从 zip 备份文件恢复数据。项目数据会立即刷新，全局配置更改可能需要重启软件生效。",
          })}
        </p>

        {/* Import strategy radio */}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {t("settings.sections.dataManagement.importStrategy", { defaultValue: "导入方式" })}
          </label>
          <div className="space-y-1">
            {([
              { value: "full" as const, label: "完全覆盖（清除当前所有数据）" },
              { value: "global-only" as const, label: "仅导入全局配置（模型、UI偏好）" },
            ]).map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="import-strategy"
                  value={opt.value}
                  checked={importStrategy === opt.value}
                  onChange={(e) => setImportStrategy(e.target.value as ImportStrategy)}
                  className="cursor-pointer"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <Button onClick={handleImport} disabled={isBusy} variant="outline">
          {isImporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.sections.dataManagement.importing", { defaultValue: "导入中..." })}
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              {t("settings.sections.dataManagement.importButton", { defaultValue: "导入备份" })}
            </>
          )}
        </Button>

        {importResult && (
          <div className="text-sm space-y-1">
            {importResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p>{t("settings.sections.dataManagement.importSuccess", { defaultValue: "导入成功，项目数据已自动刷新，部分全局配置可能需要重启生效" })}</p>
                  {importResult.projects?.length > 0 && (
                    <p className="text-muted-foreground">
                      {t("settings.sections.dataManagement.restoredProjects", {
                        defaultValue: "已恢复 {{count}} 个项目",
                        count: importResult.projects.filter((p) => p.success).length,
                      })}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{importResult.error}</p>
              </div>
            )}
            {importResult.warnings?.length > 0 && (
              <div className="text-yellow-600 text-xs space-y-1">
                {importResult.warnings.map((w, i) => (
                  <p key={i}>⚠ {w}</p>
                ))}
              </div>
            )}
            {importResult.projects?.some((p) => !p.success) && (
              <div className="text-red-600 text-xs space-y-1">
                {importResult.projects.filter((p) => !p.success).map((p, i) => (
                  <p key={i}>✗ {p.id}: {p.error}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Security warning */}
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-200">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <p>
            {t("settings.sections.dataManagement.securityWarning", {
              defaultValue: "备份文件包含 API 密钥等敏感信息，请妥善保管，不要分享给他人。",
            })}
          </p>
        </div>
      </div>
    </div>
  )
}
