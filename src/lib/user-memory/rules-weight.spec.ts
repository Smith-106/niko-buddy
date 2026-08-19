import { describe, expect, it } from "vitest"
import {
  buildDeAiWeightsFromPreferences,
  applyUserWeightsToRules,
  buildUserAwareDeAiPrompt,
  mapPreferenceToDeAiCategory,
  getAvoidWords,
  hasUserDeAiWeights,
} from "./rules-weight"
import { createDefaultStore, createPreference } from "./types"
import type { UserMemoryStore, DeAiWeights } from "./types"
import {
  DE_AI_STRUCTURED_RULES,
  filterRulesBySeverity,
} from "../novel/de-ai-rules"
import type { DeAiStructuredRule, DeAiSeverity } from "../novel/de-ai-rules"

function makeStoreWithPrefs(prefs: Array<{ key: string; value: string; category?: string }>): UserMemoryStore {
  const store = createDefaultStore()
  for (const p of prefs) {
    store.preferences.push(
      createPreference({ key: p.key, value: p.value, category: (p.category ?? "custom") as never }),
    )
  }
  return store
}

describe("user-memory/rules-weight", () => {
  describe("buildDeAiWeightsFromPreferences", () => {
    it("extracts category boosts from deai_boost: keys", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_boost:词汇", value: "2.0", category: "vocabulary" },
        { key: "deai_boost:节奏", value: "1.5", category: "pacing" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.categoryBoosts["词汇"]).toBe(2.0)
      expect(weights.categoryBoosts["节奏"]).toBe(1.5)
    })

    it("extracts severity threshold from deai_threshold key", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_threshold", value: "high", category: "custom" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.severityThreshold).toBe("high")
    })

    it("accepts all valid severity levels", () => {
      for (const level of ["critical", "high", "medium", "low"] as const) {
        const store = makeStoreWithPrefs([
          { key: "deai_threshold", value: level, category: "custom" },
        ])
        const weights = buildDeAiWeightsFromPreferences(store)
        expect(weights.severityThreshold).toBe(level)
      }
    })

    it("ignores invalid severity threshold values", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_threshold", value: "invalid", category: "custom" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.severityThreshold).toBe("medium") // default
    })

    it("extracts genre pacing overrides", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_pacing:玄幻", value: "slow" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.genreOverrides["玄幻"]?.pacing).toBe("slow")
    })

    it("extracts genre dialogue overrides", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_dialogue:都市", value: "weak" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.genreOverrides["都市"]?.dialogue).toBe("weak")
    })

    it("extracts genre introspection overrides", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_introspection:历史", value: "trim" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.genreOverrides["历史"]?.introspection).toBe("trim")
    })

    it("merges multiple genre overrides for same genre", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_pacing:玄幻", value: "slow" },
        { key: "genre_dialogue:玄幻", value: "strong" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.genreOverrides["玄幻"]?.pacing).toBe("slow")
      expect(weights.genreOverrides["玄幻"]?.dialogue).toBe("strong")
    })

    it("ignores invalid genre override values", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_pacing:玄幻", value: "invalid" },
        { key: "genre_dialogue:都市", value: "invalid" },
        { key: "genre_introspection:历史", value: "invalid" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.genreOverrides["玄幻"]?.pacing).toBeUndefined()
      expect(weights.genreOverrides["都市"]?.dialogue).toBeUndefined()
      expect(weights.genreOverrides["历史"]?.introspection).toBeUndefined()
    })

    it("ignores non-numeric boost values", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_boost:词汇", value: "not_a_number" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.categoryBoosts["词汇"]).toBeUndefined()
    })

    it("ignores negative boost values", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_boost:词汇", value: "-1.0" },
      ])
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.categoryBoosts["词汇"]).toBeUndefined()
    })

    it("returns defaults for empty store", () => {
      const store = createDefaultStore()
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.categoryBoosts).toEqual({})
      expect(weights.severityThreshold).toBe("medium")
      expect(weights.genreOverrides).toEqual({})
    })

    it("uses store.deAiWeights.severityThreshold as fallback", () => {
      const store = createDefaultStore()
      store.deAiWeights.severityThreshold = "high"
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.severityThreshold).toBe("high")
    })

    it("falls back to medium when store severityThreshold is undefined", () => {
      const store = createDefaultStore()
      store.deAiWeights.severityThreshold = undefined
      const weights = buildDeAiWeightsFromPreferences(store)
      expect(weights.severityThreshold).toBe("medium")
    })
  })

  describe("applyUserWeightsToRules", () => {
    it("filters by severity and returns rules unchanged when no boosts", () => {
      const weights: DeAiWeights = {
        categoryBoosts: {},
        severityThreshold: "high" as DeAiSeverity,
        genreOverrides: {},
      }
      const result = applyUserWeightsToRules(DE_AI_STRUCTURED_RULES, weights)
      const expected = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, "high")
      expect(result).toEqual(expected)
    })

    it("duplicates rules with boost > 1", () => {
      const weights: DeAiWeights = {
        categoryBoosts: { "词汇": 2.0 },
        severityThreshold: "medium" as DeAiSeverity,
        genreOverrides: {},
      }
      const result = applyUserWeightsToRules(DE_AI_STRUCTURED_RULES, weights)
      // 词汇 has 4 rules at medium+ → each duplicated → 8
      const vocabRules = result.filter((r) => r.category === "词汇")
      const baseVocabRules = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, "medium")
        .filter((r) => r.category === "词汇")
      expect(vocabRules).toHaveLength(baseVocabRules.length * 2)
    })

    it("boost of 1.0 does not duplicate", () => {
      const weights: DeAiWeights = {
        categoryBoosts: { "词汇": 1.0 },
        severityThreshold: "medium" as DeAiSeverity,
        genreOverrides: {},
      }
      const result = applyUserWeightsToRules(DE_AI_STRUCTURED_RULES, weights)
      const vocabRules = result.filter((r) => r.category === "词汇")
      const baseVocabRules = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, "medium")
        .filter((r) => r.category === "词汇")
      expect(vocabRules).toHaveLength(baseVocabRules.length)
    })

    it("boost of 0.5 rounds to 1 (minimum)", () => {
      const weights: DeAiWeights = {
        categoryBoosts: { "词汇": 0.5 },
        severityThreshold: "medium" as DeAiSeverity,
        genreOverrides: {},
      }
      const result = applyUserWeightsToRules(DE_AI_STRUCTURED_RULES, weights)
      const vocabRules = result.filter((r) => r.category === "词汇")
      const baseVocabRules = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, "medium")
        .filter((r) => r.category === "词汇")
      expect(vocabRules).toHaveLength(baseVocabRules.length)
    })
  })

  describe("buildUserAwareDeAiPrompt", () => {
    it("returns a prompt string containing rule categories", () => {
      const store = createDefaultStore()
      const prompt = buildUserAwareDeAiPrompt(store)
      expect(prompt).toContain("去 AI 味")
      expect(prompt).toContain("规则矩阵")
    })

    it("returns a prompt string containing user-weighted rules", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_boost:词汇", value: "2.0", category: "vocabulary" },
      ])
      const prompt = buildUserAwareDeAiPrompt(store)
      expect(prompt).toContain("用户个性化")
      expect(prompt).toContain("词汇")
    })

    it("falls back to standard prompt when no user weights", () => {
      const store = createDefaultStore()
      const prompt = buildUserAwareDeAiPrompt(store)
      // should not have "用户个性化" header
      expect(prompt).not.toContain("用户个性化")
    })

    it("includes genre baseline when genre provided", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_boost:词汇", value: "2.0", category: "vocabulary" },
      ])
      const prompt = buildUserAwareDeAiPrompt(store, "玄幻")
      expect(prompt).toContain("玄幻")
    })

    it("includes genre baseline from getGenreBaseline for standard prompt", () => {
      const store = createDefaultStore()
      const prompt = buildUserAwareDeAiPrompt(store, "玄幻")
      expect(prompt).toContain("玄幻")
    })

    it("applies genre overrides from user preferences", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_pacing:玄幻", value: "slow" },
      ])
      const prompt = buildUserAwareDeAiPrompt(store, "玄幻")
      expect(prompt).toContain("用户个性化")
      expect(prompt).toContain("slow")
    })

    it("works with unknown genre (no baseline)", () => {
      const store = createDefaultStore()
      const prompt = buildUserAwareDeAiPrompt(store, "unknown_genre")
      expect(prompt).not.toContain("流派基线")
    })

    it("includes user avoid words section when present", () => {
      const store = makeStoreWithPrefs([
        { key: "avoid_words", value: "仿佛、不禁", category: "vocabulary" },
      ])
      const prompt = buildUserAwareDeAiPrompt(store)
      expect(prompt).toContain("用户避用词")
      expect(prompt).toContain("仿佛、不禁")
    })

    it("omits avoid words section when none present", () => {
      const store = createDefaultStore()
      const prompt = buildUserAwareDeAiPrompt(store)
      expect(prompt).not.toContain("用户避用词")
    })
  })

  describe("getAvoidWords", () => {
    it("returns empty for no vocabulary prefs", () => {
      const store = createDefaultStore()
      expect(getAvoidWords(store)).toEqual([])
    })

    it("aggregates avoid_words prefs, splitting on separators", () => {
      const store = makeStoreWithPrefs([
        { key: "avoid_words", value: "仿佛、不禁、顿时", category: "vocabulary" },
        { key: "avoid_words:2", value: "微微一笑，嘴角上扬", category: "vocabulary" },
      ])
      expect(getAvoidWords(store)).toEqual(["仿佛", "不禁", "顿时", "微微一笑", "嘴角上扬"])
    })

    it("dedupes and filters empty tokens", () => {
      const store = makeStoreWithPrefs([
        { key: "avoid_words", value: "仿佛, 仿佛, ,，", category: "vocabulary" },
      ])
      expect(getAvoidWords(store)).toEqual(["仿佛"])
    })

    it("ignores non-vocabulary prefs", () => {
      const store = makeStoreWithPrefs([
        { key: "dim:plot", value: "0.3", category: "review" },
        { key: "avoid_words", value: "仿佛", category: "vocabulary" },
      ])
      expect(getAvoidWords(store)).toEqual(["仿佛"])
    })
  })

  describe("hasUserDeAiWeights", () => {
    it("false for empty store", () => {
      expect(hasUserDeAiWeights(createDefaultStore())).toBe(false)
    })

    it("true for category boost", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_boost:词汇", value: "2.0", category: "vocabulary" },
      ])
      expect(hasUserDeAiWeights(store)).toBe(true)
    })

    it("true for severity threshold", () => {
      const store = makeStoreWithPrefs([
        { key: "deai_threshold", value: "high", category: "vocabulary" },
      ])
      expect(hasUserDeAiWeights(store)).toBe(true)
    })

    it("true for genre override", () => {
      const store = makeStoreWithPrefs([
        { key: "genre_pacing:玄幻", value: "slow", category: "vocabulary" },
      ])
      expect(hasUserDeAiWeights(store)).toBe(true)
    })

    it("true for avoid words only", () => {
      const store = makeStoreWithPrefs([
        { key: "avoid_words", value: "仿佛", category: "vocabulary" },
      ])
      expect(hasUserDeAiWeights(store)).toBe(true)
    })
  })

  describe("mapPreferenceToDeAiCategory", () => {
    it("maps vocabulary to 词汇", () => {
      expect(mapPreferenceToDeAiCategory("vocabulary")).toContain("词汇")
    })

    it("maps style to 句式 and 叙事", () => {
      const result = mapPreferenceToDeAiCategory("style")
      expect(result).toContain("句式")
      expect(result).toContain("叙事")
    })

    it("maps pacing to 节奏", () => {
      expect(mapPreferenceToDeAiCategory("pacing")).toEqual(["节奏"])
    })

    it("maps dialogue to 对白", () => {
      expect(mapPreferenceToDeAiCategory("dialogue")).toEqual(["对白"])
    })

    it("maps description to 心理 and 场景", () => {
      const result = mapPreferenceToDeAiCategory("description")
      expect(result).toContain("心理")
      expect(result).toContain("场景")
    })

    it("returns empty for review category", () => {
      expect(mapPreferenceToDeAiCategory("review")).toEqual([])
    })

    it("returns empty for custom category", () => {
      expect(mapPreferenceToDeAiCategory("custom")).toEqual([])
    })
  })
})