import { describe, expect, it } from "vitest"
import {
  calibrateReviewFromPreferences,
  buildReviewScoringOptions,
  getEffectiveDimensionWeights,
  getEffectiveSeverityDeductions,
} from "./injector"
import { createDefaultStore, createPreference } from "./types"
import type { UserMemoryStore } from "./types"
import {
  CALIBRATED_DIMENSION_WEIGHTS,
  CALIBRATED_SEVERITY_DEDUCTION,
} from "../novel/review-scoring"

function makeStoreWithReviewPrefs(prefs: Array<{ key: string; value: string }>): UserMemoryStore {
  const store = createDefaultStore()
  for (const p of prefs) {
    store.preferences.push(
      createPreference({ key: p.key, value: p.value, category: "review" }),
    )
  }
  return store
}

describe("user-memory/injector", () => {
  describe("calibrateReviewFromPreferences", () => {
    it("extracts dimension weights from review preferences", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "dim:plot", value: "0.30" },
        { key: "dim:facts", value: "0.40" },
      ])
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.dimensionWeights.plot).toBe(0.30)
      expect(cal.dimensionWeights.facts).toBe(0.40)
      expect(cal.severityDeductions).toEqual({})
    })

    it("extracts severity deductions from review preferences", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "sev:error", value: "30" },
        { key: "sev:warning", value: "15" },
      ])
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.severityDeductions.error).toBe(30)
      expect(cal.severityDeductions.warning).toBe(15)
      expect(cal.dimensionWeights).toEqual({})
    })

    it("ignores invalid dimension keys", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "dim:invalid_dim", value: "0.99" },
        { key: "dim:plot", value: "0.25" },
      ])
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.dimensionWeights.invalid_dim).toBeUndefined()
      expect(cal.dimensionWeights.plot).toBe(0.25)
    })

    it("ignores invalid severity keys", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "sev:invalid_sev", value: "99" },
        { key: "sev:error", value: "30" },
      ])
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.severityDeductions.invalid_sev).toBeUndefined()
      expect(cal.severityDeductions.error).toBe(30)
    })

    it("ignores non-numeric values", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "dim:plot", value: "not_a_number" },
      ])
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.dimensionWeights.plot).toBeUndefined()
    })

    it("ignores negative values", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "dim:plot", value: "-0.5" },
      ])
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.dimensionWeights.plot).toBeUndefined()
    })

    it("returns empty calibration for empty store", () => {
      const store = createDefaultStore()
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.dimensionWeights).toEqual({})
      expect(cal.severityDeductions).toEqual({})
    })

    it("only processes review-category preferences", () => {
      const store = createDefaultStore()
      store.preferences.push(
        createPreference({ key: "dim:plot", value: "0.5", category: "vocabulary" }),
      )
      const cal = calibrateReviewFromPreferences(store)
      expect(cal.dimensionWeights.plot).toBeUndefined()
    })
  })

  describe("buildReviewScoringOptions", () => {
    it("returns options with user dimension weights merged over calibrated defaults", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "dim:plot", value: "0.50" },
      ])
      const opts = buildReviewScoringOptions(store)
      expect(opts.dimensionWeights).toBeDefined()
      expect(opts.dimensionWeights!.plot).toBe(0.50)
      // other dimensions keep calibrated defaults
      expect(opts.dimensionWeights!.facts).toBe(CALIBRATED_DIMENSION_WEIGHTS.facts)
      expect(opts.enableAntiHallucination).toBe(true)
    })

    it("returns options with user severity deductions merged over calibrated defaults", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "sev:error", value: "50" },
      ])
      const opts = buildReviewScoringOptions(store)
      expect(opts.severityDeductions).toBeDefined()
      expect(opts.severityDeductions!.error).toBe(50)
      expect(opts.severityDeductions!.warning).toBe(CALIBRATED_SEVERITY_DEDUCTION.warning)
    })

    it("returns undefined weights when no user overrides", () => {
      const store = createDefaultStore()
      const opts = buildReviewScoringOptions(store)
      expect(opts.dimensionWeights).toBeUndefined()
      expect(opts.severityDeductions).toBeUndefined()
      expect(opts.enableAntiHallucination).toBe(true)
    })
  })

  describe("getEffectiveDimensionWeights", () => {
    it("returns calibrated defaults when no user overrides", () => {
      const store = createDefaultStore()
      const weights = getEffectiveDimensionWeights(store)
      expect(weights).toEqual(CALIBRATED_DIMENSION_WEIGHTS)
    })

    it("merges user overrides over calibrated defaults", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "dim:plot", value: "0.50" },
      ])
      const weights = getEffectiveDimensionWeights(store)
      expect(weights.plot).toBe(0.50)
      expect(weights.facts).toBe(CALIBRATED_DIMENSION_WEIGHTS.facts)
    })
  })

  describe("getEffectiveSeverityDeductions", () => {
    it("returns calibrated defaults when no user overrides", () => {
      const store = createDefaultStore()
      const ded = getEffectiveSeverityDeductions(store)
      expect(ded).toEqual(CALIBRATED_SEVERITY_DEDUCTION)
    })

    it("merges user overrides over calibrated defaults", () => {
      const store = makeStoreWithReviewPrefs([
        { key: "sev:error", value: "50" },
      ])
      const ded = getEffectiveSeverityDeductions(store)
      expect(ded.error).toBe(50)
      expect(ded.warning).toBe(CALIBRATED_SEVERITY_DEDUCTION.warning)
    })
  })

  it("CALIBRATED_DIMENSION_WEIGHTS has 6 dimensions", () => {
    expect(Object.keys(CALIBRATED_DIMENSION_WEIGHTS)).toHaveLength(6)
  })

  it("CALIBRATED_SEVERITY_DEDUCTION has 3 levels", () => {
    expect(Object.keys(CALIBRATED_SEVERITY_DEDUCTION)).toHaveLength(3)
  })
})