// Canon 编辑前端（只读版）—— 公共出口（T18a / F-01）。
export { CanonEditor } from "./canon-editor"
export type { CanonEditorProps } from "./canon-editor"
export { CanonFactTable } from "./canon-fact-table"
export type { CanonFactTableProps } from "./canon-fact-table"
export { queryCanonBatch } from "./canon-editor-client"
export {
  EDGE_KIND_LABELS,
  type CanonEdge,
  type CanonEdgeFilter,
  type CanonQueryBatchResponse,
  type EdgeKind,
} from "./canon-types"
