/**
 * budget-counters.spec.ts — T34 BudgetCounters 收敛测试（墙钟全角色口径 + 分角色 token 软警告/硬封顶
 * + per-stage 预算分配表）。目标覆盖率 100%，纯函数零 mock。
 */

import { describe, expect, it } from "vitest"
import { ROUTE_ROLES } from "./control-sentinels"
import {
  DEFAULT_TOKEN_HARD_CAP_TOKENS,
  DEFAULT_TOKEN_SOFT_WARN_TOKENS,
  PER_STAGE_WALLCLOCK_BUDGETS_MIN,
  STAGE_BUDGET_TOTAL_MIN,
  WALLCLOCK_BUDGET_PER_CHAPTER_MS,
  applyStageBudgetOverrides,
  checkChapterWallclockGate,
  compareStageBudgets,
  createBudgetCounters,
  evaluateTokenGate,
  recordRoleCall,
  recordRoleWallclock,
  sumStageBudgetsMin,
  type StageMeasurement,
} from "./budget-counters"

// ── 常量哨兵 ──

describe("budget-counters 常量", () => {
  it("A/B 门槛④ 墙钟预算 = 45min/章", () => {
    expect(WALLCLOCK_BUDGET_PER_CHAPTER_MS).toBe(45 * 60 * 1000)
  })

  it("per-stage 分配表逐项等于蓝图口径（装配3/拆解2/brief2/draft20/review10/revision5/gate1/缓冲2）", () => {
    expect(PER_STAGE_WALLCLOCK_BUDGETS_MIN).toEqual({
      context_assembly: 3,
      scene_breakdown: 2,
      task_brief: 2,
      write_draft: 20,
      review: 10,
      revise: 5,
      judge: 1,
      buffer: 2,
    })
  })

  it("阶段预算合计恰为 45 分钟（与章级墙钟门槛自洽）", () => {
    expect(STAGE_BUDGET_TOTAL_MIN).toBe(45)
    expect(STAGE_BUDGET_TOTAL_MIN * 60_000).toBe(WALLCLOCK_BUDGET_PER_CHAPTER_MS)
  })

  it("token 默认档位占位值有序（软警告 < 硬封顶）", () => {
    expect(DEFAULT_TOKEN_SOFT_WARN_TOKENS).toBeGreaterThan(0)
    expect(DEFAULT_TOKEN_SOFT_WARN_TOKENS).toBeLessThan(DEFAULT_TOKEN_HARD_CAP_TOKENS)
  })

  it("角色字面量与 control-sentinels.ROUTE_ROLES 同步（零依赖复制的护栏断言）", () => {
    // budget-counters.ts 为保持 Node type-stripping 可直读而零 import；
    // 角色集合演进时两处必须同步——此断言防漂移。
    const BUDGET_ROLES = ["writer", "reviewer", "arbiter", "judge", "architect", "editor"] as const
    expect([...BUDGET_ROLES]).toEqual([...ROUTE_ROLES])
  })
})

// ── 计数器基础 ──

describe("createBudgetCounters / 墙钟全角色口径", () => {
  it("零值起点", () => {
    const c = createBudgetCounters()
    expect(c.schemaVersion).toBe("budget-counters/1.0")
    expect(c.wallclockMs).toBe(0)
    expect(c.callCount).toBe(0)
    expect(Object.keys(c.roles)).toHaveLength(0)
  })

  it("墙钟计入全部角色绑定调用（多角色求和，非单角色口径）", () => {
    const c = createBudgetCounters()
    recordRoleWallclock(c, "writer", 1000)
    recordRoleWallclock(c, "reviewer", 500)
    recordRoleWallclock(c, "judge", 250)
    expect(c.wallclockMs).toBe(1750)
    expect(c.callCount).toBe(3)
    expect(c.roles.writer.calls).toBe(1)
    // 子计数不含 wallclock 槽位（墙钟只在全角色累计层）。
    expect(Object.keys(c.roles.reviewer).sort()).toEqual(
      ["calls", "completionTokens", "hardCapped", "promptTokens", "role", "softWarned", "totalTokens"],
    )
  })

  it("recordRoleCall 与 recordRoleWallclock 同一口径累加", () => {
    const c = createBudgetCounters()
    recordRoleWallclock(c, "writer", 100)
    recordRoleCall(c, "writer", { wallclockMs: 50, promptTokens: 10, completionTokens: 5 })
    expect(c.wallclockMs).toBe(150)
    expect(c.callCount).toBe(2)
  })

  it("非法时长按 0 计但不丢弃调用本身（负数/NaN/Infinity 钳制）", () => {
    const c = createBudgetCounters()
    recordRoleCall(c, "writer", { wallclockMs: -5 })
    recordRoleCall(c, "writer", { wallclockMs: Number.NaN })
    recordRoleCall(c, "writer", { wallclockMs: Number.POSITIVE_INFINITY })
    expect(c.wallclockMs).toBe(0)
    expect(c.callCount).toBe(3)
    expect(c.roles.writer.calls).toBe(3)
  })
})

// ── 分角色 token 子计数 ──

describe("token 分角色子计数", () => {
  it("各角色独立累加互不串扰（prompt/completion/total/calls）", () => {
    const c = createBudgetCounters()
    recordRoleCall(c, "writer", { promptTokens: 100, completionTokens: 50 })
    recordRoleCall(c, "writer", { promptTokens: 10, completionTokens: 5 })
    recordRoleCall(c, "reviewer", { promptTokens: 7, completionTokens: 3 })
    expect(c.roles.writer.promptTokens).toBe(110)
    expect(c.roles.writer.completionTokens).toBe(55)
    expect(c.roles.writer.totalTokens).toBe(165)
    expect(c.roles.reviewer.totalTokens).toBe(10)
    expect(Object.keys(c.roles)).toHaveLength(2)
  })

  it("非法 token 输入按 0 计（负数/NaN/undefined）", () => {
    const c = createBudgetCounters()
    recordRoleCall(c, "writer", { promptTokens: -1, completionTokens: Number.NaN })
    recordRoleCall(c, "writer", {})
    expect(c.roles.writer.totalTokens).toBe(0)
  })
})

// ── 软警告 / 硬封顶 ──

describe("软警告 / 硬封顶裁定", () => {
  const cfg = { softWarnTokens: 100, hardCapTokens: 200 }

  it("未越线：无警告无封顶", () => {
    const c = createBudgetCounters()
    const v = recordRoleCall(c, "writer", { promptTokens: 40 }, cfg)
    expect(v).toEqual({ hardCapExceeded: false, softWarn: false, hardCapped: false })
    expect(c.roles.writer.softWarned).toBe(false)
  })

  it("恰好到达软警告线：置 softWarned 标记但本次不报 softWarn（严格越过才报）", () => {
    const c = createBudgetCounters()
    const v = recordRoleCall(c, "writer", { promptTokens: 100 }, cfg)
    expect(v.softWarn).toBe(false)
    expect(c.roles.writer.softWarned).toBe(true)
  })

  it("严格越过软警告线：报 softWarn 且标记落位", () => {
    const c = createBudgetCounters()
    const v = recordRoleCall(c, "writer", { promptTokens: 101 }, cfg)
    expect(v.softWarn).toBe(true)
    expect(v.hardCapExceeded).toBe(false)
    expect(c.roles.writer.softWarned).toBe(true)
  })

  it("越过硬封顶：报 hardCapExceeded 并压制 softWarn（更严重信号主导）", () => {
    const c = createBudgetCounters()
    const v = recordRoleCall(c, "writer", { promptTokens: 201 }, cfg)
    expect(v.hardCapExceeded).toBe(true)
    expect(v.softWarn).toBe(false)
    expect(v.hardCapped).toBe(true)
    expect(c.roles.writer.hardCapped).toBe(true)
  })

  it("恰好到达硬封顶线：不算 exceeded，但门禁将拦截后续调用", () => {
    const c = createBudgetCounters()
    const v = recordRoleCall(c, "writer", { promptTokens: 200 }, cfg)
    expect(v.hardCapExceeded).toBe(false)
    const gate = evaluateTokenGate(c, "writer", cfg)
    expect(gate.allowed).toBe(false)
  })

  it("硬封顶后累计态持续（hardCapped 标记不回退）", () => {
    const c = createBudgetCounters()
    recordRoleCall(c, "writer", { promptTokens: 500 }, cfg)
    const v2 = recordRoleCall(c, "writer", { promptTokens: 1 }, cfg)
    expect(v2.hardCapped).toBe(true)
    expect(v2.hardCapExceeded).toBe(true)
  })

  it("缺省配置走 DEFAULT 占位档位路径（不传 config 不误判小用量）", () => {
    const c = createBudgetCounters()
    const v = recordRoleCall(c, "writer", { promptTokens: 42 })
    expect(v.hardCapExceeded).toBe(false)
    expect(v.softWarn).toBe(false)
    expect(DEFAULT_TOKEN_SOFT_WARN_TOKENS).toBeLessThan(DEFAULT_TOKEN_HARD_CAP_TOKENS)
  })
})

describe("evaluateTokenGate before-call 门禁", () => {
  const cfg = { softWarnTokens: 100, hardCapTokens: 200 }

  it("无子计数的角色直接放行", () => {
    expect(evaluateTokenGate(createBudgetCounters(), "writer", cfg)).toEqual({ allowed: true, softWarn: false })
  })

  it("达到硬封顶 → 拒绝；达到软警告 → 放行+警告", () => {
    const c = createBudgetCounters()
    recordRoleCall(c, "writer", { promptTokens: 150 }, cfg)
    expect(evaluateTokenGate(c, "writer", cfg)).toEqual({ allowed: true, softWarn: true })
    recordRoleCall(c, "writer", { promptTokens: 60 }, cfg)
    expect(evaluateTokenGate(c, "writer", cfg)).toEqual({ allowed: false, softWarn: false })
  })

  it("非法阈值（<=0/NaN）视为未配置放行（哨兵不被坏配置静默关闭为拒绝）", () => {
    const c = createBudgetCounters()
    recordRoleCall(c, "writer", { promptTokens: 999999 })
    expect(evaluateTokenGate(c, "writer", { hardCapTokens: 0 }).allowed).toBe(true)
    expect(evaluateTokenGate(c, "writer", { hardCapTokens: -5 }).allowed).toBe(true)
    expect(evaluateTokenGate(c, "writer", { softWarnTokens: Number.NaN })).toEqual({ allowed: true, softWarn: false })
  })
})

// ── per-stage 预算分配表 ──

describe("applyStageBudgetOverrides 校准覆盖", () => {
  it("无覆盖时返回默认表副本（不改写常量本身）", () => {
    const t = applyStageBudgetOverrides()
    expect(t).toEqual(PER_STAGE_WALLCLOCK_BUDGETS_MIN)
    t.write_draft = 99
    expect(PER_STAGE_WALLCLOCK_BUDGETS_MIN.write_draft).toBe(20)
  })

  it("部分覆盖生效，未提供项沿用默认", () => {
    const t = applyStageBudgetOverrides({ write_draft: 25, review: 8 })
    expect(t.write_draft).toBe(25)
    expect(t.review).toBe(8)
    expect(t.context_assembly).toBe(3)
  })

  it("非法覆盖值被忽略（负数/0/NaN/Infinity）", () => {
    const t = applyStageBudgetOverrides({
      write_draft: -1,
      review: 0,
      revise: Number.NaN,
      judge: Number.POSITIVE_INFINITY,
      buffer: 4,
    })
    expect(t.write_draft).toBe(20)
    expect(t.review).toBe(10)
    expect(t.revise).toBe(5)
    expect(t.judge).toBe(1)
    expect(t.buffer).toBe(4)
  })

  it("undefined 覆盖等同默认表", () => {
    expect(applyStageBudgetOverrides(undefined)).toEqual({ ...PER_STAGE_WALLCLOCK_BUDGETS_MIN })
  })
})

describe("compareStageBudgets 实测比对", () => {
  it("sumStageBudgetsMin 对任意生效表求和", () => {
    expect(sumStageBudgetsMin(applyStageBudgetOverrides())).toBe(45)
    expect(sumStageBudgetsMin(applyStageBudgetOverrides({ write_draft: 25 }))).toBe(50)
  })

  it("未超支 ok / 超支 OVER 带 overByMs", () => {
    const measured: StageMeasurement[] = [
      { stage: "write_draft", durationMs: 19 * 60_000 },
      { stage: "review", durationMs: 11 * 60_000 },
    ]
    const [draft, review] = compareStageBudgets(measured)
    expect(draft.status).toBe("ok")
    expect(draft.overByMs).toBe(0)
    expect(review.status).toBe("over")
    expect(review.overByMs).toBe(60_000)
  })

  it("表外阶段标 unknownStage 且不判超（不静默吞墙钟）", () => {
    const [c] = compareStageBudgets([{ stage: "mystery_stage", durationMs: 999_999 }])
    expect(c.unknownStage).toBe(true)
    expect(c.budgetMs).toBe(0)
    expect(c.status).toBe("ok")
    expect(c.overByMs).toBe(0)
  })

  it("校准表参与比对 + 非法时长钳制为 0", () => {
    const table = applyStageBudgetOverrides({ judge: 2 })
    const checks = compareStageBudgets(
      [{ stage: "judge", durationMs: 3 * 60_000 }, { stage: "buffer", durationMs: Number.NaN }],
      table,
    )
    expect(checks[0].status).toBe("over")
    expect(checks[0].budgetMs).toBe(2 * 60_000)
    expect(checks[1].durationMs).toBe(0)
    expect(checks[1].status).toBe("ok")
  })
})

describe("checkChapterWallclockGate A/B 门槛④", () => {
  it("≤45min 通过", () => {
    const g = checkChapterWallclockGate(44 * 60_000)
    expect(g.pass).toBe(true)
    expect(g.overByMs).toBe(0)
  })

  it(">45min 判超并给出超出量", () => {
    const g = checkChapterWallclockGate(46 * 60_000)
    expect(g.pass).toBe(false)
    expect(g.overByMs).toBe(60_000)
  })

  it("恰好 45min 通过；非法输入钳制为 0 后通过；自定义预算生效", () => {
    expect(checkChapterWallclockGate(45 * 60_000).pass).toBe(true)
    expect(checkChapterWallclockGate(Number.NaN).pass).toBe(true)
    expect(checkChapterWallclockGate(-1).wallclockMs).toBe(0)
    const custom = checkChapterWallclockGate(30 * 60_000, 29 * 60_000)
    expect(custom.pass).toBe(false)
    expect(custom.overByMs).toBe(60_000)
  })
})
