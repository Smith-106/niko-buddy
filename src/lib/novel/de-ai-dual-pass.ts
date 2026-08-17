/**
 * Wave C — de-AI dual-pass soft orchestrator.
 *
 * Pass 1: score (mechanical slop + avoid-ai patterns).
 * Pass 2: soft remediation notes / prompt fragment only — does NOT rewrite manuscript.
 * productHardGate always false.
 */
import {
  analyzeAvoidAiPatterns,
  formatAvoidAiPatternsPromptFragment,
  type AvoidAiAnalyzeResult,
} from "./avoid-ai-patterns"
import {
  classifySlop,
  slopReportToText,
  slopScore,
  type SlopReport,
} from "./mechanical-slop-detector"
import { percentileRank, type CalibratedBands } from "./de-ai-percentile"

export const DE_AI_DUAL_PASS_SCHEMA = "de-ai-dual-pass/1.0" as const

export interface DualPassReport {
  schemaVersion: typeof DE_AI_DUAL_PASS_SCHEMA
  pass1: {
    slop: SlopReport
    slopClass: "block" | "warn" | "clean"
    avoidAi: AvoidAiAnalyzeResult
    combinedScore: number
    percentileInBaseline?: number
  }
  pass2: {
    remediationNotes: string[]
    promptFragment: string
  }
  productHardGate: false
  track: "B"
}

export interface DualPassOptions {
  /** Optional baseline scores for soft percentile rank (not a gate). */
  baselineScores?: readonly number[]
  /** Optional precomputed bands (unused for gating). */
  bands?: CalibratedBands
}

function combinedScore(slop: SlopReport, avoid: AvoidAiAnalyzeResult): number {
  // Map avoid-ai 0-100-ish score with slopPenalty 0-10 into 0-100 soft scale
  const slopPart = Math.min(100, slop.slopPenalty * 10)
  const avoidPart = Math.min(100, Math.max(0, avoid.score))
  return Math.round(slopPart * 0.55 + avoidPart * 0.45)
}

/**
 * Run dual-pass analysis. Never blocks write/accept.
 */
export function runDeAiDualPass(text: string, options: DualPassOptions = {}): DualPassReport {
  const slop = slopScore(text ?? "")
  const slopClass = classifySlop(slop)
  const avoidAi = analyzeAvoidAiPatterns(text ?? "")
  const combined = combinedScore(slop, avoidAi)
  const percentileInBaseline =
    options.baselineScores && options.baselineScores.length
      ? percentileRank(combined, options.baselineScores)
      : undefined

  const remediationNotes: string[] = []
  if (slopClass === "block" || slopClass === "warn") {
    remediationNotes.push(
      `机械腔 ${slopClass}：优先替换高频套话与低变异句长（slopPenalty=${slop.slopPenalty}）。`,
    )
  }
  if (avoidAi.score >= 15 || avoidAi.issues.length > 0) {
    remediationNotes.push(
      `avoid-ai patterns soft: score=${avoidAi.score} label=${avoidAi.label} issues=${avoidAi.issues.length}（英语偏置，仅参考）。`,
    )
  }
  if (percentileInBaseline != null && percentileInBaseline >= 90) {
    remediationNotes.push(
      `相对基线分位≈${percentileInBaseline.toFixed(0)}%（高分位=更像样板腔；非产品硬门）。`,
    )
  }
  if (!remediationNotes.length) {
    remediationNotes.push("双遍软检：未发现需优先处理的机械腔信号。")
  }

  const fragments = [
    slopClass !== "clean" ? slopReportToText(slop) : "",
    formatAvoidAiPatternsPromptFragment(avoidAi),
    remediationNotes.map((n) => `- ${n}`).join("\n"),
  ].filter(Boolean)

  return {
    schemaVersion: DE_AI_DUAL_PASS_SCHEMA,
    pass1: {
      slop,
      slopClass,
      avoidAi,
      combinedScore: combined,
      percentileInBaseline,
    },
    pass2: {
      remediationNotes,
      promptFragment: fragments.length /* v8 ignore start */
        ? `## De-AI dual-pass (Track B soft)\n${fragments.join("\n\n")}\n`
        : "", /* v8 ignore stop */
    },
    productHardGate: false,
    track: "B",
  }
}

export function formatDualPassSummary(report: DualPassReport): string {
  return [
    `de-ai dual-pass: combined=${report.pass1.combinedScore}`,
    `slop=${report.pass1.slopClass}`,
    `avoid=${report.pass1.avoidAi.label}`,
    report.pass1.percentileInBaseline != null
      ? `pct=${report.pass1.percentileInBaseline.toFixed(0)}`
      : "",
    "Track B soft; not product hard gate",
  ]
    .filter(Boolean)
    .join(" ")
}
