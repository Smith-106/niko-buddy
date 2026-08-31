/**
 * R-allrepo-4 (29 全仓吸收落地): RetrievalTrace — 检索追踪审计.
 *
 * 吸收来源：累积残余 roadmap（29 号三模型 3/3 residual value 6；对应
 * ANWA rag tracer 与 inkos 检索投影审计的交叉）。
 *
 * 定位：检索调用的确定性审计层——query → 命中 → 实际采用 全链留痕，
 * 供「为什么这段上下文被选中」的事后审计。不改变检索行为（只观测）。
 */

export interface RetrievalHit {
  sourceId: string
  sourceType: "memory" | "material" | "world" | "chapter" | "external"
  score: number
  /** 命中是否被下游实际采用（装配进上下文）。 */
  used: boolean
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
}

export function createRetrievalTrace(input: {
  traceId: string
  chapter: number
  query: string
  channel: string
  hits: Array<{ sourceId: string; sourceType: RetrievalHit["sourceType"]; score: number }>
  latencyMs: number
}): RetrievalTraceEntry {
  return {
    traceId: input.traceId,
    chapter: input.chapter,
    query: input.query,
    channel: input.channel,
    hits: input.hits.map((h) => ({ ...h, used: false })),
    latencyMs: input.latencyMs,
    recordedAt: new Date().toISOString(),
  }
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
