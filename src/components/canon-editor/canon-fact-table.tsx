// Canon 事实表子组件（T18a / F-01 只读版）。
//
// 纯展示：接收已过滤的 CanonEdge[] 与 max_revision，渲染事实表。
// 不发起任何 IPC，不做过滤——过滤逻辑在父组件 canon-editor.tsx 中，
// 通过 canon_query_batch 的 filter 参数下推到 Rust 侧。

import { EDGE_KIND_LABELS, type CanonEdge, type EdgeKind } from "./canon-types"

/** 表格列定义（只读）。 */
const COLUMNS = [
  "predicate",
  "edge_kind",
  "source → target",
  "valid_at",
  "invalid_at",
  "known_by",
  "revealed_at",
  "confidence",
  "source_chapter",
  "digest",
] as const

function formatChapter(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return String(value)
}

function formatKnownBy(povs: string[] | undefined): string {
  if (!povs || povs.length === 0) return "—"
  return povs.join(", ")
}

function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return value.toFixed(2)
}

function formatDigest(digest: string | undefined): string {
  if (!digest) return "—"
  if (digest.length <= 8) return digest
  return `${digest.slice(0, 8)}…`
}

function edgeKindLabel(kind: EdgeKind): string {
  return EDGE_KIND_LABELS[kind] ?? kind
}

export interface CanonFactTableProps {
  edges: CanonEdge[]
  /** 当前 canon revision，用于在表头展示（缓存失效判定依据）。 */
  maxRevision: number | null
}

/**
 * 只读事实表：渲染 canon_query_batch 返回的边集。
 *
 * 设计要点：
 * - 空态：edges 为空时渲染占位行（不与 loading/error 状态竞争）。
 * - max_revision 展示：表头右侧徽标；null 表示尚未加载。
 * - 无任何编辑控件（只读版硬约束）。
 */
export function CanonFactTable({ edges, maxRevision }: CanonFactTableProps) {
  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="text-sm font-medium">
          事实表
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            共 {edges.length} 条
          </span>
        </div>
        <div
          className="rounded-md border bg-muted/30 px-2 py-1 text-xs"
          data-testid="canon-max-revision"
        >
          max_revision:{" "}
          <span data-testid="canon-max-revision-value">
            {maxRevision === null ? "—" : String(maxRevision)}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {COLUMNS.map((col) => (
                <th key={col} className="whitespace-nowrap px-3 py-2 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {edges.length === 0 ? (
              <tr data-testid="canon-fact-table-empty">
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  当前过滤下暂无事实边。
                </td>
              </tr>
            ) : (
              edges.map((edge) => (
                <tr
                  key={edge.id}
                  data-testid={`canon-fact-row-${edge.id}`}
                  className="border-b last:border-0 hover:bg-muted/20"
                >
                  <td className="px-3 py-2">{edge.predicate}</td>
                  <td className="px-3 py-2">{edgeKindLabel(edge.edge_kind)}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span data-testid={`canon-fact-source-${edge.id}`}>{edge.source_id}</span>
                    {" → "}
                    <span data-testid={`canon-fact-target-${edge.id}`}>{edge.target_id}</span>
                  </td>
                  <td className="px-3 py-2" data-testid={`canon-fact-valid-at-${edge.id}`}>
                    {formatChapter(edge.valid_at)}
                  </td>
                  <td className="px-3 py-2" data-testid={`canon-fact-invalid-at-${edge.id}`}>
                    {formatChapter(edge.invalid_at)}
                  </td>
                  <td
                    className="px-3 py-2"
                    data-testid={`canon-fact-known-by-${edge.id}`}
                  >
                    {formatKnownBy(edge.known_by)}
                  </td>
                  <td className="px-3 py-2">{formatChapter(edge.revealed_at)}</td>
                  <td
                    className="px-3 py-2"
                    data-testid={`canon-fact-confidence-${edge.id}`}
                  >
                    {formatConfidence(edge.confidence)}
                  </td>
                  <td className="px-3 py-2">{formatChapter(edge.source_chapter)}</td>
                  <td
                    className="px-3 py-2 font-mono text-xs"
                    title={edge.digest ?? ""}
                  >
                    {formatDigest(edge.digest)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
