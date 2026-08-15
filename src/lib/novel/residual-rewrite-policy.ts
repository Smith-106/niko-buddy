/**
 * Residual rewrite policy — bans densify-only / short-compress as primary levers
 * when residual truepack overall median is already high (>= 8.6).
 *
 * Wave evidence (L9 waves 5–8): densify ceiling Ch5@8.8; short-compress Ch1/Ch3
 * regressed; structure thril-pacing lifted Ch4/Ch6 to 9.0.
 *
 * Never elevates literary scores to Track A product hard gate.
 */

export const RESIDUAL_OVERALL_MEDIAN_THRESHOLD = 8.6

export type ResidualRewriteMode =
  | "structure_thril_pacing"
  | "densify_only"
  | "short_compress"
  | "micro_thril"
  | "other"

export interface ResidualRewritePolicyInput {
  /** Locked truepack N≥5 overall median for the residual chapter. */
  residualOverallMedian: number
  mode: ResidualRewriteMode
  /** structure_thril_pacing should preserve length (not short-compress). */
  lengthPreserving?: boolean
  /** Optional override; default RESIDUAL_OVERALL_MEDIAN_THRESHOLD. */
  threshold?: number
}

export interface ResidualRewritePolicyDecision {
  accept: boolean
  reason: string
  requiredMode: ResidualRewriteMode | null
  residualBand: "below_residual" | "residual_high"
  mode: ResidualRewriteMode
  /** Always false — residual policy is campaign/tooling, not Track A. */
  productHardGate: false
  threshold: number
}

export function evaluateResidualRewritePolicy(
  input: ResidualRewritePolicyInput,
): ResidualRewritePolicyDecision {
  const threshold =
    input.threshold != null && Number.isFinite(input.threshold)
      ? input.threshold
      : RESIDUAL_OVERALL_MEDIAN_THRESHOLD
  const median = Number(input.residualOverallMedian)
  const mode = input.mode
  const high =
    Number.isFinite(median) && median >= threshold
      ? ("residual_high" as const)
      : ("below_residual" as const)

  const base = {
    mode,
    productHardGate: false as const,
    threshold,
    residualBand: high,
  }

  if (!Number.isFinite(median)) {
    return {
      ...base,
      accept: false,
      reason: "residualOverallMedian is not a finite number",
      requiredMode: null,
    }
  }

  if (high === "below_residual") {
    return {
      ...base,
      accept: true,
      reason: `residual overall ${median} < ${threshold}; densify/short-compress not auto-banned`,
      requiredMode: null,
    }
  }

  // residual_high
  if (mode === "densify_only") {
    return {
      ...base,
      accept: false,
      reason: `residual overall ${median} >= ${threshold}: densify_only banned as primary lever (densify ceiling)`,
      requiredMode: "structure_thril_pacing",
    }
  }

  if (mode === "short_compress") {
    return {
      ...base,
      accept: false,
      reason: `residual overall ${median} >= ${threshold}: short_compress banned (wave short-structure regression)`,
      requiredMode: "structure_thril_pacing",
    }
  }

  if (mode === "structure_thril_pacing") {
    if (input.lengthPreserving === false) {
      return {
        ...base,
        accept: false,
        reason:
          "structure_thril_pacing requires lengthPreserving=true for residual chapters (no short-compress)",
        requiredMode: "structure_thril_pacing",
      }
    }
    return {
      ...base,
      accept: true,
      reason: `residual overall ${median} >= ${threshold}: structure_thril_pacing accepted (length-preserving)`,
      requiredMode: "structure_thril_pacing",
    }
  }

  if (mode === "micro_thril") {
    return {
      ...base,
      accept: false,
      reason: `residual overall ${median} >= ${threshold}: micro_thril alone insufficient (wave8 flat/regress); use structure_thril_pacing`,
      requiredMode: "structure_thril_pacing",
    }
  }

  return {
    ...base,
    accept: false,
    reason: `residual overall ${median} >= ${threshold}: mode=${mode} not approved; require structure_thril_pacing`,
    requiredMode: "structure_thril_pacing",
  }
}

export function isDensifyOrShortCompressBanned(
  residualOverallMedian: number,
  threshold: number = RESIDUAL_OVERALL_MEDIAN_THRESHOLD,
): boolean {
  return (
    Number.isFinite(residualOverallMedian) && residualOverallMedian >= threshold
  )
}
