/**
 * Track B multi-objective guardrails for literary polish / thril experiments.
 *
 * Wave3 evidence (20260809): thril +0.6 with pull -1.7 / character -2.0.
 * Pure helpers declare protect dims, build revision constraints, and decide
 * whether a polish candidate should roll back.
 *
 * Never elevates thril/overall to product hard gate. FIX-1 always protected.
 */

import type { SixReviewDimensionKey } from "./dimension-review-adapter"

/** Dimensions Track B thril polish must not intentionally sacrifice. */
export const TRACK_B_DEFAULT_PROTECT: SixReviewDimensionKey[] = [
  "character",
  "pull",
  "continuity",
  "consistency",
]

/** FIX-1 / mechanism spoilers — hard literary constraints. */
export const TRACK_B_FIX1_BAN_PATTERNS = [
  "Offer",
  "最终存活者",
  "唯一存活者",
  "机制名",
] as const

export interface TrackBMultiObjectivePolicy {
  /** Primary lift target (usually thril; may include pacing/pull). */
  liftDimensions: SixReviewDimensionKey[]
  /** Must not regress past threshold when lift succeeds. */
  protectDimensions: SixReviewDimensionKey[]
  /** Absolute median/score drop that counts as regression (default 0.5). */
  regressionThreshold: number
  /** Max Track B polish passes per generation (default 1). */
  maxPasses: number
  /** If true, thril-only lift with protect regression → reject candidate. */
  rejectOnProtectRegression: boolean
  /** FIX-1 phrases that abort literary "pass" claims. */
  fix1BanPatterns: readonly string[]
}

export interface TrackBScoreSnapshot {
  scores: Partial<Record<SixReviewDimensionKey, number>>
  /** Optional mechanical slop penalty (lower is better). */
  slopPenalty?: number
}

export interface TrackBGuardDecision {
  accept: boolean
  reason: string
  protectRegressions: SixReviewDimensionKey[]
  liftDeltas: Partial<Record<SixReviewDimensionKey, number>>
  fix1Violation: boolean
}

export function createDefaultTrackBMultiObjectivePolicy(
  overrides: Partial<TrackBMultiObjectivePolicy> = {},
): TrackBMultiObjectivePolicy {
  return {
    liftDimensions: overrides.liftDimensions ?? ["thrill", "pacing", "pull"],
    protectDimensions: overrides.protectDimensions ?? [...TRACK_B_DEFAULT_PROTECT],
    regressionThreshold: overrides.regressionThreshold ?? 0.5,
    maxPasses: overrides.maxPasses ?? 1,
    rejectOnProtectRegression: overrides.rejectOnProtectRegression ?? true,
    fix1BanPatterns: overrides.fix1BanPatterns ?? TRACK_B_FIX1_BAN_PATTERNS,
  }
}

/**
 * Constraint block appended to Track B revision prompts.
 * Explicit multi-objective: lift thril without burning character/pull/FIX-1.
 */
export function buildTrackBMultiObjectiveConstraint(
  policy: TrackBMultiObjectivePolicy = createDefaultTrackBMultiObjectivePolicy(),
): string {
  const lift = policy.liftDimensions.join(" / ")
  const protect = policy.protectDimensions.join(" / ")
  const bans = policy.fix1BanPatterns.join("、")
  return [
    "",
    "【Track B 多目标护栏】",
    `- 优先强化：${lift}（密度/选择代价/章末钩，非耳语堆叠）。`,
    `- 必须保护：${protect}——不得为抬 thril 而牺牲人设声线、追读连贯、设定一致性。`,
    `- 禁止出现：${bans} 及机制说明书口吻（FIX-1）。`,
    "- 若只能二选一：保留人物可信与设定自洽，放弃廉价 thril 堆料。",
    "- 本抛光不改变 Track A 门控；overall≥9 不是交付标准。",
  ].join("\n")
}

export function detectFix1Violation(
  text: string,
  patterns: readonly string[] = TRACK_B_FIX1_BAN_PATTERNS,
): boolean {
  const t = text ?? ""
  return patterns.some((p) => p && t.includes(p))
}

function delta(
  before: number | undefined,
  after: number | undefined,
): number | null {
  if (typeof before !== "number" || typeof after !== "number") return null
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  return Math.round((after - before) * 10) / 10
}

/**
 * Decide whether a polished candidate is acceptable under multi-objective policy.
 * When score snapshots are unavailable (runtime polish), use text FIX-1 + slop only.
 */
export function evaluateTrackBCandidate(
  before: TrackBScoreSnapshot,
  after: TrackBScoreSnapshot,
  afterText: string,
  policy: TrackBMultiObjectivePolicy = createDefaultTrackBMultiObjectivePolicy(),
): TrackBGuardDecision {
  const fix1Violation = detectFix1Violation(afterText, policy.fix1BanPatterns)
  if (fix1Violation) {
    return {
      accept: false,
      reason: "FIX-1 ban pattern present in polished text",
      protectRegressions: [],
      liftDeltas: {},
      fix1Violation: true,
    }
  }

  const liftDeltas: Partial<Record<SixReviewDimensionKey, number>> = {}
  for (const dim of policy.liftDimensions) {
    const d = delta(before.scores[dim], after.scores[dim])
    if (d != null) liftDeltas[dim] = d
  }

  const protectRegressions: SixReviewDimensionKey[] = []
  for (const dim of policy.protectDimensions) {
    const d = delta(before.scores[dim], after.scores[dim])
    if (d != null && d <= -policy.regressionThreshold) {
      protectRegressions.push(dim)
    }
  }

  // Slop: higher penalty is worse
  if (
    typeof before.slopPenalty === "number"
    && typeof after.slopPenalty === "number"
    && after.slopPenalty > before.slopPenalty + 0.05
  ) {
    return {
      accept: false,
      reason: "mechanical slop penalty increased",
      protectRegressions,
      liftDeltas,
      fix1Violation: false,
    }
  }

  if (policy.rejectOnProtectRegression && protectRegressions.length > 0) {
    const anyLift =
      Object.values(liftDeltas).some((d) => typeof d === "number" && d >= policy.regressionThreshold)
    // Reject when we have score evidence of protect regression (with or without lift).
    // If no score evidence for lift dims, still reject hard protect regressions.
    if (anyLift || protectRegressions.length > 0) {
      return {
        accept: false,
        reason: `protected dimension regression: ${protectRegressions.join(",")}`,
        protectRegressions,
        liftDeltas,
        fix1Violation: false,
      }
    }
  }

  return {
    accept: true,
    reason: "multi-objective checks passed",
    protectRegressions,
    liftDeltas,
    fix1Violation: false,
  }
}

/**
 * Runtime polish path without per-dim LLM scores: FIX-1 + slop only.
 * Score-based multi-objective is for experiment compare / offline N5.
 */
export function shouldAcceptTrackBPolishText(options: {
  beforeText: string
  afterText: string
  beforeSlop: number
  afterSlop: number
  policy?: TrackBMultiObjectivePolicy
}): TrackBGuardDecision {
  const policy = options.policy ?? createDefaultTrackBMultiObjectivePolicy()
  return evaluateTrackBCandidate(
    { scores: {}, slopPenalty: options.beforeSlop },
    { scores: {}, slopPenalty: options.afterSlop },
    options.afterText,
    policy,
  )
}
