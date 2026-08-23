// Canon 只读视图类型（T18a / F-01）。
//
// 这些类型镜像 `src-tauri/src/types/canon_types.rs` 与
// `src-tauri/src/canon_commands.rs` 的 serde 序列化形态：
//   - 顶层 invoke 参数名走 Tauri 的 camelCase↔snake_case 转换（projectId）；
//   - 嵌套结构体字段保持 Rust serde 的 snake_case（known_by / valid_at_chapter /
//     edge_kinds / max_revision / results / edges ...），与 vectorstore 命令一致。
//
// 本文件为纯类型契约，不含运行时逻辑，便于在 vitest 中直接断言。

/** §3 edges.edge_kind 开放/受限注册表（snake_case 与 Rust 枚举一致）。 */
export type EdgeKind =
  | "world_fact"
  | "motivation"
  | "arc"
  | "foreshadow"
  | "hook"
  | "attribute"

/** EdgeKind 中文标签（只读视图展示用）。 */
export const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  world_fact: "世界事实",
  motivation: "动机",
  arc: "弧光",
  foreshadow: "伏笔",
  hook: "钩子",
  attribute: "属性",
}

/** canon_edges 行（§3 事实边 + 时态三层 + 认知轴 + 技法列）。 */
export interface CanonEdge {
  id: string
  source_id: string
  target_id: string
  predicate: string
  edge_kind: EdgeKind
  valid_at?: number | null
  invalid_at?: number | null
  reference_time?: number | null
  known_by?: string[]
  revealed_at?: number | null
  confidence?: number | null
  source_chapter?: number | null
  digest?: string
  beat_label?: string | null
  beat_hit?: boolean | null
  foreshadow_planted_at?: number | null
  hook_type?: string | null
  payoff_chapter?: number | null
  archived?: boolean
}

/**
 * canon_query / canon_query_batch 的边过滤条件（§4）。
 * 全部字段可选；undefined = 不过滤该维。
 */
export interface CanonEdgeFilter {
  known_by?: string
  valid_at_chapter?: number
  edge_kinds?: EdgeKind[]
  predicates?: string[]
  entity_ids?: string[]
  archived?: boolean
  limit?: number
}

/** canon_query_batch 响应（多查询单次 invoke）。 */
export interface CanonQueryBatchResponse {
  /** 与入参 filters 顺序一一对应的结果集。 */
  results: CanonEdge[][]
  /** 当前项目 canon revision。 */
  max_revision: number
}
