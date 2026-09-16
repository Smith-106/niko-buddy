/**
 * scheduling-gate.ts — 波1 EB-3 调度前置闸（配额熔断 / 墙钟 defer / 换模型重试-人工接管三切面合一）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 模块 21 + EB-3，三路共识）：
 *   - 配额熔断、换模型重试、checkpoint/人工接管 = **同一调度层三切面，合一实现**；
 *   - INV-7（DeepSeek 提出的核心不变量）：调度前置闸裁定与门控结果正交——
 *     调度 reject/defer **不写任何门控结果字段**（熔断不是质量门）。
 *     类型层面：SchedulingGateResult 不含 gate/verdict/outcomes 等字段（编译期保证）；
 *     运行时断言 assertNoGateFieldsInSchedulingResult 供编排层兜底复核（spec 钉死）。
 *   - 配额判定复用 T34 budget-counters（分角色 token 软警告/硬封顶）；
 *     软警告不挡（与 anti_ai warn 档同哲学）；硬封顶 reject；墙钟超预算 defer。
 *   - 模型路由底座 = T33 model-resolver（WritingRole/TaskTier/fallback 已存在）：
 *     本模块只补 RoutePolicy 本地配置 schema + 路由自检报告（AX-7 证据），不重造路由。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟（墙钟由调用方从 BudgetCounters
 * 注入）/ 零模型调用。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import { evaluateTokenGate, type BudgetCounters, type TokenBudgetConfig } from "./budget-counters"
import type { GateKey } from "./audit-taxonomy"
import type { NovelErrorKind, TaskTier, WritingRole } from "@/lib/llm/model-resolver"

// ============================================================================
// 前置闸：admit / reject / defer
// ============================================================================

/** 调度裁定（不含任何门控语义——INV-7）。 */
export type SchedulingDecision = "admit" | "reject" | "defer"

/** 配额快照（裁定依据；仅资源字段，无门控字段）。 */
export interface SchedulingQuotaSnapshot {
  readonly role: string
  readonly totalTokens: number
  readonly calls: number
  readonly hardCapped: boolean
  readonly softWarnTokens?: number
  readonly hardCapTokens?: number
}

/** 调度前置闸结果（类型级 INV-7：无 gate/verdict/outcomes/findings/status 字段）。 */
export interface SchedulingGateResult {
  readonly decision: SchedulingDecision
  /** 机器可读原因（quota_hard_cap_exceeded / wallclock_budget_exceeded / soft_warn_notice / ok）。 */
  readonly reason: string
  readonly quota: SchedulingQuotaSnapshot
}

/** 前置闸配置（token 阈值复用 T34 + 章级墙钟预算）。 */
export interface SchedulingGateConfig extends TokenBudgetConfig {
  /** 章级墙钟预算 ms（超线 → defer 资源让位，不拒单）。 */
  readonly wallclockBudgetMs?: number
  /** 当前累计墙钟 ms（调用方从 BudgetCounters.wallclockMs 注入，零时钟）。 */
  readonly wallclockMs?: number
}

/** INV-7 不变量违反错误（运行时兜底断言）。 */
export class SchedulingGateInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SchedulingGateInvariantError"
  }
}

/**
 * 调度前置闸求值（before-call）：
 *   1. 墙钟累计超章级预算 → defer（wallclock_budget_exceeded，资源压力让位不拒单）；
 *   2. token 硬封顶（evaluateTokenGate !allowed）→ reject（quota_hard_cap_exceeded，
 *      事件粒度停机：拒绝的是**本次调度**，不写门控结果，状态完整）；
 *   3. 软警告 → admit（soft_warn_notice，告警不挡）；
 *   4. 其余 → admit（ok）。
 */
export function evaluateSchedulingGate(
  counters: BudgetCounters,
  role: string,
  config: SchedulingGateConfig = {},
): SchedulingGateResult {
  const wallclockBudget =
    typeof config.wallclockBudgetMs === "number" &&
    Number.isFinite(config.wallclockBudgetMs) &&
    config.wallclockBudgetMs > 0
      ? config.wallclockBudgetMs
      : undefined
  const wallclockUsed =
    typeof config.wallclockMs === "number" && Number.isFinite(config.wallclockMs)
      ? Math.max(0, config.wallclockMs)
      : 0

  const quota: SchedulingQuotaSnapshot = {
    role,
    totalTokens: counters.roles[role]?.totalTokens ?? 0,
    calls: counters.roles[role]?.calls ?? 0,
    hardCapped: counters.roles[role]?.hardCapped ?? false,
    softWarnTokens: config.softWarnTokens,
    hardCapTokens: config.hardCapTokens,
  }

  if (wallclockBudget !== undefined && wallclockUsed >= wallclockBudget) {
    return { decision: "defer", reason: "wallclock_budget_exceeded", quota }
  }

  const tokenGate = evaluateTokenGate(counters, role, {
    softWarnTokens: config.softWarnTokens,
    hardCapTokens: config.hardCapTokens,
  })
  if (!tokenGate.allowed) {
    return { decision: "reject", reason: "quota_hard_cap_exceeded", quota }
  }
  if (tokenGate.softWarn) {
    return { decision: "admit", reason: "soft_warn_notice", quota }
  }
  return { decision: "admit", reason: "ok", quota }
}

/**
 * INV-7 运行时兜底断言：调度结果对象不得携带门控结果字段。
 * 编排层在把调度裁定并入任何门控 DTO 之前调用；发现禁止键即抛错（熔断不写门控）。
 */
const INV7_FORBIDDEN_KEYS: readonly string[] = [
  "gate",
  "verdict",
  "verdicts",
  "outcomes",
  "findings",
  "status",
  "shortCircuited",
  "shortCircuitGate",
  "allFindings",
  "gateProjection",
  "escalatedCount",
]

export function assertNoGateFieldsInSchedulingResult(result: SchedulingGateResult): void {
  const check = (obj: Record<string, unknown>, path: string) => {
    for (const key of Object.keys(obj)) {
      if (INV7_FORBIDDEN_KEYS.includes(key)) {
        throw new SchedulingGateInvariantError(
          `INV-7 违反：调度结果 ${path} 含门控结果字段 "${key}"（熔断不写门控）`,
        )
      }
    }
  }
  check(result as unknown as Record<string, unknown>, "scheduling")
  check(result.quota as unknown as Record<string, unknown>, "scheduling.quota")
}

// ============================================================================
// 切面二：换模型重试 / 人工接管（门级重试前置裁定）
// ============================================================================

/** 重试前置裁定（门级重试保留 ContextPack 换模型重跑子步骤的调度面）。 */
export type RetrySchedulingDecisionKind = "retry" | "swap-model" | "escalate" | "abort"

export interface RetrySchedulingInput {
  /** 已尝试次数（1-based：第一次失败后 attempt=1）。 */
  readonly attempt: number
  /** 上次失败错误分类（T33 NovelErrorKind 对齐）。 */
  readonly lastErrorKind: NovelErrorKind
  /** 最大自动重试次数（默认 3）。 */
  readonly maxAttempts?: number
  /** 换模型重试目标（提供且可自动重试 → swap-model）。 */
  readonly nextModelId?: string
}

export interface RetrySchedulingDecision {
  readonly decision: RetrySchedulingDecisionKind
  readonly nextModelId?: string
  /** 机器可读原因（fatal_abort / content_manual / attempts_exhausted / retry_same_model / retry_swap_model）。 */
  readonly reason: string
}

/**
 * 失败后前置裁定（三切面之二：换模型重试与人工接管合一）：
 *   - fatal → abort（不重试）；
 *   - content → escalate（人工接管：内容类失败换模型无益，交人）；
 *   - retryable：attempt < max → nextModelId 提供则 swap-model 否则 retry；
 *     attempt ≥ max → escalate（人工接管）。
 */
export function evaluateRetryScheduling(input: RetrySchedulingInput): RetrySchedulingDecision {
  const maxAttempts =
    typeof input.maxAttempts === "number" && Number.isInteger(input.maxAttempts) && input.maxAttempts > 0
      ? input.maxAttempts
      : 3
  if (input.lastErrorKind === "fatal") {
    return { decision: "abort", reason: "fatal_abort" }
  }
  if (input.lastErrorKind === "content") {
    return { decision: "escalate", reason: "content_manual" }
  }
  if (input.attempt < maxAttempts) {
    return input.nextModelId !== undefined
      ? { decision: "swap-model", nextModelId: input.nextModelId, reason: "retry_swap_model" }
      : { decision: "retry", reason: "retry_same_model" }
  }
  return { decision: "escalate", reason: "attempts_exhausted" }
}

// ============================================================================
// 切面三：RoutePolicy 本地配置（模块 21 设置底座；路由本体 = T33 model-resolver）
// ============================================================================

/** RoutePolicy 契约（本地配置，零云写；role → { modelId, fallbacks }）。 */
export const ROUTE_POLICY_SCHEMA = z
  .object({
    version: z.literal("route-policy/1.0"),
    /** 兜底模型（未绑定角色走此模型）。 */
    defaultModelId: z.string().min(1).max(128),
    /** 角色绑定表（WritingRole 键；缺省角色走 defaultModelId）。 */
    roleBindings: z
      .record(
        z.string().min(1).max(32),
        z
          .object({
            modelId: z.string().min(1).max(128),
            fallbacks: z.array(z.string().min(1).max(128)).max(8).default([]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

/** RoutePolicy。 */
export type RoutePolicy = z.infer<typeof ROUTE_POLICY_SCHEMA>

/** 规范化 RoutePolicy（非法配置直接抛错——设置面契约违反属可恢复错误）。 */
export function normalizeRoutePolicy(raw: unknown): RoutePolicy {
  try {
    return ROUTE_POLICY_SCHEMA.parse(raw)
  } catch (err) {
    throw new SchedulingGateInvariantError(
      `RoutePolicy 契约违反: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** 路由解析结果。 */
export interface RouteResolution {
  readonly modelId: string
  readonly fallbacks: readonly string[]
  /** 是否走了兜底模型（true → 该角色无显式绑定）。 */
  readonly usedDefault: boolean
}

/** 解析角色模型（policy 是 T33 ProjectModelConfig 的调度面投影；纯函数）。 */
export function resolveRouteModel(policy: RoutePolicy, role: WritingRole): RouteResolution {
  const binding = policy.roleBindings?.[role]
  if (!binding) {
    return { modelId: policy.defaultModelId, fallbacks: [], usedDefault: true }
  }
  return { modelId: binding.modelId, fallbacks: binding.fallbacks, usedDefault: false }
}

/** TaskTier → 建议角色（调度面引用 T33 既有映射，避免第二真源）。 */
export function schedulingTierRole(tier: TaskTier): WritingRole {
  switch (tier) {
    case "simple":
      return "writer"
    case "standard":
      return "writer"
    case "complex":
      return "writer"
    case "analysis":
      return "judge"
  }
}

// ============================================================================
// 路由自检报告（模块 21 超越点：同 fixture × 各模型 → 门裁决定性对比）
// ============================================================================

/** 自检单项（调用方注入各模型的门裁定与成本——机械聚合，LLM 部分留外部）。 */
export interface RoutingSelfCheckEntry {
  readonly modelId: string
  /** 各门裁定（调用方产出的结果快照；键为 GateKey）。 */
  readonly gateVerdicts: Partial<Record<GateKey, string>>
  readonly tokens: number
  readonly wallclockMs: number
  /** 该模型是否通过前置门（P0/P1 均 pass）。 */
  readonly passed: boolean
}

/** 自检报告（确定性聚合；模型间 P0 分歧 = 路由风险信号）。 */
export interface RoutingSelfCheckReport {
  readonly fixtureId: string
  readonly entries: readonly RoutingSelfCheckEntry[]
  /** P0 裁定与多数不一致的模型（空 = 全体一致）。 */
  readonly divergentModels: readonly string[]
  readonly cheapestPassing?: string
  readonly fastestPassing?: string
}

/** 构建路由自检报告（纯聚合：多数 P0 裁定 + 最便宜/最快通过模型）。 */
export function buildRoutingSelfCheckReport(
  fixtureId: string,
  entries: readonly RoutingSelfCheckEntry[],
): RoutingSelfCheckReport {
  const p0Counts = new Map<string, number>()
  for (const entry of entries) {
    const p0 = entry.gateVerdicts["consistency"]
    if (typeof p0 === "string") p0Counts.set(p0, (p0Counts.get(p0) ?? 0) + 1)
  }
  let majority: string | undefined
  let majorityCount = 0
  for (const [verdict, count] of p0Counts) {
    if (count > majorityCount) {
      majority = verdict
      majorityCount = count
    }
  }
  const divergentModels =
    majority === undefined
      ? []
      : entries
          .filter((e) => e.gateVerdicts["consistency"] !== undefined && e.gateVerdicts["consistency"] !== majority)
          .map((e) => e.modelId)

  const passing = entries.filter((e) => e.passed)
  const cheapest = [...passing].sort((a, b) => a.tokens - b.tokens)[0]
  const fastest = [...passing].sort((a, b) => a.wallclockMs - b.wallclockMs)[0]
  return {
    fixtureId,
    entries,
    divergentModels,
    cheapestPassing: cheapest?.modelId,
    fastestPassing: fastest?.modelId,
  }
}