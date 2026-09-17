/**
 * rerank-trigger-evidence.ts — R0-b rerank 触发证据采集器。
 *
 * 共识来源：批准计划 r2 §R0-b（planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113）；
 * 消费 golden `_meta.rerankTrigger` 既有规则（golden-retrieval.spec F5 哨）。
 *
 * 职责：把「各 query 的 top3/top20 rank 分档」判定为 trigger 状态与候选集，
 * 作为 R2-a 提名谓词的硬依赖输入（证据文件缺失 → 相关谓词直接 locked）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟 / 零模型调用；
 * 时间戳由调用方注入（零时钟），trace 落盘由调用方决定。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import type { RetrievalTraceEntry } from "./retrieval-trace"

/** rerank 触发证据的 trace 通道名（retrieval-trace 消费；唯一字面量）。 */
export const RERANK_TRIGGER_CHANNEL = "rerank-trigger" as const

/** 规则陈述（与 golden `_meta.rerankTrigger.rule` 同判据；spec 做漂移自检）。 */
export const RERANK_TRIGGER_RULE =
  "top20 守住（top20Rate ≥ minTop20Rate）而 top3 掉档（top3Rate < minTop3Rate）→ 触发 rerank 采纳证据；top20 未达即非触发（状态落 armed）" as const

// ============================================================================
// zod 契约
// ============================================================================

/** 单 query 的 rank 分档（与 golden-retrieval.spec channelBRank 输出同形）。 */
export const RERANK_TRIGGER_RANK_SCHEMA = z
  .object({
    query: z.string().min(1),
    rank: z.number().positive(),
    top3: z.boolean(),
    top20: z.boolean(),
  })
  .strict()

export type RerankTriggerRank = z.infer<typeof RERANK_TRIGGER_RANK_SCHEMA>

/** 基线阈值（golden `_meta.baseline` 子集）。 */
export const RERANK_TRIGGER_BASELINE_SCHEMA = z
  .object({
    minTop3Rate: z.number().min(0).max(1),
    minTop20Rate: z.number().min(0).max(1),
  })
  .strict()

export type RerankTriggerBaseline = z.infer<typeof RERANK_TRIGGER_BASELINE_SCHEMA>

/** 采集器输入。 */
export const RERANK_TRIGGER_INPUT_SCHEMA = z
  .object({
    ranks: z.array(RERANK_TRIGGER_RANK_SCHEMA).min(1).max(4096),
    baseline: RERANK_TRIGGER_BASELINE_SCHEMA,
  })
  .strict()

export type RerankTriggerInput = z.infer<typeof RERANK_TRIGGER_INPUT_SCHEMA>

/** trigger 状态：triggered（产出采纳证据）/ armed（哨已就位，未达触发）。 */
export const RERANK_TRIGGER_STATUS_SCHEMA = z.enum(["triggered", "armed"])

export type RerankTriggerStatus = z.infer<typeof RERANK_TRIGGER_STATUS_SCHEMA>

/** 采集器输出（证据快照形状真源）。 */
export const RERANK_TRIGGER_EVIDENCE_SCHEMA = z
  .object({
    status: RERANK_TRIGGER_STATUS_SCHEMA,
    rule: z.string().min(1),
    n: z.number().int().positive(),
    top3Hits: z.number().int().nonnegative(),
    top20Hits: z.number().int().nonnegative(),
    top3Rate: z.number().min(0).max(1),
    top20Rate: z.number().min(0).max(1),
    minTop3Rate: z.number().min(0).max(1),
    minTop20Rate: z.number().min(0).max(1),
    /** top3 掉档 query（rerank 候选；按输入序稳定）。 */
    droppedQueries: z.array(z.string()),
    /** top20 掉档 query（非触发判据；诊断用）。 */
    top20DroppedQueries: z.array(z.string()),
  })
  .strict()

export type RerankTriggerEvidence = z.infer<typeof RERANK_TRIGGER_EVIDENCE_SCHEMA>

/** 采集器错误（输入非法时 fail-loud）。 */
export class RerankTriggerEvidenceError extends Error {
  constructor(message: string) {
    super(`[rerank-trigger-evidence] ${message}`)
    this.name = "RerankTriggerEvidenceError"
  }
}

// ============================================================================
// 采集（纯函数）
// ============================================================================

/**
 * 采集 rerank 触发证据：top20 守住而 top3 掉档 → triggered（产出采纳证据）；
 * top20 未达 → armed（哨位状态，不产出候选）。
 * 输入非法 fail-loud（不静默降级）。
 */
export function collectRerankTriggerEvidence(input: RerankTriggerInput): RerankTriggerEvidence {
  const parsed = RERANK_TRIGGER_INPUT_SCHEMA.safeParse(input)
  if (!parsed.success) {
    throw new RerankTriggerEvidenceError(`输入 schema 校验失败：${parsed.error.message}`)
  }
  const { ranks, baseline } = parsed.data
  const n = ranks.length
  const top3Hits = ranks.filter((r) => r.top3).length
  const top20Hits = ranks.filter((r) => r.top20).length
  const top3Rate = top3Hits / n
  const top20Rate = top20Hits / n
  const status: RerankTriggerStatus =
    top20Rate >= baseline.minTop20Rate && top3Rate < baseline.minTop3Rate ? "triggered" : "armed"

  return RERANK_TRIGGER_EVIDENCE_SCHEMA.parse({
    status,
    rule: RERANK_TRIGGER_RULE,
    n,
    top3Hits,
    top20Hits,
    top3Rate,
    top20Rate,
    minTop3Rate: baseline.minTop3Rate,
    minTop20Rate: baseline.minTop20Rate,
    droppedQueries: ranks.filter((r) => !r.top3).map((r) => r.query),
    top20DroppedQueries: ranks.filter((r) => !r.top20).map((r) => r.query),
  })
}

// ============================================================================
// trace 面（retrieval-trace 消费；时间戳由调用方注入）
// ============================================================================

/**
 * 构造 rerank-trigger 通道的留痕条目（观测层，不改检索行为）。
 * top3 掉档 query 以 slotManifest 的 `rerank-candidate` 槽承载（候选≠采用）；
 * hits 留空（本哨不产出文档级命中）。
 */
export function buildRerankTriggerTraceEntry(
  evidence: RerankTriggerEvidence,
  traceId: string,
  recordedAt: string,
): RetrievalTraceEntry {
  if (evidence.status === "triggered" && evidence.droppedQueries.length === 0) {
    throw new RerankTriggerEvidenceError("triggered 状态下候选集不得为空（判据不一致）")
  }
  return {
    traceId,
    chapter: 0,
    query: `golden-${evidence.n} rerank-trigger sentinel`,
    channel: RERANK_TRIGGER_CHANNEL,
    hits: [],
    latencyMs: 0,
    recordedAt,
    slotManifest: evidence.droppedQueries.map((query, index) => ({
      slot: "rerank-candidate",
      sourceId: `query:${query}`,
      score: index,
    })),
  }
}
