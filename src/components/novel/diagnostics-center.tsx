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

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { AgentStudioPanelMounted } from "./agent-studio-panel"
import { ClosurePanel } from "./closure-panel"
import { MethodologyPanel } from "./methodology-panel"
import { PromptRegistryPanel } from "./prompt-registry-panel"
import { SkillPromptCoveragePanel } from "./skill-prompt-coverage-panel"
import { WorkflowTemplatePanel } from "./workflow-template-panel"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Download, Eye, FileSearch, RefreshCw, Wrench } from "lucide-react"
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
import { loadNovelSessionStatus } from "@/lib/novel"
import { KbHealthView } from "./kb-health-view"
import { collectKbMetricsLive, type KbMetrics } from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"
import { normalizePath } from "@/lib/path-utils"

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
      return "bg-success/10 text-success-foreground"
    case "degraded":
      return "bg-warning/10 text-warning-foreground"
    case "attention_required":
      return "bg-destructive/10 text-destructive"
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
  /** 已有报告状态下重新检测失败的错误文案（U4-08）。 */
  recheckError?: string | null
  onRecheck: () => void
  onRecover: (itemId: string, actionId: string) => void
  onPreviewBundle: () => void
  onExportBundle: () => void
  /** KB/记忆健康 6 指标快照（缺源项 value=null 显式 N/A）；缺省不渲染该面板。 */
  kbMetrics?: KbMetrics | null
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
  const panelId = useId()
  const runnable = item.recoveries.filter((a) => a.level !== "forbidden" && a.run !== null)
  const manual = item.recoveries.filter((a) => a.level === "forbidden" || a.run === null)
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
          aria-expanded={expanded}
          aria-controls={panelId}
          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "收起" : "详情"}
        </button>
      </div>
      <p data-testid={`health-impact-${item.id}`} className="mt-1 text-sm text-foreground">
        {item.userImpact}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">建议：{item.suggestedAction}</p>
      {expanded ? (
        <div id={panelId} role="region" aria-label={`${item.objectName}详情`} className="mt-1 space-y-0.5 text-xs text-muted-foreground">
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
          需手动处理：
          <span className="inline-flex flex-wrap items-center gap-1">
            {manual?.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-foreground"
              >
                {a.label}
              </span>
            ))}
          </span>
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
                aria-expanded={open}
                aria-controls={`history-provenance-${v.entry.id}`}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {open ? "收起" : "溯源"}
              </button>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              导出于 {v.entry.exportedAt} · {v.entry.pages} 页
            </p>
            {open ? (
              <div id={`history-provenance-${v.entry.id}`} role="region" aria-label={`${v.entry.chapterTitle}溯源`} data-testid={`export-provenance-${v.entry.id}`} className="mt-1 space-y-0.5 text-xs text-muted-foreground">
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
          <p>
            将包含：
            <span className="inline-flex flex-wrap items-center gap-1">
              {preview.included?.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-foreground"
                >
                  {s}
                </span>
              ))}
            </span>
          </p>
          <p>
            将排除：
            <span className="inline-flex flex-wrap items-center gap-1">
              {preview.excluded?.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-foreground"
                >
                  {s}
                </span>
              ))}
            </span>
          </p>
          <p>
            已脱敏：
            <span className="inline-flex flex-wrap items-center gap-1">
              {preview.sanitizedFields?.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-foreground"
                >
                  {s}
                </span>
              ))}
            </span>
          </p>
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
      {props.recheckError ? (
        <div
          role="alert"
          data-testid="diagnostics-center-recheck-error"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>重新检测失败：{props.recheckError}</span>
        </div>
      ) : null}
      {/* KB/记忆健康 6 指标（GOV-OBS-01）：数据源 collectKbMetricsLive，缺源显式 N/A，
          绝不伪造数值。metrics 缺省（未拿到项目路径/未装载）→ 不渲染，避免假面板。 */}
      {props.kbMetrics ? (
        <>
          <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
            <FileSearch className="h-4 w-4" />
            知识库与记忆健康（6 指标）
          </h3>
          <KbHealthView metrics={props.kbMetrics} />
        </>
      ) : null}
      {props.recoverNote ? (
        <p data-testid="recover-note" role="status" className="flex items-center gap-1 text-xs text-foreground">
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
      {/* 只读审计区（默认折叠）：健康/恢复/导出仍是首屏主角，审计不抢首屏。 */}
      <details data-testid="diagnostics-audit-section" className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground">
          只读审计（提示词 / 方法论 / 模板 / 技能覆盖 / 叙事结构 / 设置盘点）
        </summary>
        <div className="mt-3 space-y-4">
          <PromptRegistryPanel />
          <MethodologyPanel />
          <WorkflowTemplatePanel />
          <SkillPromptCoveragePanel />
          <ClosurePanel />
          <AgentStudioPanelMounted />
        </div>
      </details>
    </section>
  )
}

// ── 宿主容器（接 store + IO，逻辑薄层） ──────────────────────────────────────

const BUNDLE_PROJECT_MARKERS = [".niko-buddy/", "QM/", ".novel/"]

export function DiagnosticsCenterView() {
  const { t } = useTranslation()
  // tOr 回退（与 backup-export-view 同款）：支持插值参数，缺键时用中文兜底。
  const tOr = useCallback(
    (key: string, defaultValue: string, params?: Record<string, string | number>) =>
      t(key, { defaultValue, ...params }) as string,
    [t],
  )
  const project = useWikiStore((s) => s.project)
  const projectPath = project?.path ?? ""
  const [report, setReport] = useState<HealthReport | null>(null)
  const [historyView, setHistoryView] = useState<ExportHistoryViewEntry[]>([])
  const [bundlePreview, setBundlePreview] = useState<DiagnosticBundlePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<string | null>(null)
  const [recoverNote, setRecoverNote] = useState<string | null>(null)
  const [bundleNote, setBundleNote] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const projectGenRef = useRef(0)
  const refreshRequestIdRef = useRef(0)
  const previewRequestIdRef = useRef(0)
  const recoveryInFlight = useRef(false)
  const bundleExportInFlight = useRef(false)
  // KB/记忆健康 6 指标：真实采集（promotion 重放率走 promotion-bridge 凭证层），
  // 失败/缺源 → collectKbMetrics 显式 N/A（诚实降级，不造数）。
  const [kbMetrics, setKbMetrics] = useState<KbMetrics | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 项目切换/关闭时作废在途请求并清空旧项目的报告与提示状态，避免跨项目或 ABA 串写。
  useEffect(() => {
    projectGenRef.current += 1
    refreshRequestIdRef.current += 1
    previewRequestIdRef.current += 1
    setReport(null)
    setHistoryView([])
    setKbMetrics(null)
    setBundlePreview(null)
    setBundleNote(null)
    setRecovering(null)
    setRecoverNote(null)
    setLoadError(null)
  }, [projectPath])

  const refresh = useCallback(async () => {
    if (!projectPath) return
    const gen = projectGenRef.current
    const requestId = ++refreshRequestIdRef.current
    const startedProject = normalizePath(projectPath)
    const isCurrent = () =>
      mountedRef.current &&
      projectGenRef.current === gen &&
      refreshRequestIdRef.current === requestId &&
      normalizePath(useWikiStore.getState().project?.path ?? "") === startedProject

    setLoading(true)
    setLoadError(null)
    try {
      const llmCfg = useWikiStore.getState().llmConfig
      const r = await collectHealthReport({ projectPath, llmCfg })
      if (!isCurrent()) return
      const metrics = await collectKbMetricsLive({ projectPath }).catch(() => null)
      if (!isCurrent()) return
      const history = await loadExportHistoryView(projectPath)
      if (!isCurrent()) return
      setReport(r)
      setKbMetrics(metrics)
      setHistoryView(history)
      setBundlePreview(null)
      setBundleNote(null)
      setLoadError(null)
    } catch (e) {
      if (!isCurrent()) return
      setLoadError(toErrorMessage(e))
    } finally {
      if (mountedRef.current && projectGenRef.current === gen && refreshRequestIdRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRecover = useCallback(
    async (itemId: string, actionId: string) => {
      /* v8 ignore next -- 台账 diagnostics-center.tsx：handleRecover 的守卫是渲染前提：wrapper 在 !report 时提前返回 loading 态（L578-583），内层组件不会挂载；recovering 侧被恢复按钮的 disabled={recovering !== null}（L168）提前挡住 */
      if (!report || recovering) return
      const action = report.items.find((i) => i.id === itemId)?.recoveries.find((a) => a.id === actionId)
      if (!action?.run || action.level === "forbidden") return
      if (recoveryInFlight.current) return
      const gen = projectGenRef.current
      const startedProject = normalizePath(useWikiStore.getState().project?.path ?? "")
      if (startedProject !== normalizePath(projectPath) || startedProject !== normalizePath(report.projectPath)) return
      const isCurrent = () =>
        mountedRef.current &&
        projectGenRef.current === gen &&
        normalizePath(useWikiStore.getState().project?.path ?? "") === startedProject
      recoveryInFlight.current = true
      let didExecute = false
      try {
        if (action.level === "confirm") {
          const ok = await ask(
            tOr("diagnostics.confirmActionPrompt", "执行「{{label}}」？", { label: action.label }),
            {
              title: tOr("diagnostics.confirmActionTitle", "确认恢复操作"),
              kind: "warning",
            },
          )
          if (!ok || !isCurrent()) return
        }
        setRecovering(`${itemId}:${actionId}`)
        setRecoverNote(null)
        didExecute = true
        const res = await action.run()
        if (!isCurrent()) return
        setRecoverNote(res.ok ? `恢复成功：${res.detail}` : `恢复未完成：${res.detail}`)
      } catch (e) {
        if (!isCurrent()) return
        setRecoverNote(`恢复失败：${toErrorMessage(e)}`)
      } finally {
        recoveryInFlight.current = false
        if (mountedRef.current && projectGenRef.current === gen) setRecovering(null)
        if (didExecute && isCurrent()) {
          await refresh()
        }
      }
    },
    [report, recovering, projectPath, refresh, tOr],
  )

  const handlePreviewBundle = useCallback(async () => {
    /* v8 ignore next -- 台账 diagnostics-center.tsx：handlePreviewBundle 的守卫是渲染前提：wrapper 在 !projectPath（L569）与 !report（L578）时各自提前返回，内层组件的按钮在两种情况下都不存在 */
    if (!report || !projectPath) return
    const requestId = ++previewRequestIdRef.current
    const startedProject = normalizePath(projectPath)
    const isCurrent = () =>
      mountedRef.current &&
      previewRequestIdRef.current === requestId &&
      normalizePath(useWikiStore.getState().project?.path ?? "") === startedProject
    try {
      const st = await loadNovelSessionStatus(projectPath).catch(() => null)
      if (!isCurrent()) return
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
      const preview = previewDiagnosticBundle({
        bundle,
        targetPath: "diagnostic-bundle.json（由保存对话框确认）",
      })
      if (!isCurrent()) return
      setBundlePreview(preview)
      setBundleNote(null)
    } catch (e) {
      if (!isCurrent()) return
      setBundleNote(`诊断包预览失败：${toErrorMessage(e)}`)
    }
  }, [report, projectPath, historyView.length])

  const handleExportBundle = useCallback(async () => {
    /* v8 ignore next -- 台账 diagnostics-center.tsx：handleExportBundle 的守卫是渲染前提：导出按钮位于 {!preview ? … : …} 的 else 分支内（L301 起），只有 bundlePreview 非空时才渲染 */
    if (!bundlePreview) return
    if (bundleExportInFlight.current) return
    const startedProject = normalizePath(useWikiStore.getState().project?.path ?? "")
    if (startedProject !== normalizePath(report?.projectPath ?? "")) return
    const isSameProject = () =>
      mountedRef.current && normalizePath(useWikiStore.getState().project?.path ?? "") === startedProject
    bundleExportInFlight.current = true
    try {
      const out = await save({
        defaultPath: "diagnostic-bundle.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      if (!isSameProject()) return
      if (!out) {
        setBundleNote("已取消导出。")
        return
      }
      const confirmed = await ask("将预览中的脱敏诊断包写入所选位置？", { title: "确认导出诊断包", kind: "warning" })
      if (!isSameProject()) return
      if (!confirmed) {
        setBundleNote("已取消导出。")
        return
      }
      await writeFileAtomic(out, serializeDiagnosticBundle(bundlePreview.bundle))
      if (!isSameProject()) return
      setBundlePreview((p) => (p ? { ...p, targetPath: out } : p))
      setBundleNote(`诊断包已导出：${out}`)
    } catch (e) {
      if (isSameProject()) {
        setBundleNote(`诊断包导出失败：${toErrorMessage(e)}`)
      }
    } finally {
      bundleExportInFlight.current = false
    }
  }, [bundlePreview, report])

  if (!projectPath) {
    return (
      <section data-testid="diagnostics-center-empty" className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">
          {tOr("novel.diagnostics.noProject", "请先打开一个项目再使用诊断中心。")}
        </p>
      </section>
    )
  }
  if (!report && loadError) {
    return (
      <section
        data-testid="diagnostics-center-error"
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-4"
      >
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>诊断检测失败：{loadError}</span>
        </p>
        <button
          type="button"
          data-testid="diagnostics-retry"
          disabled={loading}
          onClick={() => void refresh()}
          className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </button>
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
      recheckError={loadError}
      kbMetrics={kbMetrics}
      onRecheck={() => void refresh()}
      onRecover={(itemId, actionId) => void handleRecover(itemId, actionId)}
      onPreviewBundle={() => void handlePreviewBundle()}
      onExportBundle={() => void handleExportBundle()}
    />
  )
}

export default DiagnosticsCenterView
