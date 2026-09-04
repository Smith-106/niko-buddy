/**
 * eval-gate.ts — 离线评测 gate（E-06 / F-006，双库架构蓝图 kb-governance）。
 *
 * ## 职责（REQ-EVAL-001..009 / G-1 明确化）
 *   - G-1 评测集种子契约（zod）：caseId / category / intent / query /
 *     expectedObligationIds / poisonBlockCheck / canonSnapshotRef / povMask。
 *   - 最小规模基线（GOV-EVAL-03）：义务召回 ≥60 例（覆盖 5 intent）、毒块拦截
 *     ≥30 例、canon 违反回放 ≥20 例（六类陷阱 P-1..P-6 各 ≥2）。
 *   - 三重判据（GOV-EVAL-04）：canon 不违反（canon_violation_rate < 1%）+
 *     氛围一致（atmosphereScore 达标）+ 覆盖率（obligation_coverage > 95%）。
 *   - 三态 verdict（E-06 共识 C-7）：PASS / FAIL / BLOCKED——种子未就绪 →
 *     恒 BLOCKED(seed-missing)，绝不默认 PASS；任一判据不可采集（null）→
 *     BLOCKED(metric-unavailable)。
 *   - MRR/NDCG MUST NOT 构成验收（GOV-EVAL-05 / SA-06）：报告固定文案声明。
 *
 * ## 边界与纪律
 *   - 离线可重跑（GOV-EVAL-02）：零网络、零服务依赖。
 *   - gate 常量在 offline-replay-config.ts（E-02 C-8 指定锚点），本文件只 import
 *     不重定义（防漂移，E-06 共识 C-6）。
 *   - 种子数据由产品侧补齐（G-1 / R-6 最高优先前置）；既有 eval/fixtures
 *     （186 case）schema 不含 G-1 契约字段，不可谎称达标。
 *
 * ## DimensionCoord（SA-05 / GOV-REV-02，E-06 共识 C-10）
 *   (Decoupled, Replay, Fixed)：离线可重放；gate 失败 = 不发布 = 零状态变更
 *   天然可逆；EVAL_GATE 常量 Fixed 不可运行时关闭。
 *
 * 遵循 QMAI/CLAUDE.md：E-06 新增锚点（2026-09-04 三模型共识），落 `src/lib/novel/`。
 */

import { z } from "zod"
import { EVAL_GATE, type TripleCriteria } from "./offline-replay-config"

// ──────────────────────────────────────────────────────────────────────────
// G-1 种子契约（REQ-EVAL-001）
// ──────────────────────────────────────────────────────────────────────────

/** 评测用例类别（三类用例，GOV-EVAL-01）。 */
export const GOV_SEED_CATEGORY = z.enum(["obligation_recall", "poison_block", "canon_violation_replay"])
export type GovSeedCategory = z.infer<typeof GOV_SEED_CATEGORY>

/** 检索意图（5 intent）。 */
export const GOV_SEED_INTENT = z.enum(["plan", "draft", "revise", "lookup", "style"])
export type GovSeedIntent = z.infer<typeof GOV_SEED_INTENT>

/** G-1 种子用例 schema（REQ-EVAL-001 契约）。 */
export const GOV_SEED_CASE_SCHEMA = z.object({
  caseId: z.string().min(1),
  category: GOV_SEED_CATEGORY,
  intent: GOV_SEED_INTENT,
  query: z.string().min(1),
  expectedObligationIds: z.array(z.string()).optional(),
  poisonBlockCheck: z.string().optional(),
  canonSnapshotRef: z.string().optional(),
  povMask: z.string().optional(),
})
export type GovSeedCase = z.infer<typeof GOV_SEED_CASE_SCHEMA>

/** 最小规模基线（GOV-EVAL-03）。 */
export const GOV_SEED_MIN_SCALE = {
  obligationRecall: 60,
  poisonBlock: 30,
  canonViolationReplay: 20,
  /** 六类陷阱 P-1..P-6 各 ≥2（canon 违反回放） */
  trapMinPerTrap: 2,
} as const

/** 六类陷阱标识（P-1..P-6，GOV-EVAL-03）。 */
export const GOV_TRAPS = ["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"] as const

/** 规模校验结果。 */
export interface ScaleViolation {
  category: GovSeedCategory
  expected: number
  actual: number
  detail?: string
}

/** 种子集加载三态（E-06 共识 C-7）。 */
export type SeedStatus = "missing" | "insufficient" | "ready"

export interface GovSeedSet {
  status: SeedStatus
  cases: GovSeedCase[]
  scaleViolations: ScaleViolation[]
}

/**
 * 校验种子集规模（GOV-EVAL-03）：义务召回 ≥60 / 毒块 ≥30 / canon 违反回放 ≥20
 * 且 P-1..P-6 各 ≥2。返回 violations（空 = 齐备）。
 */
export function validateGovSeedScale(cases: readonly GovSeedCase[]): ScaleViolation[] {
  const violations: ScaleViolation[] = []
  const byCategory: Record<GovSeedCategory, GovSeedCase[]> = {
    obligation_recall: [],
    poison_block: [],
    canon_violation_replay: [],
  }
  for (const c of cases) byCategory[c.category].push(c)

  const recall = byCategory.obligation_recall.length
  if (recall < GOV_SEED_MIN_SCALE.obligationRecall) {
    violations.push({ category: "obligation_recall", expected: GOV_SEED_MIN_SCALE.obligationRecall, actual: recall })
  }
  const poison = byCategory.poison_block.length
  if (poison < GOV_SEED_MIN_SCALE.poisonBlock) {
    violations.push({ category: "poison_block", expected: GOV_SEED_MIN_SCALE.poisonBlock, actual: poison })
  }
  const replay = byCategory.canon_violation_replay
  if (replay.length < GOV_SEED_MIN_SCALE.canonViolationReplay) {
    violations.push({ category: "canon_violation_replay", expected: GOV_SEED_MIN_SCALE.canonViolationReplay, actual: replay.length })
  }
  // 六类陷阱各 ≥2（按 caseId 前缀 P-N 判定；无陷阱标注的用例不参与该子校验）
  for (const trap of GOV_TRAPS) {
    const count = replay.filter((c) => c.caseId.includes(trap)).length
    if (count > 0 && count < GOV_SEED_MIN_SCALE.trapMinPerTrap) {
      violations.push({
        category: "canon_violation_replay",
        expected: GOV_SEED_MIN_SCALE.trapMinPerTrap,
        actual: count,
        detail: `陷阱 ${trap} 用例不足（≥2）`,
      })
    }
  }
  return violations
}

/**
 * 加载 G-1 种子集（离线，零网络）。文件缺失/空 → missing；规模不足 → insufficient；
 * 齐备 → ready。解析失败（schema 违反）→ 抛错（种子数据损坏属 RECOVERABLE）。
 */
export function loadGovSeedSet(rawLines: readonly string[]): GovSeedSet {
  const cases: GovSeedCase[] = []
  for (const line of rawLines) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    cases.push(GOV_SEED_CASE_SCHEMA.parse(JSON.parse(trimmed)))
  }
  if (cases.length === 0) return { status: "missing", cases: [], scaleViolations: [] }
  const scaleViolations = validateGovSeedScale(cases)
  if (scaleViolations.length > 0) return { status: "insufficient", cases, scaleViolations }
  return { status: "ready", cases, scaleViolations: [] }
}

// ──────────────────────────────────────────────────────────────────────────
// 三重判据 + gate verdict（GOV-EVAL-04/08）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 由评测结果集计算三重判据（纯函数；执行适配器留接口，不依赖检索侧落码状态）。
 * atmosphereScore 本期无确定性实现 → null（绝不伪造满分，E-06 共识 C-7）。
 */
export function computeTripleCriteria(input: {
  canonViolationRate: number | null
  obligationCoverage: number | null
  atmosphereScore?: number | null
}): TripleCriteria {
  return {
    canonViolationRate: input.canonViolationRate,
    obligationCoverage: input.obligationCoverage,
    atmosphereScore: input.atmosphereScore ?? null,
  }
}

/** gate verdict 三态（E-06 共识 C-7）。 */
export type RetrievalGateVerdict =
  | { verdict: "PASS"; reason?: string }
  | { verdict: "FAIL"; reason: string }
  | { verdict: "BLOCKED"; reason: "seed-missing" | "seed-insufficient" | "metric-unavailable"; detail?: string }

/**
 * 发布 gate 求值（GOV-EVAL-07/08）：
 *   - seedStatus !== "ready" → 恒 BLOCKED（missing / insufficient + scaleViolations），绝不 PASS
 *   - 任一判据 null（不可采集）→ BLOCKED(metric-unavailable)，不降级为 PASS
 *   - canonViolationRate ≥ 0.01 或 obligationCoverage ≤ 0.95 → FAIL（严格 < / > 口径）
 *   - 全过 → PASS
 */
export function evaluateRetrievalGate(input: {
  criteria: TripleCriteria
  seedStatus: SeedStatus
  scaleViolations?: ScaleViolation[]
}): RetrievalGateVerdict {
  if (input.seedStatus === "missing") {
    return { verdict: "BLOCKED", reason: "seed-missing" }
  }
  if (input.seedStatus === "insufficient") {
    return {
      verdict: "BLOCKED",
      reason: "seed-insufficient",
      detail: input.scaleViolations?.map((v) => `${v.category}:${v.actual}/${v.expected}`).join("; "),
    }
  }
  const { canonViolationRate, obligationCoverage, atmosphereScore } = input.criteria
  if (canonViolationRate === null || obligationCoverage === null || atmosphereScore === null) {
    return { verdict: "BLOCKED", reason: "metric-unavailable" }
  }
  if (canonViolationRate >= EVAL_GATE.canonViolationMax) {
    return { verdict: "FAIL", reason: `canon_violation_rate=${canonViolationRate} ≥ ${EVAL_GATE.canonViolationMax}` }
  }
  if (obligationCoverage <= EVAL_GATE.obligationCoverageMin) {
    return { verdict: "FAIL", reason: `obligation_coverage=${obligationCoverage} ≤ ${EVAL_GATE.obligationCoverageMin}` }
  }
  if (atmosphereScore < EVAL_GATE.atmosphereMin) {
    return { verdict: "FAIL", reason: `atmosphere_score=${atmosphereScore} < ${EVAL_GATE.atmosphereMin}` }
  }
  return { verdict: "PASS" }
}

/** 评测报告（GOV-EVAL-06：三判据 + 六类陷阱拦截结果，可审计复现；无 MRR/NDCG 字段）。 */
export interface EvalGateReport {
  seedStatus: SeedStatus
  criteria: TripleCriteria
  verdict: RetrievalGateVerdict
  trapInterception: Record<string, number>
  /** 固定文案：本报告不含 MRR/NDCG 验收语义（GOV-EVAL-05 / SA-06）。 */
  acceptanceNote: string
}

/** 渲染评测报告（Markdown；固定文案行断言 MRR/NDCG 缺席）。 */
export function renderEvalGateReport(report: EvalGateReport): string {
  const lines: string[] = []
  lines.push("# 检索精度评测报告（三重判据）")
  lines.push("")
  lines.push(`- seed_status: ${report.seedStatus}`)
  lines.push(`- canon_violation_rate: ${report.criteria.canonViolationRate ?? "N/A"}`)
  lines.push(`- obligation_coverage: ${report.criteria.obligationCoverage ?? "N/A"}`)
  lines.push(`- atmosphere_score: ${report.criteria.atmosphereScore ?? "N/A[需校准]"}`)
  lines.push(`- verdict: ${report.verdict.verdict}${report.verdict.reason ? ` (${report.verdict.reason})` : ""}`)
  lines.push(`- trap_interception: ${JSON.stringify(report.trapInterception)}`)
  lines.push("")
  lines.push(`> ${report.acceptanceNote}`)
  return lines.join("\n")
}
