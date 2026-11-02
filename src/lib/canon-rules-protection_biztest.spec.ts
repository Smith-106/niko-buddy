/**
 * canon-rules-protection_biztest.spec.ts — 业务验收 B6（世界规则保护：零截断 + 告警）。
 *
 * 用户视角的问题：「长篇写到 200 章，正史规则（canonRules）几十条；上下文挤爆时，
 * 我的世界规则会不会被悄悄裁掉一半？」
 *
 * 这条链路由两个真实模块串起来（不是各测一半）：
 *   1. `computeContextBudget(maxCtx)` 算出 canonRules 的**独立预留槽**（G5）；
 *   2. `compactContextSections(...)` 在超预算压缩时按该槽位判定：
 *      canonRules **零截断**（L4 也不裁），只记 `budget_exceeded` 容量告警
 *      （trace + journal 双记，含缺口字符数），其余 PROTECTED 段不丢。
 */
import { describe, expect, it } from "vitest"
import { RESERVED_CANON_RULES_CHARS, computeContextBudget } from "./context-budget"
import {
  CANON_RULES_BUDGET_EXCEEDED_KEY,
  PROTECTED_COMPACT_FIELDS,
  compactContextSections,
  type BudgetExceededRecord,
} from "./novel/context-compact"

/** 一份「挤爆」的上下文段表：规则超预留槽 + 大量可压缩语料。 */
function crowdedSections(canonRules: string) {
  return {
    task: "续写第 201 章：主角在城门受阻",
    outline: "第一幕：守军索要通行符。第二幕：旧铜钥匙换来单独问话。".repeat(20),
    canonRules,
    hardInject: "硬注入：不得越级收徒；血脉不可外传。",
    mustAvoid: "禁区：不得出现现代科技名词。".repeat(40),
    temporalFacts: "时序事实：城门换防在子时。",
    recentChapterContents: "正文摘录。".repeat(2_000),
    characterAuras: "角色气场。".repeat(1_500),
    timeline: "时间线。".repeat(1_500),
  }
}

describe("B6 超预算输入下 canonRules 全文保留（零截断）", () => {
  it("大窗口：规则超出预留槽仍逐字保留，并记 budget_exceeded 告警", () => {
    const budget = computeContextBudget(200_000)
    const reserve = budget.canonRulesReserve!
    expect(reserve.standardChars).toBe(RESERVED_CANON_RULES_CHARS)
    expect(reserve.reservedChars).toBe(RESERVED_CANON_RULES_CHARS)
    expect(reserve.clamped).toBe(false)

    // 9000 字符 ≫ 3840 预留槽。
    const canonRules = "正史规则：宗门不得越级收徒；血脉不可外传；地名不可改写。".repeat(200)
    expect(canonRules.length).toBeGreaterThan(reserve.reservedChars)

    const trace: BudgetExceededRecord[] = []
    const journal: BudgetExceededRecord[] = []
    const result = compactContextSections(crowdedSections(canonRules), {
      tokenBudget: 300,
      canonRulesReserveChars: reserve.reservedChars,
      budgetExceededSinks: { trace: (record) => trace.push(record), journal: (record) => journal.push(record) },
    })

    // 1) 零截断：逐字保留（不是「差不多」）。
    expect(result.sections.canonRules).toBe(canonRules)
    expect(result.sections.canonRules!.length).toBe(canonRules.length)
    // canonRules 永不出现在压缩记账里（既不是 tier_compressible，也不是 budget_exceeded 裁字）。
    expect(result.gaps.some((gap) => gap.ref === "canonRules")).toBe(false)

    // 2) 告警：budget_exceeded 结构化记录，缺口字符数如实。
    const alarm = result.budgetExceeded
    expect(alarm).not.toBeNull()
    expect(alarm!.type).toBe("budget_exceeded")
    expect(alarm!.ref).toBe("canonRules")
    expect(alarm!.reservedChars).toBe(RESERVED_CANON_RULES_CHARS)
    expect(alarm!.canonRulesChars).toBe(canonRules.length)
    expect(alarm!.gapChars).toBe(canonRules.length - RESERVED_CANON_RULES_CHARS)
    expect(alarm!.gapChars).toBeGreaterThan(0)
    // 是容量告警，不是截断记录。
    expect(alarm!.truncated).toBe(false)
    expect(alarm!.messageKey).toBe(CANON_RULES_BUDGET_EXCEEDED_KEY)
    expect(alarm!.messageKey.startsWith("rules.")).toBe(true)

    // 3) 双记：trace 与 journal 各一条，内容一致。
    expect(trace).toHaveLength(1)
    expect(journal).toHaveLength(1)
    expect(journal[0]).toEqual(trace[0])
  })

  it("小窗口（预留槽被挤到 0）也不裁规则：照样全文保留 + 告警", () => {
    const tight = computeContextBudget(4_000)
    const reserve = tight.canonRulesReserve!
    // 小窗口下预留槽无保障（clamped），但这不是「允许截断」的许可。
    expect(reserve.clamped).toBe(true)
    expect(reserve.reservedChars).toBeLessThan(RESERVED_CANON_RULES_CHARS)

    const canonRules = "正史规则：不得越级收徒。".repeat(400)
    const trace: BudgetExceededRecord[] = []
    const result = compactContextSections(crowdedSections(canonRules), {
      tokenBudget: 200,
      canonRulesReserveChars: reserve.reservedChars,
      budgetExceededSinks: { trace: (record) => trace.push(record) },
    })

    expect(result.sections.canonRules).toBe(canonRules)
    expect(result.budgetExceeded?.ref).toBe("canonRules")
    expect(result.budgetExceeded?.gapChars).toBeGreaterThan(0)
    expect(trace).toHaveLength(1)
  })

  it("规则在预留槽内 → 不告警、不记账（不制造假告警）", () => {
    const canonRules = "正史规则：不得越级收徒。"
    const trace: BudgetExceededRecord[] = []
    const result = compactContextSections(crowdedSections(canonRules), {
      tokenBudget: 300,
      canonRulesReserveChars: RESERVED_CANON_RULES_CHARS,
      budgetExceededSinks: { trace: (record) => trace.push(record) },
    })
    expect(result.sections.canonRules).toBe(canonRules)
    expect(result.budgetExceeded).toBeNull()
    expect(trace).toHaveLength(0)
  })
})

describe("B6 PROTECTED 字段不丢（超预算下仍可见）", () => {
  it("task / hardInject / canonRules 全文在；outline / mustAvoid 至少保留前半（不整段消失）", () => {
    const canonRules = "正史规则：宗门不得越级收徒；血脉不可外传。".repeat(300)
    const sections = crowdedSections(canonRules)
    const budget = computeContextBudget(200_000)

    const result = compactContextSections(sections, {
      tokenBudget: 200,
      canonRulesReserveChars: budget.canonRulesReserve!.reservedChars,
    })

    // 全文不动（最后手段也不裁）。
    expect(result.sections.task).toBe(sections.task)
    expect(result.sections.hardInject).toBe(sections.hardInject)
    expect(result.sections.canonRules).toBe(sections.canonRules)
    expect(result.sections.temporalFacts).toBe(sections.temporalFacts)

    // 最后手段截断的两段：仍在，且保留前半（不是被删）。
    expect(result.sections.outline).toBeDefined()
    expect(result.sections.outline!.length).toBeGreaterThan(0)
    expect(result.sections.outline!.endsWith("…")).toBe(true)
    expect(result.sections.mustAvoid).toBeDefined()
    expect(result.sections.mustAvoid!.length).toBeGreaterThan(0)

    // 可压缩语料被清掉（预算确实生效，不是「什么都没压缩」）。
    expect(result.level).toBe("fullSummary")
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore)
  })

  it("PROTECTED 名单本身包含世界规则与硬注入（口径真源）", () => {
    for (const field of ["task", "outline", "canonRules", "hardInject", "mustAvoid", "temporalFacts"]) {
      expect(PROTECTED_COMPACT_FIELDS.has(field)).toBe(true)
    }
  })
})
