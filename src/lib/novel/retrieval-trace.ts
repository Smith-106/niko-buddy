/**
 * R-allrepo-4 (29 全仓吸收落地): RetrievalTrace — 检索追踪审计.
 *
 * 吸收来源：累积残余 roadmap（29 号三模型 3/3 residual value 6；对应
 * ANWA rag tracer 与 inkos 检索投影审计的交叉）。
 *
 * 定位：检索调用的确定性审计层——query → 命中 → 实际采用 全链留痕，
 * 供「为什么这段上下文被选中」的事后审计。不改变检索行为（只观测）。
 *
 * 波1 检索可解释包（共识计划模块 12，GLM/DeepSeek/Qwen 三路共识，additive 扩展）：
 *   - slot-manifest：上下文装配槽位 → 采用条目显式契约（「这段上下文从哪来」）；
 *   - rejections：落选原因结构化（dedup/authoritative_filter/low_rank/budget/slot_full）；
 *   - corpusFilter + modelId：语料域过滤与路由证据（EB-1 证据链字段）；
 *   - counterfactualReplay：反事实重放（剔除条目 → P0 verdict 是否翻转）——
 *     B（ANWA LangGraph+Qdrant）无此能力；纯函数聚合层，重放执行由调用方驱动
 *     （LLM 部分留外部，ADR-19 机械层零模型调用）。
 *   全部新字段 additive-optional，旧 trace 消费方不受影响。
 */

export interface RetrievalHit {
  sourceId: string
  sourceType: "memory" | "material" | "world" | "chapter" | "external"
  score: number
  /** 命中是否被下游实际采用（装配进上下文）。 */
  used: boolean
  /** 波1 additive：落选原因（未采用且有因可查时填）。 */
  rejection?: RetrievalRejection
}

/** 落选原因（结构化；确定性可测）。 */
export type RetrievalRejectionReason = "dedup" | "authoritative_filter" | "low_rank" | "budget" | "slot_full"

export interface RetrievalRejection {
  readonly reason: RetrievalRejectionReason
  readonly detail?: string
}

export interface RetrievalTraceEntry {
  traceId: string
  chapter: number
  query: string
  /** 检索通道（如 bm25/vector/hybrid 五路之一）。 */
  channel: string
  hits: RetrievalHit[]
  latencyMs: number
  recordedAt: string
  /** 波1 additive：确定性 query 哈希（重放对照键）。 */
  queryHash?: string
  /** 波1 additive：检索时模型 id（路由证据）。 */
  modelId?: string
  /** 波1 additive：语料域过滤（authoritativeOnly / 域清单）。 */
  corpusFilter?: RetrievalCorpusFilter
  /** 波1 additive：槽位清单（slot-manifest，上下文装配显式契约）。 */
  slotManifest?: readonly RetrievalSlotManifestEntry[]
  /** 波1 additive：去重守恒统计（raw→deduped 计数）。 */
  dedupStats?: { readonly raw: number; readonly deduped: number; readonly removed: number }
}

/** 语料域过滤（检索输入的显式契约）。 */
export interface RetrievalCorpusFilter {
  readonly authoritativeOnly?: boolean
  readonly includeSources?: readonly string[]
}

/** 槽位清单条目（slot → 采用的来源条目）。 */
export interface RetrievalSlotManifestEntry {
  readonly slot: string
  readonly sourceId: string
  readonly score: number
  readonly charBudget?: number
}

export function createRetrievalTrace(input: {
  traceId: string
  chapter: number
  query: string
  channel: string
  hits: Array<{ sourceId: string; sourceType: RetrievalHit["sourceType"]; score: number }>
  latencyMs: number
  /** 波1 additive：确定性 query 哈希（computeQueryHash）。 */
  queryHash?: string
  /** 波1 additive：检索时模型 id。 */
  modelId?: string
  /** 波1 additive：语料域过滤。 */
  corpusFilter?: RetrievalCorpusFilter
}): RetrievalTraceEntry {
  return {
    traceId: input.traceId,
    chapter: input.chapter,
    query: input.query,
    channel: input.channel,
    hits: input.hits.map((h) => ({ ...h, used: false })),
    latencyMs: input.latencyMs,
    recordedAt: new Date().toISOString(),
    queryHash: input.queryHash,
    modelId: input.modelId,
    corpusFilter: input.corpusFilter,
  }
}

/**
 * 确定性 query 哈希（FNV-1a 32-bit + 长度后缀，与 prompt-artifacts 同法；
 * 仅作重放对照键，不承担抗碰撞性主张）。
 */
export function computeQueryHash(query: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < query.length; i += 1) {
    hash ^= query.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `qfnv1a-${hash.toString(16).padStart(8, "0")}-len${query.length}`
}

/**
 * 构建槽位清单（slot-manifest）：按装配槽位映射采用的条目（确定性，按槽位+sourceId
 * 字典序规范化；同一 sourceId 多槽各自成条）。
 */
export function buildSlotManifest(
  slots: readonly { readonly slot: string; readonly sourceIds: readonly string[] }[],
  hits: readonly Pick<RetrievalHit, "sourceId" | "score">[],
  charBudgets?: Readonly<Record<string, number | undefined>>,
): RetrievalSlotManifestEntry[] {
  const scoreBySource = new Map(hits.map((h) => [h.sourceId, h.score]))
  const entries: RetrievalSlotManifestEntry[] = []
  for (const { slot, sourceIds } of slots) {
    for (const sourceId of sourceIds) {
      entries.push({
        slot,
        sourceId,
        score: scoreBySource.get(sourceId) ?? 0,
        charBudget: charBudgets?.[slot],
      })
    }
  }
  return entries.sort((a, b) =>
    a.slot === b.slot ? (a.sourceId < b.sourceId ? -1 : 1) : a.slot < b.slot ? -1 : 1,
  )
}

/** 落选标记（纯函数；未采用的命中补 rejection 原因——「为什么没入选」结构化）。 */
export function markHitRejection(
  traces: RetrievalTraceEntry[],
  traceId: string,
  sourceId: string,
  rejection: RetrievalRejection,
): RetrievalTraceEntry[] {
  return traces.map((t) =>
    t.traceId === traceId
      ? {
          ...t,
          hits: t.hits.map((h) =>
            h.sourceId === sourceId && !h.used ? { ...h, rejection } : h,
          ),
        }
      : t,
  )
}

// ── 反事实重放（波1 超越点：剔除条目 → P0 verdict 是否翻转） ─────────────────

/** 单条反事实重放候选（调用方剔除 sourceId 后重跑门控并回报 verdict）。 */
export interface CounterfactualReplayCandidate {
  readonly removedSourceId: string
  /** 剔除该条目后重放得到的 P0 verdict。 */
  readonly p0VerdictAfterRemoval: "pass" | "fail"
}

/** 反事实重放输入：基线 verdict（全语料在场）+ 逐条剔除重放候选。 */
export interface CounterfactualReplayInput {
  readonly baselineP0Verdict: "pass" | "fail"
  readonly candidates: readonly CounterfactualReplayCandidate[]
}

/** 反事实重放结果（决定性证据 = 剔除即翻转 verdict 的条目）。 */
export interface CounterfactualReplayResult {
  /** 剔除后 P0 verdict 翻转的 sourceId（决定性证据清单）。 */
  readonly decisiveSourceIds: readonly string[]
  /** 剔除后 verdict 不变的 sourceId（非决定性）。 */
  readonly nonDecisiveSourceIds: readonly string[]
}

/**
 * 反事实重放聚合（纯函数）：verdict 与基线不同的候选 → 决定性。
 * 「这条证据对门裁定是否有因果贡献」的可测回答——B 的 Qdrant 检索无此能力。
 */
export function counterfactualReplay(input: CounterfactualReplayInput): CounterfactualReplayResult {
  const decisive: string[] = []
  const nonDecisive: string[] = []
  for (const candidate of input.candidates) {
    if (candidate.p0VerdictAfterRemoval !== input.baselineP0Verdict) {
      decisive.push(candidate.removedSourceId)
    } else {
      nonDecisive.push(candidate.removedSourceId)
    }
  }
  return { decisiveSourceIds: decisive, nonDecisiveSourceIds: nonDecisive }
}

/** 标记命中被采用（纯函数；traceId+sourceId 定位）。 */
export function markHitUsed(
  traces: RetrievalTraceEntry[],
  traceId: string,
  sourceId: string,
): RetrievalTraceEntry[] {
  return traces.map((t) =>
    t.traceId === traceId
      ? { ...t, hits: t.hits.map((h) => (h.sourceId === sourceId ? { ...h, used: true } : h)) }
      : t,
  )
}

export interface RetrievalAudit {
  totalTraces: number
  totalHits: number
  usedHits: number
  /** 采用率（usedHits/totalHits；0 命中时为 0）。 */
  hitUtilization: number
  /** 被采用但排名靠后（score 低于全体中位）的命中数——检索质量信号。 */
  lowScoreUsed: number
}

/** 审计汇总：采用率与低分采用信号（确定性）。 */
export function auditRetrievalTraces(traces: RetrievalTraceEntry[]): RetrievalAudit {
  const allHits = traces.flatMap((t) => t.hits)
  const usedHits = allHits.filter((h) => h.used)
  const usedScores = usedHits.map((h) => h.score).sort((a, b) => a - b)
  const allScores = allHits.map((h) => h.score).sort((a, b) => a - b)
  const median = allScores.length === 0 ? 0 : allScores[Math.floor((allScores.length - 1) / 2)]
  const lowScoreUsed = usedScores.filter((s) => s < median).length
  return {
    totalTraces: traces.length,
    totalHits: allHits.length,
    usedHits: usedHits.length,
    hitUtilization: allHits.length === 0 ? 0 : usedHits.length / allHits.length,
    lowScoreUsed,
  }
}
