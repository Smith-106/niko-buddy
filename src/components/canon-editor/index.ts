// Canon 编辑前端（合并版：只读浏览 + 认知轴校正写路径）—— 公共出口。
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

// 校正写路径纯函数与类型（合并自原 novel/canon-editor.tsx）。
export {
  buildSupersedeRequestForCorrection,
  computeCorrectionDigest,
  makeCorrectionId,
  validateKnownByCorrection,
  validateRevealedAtCorrection,
} from "./canon-editor"
export type {
  CanonSupersedeRequest,
  CanonSupersedeResponse,
  CorrectionViolation,
  CorrectionViolationCode,
  CorrectionValidation,
} from "./canon-editor"
