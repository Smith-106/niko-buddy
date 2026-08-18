/**
 * Wave 1 用户记忆系统 — 注入器
 *
 * 将用户偏好注入 review-scoring 六维审查打分：
 *   - 维度权重个性化（e.g. 作者更在意「事实一致性」→ 提高 facts 权重）
 *   - 严重度扣分个性化（e.g. 作者对 error 更严格 → 提高 error 扣分）
 *
 * 集成点：`scoreReviewResults()` 的 `ReviewScoringOptions` 参数。
 */

import type { UserMemoryStore, ReviewCalibration } from "./types"
import type { ReviewScoringOptions } from "../novel/review-scoring"
import {
  CALIBRATED_DIMENSION_WEIGHTS,
  CALIBRATED_SEVERITY_DEDUCTION,
} from "../novel/review-scoring"
import { getPreferences } from "./store"

/** 审查维度 key 集合（与 review-scoring DIMENSION_WEIGHTS 同步） */
const VALID_DIMENSION_KEYS = new Set(["plot", "character", "world", "pacing", "facts", "compliance"])

/** 严重度 key 集合（与 review-scoring SEVERITY_DEDUCTION 同步） */
const VALID_SEVERITY_KEYS = new Set(["error", "warning", "info"])

/**
 * 从用户偏好中提取审查校准参数。
 *
 * 偏好 key 约定：
 *   - `dim:<dimension>` → 维度权重（e.g. `dim:plot` → 0.25）
 *   - `sev:<severity>`  → 严重度扣分（e.g. `sev:error` → 30）
 *
 * 只接受合法的维度/严重度 key；非法 key 静默忽略。
 */
export function calibrateReviewFromPreferences(store: UserMemoryStore): ReviewCalibration {
  const reviewPrefs = getPreferences(store, "review")
  const dimensionWeights: Record<string, number> = {}
  const severityDeductions: Record<string, number> = {}

  for (const pref of reviewPrefs) {
    const val = parseFloat(pref.value)
    if (isNaN(val) || val < 0) continue

    if (pref.key.startsWith("dim:")) {
      const dim = pref.key.slice(4)
      if (VALID_DIMENSION_KEYS.has(dim)) {
        dimensionWeights[dim] = val
      }
    } else if (pref.key.startsWith("sev:")) {
      const sev = pref.key.slice(4)
      if (VALID_SEVERITY_KEYS.has(sev)) {
        severityDeductions[sev] = val
      }
    }
  }

  return { dimensionWeights, severityDeductions }
}

/**
 * 构建注入用户偏好的 ReviewScoringOptions。
 *
 * 合并策略：用户校准值覆盖默认校准值，再覆盖原始默认值。
 * 优先级：用户偏好 > CALIBRATED_* > 默认 DIMENSION_WEIGHTS / SEVERITY_DEDUCTION
 */
export function buildReviewScoringOptions(store: UserMemoryStore): ReviewScoringOptions {
  const cal = calibrateReviewFromPreferences(store)

  const hasDimUserOverrides = Object.keys(cal.dimensionWeights).length > 0
  const hasSevUserOverrides = Object.keys(cal.severityDeductions).length > 0

  return {
    dimensionWeights: hasDimUserOverrides
      ? { ...CALIBRATED_DIMENSION_WEIGHTS, ...cal.dimensionWeights }
      : undefined,
    severityDeductions: hasSevUserOverrides
      ? { ...CALIBRATED_SEVERITY_DEDUCTION, ...cal.severityDeductions }
      : undefined,
    enableAntiHallucination: true,
  }
}

/**
 * 获取合并后的有效维度权重（用于外部查询）。
 * 返回完整的 6 维权重映射。
 */
export function getEffectiveDimensionWeights(store: UserMemoryStore): Record<string, number> {
  const cal = calibrateReviewFromPreferences(store)
  return { ...CALIBRATED_DIMENSION_WEIGHTS, ...cal.dimensionWeights }
}

/**
 * 获取合并后的有效严重度扣分（用于外部查询）。
 */
export function getEffectiveSeverityDeductions(store: UserMemoryStore): Record<string, number> {
  const cal = calibrateReviewFromPreferences(store)
  return { ...CALIBRATED_SEVERITY_DEDUCTION, ...cal.severityDeductions }
}