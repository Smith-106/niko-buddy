// Canon 编辑前端 —— 只读版（T18a / F-01）。
//
// 职责：
//   - 接 canon_commands `canon_query_batch`（T13）：一批 filter → 一批结果；
//   - 渲染事实表（canon-fact-table.tsx）；
//   - 提供 known_by / valid_at_chapter / edge_kinds 过滤控件（下推到 IPC）；
//   - 展示响应的 max_revision（缓存失效判定依据）。
//
// 硬约束：只读版，不含任何写入/编辑控件（canon_ingest_episode /
// canon_supersede_edges 的前端入口在后续编辑版任务中接入）。
//
// IPC 缝合点：canon-editor-client.ts。T14 canon-graph-client 落地后替换其实现即可。

import { useCallback, useEffect, useMemo, useState } from "react"
import { CanonFactTable } from "./canon-fact-table"
import { queryCanonBatch } from "./canon-editor-client"
import {
  EDGE_KIND_LABELS,
  type CanonEdge,
  type CanonEdgeFilter,
  type EdgeKind,
} from "./canon-types"

const EDGE_KIND_OPTIONS = Object.entries(EDGE_KIND_LABELS) as Array<[EdgeKind, string]>

/**
 * 将当前过滤输入构建为单个 CanonEdgeFilter。
 * 空输入 → 空对象（不过滤任何维，返回全部边）。
 */
function buildFilter(input: {
  knownBy: string
  validAtChapter: string
  edgeKind: EdgeKind | "all"
}): CanonEdgeFilter {
  const filter: CanonEdgeFilter = {}
  const trimmedPov = input.knownBy.trim()
  if (trimmedPov) filter.known_by = trimmedPov
  const chapter = Number.parseInt(input.validAtChapter, 10)
  if (Number.isFinite(chapter)) filter.valid_at_chapter = chapter
  if (input.edgeKind !== "all") filter.edge_kinds = [input.edgeKind]
  return filter
}

export interface CanonEditorProps {
  /** 项目 id（canon_commands 首参；对应 Rust project_id）。 */
  projectId: string
  className?: string
}

export function CanonEditor({ projectId, className }: CanonEditorProps) {
  // ── 过滤输入 ──
  const [knownBy, setKnownBy] = useState("")
  const [validAtChapter, setValidAtChapter] = useState("")
  const [edgeKind, setEdgeKind] = useState<EdgeKind | "all">("all")

  // ── 当前已下推到 IPC 的过滤（点击「应用过滤」后更新）──
  const [appliedFilter, setAppliedFilter] = useState<CanonEdgeFilter>({})

  // ── 查询结果 ──
  const [edges, setEdges] = useState<CanonEdge[]>([])
  const [maxRevision, setMaxRevision] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await queryCanonBatch(projectId, [appliedFilter])
      // batch 返回结果集与 filters 一一对应；只读视图只发 1 个 filter。
      setEdges(response.results[0] ?? [])
      setMaxRevision(response.max_revision)
    } catch (err) {
      // Error → 用其 message；其余（含字符串 reject）→ 统一兜底文案，
      // 避免把任意 reject 值直接渲染到 UI（与 graph-view 错误兜底语义一致）。
      const message = err instanceof Error ? err.message : "canon_query_batch 调用失败"
      setError(message)
      setEdges([])
      setMaxRevision(null)
    } finally {
      setLoading(false)
    }
  }, [projectId, appliedFilter])

  // projectId 或已应用过滤变化时重新查询。
  useEffect(() => {
    void reload()
  }, [reload])

  const handleApplyFilter = useCallback(() => {
    setAppliedFilter(buildFilter({ knownBy, validAtChapter, edgeKind }))
  }, [knownBy, validAtChapter, edgeKind])

  const handleResetFilter = useCallback(() => {
    setKnownBy("")
    setValidAtChapter("")
    setEdgeKind("all")
    setAppliedFilter({})
  }, [])

  // 当前过滤是否与已应用过滤一致（用于禁用「应用过滤」按钮）。
  const filterDirty = useMemo(() => {
    const pending = buildFilter({ knownBy, validAtChapter, edgeKind })
    return JSON.stringify(pending) !== JSON.stringify(appliedFilter)
  }, [knownBy, validAtChapter, edgeKind, appliedFilter])

  return (
    <div className={className ?? "h-full overflow-auto bg-background p-6"} data-testid="canon-editor-root">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="rounded-lg border bg-card p-5 shadow-sm">
          <h1 className="text-xl font-semibold" data-testid="canon-editor-title">
            Canon 编辑器（只读）
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            项目 {projectId} · 接 canon_query_batch 渲染事实表（known_by / valid_at_chapter / edge_kinds 过滤，max_revision 展示）。
          </p>
        </header>

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
                onChange={(e) => setKnownBy(e.target.value)}
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
                onChange={(e) => setValidAtChapter(e.target.value)}
                data-testid="canon-filter-valid-at-chapter"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">edge_kind</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={edgeKind}
                onChange={(e) => setEdgeKind(e.target.value as EdgeKind | "all")}
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
                onClick={handleApplyFilter}
                disabled={!filterDirty || loading}
                data-testid="canon-filter-apply"
              >
                应用过滤
              </button>
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={handleResetFilter}
                disabled={loading}
                data-testid="canon-filter-reset"
              >
                重置
              </button>
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => void reload()}
                disabled={loading}
                data-testid="canon-refresh"
              >
                刷新
              </button>
            </div>
          </div>
        </section>

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

        <CanonFactTable edges={edges} maxRevision={maxRevision} />
      </div>
    </div>
  )
}
