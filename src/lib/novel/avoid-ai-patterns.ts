/**
 * Track B wrapper around vendored avoid-ai-writing detector (patterns.mjs).
 *
 * Full port of reference/avoid-ai-writing/detector/patterns.js (English-heavy).
 * Product hard gates are NEVER set from this score — skill hooks / soft notes only.
 * Chinese novel path still pairs with mechanical-slop-detector (de-ai-rules).
 *
 * Source: src/lib/novel/vendor/avoid-ai-writing/patterns.mjs (ESM; P1-2 — the
 * former ?raw + Function-constructor eval sandbox was removed; patterns.cjs stays as
 * the frozen vendor reference snapshot for diffing on upstream refreshes).
 * Load: direct ESM import (works in renderer + vitest + plain node).
 */
import AIDetector from "./vendor/avoid-ai-writing/patterns.mjs"

export const AVOID_AI_PATTERNS_SCHEMA = "avoid-ai-patterns/1.0" as const

export type AvoidAiContextMode = "general" | "technical"

export interface AvoidAiIssue {
  type: string
  text: string
  severity?: string
  [key: string]: unknown
}

export interface AvoidAiAnalyzeResult {
  schemaVersion: typeof AVOID_AI_PATTERNS_SCHEMA
  score: number
  label: string
  issues: AvoidAiIssue[]
  documentClassification?: string
  classProbabilities?: { human?: number; mixed?: number; ai?: number }
  confidenceCategory?: string
  stats?: Record<string, unknown>
  languageBias: "english-heavy"
  productHardGate: false
}

export interface AvoidAiAnalyzeOptions {
  contextMode?: AvoidAiContextMode
}

type RawDetector = {
  analyzeText: (
    text: string,
    options?: { contextMode?: string },
  ) => {
    score?: number
    label?: string
    issues?: AvoidAiIssue[]
    document_classification?: string
    class_probabilities?: { human?: number; mixed?: number; ai?: number }
    confidence_category?: string
    stats?: Record<string, unknown>
  }
}

// Frozen import — the module itself is the singleton (IIFE evaluates once).
const detector = AIDetector as RawDetector

function loadDetector(): RawDetector {
  if (!detector || typeof detector.analyzeText !== "function") {
    throw new Error("avoid-ai patterns.mjs missing analyzeText export")
  }
  return detector
}

/**
 * Run full avoid-ai-writing pattern engine. Track B only.
 */
export function analyzeAvoidAiPatterns(
  text: string,
  options: AvoidAiAnalyzeOptions = {},
): AvoidAiAnalyzeResult {
  const detector = loadDetector()
  const raw = detector.analyzeText(text ?? "", {
    contextMode: options.contextMode ?? "general",
  })
  return {
    schemaVersion: AVOID_AI_PATTERNS_SCHEMA,
    score: typeof raw.score === "number" ? raw.score : 0,
    label: typeof raw.label === "string" ? raw.label : "Unknown",
    issues: Array.isArray(raw.issues) ? raw.issues : [],
    documentClassification: raw.document_classification,
    classProbabilities: raw.class_probabilities,
    confidenceCategory: raw.confidence_category,
    stats: raw.stats,
    languageBias: "english-heavy",
    productHardGate: false,
  }
}

/** One-line soft note for skill hooks / logs. */
export function formatAvoidAiPatternsSummary(result: AvoidAiAnalyzeResult): string {
  return [
    `avoid-ai patterns: score=${result.score}`,
    `label=${result.label}`,
    `issues=${result.issues.length}`,
    result.documentClassification ? `class=${result.documentClassification}` : "",
    "Track B soft; english-heavy; not product hard gate",
  ]
    .filter(Boolean)
    .join(" ")
}

/**
 * Prompt fragment for Track B (truncate issues). Empty if clean-ish.
 */
export function formatAvoidAiPatternsPromptFragment(
  result: AvoidAiAnalyzeResult,
  maxIssues = 8,
): string {
  if (!result.issues.length && result.score < 15) return ""
  const top = result.issues
    .slice(0, maxIssues)
    .map((i) => `- [${i.type}] ${String(i.text).slice(0, 80)}`)
  return [
    "【Track B · avoid-ai-writing full patterns (English-heavy engine; soft only)】",
    `score=${result.score} label=${result.label} class=${result.documentClassification ?? "n/a"}`,
    ...top,
    "Prefer concrete diction over AI boilerplate; do not treat this score as a ship gate.",
  ].join("\n")
}
