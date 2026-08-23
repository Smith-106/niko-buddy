/**
 * craft-rule-registry.ts — skill↔rule + 桥接规则表（T28 / F-19 W12 注入范围）
 *
 * 职责（蓝图 §4 T28 行原文 + 任务定义）：
 *   建立技法编译器（T27b technique-compiler）规则包 id 与文学规则（T28 literary-craft-pack）
 *   之间的跨层映射关系，包括：
 *   - skill↔rule 映射：nmem skill → 规则包 → 文学规则 id
 *   - 桥接规则表：narrative_mode ↔ conflict_caliber 映射（U-07 提案）
 *   - W12 注入范围元数据：技法块（F-19）注入点标注
 *   - 规则包 id 对齐注册：与 T27b technique-compiler 的 registries.packs[].packId 一致
 *
 * 定位与边界：
 *   - 纯数据模块：零 IO、零 LLM、零 Tauri invoke（ADR-19 机械层零 LLM 同型态）
 *   - 不产生规则产出（findings），只负责映射查询
 *   - 与 T27b technique-compiler 的 packId 命名空间共享（craft.<slug> 前缀）
 *   - 桥接规则表真源为 U-07（nmem 桥接规则记忆），本模块仅做提案投影
 *
 * Draft-first（ADR-08）：新增纯数据模块，不写运行时会话状态，不触及草稿正式层。
 *
 * @license MIT © QMAI
 */

import type { NarrativeMode, ConflictCaliber } from "./canon-craft-fields"

// ============================================================================
// 类型定义
// ============================================================================

/** 规则包 id 与文学规则 id 的映射条目。 */
export interface SkillRuleMapping {
  /** T27b technique-compiler 规则包 id（如 "craft.wish-motive-action"）。 */
  readonly packId: string
  /** 该包溯源的 nmem skill id 或 memory id（为空时表示无 skill 溯源）。 */
  readonly sourceSkillId: string
  /** 关联的文学规则（T28 literary-craft-pack）id 列表，可为空。 */
  readonly relatedCraftRuleIds: readonly string[]
  /** W12 注入范围标注（含技法块 F-19）。 */
  readonly injectionScope: readonly InjectionScope[]
}

/** W12 注入范围（F-19 技法块注入点）。 */
export type InjectionScope =
  | "protagonist_brief"    // 主角卡司简报（人物弧光工作台 F-06 输入）
  | "chapter_task_brief"   // 章节任务书技法块（deep-chapter-task-brief）
  | "opening_audit"        // 开篇钩子审计（A-23.1/A-23.4）
  | "ending_guard"         // 终局三戒守卫（F-28）
  | "review_quality"       // 六维审查质量注入（质量维）
  | "review_consistency"   // 六维审查一致性注入（一致性维）

/** 桥接规则表条目：narrative_mode 到 conflict_caliber 的映射建议。 */
export interface BridgeRuleEntry {
  /** 叙事模式（F-26 项目配置）。 */
  readonly narrativeMode: NarrativeMode
  /** 建议的冲突桥接口径（U-07 提案）。 */
  readonly suggestedCaliber: ConflictCaliber
  /** 适用场景说明。 */
  readonly description: string
  /** 守卫条件（如不满足的降级说明）。 */
  readonly guardrail: string
}

/** 注册表条目聚合。 */
export interface CraftRuleRegistry {
  /** 全量 skill↔rule 映射表。 */
  readonly mappings: readonly SkillRuleMapping[]
  /** 桥接规则表（narrative_mode ↔ conflict_caliber）。 */
  readonly bridgeRules: readonly BridgeRuleEntry[]
  /** 注册表元数据。 */
  readonly metadata: {
    readonly version: string
    readonly description: string
    /** 支持的注入范围列表。 */
    readonly supportedInjectionScopes: readonly InjectionScope[]
  }
}

// ============================================================================
// 注册表常量
// ============================================================================

/** 注册表版本号（与 T27b technique-compiler 版本对齐）。 */
export const CRAFT_RULE_REGISTRY_VERSION = "1.0.0"

// ============================================================================
// T27b technique-compiler 规则包 id 常量（对齐注册用）
// ============================================================================

/** T27b technique-compiler 规则包 id 全集（与编译产物 packs[].packId 逐字对齐）。 */
export const TECHNIQUE_PACK_IDS = {
  WISH_MOTIVE_ACTION: "craft.wish-motive-action",
  THRILL_LOOP_CRISIS_DELAY: "craft.thrill-loop-crisis-delay",
  FINALE_THREE_PRECEPTS: "craft.finale-three-precepts",
  MCKEE_EIGHT_FUNDAMENTALS: "craft.mckee-eight-fundamentals",
  MCKEE_GHOST_WOUND: "craft.mckee-ghost-wound",
  CHAPTER_END_HOOKS_DOMINO: "craft.chapter-end-hooks-domino",
  OPENING_HOOK_PROMISE: "craft.opening-hook-promise",
  CONFLICT_CALIBER_BRIDGE: "craft.conflict-caliber-bridge",
  SIGNIFICANT_DETAILS: "craft.significant-details",
} as const

/** T28 literary-craft-pack 规则 id 全集。 */
export const CRAFT_RULE_IDS = {
  THRILL_DENSITY: "craft.thrill-density",
  THRILL_SPACING: "craft.thrill-spacing",
  DELAY_RATIO: "craft.delay-ratio",
  ARC_PROGRESSION: "craft.arc-progression",
  GHOST_UNREVEALED: "craft.ghost-unrevealed",
  OPENING_HOOK: "craft.opening-hook",
  CHAPTER_END_HOOK: "craft.chapter-end-hook",
  SIGNIFICANT_DETAIL: "craft.significant-detail",
  BRIDGE_CALIBER: "craft.bridge-caliber",
  ENDING_THREE_PRECEPTS: "craft.ending-three-precepts",
  TENSION_RELAX_ALTERNATION: "craft.tension-relax-alternation",
  DOMINO_CLOSURE_DANGLING_HOOKS: "craft.domino-closure-dangling-hooks",
  OPENING_RED_LINE_FIVE_CATEGORIES: "craft.opening-red-line-five-categories",
  EIGHT_FUNDAMENTALS: "craft.eight-fundamentals",
} as const

// ============================================================================
// skill↔rule 映射表
// ============================================================================

/**
 * skill↔rule 映射表：T27b 9 包 → 各包关联的文学规则 id。
 *
 * 映射规则：
 *   - 每个 T27b 规则包至少关联 0 条或多条文学规则（非对称映射：一个技法包
 *     可对应多个文学规则检查项）
 *   - W12 注入范围从技法包的 promptBlocks[].injectionPoint 继承
 *   - sourceSkillId 取 T27b 包 sourceMemoryIds 中第一个 skill 或 memory 溯源 id
 */
const SKILL_RULE_MAPPINGS: readonly SkillRuleMapping[] = [
  {
    packId: TECHNIQUE_PACK_IDS.WISH_MOTIVE_ACTION,
    sourceSkillId: "20de3c24-0000-4000-8000-000000000000",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.OPENING_RED_LINE_FIVE_CATEGORIES, // 愿望→情感承诺检查
    ],
    injectionScope: ["protagonist_brief", "chapter_task_brief"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.THRILL_LOOP_CRISIS_DELAY,
    sourceSkillId: "04644331-0000-4000-8000-000000000000",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.THRILL_DENSITY,       // 爽点密度
      CRAFT_RULE_IDS.THRILL_SPACING,        // 爽点间隔
      CRAFT_RULE_IDS.DELAY_RATIO,           // 延宕比
      CRAFT_RULE_IDS.TENSION_RELAX_ALTERNATION, // 张弛交替
    ],
    injectionScope: ["chapter_task_brief", "review_quality"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.FINALE_THREE_PRECEPTS,
    sourceSkillId: "04644331-0000-4000-8000-000000000000", // 共用爽点记忆
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.ENDING_THREE_PRECEPTS, // 结局三戒
    ],
    injectionScope: ["ending_guard", "review_consistency"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.MCKEE_EIGHT_FUNDAMENTALS,
    sourceSkillId: "84c7f90a-0000-4000-8000-000000000000",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.ARC_PROGRESSION,      // 弧光推进
      CRAFT_RULE_IDS.EIGHT_FUNDAMENTALS,    // 八项素质检查
    ],
    injectionScope: ["protagonist_brief", "chapter_task_brief"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.MCKEE_GHOST_WOUND,
    sourceSkillId: "akers-ghost-concept-char wound",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.GHOST_UNREVEALED,      // 鬼魂未揭
    ],
    injectionScope: ["protagonist_brief", "chapter_task_brief"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.CHAPTER_END_HOOKS_DOMINO,
    sourceSkillId: "28dc7918-0000-4000-8000-000000000000",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.CHAPTER_END_HOOK,             // 章末钩子
      CRAFT_RULE_IDS.DOMINO_CLOSURE_DANGLING_HOOKS, // 多米诺闭环与悬空钩子
    ],
    injectionScope: ["chapter_task_brief", "review_quality"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.OPENING_HOOK_PROMISE,
    sourceSkillId: "786b0422-0000-4000-8000-000000000000",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.OPENING_HOOK,                   // 开篇钩子
      CRAFT_RULE_IDS.OPENING_RED_LINE_FIVE_CATEGORIES, // 开篇红线 5 类全集
    ],
    injectionScope: ["opening_audit", "review_quality"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.CONFLICT_CALIBER_BRIDGE,
    sourceSkillId: "edgerton-hooked-start-at-inciting-incident",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.BRIDGE_CALIBER, // 桥接口径
    ],
    injectionScope: ["opening_audit", "review_consistency"],
  },
  {
    packId: TECHNIQUE_PACK_IDS.SIGNIFICANT_DETAILS,
    sourceSkillId: "skill_f8e81e050000",
    relatedCraftRuleIds: [
      CRAFT_RULE_IDS.SIGNIFICANT_DETAIL, // 显著细节
    ],
    injectionScope: ["chapter_task_brief", "review_quality"],
  },
]

// ============================================================================
// 桥接规则表（U-07 提案投影）
// ============================================================================

/**
 * 桥接规则表：narrative_mode ↔ conflict_caliber 映射（U-07 提案，R8 未定稿）。
 *
 * 真源：nmem 桥接规则记忆（edgerton-hooked-start-at-inciting-incident）。
 * 定稿回指 U-07（本模块仅做提案投影，不做定稿）。
 */
const BRIDGE_RULES: readonly BridgeRuleEntry[] = [
  {
    narrativeMode: "snyder_commercial",
    suggestedCaliber: "edgerton",
    description: "商业节奏优先：故事从贯穿全书的麻烦第一次发生之处开始，压缩稳定态",
    guardrail: "若仍使用长篇铺垫，开篇功能上必须让读者感到稳定已被撕开（带悬念的现状），不得把前史当成开场",
  },
  {
    narrativeMode: "longform_padding",
    suggestedCaliber: "gerke",
    description: "长篇可用格尔克长铺垫，允许先铺常态再引入冲突",
    guardrail: "长铺垫仍须让开篇功能上「稳定已被撕开」，开场不得是纯前史或风景描写",
  },
]

// ============================================================================
// 注册表导出
// ============================================================================

/** 全量 craft-rule 注册表（单例，不可变）。 */
export const CRAFT_RULE_REGISTRY: CraftRuleRegistry = Object.freeze({
  mappings: SKILL_RULE_MAPPINGS,
  bridgeRules: BRIDGE_RULES,
  metadata: Object.freeze({
    version: CRAFT_RULE_REGISTRY_VERSION,
    description: "T28 技法↔文学规则映射 + 桥接规则表（U-07 提案投影）",
    supportedInjectionScopes: Object.freeze<InjectionScope[]>([
      "protagonist_brief",
      "chapter_task_brief",
      "opening_audit",
      "ending_guard",
      "review_quality",
      "review_consistency",
    ]),
  }),
})

// ============================================================================
// 查询函数
// ============================================================================

/**
 * 按技法包 id 查找关联的文学规则 id 列表。
 * 返回空数组表示未找到映射。
 */
export function getCraftRulesByPackId(packId: string): readonly string[] {
  const mapping = CRAFT_RULE_REGISTRY.mappings.find((m) => m.packId === packId)
  return mapping?.relatedCraftRuleIds ?? []
}

/**
 * 按文学规则 id 反查溯源技法包 id。
 * 返回空数组表示未找到映射。
 */
export function getTechniquePackByCraftRuleId(ruleId: string): readonly string[] {
  return CRAFT_RULE_REGISTRY.mappings
    .filter((m) => m.relatedCraftRuleIds.includes(ruleId))
    .map((m) => m.packId)
}

/**
 * 按叙事模式查询桥接规则。
 */
export function getBridgeRuleByNarrativeMode(
  mode: NarrativeMode,
): BridgeRuleEntry | undefined {
  return CRAFT_RULE_REGISTRY.bridgeRules.find((r) => r.narrativeMode === mode)
}

/**
 * 按叙事模式推荐冲突口径。
 * 未找到匹配时返回 undefined（调用方应使用默认值 edgerton）。
 */
export function suggestCaliberForNarrativeMode(
  mode: NarrativeMode,
): ConflictCaliber | undefined {
  return CRAFT_RULE_REGISTRY.bridgeRules.find((r) => r.narrativeMode === mode)?.suggestedCaliber
}

/**
 * 获取所有注入 scope 列表（去重有序）。
 */
export function getAllInjectionScopes(): readonly InjectionScope[] {
  const scopes = new Set<InjectionScope>()
  for (const mapping of CRAFT_RULE_REGISTRY.mappings) {
    for (const scope of mapping.injectionScope) {
      scopes.add(scope)
    }
  }
  return [...CRAFT_RULE_REGISTRY.metadata.supportedInjectionScopes]
}

/**
 * 按注入 scope 查找关联的技法包 id。
 */
export function getTechniquePacksByInjectionScope(scope: InjectionScope): readonly string[] {
  return CRAFT_RULE_REGISTRY.mappings
    .filter((m) => m.injectionScope.includes(scope))
    .map((m) => m.packId)
}

/** 注册表版本号（与 CRAFT_RULE_REGISTRY.metadata.version 等价）。 */
export const REGISTRY_VERSION = CRAFT_RULE_REGISTRY_VERSION