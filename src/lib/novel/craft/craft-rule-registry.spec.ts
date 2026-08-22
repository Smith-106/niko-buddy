/**
 * craft-rule-registry.spec.ts — T28 技法↔规则映射 + 桥接规则表单测
 *
 * 覆盖（任务约束 coverage-100%）：
 *   - skill↔rule 映射表：9 包全部注册，每包至少 0 条关联规则
 *   - 桥接规则表：2 条（snyder_commercial→edgerton, longform_padding→gerke）
 *   - 查询函数：按 packId / ruleId / narrativeMode / injectionScope 查询
 *   - 与 T27b technique-compiler 规则包 id 对齐
 *   - W12 注入范围含技法块（F-19）
 *
 * 执行纪律：
 *   - ADR-19 机械层零模型调用：无 IO / 无 LLM / 无 Tauri invoke
 *   - Draft-first（ADR-08）：新增测试文件，不触及 .novel/status.json 正式层
 */
import { describe, expect, it } from "vitest"
import {
  CRAFT_RULE_REGISTRY,
  CRAFT_RULE_IDS,
  TECHNIQUE_PACK_IDS,
  CRAFT_RULE_REGISTRY_VERSION,
  getCraftRulesByPackId,
  getTechniquePackByCraftRuleId,
  getBridgeRuleByNarrativeMode,
  suggestCaliberForNarrativeMode,
  getAllInjectionScopes,
  getTechniquePacksByInjectionScope,
} from "./craft-rule-registry"

// ============================================================================
// 注册表结构完整性
// ============================================================================

describe("craft-rule-registry 结构完整性", () => {
  it("注册表元数据正确", () => {
    expect(CRAFT_RULE_REGISTRY.metadata.version).toBe(CRAFT_RULE_REGISTRY_VERSION)
    expect(CRAFT_RULE_REGISTRY.metadata.supportedInjectionScopes.length).toBeGreaterThanOrEqual(4)
    expect(CRAFT_RULE_REGISTRY.metadata.description).toContain("T28")
  })

  it("skill↔rule 映射表有 9 条（与 T27b 9 包对齐）", () => {
    expect(CRAFT_RULE_REGISTRY.mappings).toHaveLength(9)
  })

  it("桥接规则表有 2 条（snyder_commercial + longform_padding）", () => {
    expect(CRAFT_RULE_REGISTRY.bridgeRules).toHaveLength(2)
  })

  it("mappings 中 packId 全局唯一", () => {
    const ids = CRAFT_RULE_REGISTRY.mappings.map((m) => m.packId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ============================================================================
// T27b technique-compiler 规则包 id 对齐
// ============================================================================

describe("T27b 规则包 id 对齐", () => {
  it("TECHNIQUE_PACK_IDS 含 9 个包（与 T27b compileFromCommittedSnapshot 的 9 包一致）", () => {
    const packIds = Object.values(TECHNIQUE_PACK_IDS)
    expect(packIds).toHaveLength(9)
    expect(packIds).toEqual([
      "craft.wish-motive-action",
      "craft.thrill-loop-crisis-delay",
      "craft.finale-three-precepts",
      "craft.mckee-eight-fundamentals",
      "craft.mckee-ghost-wound",
      "craft.chapter-end-hooks-domino",
      "craft.opening-hook-promise",
      "craft.conflict-caliber-bridge",
      "craft.significant-details",
    ])
  })

  it("CRAFT_RULE_IDS 含 14 个规则 id（与 T28 literary-craft-pack 14 条规则一致）", () => {
    const ruleIds = Object.values(CRAFT_RULE_IDS)
    expect(ruleIds).toHaveLength(14)
    expect(ruleIds).toContain("craft.thrill-density")
    expect(ruleIds).toContain("craft.thrill-spacing")
    expect(ruleIds).toContain("craft.delay-ratio")
    expect(ruleIds).toContain("craft.arc-progression")
    expect(ruleIds).toContain("craft.ghost-unrevealed")
    expect(ruleIds).toContain("craft.opening-hook")
    expect(ruleIds).toContain("craft.chapter-end-hook")
    expect(ruleIds).toContain("craft.significant-detail")
    expect(ruleIds).toContain("craft.bridge-caliber")
    expect(ruleIds).toContain("craft.ending-three-precepts")
    expect(ruleIds).toContain("craft.tension-relax-alternation")
    expect(ruleIds).toContain("craft.domino-closure-dangling-hooks")
    expect(ruleIds).toContain("craft.opening-red-line-five-categories")
    expect(ruleIds).toContain("craft.eight-fundamentals")
  })

  it("每个 TECHNIQUE_PACK_IDS 值在 mappings 中存在", () => {
    const registeredPackIds = CRAFT_RULE_REGISTRY.mappings.map((m) => m.packId)
    for (const packId of Object.values(TECHNIQUE_PACK_IDS)) {
      expect(registeredPackIds).toContain(packId)
    }
  })
})

// ============================================================================
// skill↔rule 映射内容
// ============================================================================

describe("skill↔rule 映射内容", () => {
  it("每个 mapping 有 packId / sourceSkillId / injectionScope", () => {
    for (const mapping of CRAFT_RULE_REGISTRY.mappings) {
      expect(mapping.packId.length).toBeGreaterThan(0)
      expect(mapping.sourceSkillId.length).toBeGreaterThan(0)
      expect(mapping.injectionScope.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("W12 注入范围含 F-19 技法块（chapter_task_brief）", () => {
    const allScopes = getAllInjectionScopes()
    expect(allScopes).toContain("chapter_task_brief")
    expect(allScopes).toContain("protagonist_brief")
    expect(allScopes).toContain("opening_audit")
    expect(allScopes).toContain("ending_guard")
    expect(allScopes).toContain("review_quality")
    expect(allScopes).toContain("review_consistency")
  })

  it("爽点相关包映射到爽点密度/间隔/延宕比/张弛交替规则", () => {
    const thrillPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.THRILL_LOOP_CRISIS_DELAY,
    )!
    expect(thrillPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.THRILL_DENSITY)
    expect(thrillPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.THRILL_SPACING)
    expect(thrillPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.DELAY_RATIO)
    expect(thrillPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.TENSION_RELAX_ALTERNATION)
  })

  it("结局三戒包映射到结局三戒规则", () => {
    const finalePack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.FINALE_THREE_PRECEPTS,
    )!
    expect(finalePack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.ENDING_THREE_PRECEPTS)
  })

  it("章末钩子包映射到章末钩子 + 多米诺闭环规则", () => {
    const hookPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.CHAPTER_END_HOOKS_DOMINO,
    )!
    expect(hookPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.CHAPTER_END_HOOK)
    expect(hookPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.DOMINO_CLOSURE_DANGLING_HOOKS)
  })

  it("开篇钩子包映射到开篇钩子 + 开篇红线规则", () => {
    const openingPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.OPENING_HOOK_PROMISE,
    )!
    expect(openingPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.OPENING_HOOK)
    expect(openingPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.OPENING_RED_LINE_FIVE_CATEGORIES)
  })

  it("桥接包映射到桥接口径规则", () => {
    const bridgePack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.CONFLICT_CALIBER_BRIDGE,
    )!
    expect(bridgePack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.BRIDGE_CALIBER)
  })

  it("显著细节包映射到显著细节规则", () => {
    const detailPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.SIGNIFICANT_DETAILS,
    )!
    expect(detailPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.SIGNIFICANT_DETAIL)
  })

  it("愿望动机包映射到开篇红线规则（情感承诺检查）", () => {
    const wmaPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.WISH_MOTIVE_ACTION,
    )!
    expect(wmaPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.OPENING_RED_LINE_FIVE_CATEGORIES)
  })

  it("八素质包映射到弧光推进 + 八项素质检查规则", () => {
    const eightPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.MCKEE_EIGHT_FUNDAMENTALS,
    )!
    expect(eightPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.ARC_PROGRESSION)
    expect(eightPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.EIGHT_FUNDAMENTALS)
  })

  it("鬼魂包映射到鬼魂未揭规则", () => {
    const ghostPack = CRAFT_RULE_REGISTRY.mappings.find(
      (m) => m.packId === TECHNIQUE_PACK_IDS.MCKEE_GHOST_WOUND,
    )!
    expect(ghostPack.relatedCraftRuleIds).toContain(CRAFT_RULE_IDS.GHOST_UNREVEALED)
  })
})

// ============================================================================
// 桥接规则表
// ============================================================================

describe("桥接规则表", () => {
  it("snyder_commercial 推荐 edgerton 口径", () => {
    const rule = getBridgeRuleByNarrativeMode("snyder_commercial")
    expect(rule).toBeDefined()
    expect(rule!.suggestedCaliber).toBe("edgerton")
    expect(rule!.description).toContain("商业节奏优先")
  })

  it("longform_padding 推荐 gerke 口径", () => {
    const rule = getBridgeRuleByNarrativeMode("longform_padding")
    expect(rule).toBeDefined()
    expect(rule!.suggestedCaliber).toBe("gerke")
    expect(rule!.description).toContain("长篇")
  })

  it("suggestCaliberForNarrativeMode 快捷查询", () => {
    expect(suggestCaliberForNarrativeMode("snyder_commercial")).toBe("edgerton")
    expect(suggestCaliberForNarrativeMode("longform_padding")).toBe("gerke")
  })
})

// ============================================================================
// 查询函数
// ============================================================================

describe("查询函数", () => {
  it("getCraftRulesByPackId 返回关联规则 id", () => {
    const rules = getCraftRulesByPackId(TECHNIQUE_PACK_IDS.THRILL_LOOP_CRISIS_DELAY)
    expect(rules.length).toBeGreaterThanOrEqual(4)
    expect(rules).toContain(CRAFT_RULE_IDS.THRILL_DENSITY)
  })

  it("getCraftRulesByPackId 对未知包返回空数组", () => {
    expect(getCraftRulesByPackId("unknown-pack")).toEqual([])
  })

  it("getTechniquePackByCraftRuleId 反查溯源包", () => {
    const packs = getTechniquePackByCraftRuleId(CRAFT_RULE_IDS.THRILL_DENSITY)
    expect(packs).toContain(TECHNIQUE_PACK_IDS.THRILL_LOOP_CRISIS_DELAY)
  })

  it("getTechniquePackByCraftRuleId 对未知规则返回空数组", () => {
    expect(getTechniquePackByCraftRuleId("unknown-rule")).toEqual([])
  })

  it("getTechniquePacksByInjectionScope 返回关联包", () => {
    const packs = getTechniquePacksByInjectionScope("chapter_task_brief")
    // 多个包注入到 chapter_task_brief
    expect(packs.length).toBeGreaterThanOrEqual(4)
    expect(packs).toContain(TECHNIQUE_PACK_IDS.THRILL_LOOP_CRISIS_DELAY)
    expect(packs).toContain(TECHNIQUE_PACK_IDS.SIGNIFICANT_DETAILS)
  })

  it("getAllInjectionScopes 返回 6 个注入 scope", () => {
    const scopes = getAllInjectionScopes()
    expect(scopes).toHaveLength(6)
    expect(scopes).toContain("protagonist_brief")
    expect(scopes).toContain("chapter_task_brief")
    expect(scopes).toContain("opening_audit")
    expect(scopes).toContain("ending_guard")
    expect(scopes).toContain("review_quality")
    expect(scopes).toContain("review_consistency")
  })
})