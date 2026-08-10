/**
 * Track B wrapper around vendored avoid-ai-writing detector (patterns.cjs).
 *
 * Full port of reference/avoid-ai-writing/detector/patterns.js (English-heavy).
 * Product hard gates are NEVER set from this score — skill hooks / soft notes only.
 * Chinese novel path still pairs with mechanical-slop-detector (de-ai-rules).
 *
 * Source: src/lib/novel/vendor/avoid-ai-writing/patterns.cjs
 * Load: Vite `?raw` + Function sandbox (works in renderer + vitest; no createRequire).
 */
// Vite/vitest raw string of the CommonJS detector (IIFE + module.exports = AIDetector)
import patternsSource from "./vendor/avoid-ai-writing/patterns.cjs?raw"

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

let cached: RawDetector | null = null

function loadDetector(): RawDetector {
  if (cached) return cached
  const module = { exports: {} as RawDetector }
  // patterns.cjs ends with: module.exports = AIDetector
  const runner = new Function("module", "exports", String(patternsSource))
  runner(module, module.exports)
  if (!module.exports || typeof module.exports.analyzeText !== "function") {
    throw new Error("avoid-ai patterns.cjs missing analyzeText after eval")
  }
  cached = module.exports
  return cached
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
