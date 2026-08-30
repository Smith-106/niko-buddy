import type { UserMemoryFilterReason } from "./selector"
import type { UserMemoryRule, UserMemorySurface } from "./types"

export interface UserMemoryDecisionFilter {
  ruleId: string
  reason: UserMemoryFilterReason
}

export interface UserMemoryDecision {
  createdAt: number
  surface: UserMemorySurface
  projectKey: string | null
  sessionKey: string | null
  candidateCount: number
  selectedRuleIds: string[]
  filtered: UserMemoryDecisionFilter[]
  injectedChars: number
  estimatedTokens: number
}

let latestDecision: UserMemoryDecision | null = null

export function buildUserMemoryDecision(input: {
  rules: UserMemoryRule[]
  selected: UserMemoryRule[]
  filtered: UserMemoryDecisionFilter[]
  prompt: string
  surface: UserMemorySurface
  projectKey?: string
  sessionKey?: string
  now?: number
}): UserMemoryDecision {
  return {
    createdAt: input.now ?? Date.now(),
    surface: input.surface,
    projectKey: input.projectKey ?? null,
    sessionKey: input.sessionKey ?? null,
    candidateCount: input.rules.length,
    selectedRuleIds: input.selected.map((rule) => rule.id),
    filtered: input.filtered,
    injectedChars: input.prompt.length,
    estimatedTokens: Math.ceil(input.prompt.length / 4),
  }
}

export function setLatestUserMemoryDecision(decision: UserMemoryDecision | null): void {
  latestDecision = decision
}

export function getLatestUserMemoryDecision(): UserMemoryDecision | null {
  return latestDecision ? { ...latestDecision, selectedRuleIds: [...latestDecision.selectedRuleIds], filtered: [...latestDecision.filtered] } : null
}
