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
}

/** canon_query 过滤（与 Rust `CanonEdgeFilter` 契约一致，snake_case）。 */
export interface CanonEdgeFilter {
  known_by?: string | null
  valid_at_chapter?: number | null
  edge_kinds?: CanonEdgeKind[] | null
  predicates?: string[] | null
  entity_ids?: string[] | null
  archived?: boolean | null
  limit?: number | null
  /** 按 digest 列表过滤（精确匹配；DEBT-20260621-30b supersede 分歧检测用）。 */
  digest?: string[] | null
}

/** canon_query / canon_facts_known_by 原始响应。 */
export interface CanonQueryResponseRaw {
  edges: RawCanonEdge[]
  max_revision: number
}

/** canon_query_batch 原始响应（多查询单 invoke）。 */
export interface CanonQueryBatchResponseRaw {
  results: RawCanonEdge[][]
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
 * @returns 投影后的安全 `CanonFact[]`（已剥离 `known_by`/`digest`）
 */
export async function getFactsKnownBy(
  projectId: string,
  characterId: string,
  atChapter?: number,
): Promise<CanonFact[]> {
  const res = await invoke<CanonQueryResponseRaw>("canon_facts_known_by", {
    projectId,
    pov: characterId,
    atChapter: atChapter ?? null,
  })
  return projectEdges(res.edges)
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
 * 返回该章全部 episode 行（含 ingest_log 去重语义）。
 *
 * @param projectId 项目 id
 * @param chapterNumber 章节号
 * @returns 该章原始 episode 行（含 digest 等内部字段，调用方自行处理）
 */
export async function queryEpisodesByChapter(
  projectId: string,
  chapterNumber: number,
): Promise<{ episodes: Array<{ id: string; chapter_number: number; entity_id: string; summary: string; digest: string }>; max_revision: number }> {
  return invoke("canon_query_episodes", {
    projectId,
    chapterNumber,
  })
}
