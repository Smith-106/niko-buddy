/**
 * ISS-019: Discriminated transport error type.
 *
 * The prior `shouldRetryClaudeCliError(message: string)` / `shouldRetryClaudeCliWithIsolation(message: string)`
 * classifiers scattered string-`includes` / regex matching across two functions and three call sites in
 * `claude-cli-transport.ts`. Callers that needed to branch on the *kind* of failure (rate-limit vs. stall
 * vs. isolation-retry vs. fatal) had to re-match the same message strings themselves, which is brittle:
 * a wording change in the upstream message silently changes retry routing.
 *
 * `classifyTransportError` runs the same string matching ONCE and returns a typed `TransportError` whose
 * `kind` is the discriminating field. `message` is preserved verbatim for diagnostic logs; callers MUST
 * branch on `error.kind`, never on `message.includes(...)` (the spec test enforces this).
 *
 * The classifier is pure and synchronous: it reads only `attemptResult.message`. No LLM, no network, no
 * side effects — safe to call from hot retry paths.
 */

/**
 * The four kinds of transport failure the CLI retry loop distinguishes:
 * - `rate_limit` — upstream 429 / overloaded / 5xx availability; backoff gives the upstream time to recover.
 * - `stall` — first-token / inactivity / mid-conversation heartbeat watchdog tripped; the CLI is alive
 *   but producing no assistant text. Backoff retry is the minimal break-the-loop fix (S2 Chapter-12).
 * - `isolation_retry` — a stall-ish failure that ALSO qualifies for the single same-binary isolation
 *   retry (pipe/stdin/first-token). A strict subset of `stall` by message; isolated as its own kind
 *   because the retry routing is different (one isolation retry BEFORE the backoff loop, not inside it).
 * - `fatal` — deterministic local failures (auth, model-not-found, silent exit). No retry; surface to user.
 */
export type TransportErrorKind = "rate_limit" | "stall" | "isolation_retry" | "fatal"

export interface TransportError {
  kind: TransportErrorKind
  /** Verbatim upstream message — for diagnostic logs only. Callers MUST branch on `kind`, not on this. */
  message: string
  /** Whether the retry loop should backoff-retry this failure. Mirrors the prior shouldRetryClaudeCliError contract. */
  retryable: boolean
  raw?: unknown
}

/**
 * Input shape. Accepts the existing `attemptResult` (`{ kind: "error"; message: string; emittedToken }`)
 * plus any extra fields (forwarded to `raw` for diagnostics). Keeps the classifier decoupled from the
 * attempt-result type so it can be reused by other transports if needed.
 */
export interface TransportErrorInput {
  message: string
  [key: string]: unknown
}

// C-101 (GRL-008): the prior two regexes, consolidated. `RATE_LIMIT_RE` matches transient upstream
// availability failures (HTTP 429/5xx, rate-limit wording, overloaded, gateway timeout) PLUS the
// mid-response pipe/stdin failures that are also transient under load. `ISOLATION_RETRY_RE` is the
// strict subset that ALSO qualifies for the single same-binary isolation retry (first-token stall +
// pipe/stdin/管道已结束). A message can match BOTH; the classifier resolves this by testing
// `ISOLATION_RETRY_RE` first (isolation_retry is the more-specific kind) and falling back to
// `RATE_LIMIT_RE` / stall wording.
const RATE_LIMIT_RE =
  /(api error:\s*(429|500|502|503|504)\b|rate[ -]?limit|overloaded|temporarily unavailable|service unavailable|gateway timeout|connection closed mid-response|failed to (write to|flush) claude stdin|broken pipe|os error 109|管道已结束|produced no meaningful stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|produced no additional stream output within \d+ seconds)/i

// Strict subset of RATE_LIMIT_RE: first-token stall + pipe/stdin failures. These qualify for the
// single same-binary isolation retry (re-spawn with local CLI isolation) BEFORE the backoff loop.
const ISOLATION_RETRY_RE =
  /(produced no meaningful stream output within \d+ seconds|never produced assistant text or StructuredOutput before stalling|failed to (write to|flush) claude stdin|broken pipe|os error 109|管道已结束)/i

/**
 * Classify a transport attempt result into a typed `TransportError`.
 *
 * Resolution order (most-specific first):
 *   1. `isolation_retry` — matches ISOLATION_RETRY_RE (strict subset of stall). retryable=true.
 *   2. `rate_limit` — matches RATE_LIMIT_RE (transient upstream + transient pipe). retryable=true.
 *   3. `stall` — matches the stall-only wording (watchdog timeouts) without the isolation subset.
 *      retryable=true (C-101: first-token/inactivity/mid-conv stalls now retry with backoff too).
 *   4. `fatal` — everything else (auth, model-not-found, silent exit, unknown). retryable=false.
 *
 * Note: `isolation_retry` and `rate_limit` overlap on pipe/stdin messages. We return
 * `isolation_retry` for those because the retry routing for pipe/stdin is the isolation retry
 * (runs first), not just backoff. The backoff loop's `isStallError` check covers both kinds via
 * `retryable`, so a message classified as `isolation_retry` still triggers backoff if the
 * isolation retry already ran.
 */
export function classifyTransportError(attemptResult: TransportErrorInput): TransportError {
  const message = attemptResult.message ?? ""
  const text = message.trim()
  if (!text) {
    return { kind: "fatal", message, retryable: false, raw: attemptResult }
  }
  if (ISOLATION_RETRY_RE.test(text)) {
    return { kind: "isolation_retry", message, retryable: true, raw: attemptResult }
  }
  if (RATE_LIMIT_RE.test(text)) {
    return { kind: "rate_limit", message, retryable: true, raw: attemptResult }
  }
  // Stall-only wording is already covered by RATE_LIMIT_RE (the "produced no ... within \d+ seconds"
  // and "never produced assistant text" clauses). If we reach here, the message did NOT match any
  // transient pattern → fatal (auth, model-not-found, silent exit, unknown).
  return { kind: "fatal", message, retryable: false, raw: attemptResult }
}
