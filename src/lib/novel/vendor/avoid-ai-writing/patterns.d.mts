/**
 * Type declarations for the vendored avoid-ai-writing engine (patterns.mjs).
 *
 * P1-2: the engine was converted from a `?raw` + eval sandbox to a direct
 * ESM import, so its shape is now declared here instead of being `any`.
 * The wrapper (avoid-ai-patterns.ts) normalizes every field defensively —
 * keep this declaration structural-only, mirroring RawDetector.
 */

export interface AvoidAiVendorIssue {
  type: string
  text: string
  severity?: string
  [key: string]: unknown
}

export interface AvoidAiVendorResult {
  score?: number
  label?: string
  issues?: AvoidAiVendorIssue[]
  document_classification?: string
  class_probabilities?: { human?: number; mixed?: number; ai?: number }
  confidence_category?: string
  stats?: Record<string, unknown>
}

declare const AIDetector: {
  analyzeText: (
    text: string,
    options?: { contextMode?: string },
  ) => AvoidAiVendorResult
  normalizeText: (text: string) => string
  getLabel: (score: number) => string
  getColor: (score: number) => string
  SEVERITY_LABELS: Record<string, string>
  TYPE_LABELS: Record<string, string>
}

export default AIDetector
