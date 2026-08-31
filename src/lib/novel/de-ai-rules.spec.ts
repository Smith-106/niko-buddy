import { describe, expect, it } from "vitest"
import {
  CHINESE_NOVEL_DE_AI_RULES,
  DE_AI_CATEGORIES,
  DE_AI_SEVERITIES,
  DE_AI_STRUCTURED_RULES,
  WEB_NOVEL_GENRES,
  GENRE_BASELINES,
  getGenreBaseline,
  filterRulesBySeverity,
  buildStructuredDeAiRules,
  deAiStructuredStats,
  HUMANIZER_CAVITY_GUARD,
  buildHumanizerCavityGuard,
  classifyResidualOrigin,
  signalDisclosure,
} from "./de-ai-rules"

describe("S1e de-ai 双层结构化 (prosecreator 7×4 结构)", () => {
  it("结构维度: 7 类别 × 4 严重度 (prosecreator 14×7×4 中文适配)", () => {
    const stats = deAiStructuredStats()
    expect(stats.categoryCount).toBe(7)
    expect(stats.severityCount).toBe(4)
    expect(stats.ruleCount).toBe(44) // TASK-P2-19 (T19): 增强 28→42 (7 类 × 4 档 + 14 统计检测规则); R-inkos-2 (23-inkos-coverage): 42→44 (吸收 inkos story-deslop 净增量 Q4/Q7 两维)
    expect(stats.genreCount).toBe(14) // TASK-201 收敛: 流派 8→14
    expect(DE_AI_SEVERITIES).toEqual(["critical", "high", "medium", "low"])
  })

  it("每个类别都有规则覆盖 (7 类全覆盖)", () => {
    for (const category of DE_AI_CATEGORIES) {
      expect(DE_AI_STRUCTURED_RULES.filter((r) => r.category === category).length).toBeGreaterThan(0)
    }
  })

  it("每条规则有唯一类别×规则组合且 critical 类规则存在", () => {
    const seen = new Set<string>()
    for (const r of DE_AI_STRUCTURED_RULES) {
      const key = `${r.category}:${r.rule}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      expect(DE_AI_CATEGORIES).toContain(r.category)
      expect(DE_AI_SEVERITIES).toContain(r.severity)
    }
    expect(DE_AI_STRUCTURED_RULES.some((r) => r.severity === "critical")).toBe(true)
  })

  it("filterRulesBySeverity 过滤: medium 门槛排除 low", () => {
    const filtered = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, "medium")
    expect(filtered.every((r) => r.severity !== "low")).toBe(true)
    expect(filtered.length).toBeLessThan(DE_AI_STRUCTURED_RULES.length)
    const all = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, "low")
    expect(all.length).toBe(DE_AI_STRUCTURED_RULES.length)
  })

  it("genre 基线: 14 流派各有节奏/对白/心理倾向", () => {
    expect(GENRE_BASELINES).toHaveLength(WEB_NOVEL_GENRES.length)
    expect(getGenreBaseline("玄幻")!.pacing).toBe("fast")
    expect(getGenreBaseline("言情")!.introspection).toBe("keep")
    expect(getGenreBaseline("都市")!.dialogue).toBe("strong")
    expect(getGenreBaseline("不存在的流派")).toBeUndefined()
  })

  it("buildStructuredDeAiRules 生成结构化 prompt (genre 感知)", () => {
    const prompt = buildStructuredDeAiRules("玄幻")
    expect(prompt).toContain("玄幻")
    expect(prompt).toContain("规则矩阵")
    expect(prompt).toContain("[critical]")
    expect(prompt).not.toContain("[low]") // 默认 medium 门槛
    const full = buildStructuredDeAiRules(undefined, "low")
    expect(full).toContain("[low]")
    const critical = buildStructuredDeAiRules(undefined, "critical")
    expect(critical).not.toContain("[high]")
  })

  it("向后兼容: 原 CHINESE_NOVEL_DE_AI_RULES 字符串保留 (deep-chapter-prompts 引用不变)", () => {
    expect(CHINESE_NOVEL_DE_AI_RULES).toContain("中文小说去 AI 味补充规则")
    expect(CHINESE_NOVEL_DE_AI_RULES.length).toBeGreaterThan(500)
  })

  it("每个严重度门槛下 7 个类别都不为空 — buildStructuredDeAiRules 的 catRules.length===0 continue 分支不可达", () => {
    // 矩阵满格 (7 类 × 4 档): 任一 minSeverity 过滤后每个类别都保有 ≥1 条规则,
    // 因此 buildStructuredDeAiRules 内部 `if (catRules.length === 0) continue`
    // 永不触发 (de-ai-rules.ts:292) — 该分支为不可达死分支。
    for (const severity of DE_AI_SEVERITIES) {
      for (const category of DE_AI_CATEGORIES) {
        const kept = filterRulesBySeverity(DE_AI_STRUCTURED_RULES, severity).filter(
          (r) => r.category === category,
        )
        expect(kept.length).toBeGreaterThan(0)
        expect(buildStructuredDeAiRules(undefined, severity)).toContain(category)
      }
    }
  })
})

// ============================================================================
// P0-3/P0-4: residual 三类分诊 + 信号分证
// ============================================================================
describe("P0-3 classifyResidualOrigin — residual 三类分诊", () => {
  it("高残留 + 高源 slop + 低 cavity → SOURCE-AI continue", () => {
    const t = classifyResidualOrigin({ residualRate: 0.6, sourceSlopPenalty: 7, cavityScore: 0.2 })
    expect(t.origin).toBe("SOURCE-AI")
    expect(t.action).toBe("continue")
    expect(t.productHardGate).toBe(false)
  })

  it("高残留 + 低源 slop + 高 cavity → REWRITER-CAVITY revert", () => {
    const t = classifyResidualOrigin({ residualRate: 0.6, sourceSlopPenalty: 2, cavityScore: 0.8 })
    expect(t.origin).toBe("REWRITER-CAVITY")
    expect(t.action).toBe("revert")
  })

  it("低残留 + 高 cavity → REWRITER-CAVITY revert (清理动作引入腔)", () => {
    const t = classifyResidualOrigin({ residualRate: 0.1, sourceSlopPenalty: 2, cavityScore: 0.8 })
    expect(t.origin).toBe("REWRITER-CAVITY")
    expect(t.action).toBe("revert")
  })

  it("低残留 + 低 cavity → 已清除 continue", () => {
    const t = classifyResidualOrigin({ residualRate: 0.1, sourceSlopPenalty: 2, cavityScore: 0.1 })
    expect(t.origin).toBe("SOURCE-AI")
    expect(t.action).toBe("continue")
  })

  it("中等残留 → AMBIGUOUS manual", () => {
    const t = classifyResidualOrigin({ residualRate: 0.5, sourceSlopPenalty: 3, cavityScore: 0.3 })
    expect(t.origin).toBe("AMBIGUOUS")
    expect(t.action).toBe("manual")
  })

  it("evidence 含关键指标", () => {
    const t = classifyResidualOrigin({ residualRate: 0.5, sourceSlopPenalty: 3, cavityScore: 0.3 })
    expect(t.evidence.some((e) => e.includes("residualRate=0.50"))).toBe(true)
    expect(t.evidence.some((e) => e.includes("cavityScore=0.30"))).toBe(true)
  })
})

describe("P0-4 signalDisclosure — 反过拟合信号分证", () => {
  it("机械指标永远 Track B soft, 不设产品硬门", () => {
    const s = signalDisclosure({ metricName: "slopPenalty" })
    expect(s.productHardGate).toBe(false)
    expect(s.track).toBe("B")
    expect(s.note).toContain("Consistency(P0)")
  })
})

describe("P0-1 HUMANIZER_CAVITY_GUARD — 改写器腔 must-not-emit", () => {
  it("guard 内容覆盖关键反改写规则", () => {
    expect(HUMANIZER_CAVITY_GUARD).toContain("假口语")
    expect(HUMANIZER_CAVITY_GUARD).toContain("统一风格")
    expect(HUMANIZER_CAVITY_GUARD).toContain("分布对齐自然文本")
  })

  it("buildHumanizerCavityGuard 返回非空片段", () => {
    const g = buildHumanizerCavityGuard()
    expect(g.length).toBeGreaterThan(100)
    expect(g).toContain("改写器腔禁止")
  })
})
