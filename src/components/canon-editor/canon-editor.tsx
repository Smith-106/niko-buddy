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
import { invoke } from "@tauri-apps/api/core"
import { CanonFactTable } from "./canon-fact-table"
import { CanonFactsKnownByPanel } from "./canon-facts-known-by-panel"
import { CanonRevisionViewer } from "./canon-revision-viewer"
import { queryCanonBatch } from "./canon-editor-client"
import { PaginationControls } from "@/components/ui/pagination"
import {
  EDGE_KIND_LABELS,
  type CanonEdge,
  type CanonEdgeFilter,
  type EdgeKind,
} from "./canon-types"
import {
  buildCanonEdgeFilter,
  type CanonQueryBatchResponseRaw,
  type RawCanonEdge,
} from "@/lib/novel/canon-graph-client"

const EDGE_KIND_OPTIONS = Object.entries(EDGE_KIND_LABELS) as Array<[EdgeKind, string]>

/** 服务端分页页大小（offset/limit 载荷，v2.8 P1-2；不引新依赖）。 */
const PAGE_SIZE = 100

type EditorMode = "browse" | "correct"

/**
 * 将当前过滤输入构建为单个 CanonEdgeFilter。
 * v2.8 P1-2：委托共享构造器 buildCanonEdgeFilter（42-spec §17 P1-2 骨架接线），
 * 产物为全 null 字段对象（未提供的维不过滤）。分页 offset/limit 不在此处搭载，
 * 仅在 reload 调用点注入（避免 page → filter → 重置 page 死循环）。
 */
function buildFilter(input: {
  knownBy: string
  validAtChapter: string
  edgeKind: EdgeKind | "all"
}): CanonEdgeFilter {
  const chapter = Number.parseInt(input.validAtChapter, 10)
  return buildCanonEdgeFilter({
    knownBy: input.knownBy.trim() || undefined,
    validAtChapter: Number.isFinite(chapter) ? chapter : undefined,
    edgeKinds: input.edgeKind === "all" ? undefined : [input.edgeKind],
  })
}

// ============================================================================
// wire 契约（与 src-tauri/src/canon_commands.rs serde snake_case 对齐）
// ============================================================================

/** `canon_supersede_edges` 请求体（SupersedeRequest 镜像）。 */
export interface CanonSupersedeRequest {
  /** 被取代的旧边 id 列表。 */
  old_edge_ids: string[]
  /** 封顶章节（旧边 invalid_at 写入值）。 */
  cap_chapter: number
  /** 后继新边（id 由调用方生成）。 */
  new_edges: RawCanonEdge[]
  /** §B 审计溯源标记：人工校正 supersede 的高审计粒度标记。 */
  caused_by?: string
}

/** `canon_supersede_edges` 响应体（CanonSupersedeResponse 镜像）。 */
export interface CanonSupersedeResponse {
  result: {
    capped: number
    inserted: number
    missing: string[]
  }
  max_revision: number
}

// ============================================================================
// 校正载荷构建（纯函数）
// ============================================================================

/**
 * 生成校正后继边的 id（纯函数；salt 由调用方注入时间戳/序数以保证全局唯一）。
 * Rust 侧约定「后继新边由调用方生成全新 id」。
 */
export function makeCorrectionId(oldId: string, salt: string): string {
  return `corr:${oldId}:${salt}`
}

/** FNV-1a 32 位摘要（十六进制）。校正后继边的写路径幂等键（确定性，同内容同值）。 */
export function computeCorrectionDigest(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * 把一条原始边 + 认知轴补丁装配为 `canon_supersede_edges` 请求（纯函数）。
 *
 * - 旧边封顶章 = `old.valid_at ?? 0`：旧边自生效点起即被后继取代（无缝替换，
 *   且恒满足 valid_at <= invalid_at 时态不变量）；已封顶旧边重复封顶无害。
 * - 后继边继承旧边全部字段（含 world 时态 valid_at/invalid_at 与技法列），
 *   仅覆盖 id / known_by / revealed_at，并重算 digest；archived 归一为 false。
 *
 * @param salt 校正 id 后缀盐（调用方注入，测试传固定值）
 */
export function buildSupersedeRequestForCorrection(
  old: RawCanonEdge,
  patch: { knownBy: readonly string[]; revealedAt: number | null },
  salt: string,
): CanonSupersedeRequest {
  const newId = makeCorrectionId(old.id, salt)
  const newEdge: RawCanonEdge = {
    ...old,
    id: newId,
    known_by: [...patch.knownBy],
    revealed_at: patch.revealedAt,
    archived: false,
    digest: computeCorrectionDigest(
      `${newId}|${patch.knownBy.join(",")}|${patch.revealedAt ?? ""}`,
    ),
  }
  return {
    old_edge_ids: [old.id],
    cap_chapter: old.valid_at ?? 0,
    new_edges: [newEdge],
    // §B causedBy：人工校正 supersede 的审计溯源标记
    caused_by: "manual-correction",
  }
}

// ============================================================================
// 校正校验（纯函数；POV 防泄密 + 时态不变量，客户端 fail-closed 拦截）
// ============================================================================

/** 校验违规码（与消息一一对应，供 spec 断言与 UI 徽标）。 */
export type CorrectionViolationCode =
  | "empty_pov"
  | "duplicate_pov"
  | "not_in_allowlist"
  | "invalid_revealed_at"
  | "revealed_before_valid"
  | "revealed_without_known_by"

export interface CorrectionViolation {
  code: CorrectionViolationCode
  message: string
}

export interface CorrectionValidation {
  ok: boolean
  violations: CorrectionViolation[]
}

/**
 * known_by 白名单校验（POV 防泄密核心守卫，fail-closed）：
 *   - 空白条目 → empty_pov；
 *   - 重复条目 → duplicate_pov；
 *   - 不在白名单 → not_in_allowlist（白名单空 = 全部拒绝增补，只允许移除）。
 */
export function validateKnownByCorrection(
  nextKnownBy: readonly unknown[],
  allowlist: readonly string[],
): CorrectionValidation {
  const violations: CorrectionViolation[] = []
  const seen = new Set<string>()
  for (const raw of nextKnownBy) {
    const pov = typeof raw === "string" ? raw.trim() : ""
    if (!pov) {
      violations.push({ code: "empty_pov", message: "known_by 含空白 POV 条目" })
      continue
    }
    if (seen.has(pov)) {
      violations.push({ code: "duplicate_pov", message: `known_by 重复 POV：${pov}` })
      continue
    }
    seen.add(pov)
    if (!allowlist.includes(pov)) {
      violations.push({
        code: "not_in_allowlist",
        message: `POV「${pov}」不在项目角色白名单内（POV 防泄密：known_by 增补仅接受白名单成员）`,
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/**
 * revealed_at 时态不变量校验（与 Rust validate_edge_temporal 对齐）：
 *   - 非 null 必须为 ≥1 整数（1-based 章节号）→ 否则 invalid_revealed_at；
 *   - revealed_at < valid_at → revealed_before_valid（揭示早于事实生效）；
 *   - revealed_at 非空但 known_by 为空 → revealed_without_known_by。
 */
export function validateRevealedAtCorrection(
  revealedAt: number | null,
  validAt: number | null | undefined,
  knownByCount: number,
): CorrectionValidation {
  const violations: CorrectionViolation[] = []
  if (revealedAt !== null) {
    if (!Number.isInteger(revealedAt) || revealedAt < 1) {
      violations.push({
        code: "invalid_revealed_at",
        message: "revealed_at 必须是 ≥1 的整数章号（或留空表示未登记揭示点）",
      })
    } else if (validAt != null && revealedAt < validAt) {
      violations.push({
        code: "revealed_before_valid",
        message: `revealed_at=${revealedAt} 早于 valid_at=${validAt}：揭示不得早于事实生效（POV 防泄密时态不变量）`,
      })
    } else if (knownByCount === 0) {
      violations.push({
        code: "revealed_without_known_by",
        message: "revealed_at 已登记但 known_by 为空：无人知晓的事实不可能被揭示",
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** 解析 revealed_at 输入框文本：空白 → null（未登记）；非法整数 → NaN。 */
function parseChapterInput(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return Number.parseInt(trimmed, 10)
}

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
  return (
    <section
      className="rounded-lg border bg-card p-4 shadow-sm"
      aria-label="canon 过滤器"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">known_by（POV）</span>
          <input
            type="text"
            className="h-8 min-w-48 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="如：主角 / POV id"
            value={knownBy}
            onChange={(e) => onKnownBy(e.target.value)}
            data-testid="canon-filter-known-by"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">valid_at_chapter</span>
          <input
            type="number"
            className="h-8 w-28 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="章节号"
            value={validAtChapter}
            onChange={(e) => onValidAtChapter(e.target.value)}
            data-testid="canon-filter-valid-at-chapter"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">edge_kind</span>
          <select
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
      const message = err instanceof Error ? err.message : "canon_query_batch 调用失败"
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

  const handleSelect = useCallback((edge: RawCanonEdge) => {
    setSelectedId(edge.id)
    setDraftKnownBy([...(edge.known_by ?? [])])
    setDraftRevealedAt(edge.revealed_at == null ? "" : String(edge.revealed_at))
    setPovInput("")
    setAddPovError(null)
    setSaveViolations([])
    setSaveError(null)
    setLastSave(null)
  }, [])

  const handleDeselect = useCallback(() => {
    setSelectedId(null)
    setDraftKnownBy([])
    setDraftRevealedAt("")
    setPovInput("")
    setAddPovError(null)
    setSaveViolations([])
    setSaveError(null)
  }, [])

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
                message: "revealed_at 必须是 ≥1 的整数章号（或留空表示未登记揭示点）",
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
      setSaveError(err instanceof Error ? err.message : "canon_supersede_edges 调用失败")
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
        <div className="mx-auto max-w-5xl space-y-5">
          <header className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xl font-semibold" data-testid="canon-editor-title">
                Canon 编辑器（只读）
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
              项目 {projectId} · 接 canon_query_batch 渲染事实表（known_by / valid_at_chapter / edge_kinds 过滤 + 服务端分页 offset/limit + total；max_revision 展示）。点「校正」进入认知轴校正（写路径）。
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
              className="rounded-md border border-red-300 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
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
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold" data-testid="canon-editor-title">
              Canon 认知轴校正（写路径）
            </h1>
            <div className="flex items-center gap-2">
              <span
                className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                data-testid="canon-max-revision"
              >
                revision: {maxRevision === null ? "—" : maxRevision}
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
            项目 {projectId} · 选择事实边校正 known_by（白名单）与 revealed_at；保存走 canon_supersede_edges（旧边封顶留痕 + 校正后继边）。
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
            className="rounded-md border border-red-300 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
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

        <section aria-label="canon 事实边列表" className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">事实边</h2>
            <span className="text-xs text-muted-foreground">
              共 {total} 条（服务端过滤后全量）
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
                    <th className="px-2 py-1.5">id</th>
                    <th className="px-2 py-1.5">谓词</th>
                    <th className="px-2 py-1.5">类别</th>
                    <th className="px-2 py-1.5">known_by</th>
                    <th className="px-2 py-1.5">revealed_at</th>
                    <th className="px-2 py-1.5">操作</th>
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
            aria-label="认知轴校正面板"
            className="rounded-lg border bg-card p-4 shadow-sm"
            data-testid="correction-panel"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                校正认知轴 ·{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {selected.predicate}（
                  {EDGE_KIND_LABELS[selected.edge_kind as EdgeKind] ?? selected.edge_kind}
                  ，valid_at={selected.valid_at ?? "—"}）
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
              <span className="text-xs text-muted-foreground">known_by：</span>
              {draftKnownBy.length === 0 && (
                <span className="text-xs italic text-muted-foreground/70">（空 — 无人知晓）</span>
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
                placeholder="新增知晓 POV（限白名单）"
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
              <span className="text-xs text-muted-foreground">revealed_at（向 known_by 揭示的章节；留空=未登记）</span>
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
                保存 = canon_supersede_edges：旧边封顶于 valid_at={selected.valid_at ?? 0} + 校正后继边
              </span>
            </div>

            {saveViolations.length > 0 && (
              <ul
                className="mt-3 list-inside list-disc rounded-md border border-red-300 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
                role="alert"
                data-testid="correction-violations"
              >
                {saveViolations.map((v) => (
                  <li key={v.code}>
                    [{v.code}] {v.message}
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
            className="rounded-md border border-green-300 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:border-green-800 dark:text-green-300"
            role="status"
            data-testid="correction-saved"
          >
            校正已写入：封顶 {lastSave.capped} 条 · 插入 {lastSave.inserted} 条 · revision → {lastSave.maxRevision}
            {lastSave.missing.length > 0 && ` · 未找到旧边：${lastSave.missing.join(", ")}`}
          </div>
        )}
      </div>
    </div>
  )
}
