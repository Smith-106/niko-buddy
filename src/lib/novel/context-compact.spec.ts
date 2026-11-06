import { describe, expect, it } from "vitest"
import { RESERVED_CANON_RULES_CHARS } from "@/lib/context-budget"
import {
  CANON_RULES_BUDGET_EXCEEDED_KEY,
  CANON_RULES_BUDGET_EXCEEDED_TEXT,
  CONTEXT_DROP_ORDER,
  PROTECTED_COMPACT_FIELDS,
  RESTORE_PACK_BUDGET_CHARS,
  allowHalfOpenProbe,
  buildCanonRulesBudgetExceeded,
  buildRestorePack,
  compactContextSections,
  compactSectionText,
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

  it("L1 微压缩后回到预算内 → 记成功并停在 microcompact（熔断计数清零）", () => {
    // 超预算 → 跑 L1；L1 只折空白就够回到预算内 → 停在 microcompact，
    // 不得继续往 lightTrim 丢内容，也不得把这次算成失败。
    const breaker = createCompactBreaker({ failureThreshold: 2 })
    recordCompactFailure(breaker)
    expect(breaker.consecutiveFailures).toBe(1)
    // 空白噪声段（非 protected）：4000 个换行经 L1 折成 2 个，token 从 ~1004 降到 ~5。
    const noisy = `检索结果${"\n".repeat(4000)}结尾`
    const r = compactContextSections({ searchResults: noisy }, { tokenBudget: 100, breaker })
    expect(r.level).toBe("microcompact")
    expect(r.skipped).toBe(false)
    expect(r.gaps.some((g) => g.ref === "searchResults" && g.reason === "tier_compressible")).toBe(true)
    // 只有 recordCompactSuccess 会把失败计数清零（未调用则仍为 1）
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

describe("compactSectionText 别名", () => {
  it("字符串原样透传", () => {
    expect(compactSectionText("hello")).toBe("hello")
  })

  it("字符串数组换行拼接", () => {
    expect(compactSectionText(["a", "b"])).toBe("a\nb")
  })

  it("混合数组非字符串项 JSON 序列化", () => {
    expect(compactSectionText(["a", 1, { x: 1 }] as unknown[])).toBe('a\n1\n{"x":1}')
  })

  it("null/undefined 兜空串", () => {
    expect(compactSectionText(null)).toBe("")
    expect(compactSectionText(undefined)).toBe("")
  })

  it("数字/布尔 String 化", () => {
    expect(compactSectionText(42 as unknown as string)).toBe("42")
    expect(compactSectionText(true as unknown as string)).toBe("true")
  })
})

describe("createCompactBreaker 参数护栏", () => {
  it("非法阈值退化为默认值", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, "x"]) {
      const b = createCompactBreaker({ failureThreshold: bad as unknown as number })
      expect(b.failureThreshold).toBe(3)
    }
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = createCompactBreaker({ skipHalfOpenRounds: bad })
      expect(b.skipHalfOpenRounds).toBe(2)
    }
  })

  it("小数下取整", () => {
    const b = createCompactBreaker({ failureThreshold: 2.9, skipHalfOpenRounds: 1.9 })
    expect(b.failureThreshold).toBe(2)
    expect(b.skipHalfOpenRounds).toBe(1)
  })
})

describe("breaker 增补语义", () => {
  it("非 open 直接允许探测", () => {
    expect(allowHalfOpenProbe(createCompactBreaker())).toBe(true)
  })

  it("已 open 下再次失败返回 false 且保持 open", () => {
    const breaker = createCompactBreaker({ failureThreshold: 1 })
    expect(recordCompactFailure(breaker)).toBe(true)
    expect(recordCompactFailure(breaker)).toBe(false)
    expect(breaker.open).toBe(true)
    expect(breaker.consecutiveFailures).toBe(2)
  })

  it("CANON 文案键与默认文案同源非空", () => {
    expect(CANON_RULES_BUDGET_EXCEEDED_KEY.startsWith("rules.")).toBe(true)
    expect(CANON_RULES_BUDGET_EXCEEDED_TEXT).toContain("正史规则")
  })
})

describe("buildCanonRulesBudgetExceeded 参数护栏", () => {
  it("负 canonRulesChars 归零 → null", () => {
    expect(buildCanonRulesBudgetExceeded({ canonRulesChars: -5 })).toBeNull()
  })

  it("非法 reservedChars 退化为标准参考线", () => {
    const r1 = buildCanonRulesBudgetExceeded({ canonRulesChars: RESERVED_CANON_RULES_CHARS + 10, reservedChars: -1 })
    expect(r1!.reservedChars).toBe(RESERVED_CANON_RULES_CHARS)
    const r2 = buildCanonRulesBudgetExceeded({ canonRulesChars: RESERVED_CANON_RULES_CHARS + 10, reservedChars: Number.NaN })
    expect(r2!.reservedChars).toBe(RESERVED_CANON_RULES_CHARS)
  })

  it("reservedChars 小数下取整", () => {
    const r = buildCanonRulesBudgetExceeded({ canonRulesChars: 5000, reservedChars: 4999.9 })
    expect(r!.reservedChars).toBe(4999)
    expect(r!.gapChars).toBe(1)
  })

  it("emitBudgetExceeded 无 sink 双 false、单 trace 显式报告", () => {
    const rec = buildCanonRulesBudgetExceeded({ canonRulesChars: 5000 })!
    expect(emitBudgetExceeded(rec, {})).toEqual({ trace: false, journal: false })
    const traced: BudgetExceededRecord[] = []
    expect(emitBudgetExceeded(rec, { trace: (r) => traced.push(r) })).toEqual({ trace: true, journal: false })
    expect(traced).toHaveLength(1)
  })
})

describe("compactContextSections 输入与恢复包", () => {
  it("非法预算(0/负/NaN) → none 且 breaker 记成功", () => {
    for (const bad of [0, -5, Number.NaN]) {
      const breaker = createCompactBreaker()
      const r = compactContextSections(bigSections(), { tokenBudget: bad, breaker })
      expect(r.level).toBe("none")
      expect(r.skipped).toBe(false)
      expect(breaker.consecutiveFailures).toBe(0)
    }
  })

  it("显式 restore 输入覆盖自动提取", () => {
    const r = compactContextSections({ task: "real" }, { tokenBudget: 1_000_000, restore: { task: "CUSTOM任务" } })
    expect(r.restorePack).toContain("CUSTOM任务")
    expect(r.restorePack).not.toContain("real")
  })

  it("缺 task 时恢复包退化不断言失败", () => {
    const r = compactContextSections({ outline: "大纲锚点" }, { tokenBudget: 1_000_000 })
    expect(r.level).toBe("none")
    expect(r.restorePack).toContain("任务缺失")
  })

  it("空串/undefined 输入被过滤", () => {
    const r = compactContextSections(
      { task: "t", empty: "", missing: undefined } as unknown as Record<string, string>,
      { tokenBudget: 1_000_000 },
    )
    expect(Object.keys(r.sections)).toEqual(["task"])
  })
})

describe("compactContextSections L1/L2 增补", () => {
  it("microcompact：空白清理后恰好入预算", () => {
    const dirty = `${"a".repeat(400)}  \n\n`
    const cleaned = `${"a".repeat(400)}`
    const task = "写第 10 章"
    const budget = estimateCompactTokens(task) + estimateCompactTokens(cleaned)
    expect(estimateCompactTokens(task) + estimateCompactTokens(dirty)).toBeGreaterThan(budget)
    const r = compactContextSections({ task, searchResults: dirty }, { tokenBudget: budget })
    expect(r.level).toBe("microcompact")
    expect(r.gaps.map((g) => g.ref)).toContain("searchResults")
    expect(r.sections.searchResults).toBe(cleaned)
  })

  it("空白-only 段 L2 被跳过(continue)照常 lightTrim", () => {
    const r = compactContextSections(
      { task: "写第 10 章", wskey: "   \n\n", graphSearchResults: `${"g".repeat(600)}` },
      { tokenBudget: 100 },
    )
    expect(r.level).toBe("lightTrim")
    expect(r.sections.wskey).toBe("")
  })

  it("lightTrim 短段直接删除(retainedLength 0)仍达 lightTrim", () => {
    const sections = { task: "写第 10 章", u1: "x".repeat(150), u2: "x".repeat(150), u3: "x".repeat(150) }
    const r = compactContextSections(sections, { tokenBudget: 60 })
    expect(r.level).toBe("lightTrim")
    expect(r.sections.u1).toBeUndefined()
    expect(r.sections.u2).toBeUndefined()
    expect(r.sections.u3).toBeDefined()
    expect(r.gaps.filter((g) => g.retainedLength === 0).length).toBeGreaterThanOrEqual(2)
  })

  it("lightTrim 达标且带 breaker → 记成功", () => {
    const breaker = createCompactBreaker({ failureThreshold: 3 })
    const r = compactContextSections(
      { task: "写第 10 章", u1: "x".repeat(150), u2: "x".repeat(150), u3: "x".repeat(150) },
      { tokenBudget: 60, breaker },
    )
    expect(r.level).toBe("lightTrim")
    expect(breaker.consecutiveFailures).toBe(0)
    expect(breaker.open).toBe(false)
  })
})

describe("compactContextSections L3/L4 与熔断增补", () => {
  it("storeSummary 带 breaker → 替换后记成功", () => {
    const breaker = createCompactBreaker({ failureThreshold: 3 })
    const r = compactContextSections(
      { task: "写第 10 章", recentChapterContents: "正文".repeat(10000) },
      { tokenBudget: 3000, chapterSummaries: ["前章摘要一", "前章摘要二"], breaker },
    )
    expect(r.level).toBe("storeSummary")
    expect(r.sections.recentChapterContents).toContain("前章摘要一")
    expect(breaker.consecutiveFailures).toBe(0)
  })

  it("无摘要时跳过 storeSummary → fullSummary", () => {
    const r = compactContextSections(
      { task: "写第 10 章", recentChapterContents: "正文".repeat(10000) },
      { tokenBudget: 3000 },
    )
    expect(r.level).toBe("fullSummary")
    expect(r.sections.recentChapterContents).toBeUndefined()
  })

  it("无正文段时摘要无处可替 → fullSummary", () => {
    const r = compactContextSections(
      { task: "写第 10 章", searchResults: "检索".repeat(10000) },
      { tokenBudget: 3000, chapterSummaries: ["前章摘要一"] },
    )
    expect(r.level).toBe("fullSummary")
  })

  it("fullSummary 带 breaker 且余量入预算 → 记成功 skipReason 为空", () => {
    const breaker = createCompactBreaker({ failureThreshold: 5 })
    const budget = estimateCompactTokens("写第 10 章") + 2
    const r = compactContextSections(
      { task: "写第 10 章", graphSearchResults: "g".repeat(2000) },
      { tokenBudget: budget, breaker },
    )
    expect(r.level).toBe("fullSummary")
    expect(r.skipReason).toBe("")
    expect(breaker.consecutiveFailures).toBe(0)
    expect(breaker.open).toBe(false)
  })

  it("fullSummary 仍超预算但未达阈值 → 失败计数 skipReason 为空", () => {
    const breaker = createCompactBreaker({ failureThreshold: 5 })
    const r = compactContextSections(
      { task: "写第 10 章", graphSearchResults: "g".repeat(2000) },
      { tokenBudget: 1, breaker },
    )
    expect(r.level).toBe("fullSummary")
    expect(r.skipReason).toBe("")
    expect(breaker.consecutiveFailures).toBe(1)
    expect(breaker.open).toBe(false)
  })

  it("fullSummary 后 protected 余量已入预算 → mustAvoid/outline 不动", () => {
    const mustAvoid = "禁区".repeat(50)
    const outline = "大纲".repeat(50)
    const budget = estimateCompactTokens("写第 10 章") + estimateCompactTokens(mustAvoid) + estimateCompactTokens(outline) + 10
    const r = compactContextSections(
      { task: "写第 10 章", mustAvoid, outline, searchResults: "s".repeat(20000) },
      { tokenBudget: budget },
    )
    expect(r.level).toBe("fullSummary")
    expect(r.sections.mustAvoid).toBe(mustAvoid)
    expect(r.sections.outline).toBe(outline)
    expect(r.gaps.some((g) => g.reason === "budget_exceeded")).toBe(false)
  })

  it("open 熔断 + 半开允许 → 继续压缩不跳过", () => {
    const breaker = createCompactBreaker({ failureThreshold: 1, skipHalfOpenRounds: 1 })
    recordCompactFailure(breaker)
    expect(breaker.open).toBe(true)
    const r = compactContextSections(bigSections(), { tokenBudget: 1, breaker })
    expect(r.skipped).toBe(false)
    expect(r.level).toBe("fullSummary")
  })
})
