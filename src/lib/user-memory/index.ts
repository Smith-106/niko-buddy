/**
 * Wave 1 用户记忆系统 — canonical 公共出口
 *
 * 主链消费方（novel-review-action-items / deep-chapter-prompts / UI）只从本文件导入，
 * 不直接读存储（路线图耦合治理规则：injector/session 是唯一公共契约）。
 */

export {
  PREFERENCE_CATEGORIES,
  USER_MEMORY_SCHEMA_VERSION,
  createDefaultStore,
  createPreference,
  type UserPreference,
  type PreferenceCategory,
  type UserMemoryStore,
  type DeAiWeights,
  type GenreOverrideFields,
  type ReviewCalibration,
} from "./types"
export {
  loadUserMemory,
  saveUserMemory,
  addPreference,
  updatePreference,
  deletePreference,
  getPreferences,
  findPreferenceByKey,
  getDefaultUserMemoryPath,
} from "./store"
export {
  calibrateReviewFromPreferences,
  buildReviewScoringOptions,
  getEffectiveDimensionWeights,
  getEffectiveSeverityDeductions,
} from "./injector"
export {
  buildDeAiWeightsFromPreferences,
  applyUserWeightsToRules,
  buildUserAwareDeAiPrompt,
  hasUserDeAiWeights,
  getAvoidWords,
  mapPreferenceToDeAiCategory,
} from "./rules-weight"
export {
  getUserMemoryStore,
  loadUserMemoryForProject,
  saveUserMemoryForProject,
  invalidateUserMemoryCache,
  listPreferences,
  addPreferenceForProject,
  updatePreferenceForProject,
  deletePreferenceForProject,
  ensureUserMemoryFile,
} from "./session"
