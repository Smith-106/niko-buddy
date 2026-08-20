/**
 * checkpoint-digest.ts
 *
 * SHA-256 idempotent checkpoint digests for the QMAI control / mechanical layer.
 *
 * ADR-19 (mechanical layer, zero LLM): this module is pure cryptography. It
 * performs no model inference, no network IO, and no LLM calls. Given the same
 * normalized input it always produces the same digest — the property that lets
 * consumers use the digest as an idempotency key. Concrete callers:
 *   - T08 stage-output journal artifacts (instruction-digest-keyed caching, so a
 *     crashed run can resume by hitting an already-computed artifact instead of
 *     re-invoking the LLM).
 *   - T15 canon-pending replay queue (each pending write keyed by its digest,
 *     deduplicated + replayed in order after a restart).
 *
 * @license MIT © QMAI
 */

const HEX_DIGITS = "0123456789abcdef"

/** Lowercase hex of a SHA-256 ArrayBuffer (32 bytes → 64 chars). */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    hex += HEX_DIGITS[b >> 4] + HEX_DIGITS[b & 0x0f]
  }
  return hex
}

/**
 * Deterministic canonical JSON stringification.
 *
 * Produces a byte-stable string for any JSON-compatible value so that two
 * semantically-equal objects (different key insertion order, same payload)
 * serialize identically and therefore hash to the same digest.
 *
 *  - Object keys are sorted recursively; insertion order is ignored.
 *  - Array element order is preserved.
 *  - `undefined` object keys are dropped (JSON.stringify semantics); `undefined`
 *    array / top-level elements become `null`.
 *  - `NaN` / `Infinity` / `-Infinity` are emitted as explicit literal tokens
 *    instead of the non-deterministic `JSON.stringify` output (`"null"`).
 *  - `bigint` is emitted as a trailing-`n` decimal literal.
 *
 * Values that are neither JSON-compatible data nor primitives (functions,
 * symbols) fall back to their `String()` form so stringification never throws.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null"
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "number":
      if (Number.isNaN(value)) return "NaN"
      if (value === Infinity) return "Infinity"
      if (value === -Infinity) return "-Infinity"
      return String(value)
    case "boolean":
      return value ? "true" : "false"
    case "bigint":
      return `${value}n`
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => stableStringify(v)).join(",") + "]"
      }
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      const entries = keys
        .filter((k) => obj[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      return "{" + entries.join(",") + "}"
    }
    default:
      // function / symbol / unknown — best-effort deterministic text
      return JSON.stringify(String(value))
  }
}

/**
 * Compute the SHA-256 hex digest of an already-normalized string input.
 *
 * Pure crypto (ADR-19): no LLM, no IO. The same input always yields the same
 * 64-character lowercase hex digest.
 */
export async function computeCheckpointDigest(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  return bufferToHex(hashBuffer)
}

/**
 * Convenience: normalize any JSON-compatible value with `stableStringify` and
 * return its SHA-256 hex digest. Two semantically-equal values (regardless of
 * key order) produce the same digest — this is the idempotency-key primitive
 * used by checkpoint callers.
 */
export async function computeCheckpointDigestOf(value: unknown): Promise<string> {
  return computeCheckpointDigest(stableStringify(value))
}
