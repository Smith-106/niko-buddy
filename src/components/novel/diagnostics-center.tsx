// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/**
 * J15 诊断中心 — 统一健康视图 + J14 反查用户入口 + 安全恢复 + 脱敏诊断包。
 *
 * 用户旅程：异常 → 打开诊断中心 → 看健康项（影响+建议+恢复按钮）→
 * 执行安全恢复 → 重新检测看更新 → 展开 J14 导出历史反查上下文 →
 * 预览脱敏诊断包 → 确认后导出。
 *
 * 纪律（J15 硬门禁）：
 * - 只读聚合展示：健康判定来自 collectHealthReport（读真源），本组件不判态。
 * - 恢复按钮只执行 `run != null` 的动作；confirm 级由容器弹确认；
 *   forbidden 级动作无 run，本组件不渲染按钮（只渲染为"需手动处理"文字）。
 * - 诊断包导出前必须先展示 preview（包含/排除/脱敏/保存位置），用户确认后
 *   才写盘（门禁 11）；包内容默认脱敏（门禁 10/12）。
 * - 中文标签直书（与 kb-health-view 同款约定），零新增 i18n 键。
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle2, Download, Eye, FileSearch, RefreshCw, Wrench } from "lucide-react"
import { ask, save } from "@tauri-apps/plugin-dialog"
import { writeFileAtomic } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import {
  collectHealthReport,
  type HealthItem,
  type HealthReport,
  type HealthStatus,
} from "@/lib/diagnostics/health-check"
import {
  buildDiagnosticBundle,
  previewDiagnosticBundle,
  sanitizeForBundle,
  serializeDiagnosticBundle,
  type DiagnosticBundlePreview,
} from "@/lib/diagnostics/diagnostic-bundle"
import { loadExportHistoryView, type ExportHistoryViewEntry } from "@/lib/export/export-history-view"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"

// ── 展示文案（直书中文，零 i18n 键） ─────────────────────────────────────────

const HEALTH_STATUS_ZH: Record<HealthStatus, string> = {
  healthy: "正常",
  degraded: "部分受限",
  attention_required: "需要处理",
  unavailable: "不可用",
  unknown: "未知",
}

const HISTORY_STATUS_ZH: Record<ExportHistoryViewEntry["status"], string> = {
  available: "可用",
  source_missing: "源缺失",
  output_missing: "产物缺失",
  partially_available: "部分可用",
  invalid: "记录损坏",
}

function statusBadgeClass(status: HealthStatus): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
    case "degraded":
      return "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    case "attention_required":
      return "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200"
    case "unavailable":
      return "bg-muted text-muted-foreground"
    case "unknown":
      return "bg-muted text-muted-foreground"
  }
}

// ── 展示组件（props 驱动，可单测） ───────────────────────────────────────────

export interface DiagnosticsCenterProps {
  report: HealthReport
  /** J14 反查入口数据（loadExportHistoryView 结果）。 */
  historyView: ExportHistoryViewEntry[]
  bundlePreview: DiagnosticBundlePreview | null
  loading: boolean
  /** 正在执行的恢复动作 "itemId:actionId"，无则 null。 */
  recovering: string | null
  recoverNote: string | null
  bundleNote: string | null
  onRecheck: () => void
  onRecover: (itemId: string, actionId: string) => void
  onPreviewBundle: () => void
  onExportBundle: () => void
}

function HealthItemRow({
  item,
  recovering,
  onRecover,
}: {
  item: HealthItem
  recovering: string | null
  onRecover: (itemId: string, actionId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const runnable = item.recoveries.filter((a) => a.run !== null)
  const manual = item.recoveries.filter((a) => a.run === null)
  return (
    <div
      data-testid={`health-item-${item.id}`}
      className="rounded-md border border-border bg-background px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid={`health-status-${item.id}`}
            className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass(item.status)}`}
          >
            {HEALTH_STATUS_ZH[item.status]}
          </span>
          <span className="truncate text-sm text-foreground">{item.objectName}</span>
        </div>
        <button
          type="button"
          data-testid={`health-expand-${item.id}`}
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
        >
          {expanded ? "收起" : "详情"}
        </button>
      </div>
      <p data-testid={`health-impact-${item.id}`} className="mt-1 text-sm text-foreground">
        {item.userImpact}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">建议：{item.suggestedAction}</p>
      {expanded ? (
        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          <p data-testid={`health-evidence-${item.id}`}>证据来源：{item.evidenceSource}</p>
          <p>检测时间：{item.checkedAt}</p>
          {item.errorCode ? (
            <p data-testid={`health-error-${item.id}`}>错误码：{item.errorCode}</p>
          ) : null}
          {item.technicalDetail ? <p>技术详情：{item.technicalDetail}</p> : null}
          {item.autoRecoverable ? <p>可自动恢复：是</p> : null}
        </div>
      ) : null}
      {runnable.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {runnable.map((a) => {
            const key = `${item.id}:${a.id}`
            const busy = recovering === key
            return (
              <button
                key={a.id}
                type="button"
                data-testid={`recover-${item.id}-${a.id}`}
                disabled={recovering !== null}
                onClick={() => onRecover(item.id, a.id)}
                title={a.level === "confirm" ? "需二次确认后执行" : "安全自动恢复（幂等）"}
                className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wrench className="h-3 w-3" />
                {busy ? "执行中…" : a.label}
                {a.level === "confirm" ? "（需确认）" : ""}
              </button>
            )
          })}
        </div>
      ) : null}
      {manual.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          需手动处理：{manual.map((a) => a.label).join("；")}
        </p>
      ) : null}
    </div>
  )
}

/** J14 反查用户入口（消化 J14-UI-001）：导出历史列表 + provenance 展开，只读。 */
function HistoryViewSection({ historyView }: { historyView: ExportHistoryViewEntry[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (historyView.length === 0) {
    return (
      <p data-testid="history-view-empty" className="text-xs text-muted-foreground">
        暂无导出历史记录。
      </p>
    )
  }
  return (
    <div data-testid="history-view-list" className="space-y-1.5">
      {historyView.map((v) => {
        const p = v.provenance
        const open = openId === v.entry.id
        return (
          <div
            key={v.entry.id}
            data-testid={`export-entry-${v.entry.id}`}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  data-testid={`export-status-${v.entry.id}`}
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass(
                    v.status === "available" ? "healthy" : v.status === "invalid" ? "attention_required" : "degraded",
                  )}`}
                >
                  {HISTORY_STATUS_ZH[v.status]}
                </span>
                <span className="truncate text-sm text-foreground">{v.entry.chapterTitle}</span>
              </div>
              <button
                type="button"
                data-testid={`export-open-${v.entry.id}`}
                onClick={() => setOpenId(open ? null : v.entry.id)}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
              >
                {open ? "收起" : "溯源"}
              </button>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              导出于 {v.entry.exportedAt} · {v.entry.pages} 页
            </p>
            {open ? (
              <div data-testid={`export-provenance-${v.entry.id}`} className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                <p>确认版本：{p.confirmedVersion.confirmedDigest || "（无）"}</p>
                <p>
                  写作会话：{p.run.sessionId || "（无会话）"}
                  {p.run.conversationId ? ` / ${p.run.conversationId}` : ""}
                  {!p.run.resolvable ? "（不可关联）" : ""}
                </p>
                <p>
                  源章节：{p.sourceAsset.chapterPath || "（无）"}
                  {p.sourceAsset.reachable
                    ? p.sourceAsset.resolvedPath && !p.sourceAsset.existsAtRecordedPath
                      ? `（已重命名→${p.sourceAsset.resolvedPath}）`
                      : "（可达）"
                    : "（缺失）"}
                </p>
                <p>
                  导出产物：{p.output.target || "（无）"}
                  {p.output.exists ? `（存在，${p.output.bytesWritten} 字节）` : "（缺失）"}
                </p>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** 诊断包导出预览（门禁 11：用户确认后才写盘）。 */
function BundleSection({
  preview,
  bundleNote,
  onPreviewBundle,
  onExportBundle,
}: {
  preview: DiagnosticBundlePreview | null
  bundleNote: string | null
  onPreviewBundle: () => void
  onExportBundle: () => void
}) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">诊断包（默认脱敏）</h3>
        <button
          type="button"
          data-testid="bundle-preview-btn"
          onClick={onPreviewBundle}
          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
        >
          生成预览
        </button>
      </div>
      {!preview ? (
        <p className="text-xs text-muted-foreground">
          导出前会先展示"将包含 / 将排除 / 已脱敏字段 / 保存位置"，确认后才写盘。默认排除凭据、正文全文与绝对路径。
        </p>
      ) : (
        <div data-testid="bundle-preview" className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          <p>将包含：{preview.included.join("；")}</p>
          <p>将排除：{preview.excluded.join("；")}</p>
          <p>已脱敏：{preview.sanitizedFields.join("；")}</p>
          <p>
            保存位置：{preview.targetPath}（约 {preview.approxBytes} 字节）
          </p>
          <button
            type="button"
            data-testid="bundle-export-btn"
            onClick={onExportBundle}
            className="mt-1 flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
          >
            <Download className="h-3 w-3" />
            确认并导出诊断包
          </button>
        </div>
      )}
      {bundleNote ? (
        <p data-testid="bundle-note" role="status" className="mt-1 text-xs text-foreground">
          {bundleNote}
        </p>
      ) : null}
    </div>
  )
}

export function DiagnosticsCenter(props: DiagnosticsCenterProps) {
  const { report } = props
  const groups: Array<{ status: HealthStatus; items: HealthItem[] }> = (
    ["attention_required", "unavailable", "degraded", "unknown", "healthy"] as HealthStatus[]
  ).map((status) => ({ status, items: report.items.filter((i) => i.status === status) }))

  return (
    <section data-testid="diagnostics-center" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">诊断中心</h2>
        <button
          type="button"
          data-testid="diagnostics-recheck"
          disabled={props.loading}
          onClick={props.onRecheck}
          className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" />
          {props.loading ? "检测中…" : "重新检测"}
        </button>
      </div>
      <p
        data-testid="diagnostics-overall"
        className={`rounded-md px-3 py-2 text-sm font-medium ${statusBadgeClass(report.overall)}`}
      >
        总体{HEALTH_STATUS_ZH[report.overall]} · {report.items.length} 项 · {report.checkedAt}
      </p>
      {props.recoverNote ? (
        <p data-testid="recover-note" role="status" className="flex items-center gap-1 text-xs text-foreground">
          <CheckCircle2 className="h-3 w-3" />
          {props.recoverNote}
        </p>
      ) : null}
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <div key={g.status} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {HEALTH_STATUS_ZH[g.status]}（{g.items.length}）
            </h3>
            {g.items.map((item) => (
              <HealthItemRow
                key={item.id}
                item={item}
                recovering={props.recovering}
                onRecover={props.onRecover}
              />
            ))}
          </div>
        ),
      )}
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <FileSearch className="h-4 w-4" />
        导出历史溯源（J14 反查入口）
      </h3>
      <HistoryViewSection historyView={props.historyView} />
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <Eye className="h-4 w-4" />
        诊断包导出
      </h3>
      <BundleSection
        preview={props.bundlePreview}
        bundleNote={props.bundleNote}
        onPreviewBundle={props.onPreviewBundle}
        onExportBundle={props.onExportBundle}
      />
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <AlertTriangle className="h-3 w-3" />
        诊断数据仅保存在本地，不会自动上传；删除项目、覆盖正文等危险操作不在此执行。
      </p>
    </section>
  )
}

// ── 宿主容器（接 store + IO，逻辑薄层） ──────────────────────────────────────

const BUNDLE_PROJECT_MARKERS = [".niko-buddy/", "QM/", ".novel/"]

export function DiagnosticsCenterView() {
  const { t } = useTranslation()
  // tOr 回退（与 backup-export-view 同款）：缺键时用中文兜底，不新增 i18n 键负担。
  const tOr = (key: string, defaultValue: string) => t(key, { defaultValue }) as string
  const project = useWikiStore((s) => s.project)
  const projectPath = project?.path ?? ""
  const [report, setReport] = useState<HealthReport | null>(null)
  const [historyView, setHistoryView] = useState<ExportHistoryViewEntry[]>([])
  const [bundlePreview, setBundlePreview] = useState<DiagnosticBundlePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [recovering, setRecovering] = useState<string | null>(null)
  const [recoverNote, setRecoverNote] = useState<string | null>(null)
  const [bundleNote, setBundleNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    try {
      const llmCfg = useWikiStore.getState().llmConfig
      const r = await collectHealthReport({ projectPath, llmCfg })
      setReport(r)
      setHistoryView(await loadExportHistoryView(projectPath))
      setBundlePreview(null)
      setBundleNote(null)
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRecover = useCallback(
    async (itemId: string, actionId: string) => {
      if (!report || recovering) return
      const action = report.items.find((i) => i.id === itemId)?.recoveries.find((a) => a.id === actionId)
      if (!action?.run) return
      if (action.level === "confirm") {
        const ok = await ask(`执行「${action.label}」？`, {
          title: "确认恢复操作",
          kind: "warning",
        })
        if (!ok) return
      }
      setRecovering(`${itemId}:${actionId}`)
      setRecoverNote(null)
      try {
        const res = await action.run()
        setRecoverNote(res.ok ? `恢复成功：${res.detail}` : `恢复未完成：${res.detail}`)
      } catch (e) {
        setRecoverNote(`恢复失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setRecovering(null)
        await refresh()
      }
    },
    [report, recovering, refresh],
  )

  const handlePreviewBundle = useCallback(async () => {
    if (!report || !projectPath) return
    const st = await loadNovelSessionStatus(projectPath).catch(() => null)
    const bundle = buildDiagnosticBundle({
      report,
      appVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "unknown",
      platform: typeof navigator !== "undefined" ? sanitizeForBundle(navigator.userAgent || "unknown") : "unknown",
      projectMarkers: BUNDLE_PROJECT_MARKERS,
      run: st
        ? { status: st.status, sessionId: st.session_id, hasCurrentTask: st.current_task != null }
        : null,
      exportEntryCount: historyView.length,
    })
    setBundlePreview(
      previewDiagnosticBundle({ bundle, targetPath: "diagnostic-bundle.json（由保存对话框确认）" }),
    )
    setBundleNote(null)
  }, [report, projectPath, historyView.length])

  const handleExportBundle = useCallback(async () => {
    if (!bundlePreview) return
    const out = await save({
      defaultPath: "diagnostic-bundle.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (!out) {
      setBundleNote("已取消导出。")
      return
    }
    await writeFileAtomic(out, serializeDiagnosticBundle(bundlePreview.bundle))
    setBundlePreview((p) => (p ? { ...p, targetPath: out } : p))
    setBundleNote(`诊断包已导出：${out}`)
  }, [bundlePreview])

  if (!projectPath) {
    return (
      <section data-testid="diagnostics-center-empty" className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">
          {tOr("novel.diagnostics.noProject", "请先打开一个项目再使用诊断中心。")}
        </p>
      </section>
    )
  }
  if (!report) {
    return (
      <section data-testid="diagnostics-center-loading" className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">正在检测…</p>
      </section>
    )
  }
  return (
    <DiagnosticsCenter
      report={report}
      historyView={historyView}
      bundlePreview={bundlePreview}
      loading={loading}
      recovering={recovering}
      recoverNote={recoverNote}
      bundleNote={bundleNote}
      onRecheck={() => void refresh()}
      onRecover={(itemId, actionId) => void handleRecover(itemId, actionId)}
      onPreviewBundle={() => void handlePreviewBundle()}
      onExportBundle={() => void handleExportBundle()}
    />
  )
}

export default DiagnosticsCenterView
