import { describe, expect, it } from "vitest"
import { addManualUserMemoryRule, loadGlobalUserMemoryConfig, upsertAutomaticUserMemoryRule } from "./store"
import { applyUserMemoryFeedback, governUserMemoryConfig } from "./governance"

describe("user memory governance", () => {
  it("自动候选获得重复证据后升级为长期规则", () => {
    let config = loadGlobalUserMemoryConfig(null)
    config = upsertAutomaticUserMemoryRule(config, {
      rule: "回答时先给结论。",
      category: "interaction_preference",
      surfaces: ["all"],
      confidence: 0.8,
      evidenceSummary: "第一次证据",
      sourceHash: "h1",
    }, 100)
    expect(config.rules[0]?.status).toBe("candidate")
    config = upsertAutomaticUserMemoryRule(config, {
      rule: "回答时先给结论。",
      category: "interaction_preference",
      surfaces: ["all"],
      confidence: 0.9,
      evidenceSummary: "第二次证据",
      sourceHash: "h2",
    }, 200)

    const governed = governUserMemoryConfig(config, 200)
    expect(governed.rules[0]).toMatchObject({ status: "active", evidenceCount: 2, expiresAt: null })
  })

  it("同作用域相反规则标记为冲突", () => {
    let config = loadGlobalUserMemoryConfig(null)
    config = addManualUserMemoryRule(config, {
      rule: "写作时使用幽默风格。",
      category: "writing_preference",
      surfaces: ["chapter-writing"],
    }, 100)
    config = addManualUserMemoryRule(config, {
      rule: "写作时不要使用幽默风格。",
      category: "writing_preference",
      surfaces: ["chapter-writing"],
    }, 200)

    const governed = governUserMemoryConfig(config, 200)
    expect(governed.rules.every((rule) => rule.status === "conflicted")).toBe(true)
    expect(governed.rules[0]?.conflictsWith).toContain(governed.rules[1]?.id)
  })

  it("过期候选变为 expired，负反馈过高的自动规则降为候选", () => {
    let config = loadGlobalUserMemoryConfig(null)
    config = upsertAutomaticUserMemoryRule(config, {
      rule: "大纲使用分层标题。",
      category: "format_preference",
      surfaces: ["ai-outline"],
      confidence: 0.9,
      evidenceSummary: "证据",
      sourceHash: "h1",
    }, 100)
    const expired = governUserMemoryConfig(config, 100 + 31 * 24 * 60 * 60 * 1000)
    expect(expired.rules[0]?.status).toBe("expired")

    const active = governUserMemoryConfig({
      ...config,
      rules: config.rules.map((rule) => ({ ...rule, status: "active" as const, expiresAt: null })),
    }, 200)
    const disliked = applyUserMemoryFeedback(active, [active.rules[0]!.id], "negative", 300)
    const dislikedAgain = applyUserMemoryFeedback(disliked, [active.rules[0]!.id], "negative", 400)
    expect(governUserMemoryConfig(dislikedAgain, 400).rules[0]).toMatchObject({ status: "candidate", negativeFeedback: 2 })
  })

  it("合并同作用域中的近义自动规则并累计证据", () => {
    let config = loadGlobalUserMemoryConfig(null)
    config = upsertAutomaticUserMemoryRule(config, {
      rule: "回答时先给结论。", category: "interaction_preference", surfaces: ["all"], confidence: 0.8,
      evidenceSummary: "第一次", sourceHash: "h1",
    }, 100)
    config = upsertAutomaticUserMemoryRule(config, {
      rule: "回答问题时优先给出结论。", category: "interaction_preference", surfaces: ["all"], confidence: 0.9,
      evidenceSummary: "第二次", sourceHash: "h2",
    }, 200)

    const governed = governUserMemoryConfig(config, 200)

    expect(governed.rules).toHaveLength(1)
    expect(governed.rules[0]).toMatchObject({ evidenceCount: 2, status: "active", confidence: 0.9 })
  })
})
