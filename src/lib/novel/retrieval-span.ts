/**
 * retrieval-span.ts — R0-c 运行时 span 面（全链观测，零语义改动）。
 *
 * 共识来源：批准计划 r2 §R0-c（planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113 §R0-c）；
 * A5 教训：无调用集成不验收 —— 本面必须由真实链路（search-adapter.novelMixedSearch）
 * 注入，而非仅测试内自造。
 *
 * 链序（单一真源，缺环即 fail-loud）：
 *   分词 tokenize → 五源 sources → RRF rrf → 分档 tiering
 *   → rerank 触发-or-跳过 rerank_trigger → 封顶降级 cap_degrade
 *
 * 机械层（ADR-19）：本模块纯函数 + zod，零 IO / 零时钟（时间戳由构造方注入的
 * `now()` 提供）；观测层不得改变检索语义与排序结果 —— 注入点全部为可选参数，
 * 不传即零行为差异。消费端 = 既有 retrieval-trace（traceChannel 语义）。
 *
 * @license MIT © Niko Buddy
 */

import { z } from "zod"

/** span 通道名（retrieval-trace 消费语义）。 */
export const RETRIEVAL_SPAN_CHANNEL = "retrieval-span" as const

/** 链序 stage 枚举（顺序即契约；缺环/乱序/重复一律 fail-loud）。 */
export const RETRIEVAL_SPAN_STAGE_SCHEMA = z.enum([
  "tokenize",
  "sources",
  "rrf",
  "tiering",
  "rerank_trigger",
  "cap_degrade",
])

export type RetrievalSpanStage = z.infer<typeof RETRIEVAL_SPAN_STAGE_SCHEMA>

/** 链序常量（数组序 = 契约序）。 */
export const RETRIEVAL_SPAN_STAGES: readonly RetrievalSpanStage[] =
  RETRIEVAL_SPAN_STAGE_SCHEMA.options

/** span 明细值（有界标量；不承载语料正文）。 */
export const RETRIEVAL_SPAN_DETAIL_VALUE_SCHEMA = z.union([z.string().max(256), z.number(), z.boolean()])

export type RetrievalSpanDetail = Readonly<Record<string, z.infer<typeof RETRIEVAL_SPAN_DETAIL_VALUE_SCHEMA>>>

/** 单条 span 事件（strict；seq 由收集器分配，ts 由注入时钟提供）。 */
export const RETRIEVAL_SPAN_SCHEMA = z
  .object({
    stage: RETRIEVAL_SPAN_STAGE_SCHEMA,
    seq: z.number().int().nonnegative(),
    ts: z.string().min(1).max(64),
    channel: z.literal(RETRIEVAL_SPAN_CHANNEL),
    detail: z.record(z.string(), RETRIEVAL_SPAN_DETAIL_VALUE_SCHEMA).optional(),
  })
  .strict()

export type RetrievalSpan = z.infer<typeof RETRIEVAL_SPAN_SCHEMA>

/** span 面错误（缺环 / 乱序 / 重复 / 非法输入，一律 fail-loud）。 */
export class RetrievalSpanError extends Error {
  constructor(message: string) {
    super(`[retrieval-span] ${message}`)
    this.name = "RetrievalSpanError"
  }
}

// ============================================================================
// 事件构造（纯函数，零时钟）
// ============================================================================

/** 构造单条 span（ts/seq 由调用方注入；非法输入 fail-loud）。 */
export function makeRetrievalSpan(
  stage: RetrievalSpanStage,
  seq: number,
  ts: string,
  detail?: RetrievalSpanDetail,
): RetrievalSpan {
  const parsed = RETRIEVAL_SPAN_SCHEMA.safeParse({
    stage,
    seq,
    ts,
    channel: RETRIEVAL_SPAN_CHANNEL,
    detail,
  })
  if (!parsed.success) {
    throw new RetrievalSpanError(`span 非法：${parsed.error.message}`)
  }
  return parsed.data
}

// ============================================================================
// 链序断言（纯函数）
// ============================================================================

/**
 * 链序完整性断言：六个 stage 各恰好出现一次，且严格按契约序递增。
 * 缺环 / 乱序 / 重复一律抛错（A5：链路缺口不得静默）。
 */
export function assertRetrievalSpanSequence(spans: readonly RetrievalSpan[]): void {
  const seen = new Set<RetrievalSpanStage>()
  let lastIndex = -1
  for (const span of spans) {
    const index = RETRIEVAL_SPAN_STAGES.indexOf(span.stage)
    if (index === -1) {
      throw new RetrievalSpanError(`未知 stage：${String(span.stage)}`)
    }
    if (seen.has(span.stage)) {
      throw new RetrievalSpanError(`stage 重复：${span.stage}`)
    }
    if (index <= lastIndex) {
      throw new RetrievalSpanError(
        `stage 乱序：${span.stage}（契约序 ${RETRIEVAL_SPAN_STAGES.join(" → ")}）`,
      )
    }
    seen.add(span.stage)
    lastIndex = index
  }
  const missing = RETRIEVAL_SPAN_STAGES.filter((stage) => !seen.has(stage))
  if (missing.length > 0) {
    throw new RetrievalSpanError(`链序缺环：${missing.join(" / ")}`)
  }
}

// ============================================================================
// 收集器（时钟注入；观测层 sink 契约）
// ============================================================================

/** 注入点接受的 sink 契约（不传即完全不产生 span，零行为差异）。 */
export interface RetrievalSpanSink {
  span(stage: RetrievalSpanStage, detail?: RetrievalSpanDetail): void
}

/** 收集器（seq 自增；ts 取自注入时钟，本模块零时钟调用）。 */
export interface RetrievalSpanCollector extends RetrievalSpanSink {
  readonly spans: readonly RetrievalSpan[]
  /** 全链完整性断言（缺环/乱序/重复抛错）。 */
  assertComplete(): void
}

/** 创建收集器：`now` 由调用方注入（如 `() => new Date().toISOString()`）。 */
export function createRetrievalSpanCollector(now: () => string): RetrievalSpanCollector {
  const spans: RetrievalSpan[] = []
  return {
    get spans() {
      return spans
    },
    span(stage, detail) {
      spans.push(makeRetrievalSpan(stage, spans.length, now(), detail))
    },
    assertComplete() {
      assertRetrievalSpanSequence(spans)
    },
  }
}

// ============================================================================
// 链序 → retrieval-trace 留痕（消费端桥；时间戳由调用方注入）
// ============================================================================

/** 把一次全链 span 序列汇总为一条 trace 留痕（observation-only）。 */
export function buildRetrievalSpanTraceEntry(input: {
  spans: readonly RetrievalSpan[]
  traceId: string
  recordedAt: string
  query: string
}): {
  traceId: string
  chapter: number
  query: string
  channel: string
  hits: []
  latencyMs: number
  recordedAt: string
  slotManifest: Array<{ slot: string; sourceId: string; score: number }>
} {
  for (const span of input.spans) {
    if (span.channel !== RETRIEVAL_SPAN_CHANNEL) {
      throw new RetrievalSpanError(`trace 汇总收到非本通道 span：${span.channel}`)
    }
  }
  assertRetrievalSpanSequence(input.spans)
  return {
    traceId: input.traceId,
    chapter: 0,
    query: input.query,
    channel: RETRIEVAL_SPAN_CHANNEL,
    hits: [],
    latencyMs: 0,
    recordedAt: input.recordedAt,
    slotManifest: input.spans.map((span) => ({
      slot: span.stage,
      sourceId: `${span.stage}:${span.seq}`,
      score: span.seq,
    })),
  }
}
