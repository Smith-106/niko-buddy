/**
 * Literary experiment protocol (Track B measurement contract).
 *
 * Same-model, full-window, N≥5, NEW-only diagnosis — freezes the rules that
 * made Ch4 thril wave comparisons invalid when models/windows/N drifted.
 *
 * Pure module: no I/O, no product hard gate on overall≥9.
 * Source: measurement-protocol-milestones + quality-loop architecture 20260809.
 */

import type { ContextPack } from "./context-engine"
import {
  buildMeasurementFingerprint,
  type MeasurementFingerprint,
} from "./measurement-fingerprint"
import {
  SIX_REVIEW_DIMENSION_ORDER,
  type SixReviewDimensionKey,
} from "./dimension-review-adapter"

/** Canonical Track B diagnosis model when sub2 composer is unavailable. */
export const LITERARY_EXPERIMENT_DEFAULT_MODEL = "claude-sonnet-4-6"

/** Milestone / seal default sample count (N=3 is smoke-only). */
export const LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL = 5

export const LITERARY_EXPERIMENT_WINDOW = "full_chapter" as const

export type LiteraryExperimentMode = "NEW_only" | "AB_old_new"

export type LiteraryExperimentVerdictBand =
  | "reviewer_bias_dominant" // NEW median ≥ 8.3
  | "text_gap_dominant" // NEW median ≤ 7.5
  | "mixed_zone" // (7.5, 8.3)
  | "insufficient_samples"

export interface LiteraryExperimentProtocol {
  schemaVersion: "literary-experiment/1.0"
  /** Locked model id for before/after comparability. */
  model: string
  samples: number
  window: typeof LITERARY_EXPERIMENT_WINDOW
  mode: LiteraryExperimentMode
  /** Product hard gate is NEVER overall≥9 — Track A only. */
  productHardGate: false
  overallGe9IsShipCriterion: false
  dimensions: SixReviewDimensionKey[]
  /** Optional label for bak / post-struct / wave3 etc. */
  label?: string
  notes?: string[]
}

export interface LiteraryExperimentMedianSnapshot {
  model: string
  samples: number
  label?: string
  medians: Partial<Record<SixReviewDimensionKey, number>>
  overallMedian?: number
  generatedAt?: string
}

export interface LiteraryExperimentDelta {
  dimension: SixReviewDimensionKey
  before: number | null
  after: number | null
  delta: number | null
}

export interface LiteraryExperimentCompareResult {
  protocol: LiteraryExperimentProtocol
  before: LiteraryExperimentMedianSnapshot
  after: LiteraryExperimentMedianSnapshot
  deltas: LiteraryExperimentDelta[]
  thrilDelta: number | null
  pullDelta: number | null
  characterDelta: number | null
  overallDelta: number | null
  /** True when thril rose while a protected dim fell past threshold. */
  multiObjectiveConflict: boolean
  protectedRegressions: SixReviewDimensionKey[]
  warnings: string[]
}

export interface CreateProtocolOptions {
  model?: string
  samples?: number
  mode?: LiteraryExperimentMode
  label?: string
  notes?: string[]
}

/**
 * Build a locked protocol object. Samples below seal minimum are allowed for
 * smoke but emit a note; never claims product FAIL from literary scores.
 */
export function createLiteraryExperimentProtocol(
  options: CreateProtocolOptions = {},
): LiteraryExperimentProtocol {
  const samplesRaw = options.samples
  const samples =
    samplesRaw == null || !Number.isFinite(samplesRaw)
      ? LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL
      : Math.min(10, Math.max(1, Math.trunc(samplesRaw)))

  const notes: string[] = [...(options.notes ?? [])]
  if (samples < LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL) {
    notes.push(
      `samples=${samples} < seal minimum ${LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL}; smoke only — not a milestone verdict`,
    )
  }
  notes.push("Track B diagnosis only; Track A Consistency>Anti-AI>Quality unchanged")
  notes.push("Do not compare medians across different models")
  notes.push("Do not compare thril across different packHash (see measurementFingerprint)")

  return {
    schemaVersion: "literary-experiment/1.0",
    model: (options.model ?? LITERARY_EXPERIMENT_DEFAULT_MODEL).trim() || LITERARY_EXPERIMENT_DEFAULT_MODEL,
    samples,
    window: LITERARY_EXPERIMENT_WINDOW,
    mode: options.mode ?? "NEW_only",
    productHardGate: false,
    overallGe9IsShipCriterion: false,
    dimensions: [...SIX_REVIEW_DIMENSION_ORDER],
    label: options.label,
    notes,
  }
}

/**
 * Validate that an experiment run may be compared to a baseline protocol.
 * Returns empty array when compatible.
 */
export function validateLiteraryExperimentComparability(
  baseline: LiteraryExperimentProtocol,
  candidate: LiteraryExperimentProtocol,
): string[] {
  const errors: string[] = []
  if (baseline.model !== candidate.model) {
    errors.push(`model mismatch: baseline=${baseline.model} candidate=${candidate.model}`)
  }
  if (baseline.window !== candidate.window) {
    errors.push(`window mismatch: baseline=${baseline.window} candidate=${candidate.window}`)
  }
  if (baseline.mode !== candidate.mode) {
    errors.push(`mode mismatch: baseline=${baseline.mode} candidate=${candidate.mode}`)
  }
  if (baseline.samples !== candidate.samples) {
    errors.push(`samples mismatch: baseline=${baseline.samples} candidate=${candidate.samples}`)
  }
  if (baseline.samples < LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL || candidate.samples < LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL) {
    errors.push(
      `samples below seal minimum ${LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL} — refuse milestone compare`,
    )
  }
  return errors
}

export function bandForMedian(median: number | null | undefined, samples: number): LiteraryExperimentVerdictBand {
  if (samples < LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL) return "insufficient_samples"
  if (median == null || !Number.isFinite(median)) return "mixed_zone"
  if (median >= 8.3) return "reviewer_bias_dominant"
  if (median <= 7.5) return "text_gap_dominant"
  return "mixed_zone"
}

export interface CompareOptions {
  /** Dimensions that must not fall when thril rises (default character + pull). */
  protectDimensions?: SixReviewDimensionKey[]
  /** Absolute drop that counts as regression (default 0.5). */
  regressionThreshold?: number
}

/**
 * Compare two same-protocol median snapshots. Refuses silent cross-model compare.
 */
export function compareLiteraryExperimentSnapshots(
  before: LiteraryExperimentMedianSnapshot,
  after: LiteraryExperimentMedianSnapshot,
  protocol: LiteraryExperimentProtocol,
  options: CompareOptions = {},
): LiteraryExperimentCompareResult {
  const warnings: string[] = []
  if (before.model !== after.model) {
    warnings.push(`snapshot model mismatch: before=${before.model} after=${after.model}`)
  }
  if (before.model !== protocol.model || after.model !== protocol.model) {
    warnings.push(`snapshot model differs from protocol.model=${protocol.model}`)
  }
  if (before.samples !== protocol.samples || after.samples !== protocol.samples) {
    warnings.push("sample count differs from protocol — median noise risk")
  }

  const protect = options.protectDimensions ?? (["character", "pull"] as SixReviewDimensionKey[])
  const threshold = options.regressionThreshold ?? 0.5

  const deltas: LiteraryExperimentDelta[] = SIX_REVIEW_DIMENSION_ORDER.map((dimension) => {
    const b = before.medians[dimension]
    const a = after.medians[dimension]
    const beforeN = typeof b === "number" && Number.isFinite(b) ? b : null
    const afterN = typeof a === "number" && Number.isFinite(a) ? a : null
    return {
      dimension,
      before: beforeN,
      after: afterN,
      delta: beforeN != null && afterN != null ? round1(afterN - beforeN) : null,
    }
  })

  const byDim = Object.fromEntries(deltas.map((d) => [d.dimension, d])) as Record<
    SixReviewDimensionKey,
    LiteraryExperimentDelta
  >

  const thrilDelta = byDim.thrill?.delta ?? null
  const pullDelta = byDim.pull?.delta ?? null
  const characterDelta = byDim.character?.delta ?? null
  const overallBefore = before.overallMedian
  const overallAfter = after.overallMedian
  const overallDelta =
    typeof overallBefore === "number" && typeof overallAfter === "number"
      ? round1(overallAfter - overallBefore)
      : null

  const protectedRegressions: SixReviewDimensionKey[] = []
  for (const dim of protect) {
    const d = byDim[dim]?.delta
    if (typeof d === "number" && d <= -threshold) {
      protectedRegressions.push(dim)
    }
  }

  const thrilRose = typeof thrilDelta === "number" && thrilDelta >= threshold
  const multiObjectiveConflict = thrilRose && protectedRegressions.length > 0
  if (multiObjectiveConflict) {
    warnings.push(
      `multi-objective conflict: thril +${thrilDelta} but protected dims fell: ${protectedRegressions.join(",")}`,
    )
  }

  return {
    protocol,
    before,
    after,
    deltas,
    thrilDelta,
    pullDelta,
    characterDelta,
    overallDelta,
    multiObjectiveConflict,
    protectedRegressions,
    warnings,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Production measurement fixture: chapter text + ContextPack for step0 NEW-only.
 * Does not call LLM. Caller supplies pack from buildContextPack (production path).
 */
export interface ProductionStep0Fixture {
  generatedAt: string
  packKind: "production-measurement"
  protocol: LiteraryExperimentProtocol
  project: string
  chapter: number
  sampleChars: number
  pack: ContextPack
  chapterText: string
  prompts: { old: Record<string, string> }
  windowNote: string
  diagnosis: {
    mode: LiteraryExperimentMode
    samples: number
    label?: string
    product_hard_gate: false
    same_model_required: true
  }
  /** M0: pack+text+protocol fingerprint — required for thril causality claims. */
  measurementFingerprint: MeasurementFingerprint
}

export interface BuildProductionStep0FixtureInput {
  projectPath: string
  chapter: number
  chapterText: string
  pack: ContextPack
  protocol?: LiteraryExperimentProtocol
  /** Optional OLD-arm prompt snapshots; NEW arm always built at runtime by harness. */
  oldPrompts?: Record<string, string>
  generatedAt?: string
}

/**
 * Build a step0 fixture object that locks protocol metadata and full chapterText.
 * Prefer pack from buildContextPack(project, task, chapter) so measurement shares
 * production memory/temporal path (not hand-crafted thin packs).
 */
export function buildProductionStep0Fixture(
  input: BuildProductionStep0FixtureInput,
): ProductionStep0Fixture {
  const protocol =
    input.protocol
    ?? createLiteraryExperimentProtocol({
      label: `ch${input.chapter}-production`,
    })
  const chapterText = input.chapterText.replace(/^\uFEFF/, "")
  const generatedAt = input.generatedAt ?? new Date().toISOString()

  const measurementFingerprint = buildMeasurementFingerprint({
    protocol,
    pack: input.pack,
    chapterText,
    packKind: "production-measurement",
    notes: [
      "Cross-pack thril deltas are instrument-sensitive — refuse text-causal claims when packHash differs",
    ],
  })

  return {
    generatedAt,
    packKind: "production-measurement",
    protocol,
    project: input.projectPath,
    chapter: input.chapter,
    sampleChars: chapterText.length,
    pack: input.pack,
    chapterText,
    prompts: { old: input.oldPrompts ?? {} },
    windowNote: `full chapterText; N=${protocol.samples} ${protocol.mode}; model ${protocol.model}; fp=${measurementFingerprint.id.slice(0, 12)}`,
    diagnosis: {
      mode: protocol.mode,
      samples: protocol.samples,
      label: protocol.label,
      product_hard_gate: false,
      same_model_required: true,
    },
    measurementFingerprint,
  }
}

/**
 * Extract median snapshot from a step0-ab-results.json shaped object.
 */
export function snapshotFromStep0Results(raw: {
  model?: string
  samples?: number
  generatedAt?: string
  results?: Record<string, { newMedian?: number; new?: Array<number | null> }>
  verdict?: { overallNewMedian?: number }
  remeasure?: { label?: string }
}): LiteraryExperimentMedianSnapshot {
  const medians: Partial<Record<SixReviewDimensionKey, number>> = {}
  const results = raw.results ?? {}
  for (const dim of SIX_REVIEW_DIMENSION_ORDER) {
    const r = results[dim]
    if (!r) continue
    if (typeof r.newMedian === "number" && Number.isFinite(r.newMedian)) {
      medians[dim] = r.newMedian
      continue
    }
    const vals = (r.new ?? []).filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    if (vals.length > 0) {
      const sorted = [...vals].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      medians[dim] =
        sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }
  }
  return {
    model: raw.model ?? "unknown",
    samples: raw.samples ?? 0,
    label: raw.remeasure?.label,
    medians,
    overallMedian: raw.verdict?.overallNewMedian,
    generatedAt: raw.generatedAt,
  }
}

