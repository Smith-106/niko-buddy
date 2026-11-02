import { describe, expect, it } from "vitest"
import { RESERVED_CANON_RULES_CHARS } from "@/lib/context-budget"
import {
  CANON_RULES_BUDGET_EXCEEDED_KEY,
  CONTEXT_DROP_ORDER,
  PROTECTED_COMPACT_FIELDS,
  RESTORE_PACK_BUDGET_CHARS,
  allowHalfOpenProbe,
  buildCanonRulesBudgetExceeded,
  buildRestorePack,
  compactContextSections,
  createCompactBreaker,
  createCompactWatchdog,
  emitBudgetExceeded,
  estimateCompactTokens,
  feedCompactHeartbeat,
  pollCompactWatchdog,
  recordCompactFailure,
  recordCompactSuccess,
  type BudgetExceededRecord,
} from "./context-compact"

// §GAP-103(f) RV-004/RV-014 漂移护栏：trim fields 表键快照（27 键，与 CONTEXT_DROP_ORDER 同源）。
// 单边增键/删键/改名即红；改顺序需同步更新本快照 + droporder.spec。
const TRIM_FIELDS_SNAPSHOT: string[] = [
  "graphSearchResults", "searchResults", "references", "referenceBindings", "relatedChapters",
  "communitySummaries", "kbReferences", "recentChapterContents", "recentSummaries", "characterAuras",
  "cognitionStates", "relatedSettings", "techniqueBlocks", "previousChapterEnding", "timeline",
  "characterStates", "foreshadowingStates", "soulDoc", "writingStyle", "voiceStyleGuide",
  "revisionDirectives", "nextChapterAdvice", "mustDo", "chapterGoal", "recentStateDeltas",
  "narrativeVisibility", "worldBlueprint",
];

function bigSections(): Record<string, string> {
  return {
    task: "写第 10 章",
    outline: "大纲".repeat(500),
    canonRules: "正史规则".repeat(300),
    mustAvoid: "禁区".repeat(200),
    graphSearchResults: "图谱".repeat(2000),
    searchResults: "检索".repeat(2000),
    recentChapterContents: "正文".repeat(3000),
    recentSummaries: "摘要".repeat(500),
    characterStates: "人物".repeat(500),
    soulDoc: "灵魂".repeat(500),
  }
}

describe("estimateCompactTokens CJK 口径", () => {
  it("中文 ≈1.5 字符/token（与 contextPackToPrompt 同源）", () => {
    expect(estimateCompactTokens("状".repeat(150))).toBe(100)
    expect(estimateCompactTokens("abcd")).toBe(1)
    expect(estimateCompactTokens("")).toBe(0)
  })
})

describe("buildRestorePack 恢复包", () => {
  it("任务 + 大纲锚点 + 角色快照恒非空且有预算上限", () => {
    const pack = buildRestorePack({
      task: "写第 10 章",
      outline: "大纲".repeat(2000),
      characterStates: "林默站在城头。\n第二行",
      chapterGoal: "目标",
    })
    expect(pack).toContain("写第 10 章")
    expect(pack).toContain("大纲锚点")
    expect(pack).toContain("林默站在城头。")
    expect(pack.length).toBeLessThanOrEqual(RESTORE_PACK_BUDGET_CHARS + 1)
  })

  it("task 为空时退化不断言失败", () => {
    const pack = buildRestorePack({ task: "", outline: "大纲锚点" })
    expect(pack).toContain("大纲锚点")
  })
})

describe("compactContextSections 四级压缩", () => {
  it("预算充足 → none，不动段", () => {
    const r = compactContextSections(bigSections(), { tokenBudget: 1_000_000 })
    expect(r.level).toBe("none")
    expect(r.gaps).toHaveLength(0)
    expect(r.skipped).toBe(false)
    expect(r.restorePack).toContain("写第 10 章")
  })

  it("轻度超预算 → lightTrim 先丢 graphSearchResults（dropOrder 最先）", () => {
    const sections = bigSections()
    const before = estimateCompactTokens(sections.graphSearchResults)
    void before
    const r = compactContextSections(sections, { tokenBudget: 3000 })
    expect(["lightTrim", "storeSummary", "fullSummary"]).toContain(r.level)
    // graphSearchResults 应被优先压缩（gap 第一位或已被删除）
    const refs = r.gaps.map((g) => g.ref)
    expect(refs).toContain("graphSearchResults")
    // protected 段永不经 lightTrim/storeSummary 丢弃
    expect(r.sections.canonRules).toBeDefined()
    expect(r.sections.task).toBe("写第 10 章")
  })

  it("storeSummary 级：旧正文 → 现成摘要占位（零 LLM）", () => {
    const sections = bigSections()
    const r = compactContextSections(sections, {
      tokenBudget: 2500,
      chapterSummaries: ["前章摘要一", "前章摘要二"],
    })
    expect(["storeSummary", "fullSummary", "lightTrim"]).toContain(r.level)
    if (r.level === "storeSummary") {
      expect(r.sections.recentChapterContents).toContain("前章摘要一")
    }
  })

  it("深度超预算 → fullSummary 只剩 protected 段", () => {
    const r = compactContextSections(bigSections(), { tokenBudget: 100 })
    expect(r.level).toBe("fullSummary")
    for (const key of Object.keys(r.sections)) {
      if (key === "restorePack") continue
      expect(PROTECTED_COMPACT_FIELDS.has(key) || ["mustAvoid", "outline", "canonRules"].includes(key)).toBe(true)
    }
  })

  it("IC-02：每次压缩显式记 gap", () => {
    const r = compactContextSections(bigSections(), { tokenBudget: 2000 })
    expect(r.gaps.length).toBeGreaterThan(0)
    for (const g of r.gaps) {
      expect(g.type).toBe("compressed")
      expect(g.originalLength).toBeGreaterThanOrEqual(g.retainedLength)
    }
  })

  it("dropOrder 登记覆盖主要可丢段", () => {
    for (const key of ["searchResults", "recentSummaries", "characterStates", "soulDoc"]) {
      expect(CONTEXT_DROP_ORDER[key]).toBeDefined()
    }
  })

  it("RV-004/RV-014: trim fields 表与 CONTEXT_DROP_ORDER 键序逐位一致（§GAP-103(f) 漂移护栏）", () => {
    // RV-001 根治 v2：双锚 — (1) 键声明序 == 快照序（重排键即红）；(2) 序值映射逐位一致
    // （交换两优先级数值即红 — 变异验证：swap 120/130 全绿暴露旧 .sort() 形态空洞，已根治）。
    expect(Object.keys(CONTEXT_DROP_ORDER)).toEqual(TRIM_FIELDS_SNAPSHOT)
    const orderVals = TRIM_FIELDS_SNAPSHOT.map((k) => (CONTEXT_DROP_ORDER as Record<string, number>)[k])
    const sortedVals = [...orderVals].sort((a, b) => a - b)
    expect(orderVals).toEqual(sortedVals)
    expect(new Set(orderVals).size).toBe(orderVals.length)
  })
})

// ============================================================================
// G5 (R5 缓解): canonRules 独立预留槽 + L4 零截断 + 超预算告警
// ============================================================================

describe("G5 canonRules 独立预留槽 + L4 零截断 + 超预算告警", () => {
  it("canonRules 零截断：超预算输入仍保留规则全文（L4 跳过预留槽，缓解 R5）", () => {
    const canonRules = "正史规则：宗门不得越级收徒；血脉不可外传。".repeat(300) // 6300 chars ≫ 预留槽
    const r = compactContextSections({ ...bigSections(), canonRules }, { tokenBudget: 100 })
    expect(r.level).toBe("fullSummary")
    // 规则全文保留：逐字相等（无省略号、无半裁）
    expect(r.sections.canonRules).toBe(canonRules)
    // canonRules 永不出现在压缩记账里（无论是 tier_compressible 还是 budget_exceeded 裁字）
    expect(r.gaps.some((g) => g.ref === "canonRules")).toBe(false)
    // 其他 protected 段仍走最后手段截断（零截断只限 canonRules）
    expect(r.sections.task).toBe("写第 10 章")
  })

  it("预留槽不足 → budget_exceeded 双记（trace + journal，含缺口字符数）+ rules.* 文案键", () => {
    const canonRules = "正史规则".repeat(1200) // 4800 chars > 3840 预留槽
    const trace: BudgetExceededRecord[] = []
    const journal: BudgetExceededRecord[] = []
    const r = compactContextSections(
      { ...bigSections(), canonRules },
      {
        tokenBudget: 100,
        canonRulesReserveChars: RESERVED_CANON_RULES_CHARS,
        budgetExceededSinks: { trace: (rec) => trace.push(rec), journal: (rec) => journal.push(rec) },
      },
    )
    expect(r.budgetExceeded).not.toBeNull()
    expect(r.budgetExceeded!.type).toBe("budget_exceeded")
    expect(r.budgetExceeded!.ref).toBe("canonRules")
    expect(r.budgetExceeded!.reservedChars).toBe(RESERVED_CANON_RULES_CHARS)
    expect(r.budgetExceeded!.canonRulesChars).toBe(canonRules.length)
    // 缺口字符数显式记账
    expect(r.budgetExceeded!.gapChars).toBe(canonRules.length - RESERVED_CANON_RULES_CHARS)
    // UI degraded 横幅文案键归 rules.* 命名空间
    expect(r.budgetExceeded!.messageKey).toBe(CANON_RULES_BUDGET_EXCEEDED_KEY)
    expect(r.budgetExceeded!.messageKey.startsWith("rules.")).toBe(true)
    // 告警不等于截断
    expect(r.budgetExceeded!.truncated).toBe(false)
    // trace + journal 各写一次（双记），且内容一致
    expect(trace).toHaveLength(1)
    expect(journal).toHaveLength(1)
    expect(trace[0]).toEqual(journal[0])
    expect(trace[0].gapChars).toBe(journal[0].gapChars)
    // 告警不换来裁字：规则仍全文保留
    expect(r.sections.canonRules).toBe(canonRules)
  })

  it("canonRules 在预留槽内 → 不告警、不记账（null）", () => {
    const trace: BudgetExceededRecord[] = []
    const r = compactContextSections(bigSections(), {
      tokenBudget: 1_000_000,
      budgetExceededSinks: { trace: (rec) => trace.push(rec) },
    })
    expect(r.level).toBe("none")
    expect(r.budgetExceeded).toBeNull()
    expect(trace).toHaveLength(0)
  })

  it("单侧 sink 缺失 → 显式报告未双记（不静默吞掉）", () => {
    const rec = buildCanonRulesBudgetExceeded({ canonRulesChars: 5_000 })
    expect(rec).not.toBeNull()
    expect(rec!.gapChars).toBe(5_000 - RESERVED_CANON_RULES_CHARS)
    const journalOnly: BudgetExceededRecord[] = []
    expect(emitBudgetExceeded(rec!, { journal: (r) => journalOnly.push(r) })).toEqual({
      trace: false,
      journal: true,
    })
    expect(journalOnly).toHaveLength(1)
    // 槽内 / 空规则不告警
    expect(buildCanonRulesBudgetExceeded({ canonRulesChars: 100 })).toBeNull()
    expect(buildCanonRulesBudgetExceeded({ canonRulesChars: 0 })).toBeNull()
  })
})

describe("compactContextSections 熔断器", () => {
  it("连续失败达阈值 → open，下轮跳过并告警", () => {
    const breaker = createCompactBreaker({ failureThreshold: 2, skipHalfOpenRounds: 10 })
    // 两次深度超预算压缩（仍超 → 失败）
    const tiny = 1
    compactContextSections(bigSections(), { tokenBudget: tiny, breaker })
    expect(breaker.consecutiveFailures).toBe(1)
    expect(breaker.open).toBe(false)
    compactContextSections(bigSections(), { tokenBudget: tiny, breaker })
    expect(breaker.open).toBe(true)
    // open 后跳过
    const skipped = compactContextSections(bigSections(), { tokenBudget: tiny, breaker })
    expect(skipped.skipped).toBe(true)
    expect(skipped.skipReason).toContain("熔断器")
  })

  it("成功清零失败计数并闭合", () => {
    const breaker = createCompactBreaker({ failureThreshold: 1 })
    recordCompactFailure(breaker)
    expect(breaker.open).toBe(true)
    recordCompactSuccess(breaker)
    expect(breaker.open).toBe(false)
    expect(breaker.consecutiveFailures).toBe(0)
  })

  it("半开：跳过 N 轮后允许 1 次探测", () => {
    const breaker = createCompactBreaker({ failureThreshold: 1, skipHalfOpenRounds: 2 })
    recordCompactFailure(breaker)
    expect(allowHalfOpenProbe(breaker)).toBe(false)
    expect(allowHalfOpenProbe(breaker)).toBe(true)
  })
})

describe("compact watchdog 桥接", () => {
  it("心跳刷新 + 卡死判定复用 watchdog 语义", () => {
    const wd = createCompactWatchdog({ stallTimeoutMs: 1000, now: 0 })
    feedCompactHeartbeat(wd, 500)
    expect(pollCompactWatchdog(wd, 1200).action).toBe("continue")
    expect(pollCompactWatchdog(wd, 1600).action).toBe("block_fallback")
  })
})
