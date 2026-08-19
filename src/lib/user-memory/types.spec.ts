import { describe, expect, it } from "vitest"
import {
  createDefaultStore,
  createPreference,
  PREFERENCE_CATEGORIES,
  USER_MEMORY_SCHEMA_VERSION,
} from "./types"
import type { UserMemoryStore, DeAiWeights, ReviewCalibration } from "./types"

describe("user-memory/types", () => {
  it("createDefaultStore returns a valid empty store", () => {
    const store = createDefaultStore()
    expect(store.version).toBe(USER_MEMORY_SCHEMA_VERSION)
    expect(store.preferences).toEqual([])
    expect(store.deAiWeights).toEqual({
      categoryBoosts: {},
      severityThreshold: "medium",
      genreOverrides: {},
    })
    expect(store.reviewCalibration).toEqual({
      dimensionWeights: {},
      severityDeductions: {},
    })
    expect(store.updatedAt).toBeTruthy()
    expect(new Date(store.updatedAt).getTime()).toBeGreaterThan(0)
  })

  it("createPreference creates a valid preference with id and timestamps", () => {
    const pref = createPreference({
      key: "avoid_words",
      value: "简洁",
      category: "vocabulary",
    })
    expect(pref.id).toMatch(/^upref-/)
    expect(pref.key).toBe("avoid_words")
    expect(pref.value).toBe("简洁")
    expect(pref.category).toBe("vocabulary")
    expect(pref.label).toBeUndefined()
    expect(pref.createdAt).toBeTruthy()
    expect(pref.updatedAt).toBeTruthy()
    expect(pref.createdAt).toBe(pref.updatedAt)
  })

  it("createPreference with label", () => {
    const pref = createPreference({
      key: "style_tendency",
      value: "简洁",
      category: "style",
      label: "风格倾向",
    })
    expect(pref.label).toBe("风格倾向")
  })

  it("PREFERENCE_CATEGORIES contains all expected categories", () => {
    expect(PREFERENCE_CATEGORIES).toContain("vocabulary")
    expect(PREFERENCE_CATEGORIES).toContain("style")
    expect(PREFERENCE_CATEGORIES).toContain("pacing")
    expect(PREFERENCE_CATEGORIES).toContain("dialogue")
    expect(PREFERENCE_CATEGORIES).toContain("description")
    expect(PREFERENCE_CATEGORIES).toContain("review")
    expect(PREFERENCE_CATEGORIES).toContain("custom")
    expect(PREFERENCE_CATEGORIES).toHaveLength(7)
  })

  it("createDefaultStore creates independent instances", () => {
    const s1 = createDefaultStore()
    const s2 = createDefaultStore()
    s1.preferences.push({ id: "test", key: "k", value: "v", category: "custom", createdAt: "t", updatedAt: "t" })
    expect(s2.preferences).toHaveLength(0)
  })

  it("DeAiWeights type shape is constructable", () => {
    const w: DeAiWeights = {
      categoryBoosts: { "词汇": 2.0 },
      severityThreshold: "high",
      genreOverrides: { "玄幻": { pacing: "slow" } },
    }
    expect(w.categoryBoosts["词汇"]).toBe(2.0)
    expect(w.severityThreshold).toBe("high")
    expect(w.genreOverrides["玄幻"]!.pacing).toBe("slow")
  })

  it("ReviewCalibration type shape is constructable", () => {
    const cal: ReviewCalibration = {
      dimensionWeights: { plot: 0.3, facts: 0.4 },
      severityDeductions: { error: 30 },
    }
    expect(cal.dimensionWeights.plot).toBe(0.3)
    expect(cal.severityDeductions.error).toBe(30)
  })

  it("UserMemoryStore satisfies the full type", () => {
    const store: UserMemoryStore = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "k1", value: "v1", category: "custom" }),
    )
    expect(store.preferences).toHaveLength(1)
    expect(store.preferences[0]!.key).toBe("k1")
  })
})