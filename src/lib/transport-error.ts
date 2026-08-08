/**
 * Discriminated transport error classifier for CLI retry loops.
 *
 * Classifies transport attempt failures into typed categories so callers
 * branch on `error.kind` rather than fragile string-matching. The classifier
 * is pure and synchronous — safe to call from hot retry paths.
 *
 * MIT License — independently implemented.
 */

/**
 * The four failure kinds the retry loop distinguishes:
 * - `rate_limit` — transient upstream (429/5xx/overloaded/gateway timeout); retry with backoff.
 * - `stall` — inactivity / heartbeat watchdog timeout; retry with backoff.
 * - `isolation_retry` — first-token stall or pipe/stdin failure; single isolation retry before backoff.
 * - `fatal` — deterministic local failure (auth, model-not-found, silent exit); no retry.
 */
export type TransportErrorKind = "rate_limit" | "stall" | "isolation_retry" | "fatal"

export interface TransportError {
  kind: TransportErrorKind
  /** Verbatim upstream message — for diagnostic logs only. Branch on `kind`, not this. */
  message: string
  /** Whether the retry loop should backoff-retry this failure. */
  retryable: boolean
  raw?: unknown
}

/** Input shape: accepts a message plus any extra diagnostic fields. */
export interface TransportErrorInput {
  message: string
  [key: string]: unknown
}

/**
 * Matches transient upstream failures: HTTP 429/5xx, rate-limit wording,
 * overloaded, gateway timeout, and transient pipe/stdin failures under load.
 */
const TRANSIENT_RE =
  /(api error:\s*(429|500|502|503|504)\b|rate[ -]?limit|overloaded|temporarily unavailable|service unavailable|gateway timeout|connection closed mid-response|failed to (write to|flush) claude stdin|broken pipe|os error 109|管道已结束|produced no meaningful stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|produced no additional stream output within \d+ seconds)/i

/**
 * Strict subset of TRANSIENT_RE: first-token stall and pipe/stdin failures
 * that qualify for the single same-binary isolation retry before the backoff loop.
 */
const ISOLATION_RE =
  /(produced no meaningful stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|failed to (write to|flush) claude stdin|broken pipe|os error 109|管道已结束)/i

/**
 * Classify a transport attempt result into a typed error.
 *
 * Resolution order (most-specific first):
 *   1. `isolation_retry` — matches ISOLATION_RE (strict subset). retryable=true.
 *   2. `rate_limit` — matches TRANSIENT_RE (upstream + pipe). retryable=true.
 *   3. `fatal` — everything else. retryable=false.
 */
export function classifyTransportError(attemptResult: TransportErrorInput): TransportError {
  const message = attemptResult.message ?? ""
  const text = message.trim()

  if (!text) {
    return { kind: "fatal", message, retryable: false, raw: attemptResult }
  }

  // Test isolation subset first (more specific).
  if (ISOLATION_RE.test(text)) {
    return { kind: "isolation_retry", message, retryable: true, raw: attemptResult }
  }

  // Then the broader transient pattern.
  if (TRANSIENT_RE.test(text)) {
    return { kind: "rate_limit", message, retryable: true, raw: attemptResult }
  }

  // Everything else is deterministic/fatal.
  return { kind: "fatal", message, retryable: false, raw: attemptResult }
}
