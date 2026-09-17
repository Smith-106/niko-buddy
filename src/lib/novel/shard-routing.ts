/**
 * shard-routing.ts — B3-a 检索分片路由 + 跨片确定性归并（批准计划 r3 §T5）。
 *
 * 语义：
 *   - 分片键（`key`）：`none` = 单片（严格保序，用于字节等价基线）；`type` = 按召回来源；
 *     `collection` = 按参考库集合（缺失 → `unknown`）。
 *   - 片内选择（`selectShardItems`）：**仅在给出 `perShardTopK` 时排序+截断**（relevance desc →
 *     path asc）；不给上限则**保序**（这是「省略 shards / 单片 = 字节等价现状」的实现基础）。
 *   - 跨片归并（`mergeShards`）：两种确定性策略 ——
 *       `shard-major`（默认）：按分片首现顺序拼接，片内保序；跨片去重取**首现**。
 *       `score-major`：全局 relevance desc → path asc（**仅同尺度面可用**：跨源分数不可比）。
 *     两策略均满足「同一输入集合 → 同一输出序列」。
 *
 * 硬边界（ADR-19）：纯函数、零 IO / 零时钟 / 零模型调用；不读视图、不改默认行为。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"

export class ShardRoutingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ShardRoutingError"
  }
}

export const SHARD_KEY_SCHEMA = z.enum(["none", "type", "collection"])

export const SHARD_MERGE_POLICY_SCHEMA = z.enum(["shard-major", "score-major"])

/** 分片召回规格（`novelMixedSearch` 的可选参数；不传 = 不启用分片）。 */
export const SHARD_RECALL_SPEC_SCHEMA = z
  .object({
    key: SHARD_KEY_SCHEMA,
    /** 片内召回上限；不传 = 不截断（保序）。 */
    perShardTopK: z.number().int().positive().optional(),
    /** 归并策略；默认 shard-major。 */
    policy: SHARD_MERGE_POLICY_SCHEMA.optional(),
  })
  .strict()

export type ShardRecallSpec = z.infer<typeof SHARD_RECALL_SPEC_SCHEMA>

/** 参与分片的最小结构（与 NovelSearchResult 结构兼容，不绑定具体类型）。 */
export interface ShardableItem {
  /** 分片键的取键来源（`collection` 用；缺失按 unknown 计）。 */
  collection?: string
  /** 分片键的取键来源（`type` 用）。 */
  type?: string
  path: string
  relevance: number
}

export interface Shard<T> {
  key: string
  items: T[]
}

/** 去重键：`type\u0000path`（跨源同 path 属不同候选，不得在 RRF 前合并）。 */
function dedupeKey(item: ShardableItem): string {
  return `${item.type ?? ""}\u0000${item.path}`
}

/** 解析分片键（缺失 → "unknown"）。 */
function shardKeyOf(item: ShardableItem, key: "type" | "collection"): string {
  const raw = key === "type" ? item.type : item.collection
  return raw && raw.length > 0 ? raw : "unknown"
}

/**
 * 分片（保序分区）：分片按**首现顺序**排列，片内保持输入顺序。
 * `key="none"` → 单片（严格等于输入序列）。
 */
export function resolveShards<T extends ShardableItem>(
  items: readonly T[],
  key: "none" | "type" | "collection",
): Array<Shard<T>> {
  if (key === "none") return [{ key: "none", items: [...items] }]
  const order: string[] = []
  const byKey = new Map<string, T[]>()
  for (const item of items) {
    const k = shardKeyOf(item, key)
    let bucket = byKey.get(k)
    if (!bucket) {
      bucket = []
      byKey.set(k, bucket)
      order.push(k)
    }
    bucket.push(item)
  }
  return order.map((k) => ({ key: k, items: byKey.get(k) ?? [] }))
}

/**
 * 片内选择：给出 `perShardTopK` 时按 (relevance desc, path asc) 排序并截断；
 * 不给上限则**保序不排序**（保证单片基线字节等价）。
 */
export function selectShardItems<T extends ShardableItem>(
  shard: Shard<T>,
  perShardTopK?: number,
): Shard<T> {
  if (perShardTopK === undefined) return shard
  if (!Number.isInteger(perShardTopK) || perShardTopK <= 0) {
    throw new ShardRoutingError(`perShardTopK 非法：${perShardTopK}（须正整数）`)
  }
  const sorted = [...shard.items].sort(
    (a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path),
  )
  return { key: shard.key, items: sorted.slice(0, perShardTopK) }
}

/**
 * 跨片确定性归并。
 * - `shard-major`：分片首现顺序拼接，片内保序；跨片去重（type+path）取首现。
 * - `score-major`：全局 (relevance desc, path asc)；跨片去重取最高分。
 */
export function mergeShards<T extends ShardableItem>(
  shards: ReadonlyArray<Shard<T>>,
  policy: "shard-major" | "score-major" = "shard-major",
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  if (policy === "shard-major") {
    for (const shard of shards) {
      for (const item of shard.items) {
        const k = dedupeKey(item)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(item)
      }
    }
    return out
  }
  const all: T[] = []
  for (const shard of shards) all.push(...shard.items)
  const deduped = new Map<string, T>()
  for (const item of all) {
    const k = dedupeKey(item)
    const prev = deduped.get(k)
    if (!prev || item.relevance > prev.relevance) deduped.set(k, item)
  }
  return [...deduped.values()].sort(
    (a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path),
  )
}

export interface ShardRecallReport<T> {
  key: string
  shardCount: number
  shardKeys: string[]
  perShardTopK: number | null
  policy: "shard-major" | "score-major"
  inputCount: number
  outputCount: number
  items: T[]
}

/**
 * 一体化分片召回（resolve → select → merge），返回归并结果与可观测报告。
 * 规格非法时 fail-loud（不静默降级为不分片）。
 */
export function applyShardRecall<T extends ShardableItem>(
  items: readonly T[],
  spec: z.input<typeof SHARD_RECALL_SPEC_SCHEMA>,
): ShardRecallReport<T> {
  const parsed = SHARD_RECALL_SPEC_SCHEMA.safeParse(spec)
  if (!parsed.success) {
    throw new ShardRoutingError(`分片规格非法：${parsed.error.message}`)
  }
  const { key, perShardTopK } = parsed.data
  const policy = parsed.data.policy ?? "shard-major"
  const shards = resolveShards(items, key)
  const selected = shards.map((s) => selectShardItems(s, perShardTopK))
  const merged = mergeShards(selected, policy)
  return {
    key,
    shardCount: shards.length,
    shardKeys: shards.map((s) => s.key),
    perShardTopK: perShardTopK ?? null,
    policy,
    inputCount: items.length,
    outputCount: merged.length,
    items: merged,
  }
}
