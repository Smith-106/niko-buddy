/**
 * technique-compiler.ts — nmem space → 规则包编译器（T27b / F-20 / A-04.6）。
 *
 * 职责（蓝图 T27b 行原文）：
 *   编译 nmem space → { canon 字段枚举、规则包参数、提示词块、hook 类型注册表 }，
 *   版本化（记忆 id/版本入元数据）；≥4 技法编译为规则包并注册；canon 技法字段
 *   真实写入（主角 wish/motive/ghost/arc_stage 填充率 100%）；nmem 不可用时从
 *   快照离线编译，规则包功能不退化。
 *
 * 定位与边界：
 *   - `compileTechniques(snapshot)` 是**纯确定性函数**：零 IO、零 LLM、零时钟、
 *     零 Tauri invoke——同输入永同输出（spec 以 DeepEqual 断言）。
 *   - **runtime 永不直连 nmem**（蓝图 §8 P3）：运行时生成路径只消费编译产物；
 *     本模块提供的 live 抓取助手（{@link probeNmemHealth} /
 *     {@link compileWithFallback}）是**显式注入式**的编译期工具链接口，仅限
 *     重编译脚本/CI 使用，网络函数由调用方注入，本模块不做任何隐式网络调用。
 *   - 离线降级路径：live 探活失败或抓取失败 → 优雅中止并回落提交快照
 *     （nmem-snapshot.ts），规则包功能不退化（spec 断言两路产物 packs 深等价）。
 *   - canon 字段命名与 T26 契约（canon-craft-fields.ts）逐字对齐：
 *     entities.wish/motive/wma_action/mckee_ghost/arc_stage/arc_fundamentals/
 *     significant_details；edges.hook_type/foreshadow_planted_at/payoff_chapter；
 *     episodes.beat_hits/tension_curve/hook_type/conflict_caliber/narrative_stage。
 *   - R8 强制：HookType 开放注册表（U-05 定稿前 string 承载）；八素质槽位命名、
 *     ArcStage、桥接口径均标「提案，回指 U-xx」。
 *
 * Draft-first（ADR-08）：纯新增编译器，不写运行时会话状态，不触及草稿正式层；
 * canon 字段「真实写入」以 {@link CanonCraftFieldWrite} 载荷形态产出，由摄取
 * 管线（F-20 下游）经既有双写通道落库，本模块自身零落库。
 */

import {
  ARC_FUNDAMENTALS_SLOT_COUNT,
  isArcStage,
  validateArcFundamentals,
  type ArcStage,
  type EntityCraftFields,
} from "./canon-craft-fields"
import {
  NMEM_SNAPSHOT,
  NMEM_SNAPSHOT_VERSION,
  validateNmemSnapshot,
  type NmemSnapshot,
  type NmemSnapshotMemory,
} from "./nmem-snapshot"

// ============================================================================
// 编译产物类型（蓝图四件套：canon 字段枚举 / 规则包参数 / 提示词块 / hook 注册表）
// ============================================================================

/** 编译器版本号：编译逻辑或参数语义变更时升版（与快照版本正交）。 */
export const TECHNIQUE_COMPILER_VERSION = "1.0.0"

/** canon 三表目标（T11 DDL 三表）。 */
export type CanonTableTarget = "entities" | "edges" | "episodes"

/** 单个 canon 技法字段目标（table+field 与 T26 契约 snake_case 列名逐字对齐）。 */
export interface CanonFieldTarget {
  readonly table: CanonTableTarget
  readonly field: string
}

/** 提示词块注入点（W12 注入范围含技法块，F-19）。 */
export type PromptInjectionPoint =
  | "protagonist_brief" // 主角卡司简报（人物弧光工作台 F-06 输入）
  | "chapter_task_brief" // 章节任务书技法块（deep-chapter-task-brief）
  | "opening_audit" // 开篇钩子审计（A-23.1/A-23.4）
  | "ending_guard" // 终局三戒守卫（F-28）

/** 单条提示词块（注入生成端上下文的最小技法指令面）。 */
export interface TechniquePromptBlock {
  readonly blockId: string
  readonly title: string
  /** 提示词正文（中文，面向生成端 LLM 的技法约束/指引）。 */
  readonly body: string
  readonly injectionPoint: PromptInjectionPoint
}

/**
 * 钩子类型注册表条目（**开放注册表**，R8/U-05：不定稿为封闭联合，string 承载）。
 * 挂载点区分（A-23.1/A-23.2）：edges=开端钩子 / episodes=章末钩子。
 */
export interface HookTypeEntry {
  readonly hookType: string
  readonly mountPoint: Extract<CanonTableTarget, "edges" | "episodes">
  readonly labelZh: string
  /** 溯源：注册该型的 nmem 记忆 id。 */
  readonly sourceMemoryId: string
}

/** 规则包参数值域（JSON 可序列化的标量/只读数组，禁嵌套对象以保证参数面扁平可审计）。 */
export type RulePackParamValue = string | number | boolean | readonly string[]

/**
 * 单个技法规则包：一次技法编译的最小交付单元。
 * 追溯链 = sourceSnapshotVersion + sourceMemoryIds（蓝图 A-04.6：
 * 「每个规则包可追溯 nmem memory id+版本」）。
 */
export interface TechniqueRulePack {
  /** 包 id（craft.<slug>，全局唯一）。 */
  readonly packId: string
  /** 技法名（人类可读）。 */
  readonly techniqueName: string
  /** 编译自的快照版本。 */
  readonly sourceSnapshotVersion: number
  /** 溯源 nmem 记忆 id 列表（全部必须存在于来源快照）。 */
  readonly sourceMemoryIds: readonly string[]
  /** 该包负责回填的 canon 技法字段枚举。 */
  readonly canonFieldTargets: readonly CanonFieldTarget[]
  /** 规则包参数（扁平键值）。 */
  readonly params: Readonly<Record<string, RulePackParamValue>>
  /** 提示词块列表（至少 1 条）。 */
  readonly promptBlocks: readonly TechniquePromptBlock[]
}

/** 编译产物注册表（含 hook 类型注册表聚合）。 */
export interface CompiledTechniqueRegistry {
  readonly compilerVersion: string
  readonly snapshotVersion: number
  readonly packs: readonly TechniqueRulePack[]
  /** 全部已注册钩子型（开端 + 章末，开放注册表）。 */
  readonly hookTypeRegistry: readonly HookTypeEntry[]
}

// ============================================================================
// 编译主入口（纯函数）
// ============================================================================

/**
 * 从快照编译技法规则包注册表（纯确定性：零 IO/LLM/时钟）。
 *
 * 前置校验：快照结构不合法（validateNmemSnapshot 失败）→ TypeError，
 * 不产出半成品注册表（fail-fast，避免静默降级污染下游）。
 */
export function compileTechniques(snapshot: NmemSnapshot): CompiledTechniqueRegistry {
  const snapshotCheck = validateNmemSnapshot(snapshot)
  if (!snapshotCheck.ok) {
    throw new TypeError(
      `compileTechniques: 快照校验失败：${snapshotCheck.violations.map((v) => `${v.path}: ${v.message}`).join("; ")}`,
    )
  }
  return {
    compilerVersion: TECHNIQUE_COMPILER_VERSION,
    snapshotVersion: snapshot.snapshotVersion,
    packs: buildPacks(snapshot),
    hookTypeRegistry: buildHookTypeRegistry(),
  }
}

/**
 * 离线编译入口：直接使用入仓提交快照（nmem server 不可用时的唯一编译路径，
 * 蓝图 §8 P3「CI 守卫测试基于提交快照通过」）。
 */
export function compileFromCommittedSnapshot(): CompiledTechniqueRegistry {
  return compileTechniques(NMEM_SNAPSHOT)
}

// ---------------------------------------------------------------------------
// 规则包构建（9 包 ≥ 任务下限 4；每包溯源 memoryId 见各 sourceMemoryIds）
// ---------------------------------------------------------------------------

const MEMORY_WMA = "20de3c24-0000-4000-8000-000000000000"
const MEMORY_THRILL_FINALE = "04644331-0000-4000-8000-000000000000"
const MEMORY_MCKEE_EIGHT = "84c7f90a-0000-4000-8000-000000000000"
const MEMORY_GHOST = "akers-ghost-concept-char wound"
const MEMORY_CHAPTER_END_HOOKS = "28dc7918-0000-4000-8000-000000000000"
const MEMORY_OPENING_HOOKS = "786b0422-0000-4000-8000-000000000000"
const MEMORY_BRIDGE = "edgerton-hooked-start-at-inciting-incident"
const MEMORY_DETAILS = "94a6af29-0000-4000-8000-000000000000"
const SKILL_DETAILS = "skill_f8e81e050000"

function buildPacks(snapshot: NmemSnapshot): readonly TechniqueRulePack[] {
  const version = snapshot.snapshotVersion
  return [
    {
      packId: "craft.wish-motive-action",
      techniqueName: "愿望—动机—行动范式",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_WMA],
      canonFieldTargets: [
        { table: "entities", field: "wish" },
        { table: "entities", field: "motive" },
        { table: "entities", field: "wma_action" },
      ],
      params: {
        wish_motive_distinction_enforced: true, // wish=想要什么 / motive=为什么要，强制区分（A-22.1）
        conflicting_wish_construction: true, // 主要人物间相互冲突的愿望建构对抗性情节
        plot_stall_recovery: "ask_wish_motive", // 情节不知如何发展时问主角的愿望与动机
      },
      promptBlocks: [
        {
          blockId: "craft.wma.protagonist-brief",
          title: "主角愿望—动机—行动注入",
          body:
            "主角必须有明确的愿望清单（想要什么）与动机清单（为什么要），两者强制区分不得混写。" +
            "每个主要人物的愿望—动机—行动链条须完整；主要人物之间的愿望应相互冲突以建构对抗性情节。" +
            "主角的行动由其选择推动，结局必须是主角行为的直接结果。",
          injectionPoint: "protagonist_brief",
        },
      ],
    },
    {
      packId: "craft.thrill-loop-crisis-delay",
      techniqueName: "爽点循环与危机延宕",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_THRILL_FINALE],
      canonFieldTargets: [
        { table: "episodes", field: "beat_hits" },
        { table: "episodes", field: "tension_curve" },
      ],
      params: {
        crisis_delay_allowed: true, // 对抗爆发之初让敌人得意、主角承压
        delay_relief_required: true, // 压抑不可长久不疏解（延宕须配张弛疏解）
        tension_alternation_required: true, // 激烈冲突后插入次要线索或喜剧舒缓
        ending_coincidence_forbidden: true, // 结局必是主角行为结果，巧合不得用作高潮结局
        per_arc_thrill_closure_min: 1, // 每卷/每弧保证一个可感爽点闭环
      },
      promptBlocks: [
        {
          blockId: "craft.thrill.chapter-brief",
          title: "爽点循环与延宕节奏注入",
          body:
            "对抗—冲突阶段允许先让对手得意、主角承压以积蓄读者焦虑，但压抑不得长久不疏解；" +
            "激烈冲突后应以次要线索或轻喜剧桥段张弛交替。每个故事弧至少完成一次可感的爽点闭环。" +
            "高潮必须由主角连续行动达成，禁止以巧合解决。",
          injectionPoint: "chapter_task_brief",
        },
      ],
    },
    {
      packId: "craft.finale-three-precepts",
      techniqueName: "结局三戒守卫",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_THRILL_FINALE],
      canonFieldTargets: [{ table: "episodes", field: "narrative_stage" }],
      params: {
        precepts: [
          "protagonist_absent", // 戒一：主角不在场的结局
          "protagonist_out_of_control", // 戒二：主角失控的结局
          "protagonist_avoids_final_choice", // 戒三：主角逃避最终选择的结局
        ],
        finale_by_protagonist_choice: true, // 终局由主角选择与行为解决问题
        reader_expectation_fulfillment_required: true, // 满足读者对主角愿望—命运的最终期待
      },
      promptBlocks: [
        {
          blockId: "craft.finale.precepts-guard",
          title: "终局章三戒守卫",
          body:
            "终局章必须让主角在场、在掌控中并主动完成最终抉择；禁止主角缺席收场、被外力裹挟失控、" +
            "或逃避最终选择。结局是主角行为的结果，作者不得以任何理由逃避满足读者对主角愿望—命运的最终期待。",
          injectionPoint: "ending_guard",
        },
      ],
    },
    {
      packId: "craft.mckee-eight-fundamentals",
      techniqueName: "麦基主人公八项基本素质",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_MCKEE_EIGHT],
      canonFieldTargets: [
        { table: "entities", field: "arc_fundamentals" },
        { table: "entities", field: "arc_stage" },
      ],
      params: {
        slot_count: ARC_FUNDAMENTALS_SLOT_COUNT,
        // 槽位命名为 U-04 提案回填（R8：未定稿，真源=nmem 麦基书摘记忆）
        slot_names: [
          "willpower", // 意志力
          "versatility", // 多才多艺
          "underdog_position", // 下风狗位置
          "empathy_core", // 移情本质/善中
          "duplicity", // 心机
          "foreground_depth", // 长度与深度
          "change_capacity", // 改变容量
          "epiphany_insight", // 洞察力/顿悟
        ],
        value_range_min: 0,
        value_range_max: 1,
      },
      promptBlocks: [
        {
          blockId: "craft.mckee.fundamentals-brief",
          title: "主人公八素质评估注入",
          body:
            "主角设计应对照八项基本素质：意志力（穷尽意志应对终极两难）、多才多艺（行动非他莫属）、" +
            "下风狗位置（对抗力量压倒性占优而仅存一线希望）、移情本质/善中、心机（内心矛盾品质）、" +
            "长度与深度（高压选择暴露潜意识动机）、改变容量、洞察力/顿悟。激励事件后主角须穷尽意志而非轻易放弃。",
          injectionPoint: "protagonist_brief",
        },
      ],
    },
    {
      packId: "craft.mckee-ghost-wound",
      techniqueName: "鬼魂：驱动英雄的过去创伤",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_GHOST],
      canonFieldTargets: [{ table: "entities", field: "mckee_ghost" }],
      params: {
        ghost_vs_backstory_distinction: true, // 鬼魂=核心伤口，不是普通背景故事
        submerged_reveal: true, // 不必直接展示，但必须存在于水面之下
        grounds_desire_and_need: true, // 为欲望（想要什么）/需要（真正需要什么）提供情感根基
      },
      promptBlocks: [
        {
          blockId: "craft.ghost.submerged-injection",
          title: "鬼魂水下注入",
          body:
            "主角的鬼魂（核心过去创伤）不必直接展示，但必须存在于水面之下：读者看到冰山一角，" +
            "情节安排须体现它对主角当前行为的持续驱使。鬼魂为主角的欲望（想要什么）与需要（真正需要什么）" +
            "提供情感根基，二者可以相互矛盾。",
          injectionPoint: "protagonist_brief",
        },
      ],
    },
    {
      packId: "craft.chapter-end-hooks-domino",
      techniqueName: "章末钩子十一型与多米诺闭环",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_CHAPTER_END_HOOKS],
      canonFieldTargets: [
        { table: "episodes", field: "hook_type" },
        { table: "edges", field: "foreshadow_planted_at" },
        { table: "edges", field: "payoff_chapter" },
      ],
      params: {
        hook_types_total: 11,
        domino_chain_required: true, // 场景环环相扣，每个场景都影响后续场景
        removable_scene_action: "delete_or_merge", // 无法推动情节的场景删去或合并
        dangling_payoff_forbidden: true, // 有 plant 无 payoff 的悬空钩子须报告（T28 规则输入）
      },
      promptBlocks: [
        {
          blockId: "craft.hooks.chapter-end",
          title: "章末钩子注入",
          body:
            "每章结尾必须提出有力的问题让读者翻页：从十一型注册表中选取章末钩子类型并标注。" +
            "场景之间须多米诺式环环相扣：每个场景都影响后续场景；无法推动情节的场景应删除或合并。" +
            "埋设的伏笔必须登记 payoff 计划，禁止悬空。",
          injectionPoint: "chapter_task_brief",
        },
      ],
    },
    {
      packId: "craft.opening-hook-promise",
      techniqueName: "开篇承诺与投稿禁忌",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_OPENING_HOOKS],
      canonFieldTargets: [{ table: "edges", field: "hook_type" }],
      params: {
        opening_approaches_total: 10,
        opening_taboos: [
          "country_road", // 乡间小路：风景无冲突开场
          "crash_course", // 突击速成：信息过载
          "dud_opening", // 哑炮引子：无张力或与未来无关
          "mirror_gazing", // 镜子镜子：照镜子自我描写
          "standing_still", // 几无进展：日常琐事
          "typecasting", // 对号入座：陈腐套路
          "sensationalism", // 耸人听闻：开头与后续不匹配
          "fast_lane", // 快车道：节奏过快读者失序
          "tears", // 泪痕：无来由极端情绪
        ],
        promise_required: true, // 开篇向读者许下「值得投入情感的世界」承诺
      },
      promptBlocks: [
        {
          blockId: "craft.hooks.opening-audit",
          title: "开篇钩子审计注入",
          body:
            "开篇必须建立可信度、引入人物、暗示冲突、营造氛围，并用具体感觉细节让读者沉浸。" +
            "首句优先打磨为有力首句或制造必须读到后续才能解答的疑问。逐项检查九类投稿禁忌" +
            "（风景无冲突开场、信息过载、哑炮引子、照镜自我描写、日常琐事、陈腐套路、头重脚轻、" +
            "节奏失序、无来由极端情绪），命中任一项即整改。",
          injectionPoint: "opening_audit",
        },
      ],
    },
    {
      packId: "craft.conflict-caliber-bridge",
      techniqueName: "桥接口径：埃杰顿/格尔克分流",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_BRIDGE],
      canonFieldTargets: [
        { table: "episodes", field: "conflict_caliber" },
        { table: "episodes", field: "narrative_mode" },
      ],
      params: {
        // U-07 提案映射（R8：真源=nmem 桥接规则记忆，定稿回指 U-07）
        caliber_by_narrative_mode_snyder_commercial: "edgerton", // 商业节奏优先埃杰顿式：麻烦尽快落地
        caliber_by_narrative_mode_longform_padding: "gerke", // 长篇可用格尔克长铺垫
        gerke_guardrail: "stability_torn_in_opening_function", // 长铺垫仍须让开篇功能上「稳定已被撕开」
        inciting_incident_first: true, // 当代口径：诱发事件尽早落地，压缩甚至省略稳定态
      },
      promptBlocks: [
        {
          blockId: "craft.bridge.caliber-note",
          title: "开篇桥接口径注入",
          body:
            "当代商业节奏采用埃杰顿口径：故事从贯穿全书的麻烦第一次发生之处开始，压缩甚至省略稳定态。" +
            "若项目为长篇铺垫口径（格尔克式），允许先铺常态，但开篇功能上仍必须让读者感到稳定已被撕开" +
            "（带悬念的现状），不得把前史当成开场。",
          injectionPoint: "opening_audit",
        },
      ],
    },
    {
      packId: "craft.significant-details",
      techniqueName: "显著细节",
      sourceSnapshotVersion: version,
      sourceMemoryIds: [MEMORY_DETAILS, SKILL_DETAILS],
      canonFieldTargets: [{ table: "entities", field: "significant_details" }],
      params: {
        max_details_per_subject: 2, // 一两个鲜明细节替代完整生平（少即是多）
        avoid_generic_adjectives: ["漂亮", "帅", "美", "丑"], // 广告词禁用
        skill_id: SKILL_DETAILS,
        skill_version: 1,
        skill_content_hash: "219c319a3b1b79038b3f288d28f24cf1e35996ddc91aa525db0d43ef8416091e",
      },
      promptBlocks: [
        {
          blockId: "craft.details.injection",
          title: "显著细节注入",
          body:
            "塑造人物与环境时优先投放显著细节：用一两个鲜明、出乎意料的具体细节替代完整生平介绍，" +
            "让读者在快节奏中记住人物。禁用「漂亮」「帅」「美」「丑」等广告词，寻找新鲜、具体的描述方式；" +
            "对不重要人物不投入冗余笔墨。",
          injectionPoint: "chapter_task_brief",
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// hook 类型注册表（开放注册表，R8/U-05：取值由摄取编译注册，非封闭联合）
// ---------------------------------------------------------------------------

/** 维兰德十一型章末钩子（memory 28dc7918；挂载点 episodes，A-23.2）。 */
const CHAPTER_END_HOOK_TYPES: readonly { hookType: string; labelZh: string }[] = [
  { hookType: "foreshadow_conflict", labelZh: "预示冲突" },
  { hookType: "secret", labelZh: "秘密" },
  { hookType: "important_decision_or_vow", labelZh: "重要决定或誓言" },
  { hookType: "shocking_announcement", labelZh: "宣布震惊事件" },
  { hookType: "intense_emotion", labelZh: "激烈情绪" },
  { hookType: "novel_flipping_twist", labelZh: "足以颠覆小说的突转" },
  { hookType: "new_idea", labelZh: "新想法" },
  { hookType: "unanswered_question", labelZh: "未回答的问题" },
  { hookType: "mysterious_dialogue", labelZh: "神秘对白" },
  { hookType: "prophecy", labelZh: "预言" },
  { hookType: "turning_point", labelZh: "转折点" },
]

/** 莫雷尔好开篇十方案（memory 786b0422；挂载点 edges，A-23.1）。 */
const OPENING_HOOK_TYPES: readonly { hookType: string; labelZh: string }[] = [
  { hookType: "dialogue", labelZh: "对话" },
  { hookType: "anecdote", labelZh: "逸事" },
  { hookType: "question", labelZh: "疑问" },
  { hookType: "suspense", labelZh: "悬念" },
  { hookType: "theme", labelZh: "主题" },
  { hookType: "setting", labelZh: "设定" },
  { hookType: "strong_first_line", labelZh: "有力首句" },
  { hookType: "character_portrait", labelZh: "人物描写" },
  { hookType: "turning_point", labelZh: "转机" },
  { hookType: "foreshadowing", labelZh: "伏笔" },
]

function buildHookTypeRegistry(): readonly HookTypeEntry[] {
  return [
    ...CHAPTER_END_HOOK_TYPES.map<HookTypeEntry>((entry) => ({
      ...entry,
      mountPoint: "episodes",
      sourceMemoryId: MEMORY_CHAPTER_END_HOOKS,
    })),
    ...OPENING_HOOK_TYPES.map<HookTypeEntry>((entry) => ({
      ...entry,
      mountPoint: "edges",
      sourceMemoryId: MEMORY_OPENING_HOOKS,
    })),
  ]
}

/** 按挂载点过滤已注册钩子型。 */
export function getHookTypesByMountPoint(
  registry: CompiledTechniqueRegistry,
  mountPoint: HookTypeEntry["mountPoint"],
): readonly HookTypeEntry[] {
  return registry.hookTypeRegistry.filter((entry) => entry.mountPoint === mountPoint)
}

/** 是否已注册的钩子型（同一挂载点内查重）。 */
export function isRegisteredHookType(
  registry: CompiledTechniqueRegistry,
  hookType: string,
  mountPoint: HookTypeEntry["mountPoint"],
): boolean {
  return registry.hookTypeRegistry.some((e) => e.hookType === hookType && e.mountPoint === mountPoint)
}

// ============================================================================
// 追溯性守卫（A-04.6：每个规则包可追溯 nmem memory id+版本）
// ============================================================================

/** {@link validateRegistryTraceability} 的单条违规描述。 */
export interface TraceabilityViolation {
  path: string
  message: string
}

/** 校验结果：ok=false 时 violations 非空。 */
export interface TraceabilityValidation {
  ok: boolean
  violations: TraceabilityViolation[]
}

/**
 * 校验注册表对来源快照的可追溯性（机械检查，零 LLM）：
 *   - 每个 pack.sourceSnapshotVersion == snapshot.snapshotVersion；
 *   - 每个 pack.sourceMemoryIds 都存在于 snapshot.memories/.skills；
 *   - packId 全局唯一；每包 ≥1 条提示词块且 canonFieldTargets 非空；
 *   - hook 注册表每条 sourceMemoryId 存在，且 (hookType, mountPoint) 无重复。
 */
export function validateRegistryTraceability(
  registry: CompiledTechniqueRegistry,
  snapshot: NmemSnapshot,
): TraceabilityValidation {
  const violations: TraceabilityViolation[] = []
  const knownIds = new Set<string>([
    ...snapshot.memories.map((m) => m.memoryId),
    ...snapshot.skills.map((s) => s.skillId),
  ])

  const seenPackIds = new Set<string>()
  registry.packs.forEach((pack, i) => {
    const at = `packs[${i}](${pack.packId})`
    if (seenPackIds.has(pack.packId)) violations.push({ path: at, message: `packId 重复：${pack.packId}` })
    seenPackIds.add(pack.packId)
    if (pack.sourceSnapshotVersion !== snapshot.snapshotVersion) {
      violations.push({
        path: `${at}.sourceSnapshotVersion`,
        message: `快照版本不匹配：pack=${pack.sourceSnapshotVersion} snapshot=${snapshot.snapshotVersion}`,
      })
    }
    if (pack.sourceMemoryIds.length === 0) {
      violations.push({ path: `${at}.sourceMemoryIds`, message: "溯源 memoryId 列表不得为空" })
    }
    for (const id of pack.sourceMemoryIds) {
      if (!knownIds.has(id)) {
        violations.push({ path: `${at}.sourceMemoryIds`, message: `溯源 id 不在来源快照中：${id}` })
      }
    }
    if (pack.canonFieldTargets.length === 0) {
      violations.push({ path: `${at}.canonFieldTargets`, message: "canon 字段目标不得为空" })
    }
    if (pack.promptBlocks.length === 0) {
      violations.push({ path: `${at}.promptBlocks`, message: "提示词块不得为空" })
    }
  })

  const seenHooks = new Set<string>()
  registry.hookTypeRegistry.forEach((entry, i) => {
    const at = `hookTypeRegistry[${i}]`
    if (!knownIds.has(entry.sourceMemoryId)) {
      violations.push({ path: `${at}.sourceMemoryId`, message: `溯源 id 不在来源快照中：${entry.sourceMemoryId}` })
    }
    const key = `${entry.mountPoint}::${entry.hookType}`
    if (seenHooks.has(key)) {
      violations.push({ path: at, message: `钩子型重复注册：${key}` })
    }
    seenHooks.add(key)
  })

  return { ok: violations.length === 0, violations }
}

// ============================================================================
// canon 技法字段真实写入（主角 wish/motive/ghost/arc_stage 填充率 100%）
// ============================================================================

/** 主角技法字段填充率硬门要求字段（任务完成定义四字段）。 */
export const PROTAGONIST_REQUIRED_CRAFT_FIELDS = ["wish", "motive", "mckee_ghost", "arc_stage"] as const

export type ProtagonistRequiredCraftField = (typeof PROTAGONIST_REQUIRED_CRAFT_FIELDS)[number]

/** 主角技法画像（摄取管线抽取产物的结构化输入；本模块据此确定性装配写入载荷）。 */
export interface ProtagonistCraftProfile {
  /** 目标 entity id（canon entities 表主键）。 */
  readonly entityId: string
  /** 愿望清单（W-M-A 的 W；与 motive 强制区分）。 */
  readonly wish: readonly string[]
  /** 动机清单（为什么要）。 */
  readonly motive: readonly string[]
  /** 愿望—动机驱动的行动清单（可选；缺省由下游增量回填）。 */
  readonly wmaAction?: readonly string[]
  /** 麦基鬼魂（核心过去创伤；来自 craft.mckee-ghost-wound 包口径）。 */
  readonly mckeeGhost: string
  /** 当前弧光阶段（U-04 提案 7 值）。 */
  readonly arcStage: ArcStage
  /** 八项素质评分表（可选；值域 [0,1]，经 validateArcFundamentals 机械校验）。 */
  readonly arcFundamentals?: Record<string, number>
  /** 显著细节锚点（可选）。 */
  readonly significantDetails?: readonly string[]
}

/** 单条 canon 技法字段写入载荷（由摄取管线经既有双写通道落库；本模块零落库）。 */
export interface CanonCraftFieldWrite {
  readonly entityId: string
  readonly fields: EntityCraftFields
  /** 字段级溯源：field → 产出该字段的规则包与 nmem 记忆 id。 */
  readonly provenance: Readonly<Record<string, { packId: string; memoryId: string }>>
}

/**
 * 将主角技法画像装配为 canon 技法字段写入载荷（确定性纯函数）。
 *
 * wish/motive 为空清单、mckeeGhost 为空白串、arcStage 非法值 → TypeError
 * （fail-fast：填充率 100% 是硬门，缺件不允许静默出载荷）。
 */
export function buildProtagonistCraftWrite(profile: ProtagonistCraftProfile): CanonCraftFieldWrite {
  if (profile.entityId.length === 0) throw new TypeError("buildProtagonistCraftWrite: entityId 不得为空")
  if (profile.wish.length === 0) throw new TypeError("buildProtagonistCraftWrite: wish 清单不得为空（主角填充率硬门）")
  if (profile.motive.length === 0) throw new TypeError("buildProtagonistCraftWrite: motive 清单不得为空（主角填充率硬门）")
  if (profile.mckeeGhost.trim().length === 0) {
    throw new TypeError("buildProtagonistCraftWrite: mckeeGhost 不得为空白（主角填充率硬门）")
  }
  if (!isArcStage(profile.arcStage)) {
    throw new TypeError(`buildProtagonistCraftWrite: arcStage 非法：${String(profile.arcStage)}（U-04 提案 7 值）`)
  }
  if (!profile.wish.some((w) => w.trim().length > 0)) {
    throw new TypeError("buildProtagonistCraftWrite: wish 清单不得全为空白项")
  }
  if (!profile.motive.some((m) => m.trim().length > 0)) {
    throw new TypeError("buildProtagonistCraftWrite: motive 清单不得全为空白项")
  }

  const fundamentalsCheck = validateArcFundamentals(profile.arcFundamentals ?? null)
  if (!fundamentalsCheck.ok) {
    throw new TypeError(
      `buildProtagonistCraftWrite: arc_fundamentals 校验失败：${fundamentalsCheck.violations.map((v) => `${v.path}: ${v.message}`).join("; ")}`,
    )
  }

  const fields: EntityCraftFields = {
    wish: [...profile.wish],
    motive: [...profile.motive],
    mckee_ghost: profile.mckeeGhost,
    arc_stage: profile.arcStage,
  }
  const provenance: Record<string, { packId: string; memoryId: string }> = {
    wish: { packId: "craft.wish-motive-action", memoryId: MEMORY_WMA },
    motive: { packId: "craft.wish-motive-action", memoryId: MEMORY_WMA },
    mckee_ghost: { packId: "craft.mckee-ghost-wound", memoryId: MEMORY_GHOST },
    arc_stage: { packId: "craft.mckee-eight-fundamentals", memoryId: MEMORY_MCKEE_EIGHT },
  }

  if (profile.wmaAction && profile.wmaAction.length > 0) {
    fields.wma_action = [...profile.wmaAction]
    provenance.wma_action = { packId: "craft.wish-motive-action", memoryId: MEMORY_WMA }
  }
  if (profile.arcFundamentals) {
    fields.arc_fundamentals = { ...profile.arcFundamentals }
    provenance.arc_fundamentals = { packId: "craft.mckee-eight-fundamentals", memoryId: MEMORY_MCKEE_EIGHT }
  }
  if (profile.significantDetails && profile.significantDetails.length > 0) {
    fields.significant_details = [...profile.significantDetails]
    provenance.significant_details = { packId: "craft.significant-details", memoryId: MEMORY_DETAILS }
  }

  return { entityId: profile.entityId, fields, provenance }
}

/** 填充率度量结果。 */
export interface CraftFieldFillRate {
  /** 已填字段数 / 要求字段数 ∈ [0,1]。 */
  readonly rate: number
  readonly filled: readonly string[]
  readonly missing: readonly string[]
}

/** 单个必填字段的「已填充」判定：undefined/null/空白串/全空白项清单视为未填。 */
function isFieldFilled(fields: EntityCraftFields, field: string): boolean {
  const value = (fields as Record<string, unknown>)[field]
  if (value == null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) {
    return value.some((item) =>
      typeof item === "string" ? item.trim().length > 0 : item != null,
    )
  }
  return true
}

/**
 * 度量 canon 技法字段填充率（默认按 {@link PROTAGONIST_REQUIRED_CRAFT_FIELDS} 四字段硬门口径）。
 */
export function measureCraftFieldFillRate(
  fields: EntityCraftFields,
  required: readonly string[] = PROTAGONIST_REQUIRED_CRAFT_FIELDS,
): CraftFieldFillRate {
  const filled = required.filter((f) => isFieldFilled(fields, f))
  const missing = required.filter((f) => !isFieldFilled(fields, f))
  return {
    rate: required.length === 0 ? 1 : filled.length / required.length,
    filled,
    missing,
  }
}

// ============================================================================
// live 抓取助手（编译期工具链专用；runtime 永不直连——网络函数显式注入）
// ============================================================================

/** nmem 默认 API 基址（蓝图 §8 健康探活地址）。 */
export const NMEM_DEFAULT_BASE_URL = "http://127.0.0.1:14242"

/** 注入式网络依赖（编译期重编译脚本/CI 注入；测试注入 fake，永不触网）。 */
export interface NmemFetchDeps {
  /** GET 一个 URL 并解析 JSON（抛错=网络失败）。 */
  readonly fetchJson: (url: string) => Promise<unknown>
  readonly baseUrl?: string
}

interface NmemHealthOk {
  status?: string
  version?: string
}

/**
 * nmem 健康探活（GET {baseUrl}/health，status=="ok" 视为健康）。
 * 网络/解析失败一律返回 false（优雅中止语义，不抛错）。
 */
export async function probeNmemHealth(deps: NmemFetchDeps): Promise<boolean> {
  try {
    const body = (await deps.fetchJson(`${deps.baseUrl ?? NMEM_DEFAULT_BASE_URL}/health`)) as NmemHealthOk | null
    return body?.status === "ok"
  } catch {
    return false
  }
}

/**
 * live 抓取 nmem space 并编译（编译期专用）。
 * 抓取/解析失败原样抛出，由 {@link compileWithFallback} 统一降级。
 */
export async function fetchLiveSnapshot(deps: NmemFetchDeps): Promise<NmemSnapshot> {
  const base = deps.baseUrl ?? NMEM_DEFAULT_BASE_URL
  const health = (await deps.fetchJson(`${base}/health`)) as NmemHealthOk | null
  if (health?.status !== "ok") {
    throw new Error(`fetchLiveSnapshot: nmem 健康探活未通过（status=${String(health?.status)}）`)
  }
  const searchResult = (await deps.fetchJson(
    `${base}/api/memories/search?q=&space=${encodeURIComponent(NMEM_SNAPSHOT.spaceId)}&limit=2000`,
  )) as { memories?: unknown } | null
  const rawMemories = Array.isArray(searchResult?.memories) ? searchResult.memories : []
  const memories = rawMemories.map<NmemSnapshotMemory>((raw) => {
    const m = raw as Record<string, unknown>
    return {
      memoryId: String(m.id ?? ""),
      title: String(m.title ?? ""),
      contentExcerpt: String(m.content ?? "").slice(0, 600),
      createdAt: String(m.created_at ?? ""),
      importance: typeof m.importance === "number" ? m.importance : 0,
      unitType: String(m.unit_type ?? ""),
      labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
    }
  })
  return {
    snapshotVersion: NMEM_SNAPSHOT_VERSION + 1,
    capturedAt: new Date().toISOString(),
    serverVersion: String(health.version ?? ""),
    spaceId: NMEM_SNAPSHOT.spaceId,
    memories,
    skills: NMEM_SNAPSHOT.skills,
  }
}

/** {@link compileWithFallback} 的结果：编译来源与降级原因。 */
export interface FallbackCompileResult {
  readonly registry: CompiledTechniqueRegistry
  /** live=在线抓取编译；snapshot=回落入仓快照（离线降级路径）。 */
  readonly source: "live" | "snapshot"
  /** source=snapshot 时的降级原因（人类可读）。 */
  readonly fallbackReason?: string
}

/**
 * 带降级的编译入口（编译期工具链专用）：
 *   探活成功 → live 抓取编译；探活失败或 live 编译抛错 → 优雅中止，
 *   回落入仓快照离线编译（规则包功能不退化）。
 *
 * 注意：本函数是 T27b 重编译脚本/CI 的入口，不属于运行时生成链路；
 * runtime 模块只应 import compileFromCommittedSnapshot 的产物。
 */
export async function compileWithFallback(deps: NmemFetchDeps): Promise<FallbackCompileResult> {
  const healthy = await probeNmemHealth(deps)
  if (!healthy) {
    return {
      registry: compileFromCommittedSnapshot(),
      source: "snapshot",
      fallbackReason: `nmem 健康探活失败（${deps.baseUrl ?? NMEM_DEFAULT_BASE_URL}/health），优雅中止并回落入仓快照`,
    }
  }
  try {
    const liveSnapshot = await fetchLiveSnapshot(deps)
    return { registry: compileTechniques(liveSnapshot), source: "live" }
  } catch (error) {
    return {
      registry: compileFromCommittedSnapshot(),
      source: "snapshot",
      fallbackReason: `live 抓取/编译失败，回落入仓快照：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
