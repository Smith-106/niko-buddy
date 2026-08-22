// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/**
 * T34c 项目级一键备份/恢复/导出视图。
 *
 * 与设置页「数据管理」的**全局**备份（i18n exportTitle，打包所有项目配置 +
 * app-state）严格区分：本视图是**单项目**入口，包内容 =
 * `.novel/status.json`（会话状态唯一真源）+ `.novel/drafts/`（草稿工件）+
 * `.qmai/lancedb/`（Canon 三表 LanceDB 快照），zip + SHA-256 校验和
 * （sidecar `.sha256` + 包内 manifest 双层校验）。
 *
 * - 导出：save 对话框选路径 → `canon_export_project`；可选本地口令
 *   （AES-256，纯本地，不上云、不持久化）。
 * - 恢复：open 对话框选 zip → 二次确认 → `canon_restore_project`
 *   （校验通过后原子替换；替换前自动备份现状）。
 * - 自动备份：supersede / schema 迁移前由编排层或用户手动触发
 *   `canon_auto_backup`。
 */

import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  ShieldCheck,
} from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { ask, open, save } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"

// ── IPC 契约（与 src-tauri/src/canon_export.rs camelCase 一一对应）──

export interface CanonExportRequest {
  projectPath: string
  outputZipPath: string
  passphrase?: string | null
}

export interface CanonExportResult {
  success: boolean
  warnings: string[]
  fileCount: number
  totalSize: number
  checksumSha256: string | null
  sidecarPath: string | null
  error: string | null
}

export interface CanonRestoreRequest {
  projectPath: string
  zipPath: string
  expectedChecksum?: string | null
  passphrase?: string | null
}

export interface CanonRestoreResult {
  success: boolean
  restoredStatus: boolean
  restoredDrafts: boolean
  restoredCanonLancedb: boolean
  restoredFiles: number
  checksumVerified: boolean | null
  autoBackupPath: string | null
  warnings: string[]
  error: string | null
}

export interface CanonVerifyRequest {
  zipPath: string
  expectedChecksum?: string | null
  passphrase?: string | null
}

export interface CanonVerifyResult {
  success: boolean
  containerChecksumMatches: boolean | null
  computedChecksum: string | null
  manifestFound: boolean
  fileCount: number
  contentDigestVerified: boolean
  warnings: string[]
  error: string | null
}

export interface CanonAutoBackupRequest {
  projectPath: string
  reason: string
}

export interface CanonAutoBackupResult {
  success: boolean
  backupPath: string | null
  checksumSha256: string | null
  warnings: string[]
  error: string | null
}

// ── invoke 薄封装（导出供测试替身断言）──

export function invokeCanonExportProject(request: CanonExportRequest): Promise<CanonExportResult> {
  return invoke<CanonExportResult>("canon_export_project", { request })
}

export function invokeCanonRestoreProject(request: CanonRestoreRequest): Promise<CanonRestoreResult> {
  return invoke<CanonRestoreResult>("canon_restore_project", { request })
}

export function invokeCanonVerifyExport(request: CanonVerifyRequest): Promise<CanonVerifyResult> {
  return invoke<CanonVerifyResult>("canon_verify_export", { request })
}

export function invokeCanonAutoBackup(request: CanonAutoBackupRequest): Promise<CanonAutoBackupResult> {
  return invoke<CanonAutoBackupResult>("canon_auto_backup", { request })
}

/** 导出包默认文件名：niko-buddy-project-backup-YYYYMMDD-HHMMSS.zip */
export function defaultExportName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `niko-buddy-project-backup-${stamp}.zip`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="text-yellow-600 text-xs space-y-1">
      {items.map((w, i) => (
        <p key={i}>⚠ {w}</p>
      ))}
    </div>
  )
}

/**
 * 项目级备份/恢复/导出面板。挂在项目工作区侧栏/工具页使用；
 * 未打开项目时整体禁用。
 */
export function BackupExportView() {
  const { t } = useTranslation()
  const currentProject = useWikiStore((s) => s.project)
  const projectPath = currentProject?.path ?? ""

  const [passphrase, setPassphrase] = useState("")
  const [isBusy, setIsBusy] = useState<"export" | "restore" | "auto" | null>(null)
  const [exportResult, setExportResult] = useState<CanonExportResult | null>(null)
  const [restoreResult, setRestoreResult] = useState<CanonRestoreResult | null>(null)
  const [autoResult, setAutoResult] = useState<CanonAutoBackupResult | null>(null)

  const tOr = useCallback(
    (key: string, defaultValue: string) => t(key, { defaultValue }) as string,
    [t],
  )

  async function handleExport() {
    /* v8 ignore next -- 无项目时按钮 disabled，守卫不可达 */
    if (!projectPath) return
    setIsBusy("export")
    setExportResult(null)
    try {
      const outputPath = await save({
        defaultPath: defaultExportName(),
        filters: [{ name: "ZIP 备份文件", extensions: ["zip"] }],
      })
      if (!outputPath) {
        setExportResult({
          success: false,
          warnings: [],
          fileCount: 0,
          totalSize: 0,
          checksumSha256: null,
          sidecarPath: null,
          error: tOr("novel.backupExport.cancelled", "已取消"),
        })
        return
      }
      const result = await invokeCanonExportProject({
        projectPath,
        outputZipPath: outputPath,
        passphrase: passphrase.trim() || null,
      })
      setExportResult(result)
    } catch (err) {
      setExportResult({
        success: false,
        warnings: [],
        fileCount: 0,
        totalSize: 0,
        checksumSha256: null,
        sidecarPath: null,
        error: String(err),
      })
    } finally {
      setIsBusy(null)
    }
  }

  async function handleRestore() {
    /* v8 ignore next -- 无项目时按钮 disabled，守卫不可达 */
    if (!projectPath) return
    setIsBusy("restore")
    setRestoreResult(null)
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "项目备份包", extensions: ["zip"] }],
      })
      const zipPath = typeof picked === "string" ? picked : null
      if (!zipPath) {
        setRestoreResult({
          success: false,
          restoredStatus: false,
          restoredDrafts: false,
          restoredCanonLancedb: false,
          restoredFiles: 0,
          checksumVerified: null,
          autoBackupPath: null,
          warnings: [],
          error: tOr("novel.backupExport.cancelled", "已取消"),
        })
        return
      }
      const confirmed = await ask(
        tOr(
          "novel.backupExport.restoreConfirm",
          "恢复将覆盖当前项目的 status.json、草稿与 Canon 数据（替换前会自动备份现状）。确定继续？",
        ),
        { title: tOr("novel.backupExport.restoreConfirmTitle", "确认恢复"), kind: "warning" },
      )
      if (!confirmed) {
        setRestoreResult({
          success: false,
          restoredStatus: false,
          restoredDrafts: false,
          restoredCanonLancedb: false,
          restoredFiles: 0,
          checksumVerified: null,
          autoBackupPath: null,
          warnings: [],
          error: tOr("novel.backupExport.cancelled", "已取消"),
        })
        return
      }
      const result = await invokeCanonRestoreProject({
        projectPath,
        zipPath,
        passphrase: passphrase.trim() || null,
      })
      setRestoreResult(result)
    } catch (err) {
      setRestoreResult({
        success: false,
        restoredStatus: false,
        restoredDrafts: false,
        restoredCanonLancedb: false,
        restoredFiles: 0,
        checksumVerified: null,
        autoBackupPath: null,
        warnings: [],
        error: String(err),
      })
    } finally {
      setIsBusy(null)
    }
  }

  async function handleAutoBackup() {
    /* v8 ignore next -- 无项目时按钮 disabled，守卫不可达 */
    if (!projectPath) return
    setIsBusy("auto")
    setAutoResult(null)
    try {
      const result = await invokeCanonAutoBackup({
        projectPath,
        reason: "pre-supersede-manual",
      })
      setAutoResult(result)
    } catch (err) {
      setAutoResult({
        success: false,
        backupPath: null,
        checksumSha256: null,
        warnings: [],
        error: String(err),
      })
    } finally {
      setIsBusy(null)
    }
  }

  return (
    <div className="space-y-6" data-testid="backup-export-view">
      {/* Header：明确与全局导出区分 */}
      <div>
        <h2 className="text-xl font-semibold">
          {tOr("novel.backupExport.title", "项目备份与恢复")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {tOr(
            "novel.backupExport.description",
            "当前项目的独立备份包：status.json（会话状态）+ drafts（草稿）+ Canon LanceDB 快照，zip + SHA-256 校验和。全局配置备份请到 设置 → 数据管理。",
          )}
        </p>
      </div>

      {/* 可选本地口令 */}
      <div className="rounded-lg border p-4 space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <Label htmlFor="backup-passphrase" className="font-medium">
            {tOr("novel.backupExport.passphraseLabel", "本地口令（可选）")}
          </Label>
        </div>
        <Input
          id="backup-passphrase"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={tOr("novel.backupExport.passphrasePlaceholder", "留空则不加密；仅用于本次操作")}
          disabled={isBusy !== null}
        />
        <p className="text-xs text-muted-foreground">
          {tOr(
            "novel.backupExport.passphraseNote",
            "AES-256 本地加密，不连接云端；口令不会保存，丢失后备份将无法恢复。",
          )}
        </p>
      </div>

      {/* 导出卡片 */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5 text-primary" />
          <h3 className="font-medium">{tOr("novel.backupExport.exportTitle", "导出项目备份包")}</h3>
        </div>
        <Button onClick={() => void handleExport()} disabled={!projectPath || isBusy !== null}>
          {isBusy === "export" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {tOr("novel.backupExport.exporting", "导出中...")}
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              {tOr("novel.backupExport.exportButton", "导出备份包")}
            </>
          )}
        </Button>
        {exportResult && (
          <div className="text-sm space-y-1">
            {exportResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <p>
                    {tOr("novel.backupExport.exportSuccess", "导出成功")}：
                    {exportResult.fileCount} {tOr("novel.backupExport.filesUnit", "个文件")}，
                    {formatSize(exportResult.totalSize)}
                  </p>
                  {exportResult.checksumSha256 && (
                    <p className="font-mono text-xs break-all text-muted-foreground select-all">
                      SHA-256: {exportResult.checksumSha256}
                    </p>
                  )}
                  {exportResult.sidecarPath && (
                    <p className="text-xs text-muted-foreground">
                      {tOr("novel.backupExport.sidecarWritten", "校验和文件")}: {exportResult.sidecarPath}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{exportResult.error}</p>
              </div>
            )}
            <Warnings items={exportResult.warnings} />
          </div>
        )}
      </div>

      {/* 恢复卡片 */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ArchiveRestore className="h-5 w-5 text-primary" />
          <h3 className="font-medium">{tOr("novel.backupExport.restoreTitle", "从备份包恢复")}</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {tOr(
            "novel.backupExport.restoreDescription",
            "校验（SHA-256 + 内容摘要）通过后原子替换当前项目数据；替换前自动备份现状到 backups/auto/。",
          )}
        </p>
        <Button
          onClick={() => void handleRestore()}
          disabled={!projectPath || isBusy !== null}
          variant="outline"
        >
          {isBusy === "restore" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {tOr("novel.backupExport.restoring", "恢复中...")}
            </>
          ) : (
            <>
              <ArchiveRestore className="mr-2 h-4 w-4" />
              {tOr("novel.backupExport.restoreButton", "选择备份包并恢复")}
            </>
          )}
        </Button>
        {restoreResult && (
          <div className="text-sm space-y-1">
            {restoreResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <p>
                    {tOr("novel.backupExport.restoreSuccess", "恢复成功")}：
                    {restoreResult.restoredFiles} {tOr("novel.backupExport.filesUnit", "个文件")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    status: {restoreResult.restoredStatus ? "✓" : "—"} · drafts:{" "}
                    {restoreResult.restoredDrafts ? "✓" : "—"} · canon:{" "}
                    {restoreResult.restoredCanonLancedb ? "✓" : "—"}
                  </p>
                  {restoreResult.autoBackupPath && (
                    <p className="text-xs text-muted-foreground">
                      {tOr("novel.backupExport.autoBackupTaken", "替换前自动备份")}:{" "}
                      {restoreResult.autoBackupPath}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{restoreResult.error}</p>
              </div>
            )}
            <Warnings items={restoreResult.warnings} />
          </div>
        )}
      </div>

      {/* 自动备份卡片（supersede / 迁移前保护） */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h3 className="font-medium">{tOr("novel.backupExport.autoTitle", "自动备份（supersede / 迁移前）")}</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {tOr(
            "novel.backupExport.autoDescription",
            "在执行 Canon supersede 或 schema 迁移等破坏性写操作前，先落一份带校验和的时间戳快照到 backups/auto/。",
          )}
        </p>
        <Button onClick={() => void handleAutoBackup()} disabled={!projectPath || isBusy !== null} variant="outline">
          {isBusy === "auto" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {tOr("novel.backupExport.autoRunning", "备份中...")}
            </>
          ) : (
            <>
              <ShieldCheck className="mr-2 h-4 w-4" />
              {tOr("novel.backupExport.autoButton", "立即自动备份")}
            </>
          )}
        </Button>
        {autoResult && (
          <div className="text-sm space-y-1">
            {autoResult.success ? (
              <div className="flex items-start gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <p>{tOr("novel.backupExport.autoSuccess", "自动备份完成")}</p>
                  <p className="text-xs text-muted-foreground break-all">{autoResult.backupPath}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <p>{autoResult.error}</p>
              </div>
            )}
            <Warnings items={autoResult.warnings} />
          </div>
        )}
      </div>
    </div>
  )
}
