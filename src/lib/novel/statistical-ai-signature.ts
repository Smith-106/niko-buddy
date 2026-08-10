/**
 * Wave C — Binoculars-inspired statistical AI signature (Track B experimental).
 *
 * v1 proxy: avoid-ai classProbabilities + lexical burstiness/CV from slop detector.
 * Does NOT require dual local LMs (true Binoculars). experimental:true always.
 * productHardGate always false.
 */
import { analyzeAvoidAiPatterns } from "./avoid-ai-patterns"
import { slopScore } from "./mechanical-slop-detector"
import { percentileRank } from "./de-ai-percentile"

export const STATISTICAL_AI_SIGNATURE_SCHEMA = "statistical-ai-signature/1.0" as const

export type SignatureBand = "low" | "mid" | "high"

export interface StatisticalAiSignature {
  schemaVersion: typeof STATISTICAL_AI_SIGNATURE_SCHEMA
  /** Soft 0–1 AI-likeness proxy. */
  score0to1: number
  band: SignatureBand
  features: {
    avoidAiScore: number
    aiClassProb: number
    slopPenalty: number
    sentenceLengthCV: number
  }
  percentileInBaseline?: number
  productHardGate: false
  experimental: true
  method: "classprob+lexical-proxy"
  note: string
}

function bandOf(score: number): SignatureBand {
  if (score >= 0.66) return "high"
  if (score >= 0.33) return "mid"
  return "low"
}

export interface SignatureOptions {
  baselineScores?: readonly number[]
}

/**
 * Score statistical AI signature. Track B soft only.
 */
export function scoreStatisticalAiSignature(
  text: string,
  options: SignatureOptions = {},
): StatisticalAiSignature {
  const avoid = analyzeAvoidAiPatterns(text ?? "")
  const slop = slopScore(text ?? "")
  const aiProb = Math.min(1, Math.max(0, avoid.classProbabilities?.ai ?? avoid.score / 100))
  const avoidNorm = Math.min(1, Math.max(0, avoid.score / 100))
  const slopNorm = Math.min(1, Math.max(0, slop.slopPenalty / 10))
  // Low CV often correlates with uniform AI prose — invert lightly into risk
  const cv = slop.sentenceLengthCV ?? 0
  const lowCvRisk = cv > 0 && cv < 0.15 ? 0.25 : 0
  const score0to1 = Math.min(
    1,
    Math.round((aiProb * 0.45 + avoidNorm * 0.3 + slopNorm * 0.2 + lowCvRisk * 0.05) * 1000) / 1000,
  )
  const percentileInBaseline =
    options.baselineScores && options.baselineScores.length
      ? percentileRank(score0to1 * 100, options.baselineScores.map((s) => s * 100))
      : undefined

  return {
    schemaVersion: STATISTICAL_AI_SIGNATURE_SCHEMA,
    score0to1,
    band: bandOf(score0to1),
    features: {
      avoidAiScore: avoid.score,
      aiClassProb: aiProb,
      slopPenalty: slop.slopPenalty,
      sentenceLengthCV: cv,
    },
    percentileInBaseline,
    productHardGate: false,
    experimental: true,
    method: "classprob+lexical-proxy",
    note: "Binoculars-inspired proxy without dual LM; Track B experimental; not product hard gate",
  }
}

export function formatStatisticalAiSignatureFragment(sig: StatisticalAiSignature): string {
  if (sig.band === "low") return ""
  return [
    "## Statistical AI signature (Track B experimental)",
    `- score=${sig.score0to1.toFixed(3)} band=${sig.band}`,
    `- method=${sig.method}`,
    `- not product hard gate`,
  ].join("\n")
}
