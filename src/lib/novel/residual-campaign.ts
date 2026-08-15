/**
 * Residual campaign product opt-in — hold medians + field resolution
 * for deep-chapter structure-first residual rewrites.
 *
 * Default OFF (fail-open). Does not elevate overall>=9 to Track A.
 *
 * Roadmap 2026-08-12:
 * - Hold medians refreshed to live residual truepack (Ch1/2/3/5 @ 8.8).
 * - Dual-threshold keepGate: seal_stretch (9.0 default) | test_control (9.5).
 * - Freeze policy A: Ch4/Ch6 frozen at seal 9.0 unless includeFreeze override.
 */

import type { ResidualRewriteMode } from "./residual-rewrite-policy"
import { RESIDUAL_OVERALL_MEDIAN_THRESHOLD } from "./residual-rewrite-policy"
import type { ChapterStructurePlan } from "./chapter-structure-plan"
import { createDimAwareStructureThrilPacingPlan } from "./chapter-structure-plan"
import {
  classifyL9OverallMedian,
  L9_OVERALL_STRETCH_MEDIAN,
  L9_OVERALL_TEST_CONTROL_MEDIAN,
  type L9OverallMedianDisposition,
} from "./literary-experiment-protocol"

/**
 * Residual campaign hold medians (live truepack 2026-08-12).
 * Historical name WAVE8_* retained for import stability; values are live holds.
 */
export const WAVE8_RESIDUAL_HOLD_MEDIANS: Readonly<Record<number, number>> = {
  1: 8.8,
  2: 8.8,
  3: 8.8,
  4: 9.0,
  5: 8.8,
  6: 9.0,
} as const

/** Chapters already at overall 9.0 — freeze (no residual campaign by default). Policy A. */
export const RESIDUAL_FREEZE_CHAPTERS: ReadonlySet<number> = new Set([4, 6])

/** Default residual chapter order for Live campaign (roadmap P4: Ch5→2→1→3). */
export const RESIDUAL_CAMPAIGN_ORDER: readonly number[] = [5, 2, 1, 3]

/** KEEP gate for dual-threshold residual stop/freeze language. Default seal. */
export type ResidualKeepGate = "seal_stretch" | "test_control"

export const RESIDUAL_KEEP_GATE_DEFAULT: ResidualKeepGate = "seal_stretch"

/** Absolute pacing drop that forces ROLLBACK even if overall ≥ hold (M2). */
export const RESIDUAL_PACING_REGRESSION_THRESHOLD = 0.3

export interface ResidualCampaignNovelConfigSlice {
  residualCampaignEnabled?: boolean
  /** Override hold median for current chapter; omit = use hold table. */
  residualCampaignOverallMedian?: number | null
  residualCampaignMode?: ResidualRewriteMode | null
  residualCampaignLengthPreserving?: boolean
  /** When true, residual opt-in also targets freeze chapters (default false). */
  residualCampaignIncludeFreezeChapters?: boolean
  /**
   * Dual-threshold KEEP stop line. Default seal_stretch (≥9.0).
   * test_control aims ≥9.5 for stable 9+ campaigns; never Track A hard gate.
   */
  residualCampaignKeepGate?: ResidualKeepGate | null
  /** Optional dim medians for dim-aware structure plan (thril/pacing emphasis). */
  residualCampaignDimMedians?: Partial<
    Record<"thrill" | "pacing" | "character" | "pull" | "consistency" | "continuity", number>
  > | null
}

export type ResidualL9Band =
  | "below_residual"
  | "residual_high"
  | "at_nine"
  | "seal_pass_below_test_control"
  | "test_control_pass"

export interface ResidualCampaignResolvedFields {
  residualOverallMedian: number
  residualRewriteMode: ResidualRewriteMode
  residualLengthPreserving: boolean
  chapterStructurePlan: ChapterStructurePlan
  chapterNumber: number
  residualBand: ResidualL9Band
  frozen: boolean
  keepGate: ResidualKeepGate
  l9Disposition: L9OverallMedianDisposition
  sealMedian: typeof L9_OVERALL_STRETCH_MEDIAN
  testControlMedian: typeof L9_OVERALL_TEST_CONTROL_MEDIAN
  /** Always false — residual campaign is not Track A. */
  productHardGate: false
}

export type ResidualKeepDisposition =
  | "keep"
  | "rollback_overall"
  | "rollback_pacing"
  | "continue_polish"

export interface ResidualKeepEvaluationInput {
  /** Post-rewrite truepack overall median (N≥5). */
  overallMedian: number
  /** Chapter hold median (default from WAVE8 table when chapter provided). */
  holdMedian: number
  /** Optional pre/post pacing medians for M2 non-regression. */
  pacingBefore?: number | null
  pacingAfter?: number | null
  keepGate?: ResidualKeepGate
  samples?: number
  pacingRegressionThreshold?: number
}

export interface ResidualKeepEvaluation {
  disposition: ResidualKeepDisposition
  accept: boolean
  reason: string
  l9Disposition: L9OverallMedianDisposition
  keepGate: ResidualKeepGate
  overallMedian: number
  holdMedian: number
  pacingDelta: number | null
  productHardGate: false
}

function resolveKeepGate(
  config?: ResidualCampaignNovelConfigSlice | null,
): ResidualKeepGate {
  return config?.residualCampaignKeepGate === "test_control"
    ? "test_control"
    : RESIDUAL_KEEP_GATE_DEFAULT
}

function bandFromMedianAndGate(
  median: number,
  keepGate: ResidualKeepGate,
  samples: number = 5,
): { residualBand: ResidualL9Band; l9Disposition: L9OverallMedianDisposition } {
  const l9Disposition = classifyL9OverallMedian(median, samples)
  if (l9Disposition === "insufficient_samples") {
    return {
      residualBand:
        median >= RESIDUAL_OVERALL_MEDIAN_THRESHOLD ? "residual_high" : "below_residual",
      l9Disposition,
    }
  }
  if (l9Disposition === "test_control_pass") {
    return { residualBand: "test_control_pass", l9Disposition }
  }
  if (l9Disposition === "seal_pass_below_test_control") {
    // seal ≥9.0 but below 9.5 — at_nine for freeze language under seal gate;
    // under test_control still polishable.
    return {
      residualBand:
        keepGate === "test_control"
          ? "seal_pass_below_test_control"
          : "at_nine",
      l9Disposition,
    }
  }
  if (median >= RESIDUAL_OVERALL_MEDIAN_THRESHOLD) {
    return { residualBand: "residual_high", l9Disposition }
  }
  return { residualBand: "below_residual", l9Disposition }
}

/**
 * Resolve residual fields for deep-chapter when product residual campaign is enabled.
 * Returns null when campaign disabled, chapter missing, or freeze chapter without override.
 */
export function resolveResidualCampaignFields(args: {
  enabled: boolean
  chapterNumber?: number | null
  config?: ResidualCampaignNovelConfigSlice | null
}): ResidualCampaignResolvedFields | null {
  if (!args.enabled) return null
  const ch = args.chapterNumber
  if (ch == null || !Number.isFinite(ch) || ch < 1) return null

  const includeFreeze = args.config?.residualCampaignIncludeFreezeChapters === true
  const frozen = RESIDUAL_FREEZE_CHAPTERS.has(ch)
  if (frozen && !includeFreeze) return null

  const hold = WAVE8_RESIDUAL_HOLD_MEDIANS[ch]
  const override = args.config?.residualCampaignOverallMedian
  const median =
    override != null && Number.isFinite(override)
      ? Number(override)
      : hold != null
        ? hold
        : RESIDUAL_OVERALL_MEDIAN_THRESHOLD

  const mode: ResidualRewriteMode =
    args.config?.residualCampaignMode ?? "structure_thril_pacing"
  const lengthPreserving = args.config?.residualCampaignLengthPreserving !== false
  const keepGate = resolveKeepGate(args.config)
  const { residualBand, l9Disposition } = bandFromMedianAndGate(median, keepGate)

  const dimMedians = args.config?.residualCampaignDimMedians ?? undefined
  const chapterStructurePlan = createDimAwareStructureThrilPacingPlan({
    chapterNumber: ch,
    dimMedians: dimMedians ?? undefined,
  })

  return {
    residualOverallMedian: median,
    residualRewriteMode: mode,
    residualLengthPreserving: lengthPreserving,
    chapterStructurePlan,
    chapterNumber: ch,
    residualBand,
    frozen,
    keepGate,
    l9Disposition,
    sealMedian: L9_OVERALL_STRETCH_MEDIAN,
    testControlMedian: L9_OVERALL_TEST_CONTROL_MEDIAN,
    productHardGate: false,
  }
}

/**
 * M2 + dual-threshold KEEP evaluation after truepack N≥5 measure.
 * - overall < hold → rollback_overall
 * - pacing drop ≥ τ → rollback_pacing (even if overall ≥ hold)
 * - keepGate test_control and overall < 9.5 → continue_polish (if overall ≥ hold)
 * - else keep
 */
export function evaluateResidualKeep(
  input: ResidualKeepEvaluationInput,
): ResidualKeepEvaluation {
  const keepGate = input.keepGate ?? RESIDUAL_KEEP_GATE_DEFAULT
  const samples = input.samples ?? 5
  const overall = Number(input.overallMedian)
  const hold = Number(input.holdMedian)
  const l9Disposition = classifyL9OverallMedian(
    Number.isFinite(overall) ? overall : null,
    samples,
  )
  const base = {
    l9Disposition,
    keepGate,
    overallMedian: overall,
    holdMedian: hold,
    productHardGate: false as const,
  }

  let pacingDelta: number | null = null
  if (
    input.pacingBefore != null &&
    input.pacingAfter != null &&
    Number.isFinite(input.pacingBefore) &&
    Number.isFinite(input.pacingAfter)
  ) {
    pacingDelta = Number(input.pacingAfter) - Number(input.pacingBefore)
  }

  if (!Number.isFinite(overall) || !Number.isFinite(hold)) {
    return {
      ...base,
      disposition: "rollback_overall",
      accept: false,
      reason: "overallMedian/holdMedian not finite",
      pacingDelta,
    }
  }

  if (overall < hold) {
    return {
      ...base,
      disposition: "rollback_overall",
      accept: false,
      reason: `overall ${overall} < hold ${hold}`,
      pacingDelta,
    }
  }

  const tau =
    input.pacingRegressionThreshold != null &&
    Number.isFinite(input.pacingRegressionThreshold)
      ? Number(input.pacingRegressionThreshold)
      : RESIDUAL_PACING_REGRESSION_THRESHOLD
  if (pacingDelta != null && pacingDelta <= -tau) {
    return {
      ...base,
      disposition: "rollback_pacing",
      accept: false,
      reason: `pacing delta ${pacingDelta.toFixed(2)} ≤ -${tau} (non-regression)`,
      pacingDelta,
    }
  }

  if (keepGate === "test_control" && overall < L9_OVERALL_TEST_CONTROL_MEDIAN) {
    return {
      ...base,
      disposition: "continue_polish",
      accept: true,
      reason: `overall ${overall} ≥ hold ${hold} but < test_control ${L9_OVERALL_TEST_CONTROL_MEDIAN}; keep text, continue polish`,
      pacingDelta,
    }
  }

  return {
    ...base,
    disposition: "keep",
    accept: true,
    reason:
      keepGate === "test_control"
        ? `overall ${overall} ≥ test_control ${L9_OVERALL_TEST_CONTROL_MEDIAN} and hold ${hold}`
        : `overall ${overall} ≥ hold ${hold} (seal gate)`,
    pacingDelta,
  }
}

export function isResidualCampaignChapter(chapterNumber?: number | null): boolean {
  if (chapterNumber == null || !Number.isFinite(chapterNumber)) return false
  if (RESIDUAL_FREEZE_CHAPTERS.has(chapterNumber)) return false
  return RESIDUAL_CAMPAIGN_ORDER.includes(chapterNumber)
}

/** Freeze policy A: Ch4/Ch6 stay frozen unless includeFreeze override. */
export const RESIDUAL_FREEZE_POLICY = "A_freeze_seal_nines" as const
