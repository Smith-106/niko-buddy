/**
 * Wave 1 用户记忆系统 — 类型定义
 *
 * 简单 key-value + 规则权重，不做复杂 embedding 检索。
 * 持久化在独立 `user-memory.json`（不并入 status.json，R1 风险缓解）。
 * 喂入 de-ai-rules.ts + review-scoring.ts。
 */

import type { DeAiSeverity } from "../novel/de-ai-rules"

// ── 偏好条目 ──

/** 偏好分类（映射到 de-ai 7 类别 + 审查维度） */
export const PREFERENCE_CATEGORIES = [
  "vocabulary",   // 词汇偏好 → de-ai 词汇
  "style",        // 风格偏好 → de-ai 句式
  "pacing",       // 节奏偏好 → de-ai 节奏
  "dialogue",     // 对话偏好 → de-ai 对白
  "description",  // 描写偏好 → de-ai 场景
  "review",       // 审查偏好 → review-scoring 校准
  "custom",       // 自定义
] as const

export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number]

export interface UserPreference {
  /** 稳定 id（e.g. `upref-<timestamp>-<random>`） */
  id: string
  /** 偏好键（e.g. "avoid_words", "dim:plot", "sev:error", "style_tendency"） */
  key: string
  /** 偏好值（可解析为 string | number | boolean） */
  value: string
  /** 分类 */
  category: PreferenceCategory
  /** 可读标签 */
  label?: string
  /** ISO 时间戳 */
  createdAt: string
  /** ISO 时间戳 */
  updatedAt: string
}

// ── de-ai 规则权重 ──

export interface DeAiWeights {
  /** 类别增强系数（category → multiplier，默认 1.0） */
  categoryBoosts: Record<string, number>
  /** 最低严重度阈值（低于此级别的规则不注入） */
  severityThreshold: DeAiSeverity
  /** 流派覆盖（genre → baseline 部分覆盖） */
  genreOverrides: Record<string, GenreOverrideFields>
}

/** 流派基线可覆盖字段 */
export interface GenreOverrideFields {
  pacing?: "fast" | "slow"
  dialogue?: "strong" | "medium" | "weak"
  introspection?: "keep" | "trim"
}

// ── 审查校准 ──

export interface ReviewCalibration {
  /** 维度权重覆盖（e.g. { plot: 0.25, facts: 0.35 }） */
  dimensionWeights: Record<string, number>
  /** 严重度扣分覆盖（e.g. { error: 30, warning: 15 }） */
  severityDeductions: Record<string, number>
}

// ── 完整存储结构 ──

export const USER_MEMORY_SCHEMA_VERSION = "user-memory/1.0" as const

export interface UserMemoryStore {
  version: typeof USER_MEMORY_SCHEMA_VERSION
  /** 偏好条目列表 */
  preferences: UserPreference[]
  /** de-ai 规则权重 */
  deAiWeights: DeAiWeights
  /** 审查校准 */
  reviewCalibration: ReviewCalibration
  /** ISO 时间戳 */
  updatedAt: string
}

// ── 工厂 ──

export function createDefaultStore(): UserMemoryStore {
  return {
    version: USER_MEMORY_SCHEMA_VERSION,
    preferences: [],
    deAiWeights: {
      categoryBoosts: {},
      severityThreshold: "medium",
      genreOverrides: {},
    },
    reviewCalibration: {
      dimensionWeights: {},
      severityDeductions: {},
    },
    updatedAt: new Date().toISOString(),
  }
}

/** 创建偏好条目（纯函数，不修改 store） */
export function createPreference(
  fields: Pick<UserPreference, "key" | "value" | "category"> & Partial<Pick<UserPreference, "label">>,
): UserPreference {
  const now = new Date().toISOString()
  const id = `upref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    key: fields.key,
    value: fields.value,
    category: fields.category,
    label: fields.label,
    createdAt: now,
    updatedAt: now,
  }
}