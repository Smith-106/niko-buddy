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
  /** G3 bi-temporal 事务时间轴 (51 号报告，镜像 Rust CanonEdge)：事务/系统时间 unix seconds。
   *  与 valid_at/invalid_at（故事时间）正交；旧数据缺失 → undefined（effective 回退用故事时间）。 */
  created_at?: number | null
  /** 事务结束时间（被 supersede/invalidate 后置入；null/undefined=当前有效版本）。 */
  expired_at?: number | null
}

/**
 * canon_query / canon_query_batch 的边过滤条件（§4）。
 * 与 `src/lib/novel/canon-graph-client.ts` 的 `CanonEdgeFilter`（Rust 镜像）结构一致，
 * 使 `buildCanonEdgeFilter` 产物可直接赋值给本地状态类型。
 * 全部字段可选；undefined/null = 不过滤该维。
 */
export interface CanonEdgeFilter {
  known_by?: string | null
  valid_at_chapter?: number | null
  /** 召回已失效窗口边（"曾以为"）：true=保留 invalid_at<=章节 的边。 */
  include_invalidated?: boolean | null
  edge_kinds?: EdgeKind[] | null
  predicates?: string[] | null
  entity_ids?: string[] | null
  archived?: boolean | null
  limit?: number | null
  /** 分页偏移（v2.8 P1-2，镜像 Rust `CanonEdgeFilter`）：仅 paged 读路径消费。 */
  offset?: number | null
  digest?: string[] | null
  /** as-of-revision 视角重建：仅返回 recorded_revision <= 该值的边（镜像 Rust `CanonEdgeFilter`）。 */
  max_recorded_revision?: number | null
}

/** canon_query_batch 响应（多查询单次 invoke）。 */
export interface CanonQueryBatchResponse {
  /** 与入参 filters 顺序一一对应的结果集（分页 filter 时为当前页）。 */
  results: CanonEdge[][]
  /** v2.8 P1-2：与 results 下标一一对应的过滤后全量计数（旧后端无此字段 → undefined）。 */
  totals?: number[]
  /** 当前项目 canon revision。 */
  max_revision: number
}

// ── G3 bi-temporal 事务时间轴查询辅助 (51 号报告，镜像 Rust CanonEdge::effective_*) ──

/**
 * 事务有效版本判定：记录在 `atTime`（unix seconds）是否为当前有效版本。
 * created_at <= atTime < expired_at（null/undefined 边界视为开放）。
 * 语义：查「某系统时刻该事实的当前版本」（bi-temporal as-of 查询）。
 */
export function isCanonEdgeEffectiveAt(edge: CanonEdge, atTime: number): boolean {
  const afterStart = edge.created_at == null || edge.created_at <= atTime
  const beforeEnd = edge.expired_at == null || atTime < edge.expired_at
  return afterStart && beforeEnd
}

/**
 * 有效事务开始时间（回退：created_at 缺失 → valid_at → 0）。
 * 旧数据无事务时间轴时用故事时间近似回退（守向后兼容，镜像 Rust effective_created_at）。
 */
export function effectiveCanonCreatedAt(edge: CanonEdge): number {
  return edge.created_at ?? edge.valid_at ?? 0
}

/**
 * 有效事务结束时间（回退：expired_at 缺失 → invalid_at → Number.MAX_SAFE_INTEGER 表示仍有效）。
 */
export function effectiveCanonExpiredAt(edge: CanonEdge): number {
  return edge.expired_at ?? edge.invalid_at ?? Number.MAX_SAFE_INTEGER
}
