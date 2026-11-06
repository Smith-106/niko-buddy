import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  GLOBAL_USER_MEMORY_CHANGED_EVENT,
  GLOBAL_USER_MEMORY_STORAGE_KEY,
  addManualUserMemoryRule,
  deleteUserMemoryRule,
  loadGlobalUserMemoryConfig,
  saveGlobalUserMemoryConfig,
  setUserMemoryRuleEnabled,
  upsertAutomaticUserMemoryRule,
  updateGlobalUserMemorySettings,
  updateUserMemoryRule,
  normalizeGlobalUserMemoryConfig,
  clearGlobalUserMemoryConfig,
  getGlobalUserMemoryStats,
  exportGlobalUserMemoryJson,
} from "./store"
import { consumeUserMemoryLearningBudget, loadUserMemoryLearningBudget } from "./learning-budget"
import type { UserMemoryRule } from "./types"

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

describe("global user memory store · 分支补齐", () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it("默认存储缺席时回退默认配置且保存直接返回", () => {
    expect(loadGlobalUserMemoryConfig()).toMatchObject({ version: 2, rules: [] })
    expect(loadGlobalUserMemoryConfig(null)).toMatchObject({ version: 2, rules: [] })
    expect(saveGlobalUserMemoryConfig(loadGlobalUserMemoryConfig(null))).toBeUndefined()
  })

  it("浏览器存储经 window.localStorage 读写并广播变更", () => {
    const backing = new MemoryStorage()
    const dispatched: string[] = []
    vi.stubGlobal("window", {
      localStorage: backing,
      dispatchEvent: (event: Event) => {
        dispatched.push(event.type)
        return true
      },
    })
    try {
      const created = addManualUserMemoryRule(loadGlobalUserMemoryConfig(), {
        rule: "浏览器记忆甲。",
        category: "manual",
        surfaces: ["all"],
      }, 100)
      saveGlobalUserMemoryConfig(created)

      expect(dispatched).toEqual([GLOBAL_USER_MEMORY_CHANGED_EVENT])
      const loaded = loadGlobalUserMemoryConfig()
      expect(loaded.rules.map((rule) => rule.rule)).toEqual(["浏览器记忆甲。"])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("normalize 容忍非对象与脏规则并丢弃无效条目", () => {
    expect(normalizeGlobalUserMemoryConfig(null)).toMatchObject({ version: 2, rules: [] })
    expect(normalizeGlobalUserMemoryConfig({ rules: "not-an-array" }).rules).toEqual([])
    const normalized = normalizeGlobalUserMemoryConfig({
      rules: [null, { id: "no-rule-text" }, { id: "num-rule", rule: 123 }],
    })
    expect(normalized.rules).toEqual([])
  })

  it("非法置信度按来源回退默认值", () => {
    const normalized = normalizeGlobalUserMemoryConfig({
      rules: [
        { id: "bad-auto", rule: "自动脏置信度。", source: "automatic", confidence: "bad" },
        { id: "bad-manual", rule: "手动脏置信度。", source: "manual", confidence: Number.NaN },
      ],
    })

    expect(normalized.rules[0]?.confidence).toBe(0.5)
    expect(normalized.rules[1]?.confidence).toBe(1)
  })

  it("normalize 补齐缺失字段并保留有效值", () => {
    const normalized = normalizeGlobalUserMemoryConfig({
      rules: [
        {
          rule: "  有效规则甲  ",
          category: "unknown-category",
          createdAt: "bad",
          confidence: 0.8,
          surfaces: [],
          projectKey: "p1",
          sessionKey: "s1",
          lastUsedAt: 500,
          scope: "project",
        },
        { rule: "规则乙", lastUsedAt: Number.NaN },
      ],
    })

    expect(normalized.rules).toHaveLength(2)
    expect(normalized.rules[0]).toMatchObject({
      rule: "有效规则甲",
      category: "manual",
      createdAt: 0,
      confidence: 0.8,
      surfaces: ["all"],
      projectKey: "p1",
      sessionKey: "s1",
      lastUsedAt: 500,
      updatedAt: 0,
      scope: "project",
    })
    expect(normalized.rules[0]?.id).toMatch(/^memory:0:/)
    expect(normalized.rules[1]?.lastUsedAt).toBeNull()
  })

  it("prune 并列时按更新时间取舍", () => {
    const normalized = normalizeGlobalUserMemoryConfig({
      maxRules: 2,
      rules: [1, 2, 3, 4].map((index) => ({
        id: `auto-${index}`,
        rule: `自动规则${index}。`,
        category: "manual",
        source: "automatic",
        surfaces: ["all"],
        enabled: true,
        status: "candidate",
        confidence: 0.5,
        usageCount: 0,
        createdAt: index,
        updatedAt: index,
      })),
    })

    expect(normalized.rules.map((rule) => rule.id).sort()).toEqual(["auto-3", "auto-4"])
  })

  it("存储超限时移除一条即回落", () => {
    const input = {
      maxRules: 300,
      rules: [
        { id: "manual", rule: "手动。", category: "manual", source: "manual", surfaces: ["all"], enabled: true, createdAt: 1, updatedAt: 1 },
        { id: "low", rule: `低价值${"内容".repeat(1000)}`, category: "manual", source: "automatic", surfaces: ["all"], enabled: true, status: "candidate", confidence: 0.1, createdAt: 2, updatedAt: 2 },
        { id: "high", rule: `高价值${"内容".repeat(1000)}`, category: "manual", source: "automatic", surfaces: ["all"], enabled: true, status: "candidate", confidence: 0.9, createdAt: 3, updatedAt: 3 },
      ],
    }
    const full = JSON.stringify(normalizeGlobalUserMemoryConfig({ ...input, maxStorageBytes: 10_000_000 })).length * 2
    const normalized = normalizeGlobalUserMemoryConfig({ ...input, maxStorageBytes: full - 1500 })

    expect(normalized.rules.some((rule) => rule.id === "manual")).toBe(true)
    expect(normalized.rules.some((rule) => rule.id === "low")).toBe(false)
    expect(normalized.rules.some((rule) => rule.id === "high")).toBe(true)
  })

  it("空规则与空来源哈希直接返回原配置", () => {
    const base = loadGlobalUserMemoryConfig(storage)
    expect(addManualUserMemoryRule(base, { rule: "   ", category: "manual", surfaces: ["all"] }, 100)).toBe(base)
    expect(upsertAutomaticUserMemoryRule(base, {
      rule: "   ", category: "manual", surfaces: ["all"], confidence: 0.5, evidenceSummary: "e", sourceHash: "h",
    }, 100)).toBe(base)
    expect(upsertAutomaticUserMemoryRule(base, {
      rule: "有效规则。", category: "manual", surfaces: ["all"], confidence: 0.5, evidenceSummary: "e", sourceHash: "   ",
    }, 100)).toBe(base)
  })

  it("crypto 缺席时回退随机 id", () => {
    vi.stubGlobal("crypto", undefined)
    try {
      const created = addManualUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
        rule: "无 crypto 规则。",
        category: "manual",
        surfaces: ["all"],
      }, 100)
      expect(created.rules[0]?.id).toMatch(/^memory:100:[a-z0-9]+$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("同指纹更新保留其他规则并补齐缺失证据计数", () => {
    const first = upsertAutomaticUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "规则甲。", category: "interaction_preference", surfaces: ["all"],
      confidence: 0.6, evidenceSummary: "甲证据", sourceHash: "h1",
    }, 100)
    const withPeer = upsertAutomaticUserMemoryRule(first, {
      rule: "规则乙。", category: "format_preference", surfaces: ["all"],
      confidence: 0.7, evidenceSummary: "乙证据", sourceHash: "h2",
    }, 200)
    const fingerprintA = withPeer.rules.find((rule) => rule.rule === "规则甲。")!.fingerprint
    const stripped = {
      ...withPeer,
      rules: withPeer.rules.map((rule) => rule.fingerprint === fingerprintA ? { ...rule, evidenceCount: undefined } : rule),
    }
    const updated = upsertAutomaticUserMemoryRule(stripped, {
      rule: "规则甲。", category: "interaction_preference", surfaces: ["all"],
      confidence: 0.8, evidenceSummary: "甲新证据", sourceHash: "h3",
    }, 300)

    expect(updated.rules.find((rule) => rule.rule === "规则甲。")).toMatchObject({ evidenceCount: 2, confidence: 0.8 })
    expect(updated.rules.find((rule) => rule.rule === "规则乙。")).toMatchObject({ evidenceSummary: "乙证据" })
  })

  it("session 域自动规则一天过期", () => {
    const created = upsertAutomaticUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "会话规则甲。",
      category: "interaction_preference",
      surfaces: ["all"],
      confidence: 0.6,
      evidenceSummary: "证据",
      sourceHash: "session-hash",
      scope: "session",
    }, 1000)

    expect(created.rules[0]?.expiresAt).toBe(1000 + 24 * 60 * 60 * 1000)
  })

  it("更新与删除的边界行为", () => {
    const created = addManualUserMemoryRule(loadGlobalUserMemoryConfig(storage), {
      rule: "边界规则甲。",
      category: "manual",
      surfaces: ["all"],
    }, 100)
    const id = created.rules[0]!.id

    const untouched = updateUserMemoryRule(created, "missing-id", { rule: "新文本。" }, 200)
    expect(untouched.rules).toEqual(created.rules)

    const renamed = updateUserMemoryRule(created, id, { rule: "  重命名后  " }, 200)
    expect(renamed.rules[0]).toMatchObject({ rule: "重命名后" })

    const keptOnBlank = updateUserMemoryRule(created, id, { rule: "   " }, 300)
    expect(keptOnBlank.rules[0]?.rule).toBe("边界规则甲。")

    expect(deleteUserMemoryRule(created, "missing-id")).toBe(created)
    const deletedManual = deleteUserMemoryRule(created, id, 400)
    expect(deletedManual.rules).toEqual([])
    expect(deletedManual.deletedFingerprints).toEqual([])
  })

  it("设置更新默认走当前时间", () => {
    const base = loadGlobalUserMemoryConfig(storage)
    const updated = updateGlobalUserMemorySettings(base, { enabled: false })

    expect(updated.enabled).toBe(false)
    expect(updated.updatedAt).toBeGreaterThan(0)
  })

  it("缺失状态按长期有效统计", () => {
    const base = loadGlobalUserMemoryConfig(storage)
    const full: UserMemoryRule = {
      id: "nostatus",
      rule: "无状态规则。",
      category: "manual",
      source: "manual",
      surfaces: ["all"],
      confidence: 1,
      evidenceSummary: "",
      sourceHash: null,
      fingerprint: "manual:nostatus",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      scope: "global",
      projectKey: null,
      sessionKey: null,
      status: "active",
      expiresAt: null,
    }
    const { status: _dropped, ...rest } = full
    void _dropped
    const config = { ...base, rules: [rest as UserMemoryRule] }

    expect(getGlobalUserMemoryStats(config).activeRules).toBe(1)
  })

  it("window.localStorage 访问抛错 → defaultStorage 返回 null，降级为默认配置", () => {
    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new Error("storage denied")
      },
    })
    try {
      expect(loadGlobalUserMemoryConfig()).toEqual(normalizeGlobalUserMemoryConfig(null))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("crypto.randomUUID 抛错 → createId 回退到 now+random 形式", () => {
    const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("no uuid")
    })
    try {
      const config = addManualUserMemoryRule(loadGlobalUserMemoryConfig(new MemoryStorage()), {
        rule: "回退 id。",
        category: "constraint",
        surfaces: ["all"],
      }, 100)
      const id = config.rules[0].id
      // 回退形式 memory:<now>:<random> 有两段冒号；UUID 形式只有一段
      expect(id.split(":")).toHaveLength(3)
    } finally {
      spy.mockRestore()
    }
  })

  it("exportGlobalUserMemoryJson 输出规范化后的 2 空格缩进 JSON", () => {
    const config = addManualUserMemoryRule(loadGlobalUserMemoryConfig(new MemoryStorage()), {
      rule: "先给结论，再给依据。",
      category: "interaction_preference",
      surfaces: ["all"],
    }, 100)
    const json = exportGlobalUserMemoryJson(config)
    expect(JSON.parse(json)).toEqual(normalizeGlobalUserMemoryConfig(config))
    expect(json).toContain("\n  \"")
  })
})
