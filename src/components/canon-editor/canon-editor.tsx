// Canon 编辑器 —— 合并实现（T18a 只读版 + T29b 写路径校正版，裁决：双实现合一）。
//
// 职责：
//   - 浏览模式（默认）：接 canon_query_batch 渲染只读事实表（CanonFactTable），
//     提供 known_by / valid_at_chapter / edge_kinds 过滤（下推到 IPC）+
//     服务端分页（offset/limit + total，v2.8 P1-2，PaginationControls）；
//   - 校正模式（入口=浏览模式「校正」按钮，退出=「返回浏览」）：复用同一 IPC 缝合点，
//     渲染事实边列表 + 认知轴校正面板（known_by 白名单 fail-closed + 时态不变量守卫
//     + 保存态），保存走 canon_supersede_edges，成功后自动重新 query 刷新边列表。
//
// 硬约束：
//   - 只读版不含任何写入/编辑控件（写路径全部收敛到校正模式）；
//   - POV 防泄密 known_by 白名单校验 fail-closed 必须保留（白名单空 = 禁止一切增补）；
//   - 导出名与 props 不变（导航域 agent 挂载此组件）：CanonEditor / CanonEditorProps。
//
// IPC 缝合点：canon-editor-client.ts（浏览查询）。校正模式的写/查直连 invoke，
// 与只读版共享同一后端命令，无新增 Rust 面。

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { CanonFactTable } from "./canon-fact-table"
import { CanonFactsKnownByPanel } from "./canon-facts-known-by-panel"
import { CanonRevisionViewer } from "./canon-revision-viewer"
import { buildFilter, parseChapterInput, queryCanonBatch } from "./canon-editor-client"
import { PaginationControls } from "@/components/ui/pagination"
import {
  EDGE_KIND_LABELS,
  type CanonEdge,
  type CanonEdgeFilter,
  type EdgeKind,
} from "./canon-types"
import type { CanonQueryBatchResponseRaw, RawCanonEdge } from "@/lib/novel"

const EDGE_KIND_OPTIONS = Object.entries(EDGE_KIND_LABELS) as Array<[EdgeKind, string]>

/** 服务端分页页大小（offset/limit 载荷，v2.8 P1-2；不引新依赖）。 */
const PAGE_SIZE = 100

import { buildSupersedeRequestForCorrection, validateKnownByCorrection, validateRevealedAtCorrection, type CanonSupersedeResponse, type CorrectionViolation } from "./canon-correction"

export {
  buildSupersedeRequestForCorrection,
  computeCorrectionDigest,
  makeCorrectionId,
  validateKnownByCorrection,
  validateRevealedAtCorrection,
} from "./canon-correction"
export type {
  CanonSupersedeRequest,
  CanonSupersedeResponse,
  CorrectionViolation,
  CorrectionViolationCode,
  CorrectionValidation,
} from "./canon-correction"

type EditorMode = "browse" | "correct"





// ============================================================================
// 子组件：筛选条（浏览 / 校正两模式共用）
// ============================================================================

interface FilterBarProps {
  knownBy: string
  validAtChapter: string
  edgeKind: EdgeKind | "all"
  filterDirty: boolean
  loading: boolean
  onKnownBy: (v: string) => void
  onValidAtChapter: (v: string) => void
  onEdgeKind: (v: EdgeKind | "all") => void
  onApply: () => void
  onReset: () => void
  onRefresh: () => void
}

function FilterBar({
  knownBy,
  validAtChapter,
  edgeKind,
  filterDirty,
  loading,
  onKnownBy,
  onValidAtChapter,
  onEdgeKind,
  onApply,
  onReset,
  onRefresh,
}: FilterBarProps) {
  const { t } = useTranslation()
  return (
    <section
      className="rounded-lg border bg-card p-4 elevation-1"
      aria-label={t("canon.filter")}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm" htmlFor="canon-filter-known-by-input">
          <span className="text-xs text-muted-foreground">{t("canon.filterKnownBy")}</span>
          <input
            id="canon-filter-known-by-input"
            type="text"
            className="h-8 min-w-48 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={t("canon.filterPlaceholder")}
            value={knownBy}
            onChange={(e) => onKnownBy(e.target.value)}
            data-testid="canon-filter-known-by"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="canon-filter-valid-at-chapter-input">
          <span className="text-xs text-muted-foreground">{t("canon.filterValidAtChapter")}</span>
          <input
            id="canon-filter-valid-at-chapter-input"
            type="number"
            className="h-8 w-28 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="章节号"
            value={validAtChapter}
            onChange={(e) => onValidAtChapter(e.target.value)}
            data-testid="canon-filter-valid-at-chapter"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm" htmlFor="canon-filter-edge-kind-select">
          <span className="text-xs text-muted-foreground">{t("canon.filterEdgeKind")}</span>
          <select
            id="canon-filter-edge-kind-select"
            className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={edgeKind}
            onChange={(e) => onEdgeKind(e.target.value as EdgeKind | "all")}
            data-testid="canon-filter-edge-kind"
          >
            <option value="all">全部</option>
            {EDGE_KIND_OPTIONS.map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="h-8 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onApply}
            disabled={!filterDirty || loading}
            data-testid="canon-filter-apply"
          >
            应用过滤
          </button>
          <button
            type="button"
            className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onReset}
            disabled={loading}
            data-testid="canon-filter-reset"
          >
            重置
          </button>
          <button
            type="button"
            className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onRefresh}
            disabled={loading}
            data-testid="canon-refresh"
          >
            刷新
          </button>
        </div>
      </div>
    </section>
  )
}

// 分页控件：@/components/ui/pagination 的 PaginationControls（服务端分页，v2.8 P1-2）。

// ============================================================================
// 主组件
// ============================================================================

export interface CanonEditorProps {
  /** 项目 id（canon_commands 首参；对应 Rust project_id）。 */
  projectId: string
  /**
   * POV 白名单（项目角色注册表投影）。
   * fail-closed：缺省/空数组 = 禁止一切 known_by 增补（仅允许移除）。
   * 浏览模式不消费此 prop；合并后组件导出名与 props 不变。
   */
  povAllowlist?: readonly string[]
  className?: string
}

interface SaveOutcome {
  capped: number
  inserted: number
  missing: string[]
  maxRevision: number
}

export function CanonEditor({ projectId, povAllowlist = [], className }: CanonEditorProps) {
  const { t } = useTranslation()
  // ── 模式 ──
  const [mode, setMode] = useState<EditorMode>("browse")

  // ── 过滤输入（两模式共用）──
  const [knownBy, setKnownBy] = useState("")
  const [validAtChapter, setValidAtChapter] = useState("")
  const [edgeKind, setEdgeKind] = useState<EdgeKind | "all">("all")

  // ── 当前已下推到 IPC 的过滤（点击「应用过滤」后更新）──
  // 初始值 = buildFilter(空输入)（全 null 字段对象）：与 filterDirty 的 JSON 比对
  // 保持同构，避免挂载即「假脏」（v2.8 P1-2 防假脏）。
  const [appliedFilter, setAppliedFilter] = useState<CanonEdgeFilter>(() =>
    buildFilter({ knownBy: "", validAtChapter: "", edgeKind: "all" }),
  )

  // ── 查询结果与状态 ──
  const [browseEdges, setBrowseEdges] = useState<CanonEdge[]>([])
  const [correctEdges, setCorrectEdges] = useState<RawCanonEdge[]>([])
  const [maxRevision, setMaxRevision] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── 服务端分页（v2.8 P1-2；两模式共用，过滤/模式/项目变化时回到首页）──
  const [page, setPage] = useState(1)
  // 过滤后全量计数（来自响应 totals[0]；pageCount 据此推导）。
  const [total, setTotal] = useState(0)

  useEffect(() => {
    setPage(1)
  }, [appliedFilter, mode, projectId])

  // ── 校正草稿态 ──
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftKnownBy, setDraftKnownBy] = useState<string[]>([])
  const [draftRevealedAt, setDraftRevealedAt] = useState("")
  const [povInput, setPovInput] = useState("")
  const [addPovError, setAddPovError] = useState<string | null>(null)
  const [saveViolations, setSaveViolations] = useState<CorrectionViolation[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSave, setLastSave] = useState<SaveOutcome | null>(null)

  // 分页派生量（v2.8 P1-2）：pageCount 由服务端全量计数推导；safePage 仅作显示钳位。
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    // 服务端分页：offset/limit 仅在调用点注入（appliedFilter 不含分页字段），
    // 每次 IPC 只传输当前页边（≤PAGE_SIZE 条）。
    const pagedFilter: CanonEdgeFilter = {
      ...appliedFilter,
      offset: (safePage - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }
    try {
      let respTotal = 0
      let pageEmpty = false
      if (mode === "browse") {
        const response = await queryCanonBatch(projectId, [pagedFilter])
        const edges = response.results[0] ?? []
        respTotal = response.totals?.[0] ?? edges.length
        pageEmpty = edges.length === 0
        setBrowseEdges(edges)
        setMaxRevision(response.max_revision)
      } else {
        // 校正模式需要原始边（含 known_by），直连 canon_query_batch，不走投影剥离。
        const res = await invoke<CanonQueryBatchResponseRaw>("canon_query_batch", {
          projectId,
          filters: [pagedFilter],
        })
        const edges = res.results[0] ?? []
        respTotal = res.totals?.[0] ?? edges.length
        pageEmpty = edges.length === 0
        setCorrectEdges(edges)
        setMaxRevision(res.max_revision)
      }
      setTotal(respTotal)
      // 越界回跳守卫：page>1 且当前页为空但服务端仍有数据（过滤/删除后 total
      // 缩小导致当前页越界）→ 回第 1 页重取。page>1 前置条件防死循环；
      // 第 1 页空 = 真空态，不回跳。
      if (safePage > 1 && pageEmpty && respTotal > 0) {
        setPage(1)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "事实列表加载失败"
      setError(message)
      if (mode === "browse") setBrowseEdges([])
      else setCorrectEdges([])
      setMaxRevision(null)
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [projectId, appliedFilter, mode, safePage])

  // projectId / 已应用过滤 / 模式变化时重新查询。
  useEffect(() => {
    void reload()
  }, [reload])

  const handleApplyFilter = useCallback(() => {
    setAppliedFilter(buildFilter({ knownBy, validAtChapter, edgeKind }))
    // 同步回页 1（与 setAppliedFilter 同批提交，避免旧页 offset 先发一次的双取）
    setPage(1)
  }, [knownBy, validAtChapter, edgeKind])

  const handleResetFilter = useCallback(() => {
    setKnownBy("")
    setValidAtChapter("")
    setEdgeKind("all")
    // 重置 = 空输入走同一构造器（全 null 字段对象，与初始值同构；防假脏）
    setAppliedFilter(buildFilter({ knownBy: "", validAtChapter: "", edgeKind: "all" }))
    setPage(1)
  }, [])

  // 当前过滤是否与已应用过滤一致（用于禁用「应用过滤」按钮）。
  const filterDirty = useMemo(() => {
    const pending = buildFilter({ knownBy, validAtChapter, edgeKind })
    return JSON.stringify(pending) !== JSON.stringify(appliedFilter)
  }, [knownBy, validAtChapter, edgeKind, appliedFilter])

  const enterCorrect = useCallback(() => {
    setLastSave(null)
    setSaveError(null)
    setSelectedId(null)
    setMode("correct")
    setPage(1)
  }, [])

  const exitCorrect = useCallback(() => {
    setSelectedId(null)
    setSaveViolations([])
    setSaveError(null)
    setLastSave(null)
    setMode("browse")
    setPage(1)
  }, [])

  // ── 校正模式：选中 / 草稿 ──
  const selected = useMemo(
    () => correctEdges.find((e) => e.id === selectedId) ?? null,
    [correctEdges, selectedId],
  )

  // 无变更守卫：草稿与原边完全一致时禁止保存（避免零差异冗余后继边污染事实表）。
  const correctionDirty = useMemo(() => {
    if (!selected) return false
    const original = [...(selected.known_by ?? [])]
    const sameSet =
      original.length === draftKnownBy.length &&
      original.every((p) => draftKnownBy.includes(p))
    const originalRevealed = selected.revealed_at == null ? "" : String(selected.revealed_at)
    return !sameSet || originalRevealed !== draftRevealedAt.trim()
  }, [selected, draftKnownBy, draftRevealedAt])

  // 脏草稿守卫：取消/切行会静默丢弃未保存校正时，先经用户确认。
  const confirmDiscardDirty = useCallback(() => {
    if (!correctionDirty) return true
    return window.confirm(
      t("canon.correctionDiscardConfirm", { defaultValue: "校正草稿尚未保存，确定要放弃吗？" }),
    )
  }, [correctionDirty, t])

  const handleSelect = useCallback((edge: RawCanonEdge) => {
    if (!confirmDiscardDirty()) return
    setSelectedId(edge.id)
    setDraftKnownBy([...(edge.known_by ?? [])])
    setDraftRevealedAt(edge.revealed_at == null ? "" : String(edge.revealed_at))
    setPovInput("")
    setAddPovError(null)
    setSaveViolations([])
    setSaveError(null)
    setLastSave(null)
  }, [confirmDiscardDirty])

  const handleDeselect = useCallback(() => {
    if (!confirmDiscardDirty()) return
    setSelectedId(null)
    setDraftKnownBy([])
    setDraftRevealedAt("")
    setPovInput("")
    setAddPovError(null)
    setSaveViolations([])
    setSaveError(null)
  }, [confirmDiscardDirty])

  const handleRemovePov = useCallback((pov: string) => {
    // 移除知晓成员永不扩大知晓面（POV 安全方向），不做白名单限制。
    setDraftKnownBy((prev) => prev.filter((p) => p !== pov))
    setSaveViolations([])
  }, [])

  const handleAddPov = useCallback(() => {
    const pov = povInput.trim()
    setAddPovError(null)
    if (!pov) return
    // 增补前即时白名单校验（fail-closed；违规不入草稿、更不触达 IPC）。
    const check = validateKnownByCorrection([...draftKnownBy, pov], povAllowlist)
    if (!check.ok) {
      setAddPovError(check.violations.map((v) => v.message).join("；"))
      return
    }
    setDraftKnownBy((prev) => [...prev, pov])
    setPovInput("")
  }, [povInput, draftKnownBy, povAllowlist])

  const handleSave = useCallback(async () => {
    if (!selected || saving) return
    setSaveError(null)
    setLastSave(null)

    const parsed = parseChapterInput(draftRevealedAt)
    const knownByCheck = validateKnownByCorrection(draftKnownBy, povAllowlist)
    const revealedCheck =
      Number.isNaN(parsed as number) && draftRevealedAt.trim() !== ""
        ? {
            ok: false,
            violations: [
              {
                code: "invalid_revealed_at" as const,
                message: "揭晓章节必须是 ≥1 的整数（留空表示尚未揭晓）",
              },
            ],
          }
        : validateRevealedAtCorrection(parsed, selected.valid_at, draftKnownBy.length)
    const violations = [...knownByCheck.violations, ...revealedCheck.violations]
    if (violations.length > 0) {
      setSaveViolations(violations)
      return
    }
    setSaveViolations([])

    const request = buildSupersedeRequestForCorrection(
      selected,
      { knownBy: draftKnownBy, revealedAt: parsed },
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    setSaving(true)
    try {
      const res = await invoke<CanonSupersedeResponse>("canon_supersede_edges", {
        projectId,
        request,
      })
      setLastSave({ ...res.result, maxRevision: res.max_revision })
      handleDeselect()
      // ③-2 保存后刷新：成功回调内自动重新 query 刷新边列表。
      await reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "校正保存失败")
    } finally {
      setSaving(false)
    }
  }, [
    selected,
    saving,
    draftRevealedAt,
    draftKnownBy,
    povAllowlist,
    projectId,
    handleDeselect,
    reload,
  ])

  // ── 浏览模式渲染 ──
  if (mode === "browse") {
    return (
      <div
        className={className ?? "h-full overflow-auto bg-background p-6"}
        data-testid="canon-editor-root"
      >
        <div className="w-full min-w-0 space-y-5">
          <header className="rounded-lg border bg-card p-5 elevation-1">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xl font-semibold" data-testid="canon-editor-title">
                设定校正
                <span className="ml-2 text-sm font-normal text-muted-foreground">浏览</span>
                <span className="sr-only">Canon</span>
              </h1>
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted"
                onClick={enterCorrect}
                data-testid="canon-enter-correct"
              >
                校正
              </button>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              <span title={projectId}>下方是本项目的事实列表，可按知晓角色、有效章节、关系类型筛选。浏览不会改动任何数据；点「校正」可修正某条事实的知晓范围与揭晓章节。</span>
            </p>
          </header>

          <FilterBar
            knownBy={knownBy}
            validAtChapter={validAtChapter}
            edgeKind={edgeKind}
            filterDirty={filterDirty}
            loading={loading}
            onKnownBy={setKnownBy}
            onValidAtChapter={setValidAtChapter}
            onEdgeKind={setEdgeKind}
            onApply={handleApplyFilter}
            onReset={handleResetFilter}
            onRefresh={() => void reload()}
          />

          {error && (
            <div
              className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive dark:border-destructive dark:text-destructive"
              data-testid="canon-editor-error"
              role="alert"
            >
              {error}
            </div>
          )}

          {loading && (
            <div
              className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
              data-testid="canon-editor-loading"
            >
              加载中…
            </div>
          )}

          {/* v2.8 P1-2：服务端分页 —— 当前页边集直渲染（无客户端切片） */}
          <CanonFactTable edges={browseEdges} maxRevision={maxRevision} />
          <PaginationControls
            page={safePage}
            pageCount={pageCount}
            total={total}
            onPageChange={setPage}
            disabled={loading}
            testIdPrefix="canon"
          />
          <CanonFactsKnownByPanel
            projectId={projectId}
            povAllowlist={povAllowlist}
            refreshSignal={maxRevision ?? 0}
          />
          <CanonRevisionViewer projectId={projectId} refreshSignal={maxRevision ?? 0} />
        </div>
      </div>
    )
  }

  // ── 校正模式渲染 ──
  return (
    <div
      className={className ?? "h-full overflow-auto bg-background p-6"}
      data-testid="canon-editor-root"
    >
      <div className="w-full min-w-0 space-y-5">
        <header className="rounded-lg border bg-card p-5 elevation-1">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold" data-testid="canon-editor-title">
              设定校正
              <span className="sr-only">Canon 写路径</span>
            </h1>
            <div className="flex items-center gap-2">
              <span
                className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                data-testid="canon-max-revision"
              >
                {t("canon.maxRevision")}: {maxRevision === null ? "—" : maxRevision}
              </span>
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={exitCorrect}
                data-testid="canon-exit-correct"
              >
                返回浏览
              </button>
            </div>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            <span title={projectId}>选择一条事实，校正它的知晓角色（白名单）与揭晓章节；保存时旧版本封顶留痕并写入新版本。</span>
          </p>
        </header>

        <FilterBar
          knownBy={knownBy}
          validAtChapter={validAtChapter}
          edgeKind={edgeKind}
          filterDirty={filterDirty}
          loading={loading}
          onKnownBy={setKnownBy}
          onValidAtChapter={setValidAtChapter}
          onEdgeKind={setEdgeKind}
          onApply={handleApplyFilter}
          onReset={handleResetFilter}
          onRefresh={() => void reload()}
        />

        {error && (
          <div
            className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive dark:border-destructive dark:text-destructive"
            role="alert"
            data-testid="canon-editor-error"
          >
            {error}
          </div>
        )}

        {loading && (
          <div
            className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
            data-testid="canon-editor-loading"
          >
            加载中…
          </div>
        )}

        <section aria-label={t("canon.edgeList")} className="rounded-lg border bg-card p-4 elevation-1">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("canon.edge")}</h2>
            <span className="text-xs text-muted-foreground">
              {t("canon.edgeTotalLine", { count: total })}
            </span>
          </div>
          {correctEdges.length === 0 ? (
            <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="canon-empty">
              无事实边（先完成章节摄取或调整过滤条件）。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="canon-edge-table">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5">{t("canon.factIndexHeader")}</th>
                    <th className="px-2 py-1.5">{t("canon.predicate")}</th>
                    <th className="px-2 py-1.5">{t("canon.category")}</th>
                    <th className="px-2 py-1.5">{t("canon.knownByHeader")}</th>
                    <th className="px-2 py-1.5">{t("canon.revealedAtHeader")}</th>
                    <th className="px-2 py-1.5">{t("canon.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {correctEdges.map((edge) => (
                    <tr key={edge.id} className="border-t">
                      <td className="px-2 py-1.5 font-mono">{edge.id}</td>
                      <td className="px-2 py-1.5">{edge.predicate}</td>
                      <td className="px-2 py-1.5">
                        {EDGE_KIND_LABELS[edge.edge_kind as EdgeKind] ?? edge.edge_kind}
                      </td>
                      <td className="px-2 py-1.5">
                        {(edge.known_by ?? []).join(", ") || "—"}
                      </td>
                      <td className="px-2 py-1.5">{edge.revealed_at ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          className="rounded-md border px-2 py-0.5 transition-colors hover:bg-muted"
                          onClick={() => handleSelect(edge)}
                          data-testid={`canon-select-${edge.id}`}
                        >
                          校正
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <PaginationControls
            page={safePage}
            pageCount={pageCount}
            total={total}
            onPageChange={setPage}
            disabled={loading}
            testIdPrefix="canon"
          />
        </section>

        {selected && (
          <section
            aria-label={t("canon.cognitionPanel")}
            className="rounded-lg border bg-card p-4 elevation-1"
            data-testid="correction-panel"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                校正认知轴 ·{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {selected.predicate}（
                  {EDGE_KIND_LABELS[selected.edge_kind as EdgeKind] ?? selected.edge_kind}
                  ，{selected.valid_at != null ? `有效自第${selected.valid_at}章` : "未设有效章节"}）
                </span>
              </h2>
              <button
                type="button"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={handleDeselect}
                data-testid="correction-cancel"
              >
                取消
              </button>
            </div>

            {/* known_by 草稿 chips */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("canon.filterKnownBy")}：</span>
              {draftKnownBy.length === 0 && (
                <span className="text-xs italic text-muted-foreground">{t("canon.emptyUnknown")}</span>
              )}
              {draftKnownBy.map((pov) => (
                <span
                  key={pov}
                  className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
                  data-testid={`correction-pov-chip-${pov}`}
                >
                  {pov}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`移除 ${pov}`}
                    onClick={() => handleRemovePov(pov)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            {/* 增补 POV（白名单 datalist） */}
            <div className="mb-3 flex items-center gap-2">
              <input
                type="text"
                list="canon-pov-allowlist"
                className="h-8 w-56 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder={t("canon.addKnownByPlaceholder")}
                value={povInput}
                onChange={(e) => {
                  setPovInput(e.target.value)
                  setAddPovError(null)
                }}
                data-testid="correction-pov-input"
              />
              <datalist id="canon-pov-allowlist">
                {povAllowlist.map((pov) => (
                  <option key={pov} value={pov} />
                ))}
              </datalist>
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted"
                onClick={handleAddPov}
                data-testid="correction-pov-add"
              >
                添加
              </button>
            </div>
            {addPovError && (
              <p className="mb-3 text-xs text-destructive" role="alert" data-testid="correction-pov-error">
                {addPovError}
              </p>
            )}

            {/* revealed_at（text+inputMode：让非法输入留在框内被校验拦截，而非被浏览器静默清洗） */}
            <label className="mb-3 flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t("canon.revealedAtHint")}</span>
              <input
                type="text"
                inputMode="numeric"
                className="h-8 w-32 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={draftRevealedAt}
                onChange={(e) => {
                  setDraftRevealedAt(e.target.value)
                  setSaveViolations([])
                }}
                data-testid="correction-revealed-at"
              />
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleSave()}
                disabled={saving || !correctionDirty}
                data-testid="correction-save"
              >
                {saving ? "保存中…" : "保存校正"}
              </button>
              <span className="text-xs text-muted-foreground">
                保存后旧版本封顶留痕，并写入校正后的新版本。
              </span>
            </div>

            {saveViolations.length > 0 && (
              <ul
                className="mt-3 list-inside list-disc rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive dark:border-destructive dark:text-destructive"
                role="alert"
                data-testid="correction-violations"
              >
                {saveViolations.map((v) => (
                  <li key={v.code}>
                    {v.message}
                  </li>
                ))}
              </ul>
            )}

            {saveError && (
              <p className="mt-3 text-xs text-destructive" role="alert" data-testid="correction-save-error">
                {saveError}
              </p>
            )}
          </section>
        )}

        {lastSave && (
          <div
            className="rounded-md border border-success bg-success/10 px-4 py-3 text-sm text-success-foreground dark:border-success dark:text-success-foreground"
            role="status"
            data-testid="correction-saved"
          >
            {t("canon.correctionSaved", {
              inserted: lastSave.inserted,
              cappedSuffix:
                lastSave.capped > 0 ? t("canon.correctionCappedSuffix", { count: lastSave.capped }) : "",
              revision: lastSave.maxRevision,
              missingSuffix:
                lastSave.missing.length > 0
                  ? t("canon.correctionMissingSuffix", { names: lastSave.missing.join(", ") })
                  : "",
            })}
          </div>
        )}
      </div>
    </div>
  )
}
