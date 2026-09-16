/**
 * title-forge.ts — 波2-B 模块 11：标题工坊可证筛选（标题种子 constraints 逐条对账）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 11）：
 *   - GLM P1 缺口「title-workshop」：标题候选未按标题种子 constraints 做可证
 *     筛选——本模块把每条候选 × 每个标题种子的命中/落选做成**逐条对账证据表**；
 *   - GLM 验收：每条候选标题的采纳/淘汰原因落事件且可按 constraints 逐条对账；
 *     DS 验收：每个入选/落选标题携带 constraints 命中与分数证据并可点开回溯
 *     到种子（evidenceRefs = 种子 entryId + 约束锚）；
 *   - 机械对账（ADR-19 零模型调用）：pattern/constraint 均按「候选标题须含
 *     锚点子串」机械判据（与 world-constraint-gate 同法近似，LLM 语义评分
 *     out-of-scope；candidates 可先经 LLM 生成，本模块只做机械证据面）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用；事件对象只产出输入
 * 形态（RunEventAppendInput，seq/eventId 由 run-event-ledger-store 派生落账）。
 *
 * @license MIT © QMAI
 */

import type { TitleSeedEntry } from "./asset-library"
import type { RunEventAppendInput } from "./run-event-ledger-store"

// ============================================================================
// 契约
// ============================================================================

/** 标题候选输入。 */
export interface TitleForgeCandidate {
  /** 全报告唯一候选 id（重复 id 拒绝）。 */
  readonly candidateId: string
  /** 候选标题文本。 */
  readonly title: string
}

/** 单条约束的对账结果（逐条证据行）。 */
export interface TitleConstraintCheck {
  /** 种子条目 id（回溯锚）。 */
  readonly seedEntryId: string
  /** 约束原文。 */
  readonly constraint: string
  /** 机械判据：候选标题是否含约束锚点子串。 */
  readonly hit: boolean
}

/** 单候选 × 单种子的对账行。 */
export interface TitleSeedMatchRow {
  readonly seedEntryId: string
  /** 候选标题是否含种子 pattern 锚点（种子命中判据）。 */
  readonly patternMatched: boolean
  /** 该种子 constraints 逐条对账。 */
  readonly constraintChecks: readonly TitleConstraintCheck[]
  /** 本种子命中约束数。 */
  readonly matchedCount: number
  /** 本种子约束总数。 */
  readonly totalCount: number
}

/** 单候选对账证据表（采纳/淘汰原因可点开）。 */
export interface TitleForgeRow {
  readonly candidateId: string
  readonly title: string
  /** 候选 × 种子逐条对账（种子输入序稳定）。 */
  readonly seedRows: readonly TitleSeedMatchRow[]
  /** 跨种子约束命中总数（分数证据）。 */
  readonly totalConstraintHits: number
  /** 命中种子的 pattern 数。 */
  readonly seedMatchCount: number
  /** 确定性裁定（reason 机器可读）。 */
  readonly admitted: boolean
  /** 采纳/淘汰原因（machine-readable：no_seed_pattern_match / below_min_constraint_hits / admitted）。 */
  readonly reason: string
}

/** 标题工坊筛选报告（对账证据表 + 事件输入）。 */
export interface TitleForgeReport {
  /** 候选对账行（输入序稳定，逐条含证据）。 */
  readonly rows: readonly TitleForgeRow[]
  readonly admitted: readonly string[]
  readonly rejected: readonly string[]
  /** 采纳/淘汰事件输入（kind=stage；appendRunEventsToStore 落账）。 */
  readonly events: readonly RunEventAppendInput[]
}

/** 标题工坊错误（重复候选 id）。 */
export class TitleForgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TitleForgeError"
  }
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 标题工坊机械筛选（对账语义）：
 *   1. 候选 × 种子逐条对账：pattern 命中 = 标题含种子 pattern 子串；
 *      constraints 逐条 hit = 标题含约束子串（逐条留 hit/miss 证据）；
 *   2. 采纳判据（确定性）：≥1 种子 pattern 命中 且 跨种子约束命中数 ≥
 *      minConstraintHits（缺省 1）；淘汰原因 machine-readable；
 *   3. 空种子/空候选 → 空报告；重复候选 id 拒绝（对账表不可二义）；
 *   4. ts 由调用方注入（零时钟；事件落账前不可为空）。
 */
export function forgeTitles(input: {
  readonly candidates: readonly TitleForgeCandidate[]
  readonly seeds: readonly TitleSeedEntry[]
  readonly minConstraintHits?: number
  /** 事件时间戳（ISO-8601，调用方注入；空串/缺省拒绝）。 */
  readonly ts: string
}): TitleForgeReport {
  if (input.ts.length === 0) {
    throw new TitleForgeError("ts 为空：事件落账前必须由调用方注入时间戳（零时钟纪律）")
  }
  const seen = new Set<string>()
  for (const candidate of input.candidates) {
    if (seen.has(candidate.candidateId)) {
      throw new TitleForgeError(`重复的候选 id: "${candidate.candidateId}"`)
    }
    seen.add(candidate.candidateId)
  }
  const minHits = input.minConstraintHits ?? 1
  const rows: TitleForgeRow[] = []
  const admitted: string[] = []
  const rejected: string[] = []
  for (const candidate of input.candidates) {
    const seedRows: TitleSeedMatchRow[] = []
    let totalHits = 0
    let seedMatchCount = 0
    for (const seed of input.seeds) {
      const patternMatched =
        seed.pattern.length > 0 && candidate.title.includes(seed.pattern)
      if (patternMatched) seedMatchCount += 1
      const constraintChecks = seed.constraints.map((constraint) => {
        const hit = constraint.length > 0 && candidate.title.includes(constraint)
        if (hit) totalHits += 1
        return {
          seedEntryId: seed.entryId,
          constraint,
          hit,
          reason: hit ? `命中约束锚「${constraint}」` : `缺失约束锚「${constraint}」`,
        }
      })
      seedRows.push({
        seedEntryId: seed.entryId,
        patternMatched,
        constraintChecks,
        matchedCount: constraintChecks.filter((c) => c.hit).length,
        totalCount: constraintChecks.length,
      })
    }
    const noSeed = seedMatchCount === 0
    const belowMin = !noSeed && totalHits < minHits
    const admittedRow = !noSeed && !belowMin
    rows.push({
      candidateId: candidate.candidateId,
      title: candidate.title,
      seedRows,
      totalConstraintHits: totalHits,
      seedMatchCount,
      admitted: admittedRow,
      reason: noSeed ? "no_seed_pattern_match" : belowMin ? "below_min_constraint_hits" : "admitted",
    })
    if (admittedRow) {
      admitted.push(candidate.candidateId)
    } else {
      rejected.push(candidate.candidateId)
    }
  }
  const events: RunEventAppendInput[] = rows.map((row) => ({
    ts: input.ts,
    kind: "stage" as const,
    actor: "writer" as const,
    evidenceRefs: [
      ...row.seedRows.filter((r) => r.patternMatched).map((r) => `title-seed:${r.seedEntryId}`),
      ...row.seedRows.flatMap((r) =>
        r.constraintChecks.filter((c) => c.hit).map((c) => `title-seed:${r.seedEntryId}:hit:${c.constraint}`),
      ),
    ],
    payload: {
      candidateId: row.candidateId,
      title: row.title,
      admitted: row.admitted,
      reason: row.reason,
      seedMatchCount: row.seedMatchCount,
      totalConstraintHits: row.totalConstraintHits,
      seedRows: row.seedRows.map((r) => ({
        seedEntryId: r.seedEntryId,
        patternMatched: r.patternMatched,
        matchedCount: r.matchedCount,
        totalCount: r.totalCount,
      })),
    },
  }))
  return { rows, admitted, rejected, events }
}