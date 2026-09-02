/**
 * canon-revision-diff.ts — 跨 revision 边集 diff 纯函数（P2 对比模式）。
 *
 * 只消费投影后的 `CanonFact[]`（已剥离 `known_by`/`digest`），零 LLM、零 invoke、
 * 零副作用。纯函数，可独立单测。
 *
 * ## 数据模型根因（决定 diff 语义）
 *   - 边 `id` 不可变且唯一；supersede = 旧边原地封顶（写 `invalid_at`，保留
 *     `recorded_revision`）+ 插入全新 id 后继。
 *   - `recorded_revision` 是边**首次写入戳**；封顶（`invalid_at`）无历史 revision 戳，
 *     审计事件（old/new edge ids + revision）无 IPC 读出口。
 *
 * ## 键决策
 *   - 集合差主键 = 边 `id`（不可变、唯一、精确）。
 *   - 取代配对键 = 内容身份 `(sourceId, targetId, predicate, edgeKind, validAt)`
 *     （后继在人工校正写路径逐字段继承事实本体），不用裸 `(source, predicate, target)`
 *     以避免同三元组但不同类别/时态层的误配；明确排除 `invalidAt`/`recordedRevision`/
 *     `id`/`knownBy`/`revealedAt`/`digest`（变更域 / 内部句柄）。
 *
 * ## 已知限制
 *   - `invalidated`（封顶但同窗口无同内容后继，如回填分歧 `new_edges: []`）无法从
 *     `recorded_revision` 契约精确归属：封顶原地写 `invalid_at` 无 revision 戳、审计
 *     事件无 IPC 出口。本波恒返回空数组（类型预留）；精确判定需后端补强
 *     `canon_query_events`（读审计 `old_edge_ids/new_edge_ids/revision`）或给边加
 *     `invalidated_revision` 戳。
 */

import type { CanonFact } from "./canon-graph-client"

/**
 * 取代配对内容键：事实本体指纹（排除变更域 id/known_by/revealed_at/digest 与
 * invalid_at/recorded_revision/archived）。后继边逐字段继承此指纹 → 精确配对。
 */
export function supersedeKey(fact: CanonFact): string {
  return JSON.stringify([
    fact.sourceId,
    fact.targetId,
    fact.predicate,
    fact.edgeKind,
    fact.validAt ?? null,
  ])
}

/**
 * as-of 快照：`rev === null` → 空基线；否则取 `recordedRevision == null`（旧数据无戳，
 * 始终保留）或 `recordedRevision <= rev` 的边。
 */
export function asOfSnapshot(facts: readonly CanonFact[], rev: number | null): CanonFact[] {
  if (rev === null) return []
  return facts.filter((f) => f.recordedRevision == null || f.recordedRevision <= rev)
}

/** 从全量边集派生去重升序的非 null recordedRevision 列表（选择器选项）。 */
export function distinctRecordedRevisions(facts: readonly CanonFact[]): number[] {
  const set = new Set<number>()
  for (const f of facts) {
    if (f.recordedRevision != null) set.add(f.recordedRevision)
  }
  return [...set].sort((a, b) => a - b)
}

/** 取代配对：封顶旧边 + 后继新边（共享事实本体内容键）。 */
export interface CanonDiffSuperseded {
  kind: "superseded"
  /** 封顶旧边。 */
  before: CanonFact
  /** 后继新边。 */
  after: CanonFact
}

/** 单边变更（added / invalidated / removed）。 */
export interface CanonDiffEdge {
  kind: "added" | "invalidated" | "removed"
  edge: CanonFact
}

export type CanonDiffChange = CanonDiffSuperseded | CanonDiffEdge

export interface CanonRevisionDiff {
  revA: number | null
  revB: number | null
  /** 纯新增（after 中无同内容键封顶前任的边）。 */
  added: CanonFact[]
  /** 取代配对（封顶旧边 ↔ 同内容后继新边）。 */
  superseded: CanonDiffSuperseded[]
  /** 失效（封顶但同窗口无同内容后继）——本波恒空（见头注释 limitation）。 */
  invalidated: CanonFact[]
  /** 移除（before ∖ after 按 id）——append-only 模型恒空，防御性保留。 */
  removed: CanonFact[]
  /** 渲染用有序变更列表（superseded → invalidated → removed → added）。 */
  changes: CanonDiffChange[]
  /** 变更总数 = added + superseded + invalidated + removed。 */
  total: number
}

/**
 * 计算两 as-of 快照（before=revA、after=revB，A<B）间的边集差异。
 *
 * 1. 建 before/after 的 `Map<id, CanonFact>`；`added = after ∖ before`（按 id），
 *    `removed = before ∖ after`（防御，append-only 恒空）。
 * 2. 建 `cappedBeforeByKey: Map<supersedeKey, CanonFact[]>`：只收 before 中
 *    `invalidAt != null` 的边；每 key 候选按 `recordedRevision` 降序（多跳 supersede
 *    优先匹配最近前任）。
 * 3. 遍历 added，按 `supersedeKey` 贪心 `shift()` 首个候选 → 命中即生成 `superseded`
 *    配对并消耗该 added 边。
 * 4. `added` 字段 = 未被消耗的纯新增；`invalidated = []`（预留）；`removed` 直接输出。
 *
 * @param before revA 快照（`revA === null` 时传空数组 = 基线）
 * @param after  revB 快照
 * @param revA   起始 revision（null = 基线），仅回填结果元数据，不参与判定
 * @param revB   目标 revision（null 仅在无任何带戳边时合法），仅回填结果元数据
 */
export function diffCanonRevisions(
  before: readonly CanonFact[],
  after: readonly CanonFact[],
  revA: number | null = null,
  revB: number | null = null,
): CanonRevisionDiff {
  const beforeById = new Map<string, CanonFact>()
  for (const f of before) beforeById.set(f.id, f)
  const afterById = new Map<string, CanonFact>()
  for (const f of after) afterById.set(f.id, f)

  // 集合差（按 id）。
  const added: CanonFact[] = []
  for (const f of after) {
    if (!beforeById.has(f.id)) added.push(f)
  }
  const removed: CanonFact[] = []
  for (const f of before) {
    if (!afterById.has(f.id)) removed.push(f)
  }

  // 封顶旧边候选：按内容键分组，候选内按 recordedRevision 降序（最近前任优先）。
  const cappedBeforeByKey = new Map<string, CanonFact[]>()
  for (const f of before) {
    if (f.invalidAt != null) {
      const key = supersedeKey(f)
      const arr = cappedBeforeByKey.get(key)
      if (arr) arr.push(f)
      else cappedBeforeByKey.set(key, [f])
    }
  }
  const byRecentFirst = (a: CanonFact, b: CanonFact): number => {
    const ra = a.recordedRevision ?? Number.NEGATIVE_INFINITY
    const rb = b.recordedRevision ?? Number.NEGATIVE_INFINITY
    return rb - ra
  }
  for (const arr of cappedBeforeByKey.values()) arr.sort(byRecentFirst)

  // 取代配对：贪心取每个内容键的最近封顶前任。
  const superseded: CanonDiffSuperseded[] = []
  const consumedAdded = new Set<string>()
  for (const f of added) {
    const key = supersedeKey(f)
    const candidates = cappedBeforeByKey.get(key)
    if (candidates && candidates.length > 0) {
      const beforeEdge = candidates.shift()!
      superseded.push({ kind: "superseded", before: beforeEdge, after: f })
      consumedAdded.add(f.id)
    }
  }

  // 纯新增 = added 排除被取代配对消耗者。
  const pureAdded = added.filter((f) => !consumedAdded.has(f.id))
  // 失效：本波恒空（见头注释 limitation）。
  const invalidated: CanonFact[] = []

  const changes: CanonDiffChange[] = [
    ...superseded,
    ...invalidated.map((edge) => ({ kind: "invalidated" as const, edge })),
    ...removed.map((edge) => ({ kind: "removed" as const, edge })),
    ...pureAdded.map((edge) => ({ kind: "added" as const, edge })),
  ]

  return {
    revA,
    revB,
    added: pureAdded,
    superseded,
    invalidated,
    removed,
    changes,
    total: pureAdded.length + superseded.length + invalidated.length + removed.length,
  }
}
