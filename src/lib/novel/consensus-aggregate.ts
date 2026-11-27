import type { DimensionReviewResult } from "./dimension-review-adapter"

/**
 * 多模型共识聚合器（纯函数，零 LLM、确定性）。
 *
 * 审查共识：N 模型各维终轮投票 → 每维取分数中位数，summary/issues 取最接近
 * 中位数的匿名票（不膨胀问题列表），max-min 超阈值标 disputed。
 * 写作共识：互评矩阵（排除自评）平均分最高的稿胜出（保作者声音一致性，
 * 不做段落合成）；平票取数组序首个（确定性）。
 */

/** 共识阈值：终轮分数极差超过该值视为存在实质分歧。 */
export const CONSENSUS_DISPUTE_THRESHOLD = 2.0

/** 共识互评/辩论正典约束摘要的硬上限（字符数）。 */
export const CONSENSUS_CANON_DIGEST_MAX_CHARS = 1400

export interface ConsensusCanonDigestInput {
  canonRulesBase?: string
  canonRules?: string
  worldBlueprint?: string
  mustAvoid?: string
  planBlueprint?: string
  outline?: string
  taskBrief?: string
}

const TASK_BRIEF_CONSTRAINT_HINT_RE = /(?:约束|禁止|不得|必须|红线|契约|设定|规则|正典|避免|目标|伏笔|连续性)/

function extractTaskBriefConstraintLines(taskBrief: string): string {
  const trimmed = taskBrief.trim()
  // 忽略极短占位串（如测试夹具中的 "tb"），避免污染互评提示词。
  if (trimmed.length < 8) return ""
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
  if (lines.length === 0) return ""
  const prioritized = lines.filter((line) => TASK_BRIEF_CONSTRAINT_HINT_RE.test(line))
  const chosen = prioritized.length > 0 ? prioritized : lines
  return chosen.slice(0, 6).join("\n")
}

function truncateToMaxChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  if (maxChars === 1) return "…"
  return `${text.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * 构建有界共识正典摘要（纯函数、零 LLM、确定性），用于共识评审辩论轮与写作互评对齐正典基线。
 * 按优先级拼装：正典规则(canonRulesBase || canonRules) → 世界蓝图(worldBlueprint) →
 * 禁止项(mustAvoid) → 计划/大纲(planBlueprint || outline) → 任务书关键约束行(taskBrief, 忽略 <8 字占位)。
 * 全部为空时返回 ""；输出严格 <= maxChars。
 */
export function buildConsensusCanonDigest(
  input: ConsensusCanonDigestInput | null | undefined,
  maxChars: number = CONSENSUS_CANON_DIGEST_MAX_CHARS,
): string {
  if (!input || !Number.isFinite(maxChars) || maxChars <= 0) return ""
  const limit = Math.floor(maxChars)
  const sections: Array<{ label: string; content: string }> = []

  const canonText = input.canonRulesBase?.trim() || input.canonRules?.trim() || ""
  if (canonText) sections.push({ label: "正典规则", content: canonText })

  const worldText = input.worldBlueprint?.trim() || ""
  if (worldText) sections.push({ label: "世界蓝图", content: worldText })

  const mustAvoidText = input.mustAvoid?.trim() || ""
  if (mustAvoidText) sections.push({ label: "禁止项", content: mustAvoidText })

  const planOrOutline = input.planBlueprint?.trim() || input.outline?.trim() || ""
  if (planOrOutline) sections.push({ label: "计划/大纲", content: planOrOutline })

  const briefConstraints = input.taskBrief ? extractTaskBriefConstraintLines(input.taskBrief) : ""
  if (briefConstraints) sections.push({ label: "任务书约束", content: briefConstraints })

  if (sections.length === 0) return ""

  const blocks: string[] = []
  let usedChars = 0
  for (const section of sections) {
    const separator = blocks.length > 0 ? "\n" : ""
    const prefix = `${separator}[${section.label}] `
    const remaining = limit - usedChars
    if (remaining <= prefix.length + 1) break
    const bodyBudget = remaining - prefix.length
    const normalizedBody = section.content.replace(/\s+/g, " ").trim()
    const body = truncateToMaxChars(normalizedBody, bodyBudget)
    if (!body) continue
    blocks.push(`${prefix}${body}`)
    usedChars += prefix.length + body.length
    if (usedChars >= limit) break
  }

  return truncateToMaxChars(blocks.join(""), limit)
}

/** 辩论轮匿名代号（A/B/C...，防模型身份偏见）。 */
export function anonymousId(index: number): string {
  return String.fromCharCode(65 + (index % 26))
}

export interface DebateBallot {
  anonymousId: string
  score: number
  status: string
  summary: string
  issues: DimensionReviewResult["issues"]
}

export interface ReviewConsensusOutcome {
  result: DimensionReviewResult
  ballots: DebateBallot[]
  disputed: boolean
  spread: number
}

function median(scores: number[]): number {
  const sorted = [...scores].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  // 偶数取中间两数平均，保留一位小数（与审查量程一致）
  return Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10
}

/** 审查共识聚合：单模型输入（长度 1）直通等价。 */
export function aggregateReviewDimension(
  dimensionKey: DimensionReviewResult["dimensionKey"],
  ballots: DebateBallot[],
): ReviewConsensusOutcome {
  if (ballots.length === 0) throw new Error("consensus aggregate: no ballots")
  const scores = ballots.map((b) => b.score)
  const med = median(scores)
  const spread = Math.round((Math.max(...scores) - Math.min(...scores)) * 10) / 10
  const disputed = spread > CONSENSUS_DISPUTE_THRESHOLD
  // 最接近中位数的票作为代表（确定性：平距取先出现者）
  let representative = ballots[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const b of ballots) {
    const d = Math.abs(b.score - med)
    if (d < bestDistance) {
      bestDistance = d
      representative = b
    }
  }
  const disagreementNote = disputed
    ? `（共识分歧：${ballots.length} 模型极差 ${spread}，取中位数 ${med}）`
    : ""
  const result: DimensionReviewResult = {
    dimensionKey,
    score: med,
    status: representative.status as DimensionReviewResult["status"],
    summary: `${representative.summary}${disagreementNote}`,
    thinking: representative.summary,
    issues: representative.issues,
  }
  return { result, ballots, disputed, spread }
}

export interface DraftCandidate {
  anonymousId: string
  content: string
}

export interface PeerEvaluation {
  /** 评分者代号 */
  voter: string
  /** 被评稿代号 */
  candidate: string
  score: number
  rationale: string
}

export interface WritingConsensusOutcome {
  winner: DraftCandidate
  averageScores: { candidate: string; average: number }[]
  rationaleDigest: string
}

/** 写作共识：互评平均分（排除自评）最高者胜；平票取候选序首个。 */
export function pickBestDraft(
  candidates: DraftCandidate[],
  evaluations: PeerEvaluation[],
): WritingConsensusOutcome {
  if (candidates.length === 0) throw new Error("consensus aggregate: no candidates")
  const averages = candidates.map((c) => {
    const received = evaluations.filter((e) => e.candidate === c.anonymousId && e.voter !== c.anonymousId)
    const average =
      received.length === 0
        ? 0
        : Math.round((received.reduce((sum, e) => sum + e.score, 0) / received.length) * 10) / 10
    return { candidate: c.anonymousId, average }
  })
  let winner = candidates[0]!
  let bestAverage = -1
  for (const avg of averages) {
    if (avg.average > bestAverage) {
      bestAverage = avg.average
      winner = candidates.find((c) => c.anonymousId === avg.candidate) ?? candidates[0]!
    }
  }
  const winnerReviews = evaluations
    .filter((e) => e.candidate === winner.anonymousId && e.voter !== winner.anonymousId)
    .sort((a, b) => b.score - a.score)
  const rationaleDigest = winnerReviews
    .slice(0, 3)
    .map((e) => `${e.voter}(${e.score}): ${e.rationale}`)
    .join("；")
  return { winner, averageScores: averages, rationaleDigest }
}
