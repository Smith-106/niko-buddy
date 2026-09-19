/**
 * retrieval-budget.ts — R0-d 延迟-成本预算账本。
 *
 * 共识来源：批准计划 r2 §R0-d（planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113 §R0-d）；
 * 收编既有 `SEARCH_SOURCE_TIMEOUT_MS = 2500`（search-adapter）与 context-engine
 * rerank 回退（`.catch(() => candidates)`）为统一口径 + 可回退注册表。
 *
 * 口径（数值不改，仅收编）：
 *   - 单源封顶 2500ms（source 类路径；数值 = 迁移前的 SEARCH_SOURCE_TIMEOUT_MS，零改动）；
 *   - 零 LLM 默认不可逾越线 2500ms（零 LLM 路径不得比单源封顶更宽）；
 *   - LLM 路径既有超时 45000ms（rerank.ts AbortSignal.timeout；仅登记不调参）。
 *   任何路径都必须显式登记回退函数（registerRollback）——无回退即 fail-loud。
 *
 * λ（MMR 成本系数初值）：`lambdaMsPerPp = 单源封顶 / 目标质量跨度(100pp) = 25 ms/pp`；
 * `calibrated=false`（非同源矩阵缺失，无标定数据）→ R2-a MMR 谓词在被消费时 locked。
 *
 * 机械层（ADR-19）：纯函数 + zod + 无 IO/无时钟（measuredMs 由调用方测量注入）。
 * 账本为显式状态容器（工厂 `createRetrievalBudgetLedger`，测试可独立实例）。
 *
 * @license MIT © Niko Buddy
 */

import { z } from "zod"

/** 单源封顶（迁移自 search-adapter SEARCH_SOURCE_TIMEOUT_MS；数值不变）。 */
export const RETRIEVAL_SOURCE_TIMEOUT_MS = 2500

/** 零 LLM 路径默认不可逾越线（零 LLM 不得宽于单源封顶）。 */
export const ZERO_LLM_DEFAULT_BUDGET_MS = 2500

/** LLM 路径既有超时（rerank.ts AbortSignal.timeout；仅登记）。 */
export const LLM_RERANK_TIMEOUT_MS = 45000

/** 规范路径 id（登记表的键空间）。 */
export const RETRIEVAL_BUDGET_PATHS = {
  searchBranch: "source:search-branch",
  contextRerank: "context:rerank-candidates",
  kbReferenceKeyword: "kb:reference-keyword",
} as const

export type RetrievalBudgetPath = (typeof RETRIEVAL_BUDGET_PATHS)[keyof typeof RETRIEVAL_BUDGET_PATHS]

/** 路径预算类型。 */
export const RETRIEVAL_BUDGET_KIND_SCHEMA = z.enum(["source", "zero_llm", "llm"])

/** 单路径预算条目（strict）。 */
export const RETRIEVAL_BUDGET_ENTRY_SCHEMA = z
  .object({
    path: z.string().min(1).max(128),
    budgetMs: z.number().int().positive(),
    kind: RETRIEVAL_BUDGET_KIND_SCHEMA,
  })
  .strict()

/** 预算账本契约（strict；数值口径真源）。 */
export const RETRIEVAL_BUDGET_SCHEMA = z
  .object({
    sourceTimeoutMs: z.literal(RETRIEVAL_SOURCE_TIMEOUT_MS),
    zeroLlmDefaultMs: z.literal(ZERO_LLM_DEFAULT_BUDGET_MS),
    llmRerankTimeoutMs: z.literal(LLM_RERANK_TIMEOUT_MS),
    entries: z.array(RETRIEVAL_BUDGET_ENTRY_SCHEMA).min(1),
  })
  .strict()

export type RetrievalBudget = z.infer<typeof RETRIEVAL_BUDGET_SCHEMA>

/** 默认账本（与既有代码数值逐字对齐）。 */
export const DEFAULT_RETRIEVAL_BUDGET: RetrievalBudget = RETRIEVAL_BUDGET_SCHEMA.parse({
  sourceTimeoutMs: RETRIEVAL_SOURCE_TIMEOUT_MS,
  zeroLlmDefaultMs: ZERO_LLM_DEFAULT_BUDGET_MS,
  llmRerankTimeoutMs: LLM_RERANK_TIMEOUT_MS,
  entries: [
    { path: RETRIEVAL_BUDGET_PATHS.searchBranch, budgetMs: RETRIEVAL_SOURCE_TIMEOUT_MS, kind: "source" },
    { path: RETRIEVAL_BUDGET_PATHS.contextRerank, budgetMs: LLM_RERANK_TIMEOUT_MS, kind: "llm" },
    { path: RETRIEVAL_BUDGET_PATHS.kbReferenceKeyword, budgetMs: ZERO_LLM_DEFAULT_BUDGET_MS, kind: "zero_llm" },
  ],
})

/** 预算裁决（观察层；不改变调用方回退行为）。 */
export const RETRIEVAL_BUDGET_VERDICT_SCHEMA = z
  .object({
    path: z.string().min(1),
    measuredMs: z.number().nonnegative(),
    budgetMs: z.number().positive(),
    within: z.boolean(),
    exceededByMs: z.number().nonnegative(),
    action: z.enum(["allow", "reject_fallback"]),
    rollbackRegistered: z.boolean(),
  })
  .strict()

export type RetrievalBudgetVerdict = z.infer<typeof RETRIEVAL_BUDGET_VERDICT_SCHEMA>

/** 预算账本错误（未登记路径 / 未登记回退 / 非法输入，一律 fail-loud）。 */
export class RetrievalBudgetError extends Error {
  constructor(message: string) {
    super(`[retrieval-budget] ${message}`)
    this.name = "RetrievalBudgetError"
  }
}

// ============================================================================
// λ（MMR 成本系数）初值
// ============================================================================

/** λ 初值 = 单源封顶 / 目标质量跨度（100pp）。 */
export const LAMBDA_MS_PER_PP_INITIAL =
  RETRIEVAL_SOURCE_TIMEOUT_MS / 100

/** λ 标定状态（缺失标定 → R2-a MMR 谓词 locked）。 */
export const RETRIEVAL_LAMBDA_SCHEMA = z
  .object({
    value: z.number().positive(),
    unit: z.literal("ms_per_pp"),
    calibrated: z.boolean(),
    basis: z.string().min(1),
  })
  .strict()

export type RetrievalLambda = z.infer<typeof RETRIEVAL_LAMBDA_SCHEMA>

/** λ 初值（未标定；非同源矩阵缺失期间 R2-a 谓词 locked）。 */
export const RETRIEVAL_LAMBDA_INITIAL: RetrievalLambda = RETRIEVAL_LAMBDA_SCHEMA.parse({
  value: LAMBDA_MS_PER_PP_INITIAL,
  unit: "ms_per_pp",
  calibrated: false,
  basis: "单源封顶 2500ms / 目标质量跨度 100pp（待标定；非同源矩阵缺失期间 R2-a MMR 谓词 locked）",
})

// ============================================================================
// 账本（工厂；无 IO / 无时钟）
// ============================================================================

/** 回退策略（无调用级闭包缓存：每次回退由调用方传 ctx，避免共享账本持陈旧调用数据）。 */
export type RetrievalRollback<C = undefined, T = unknown> = (ctx: C) => T

export interface RetrievalBudgetLedger {
  /** 显式登记路径回退策略（重复登记同路径 fail-loud——回退语义必须唯一）。 */
  registerRollback<C, T>(path: string, rollback: RetrievalRollback<C, T>): void
  /** 幂等登记（生产调用点用：重置账本后首个调用自动补登记）。 */
  ensureRollback<C, T>(path: string, rollback: RetrievalRollback<C, T>): void
  /** 预算裁决（未登记路径 fail-loud；观察层，不改行为）。 */
  check(path: string, measuredMs: number): RetrievalBudgetVerdict
  /** 调用已登记回退策略（ctx 为本次调用的上下文；未登记 fail-loud）。 */
  rollback<C, T>(path: string, ctx: C): T
  /** 已登记回退的路径集合（诊断）。 */
  rollbackPaths(): string[]
  /** 裁决记录（累计，诊断/账本输出）。 */
  readonly verdicts: readonly RetrievalBudgetVerdict[]
  /** 预算契约快照（数值口径真源）。 */
  readonly budget: RetrievalBudget
}

/** 创建账本（独立实例，测试可隔离；注入 budget 时先过 zod strict）。 */
export function createRetrievalBudgetLedger(
  budget: RetrievalBudget = DEFAULT_RETRIEVAL_BUDGET,
): RetrievalBudgetLedger {
  const parsed = RETRIEVAL_BUDGET_SCHEMA.safeParse(budget)
  if (!parsed.success) {
    throw new RetrievalBudgetError(`预算契约非法：${parsed.error.message}`)
  }
  const entries = new Map(parsed.data.entries.map((entry) => [entry.path, entry]))
  const rollbacks = new Map<string, RetrievalRollback<never, unknown>>()
  const verdicts: RetrievalBudgetVerdict[] = []

  const check = (path: string, measuredMs: number): RetrievalBudgetVerdict => {
    if (typeof measuredMs !== "number" || !Number.isFinite(measuredMs) || measuredMs < 0) {
      throw new RetrievalBudgetError(`measuredMs 非法：${String(measuredMs)}`)
    }
    const entry = entries.get(path)
    if (!entry) {
      throw new RetrievalBudgetError(
        `未登记路径：${path}（合法路径：${[...entries.keys()].join(" / ")}）`,
      )
    }
    // 封顶语义：严格小于预算才算 within；达到上限（= 封顶）即回退动作
    // （真实超时恰好落在上限——计时器不会超自身上限，故上限即回退边界）。
    const within = measuredMs < entry.budgetMs
    const verdict = RETRIEVAL_BUDGET_VERDICT_SCHEMA.parse({
      path,
      measuredMs,
      budgetMs: entry.budgetMs,
      within,
      exceededByMs: within ? 0 : Math.max(0, measuredMs - entry.budgetMs),
      action: within ? "allow" : "reject_fallback",
      rollbackRegistered: rollbacks.has(path),
    })
    verdicts.push(verdict)
    return verdict
  }

  return {
    registerRollback(path, rollback) {
      if (!entries.has(path)) {
        throw new RetrievalBudgetError(`未登记路径：${path}（不得为未知路径登记回退）`)
      }
      if (rollbacks.has(path)) {
        throw new RetrievalBudgetError(`路径回退重复登记：${path}`)
      }
      rollbacks.set(path, rollback as RetrievalRollback<never, unknown>)
    },
    ensureRollback(path, rollback) {
      if (!entries.has(path)) {
        throw new RetrievalBudgetError(`未登记路径：${path}（不得为未知路径登记回退）`)
      }
      if (!rollbacks.has(path)) rollbacks.set(path, rollback as RetrievalRollback<never, unknown>)
    },
    check,
    rollback<C, T>(path: string, ctx: C): T {
      const fn = rollbacks.get(path)
      if (!fn) {
        throw new RetrievalBudgetError(`路径回退未登记：${path}（超预算时无回退即 fail-loud）`)
      }
      return (fn as unknown as RetrievalRollback<C, T>)(ctx)
    },
    rollbackPaths: () => [...rollbacks.keys()],
    get verdicts() {
      return verdicts
    },
    get budget() {
      return parsed.data
    },
  }
}

/**
 * 进程级共享账本（生产调用点使用；测试用 createRetrievalBudgetLedger 隔离实例）。
 * 调用点首次经过时登记各自回退函数（见 search-adapter / context-engine 接线）。
 */
let sharedLedger: RetrievalBudgetLedger | undefined

export function getRetrievalBudgetLedger(): RetrievalBudgetLedger {
  if (!sharedLedger) sharedLedger = createRetrievalBudgetLedger()
  return sharedLedger
}

/** 重置进程级共享账本（仅测试用；生产不调用）。 */
export function resetRetrievalBudgetLedger(): void {
  sharedLedger = undefined
}

/** 便捷裁决（生产调用点；等价于 getRetrievalBudgetLedger().check）。 */
export function checkRetrievalBudget(path: string, measuredMs: number): RetrievalBudgetVerdict {
  return getRetrievalBudgetLedger().check(path, measuredMs)
}
