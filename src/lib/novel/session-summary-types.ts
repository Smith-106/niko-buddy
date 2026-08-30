/**
 * SessionContextSummary 本地类型（qmai context-hub/types.ts 最小子集移植，
 * 2026-08-30 三模型共识 context-hub 子件）。仅含与会话摘要相关的字段，
 * 避免整层 types 依赖（@/lib/agent/types / classification / context-engine）。
 */
export interface SessionContextSummary {
  text: string
  dependencyFingerprint?: string
  updatedAt: number
}

export const SESSION_SUMMARY_TYPE_LOCAL = true as const
