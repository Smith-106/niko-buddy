/**
 * eval-schema.spec.ts — F1 G1 骨架：zod 契约校验。
 */
import { describe, it, expect } from "vitest"
import {
  evalCaseSchema,
  evalRunConfigSchema,
  evalManifestSchema,
  rejectionSignalSchema,
} from "./eval-schema"

describe("eval-schema", () => {
  it("accepts a valid synthetic EvalCase", () => {
    const parsed = evalCaseSchema.safeParse({
      id: "synth-canon_retrieval-0",
      chapter: 1,
      query: "白砚 持有",
      goldChunks: [{
        id: "g-0",
        subject: "白砚",
        predicate: "持有",
        object: "轩辕剑",
        tier: "protected",
        expectedLayer: "protected",
      }],
      poisonChunks: [],
      expectedLayer: "protected",
      source: "synthetic",
    })
    expect(parsed.success).toBe(true)
  })

  it("defaults source to synthetic (C7)", () => {
    const parsed = evalCaseSchema.safeParse({
      id: "x",
      chapter: 1,
      query: "q",
      goldChunks: [],
      poisonChunks: [],
      expectedLayer: "excluded",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.source).toBe("synthetic")
  })

  it("rejects invalid poisonType", () => {
    const parsed = evalCaseSchema.safeParse({
      id: "x",
      chapter: 1,
      query: "q",
      goldChunks: [],
      poisonChunks: [{ id: "p", subject: "s", predicate: "p", object: "o", poisonType: "bogus", expectedLanding: "excluded" }],
      expectedLayer: "excluded",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects non-positive chapter", () => {
    const parsed = evalCaseSchema.safeParse({
      id: "x",
      chapter: 0,
      query: "q",
      goldChunks: [],
      poisonChunks: [],
      expectedLayer: "excluded",
    })
    expect(parsed.success).toBe(false)
  })

  it("evalRunConfig defaults replayOnlyFailed=true (C9) and thresholds", () => {
    const parsed = evalRunConfigSchema.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.replayOnlyFailed).toBe(true)
      expect(parsed.data.thresholds.l1Min).toBe(0.95)
      expect(parsed.data.thresholds.l2Min).toBe(0.99)
      expect(parsed.data.thresholds.l3Max).toBe(0.01)
    }
  })

  it("rejectionSignal requires negation_active (C10)", () => {
    const parsed = rejectionSignalSchema.safeParse({ reason: "x", negation_active: true })
    expect(parsed.success).toBe(true)
    const missing = rejectionSignalSchema.safeParse({ reason: "x" })
    expect(missing.success).toBe(false)
  })

  it("evalManifest validates fixture contract", () => {
    const parsed = evalManifestSchema.safeParse({
      version: "1.0.0",
      generatedAt: "2026-08-23T00:00:00.000Z",
      totalCases: 200,
      holdoutRatio: 0.15,
      scenarios: ["canon_retrieval"],
      source: "synthetic",
    })
    expect(parsed.success).toBe(true)
  })
})
