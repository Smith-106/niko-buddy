/**
 * same-scale-harness.ts — R0-a1 同尺迁移评测比较核。
 *
 * 共识来源：DeepSeek-flash + GLM-5.2 两路探讨共识 P0#1 同尺迁移评测；
 * 批准计划 r2 §R0-a1，planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113。
 *
 * 口径诚实声明（反目标 AG3 豁免标记，同源回归口径）：
 *   - W 面（reference/WeKnora dataset/samples，commit 1ef38fdb）服务不可运行，
 *     未做逐 query 跨系统对跑；"同尺"指评测方法同尺（rank 分档 + topK 命中率 +
 *     Wilson 95% CI），非同实例对跑。
 *   - W demo 快照 qrels 把全 corpus（4/4，pid 1-4，score 全 1）标为相关，
 *     topK 恒 1.0，无判别力——仅作方法学对齐参照，不作精度对比数字。
 *   - P1 臂 = golden-34 在 channel-B 面的 rank 分档（与 golden-retrieval.spec.ts
 *     的 channelBRank 同构：路由 collections 排除 tech，hay=name+title+domain，
 *     tokensForKbMatch + rankByBm25），裁决看 Wilson CI 下界。
 *
 * 统计口径冻结（计划 r2 §R0-a1）：N=34 用 Wilson 95% CI，裁决看 CI 下界；
 * 点估计≥0.7 但下界<0.7 记"未达裁决"。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟 / 零模型调用；
 * docs 与 kb 视图由调用方传入（IO 层组装）。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"

// ============================================================================
// 快照 schema（extract-weknora-snapshot.mjs 产出）
// ============================================================================

/** parquet 文件元信息。 */
export const WEKNORA_FILE_META_SCHEMA = z
  .object({
    rows: z.number().int().nonnegative(),
    columns: z.array(z.string()),
  })
  .strict()

/** WeKnora 快照 schema。 */
export const WEKNORA_SNAPSHOT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().min(1),
    sourceCommit: z.string().min(1),
    files: z.record(z.string(), WEKNORA_FILE_META_SCHEMA),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.string()))),
  })
  .strict()

export type WeknoraSnapshot = z.infer<typeof WEKNORA_SNAPSHOT_SCHEMA>

// ============================================================================
// 输入 schema
// ============================================================================

/** golden query 的 rank 测量（调用方由 channel-B 面算出后传入）。 */
export const GOLDEN_RANK_SCHEMA = z
  .object({
    query: z.string().min(1),
    rank: z.number().positive(),
    top3: z.boolean(),
    top20: z.boolean(),
  })
  .strict()

export type GoldenRank = z.infer<typeof GOLDEN_RANK_SCHEMA>

/** compareSameScale 输入。 */
export const SAME_SCALE_INPUT_SCHEMA = z
  .object({
    ranks: z.array(GOLDEN_RANK_SCHEMA).min(1).max(4096),
    snapshot: WEKNORA_SNAPSHOT_SCHEMA,
    /** top3 裁决阈值（缺省 0.7 = golden _meta.baseline.minTop3Rate）。 */
    top3Threshold: z.number().min(0).max(1).default(0.7),
  })
  .strict()

export type SameScaleInput = z.infer<typeof SAME_SCALE_INPUT_SCHEMA>

// ============================================================================
// Wilson 得分区间（95% CI，z=1.96）
// ============================================================================

/** Wilson 得分区间上下界（k 成功 / n 总数）。 */
export interface WilsonInterval {
  lower: number
  upper: number
}

/**
 * Wilson 得分区间（正态近似，z=1.96，95% CI）。
 * 纯函数；k=0 与 k=n 的边界行为由公式自然给出（不截断到 [0,1] 之外，
 * 调用方展示时保留 4 位小数）。
 */
export function wilsonScoreInterval(k: number, n: number, z = 1.96): WilsonInterval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n <= 0 || k > n) {
    throw new SameScaleHarnessError(`Wilson 输入非法：k=${k} n=${n}（须 0≤k≤n 且 n>0）`)
  }
  const p = k / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const delta = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return {
    lower: (center - delta) / denominator,
    upper: (center + delta) / denominator,
  }
}

// ============================================================================
// 比较核
// ============================================================================

/** 比较核错误（输入非法时 fail-loud）。 */
export class SameScaleHarnessError extends Error {
  constructor(message: string) {
    super(`[same-scale-harness] ${message}`)
    this.name = "SameScaleHarnessError"
  }
}

/** P1 臂判定：triggered（达裁决）/ 未达裁决。 */
export const SAME_SCALE_VERDICT_SCHEMA = z.enum(["triggered", "未达裁决"])

export type SameScaleVerdict = z.infer<typeof SAME_SCALE_VERDICT_SCHEMA>

/** compareSameScale 输出。 */
export interface SameScaleResult {
  /** P1 臂：top3 点估计 + Wilson CI + 样本量 + 判定 + 掉档 query 清单。 */
  p1: {
    n: number
    top3Hits: number
    top3Rate: number
    wilsonLower: number
    wilsonUpper: number
    threshold: number
    verdict: SameScaleVerdict
    droppedQueries: string[]
  }
  /** W 臂：方法学对齐参照（非精度对比数字）。 */
  w: {
    sourceCommit: string
    corpusSize: number
    goldSize: number
    queryCount: number
    note: string
  }
}

/**
 * 同尺比较（纯函数）：P1 golden rank 分档 Wilson CI 自评 + W 快照方法学对齐。
 * 不伪造跨系统对比数字（W 服务不可运行）；W 面 qrels 全标导致 topK 恒 1.0，
 * 无判别力，如实声明。
 */
export function compareSameScale(input: SameScaleInput): SameScaleResult {
  const parsed = SAME_SCALE_INPUT_SCHEMA.safeParse(input)
  if (!parsed.success) {
    throw new SameScaleHarnessError(`输入 schema 校验失败：${parsed.error.message}`)
  }
  const { ranks, snapshot, top3Threshold } = parsed.data
  const n = ranks.length
  const top3Hits = ranks.filter((r) => r.top3).length
  const { lower, upper } = wilsonScoreInterval(top3Hits, n)
  // 裁决看 CI 下界：下界≥阈值才算达裁决（点估计达标但下界未达标记"未达裁决"）。
  const verdict: SameScaleVerdict = lower >= top3Threshold ? "triggered" : "未达裁决"
  const droppedQueries = ranks.filter((r) => !r.top3).map((r) => r.query)

  const qrels = snapshot.tables["qrels.parquet"] ?? []
  const corpus = snapshot.tables["corpus.parquet"] ?? []
  const queries = snapshot.tables["queries.parquet"] ?? []
  const goldPids = new Set(qrels.filter((row) => row["score"] === "1").map((row) => row["pid"]))

  return {
    p1: {
      n,
      top3Hits,
      top3Rate: top3Hits / n,
      wilsonLower: Math.round(lower * 10000) / 10000,
      wilsonUpper: Math.round(upper * 10000) / 10000,
      threshold: top3Threshold,
      verdict,
      droppedQueries,
    },
    w: {
      sourceCommit: snapshot.sourceCommit,
      corpusSize: corpus.length,
      goldSize: goldPids.size,
      queryCount: queries.length,
      note:
        "W 面服务不可运行，未做逐 query 跨系统对跑；qrels 全标 " +
        `(${goldPids.size}/${corpus.length}) 导致 topK 恒 1.0 无判别力，仅作方法学对齐参照` +
        "（同为 rank 分档 + topK 命中率）。同源回归口径，不可作收敛结论。",
    },
  }
}
