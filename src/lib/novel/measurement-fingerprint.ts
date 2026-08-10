/**
 * Measurement fingerprint (Wave M0) — makes ContextPack a first-class independent variable.
 *
 * Same manuscript can score thril 6.4–8.2 under different packs. Every Track B result
 * must carry a stable fingerprint of model + N + window + mode + pack shape + chapter text
 * so cross-pack narratives are refuseable.
 *
 * Pure + browser-safe: reuses FNV-1a from book-analysis content-fingerprint.
 * Product hard gates are never set from literary scores.
 */
import { fingerprintText } from "./book-analysis/content-fingerprint"
import type { ContextPack } from "./context-engine"
import type {
  LiteraryExperimentMode,
  LiteraryExperimentProtocol,
} from "./literary-experiment-protocol"
import { LITERARY_EXPERIMENT_WINDOW } from "./literary-experiment-protocol"

export const MEASUREMENT_FINGERPRINT_SCHEMA = "measurement-fingerprint/1.0" as const

/** Fields of ContextPack that dominate six-dim diagnosis context. */
const PACK_HASH_KEYS = [
  "task",
  "chapterGoal",
  "outline",
  "recentSummaries",
  "previousChapterEnding",
  "characterStates",
  "soulDoc",
  "characterAuras",
  "cognitionStates",
  "foreshadowingStates",
  "timeline",
  "relatedSettings",
  "canonRules",
  "writingStyle",
  "searchResults",
  "graphSearchResults",
  "mustDo",
  "mustAvoid",
  "nextChapterAdvice",
  "revisionDirectives",
  "styleExemplars",
  "gaps",
  "recentChapterContents",
] as const

export interface MeasurementFingerprint {
  schemaVersion: typeof MEASUREMENT_FINGERPRINT_SCHEMA
  /** Short stable id for UI / compare (16 hex of composite). */
  id: string
  model: string
  samples: number
  window: typeof LITERARY_EXPERIMENT_WINDOW
  mode: LiteraryExperimentMode
  packKind?: string
  label?: string
  /** FNV of canonical pack payload. */
  packHash: string
  /** FNV of full chapter text under review. */
  chapterTextHash: string
  /** Optional sample length for quick sanity. */
  chapterTextChars: number
  /** Outline / recent / exemplar sizes for human readouts (not part of id alone). */
  shape: {
    outlineChars: number
    previousEndingChars: number
    recentChapterCount: number
    styleExemplarCount: number
    gapCount: number
    characterStateChars: number
  }
  /** True when packs differ enough that thril deltas are not text-causal. */
  notes?: string[]
}

export interface BuildMeasurementFingerprintInput {
  protocol: Pick<LiteraryExperimentProtocol, "model" | "samples" | "window" | "mode" | "label">
  pack: ContextPack
  chapterText: string
  packKind?: string
  notes?: string[]
}

function stableStringify(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
  }
  return JSON.stringify(String(value))
}

/** Canonical pack payload for hashing (order-stable). */
export function canonicalizeContextPackForHash(pack: ContextPack): string {
  const picked: Record<string, unknown> = {}
  for (const key of PACK_HASH_KEYS) {
    if (key in pack) {
      picked[key] = (pack as Record<string, unknown>)[key]
    }
  }
  return stableStringify(picked)
}

export function buildMeasurementFingerprint(
  input: BuildMeasurementFingerprintInput,
): MeasurementFingerprint {
  const chapterText = (input.chapterText ?? "").replace(/^\uFEFF/, "")
  const packHash = fingerprintText(canonicalizeContextPackForHash(input.pack))
  const chapterTextHash = fingerprintText(chapterText)
  const protocol = input.protocol

  const styleExemplars = (input.pack as { styleExemplars?: unknown[] }).styleExemplars
  const gaps = (input.pack as { gaps?: unknown[] }).gaps
  const recent = (input.pack as { recentChapterContents?: unknown[] }).recentChapterContents

  const shape = {
    outlineChars: (input.pack.outline ?? "").length,
    previousEndingChars: (input.pack.previousChapterEnding ?? "").length,
    recentChapterCount: Array.isArray(recent) ? recent.length : 0,
    styleExemplarCount: Array.isArray(styleExemplars) ? styleExemplars.length : 0,
    gapCount: Array.isArray(gaps) ? gaps.length : 0,
    characterStateChars: (input.pack.characterStates ?? "").length,
  }

  const composite = [
    protocol.model,
    String(protocol.samples),
    protocol.window,
    protocol.mode,
    input.packKind ?? "",
    packHash,
    chapterTextHash,
  ].join("|")
  const id = fingerprintText(composite)

  return {
    schemaVersion: MEASUREMENT_FINGERPRINT_SCHEMA,
    id,
    model: protocol.model,
    samples: protocol.samples,
    window: protocol.window,
    mode: protocol.mode,
    packKind: input.packKind,
    label: protocol.label,
    packHash,
    chapterTextHash,
    chapterTextChars: chapterText.length,
    shape,
    notes: input.notes,
  }
}

/**
 * Compare two fingerprints. Empty errors = comparable for thril/text causality claims.
 */
export function validateMeasurementFingerprintComparability(
  baseline: MeasurementFingerprint,
  candidate: MeasurementFingerprint,
): string[] {
  const errors: string[] = []
  if (baseline.model !== candidate.model) {
    errors.push(`model mismatch: ${baseline.model} vs ${candidate.model}`)
  }
  if (baseline.samples !== candidate.samples) {
    errors.push(`samples mismatch: ${baseline.samples} vs ${candidate.samples}`)
  }
  if (baseline.window !== candidate.window) {
    errors.push(`window mismatch: ${baseline.window} vs ${candidate.window}`)
  }
  if (baseline.mode !== candidate.mode) {
    errors.push(`mode mismatch: ${baseline.mode} vs ${candidate.mode}`)
  }
  if (baseline.chapterTextHash !== candidate.chapterTextHash) {
    errors.push("chapterTextHash mismatch — not same manuscript window")
  }
  if (baseline.packHash !== candidate.packHash) {
    errors.push(
      `packHash mismatch (${baseline.packHash.slice(0, 8)}… vs ${candidate.packHash.slice(0, 8)}…) — thril delta is pack-sensitive, not text-causal`,
    )
  }
  return errors
}

/** One-line UI / log summary. */
export function formatMeasurementFingerprintSummary(fp: MeasurementFingerprint): string {
  return [
    `fp=${fp.id.slice(0, 12)}`,
    `model=${fp.model}`,
    `N=${fp.samples}`,
    `window=${fp.window}`,
    `mode=${fp.mode}`,
    `pack=${fp.packHash.slice(0, 8)}`,
    `text=${fp.chapterTextHash.slice(0, 8)}`,
    `outline=${fp.shape.outlineChars}`,
    `ex=${fp.shape.styleExemplarCount}`,
  ].join(" ")
}

/**
 * K5′ narrative guard: thril "progress curves" / body-causal claims are allowed
 * only when fingerprints are comparable (same model, N protocol fields, pack, text).
 * Track B only — never a product hard gate.
 */
export function assertThrilProgressClaimAllowed(
  baseline: MeasurementFingerprint,
  candidate: MeasurementFingerprint,
): { allowed: boolean; errors: string[]; reason: string } {
  const errors = validateMeasurementFingerprintComparability(baseline, candidate)
  if (errors.length === 0) {
    return {
      allowed: true,
      errors: [],
      reason: "fingerprints comparable — thril delta may be discussed as text/process under locked pack",
    }
  }
  return {
    allowed: false,
    errors,
    reason:
      "REFUSE thril progress narrative: fingerprints not comparable (pack/model/window/text). " +
      "Do not claim body regression or architecture collapse from cross-pack thril deltas.",
  }
}

