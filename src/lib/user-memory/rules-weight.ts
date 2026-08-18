/**
 * Wave 1 用户记忆系统 — de-ai 规则权重
 *
 * 将用户偏好映射到 de-ai 结构化规则的权重调整：
 *   - 类别增强：用户偏好某类别 → 该类规则在 prompt 中加强
 *   - 严重度阈值：用户可调整最低注入严重度
 *   - 流派覆盖：用户可覆盖流派基线（节奏/对白/心理描写）
 *
 * 集成点：`filterRulesBySeverity()` + `buildStructuredDeAiRules()`。
 */

import type { UserMemoryStore, DeAiWeights } from "./types"
import type { DeAiSeverity, DeAiStructuredRule } from "../novel/de-ai-rules"
import {
  DE_AI_STRUCTURED_RULES,
  DE_AI_CATEGORIES as _DE_AI_CATEGORIES,
  filterRulesBySeverity,
  getGenreBaseline,
  buildStructuredDeAiRules,
} from "../novel/de-ai-rules"
import { getPreferences } from "./store"

/** de-ai 类别 → 偏好分类映射 */
const CATEGORY_TO_PREFERENCE: Record<string, string> = {
  "词汇": "vocabulary",
  "句式": "style",
  "叙事": "style",
  "对白": "dialogue",
  "心理": "description",
  "场景": "description",
  "节奏": "pacing",
}

/**
 * 从用户偏好构建 de-ai 规则权重。
 *
 * 偏好 key 约定：
 *   - `deai_boost:<category>` → 类别增强系数（e.g. `deai_boost:词汇` → 2.0）
 *   - `deai_threshold`           → 严重度阈值（e.g. `high`）
 *   - `genre_pacing:<genre>`     → 流派节奏覆盖
 *   - `genre_dialogue:<genre>`   → 流派对白覆盖
 *   - `genre_introspection:<genre>` → 流派心理描写覆盖
 */
export function buildDeAiWeightsFromPreferences(store: UserMemoryStore): DeAiWeights {
  const allPrefs = getPreferences(store)
  const categoryBoosts: Record<string, number> = {}
  let severityThreshold: DeAiSeverity = store.deAiWeights.severityThreshold ?? "medium"
  const genreOverrides: Record<string, { pacing?: "fast" | "slow"; dialogue?: "strong" | "medium" | "weak"; introspection?: "keep" | "trim" }> = {}

  for (const pref of allPrefs) {
    // 类别增强：deai_boost:<category>
    if (pref.key.startsWith("deai_boost:")) {
      const cat = pref.key.slice(11)
      const val = parseFloat(pref.value)
      if (!isNaN(val) && val > 0) {
        categoryBoosts[cat] = val
      }
      continue
    }

    // 严重度阈值
    if (pref.key === "deai_threshold") {
      const val = pref.value as DeAiSeverity
      if (val === "critical" || val === "high" || val === "medium" || val === "low") {
        severityThreshold = val
      }
      continue
    }

    // 流派覆盖
    if (pref.key.startsWith("genre_pacing:")) {
      const genre = pref.key.slice(13)
      const val = pref.value
      if (val === "fast" || val === "slow") {
        genreOverrides[genre] = { ...genreOverrides[genre], pacing: val }
      }
      continue
    }
    if (pref.key.startsWith("genre_dialogue:")) {
      const genre = pref.key.slice(15)
      const val = pref.value
      if (val === "strong" || val === "medium" || val === "weak") {
        genreOverrides[genre] = { ...genreOverrides[genre], dialogue: val }
      }
      continue
    }
    if (pref.key.startsWith("genre_introspection:")) {
      const genre = pref.key.slice(20)
      const val = pref.value
      if (val === "keep" || val === "trim") {
        genreOverrides[genre] = { ...genreOverrides[genre], introspection: val }
      }
      continue
    }
  }

  return {
    categoryBoosts,
    severityThreshold,
    genreOverrides,
  }
}

/**
 * 应用用户权重到结构化规则。
 *
 * 增强策略：boost > 1 的类别规则在结果中重复出现（增加在 prompt 中的权重）。
 * 不修改原始规则，返回新数组。
 */
export function applyUserWeightsToRules(
  rules: readonly DeAiStructuredRule[],
  weights: DeAiWeights,
): DeAiStructuredRule[] {
  const filtered = filterRulesBySeverity(rules, weights.severityThreshold)
  const result: DeAiStructuredRule[] = []

  for (const rule of filtered) {
    const boost = weights.categoryBoosts[rule.category] ?? 1.0
    const times = Math.max(1, Math.round(boost))
    for (let i = 0; i < times; i++) {
      result.push(rule)
    }
  }

  return result
}

/**
 * 判断用户是否做了任何 de-ai 个性化（类别增强/阈值/流派覆盖/避用词）。
 * 用于接线门控：无个性化时调用方回退旧行为（逐字节不变）。
 */
export function hasUserDeAiWeights(store: UserMemoryStore): boolean {
  const weights = buildDeAiWeightsFromPreferences(store)
  return (
    Object.keys(weights.categoryBoosts).length > 0
    || weights.severityThreshold !== "medium"
    || Object.keys(weights.genreOverrides).length > 0
    || getAvoidWords(store).length > 0
  )
}

/**
 * 聚合用户避用词列表（category === "vocabulary" 且 key 以 avoid_words 开头）。
 * value 按 [,，、\s]+ 切分、去重、滤空。
 */
export function getAvoidWords(store: UserMemoryStore): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const pref of getPreferences(store, "vocabulary")) {
    if (!pref.key.startsWith("avoid_words")) continue
    for (const word of pref.value.split(/[,，、\s]+/)) {
      const trimmed = word.trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
        result.push(trimmed)
      }
    }
  }
  return result
}

/**
 * 构建用户感知的 de-ai 语义层 prompt。
 *
 * 等价于 `buildStructuredDeAiRules()` 但叠加用户偏好权重。
 */
export function buildUserAwareDeAiPrompt(
  store: UserMemoryStore,
  genre?: string,
): string {
  const weights = buildDeAiWeightsFromPreferences(store)
  const weightedRules = applyUserWeightsToRules(DE_AI_STRUCTURED_RULES, weights)
  const avoidWords = getAvoidWords(store)

  // 流派基线：优先用户覆盖，其次默认基线
  let baseline = genre ? getGenreBaseline(genre) : undefined
  if (baseline && genre && weights.genreOverrides[genre]) {
    const override = weights.genreOverrides[genre]!
    baseline = {
      ...baseline,
      ...override,
    }
  }

  // 如果用户没有做任何个性化，回退到标准 buildStructuredDeAiRules
  const hasUserWeights = Object.keys(weights.categoryBoosts).length > 0
    || weights.severityThreshold !== "medium"
    || Object.keys(weights.genreOverrides).length > 0
    || avoidWords.length > 0

  if (!hasUserWeights) {
    return buildStructuredDeAiRules(genre, weights.severityThreshold)
  }

  const lines: string[] = []
  lines.push("# 中文小说去 AI 味语义层规则 (用户个性化)")
  lines.push("")
  if (baseline) {
    lines.push(`流派基线: ${baseline.genre} — 节奏: ${baseline.pacing} / 对白口语化: ${baseline.dialogue} / 心理描写: ${baseline.introspection}`)
    lines.push("")
  }
  lines.push("## 规则矩阵 (按类别分组，含用户权重)")
  // 保持类别顺序
  const categories = _DE_AI_CATEGORIES.filter((cat) =>
    weightedRules.some((r) => r.category === cat),
  )
  for (const category of categories) {
    const catRules = weightedRules.filter((r) => r.category === category)
    /* v8 ignore next */
    if (catRules.length === 0) continue
    lines.push(`### ${category}`)
    for (const r of catRules) {
      lines.push(`- [${r.severity}] ${r.rule}${r.example ? ` (${r.example})` : ""}`)
    }
    lines.push("")
  }
  if (avoidWords.length > 0) {
    lines.push("## 用户避用词 (生成时禁止使用)")
    lines.push(`- ${avoidWords.join("、")}`)
    lines.push("")
  }
  lines.push("## 保留内容 (不可删改)")
  lines.push("1. 剧情事实、人物关系、时间线、伏笔、章节钩子")
  lines.push("2. 视角人称、角色声线、对白毛边")
  lines.push("3. 不增删剧情点, 只改写作方式")
  return lines.join("\n")
}

/**
 * 从偏好分类推断对应的 de-ai 类别。
 * 用于辅助 UI 展示偏好影响范围。
 */
export function mapPreferenceToDeAiCategory(prefCategory: string): string[] {
  const result: string[] = []
  for (const [deAiCat, prefCat] of Object.entries(CATEGORY_TO_PREFERENCE)) {
    if (prefCat === prefCategory) {
      result.push(deAiCat)
    }
  }
  return result
}