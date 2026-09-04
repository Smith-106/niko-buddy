/**
 * trust-grader.ts — Trust 归一化分级器（E-06 / F-006，双库架构蓝图 kb-governance）。
 *
 * ## 职责（REQ-GOV-001..006 / G-2 明确化）
 *   trust = Synthesize( NormalizeADR(adr_score), LicensePolicy(license) )，
 *   确定性纯函数，值域恰为 R-1 三级 {blocked, reference_only, full}：
 *   - NormalizeADR(adr_score)：≥0.8 → full；0.5 ≤ x < 0.8 → reference_only；<0.5 → blocked
 *   - LicensePolicy(license)：CC-BY/公共领域 → full；MIT/Apache → reference_only；
 *     AGPL/GPL → blocked（仅模式借鉴，MUST NOT 作被检索原文，铁律③）；未知/未声明 → blocked（保守默认）
 *   - Synthesize = min(adr_grade, license_grade)（GOV-TRUST-03）
 *
 * ## 边界与纪律
 *   - 纯函数层：零 IO、零 LLM、零写句柄（BND-PRM-08：派生结果不写回凭证，消费点即时计算）。
 *   - 阈值可配置且带 zod 校验（GOV-TRUST-04）：配置变更可回滚（锁 seed + 分支）。
 *   - 无法派生 trust 的项 → blocked + quarantine 判定（GOV-TRUST-06，MUST NOT 静默入库）。
 *   - 入参非法（NaN / 越界 / 非字符串 license）→ throw（由 kb-observability 归为
 *     RECOVERABLE → QUARANTINE，不静默入库）。
 *
 * ## DimensionCoord（SA-05 / GOV-REV-02，E-06 共识 C-10）
 *   (Decoupled, Sync, Tunable)：纯函数与库存储解耦（无写句柄）；同步求值无延迟面；
 *   阈值可配置 = Tunable 且锁 seed + 分支可回滚；AGPL→blocked 为 Fixed 子约束不可放宽。
 *
 * 遵循 QMAI/CLAUDE.md：E-06 新增锚点（2026-09-04 三模型共识），落 `src/lib/novel/`。
 */

import { z } from "zod"

// ──────────────────────────────────────────────────────────────────────────
// 类型与常量
// ──────────────────────────────────────────────────────────────────────────

/** trust 三级值域（R-1）。 */
export type TrustGrade = "blocked" | "reference_only" | "full"

/** 档位序数值（min 合成用：blocked < reference_only < full）。 */
export const GRADE_ORDER: Record<TrustGrade, number> = {
  blocked: 0,
  reference_only: 1,
  full: 2,
} as const

/** trust 阈值配置（zod 校验，GOV-TRUST-04）。 */
export const TRUST_THRESHOLDS_SCHEMA = z
  .object({
    /** adr_score ≥ 此值 → full */
    adrFullMin: z.number().min(0).max(1),
    /** adr_score ≥ 此值 → reference_only（< 此值 → blocked） */
    adrReferenceMin: z.number().min(0).max(1),
  })
  .strict()

export type TrustThresholds = z.infer<typeof TRUST_THRESHOLDS_SCHEMA>

/** 默认阈值（G-2 明确化原文；配置变更须锁 seed + 分支回滚）。 */
export const DEFAULT_TRUST_THRESHOLDS: TrustThresholds = {
  adrFullMin: 0.8,
  adrReferenceMin: 0.5,
} as const

/** 配置 seed 锁（GOV-TRUST-04：配置变更可回滚的锚点）。 */
export const TRUST_SEED_LOCK = "trust-thresholds-v1"

/** license 查表（GOV-TRUST-02：AGPL/GPL → blocked 仅模式借鉴）。 */
const LICENSE_TABLE: Record<string, TrustGrade> = {
  "CC-BY": "full",
  "CC-BY-4.0": "full",
  CC0: "full",
  "public-domain": "full",
  "公共领域": "full",
  MIT: "reference_only",
  "Apache-2.0": "reference_only",
  "Apache": "reference_only",
  BSD: "reference_only",
  "BSD-3-Clause": "reference_only",
  AGPL: "blocked",
  "AGPL-3.0": "blocked",
  "AGPL-3.0-only": "blocked",
  GPL: "blocked",
  "GPL-3.0": "blocked",
  "GPL-2.0": "blocked",
}

// ──────────────────────────────────────────────────────────────────────────
// 纯函数
// ──────────────────────────────────────────────────────────────────────────

/**
 * NormalizeADR(adr_score)：档位化映射（GOV-TRUST-01）。
 * 非法入参（NaN / 越界）→ throw（不静默降级）。
 */
export function normalizeADR(adrScore: number, thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS): TrustGrade {
  if (!Number.isFinite(adrScore) || adrScore < 0 || adrScore > 1) {
    throw new Error(`normalizeADR: adrScore 越界或非有限值: ${adrScore}`)
  }
  if (adrScore >= thresholds.adrFullMin) return "full"
  if (adrScore >= thresholds.adrReferenceMin) return "reference_only"
  return "blocked"
}

/**
 * LicensePolicy(license)：查表（GOV-TRUST-02）。
 * 未知/未声明 → blocked（保守默认，进 quarantine 复核，GOV-TRUST-06）。
 */
export function licensePolicy(license: string): TrustGrade {
  if (typeof license !== "string" || license.trim() === "") {
    return "blocked"
  }
  const key = license.trim()
  return LICENSE_TABLE[key] ?? "blocked"
}

/**
 * Synthesize(adr_grade, license_grade) = min（GOV-TRUST-03）。
 * 值域恰为 R-1 三级 {blocked, reference_only, full}。
 */
export function synthesizeTrust(adrGrade: TrustGrade, licenseGrade: TrustGrade): TrustGrade {
  return GRADE_ORDER[adrGrade] <= GRADE_ORDER[licenseGrade] ? adrGrade : licenseGrade
}

/** 完整分级入口：trust = NormalizeADR ⊕ LicensePolicy（确定性纯函数）。 */
export function gradeTrust(
  input: { adrScore: number; license: string },
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
): { grade: TrustGrade; adrGrade: TrustGrade; licenseGrade: TrustGrade } {
  const adrGrade = normalizeADR(input.adrScore, thresholds)
  const licenseGrade = licensePolicy(input.license)
  return { grade: synthesizeTrust(adrGrade, licenseGrade), adrGrade, licenseGrade }
}

/** blocked 条目 MUST NOT 作为被检索原文（GOV-TRUST-05）。 */
export function isRetrievable(trust: TrustGrade): boolean {
  return trust !== "blocked"
}

/** 剔除 blocked 条目（检索/装配消费点复用；IC-02 绝不静默——调用方负责记 gap）。 */
export function filterByTrust<T extends { trust?: TrustGrade }>(items: readonly T[]): T[] {
  return items.filter((item) => item.trust === undefined || isRetrievable(item.trust))
}

/** blocked → quarantine 判定（GOV-TRUST-06：无法派生 trust 的项 MUST 落 quarantine）。 */
export function dispositionOf(grade: TrustGrade): "quarantine" | "normal" {
  return grade === "blocked" ? "quarantine" : "normal"
}

/** 校验阈值配置（zod strict：拒绝未知键；非法 → throw）。 */
export function validateTrustThresholds(config: unknown): TrustThresholds {
  return TRUST_THRESHOLDS_SCHEMA.parse(config)
}
