/**
 * canon-graph-client.ts — Canon 图投影薄客户端（T14 / F-13）。
 *
 * 封装 T13 IPC invoke（canon_query / canon_query_batch / canon_facts_known_by），
 * 向上层（T25/T33 五角色共用读出口）提供投影后的 TS API。
 *
 * ## 禁句柄外泄（POV 防泄密地基）
 *   投影严格 allowlist：只把安全语义字段升为 camelCase 的 `CanonFact`，
 *   绝不拷贝认知轴内部句柄 `known_by`（谁知晓该事实）与写路径幂等键 `digest`。
 *   这两个字段是内部句柄，一旦外泄到读出口，五角色即可借此重建他人的认知图 → POV 泄密。
 *   `assertNoHandleLeak` 作为运行时兜底断言（defense-in-depth）：任何投影产物
 *   含 `known_by`/`digest` 即抛错——即使在 Tauri 未加载的纯单测环境也能守护读出口契约。
 *
 * ## 契约约定（与 T13 / Rust 对齐）
 *   - 命令名 snake_case；Tauri v2 顶层参数 camelCase（project_id → projectId）。
 *   - 嵌套 filter / 响应体走 serde snake_case，与 Rust `CanonEdgeFilter` / `CanonEdge` 对齐。
 *   - 多项目契约：单库查询，无跨库 join；`max_revision` 由 TS 侧缓存失效判定使用（本文件只透传响应）。
 *
 * 遵循 QMAI/CLAUDE.md：纯客户端封装，零 LLM、零副作用；Draft-first 不适用。
 */

import { invoke } from "@tauri-apps/api/core"

/** 边类别（与 Rust `EdgeKind` snake_case 序列化一致）。 */
export type CanonEdgeKind =
  | "world_fact"
  | "motivation"
  | "arc"
  | "foreshadow"
  | "hook"
  | "attribute"

/** 事实认知模态（落点①，与 edgeKind 正交）：assertive=叙述者断言（默认）；belief=角色相信；hypothesis=假设；retconned=回溯改写。 */
export type CanonModality =
  | "assertive"
  | "belief"
  | "hypothesis"
  | "retconned"

/** 原始边（IPC 返回，serde snake_case；含内部句柄 `known_by`/`digest`）。 */
export interface RawCanonEdge {
  id: string
  source_id: string
  target_id: string
  predicate: string
  edge_kind: CanonEdgeKind
  valid_at?: number | null
  invalid_at?: number | null
  reference_time?: number | null
  /** 内部认知轴句柄：知晓该事实的 POV 集合。读出口禁止外泄。 */
  known_by?: string[] | null
  revealed_at?: number | null
  confidence?: number | null
  source_chapter?: number | null
  /** 写路径幂等键。内部句柄，读出口禁止外泄。 */
  digest?: string | null
  beat_label?: string | null
  beat_hit?: boolean | null
  foreshadow_planted_at?: number | null
  hook_type?: string | null
  payoff_chapter?: number | null
  archived?: boolean | null
  /** 认知模态（落点①）：assertive/belief/hypothesis/retconned。旧数据（data JSON 无此字段）→ undefined。 */
  modality?: CanonModality | null
  /** 写入该边的写尝试 revision（attempt-count，含幂等 skip 的 post-bump 值）；旧数据无此字段 → undefined。 */
  recorded_revision?: number | null
}

/** canon_query 过滤（与 Rust `CanonEdgeFilter` 契约一致，snake_case）。 */
export interface CanonEdgeFilter {
  known_by?: string | null
  valid_at_chapter?: number | null
  /** 召回已失效窗口边（"曾以为"）：true=保留 invalid_at<=章节 的边；缺省/ false=旧行为（仅有效边）。与 Rust `include_invalidated` 对齐。 */
  include_invalidated?: boolean | null
  edge_kinds?: CanonEdgeKind[] | null
  predicates?: string[] | null
  entity_ids?: string[] | null
  archived?: boolean | null
  limit?: number | null
  /** 分页偏移（v2.8 P1-2）：仅 paged 读路径消费；缺省 = 旧行为（全量/limit 截断）。 */
  offset?: number | null
  /** 按 digest 列表过滤（精确匹配；DEBT-20260621-30b supersede 分歧检测用）。 */
  digest?: string[] | null
  /** as-of-revision 视角重建：仅返回 recorded_revision <= 该值的边（None=旧数据无戳，始终保留）。 */
  max_recorded_revision?: number | null
}

/** canon_query / canon_facts_known_by 原始响应。 */
export interface CanonQueryResponseRaw {
  edges: RawCanonEdge[]
  /** v2.8 P1-2：过滤后全量计数（分页时为幸存集全量；旧后端无此字段 → undefined）。 */
  total?: number
  max_revision: number
}

/** canon_facts_known_by 分页原始响应（P1-1：offset/limit/total）。 */
export interface CanonFactsKnownByResponseRaw {
  edges: RawCanonEdge[]
  total: number
  max_revision: number
}

/** canon_query_batch 原始响应（多查询单 invoke）。 */
export interface CanonQueryBatchResponseRaw {
  results: RawCanonEdge[][]
  /** v2.8 P1-2：与 results 下标一一对应的过滤后全量计数（旧后端无此字段 → undefined）。 */
  totals?: number[]
  max_revision: number
}

/**
 * 投影后的安全读出口事实（camelCase）。
 *
 * **不含** `knownBy` / `digest` —— 这两个内部句柄被投影层剥离（见 `projectEdge`）。
 * T25/T33 五角色只通过此类型消费 canon 事实，确保 POV 防泄密地基不被击穿。
 */
export interface CanonFact {
  id: string
  sourceId: string
  targetId: string
  predicate: string
  edgeKind: CanonEdgeKind
  validAt?: number | null
  invalidAt?: number | null
  referenceTime?: number | null
  revealedAt?: number | null
  confidence?: number | null
  sourceChapter?: number | null
  beatLabel?: string | null
  beatHit?: boolean | null
  foreshadowPlantedAt?: number | null
  hookType?: string | null
  payoffChapter?: number | null
  archived: boolean
  /** 认知模态（落点①）：assertive/belief/hypothesis/retconned。 */
  modality?: CanonModality | null
  /** 写入该边的写尝试 revision（attempt-count）。 */
  recordedRevision?: number | null
}

/**
 * 内部句柄集合：绝不允许出现在投影读出口（`CanonFact`）。
 * - `known_by`：POV 认知轴句柄（谁知晓），外泄即 POV 泄密（F-13）。
 * - `digest`：写路径幂等键，内部句柄。
 */
export const FORBIDDEN_HANDLE_KEYS = ["known_by", "digest"] as const

/**
 * 禁句柄外泄断言（POV 防泄密兜底）。
 *
 * 抛错若：投影对象含 `known_by`/`digest` 键、或为 null / 非普通对象 / 数组。
 * 即使 Tauri 未加载（纯单测），也可直接调用以守护读出口契约不被击穿。
 */
export function assertNoHandleLeak(fact: unknown): asserts fact is CanonFact {
  if (fact === null || typeof fact !== "object" || Array.isArray(fact)) {
    throw new Error("[canon-graph-client] 投影产物不是普通对象，疑似句柄外泄")
  }
  const obj = fact as Record<string, unknown>
  for (const key of FORBIDDEN_HANDLE_KEYS) {
    if (key in obj) {
      throw new Error(
        `[canon-graph-client] 禁句柄外泄断言失败：投影读出口含内部句柄 "${key}"（POV 防泄密）`,
      )
    }
  }
}

/**
 * 单条边投影：把 `RawCanonEdge` 升为安全 `CanonFact`（allowlist，剥离 `known_by`/`digest`）。
 * 返回前立即经 `assertNoHandleLeak` 守护，任何句柄外泄都会被即时拦下。
 */
export function projectEdge(raw: RawCanonEdge): CanonFact {
  const fact: CanonFact = {
    id: raw.id,
    sourceId: raw.source_id,
    targetId: raw.target_id,
    predicate: raw.predicate,
    edgeKind: raw.edge_kind,
    validAt: raw.valid_at ?? null,
    invalidAt: raw.invalid_at ?? null,
    referenceTime: raw.reference_time ?? null,
    revealedAt: raw.revealed_at ?? null,
    confidence: raw.confidence ?? null,
    sourceChapter: raw.source_chapter ?? null,
    beatLabel: raw.beat_label ?? null,
    beatHit: raw.beat_hit ?? null,
    foreshadowPlantedAt: raw.foreshadow_planted_at ?? null,
    hookType: raw.hook_type ?? null,
    payoffChapter: raw.payoff_chapter ?? null,
    archived: raw.archived ?? false,
    modality: raw.modality ?? null,
    recordedRevision: raw.recorded_revision ?? null,
  }
  assertNoHandleLeak(fact)
  return fact
}

/** 投影一批边（逐一 allowlist + 禁句柄外泄守护）。 */
export function projectEdges(raws: RawCanonEdge[]): CanonFact[] {
  return raws.map(projectEdge)
}

/**
 * 按 POV 认知轴取该角色已知事实（T13 `canon_facts_known_by` 投影封装）。
 *
 * @param projectId 项目 id（多项目契约：单库查询，无跨库 join）
 * @param characterId POV 角色 id（认知轴 filter `known_by`）
 * @param atChapter 世界时态截点（可选；仅返回该章仍有效的边）
 * @param includeInvalidated 召回已失效窗口边（"曾以为"）：true=保留 invalid_at<=章节 的边。
 *   用于 POV 精确归因（角色 X 曾以为…），剥离世界层投影限制。
 * @returns 投影后的安全 `CanonFact[]`（已剥离 `known_by`/`digest`）
 */
export async function getFactsKnownBy(
  projectId: string,
  characterId: string,
  atChapter?: number,
  includeInvalidated?: boolean,
): Promise<CanonFact[]> {
  return (
    await getFactsKnownByPaged(projectId, characterId, atChapter, includeInvalidated)
  ).facts
}

/**
 * 按 POV 认知轴取该角色已知事实（分页版；P1-1）。
 *
 * @param projectId 项目 id
 * @param characterId POV 角色 id（认知轴 filter `known_by`）
 * @param atChapter 世界时态截点（可选）
 * @param includeInvalidated 召回已失效窗口边（可选）
 * @param page 可选分页（offset/limit）；缺省 = 全量
 * @returns 投影后 `facts` + 服务端 `total` + `maxRevision`
 */
export async function getFactsKnownByPaged(
  projectId: string,
  characterId: string,
  atChapter?: number,
  includeInvalidated?: boolean,
  page?: { offset: number; limit: number },
): Promise<{ facts: CanonFact[]; total: number; maxRevision: number }> {
  const res = await invoke<CanonFactsKnownByResponseRaw>("canon_facts_known_by", {
    projectId,
    pov: characterId,
    atChapter: atChapter ?? null,
    includeInvalidated: includeInvalidated ?? null,
    offset: page?.offset ?? null,
    limit: page?.limit ?? null,
  })
  return {
    facts: projectEdges(res.edges),
    total: res.total,
    maxRevision: res.max_revision,
  }
}

/**
 * 结构化过滤查询（T13 `canon_query` 投影封装）。
 * @param projectId 项目 id
 * @param filter 边过滤条件（snake_case，契约同 Rust `CanonEdgeFilter`）
 */
export async function queryCanonEdges(
  projectId: string,
  filter: CanonEdgeFilter,
): Promise<CanonFact[]> {
  const res = await invoke<CanonQueryResponseRaw>("canon_query", {
    projectId,
    filter,
  })
  return projectEdges(res.edges)
}

/**
 * 批量过滤查询（T13 `canon_query_batch` 投影封装）。
 * @returns 与 `filters` 顺序一一对应的投影结果集。
 */
export async function queryCanonEdgesBatch(
  projectId: string,
  filters: CanonEdgeFilter[],
): Promise<CanonFact[][]> {
  const res = await invoke<CanonQueryBatchResponseRaw>("canon_query_batch", {
    projectId,
    filters,
  })
  return res.results.map(projectEdges)
}

/**
 * 按章节号查询 episodes（DEBT-20260621-30b supersede 分歧检测读路径）。
 * 返回该章 episode 行（含 ingest_log 去重语义）。
 *
 * v2.8 P1-2：支持可选分页（offset/limit）。缺省时保持旧行为（全量拉取）；
 * 分页时响应含 `total`（该章全量计数）供 UI 分页器使用。
 *
 * @param projectId 项目 id
 * @param chapterNumber 章节号
 * @param page 可选分页（offset/limit）；缺省 = 全量
 * @returns 该章 episode 行（含 digest 等内部字段，调用方自行处理）+ total + max_revision
 */
export async function queryEpisodesByChapter(
  projectId: string,
  chapterNumber: number,
  page?: { offset: number; limit: number },
): Promise<{ episodes: Array<{ id: string; chapter_number: number; entity_id: string; summary: string; digest: string }>; total: number; max_revision: number }> {
  return invoke("canon_query_episodes", {
    projectId,
    chapterNumber,
    offset: page?.offset ?? null,
    limit: page?.limit ?? null,
  })
}

/**
 * v2.8 P1-2：便捷筛选构造器（query_batch 批量筛选条件）。
 *
 * 把常见筛选意图（边类别/谓词/实体/认知轴/时态截点/分页）构造为
 * 与 Rust `CanonEdgeFilter` 契约一致的 snake_case filter，供
 * `queryCanonEdgesBatch` / `queryCanonEdges` 使用。
 *
 * v2.8 P1-2：分页（offset/limit）随 filter 搭载（canon_query/batch 签名不变）。
 *
 * @param opts 筛选意图（全部可选；缺省 = 全量查询）
 */
export function buildCanonEdgeFilter(opts: {
  edgeKinds?: CanonEdgeKind[]
  predicates?: string[]
  entityIds?: string[]
  knownBy?: string
  validAtChapter?: number
  includeInvalidated?: boolean
  archived?: boolean
  digest?: string[]
  limit?: number
  /** 分页偏移（0 基；与 limit 搭载实现服务端分页）。 */
  offset?: number
  maxRecordedRevision?: number
}): CanonEdgeFilter {
  return {
    known_by: opts.knownBy ?? null,
    valid_at_chapter: opts.validAtChapter ?? null,
    include_invalidated: opts.includeInvalidated ?? null,
    edge_kinds: opts.edgeKinds ?? null,
    predicates: opts.predicates ?? null,
    entity_ids: opts.entityIds ?? null,
    archived: opts.archived ?? null,
    digest: opts.digest ?? null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
    max_recorded_revision: opts.maxRecordedRevision ?? null,
  }
}
