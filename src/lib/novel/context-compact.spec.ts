import { describe, expect, it } from "vitest"
import {
  CONTEXT_DROP_ORDER,
  PROTECTED_COMPACT_FIELDS,
  RESTORE_PACK_BUDGET_CHARS,
  allowHalfOpenProbe,
  buildRestorePack,
  compactContextSections,
  createCompactBreaker,
  createCompactWatchdog,
  estimateCompactTokens,
  feedCompactHeartbeat,
  pollCompactWatchdog,
  recordCompactFailure,
  recordCompactSuccess,
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
    // 有序断言：顺序承载 drop 优先级，重排即红（RV-013）。快照为 spec 内独立字面量（RV-019 非空洞）。
    const ordered = Object.keys(CONTEXT_DROP_ORDER).sort((a, b) => CONTEXT_DROP_ORDER[a]! - CONTEXT_DROP_ORDER[b]!)
    expect(TRIM_FIELDS_SNAPSHOT).toEqual(ordered)
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
