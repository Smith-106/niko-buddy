/**
 * retrieval-budget.spec — R0-d 延迟-成本预算账本测试。
 * 覆盖：契约数值（2500/2500/45000 逐字对齐迁移前）/ 裁决边界（≤预算 allow，
 * >预算 reject_fallback + exceededByMs）/ 未登记路径与重复回退 fail-loud /
 * 回退调用语义（无回退 fail-loud）/ λ 初值（25 ms/pp，calibrated=false）/
 * 超时语义等价（真实链路 runSearchBranch：2500ms 超时 → 回退 [] 且账本记账）。
 *
 * @license MIT © Niko Buddy
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_RETRIEVAL_BUDGET,
  LLM_RERANK_TIMEOUT_MS,
  LAMBDA_MS_PER_PP_INITIAL,
  RETRIEVAL_BUDGET_PATHS,
  RETRIEVAL_BUDGET_SCHEMA,
  RETRIEVAL_LAMBDA_SCHEMA,
  RETRIEVAL_LAMBDA_INITIAL,
  RETRIEVAL_SOURCE_TIMEOUT_MS,
  RetrievalBudgetError,
  ZERO_LLM_DEFAULT_BUDGET_MS,
  createRetrievalBudgetLedger,
} from "./retrieval-budget"

describe("R0-d 契约数值（迁移前后逐字对齐）", () => {
  it("单源封顶 2500ms / 零 LLM 线 2500ms / LLM rerank 45000ms", () => {
    expect(RETRIEVAL_SOURCE_TIMEOUT_MS).toBe(2500)
    expect(ZERO_LLM_DEFAULT_BUDGET_MS).toBe(2500)
    expect(LLM_RERANK_TIMEOUT_MS).toBe(45000)
    expect(DEFAULT_RETRIEVAL_BUDGET.sourceTimeoutMs).toBe(2500)
    expect(DEFAULT_RETRIEVAL_BUDGET.entries).toHaveLength(3)
    expect(RETRIEVAL_BUDGET_SCHEMA.safeParse(DEFAULT_RETRIEVAL_BUDGET).success).toBe(true)
  })

  it("契约 strict：数值漂移（如 2500→3000）即校验失败", () => {
    const drifted = { ...DEFAULT_RETRIEVAL_BUDGET, sourceTimeoutMs: 3000 }
    expect(RETRIEVAL_BUDGET_SCHEMA.safeParse(drifted).success).toBe(false)
  })

  it("零 LLM 路径预算不得宽于单源封顶（口径不变量）", () => {
    const zeroLlm = DEFAULT_RETRIEVAL_BUDGET.entries.find((e) => e.kind === "zero_llm")
    expect(zeroLlm?.budgetMs).toBeLessThanOrEqual(RETRIEVAL_SOURCE_TIMEOUT_MS)
  })
})

describe("R0-d 裁决（观察层）", () => {
  it("< 预算 → allow；达上限（= 封顶）→ reject_fallback（exceededByMs 0）；超上限带超出量", () => {
    const ledger = createRetrievalBudgetLedger()
    const within = ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, 2499)
    expect(within.within).toBe(true)
    expect(within.action).toBe("allow")
    expect(within.exceededByMs).toBe(0)
    // 封顶边界：达到 2500ms 即回退动作（真实超时恰好落在上限）
    const atCap = ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, 2500)
    expect(atCap.within).toBe(false)
    expect(atCap.action).toBe("reject_fallback")
    expect(atCap.exceededByMs).toBe(0)
    const over = ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, 2600)
    expect(over.within).toBe(false)
    expect(over.action).toBe("reject_fallback")
    expect(over.exceededByMs).toBe(100)
    expect(ledger.verdicts).toHaveLength(3)
  })

  it("未登记路径 fail-loud（并列出合法路径）", () => {
    const ledger = createRetrievalBudgetLedger()
    expect(() => ledger.check("source:unknown", 1)).toThrow(RetrievalBudgetError)
    expect(() => ledger.check("source:unknown", 1)).toThrow(/未登记路径/)
  })

  it("measuredMs 非法（负数 / NaN / 非数字）fail-loud", () => {
    const ledger = createRetrievalBudgetLedger()
    expect(() => ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, -1)).toThrow(RetrievalBudgetError)
    expect(() => ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, Number.NaN)).toThrow(
      RetrievalBudgetError,
    )
  })
})

describe("R0-d 回退注册表", () => {
  it("登记后可通过 rollback 调用（ctx 为调用级数据，无陈旧闭包）", () => {
    const ledger = createRetrievalBudgetLedger()
    ledger.registerRollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, () => [])
    expect(ledger.rollbackPaths()).toEqual([RETRIEVAL_BUDGET_PATHS.searchBranch])
    expect(ledger.rollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, undefined)).toEqual([])
    const verdict = ledger.check(RETRIEVAL_BUDGET_PATHS.searchBranch, 3000)
    expect(verdict.rollbackRegistered).toBe(true)
  })

  it("调用级 ctx 回退：策略每次取当次数据（共享账本不持调用级快照）", () => {
    const ledger = createRetrievalBudgetLedger()
    ledger.registerRollback<string[], string[]>(
      RETRIEVAL_BUDGET_PATHS.contextRerank,
      (ctx) => ctx,
    )
    expect(ledger.rollback<string[], string[]>(RETRIEVAL_BUDGET_PATHS.contextRerank, ["第一次"])).toEqual([
      "第一次",
    ])
    expect(ledger.rollback<string[], string[]>(RETRIEVAL_BUDGET_PATHS.contextRerank, ["第二次"])).toEqual([
      "第二次",
    ])
  })

  it("ensureRollback 幂等（重置账本后首个调用自动补登记）", () => {
    const ledger = createRetrievalBudgetLedger()
    ledger.ensureRollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, () => [])
    ledger.ensureRollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, () => [1])
    expect(ledger.rollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, undefined)).toEqual([])
  })

  it("未登记回退即 fail-loud（超预算无回退不得静默）", () => {
    const ledger = createRetrievalBudgetLedger()
    expect(() =>
      ledger.rollback<undefined, unknown>(RETRIEVAL_BUDGET_PATHS.contextRerank, undefined),
    ).toThrow(/路径回退未登记/)
  })

  it("重复登记同路径 / 为未知路径登记一律 fail-loud", () => {
    const ledger = createRetrievalBudgetLedger()
    ledger.registerRollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, () => [])
    expect(() =>
      ledger.registerRollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, () => []),
    ).toThrow(/重复登记/)
    expect(() =>
      ledger.registerRollback<undefined, number[]>(RETRIEVAL_BUDGET_PATHS.searchBranch, () => []),
    ).toThrow(RetrievalBudgetError)
    expect(() =>
      ledger.registerRollback<undefined, number[]>("source:unknown", () => []),
    ).toThrow(/未登记路径/)
  })

  it("未登记回退时 verdict.rollbackRegistered=false（缺口可观测）", () => {
    const ledger = createRetrievalBudgetLedger()
    expect(ledger.check(RETRIEVAL_BUDGET_PATHS.contextRerank, 100).rollbackRegistered).toBe(false)
  })
})

describe("R0-d λ（MMR 成本系数初值）", () => {
  it("λ 初值 = 2500 / 100 = 25 ms/pp 且未标定（R2-a 谓词 locked 依据）", () => {
    expect(LAMBDA_MS_PER_PP_INITIAL).toBe(25)
    expect(RETRIEVAL_LAMBDA_SCHEMA.safeParse(RETRIEVAL_LAMBDA_INITIAL).success).toBe(true)
    expect(RETRIEVAL_LAMBDA_INITIAL.value).toBe(25)
    expect(RETRIEVAL_LAMBDA_INITIAL.unit).toBe("ms_per_pp")
    expect(RETRIEVAL_LAMBDA_INITIAL.calibrated).toBe(false)
    expect(RETRIEVAL_LAMBDA_INITIAL.basis).toContain("待标定")
  })
})
