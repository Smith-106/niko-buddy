import { describe, expect, it } from "vitest"
import { addManualUserMemoryRule, loadGlobalUserMemoryConfig, upsertAutomaticUserMemoryRule } from "./store"
import { applyUserMemoryFeedback, governUserMemoryConfig } from "./governance"
import type { GlobalUserMemoryConfig, UserMemoryRule } from "./types"

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

describe("user memory governance · 分支补齐", () => {
  function handRule(partial: Pick<UserMemoryRule, "id" | "rule"> & Partial<UserMemoryRule>): UserMemoryRule {
    return {
      category: "interaction_preference",
      source: "manual",
      surfaces: ["all"],
      confidence: 1,
      evidenceSummary: "",
      sourceHash: null,
      fingerprint: `test:${partial.id}`,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      scope: "global",
      projectKey: null,
      sessionKey: null,
      status: "active",
      expiresAt: null,
      ...partial,
    }
  }

  function configWith(rules: UserMemoryRule[]): GlobalUserMemoryConfig {
    return { ...loadGlobalUserMemoryConfig(null), rules, updatedAt: 1000 }
  }

  it("类目不同或签名不同的规则不成对冲突", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "a", rule: "写作时使用幽默风格。" }),
      handRule({ id: "b", rule: "写作时使用幽默风格。", category: "constraint" }),
      handRule({ id: "c", rule: "大纲使用分层标题。" }),
    ]), 1000)

    expect(governed.rules.every((rule) => rule.status === "active")).toBe(true)
    expect(governed.rules.every((rule) => rule.conflictsWith!.length === 0)).toBe(true)
  })

  it("手动与自动的近义规则不合并", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "m", rule: "回答时先给结论。" }),
      handRule({ id: "a", rule: "回答时先给结论。", source: "automatic", status: "candidate", evidenceCount: 1 }),
    ]), 1000)

    expect(governed.rules).toHaveLength(2)
    expect(governed.rules.find((rule) => rule.id === "a")?.status).toBe("candidate")
  })

  it("极性相反的自动规则不合并但标记冲突", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "a", rule: "回答时先给结论。", source: "automatic", status: "active" }),
      handRule({ id: "b", rule: "回答时不要先给结论。", source: "automatic", status: "active" }),
    ]), 1000)

    expect(governed.rules).toHaveLength(2)
    expect(governed.rules.every((rule) => rule.status === "conflicted")).toBe(true)
  })

  it("语义签名为空的规则不参与合并", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "a", rule: "请", source: "automatic", status: "active" }),
      handRule({ id: "b", rule: "回答时先给结论。", source: "automatic", status: "active" }),
    ]), 1000)

    expect(governed.rules).toHaveLength(2)
  })

  it("类目不同的自动规则不参与合并", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "a", rule: "回答时先给结论。", source: "automatic", status: "active" }),
      handRule({ id: "b", rule: "回答时先给结论。", source: "automatic", status: "active", category: "constraint" }),
    ]), 1000)

    expect(governed.rules).toHaveLength(2)
    expect(governed.rules.every((rule) => rule.status === "active")).toBe(true)
  })

  it("低相似度自动规则各自保留", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "a", rule: "回答时先给结论。", source: "automatic", status: "active" }),
      handRule({ id: "b", rule: "回答时先给依据。", source: "automatic", status: "active" }),
    ]), 1000)

    expect(governed.rules).toHaveLength(2)
    expect(governed.rules.every((rule) => rule.status === "active")).toBe(true)
  })

  it("低置信后来规则并入既有高置信规则并补齐缺失计数", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({
        id: "old", rule: "回答时先给结论。", source: "automatic", status: "active",
        confidence: 0.9, evidenceSummary: "旧证据", sourceHash: "old-hash",
      }),
      handRule({
        id: "new", rule: "回答时先给结论。", source: "automatic", status: "candidate",
        confidence: 0.3, evidenceSummary: "新证据", sourceHash: "new-hash",
      }),
    ]), 1000)

    expect(governed.rules).toHaveLength(1)
    expect(governed.rules[0]).toMatchObject({
      rule: "回答时先给结论。",
      confidence: 0.9,
      evidenceCount: 2,
      evidenceSummary: "旧证据",
      sourceHash: "old-hash",
      usageCount: 0,
      positiveFeedback: 0,
      negativeFeedback: 0,
      status: "active",
    })
  })

  it("手动过期规则恢复为长期有效", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "m", rule: "手动规则甲。", status: "expired", expiresAt: 100 }),
    ]), 1000)

    expect(governed.rules[0]).toMatchObject({ status: "active", expiresAt: null })
  })

  it("缺失反馈计数按零处理并触发降级", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "quiet", rule: "安静规则甲。", source: "automatic", status: "active" }),
      handRule({ id: "hated", rule: "被讨厌规则乙。", source: "automatic", status: "active", negativeFeedback: 5 }),
    ]), 1000)

    expect(governed.rules.find((rule) => rule.id === "quiet")?.status).toBe("active")
    expect(governed.rules.find((rule) => rule.id === "hated")).toMatchObject({ status: "candidate" })
    expect(governed.rules.find((rule) => rule.id === "hated")?.expiresAt).toBeGreaterThan(1000)
  })

  it("缺失证据计数按 1 处理晋升判定", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "nocount", rule: "候选规则甲。", source: "automatic", status: "candidate" }),
      handRule({ id: "proven", rule: "候选规则乙。", source: "automatic", status: "candidate", evidenceCount: 3 }),
    ]), 1000)

    expect(governed.rules.find((rule) => rule.id === "nocount")?.status).toBe("candidate")
    expect(governed.rules.find((rule) => rule.id === "proven")).toMatchObject({ status: "active", expiresAt: null })
  })

  it("孤立冲突态规则回稳为长期有效", () => {
    const governed = governUserMemoryConfig(configWith([
      handRule({ id: "lonely", rule: "孤独规则甲。", source: "automatic", status: "conflicted" }),
    ]), 1000)

    expect(governed.rules[0]).toMatchObject({ status: "active", conflictsWith: [] })
  })

  it("冲突合并兼容缺失的 conflictsWith 字段", () => {
    const base = configWith([
      handRule({ id: "a", rule: "写作时使用幽默风格。" }),
      handRule({ id: "b", rule: "写作时不要使用幽默风格。" }),
    ])
    const stripped: GlobalUserMemoryConfig = {
      ...base,
      rules: base.rules.map((rule) => {
        const { conflictsWith: _dropped, ...rest } = rule as UserMemoryRule & { conflictsWith?: string[] }
        void _dropped
        return rest as UserMemoryRule
      }),
    }

    const governed = governUserMemoryConfig(stripped, 1000)
    expect(governed.rules.find((rule) => rule.id === "a")?.conflictsWith).toEqual(["b"])
    expect(governed.rules.find((rule) => rule.id === "b")?.conflictsWith).toEqual(["a"])
  })

  it("反馈只影响命中规则并支持正向加分", () => {
    const base = configWith([
      handRule({ id: "a", rule: "规则甲。" }),
      handRule({ id: "b", rule: "规则乙。" }),
    ])
    const noCounts: GlobalUserMemoryConfig = {
      ...base,
      rules: base.rules.map((rule) => {
        const { positiveFeedback: _p, negativeFeedback: _n, ...rest } = rule
        void _p
        void _n
        return rest as UserMemoryRule
      }),
    }

    const praised = applyUserMemoryFeedback(noCounts, ["a"], "positive", 2000)
    expect(praised.rules.find((rule) => rule.id === "a")).toMatchObject({ positiveFeedback: 1, negativeFeedback: 0 })
    expect(praised.rules.find((rule) => rule.id === "b")).toMatchObject({ positiveFeedback: 0, negativeFeedback: 0 })

    const blamed = applyUserMemoryFeedback(praised, ["b"], "negative", 3000)
    expect(blamed.rules.find((rule) => rule.id === "b")).toMatchObject({ positiveFeedback: 0, negativeFeedback: 1 })
    expect(blamed.rules.find((rule) => rule.id === "a")?.positiveFeedback).toBe(1)
  })
})
