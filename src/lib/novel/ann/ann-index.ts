/**
 * ann/ann-index.ts — B3-b 可插拔 ANN 接口契约（批准计划 r3 §T6）。
 *
 * 定位：**契约 + 度量口径**，不含任何近似索引算法（HNSW/IVF/PQ 均未实现）。
 *   - `AnnIndex`：可替换接口（`build` / `search` / `descriptor`）；
 *   - zod strict schema：向量 / 查询 / 命中 / 描述子；
 *   - 度量原语：`recallAtK`（recall@k，纯函数）与 `withInjectedClock`（**注入时钟**，
 *     零墙钟 —— ADR-19：机械层不读时钟，延迟度量由调用方注入）。
 *
 * 硬边界：本模块与同目录 `brute-force-index.ts` 均为纯函数/纯计算，零 IO / 零时钟 / 零模型调用；
 * **不解除** `ANN_PLAN.implemented=false`（近似未实现 → `ann_no_implementation` 谓词保持 locked）。
 *
 * @license MIT © Niko Buddy
 */
import { z } from "zod"
import { ANN_INDEX_KIND_SCHEMA } from "../retrieval-scale-placeholders"

export class AnnIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AnnIndexError"
  }
}

/** 索引类型：`exact` = 精确暴力参考；其余为占位选型（未实现）。 */
export const ANN_INDEX_TYPE_SCHEMA = z.union([ANN_INDEX_KIND_SCHEMA, z.literal("exact")])
export type AnnIndexType = z.infer<typeof ANN_INDEX_TYPE_SCHEMA>

/** 距离度量（决定打分口径；实现方须在 descriptor 中声明）。 */
export const ANN_METRIC_SCHEMA = z.enum(["cosine", "l2"])
export type AnnMetric = z.infer<typeof ANN_METRIC_SCHEMA>

export const ANN_VECTOR_SCHEMA = z
  .object({
    id: z.string().min(1),
    values: z.array(z.number().finite()).min(1),
  })
  .strict()

export const ANN_QUERY_SCHEMA = z
  .object({
    values: z.array(z.number().finite()).min(1),
    k: z.number().int().positive(),
  })
  .strict()

export const ANN_HIT_SCHEMA = z
  .object({
    id: z.string().min(1),
    score: z.number(),
    /** 1-based 名次（确定性全序 → 名次可复现）。 */
    rank: z.number().int().positive(),
  })
  .strict()

export const ANN_DESCRIPTOR_SCHEMA = z
  .object({
    kind: ANN_INDEX_TYPE_SCHEMA,
    metric: ANN_METRIC_SCHEMA,
    dimension: z.number().int().positive(),
    size: z.number().int().nonnegative(),
    /** 是否精确（无近似误差）。 */
    exact: z.boolean(),
    /** 能力/限制声明（必须非空：任何实现都须自证边界）。 */
    note: z.string().min(1),
  })
  .strict()

export type AnnVector = z.infer<typeof ANN_VECTOR_SCHEMA>
export type AnnQuery = z.infer<typeof ANN_QUERY_SCHEMA>
export type AnnHit = z.infer<typeof ANN_HIT_SCHEMA>
export type AnnDescriptor = z.infer<typeof ANN_DESCRIPTOR_SCHEMA>

/** 可插拔索引接口（实现方：精确参考 `createExactAnnIndex`；近似实现待认领）。 */
export interface AnnIndex {
  /** 装载向量（可多次 build；以最后一次为准）。 */
  build(vectors: readonly AnnVector[]): void
  /** 查询 top-k（确定性全序：score desc → id asc）。 */
  search(query: AnnQuery): AnnHit[]
  /** 描述子（类型/度量/维度/规模/精确定/限制声明）。 */
  descriptor(): AnnDescriptor
  /** 当前规模。 */
  size(): number
}

/**
 * recall@k（纯函数）：候选 top-k 覆盖参考 top-k 的比例。
 * 参考与候选均按名次给出 id 序列（调用方保证已按同一口径排序）。
 */
export function recallAtK(
  referenceIds: readonly string[],
  candidateIds: readonly string[],
  k: number,
): number {
  if (!Number.isInteger(k) || k <= 0) {
    throw new AnnIndexError(`recall@k 的 k 非法：${k}（须正整数）`)
  }
  const topRef = referenceIds.slice(0, k)
  if (topRef.length === 0) return 1
  const candidateTop = new Set(candidateIds.slice(0, k))
  const hit = topRef.filter((id) => candidateTop.has(id)).length
  return hit / topRef.length
}

/**
 * 注入时钟包装（零墙钟）：`clock()` 每次调用返回一个毫秒读数；
 * 返回 `{ result, durationMs }`，同一注入序列 → 同一 durationMs（可复现）。
 */
export function withInjectedClock<T>(clock: () => number, fn: () => T): { result: T; durationMs: number } {
  const start = clock()
  const result = fn()
  const end = clock()
  return { result, durationMs: end - start }
}
