/**
 * checkpoint-digest.spec.ts
 *
 * T07 acceptance: SHA-256 idempotent checkpoint digest.
 *  - same input ⇒ same digest (idempotency key invariant)
 *  - different input ⇒ different digest
 *  - stable key-order normalization ⇒ equal semantic objects produce equal
 *    digests regardless of key insertion order
 *
 * Mechanical layer, zero LLM (ADR-19): every assertion here exercises only
 * pure crypto — no model call is touched.
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  computeCheckpointDigest,
  computeCheckpointDigestOf,
  stableStringify,
} from "./checkpoint-digest"

// Well-known FIPS 180-2 SHA-256 test vectors.
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("computeCheckpointDigest", () => {
  it("matches known SHA-256 test vectors", async () => {
    expect(await computeCheckpointDigest("")).toBe(SHA256_EMPTY)
    expect(await computeCheckpointDigest("abc")).toBe(SHA256_ABC)
  })

  it("is idempotent: same input yields the same digest", async () => {
    const a = await computeCheckpointDigest("checkpoint:stage-3:ok")
    const b = await computeCheckpointDigest("checkpoint:stage-3:ok")
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is deterministic across repeated calls on varied inputs", async () => {
    const inputs = ["", "abc", "中文输入", JSON.stringify({ b: 1, a: 2 })]
    for (const input of inputs) {
      const d1 = await computeCheckpointDigest(input)
      const d2 = await computeCheckpointDigest(input)
      expect(d1).toBe(d2)
    }
  })

  it("different inputs yield different digests", async () => {
    const d1 = await computeCheckpointDigest("stage:1")
    const d2 = await computeCheckpointDigest("stage:2")
    expect(d1).not.toBe(d2)
  })
})

describe("stableStringify", () => {
  it("sorts object keys recursively for stable output", () => {
    const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })
    const b = stableStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 })
    expect(a).toBe(b)
  })

  it("preserves array element order", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]")
    expect(stableStringify([3, 2, 1])).not.toBe(stableStringify([1, 2, 3]))
  })

  it("drops undefined object keys (JSON.stringify semantics)", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it("emits null for undefined array / top-level elements", () => {
    expect(stableStringify([undefined, 1])).toBe("[null,1]")
    expect(stableStringify(undefined)).toBe("null")
  })

  it("handles special numbers deterministically", () => {
    expect(stableStringify(NaN)).toBe("NaN")
    expect(stableStringify(Infinity)).toBe("Infinity")
    expect(stableStringify(-Infinity)).toBe("-Infinity")
    expect(stableStringify(1.5)).toBe("1.5")
  })

  it("handles scalars, bigint, and null", () => {
    expect(stableStringify("x")).toBe('"x"')
    expect(stableStringify(true)).toBe("true")
    expect(stableStringify(false)).toBe("false")
    expect(stableStringify(null)).toBe("null")
    expect(stableStringify(42n)).toBe("42n")
  })

  it("escapes strings deterministically", () => {
    expect(stableStringify('a"b')).toBe('"a\\"b"')
  })

  it("falls back to String() for functions and symbols without throwing", () => {
    const fn = function foo() {
      return 1
    }
    expect(() => stableStringify(fn)).not.toThrow()
    expect(() => stableStringify(Symbol("x"))).not.toThrow()
  })
})

describe("computeCheckpointDigestOf", () => {
  it("same semantic object yields same digest regardless of key order", async () => {
    const d1 = await computeCheckpointDigestOf({ b: 1, a: 2 })
    const d2 = await computeCheckpointDigestOf({ a: 2, b: 1 })
    expect(d1).toBe(d2)
  })

  it("different objects yield different digests", async () => {
    const d1 = await computeCheckpointDigestOf({ a: 1 })
    const d2 = await computeCheckpointDigestOf({ a: 2 })
    expect(d1).not.toBe(d2)
  })

  it("round-trips through stableStringify + computeCheckpointDigest", async () => {
    const value = { x: [1, 2, { y: "z" }] }
    expect(await computeCheckpointDigestOf(value)).toBe(
      await computeCheckpointDigest(stableStringify(value)),
    )
  })

  it("normalizes nested structures before hashing", async () => {
    const normal = await computeCheckpointDigestOf({ a: { c: 3, b: [1, 2] } })
    const reordered = await computeCheckpointDigestOf({ a: { b: [1, 2], c: 3 } })
    expect(normal).toBe(reordered)
  })
})
