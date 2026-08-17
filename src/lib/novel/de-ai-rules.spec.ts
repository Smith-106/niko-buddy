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
} from "./de-ai-rules"

describe("S1e de-ai 双层结构化 (prosecreator 7×4 结构)", () => {
  it("结构维度: 7 类别 × 4 严重度 (prosecreator 14×7×4 中文适配)", () => {
    const stats = deAiStructuredStats()
    expect(stats.categoryCount).toBe(7)
    expect(stats.severityCount).toBe(4)
    expect(stats.ruleCount).toBe(28) // TASK-202 收敛: 矩阵 24→28 满格 (7 类 × 4 档)
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
