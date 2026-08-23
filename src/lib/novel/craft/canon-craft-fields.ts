/**
 * canon-craft-fields.ts — Canon 三表技法字段类型契约（T26 / F-21 人物弧光 + F-22 爽点闭环）。
 *
 * 职责（蓝图 §3 数据面 + §4 技法类型，R5/R6/R8 裁定后口径）：
 *   把 entities / edges / episodes 三表的「技法列」定义为 TS 侧 type-only 契约，
 *   供 F-20 摄取管线（T27b technique-compiler）、爽点量化（T27 thrill-quantifier）、
 *   规则包（T28 literary-craft-pack）共用同一套字段命名与枚举取值。
 *
 * 定位与边界：
 *   - 纯类型契约模块：仅导出类型 + 取值注册表常量 + 机械守卫/校验纯函数，
 *     零 IO、零 LLM、零 Tauri invoke（ADR-19 机械层零 LLM 同型态）。
 *   - 不做 Rust DDL：canon 三表 DDL 真源在 src-tauri/src/types/canon_types.rs（T11）；
 *     本模块是 TS 消费侧契约镜像，字段名与 serde snake_case 序列化对齐。
 *   - R8 强制：ArcStage（U-04）/ HookType（U-05 开放注册表）/ 桥接枚举（U-07）/
 *     爽点公式（U-01）四处必须标「提案，回指 U-xx」，不得在本模块自行定稿。
 *
 * 字段来源（蓝图 §3 原文锚点）：
 *   entities 表技法列：wish / motive / wma_action / mckee_* 四件套 / arc_stage /
 *     arc_fundamentals（八项素质 8 槽位，U-04 命名由摄取回填）/ significant_details /
 *     visible_actions / craft_meta。
 *   edges 表技法列：beat_label（Snyder 标签级标注）/ beat_hit /
 *     foreshadow_planted_at / hook_type（开端钩子挂载点 A-23.1）/ payoff_chapter。
 *   episodes 表技法列：beat_hits（结构化 JSON 列，爽点闭环依据）/ tension_curve /
 *     arc_closure / hook_type（章末钩子挂载点 A-23.2）/ conflict_caliber /
 *     craft_meta；项目级口径 narrative_mode。
 *
 * Draft-first（ADR-08）：本模块为新增 spec/源文件，不写入运行时会话状态文件，
 * 不回填正式正文/记忆，不触及草稿正式层。
 */

// ============================================================================
// 枚举注册表（R8：提案值必须回指 U-xx）
// ============================================================================

/**
 * 弧光阶段（蓝图 §4 `ArcStage`，**U-04 提案值，未定稿**）。
 *
 * U-04 真源：nmem 麦基书摘记忆（八项素质 8 槽位命名 + ArcStage 枚举一并定稿）。
 * F-20 摄取管线以 nmem 为唯一真源回填；本 7 值仅为两文档统一的提案口径。
 */
export const ARC_STAGE_VALUES = [
  "ghost_exposed",
  "refusal",
  "commitment",
  "active",
  "crisis",
  "climax",
  "resolution",
] as const

/** 弧光阶段枚举（U-04 提案，7 值弧光情节点语义）。 */
export type ArcStage = (typeof ARC_STAGE_VALUES)[number]

/** 八项素质槽位上限（蓝图 §3：`arc_fundamentals` 8 槽位；键名由 U-04 摄取回填）。 */
export const ARC_FUNDAMENTALS_SLOT_COUNT = 8

/**
 * 场景冲突桥接口径（蓝图 §3 `conflict_caliber`，**U-07 提案值，未定稿**）。
 *
 * U-07 真源：nmem 桥接规则记忆（埃杰顿 / 格尔克 / 斯奈德）；F-20 摄取时定稿。
 * snyder_long = 连载主线口径（长篇连载场景允许的延宕型冲突）。
 */
export const CONFLICT_CALIBER_VALUES = ["edgerton", "gerke", "snyder_long"] as const

/** 场景桥接口径枚举（U-07 提案三值）。 */
export type ConflictCaliber = (typeof CONFLICT_CALIBER_VALUES)[number]

/**
 * 项目级叙事模式（蓝图 §3 episodes 表「项目级口径」，F-26 项目配置）。
 *
 * 桥接默认（U-07 提案）：snyder_commercial → edgerton 默认；
 * longform_padding → gerke 可用。映射规则归 T28 craft-rule-registry 桥接表，本模块只承载枚举。
 */
export const NARRATIVE_MODE_VALUES = ["snyder_commercial", "longform_padding"] as const

/** 项目级叙事模式枚举（F-26 双值）。 */
export type NarrativeMode = (typeof NARRATIVE_MODE_VALUES)[number]

/**
 * 爽点声明/兑现闭环状态（蓝图 R6 裁定：结构化列 `closure_state`，非 JSON 兜底）。
 *
 * R6 原文：「edges 保留 beat_label/beat_hit（Snyder 标签级标注）；
 * “爽点声明/兑现”语义由 episodes.beat_hits[].closure_state（open|closed）承载」。
 */
export const CLOSURE_STATE_VALUES = ["open", "closed"] as const

/** 爽点闭环状态（open=已声明未兑现 / closed=已兑现）。 */
export type ClosureState = (typeof CLOSURE_STATE_VALUES)[number]

/**
 * 钩子类型（蓝图 §3：**开放注册表，不得定稿为封闭联合**）。
 *
 * R8 原文：HookType 为开放注册表（11 型章末 + 蔡骏五法开端，F-20 摄取注册），
 * 枚举定稿回指 **U-05**。挂载点区分（A-23.1/A-23.2）：
 *   - 开端钩子 → edges.hook_type
 *   - 章末钩子 → episodes.hook_type
 * 因此本模块不导出 HookType 联合类型，统一用 `string`（注册表取值由 T28/U-05 收口）。
 */

// ============================================================================
// entities 表技法列（人物弧光 F-21 主载体）
// ============================================================================

/** 可见行为层快照（`visible_actions` JSON 列元素，随章追加）。 */
export interface VisibleActionSnapshot {
  /** 行为发生章号（1-based）。 */
  chapterNumber: number
  /** 可观察行为描述（外部可见，非心理活动）。 */
  action: string
}

/**
 * entities 表技法字段集（蓝图 §3 entities 表「技法」行原文镜像）。
 *
 * 全部字段 additive optional（serde 默认值语义），与 T11 Rust 侧 Option 列对齐：
 * 摄取管线按需回填，读侧以 undefined/null 表示「尚未摄取」而非空串。
 */
export interface EntityCraftFields {
  /** 角色愿望清单（W-M-A 的 W；与 motive 强制区分，内容检查归 T28 规则包 A-22.1）。 */
  wish?: string[]
  /** 动机清单（与 wish 强制区分：wish=想要什么，motive=为什么要）。 */
  motive?: string[]
  /** 愿望-动机驱动的行动清单（W-M-A 的 A）。 */
  wma_action?: string[]
  /** 麦基鬼魂（主角过往创伤，U-04 提案字段族）。 */
  mckee_ghost?: string | null
  /** 麦基意识欲望（独立于 wish，A-22.1 三字段区分之一）。 */
  mckee_conscious_desire?: string | null
  /** 麦基无意识需求。 */
  mckee_unconscious_need?: string | null
  /** 麦基共情内核（善中）。 */
  mckee_empathy_core?: string | null
  /** 当前弧光阶段（U-04 提案 7 值，见 {@link ArcStage}）。 */
  arc_stage?: ArcStage | null
  /**
   * 八项素质评分表（U-04 提案：8 槽位，键名由摄取按 nmem 回填，值域 [0,1]）。
   * 缺失槽位 → diagnostic（A-22.2），范围校验见 {@link validateArcFundamentals}。
   */
  arc_fundamentals?: ArcFundamentals | null
  /** 显著细节锚点（skill_f8e81e050000，F-25；task_brief 注入源）。 */
  significant_details?: string[]
  /** 可见行为快照（随章追加的行为证据层，F-06/A-22.4）。 */
  visible_actions?: VisibleActionSnapshot[]
  /** 兜底扩展列（结构化演进前的暂存区；不得存放上面已有专列的语义）。 */
  craft_meta?: Record<string, unknown> | null
}

/** 八项素质评分表（键=U-04 回填的素质名，值=[0,1]）。 */
export type ArcFundamentals = Record<string, number>

// ============================================================================
// edges 表技法列（Snyder 标签级标注 + 多米诺伏笔，R6 口径）
// ============================================================================

/**
 * edges 表技法字段集（蓝图 §3 edges 表「技法」行原文镜像；与 T14 RawCanonEdge
 * 已有 beat_label/beat_hit 等 snake_case 字段同名同义，此处收敛成可复用子集契约）。
 */
export interface EdgeCraftFields {
  /** Snyder beat 标签（标签级标注；合法取值域见 beat-model.ts {@link SnyderBeatId} 注册表）。 */
  beat_label?: string | null
  /** 是否命中该 beat（布尔标注；“声明/兑现”语义走 episodes.beat_hits[].closure_state，R6）。 */
  beat_hit?: boolean | null
  /** 伏笔埋设章号（多米诺闭环起点）。 */
  foreshadow_planted_at?: number | null
  /** 开端钩子类型（挂载点 A-23.1；开放注册表，U-05 定稿前为自由字符串）。 */
  hook_type?: string | null
  /** 伏笔回收章号（payoff；悬空钩子检测 = 有 plant 无 payoff，T28 规则）。 */
  payoff_chapter?: number | null
}

// ============================================================================
// episodes 表技法列（爽点闭环 F-22 主载体）
// ============================================================================

/**
 * 单条爽点命中记录（episodes.beat_hits 结构化 JSON 列元素）。
 *
 * 键名刻意保持 snake_case：与蓝图 §3 原文 `{beat_type, intensity, position_ratio,
 * arc_id, closure_state}` 及 serde 序列化的存储形态逐字对齐（wire shape），
 * 量化器（T27）直接消费，不做 camelCase 转换以免双份命名漂移。
 */
export interface BeatHit {
  /** 爽点类型（beat 标签或注册表取值）。 */
  beat_type: string
  /** 强度 [0,1]（原始强度；加权公式 type_weight×payoff_magnitude×closure_decay 归 T27/U-01）。 */
  intensity: number
  /** 在全书中的位置比例 [0,1]。 */
  position_ratio: number
  /** 关联弧光 id（可空：无弧光归属的单章爽点）。 */
  arc_id?: string | null
  /** 闭环状态（R6：open=声明未兑现 / closed=已兑现；爽点闭环依据列）。 */
  closure_state: ClosureState
}

/** 单条弧光闭环记录（episodes.arc_closure 结构化 JSON 列元素）。 */
export interface ArcClosure {
  /** 弧光 id。 */
  arc_id: string
  /** 闭环状态。 */
  state: ClosureState
}

/**
 * episodes 表技法字段集（蓝图 §3 episodes 表「技法」行原文镜像）。
 * tension_curve 采样率与 EMA 平滑（raw/smoothed 双列）参数归 T27，本模块只承载列形态。
 */
export interface EpisodeCraftFields {
  /** 爽点命中记录（结构化列，非 JSON 兜底；R6 爽点闭环依据）。 */
  beat_hits?: BeatHit[]
  /** 张力曲线采样（结构化列；张弛交替 F-23 输入）。 */
  tension_curve?: number[]
  /** 弧光闭环登记（结构化列）。 */
  arc_closure?: ArcClosure[]
  /** 章末钩子类型（挂载点 A-23.2；11 型注册表 U-05 定稿前为自由字符串）。 */
  hook_type?: string | null
  /** 本章场景桥接口径（U-07 提案三值）。 */
  conflict_caliber?: ConflictCaliber | null
  /** 项目级叙事模式（F-26 配置投影到 episode 维度的只读冗余，便于单行诊断）。 */
  narrative_mode?: NarrativeMode | null
  /** 兜底扩展列。 */
  craft_meta?: Record<string, unknown> | null
}

// ============================================================================
// 机械守卫（type guard，零 LLM 纯谓词）
// ============================================================================

/** 是否合法 ArcStage 取值（运行时兜底；TS 层由联合类型约束）。 */
export function isArcStage(value: unknown): value is ArcStage {
  return typeof value === "string" && (ARC_STAGE_VALUES as readonly string[]).includes(value)
}

/** 是否合法 ConflictCaliber 取值。 */
export function isConflictCaliber(value: unknown): value is ConflictCaliber {
  return (
    typeof value === "string" && (CONFLICT_CALIBER_VALUES as readonly string[]).includes(value)
  )
}

/** 是否合法 NarrativeMode 取值。 */
export function isNarrativeMode(value: unknown): value is NarrativeMode {
  return typeof value === "string" && (NARRATIVE_MODE_VALUES as readonly string[]).includes(value)
}

/** 是否合法 ClosureState 取值。 */
export function isClosureState(value: unknown): value is ClosureState {
  return typeof value === "string" && (CLOSURE_STATE_VALUES as readonly string[]).includes(value)
}

// ============================================================================
// arc_fundamentals 校验（机械范围检查，缺失槽位判定留给规则包 T28）
// ============================================================================

/** {@link validateArcFundamentals} 的单条违规描述（path 指向违规键，message 人类可读）。 */
export interface ArcFundamentalsViolation {
  path: string
  message: string
}

/** 校验结果：ok=false 时 violations 非空。 */
export interface ArcFundamentalsValidation {
  ok: boolean
  violations: ArcFundamentalsViolation[]
}

/**
 * 校验八项素质评分表（机械范围检查，零 LLM）：
 *   - 每个值必须是 [0,1] 内的有限数字；
 *   - 槽位数不得超过 {@link ARC_FUNDAMENTALS_SLOT_COUNT}（8）；
 *   - 键不得为空字符串。
 *
 * 注意（边界）：「8 个具名槽位是否齐全」「键名是否符合 U-04 回填命名」属于内容/
 * 注册表层检查，归 T28 八项素质规则包 + U-04 定稿，本函数不做（避免抢跑未决项）。
 */
export function validateArcFundamentals(
  fundamentals: ArcFundamentals | null | undefined,
): ArcFundamentalsValidation {
  if (!fundamentals) return { ok: true, violations: [] }

  const violations: ArcFundamentalsViolation[] = []
  const keys = Object.keys(fundamentals)

  for (const key of keys) {
    if (key.length === 0) {
      violations.push({ path: "(empty key)", message: "arc_fundamentals 键不得为空字符串" })
      continue
    }
    const value = fundamentals[key]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      violations.push({
        path: key,
        message: `arc_fundamentals.${key} 必须是 [0,1] 内的有限数字，实际=${String(value)}`,
      })
    }
  }

  if (keys.length > ARC_FUNDAMENTALS_SLOT_COUNT) {
    violations.push({
      path: "(slot count)",
      message: `arc_fundamentals 槽位数 ${keys.length} 超过上限 ${ARC_FUNDAMENTALS_SLOT_COUNT}`,
    })
  }

  return { ok: violations.length === 0, violations }
}
