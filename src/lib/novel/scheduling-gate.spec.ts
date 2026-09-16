/**
 * scheduling-gate.spec.ts — 波1 EB-3 调度前置闸 spec 锁定.
 *
 * 覆盖: INV-7（调度裁定不含门控字段，类型级+运行时断言）+ token 硬封顶 reject /
 * 软警告 admit / 墙钟 defer + 重试三切面（retryable/content/fatal × attempt ×
 * 换模型）+ RoutePolicy schema/解析 + 路由自检报告（分歧/最便宜/最快）.
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import { createBudgetCounters, recordRoleCall, WALLCLOCK_BUDGET_PER_CHAPTER_MS } from "./budget-counters"
import {
  ROUTE_POLICY_SCHEMA,
  SchedulingGateInvariantError,
  assertNoGateFieldsInSchedulingResult,
  buildRoutingSelfCheckReport,
  evaluateRetryScheduling,
  evaluateSchedulingGate,
  normalizeRoutePolicy,
  resolveRouteModel,
  schedulingTierRole,
  type SchedulingGateResult,
} from "./scheduling-gate"

describe("evaluateSchedulingGate（配额熔断前置闸）", () => {
  it("正常配额 → admit(ok)", () => {
    const counters = createBudgetCounters()
    const r = evaluateSchedulingGate(counters, "writer")
    expect(r.decision).toBe("admit")
    expect(r.reason).toBe("ok")
    expect(r.quota.role).toBe("writer")
    expect(r.quota.totalTokens).toBe(0)
  })

  it("token 硬封顶 → reject（事件粒度停机，不写门控）", () => {
    const counters = createBudgetCounters()
    recordRoleCall(counters, "writer", { promptTokens: 100, completionTokens: 100 }, { hardCapTokens: 100 })
    const r = evaluateSchedulingGate(counters, "writer", { hardCapTokens: 100 })
    expect(r.decision).toBe("reject")
    expect(r.reason).toBe("quota_hard_cap_exceeded")
    expect(r.quota.hardCapped).toBe(true)
  })

  it("软警告越线 → admit 但 reason=soft_warn_notice（告警不挡）", () => {
    let counters = createBudgetCounters()
    recordRoleCall(counters, "critic", { promptTokens: 50 })
    const r = evaluateSchedulingGate(counters, "critic", { softWarnTokens: 10, hardCapTokens: 1000 })
    expect(r.decision).toBe("admit")
    expect(r.reason).toBe("soft_warn_notice")
  })

  it("墙钟超章级预算 → defer（资源让位不拒单）", () => {
    const counters = createBudgetCounters()
    const r = evaluateSchedulingGate(counters, "writer", {
      wallclockBudgetMs: WALLCLOCK_BUDGET_PER_CHAPTER_MS,
      wallclockMs: WALLCLOCK_BUDGET_PER_CHAPTER_MS,
    })
    expect(r.decision).toBe("defer")
    expect(r.reason).toBe("wallclock_budget_exceeded")
  })

  it("墙钟恰低于预算 → admit（边界含端点口径正确）", () => {
    const counters = createBudgetCounters()
    const r = evaluateSchedulingGate(counters, "writer", {
      wallclockBudgetMs: 1000,
      wallclockMs: 999,
    })
    expect(r.decision).toBe("admit")
  })

  it("INV-7 运行时断言：合法结果通过；携带门控字段的对象抛错", () => {
    const counters = createBudgetCounters()
    const r = evaluateSchedulingGate(counters, "writer")
    expect(() => assertNoGateFieldsInSchedulingResult(r)).not.toThrow()
    const rogue = { ...r, verdicts: { consistency: "fail" } } as unknown as SchedulingGateResult
    expect(() => assertNoGateFieldsInSchedulingResult(rogue)).toThrow(SchedulingGateInvariantError)
    const rogueQuota = { ...r, quota: { ...r.quota, gate: "consistency" } } as unknown as SchedulingGateResult
    expect(() => assertNoGateFieldsInSchedulingResult(rogueQuota)).toThrow(SchedulingGateInvariantError)
  })
})

describe("evaluateRetryScheduling（换模型重试/人工接管三切面之二）", () => {
  it("fatal → abort（不重试）", () => {
    expect(evaluateRetryScheduling({ attempt: 1, lastErrorKind: "fatal" })).toMatchObject({
      decision: "abort",
      reason: "fatal_abort",
    })
  })

  it("content → escalate（人工接管：换模型无益）", () => {
    expect(evaluateRetryScheduling({ attempt: 1, lastErrorKind: "content" })).toMatchObject({
      decision: "escalate",
      reason: "content_manual",
    })
  })

  it("retryable 未超限 → retry；提供 nextModelId → swap-model（换模型重试）", () => {
    expect(evaluateRetryScheduling({ attempt: 1, lastErrorKind: "retryable" })).toMatchObject({
      decision: "retry",
      reason: "retry_same_model",
    })
    expect(
      evaluateRetryScheduling({ attempt: 1, lastErrorKind: "retryable", nextModelId: "m2" }),
    ).toMatchObject({ decision: "swap-model", nextModelId: "m2", reason: "retry_swap_model" })
  })

  it("attempt 耗尽 → escalate（默认 3 次）", () => {
    expect(
      evaluateRetryScheduling({ attempt: 2, lastErrorKind: "retryable" }).decision,
    ).toBe("retry")
    expect(evaluateRetryScheduling({ attempt: 3, lastErrorKind: "retryable" })).toMatchObject({
      decision: "escalate",
      reason: "attempts_exhausted",
    })
    expect(
      evaluateRetryScheduling({ attempt: 2, lastErrorKind: "retryable", maxAttempts: 2 }).decision,
    ).toBe("escalate")
  })
})

describe("RoutePolicy（模块 21 设置底座）", () => {
  const policy = normalizeRoutePolicy({
    version: "route-policy/1.0",
    defaultModelId: "m-default",
    roleBindings: {
      writer: { modelId: "m-writer", fallbacks: ["m-fb"] },
      judge: { modelId: "m-judge", fallbacks: [] },
    },
  })

  it("schema 校验：合法通过；非法 version/未知字段拒绝", () => {
    expect(() => ROUTE_POLICY_SCHEMA.parse({ version: "route-policy/1.0", defaultModelId: "m" })).not.toThrow()
    expect(() => normalizeRoutePolicy({ version: "route-policy/9.9", defaultModelId: "m" })).toThrow(
      SchedulingGateInvariantError,
    )
    expect(() =>
      ROUTE_POLICY_SCHEMA.parse({ version: "route-policy/1.0", defaultModelId: "m", rogue: 1 }),
    ).toThrow()
  })

  it("resolveRouteModel：绑定角色走绑定+fallback；未绑定走默认", () => {
    const writer = resolveRouteModel(policy, "writer")
    expect(writer).toEqual({ modelId: "m-writer", fallbacks: ["m-fb"], usedDefault: false })
    const critic = resolveRouteModel(policy, "critic")
    expect(critic).toEqual({ modelId: "m-default", fallbacks: [], usedDefault: true })
  })

  it("schedulingTierRole：analysis → judge，其余 → writer（T33 对齐）", () => {
    expect(schedulingTierRole("analysis")).toBe("judge")
    expect(schedulingTierRole("complex")).toBe("writer")
    expect(schedulingTierRole("simple")).toBe("writer")
  })
})

describe("buildRoutingSelfCheckReport（路由自检，模块 21 超越点）", () => {
  const entries = [
    { modelId: "m1", gateVerdicts: { consistency: "pass", anti_ai: "pass" }, tokens: 100, wallclockMs: 5000, passed: true },
    { modelId: "m2", gateVerdicts: { consistency: "fail", anti_ai: "pass" }, tokens: 80, wallclockMs: 4000, passed: false },
    { modelId: "m3", gateVerdicts: { consistency: "pass", anti_ai: "fail" }, tokens: 60, wallclockMs: 6000, passed: false },
  ]

  it("多数 P0 裁定 + 分歧模型检出", () => {
    const report = buildRoutingSelfCheckReport("fixture-1", entries)
    expect(report.fixtureId).toBe("fixture-1")
    expect(report.divergentModels).toEqual(["m2"])
  })

  it("通过模型中最便宜/最快（仅 passed 计入）", () => {
    const report = buildRoutingSelfCheckReport("fixture-1", [
      ...entries,
      { modelId: "m4", gateVerdicts: { consistency: "pass" }, tokens: 200, wallclockMs: 1000, passed: true },
    ])
    expect(report.cheapestPassing).toBe("m1")
    expect(report.fastestPassing).toBe("m4")
  })

  it("全体一致 → divergentModels 为空；空输入 → 平凡报告", () => {
    expect(buildRoutingSelfCheckReport("f", [entries[0], entries[2]]).divergentModels).toEqual([])
    const empty = buildRoutingSelfCheckReport("f", [])
    expect(empty.divergentModels).toEqual([])
    expect(empty.cheapestPassing).toBeUndefined()
  })
})