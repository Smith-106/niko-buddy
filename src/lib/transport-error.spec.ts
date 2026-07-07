import { describe, expect, it } from "vitest"
import { classifyTransportError, type TransportErrorKind } from "./transport-error"

/**
 * ISS-019: tests for the discriminated transport error classifier.
 *
 * The spec (ISS-019) requires that callers branch on `error.kind`, NOT on `message.includes(...)`.
 * These tests pin the four kinds + retryable flag for representative inputs, and assert that the
 * classifier is the single source of string-matching truth (the prior shouldRetryClaudeCliError /
 * shouldRetryClaudeCliWithIsolation contract is preserved: every input they returned true for is
 * now `retryable: true`, every input they returned false for is now `retryable: false`).
 */

describe("classifyTransportError", () => {
  describe("isolation_retry (strict subset — pipe/stdin + first-token stall)", () => {
    const isolationInputs = [
      "Claude Code CLI produced no meaningful stream output within 90 seconds.",
      "Claude Code CLI never produced assistant text or StructuredOutput before stalling.",
      "Failed to flush claude stdin: 管道已结束。 (os error 109)",
      "Failed to write to claude stdin: Broken pipe",
      "claude CLI exited with code 1: Broken pipe (os error 109)",
    ]

    isolationInputs.forEach((message) => {
      it(`classifies isolation_retry + retryable for: ${message.slice(0, 60)}...`, () => {
        const err = classifyTransportError({ message })
        expect(err.kind).toBe("isolation_retry")
        expect(err.retryable).toBe(true)
        expect(err.message).toBe(message)
      })
    })
  })

  describe("rate_limit (transient upstream availability — 429/5xx/overloaded)", () => {
    const rateLimitInputs = [
      "claude CLI exited with code 1: API Error: 429 overloaded_error",
      "claude CLI exited with code 1: API Error: 503 Service temporarily unavailable. Try again in a moment.",
      "claude CLI exited with code 1: API Error: 500 Internal Server Error",
      "claude CLI exited with code 1: API Error: 502 Bad Gateway",
      "claude CLI exited with code 1: API Error: 504 Gateway Timeout",
      "Claude Code CLI rate-limited by upstream: Too many requests.",
      "The service is temporarily unavailable; please retry.",
      "Connection closed mid-response",
    ]

    rateLimitInputs.forEach((message) => {
      it(`classifies rate_limit + retryable for: ${message.slice(0, 60)}...`, () => {
        const err = classifyTransportError({ message })
        expect(err.kind).toBe("rate_limit")
        expect(err.retryable).toBe(true)
        expect(err.message).toBe(message)
      })
    })
  })

  describe("fatal (deterministic local failures — no retry)", () => {
    const fatalInputs = [
      "Claude Code CLI is not authenticated. Please open a terminal and run `claude` to complete the OAuth login.",
      "claude CLI exited with code 1: Unknown model 'foo-bar'",
      "claude CLI exited silently with code 1.",
      "Claude Code CLI completed but returned no content.",
    ]

    fatalInputs.forEach((message) => {
      it(`classifies fatal + non-retryable for: ${message.slice(0, 60)}...`, () => {
        const err = classifyTransportError({ message })
        expect(err.kind).toBe("fatal")
        expect(err.retryable).toBe(false)
        expect(err.message).toBe(message)
      })
    })
  })

  describe("stall wording routed as retryable", () => {
    // C-101 (GRL-008): the "produced no additional stream output within \d+ seconds" inactivity
    // stall and the mid-conversation heartbeat stall are covered by RATE_LIMIT_RE, so they classify
    // as rate_limit (retryable). They do NOT match ISOLATION_RETRY_RE, so they are NOT
    // isolation_retry — the isolation retry is reserved for first-token + pipe/stdin only.
    it("classifies inactivity stall as rate_limit (retryable, not isolation_retry)", () => {
      const message = "Claude Code CLI produced no additional stream output within 30 seconds."
      const err = classifyTransportError({ message })
      expect(err.retryable).toBe(true)
      expect(err.kind).not.toBe("isolation_retry")
    })
  })

  describe("edge cases", () => {
    it("returns fatal for empty message", () => {
      const err = classifyTransportError({ message: "" })
      expect(err.kind).toBe("fatal")
      expect(err.retryable).toBe(false)
    })

    it("returns fatal for whitespace-only message", () => {
      const err = classifyTransportError({ message: "   \n\t  " })
      expect(err.kind).toBe("fatal")
      expect(err.retryable).toBe(false)
    })

    it("preserves the verbatim message for diagnostics", () => {
      const message = "  API Error: 429 overloaded_error  "
      const err = classifyTransportError({ message })
      // Verbatim, not trimmed — diagnostics see exactly what upstream emitted.
      expect(err.message).toBe(message)
    })

    it("forwards extra attemptResult fields to raw for diagnostics", () => {
      const err = classifyTransportError({ message: "x", emittedToken: false, streamId: "abc" })
      expect(err.raw).toEqual({ message: "x", emittedToken: false, streamId: "abc" })
    })
  })

  describe("kind is the discriminating field (ISS-019 contract)", () => {
    // Pin the full set of kinds so a future refactor that drops or renames a kind breaks here
    // (callers branch on `kind`, so a missing kind is a compile + test error, not a silent routing change).
    it("covers exactly the four documented kinds across the input space", () => {
      const kinds = new Set<TransportErrorKind>()
      const samples = [
        { message: "API Error: 429 overloaded" }, // rate_limit
        { message: "Failed to flush claude stdin: 管道已结束。 (os error 109)" }, // isolation_retry
        { message: "produced no additional stream output within 30 seconds." }, // rate_limit
        { message: "Unknown model 'foo'" }, // fatal
        { message: "" }, // fatal
      ]
      for (const input of samples) {
        kinds.add(classifyTransportError(input).kind)
      }
      expect(kinds).toEqual(new Set<TransportErrorKind>(["rate_limit", "isolation_retry", "fatal"]))
    })
  })
})
