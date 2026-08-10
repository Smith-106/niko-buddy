/**
 * Wave C — percentile helpers for de-AI soft calibration.
 *
 * Pure math for FPR-oriented bands. Does NOT claim a labeled corpus;
 * self-test is a proxy over caller-supplied samples.
 * productHardGate always false — Track B only.
 */
export const DE_AI_PERCENTILE_SCHEMA = "de-ai-percentile/1.0" as const

/** 0–100 percentile rank of value within sample (inclusive). */
export function percentileRank(value: number, sample: readonly number[]): number {
  if (!sample.length) return 50
  const sorted = [...sample].filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!sorted.length) return 50
  if (sorted.length === 1) return value >= sorted[0]! ? 100 : 0
  let below = 0
  let equal = 0
  for (const x of sorted) {
    if (x < value) below++
    else if (x === value) equal++
  }
  // Midrank: (count < v + 0.5 * count == v) / n * 100
  return ((below + 0.5 * equal) / sorted.length) * 100
}

/** Value at percentile p in [0,100] via nearest-rank. */
export function valueAtPercentile(sample: readonly number[], p: number): number {
  const sorted = [...sample].filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const clamped = Math.min(100, Math.max(0, p))
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((clamped / 100) * sorted.length) - 1))
  return sorted[idx]!
}

export interface CalibratedBands {
  schemaVersion: typeof DE_AI_PERCENTILE_SCHEMA
  n: number
  p50: number
  p90: number
  p95: number
  /** Soft note: not a product gate. */
  productHardGate: false
  calibrated: boolean
  note: string
}

export function calibrateThresholds(
  samples: readonly number[],
  opts?: { p50?: number; p90?: number; p95?: number },
): CalibratedBands {
  const want50 = opts?.p50 ?? 50
  const want90 = opts?.p90 ?? 90
  const want95 = opts?.p95 ?? 95
  const n = samples.filter((x) => Number.isFinite(x)).length
  return {
    schemaVersion: DE_AI_PERCENTILE_SCHEMA,
    n,
    p50: valueAtPercentile(samples, want50),
    p90: valueAtPercentile(samples, want90),
    p95: valueAtPercentile(samples, want95),
    productHardGate: false,
    calibrated: n >= 5,
    note:
      n < 5
        ? "uncalibrated: need ≥5 samples for soft bands"
        : "soft FPR-oriented bands; not product hard gate",
  }
}

export interface ChineseFprProxyResult {
  schemaVersion: typeof DE_AI_PERCENTILE_SCHEMA
  humanN: number
  aiN: number
  /** Fraction of humanish samples scoring ≥ thr (false positive proxy). */
  fprAtP90: number
  /** Fraction of aish samples scoring ≥ thr (true positive proxy). */
  tprAtP90: number
  threshold: number
  productHardGate: false
  experimental: true
  note: string
}

/**
 * Proxy FPR/TPR using humanish vs aish score samples at human p90 threshold.
 * Not a RAID-grade evaluation — soft self-test only.
 */
export function selfTestChineseFprProxy(
  humanish: readonly number[],
  aish: readonly number[],
): ChineseFprProxyResult {
  const bands = calibrateThresholds(humanish)
  const thr = bands.p90
  const fpr =
    humanish.length === 0
      ? 0
      : humanish.filter((s) => s >= thr).length / humanish.length
  const tpr = aish.length === 0 ? 0 : aish.filter((s) => s >= thr).length / aish.length
  return {
    schemaVersion: DE_AI_PERCENTILE_SCHEMA,
    humanN: humanish.length,
    aiN: aish.length,
    fprAtP90: fpr,
    tprAtP90: tpr,
    threshold: thr,
    productHardGate: false,
    experimental: true,
    note: "Chinese FPR proxy self-test; uncalibrated corpus; Track B only",
  }
}
