/**
 * 质量自主迭代闭环（阶段 2）：起草 → 六维评分 → 定向重写 → 再评分。
 *
 * 终止条件：六维中位 ≥ 目标（默认 9.0，与 L9 书稿硬门一致）或轮次预算耗尽；
 * 重写只要没有实质提升就立即停止并保留历史最佳稿，避免越改越差。
 *
 * 纪律：
 * - 纯编排，零 IO、零时钟读取（score/revise 与 now 全部注入），不 import 任何 store。
 * - 不覆盖 Consistency(P0) 判定：门控结论由 `pass` 之外的门禁负责，这里只做文学维度推进。
 * - 评分维度复用 review-center 六维 key（thrill/consistency/pacing/character/continuity/pull）。
 */
import type { RunEventInput } from "./run-event-ledger"

/** review-center 六维 key（与 SixReviewDimensionKey 同源，此处只取本闭环使用的子集语义）。 */
export const QUALITY_DIMS = [
  "thrill",
  "consistency",
  "pacing",
  "character",
  "continuity",
  "pull",
] as const

export type QualityDimKey = (typeof QUALITY_DIMS)[number]

export interface QualityBudget {
  /** 最多重写轮次。 */
  maxRounds: number
  /** 目标中位分（含）。 */
  minMedian: number
  /** 认定为「实质提升」的最小中位分增益。 */
  minGain: number
}

export const DEFAULT_QUALITY_BUDGET: QualityBudget = {
  maxRounds: 3,
  minMedian: 9.0,
  minGain: 0.1,
}

export type DimensionScores = Partial<Record<QualityDimKey, number>>

export interface WeakDimension {
  key: QualityDimKey
  score: number
  gap: number
}

export interface QualityScore {
  dims: DimensionScores
  /** 已给维度分数的中位分；无有效维度时为 0。 */
  median: number
  /** 没有给出分数的维度（不计入中位）。 */
  missing: QualityDimKey[]
  /** 低于目标分的维度，按缺口降序。 */
  weak: WeakDimension[]
  pass: boolean
}

export interface QualityRound {
  round: number
  median: number
  dims: DimensionScores
  /** 本轮最弱的 3 个维度 key。 */
  weakest: QualityDimKey[]
  /** 中位分较上一轮有实质提升。 */
  improved: boolean
  /** 重写稿字符数。 */
  revisedChars: number
}

export type QualityStopReason = "target" | "budget" | "no-improvement" | "score-error"

export interface QualityIterationResult {
  ok: boolean
  stopReason: QualityStopReason
  /** 历史最佳稿（不会被更差的重写稿覆盖）。 */
  content: string
  score: QualityScore
  rounds: QualityRound[]
  /** 每轮评分（含首轮）。 */
  history: QualityScore[]
  error?: string
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return Math.round(value * 100) / 100
}

export function scoreChapter(
  dims: DimensionScores,
  budget: QualityBudget = DEFAULT_QUALITY_BUDGET,
): QualityScore {
  const present = QUALITY_DIMS.filter(
    (key) => typeof dims[key] === "number" && Number.isFinite(dims[key]),
  )
  const values = present.map((key) => dims[key] as number)
  const med = median(values)
  const missing = QUALITY_DIMS.filter((key) => !present.includes(key))
  const weak = present
    .map((key) => {
      const score = dims[key] as number
      return { key, score, gap: Math.round((budget.minMedian - score) * 100) / 100 }
    })
    .filter((row) => row.gap > 0)
    .sort((a, b) => b.gap - a.gap || QUALITY_DIMS.indexOf(a.key) - QUALITY_DIMS.indexOf(b.key))
  return {
    dims,
    median: med,
    missing,
    weak,
    pass: present.length > 0 && missing.length === 0 && med >= budget.minMedian && weak.length === 0,
  }
}

/** 定向重写指令：只针对未达标维度，避免整章重写漂移。 */
export function buildRevisionBrief(
  score: QualityScore,
  budget: QualityBudget = DEFAULT_QUALITY_BUDGET,
): string {
  const lines: string[] = [
    `当前六维中位 ${score.median}，目标 ${budget.minMedian}。请只做定向重写，不要改动已达标维度的既有优点。`,
  ]
  if (score.weak.length > 0) {
    lines.push("未达标维度（按缺口排序）：")
    for (const row of score.weak.slice(0, 4)) {
      lines.push(`- ${row.key}: ${row.score}（差 ${row.gap}）`)
    }
  }
  if (score.missing.length > 0) {
    lines.push(`缺少评分的维度：${score.missing.join("、")}（请补齐这些维度的表现）`)
  }
  lines.push("要求：保留既有设定与人物关系（Consistency 不可牺牲），只提升上述维度的具体场景处理。")
  return lines.join("\n")
}

export interface QualityIterationOptions {
  content: string
  score: (content: string) => Promise<DimensionScores>
  revise: (content: string, brief: string, round: number) => Promise<string>
  budget?: Partial<QualityBudget>
  onRound?: (round: QualityRound) => void
}

export async function runQualityIteration(
  options: QualityIterationOptions,
): Promise<QualityIterationResult> {
  const budget: QualityBudget = { ...DEFAULT_QUALITY_BUDGET, ...options.budget }
  const rounds: QualityRound[] = []
  const history: QualityScore[] = []

  const safeScore = async (text: string): Promise<QualityScore | null> => {
    try {
      return scoreChapter(await options.score(text), budget)
    } catch {
      return null
    }
  }

  const first = await safeScore(options.content)
  if (!first) {
    return {
      ok: false,
      stopReason: "score-error",
      content: options.content,
      score: scoreChapter({}),
      rounds,
      history,
      error: "首轮评分失败",
    }
  }

  history.push(first)
  let current = first
  let best = { content: options.content, score: first }
  let content = options.content
  let stopReason: QualityStopReason | undefined = current.pass ? "target" : undefined

  while (!stopReason && rounds.length < budget.maxRounds) {
    const brief = buildRevisionBrief(current, budget)
    const revised = await options.revise(content, brief, rounds.length + 1)
    const scored = await safeScore(revised)
    if (!scored) {
      stopReason = "score-error"
      break
    }
    const improved = scored.median >= current.median + budget.minGain
    const round: QualityRound = {
      round: rounds.length + 1,
      median: scored.median,
      dims: scored.dims,
      weakest: scored.weak.slice(0, 3).map((row) => row.key),
      improved,
      revisedChars: revised.length,
    }
    rounds.push(round)
    history.push(scored)
    options.onRound?.(round)
    if (!improved) {
      stopReason = "no-improvement"
      break
    }
    content = revised
    current = scored
    best = { content: revised, score: scored }
    if (scored.pass) stopReason = "target"
  }

  return {
    ok: best.score.pass,
    stopReason: stopReason ?? "budget",
    content: best.content,
    score: best.score,
    rounds,
    history,
  }
}

export interface QualityRunEventOptions {
  runId: string
  chapterId?: number
  bookId?: string
  /** 事件 id 前缀（默认 `quality`）。 */
  idPrefix?: string
}

/**
 * 把闭环结果转成 run-event-ledger 事件（供热力图与证据面板回放）：
 * 每轮评分 gate-run + 每次重写 retry，收口 accept（达标）或 stage（未达标）。
 */
export function buildQualityRunEvents(
  result: QualityIterationResult,
  options: QualityRunEventOptions,
): RunEventInput[] {
  const prefix = options.idPrefix ?? "quality"
  const base = {
    bookId: options.bookId,
    chapterId: options.chapterId,
    sessionId: options.runId,
    replayId: options.runId,
  }
  const events: RunEventInput[] = []
  result.history.forEach((score, index) => {
    events.push({
      ...base,
      seq: events.length,
      eventId: `${prefix}:gate:${options.runId}:${index}`,
      ts: `round-${index}`,
      kind: "gate-run",
      actor: "critic",
      evidenceRefs: [],
      payload: {
        round: index,
        median: score.median,
        dims: score.dims,
        weak: score.weak.map((row) => row.key),
        missing: score.missing,
        pass: score.pass,
      },
    })
  })
  for (const round of result.rounds) {
    events.push({
      ...base,
      seq: events.length,
      eventId: `${prefix}:revise:${options.runId}:${round.round}`,
      ts: `round-${round.round}`,
      kind: "retry",
      actor: "reviser",
      evidenceRefs: [],
      payload: {
        round: round.round,
        median: round.median,
        weakest: round.weakest,
        improved: round.improved,
        revisedChars: round.revisedChars,
      },
    })
  }
  events.push({
    ...base,
    seq: events.length,
    eventId: `${prefix}:final:${options.runId}`,
    ts: `round-${result.history.length - 1}`,
    kind: result.ok ? "accept" : "stage",
    actor: "arbiter",
    evidenceRefs: [],
    payload: {
      stopReason: result.stopReason,
      median: result.score.median,
      rounds: result.rounds.length,
      ok: result.ok,
    },
  })
  return events
}
