export type UserMemoryCategory =
  | "output_style"
  | "writing_preference"
  | "outline_preference"
  | "workflow_preference"
  | "interaction_preference"
  | "format_preference"
  | "constraint"
  | "manual"

export type UserMemorySource = "automatic" | "manual"
export type UserMemoryScope = "global" | "project" | "session"
export type UserMemoryStatus = "candidate" | "active" | "conflicted" | "expired"

export type UserMemorySurface =
  | "all"
  | "ai-chat"
  | "ai-outline"
  | "chapter-writing"
  | "book-analysis"
  | "review"
  | "analysis"

export interface UserMemoryRule {
  id: string
  rule: string
  category: UserMemoryCategory
  source: UserMemorySource
  surfaces: UserMemorySurface[]
  confidence: number
  evidenceSummary: string
  sourceHash: string | null
  fingerprint: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  scope?: UserMemoryScope
  projectKey?: string | null
  sessionKey?: string | null
  status?: UserMemoryStatus
  evidenceCount?: number
  lastEvidenceAt?: number
  expiresAt?: number | null
  usageCount?: number
  lastUsedAt?: number | null
  positiveFeedback?: number
  negativeFeedback?: number
  conflictsWith?: string[]
}

export interface GlobalUserMemoryConfig {
  version: 2
  enabled: boolean
  autoLearn: boolean
  autoRead: boolean
  rules: UserMemoryRule[]
  analyzedSourceHashes: string[]
  deletedFingerprints: string[]
  updatedAt: number
  onlyManual: boolean
  dailyLearningLimit: number
  batchSize: number
  candidatePromotionThreshold: number
  maxRules: number
  maxAnalyzedHashes: number
  maxStorageBytes: number
}

export interface AutomaticUserMemoryRuleInput {
  rule: string
  category: UserMemoryCategory
  surfaces: UserMemorySurface[]
  confidence: number
  evidenceSummary: string
  sourceHash: string
  scope?: UserMemoryScope
  projectKey?: string | null
  sessionKey?: string | null
}

export interface ManualUserMemoryRuleInput {
  rule: string
  category: UserMemoryCategory
  surfaces: UserMemorySurface[]
  scope?: UserMemoryScope
  projectKey?: string | null
  sessionKey?: string | null
}
