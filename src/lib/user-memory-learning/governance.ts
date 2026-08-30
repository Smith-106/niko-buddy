import { normalizeGlobalUserMemoryConfig, userMemoryRuleFingerprint } from "./store"
import type { GlobalUserMemoryConfig, UserMemoryRule } from "./types"

const NEGATIVE_PATTERN = /不要|禁止|不再|避免|无需|不能|不得/

function conflictSignature(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(NEGATIVE_PATTERN, "")
    .replace(/(?:回答时|写作时|生成时|大纲|使用|采用|保持|风格|方式|内容|规则)/g, "")
    .replace(/[\s，。！？；：,.!?;:、]/g, "")
}

function sameScope(left: UserMemoryRule, right: UserMemoryRule): boolean {
  return (left.scope ?? "global") === (right.scope ?? "global")
    && (left.projectKey ?? null) === (right.projectKey ?? null)
    && (left.sessionKey ?? null) === (right.sessionKey ?? null)
}

function areOpposite(left: UserMemoryRule, right: UserMemoryRule): boolean {
  if (left.category !== right.category || !sameScope(left, right)) return false
  const leftSignature = conflictSignature(left.rule)
  const rightSignature = conflictSignature(right.rule)
  if (!leftSignature || leftSignature !== rightSignature) return false
  return NEGATIVE_PATTERN.test(left.rule) !== NEGATIVE_PATTERN.test(right.rule)
}

function semanticSignature(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s，。！？；：,.!?;:、]/g, "")
    .replace(/(?:回答问题|回答时|写作时|生成时|问题|请|务必|需要|要|优先|先|给出|给|使用|采用|保持|一直|始终|时)/g, "")
}

function areSimilar(left: UserMemoryRule, right: UserMemoryRule): boolean {
  if (left.source !== "automatic" || right.source !== "automatic") return false
  if (left.category !== right.category || !sameScope(left, right)) return false
  if (NEGATIVE_PATTERN.test(left.rule) !== NEGATIVE_PATTERN.test(right.rule)) return false
  const leftSignature = semanticSignature(left.rule)
  const rightSignature = semanticSignature(right.rule)
  if (!leftSignature || !rightSignature) return false
  if (leftSignature === rightSignature) return true
  const leftChars = new Set(leftSignature)
  const rightChars = new Set(rightSignature)
  const intersection = [...leftChars].filter((char) => rightChars.has(char)).length
  const union = new Set([...leftChars, ...rightChars]).size
  return union > 0 && intersection / union >= 0.75
}

function mergeSimilarAutomaticRules(rules: UserMemoryRule[]): UserMemoryRule[] {
  const merged: UserMemoryRule[] = []
  for (const rule of rules) {
    const existingIndex = merged.findIndex((item) => areSimilar(item, rule))
    if (existingIndex < 0) {
      merged.push(rule)
      continue
    }
    const existing = merged[existingIndex]!
    const preferred = rule.confidence >= existing.confidence ? rule : existing
    merged[existingIndex] = {
      ...existing,
      rule: preferred.rule,
      fingerprint: userMemoryRuleFingerprint(preferred.rule, preferred.category),
      confidence: Math.max(existing.confidence, rule.confidence),
      surfaces: [...new Set([...existing.surfaces, ...rule.surfaces])],
      evidenceCount: (existing.evidenceCount ?? 1) + (rule.evidenceCount ?? 1),
      evidenceSummary: preferred.evidenceSummary,
      sourceHash: preferred.sourceHash,
      lastEvidenceAt: Math.max(existing.lastEvidenceAt ?? 0, rule.lastEvidenceAt ?? 0),
      updatedAt: Math.max(existing.updatedAt, rule.updatedAt),
      usageCount: (existing.usageCount ?? 0) + (rule.usageCount ?? 0),
      positiveFeedback: (existing.positiveFeedback ?? 0) + (rule.positiveFeedback ?? 0),
      negativeFeedback: (existing.negativeFeedback ?? 0) + (rule.negativeFeedback ?? 0),
    }
  }
  return merged
}

export function governUserMemoryConfig(config: GlobalUserMemoryConfig, now = Date.now()): GlobalUserMemoryConfig {
  const promotionThreshold = Math.max(1, config.candidatePromotionThreshold)
  const rules = mergeSimilarAutomaticRules(config.rules).map((rule): UserMemoryRule => {
    if (rule.source === "manual") {
      return { ...rule, status: rule.status === "expired" ? "active" : rule.status, expiresAt: null, conflictsWith: [] }
    }
    if (rule.expiresAt !== null && rule.expiresAt !== undefined && rule.expiresAt <= now && rule.status === "candidate") {
      return { ...rule, status: "expired", conflictsWith: [] }
    }
    if ((rule.negativeFeedback ?? 0) >= (rule.positiveFeedback ?? 0) + 2) {
      return { ...rule, status: "candidate", expiresAt: now + 30 * 24 * 60 * 60 * 1000, conflictsWith: [] }
    }
    if (rule.status === "candidate" && (rule.evidenceCount ?? 1) >= promotionThreshold) {
      return { ...rule, status: "active", expiresAt: null, conflictsWith: [] }
    }
    return { ...rule, status: rule.status === "conflicted" ? "active" : rule.status, conflictsWith: [] }
  })

  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const left = rules[leftIndex]!
      const right = rules[rightIndex]!
      if (!areOpposite(left, right)) continue
      rules[leftIndex] = { ...left, status: "conflicted", conflictsWith: [...new Set([...(left.conflictsWith ?? []), right.id])] }
      rules[rightIndex] = { ...right, status: "conflicted", conflictsWith: [...new Set([...(right.conflictsWith ?? []), left.id])] }
    }
  }

  return normalizeGlobalUserMemoryConfig({ ...config, rules, updatedAt: Math.max(config.updatedAt, now) })
}

export function applyUserMemoryFeedback(
  config: GlobalUserMemoryConfig,
  ruleIds: string[],
  sentiment: "positive" | "negative",
  now = Date.now(),
): GlobalUserMemoryConfig {
  const ids = new Set(ruleIds)
  return normalizeGlobalUserMemoryConfig({
    ...config,
    rules: config.rules.map((rule) => ids.has(rule.id)
      ? {
          ...rule,
          positiveFeedback: (rule.positiveFeedback ?? 0) + (sentiment === "positive" ? 1 : 0),
          negativeFeedback: (rule.negativeFeedback ?? 0) + (sentiment === "negative" ? 1 : 0),
          updatedAt: now,
        }
      : rule),
    updatedAt: now,
  })
}
