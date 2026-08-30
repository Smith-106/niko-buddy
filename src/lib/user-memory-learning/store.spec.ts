import { beforeEach, describe, expect, it } from "vitest"
import {
  GLOBAL_USER_MEMORY_STORAGE_KEY,
  addManualUserMemoryRule,
  deleteUserMemoryRule,
  loadGlobalUserMemoryConfig,
  saveGlobalUserMemoryConfig,
  setUserMemoryRuleEnabled,
  upsertAutomaticUserMemoryRule,
  normalizeGlobalUserMemoryConfig,
  clearGlobalUserMemoryConfig,
  getGlobalUserMemoryStats,
} from "./store"
import { consumeUserMemoryLearningBudget, loadUserMemoryLearningBudget } from "./learning-budget"

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe("global user memory store", () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it("损坏数据回退为默认开启的空配置", () => {
    storage.setItem(GLOBAL_USER_MEMORY_STORAGE_KEY, "{broken")

    expect(loadGlobalUserMemoryConfig(storage)).toMatchObject({
      version: 2,
      enabled: true,
      autoLearn: true,
      autoRead: true,
      rules: [],
      analyzedSourceHashes: [],
      deletedFingerprints: [],
    })
  })

  it("把 v1 规则迁移为全局长期规则并补齐治理字段", () => {
    const migrated = normalizeGlobalUserMemoryConfig({
      version: 1,
      enabled: true,
      autoLearn: true,
      autoRead: true,
      rules: [{
        id: "old-rule",
        rule: "回答时先给结论。",
        category: "interaction_preference",
        source: "automatic",
        surfaces: ["all"],
        confidence: 0.8,
        evidenceSummary: "旧数据",
        sourceHash: "old-hash",
        fingerprint: "interaction_preference:回答时先给结论。",
        enabled: true,
        createdAt: 100,
        updatedAt: 100,
      }],
      analyzedSourceHashes: ["old-hash"],
      deletedFingerprints: [],
      updatedAt: 100,
    })

    expect(migrated.version).toBe(2)
    expect(migrated.rules[0]).toMatchObject({
      scope: "global",
      status: "active",
      evidenceCount: 1,
      usageCount: 0,
      positiveFeedback: 0,
      negativeFeedback: 0,
      conflictsWith: [],
    })
    expect(migrated.onlyManual).toBe(false)
    expect(migrated.candidatePromotionThreshold).toBe(2)
  })

  it("限制分析哈希和自动规则数量但不自动删除手动规则", () => {
    const normalized = normalizeGlobalUserMemoryConfig({
      version: 2,
      maxAnalyzedHashes: 2,
      maxRules: 2,
      rules: [
        { id: "manual", rule: "手动规则", category: "manual", source: "manual", surfaces: ["all"], enabled: true, createdAt: 1, updatedAt: 1 },
        { id: "auto-old", rule: "旧候选规则", category: "manual", source: "automatic", surfaces: ["all"], enabled: true, status: "candidate", confidence: 0.2, createdAt: 2, updatedAt: 2 },
        { id: "auto-new", rule: "新长期规则", category: "manual", source: "automatic", surfaces: ["all"], enabled: true, status: "active", confidence: 0.9, createdAt: 3, updatedAt: 3 },
      ],
      analyzedSourceHashes: ["h1", "h2", "h3"],
    })

    expect(normalized.analyzedSourceHashes).toEqual(["h2", "h3"])
    expect(normalized.rules.map((rule) => rule.id)).toEqual(["manual", "auto-new"])
  })

  it("手动规则可以新增并持久化", () => {
    const config = addManualUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "回答时先给结论，再给依据。",
      category: "interaction_preference",
      surfaces: ["all"],
    }, 100)

    saveGlobalUserMemoryConfig(config, storage)
    const loaded = loadGlobalUserMemoryConfig(storage)

    expect(loaded.rules).toHaveLength(1)
    expect(loaded.rules[0]).toMatchObject({
      source: "manual",
      enabled: true,
      rule: "回答时先给结论，再给依据。",
    })
  })

  it("同一自动规则和来源哈希只保留一条", () => {
    const first = upsertAutomaticUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "续写时重视指定章节之间的剧情承接。",
      category: "workflow_preference",
      surfaces: ["chapter-writing", "ai-chat"],
      confidence: 0.82,
      evidenceSummary: "用户要求根据非连续章节生成后续内容。",
      sourceHash: "source-1",
    }, 100)
    const second = upsertAutomaticUserMemoryRule(first, {
      rule: "续写时重视指定章节之间的剧情承接。",
      category: "workflow_preference",
      surfaces: ["chapter-writing"],
      confidence: 0.9,
      evidenceSummary: "用户再次强调章节承接。",
      sourceHash: "source-1",
    }, 200)

    expect(second.rules).toHaveLength(1)
    expect(second.analyzedSourceHashes).toContain("source-1")
    expect(second.rules[0]?.updatedAt).toBe(200)
  })

  it("同一条用户消息提取出的不同规则分别保留", () => {
    const first = upsertAutomaticUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "回答时先给结论。",
      category: "interaction_preference",
      surfaces: ["all"],
      confidence: 0.9,
      evidenceSummary: "用户强调先给结论。",
      sourceHash: "shared-source",
    }, 100)
    const second = upsertAutomaticUserMemoryRule(first, {
      rule: "大纲使用分层标题。",
      category: "format_preference",
      surfaces: ["ai-outline"],
      confidence: 0.85,
      evidenceSummary: "用户同时要求分层标题。",
      sourceHash: "shared-source",
    }, 200)

    expect(second.rules.map((rule) => rule.rule)).toEqual([
      "回答时先给结论。",
      "大纲使用分层标题。",
    ])
  })

  it("删除规则后写入墓碑且相同自动规则不会复活", () => {
    const created = upsertAutomaticUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "大纲输出使用分层标题。",
      category: "format_preference",
      surfaces: ["ai-outline"],
      confidence: 0.9,
      evidenceSummary: "用户多次要求分层标题。",
      sourceHash: "source-2",
    }, 100)
    const deleted = deleteUserMemoryRule(created, created.rules[0]!.id, 200)
    const attempted = upsertAutomaticUserMemoryRule(deleted, {
      rule: "大纲输出使用分层标题。",
      category: "format_preference",
      surfaces: ["ai-outline"],
      confidence: 0.95,
      evidenceSummary: "相同来源再次出现。",
      sourceHash: "source-2",
    }, 300)

    expect(attempted.rules).toEqual([])
    expect(attempted.deletedFingerprints).toHaveLength(1)
  })

  it("规则可以停用后重新启用", () => {
    const created = addManualUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "避免空泛总结。",
      category: "constraint",
      surfaces: ["all"],
    }, 100)
    const id = created.rules[0]!.id

    const disabled = setUserMemoryRuleEnabled(created, id, false, 200)
    const enabled = setUserMemoryRuleEnabled(disabled, id, true, 300)

    expect(disabled.rules[0]?.enabled).toBe(false)
    expect(enabled.rules[0]?.enabled).toBe(true)
  })

  it("统计规则状态和存储占用，并可清空全部记忆", () => {
    let config = addManualUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "回答时先给结论。", category: "manual", surfaces: ["all"],
    }, 100)
    config = upsertAutomaticUserMemoryRule(config, {
      rule: "大纲使用分层标题。", category: "format_preference", surfaces: ["ai-outline"], confidence: 0.8,
      evidenceSummary: "证据", sourceHash: "h1",
    }, 200)
    saveGlobalUserMemoryConfig(config, storage)
    consumeUserMemoryLearningBudget(storage, 10, 100, 100)

    expect(getGlobalUserMemoryStats(config)).toMatchObject({ totalRules: 2, manualRules: 1, candidateRules: 1 })
    expect(getGlobalUserMemoryStats(config).estimatedBytes).toBeGreaterThan(0)
    clearGlobalUserMemoryConfig(storage)
    expect(loadGlobalUserMemoryConfig(storage).rules).toEqual([])
    expect(loadUserMemoryLearningBudget(storage, 100).calls).toBe(0)
  })

  it("超过存储字节预算时优先移除低价值自动候选", () => {
    const normalized = normalizeGlobalUserMemoryConfig({
      ...loadGlobalUserMemoryConfig(storage),
      maxStorageBytes: 900,
      rules: [
        { id: "manual", rule: "手动规则必须保留。", category: "manual", source: "manual", surfaces: ["all"], enabled: true, createdAt: 1, updatedAt: 1 },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `auto-${index}`, rule: `自动候选${index}${"内容".repeat(100)}`, category: "manual", source: "automatic",
          surfaces: ["all"], enabled: true, status: "candidate", confidence: 0.1, createdAt: index + 2, updatedAt: index + 2,
        })),
      ],
    })

    expect(normalized.rules.some((rule) => rule.id === "manual")).toBe(true)
    expect(normalized.rules.length).toBeLessThan(9)
  })
})
