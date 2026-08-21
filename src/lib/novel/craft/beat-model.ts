/**
 * beat-model.ts — 节拍模型：Snyder 15-beat 注册表 + 三段式结构（T26 / F-21+F-22 输入契约）。
 *
 * 职责（蓝图 §4 技法类型 `BeatModel` + R6 标签级标注口径）：
 *   定义 Save the Cat 15-beat 注册表与三段式（three-act）结构，作为：
 *   - edges.beat_label 的合法取值域（Snyder 标签级标注，R6）；
 *   - T27 thrill-quantifier 纯算术量化（`quantifyThrill(model: BeatModel, ...)`
 *     蓝图 §4 原文签名）的输入模型；
 *   - F-26 叙事口径（narrative_mode）与 beat 层的连接点。
 *
 * 定位与边界：
 *   - 纯类型 + 注册表常量 + 机械校验纯函数：零 IO、零 LLM、零 Tauri invoke。
 *   - 三段式边界与 Snyder 锚点位置为 **PROVISIONAL 默认值**（经典 25/50/25 与
 *     救猫咪页码标记 /110 归一），非 U-xx 定稿项；T27/T31 实测后可经
 *     decision-log 复核调整，改动须留档。
 *   - HookType 不在本模块定稿（R8 开放注册表，U-05；见 canon-craft-fields.ts 注记）。
 *   - closure_state 复用 canon-craft-fields 的 {@link ClosureState}（R6 结构化列口径），
 *     本模块不重复定义。
 *
 * Draft-first（ADR-08）：新增纯类型模块，不写运行时会话状态，不触及草稿正式层。
 */

import { isClosureState, isNarrativeMode, type BeatHit, type NarrativeMode } from "./canon-craft-fields"

// ============================================================================
// 三段式结构（three-act）
// ============================================================================

/** 三幕标识。 */
export type ThreeActId = "act1_setup" | "act2_confrontation" | "act3_resolution"

/** 三幕定义：比例区间 [start, end] ⊆ [0,1]，左闭右开（末幕右端闭区间含 1）。 */
export interface ThreeActDef {
  id: ThreeActId
  /** 中文幕名。 */
  zh: string
  /** 英文幕名。 */
  en: string
  /** 全书位置比例区间 [start, end]。 */
  range: readonly [number, number]
}

/**
 * 经典三段式默认结构（PROVISIONAL 默认值）：第一幕 25% / 第二幕 50% / 第三幕 25%。
 * 区间连续无缝覆盖 [0,1]；与 Snyder 页码标记（break into two ≈ p25/110、
 * all is lost ≈ p75/110）一致。调整须经 decision-log 留档。
 */
export const THREE_ACTS: readonly ThreeActDef[] = [
  { id: "act1_setup", zh: "第一幕·建置", en: "Act I — Setup", range: [0, 0.25] },
  { id: "act2_confrontation", zh: "第二幕·对抗", en: "Act II — Confrontation", range: [0.25, 0.75] },
  { id: "act3_resolution", zh: "第三幕·解决", en: "Act III — Resolution", range: [0.75, 1] },
]

// ============================================================================
// Snyder 15-beat 注册表（Save the Cat）
// ============================================================================

/** Snyder 15-beat 标识（snake_case；即 edges.beat_label 的注册表取值域）。 */
export type SnyderBeatId =
  | "opening_image"
  | "theme_stated"
  | "set_up"
  | "catalyst"
  | "debate"
  | "break_into_two"
  | "b_story"
  | "fun_and_games"
  | "midpoint"
  | "bad_guys_close_in"
  | "all_is_lost"
  | "dark_night_of_the_soul"
  | "break_into_three"
  | "finale"
  | "final_image"

/** 单个 Snyder beat 定义。 */
export interface SnyderBeatDef {
  id: SnyderBeatId
  /** 1-based 序号（全书叙事顺序）。 */
  index: number
  /** 英文原名（Save the Cat）。 */
  en: string
  /** 中文通行译名。 */
  zh: string
  /** 所属三幕。 */
  act: ThreeActId
  /**
   * 名义锚点位置 [0,1]（PROVISIONAL：救猫咪 110 页页码标记归一；
   * 区段型 beat 取区段中点）。仅供缺省摆放/诊断参考，实际以摄取的
   * position_ratio 为准。
   */
  nominalPosition: number
}

/**
 * Snyder 15-beat 注册表（顺序 = 叙事顺序；act 划分按三段式默认结构）。
 *
 * 幕归属：第一幕 5 拍（opening_image..debate）、第二幕 7 拍
 * （break_into_two..dark_night_of_the_soul，含第二幕后半程低谷段）、第三幕 3 拍
 * （break_into_three..final_image）——与救猫咪原书节拍表逐条对应。
 */
export const SNYDER_BEATS: readonly SnyderBeatDef[] = [
  { id: "opening_image", index: 1, en: "Opening Image", zh: "开场画面", act: "act1_setup", nominalPosition: 0.0 },
  { id: "theme_stated", index: 2, en: "Theme Stated", zh: "主题呈现", act: "act1_setup", nominalPosition: 0.05 },
  { id: "set_up", index: 3, en: "Set-Up", zh: "铺垫", act: "act1_setup", nominalPosition: 0.07 },
  { id: "catalyst", index: 4, en: "Catalyst", zh: "催化剂", act: "act1_setup", nominalPosition: 0.11 },
  { id: "debate", index: 5, en: "Debate", zh: "争执", act: "act1_setup", nominalPosition: 0.17 },
  { id: "break_into_two", index: 6, en: "Break into Two", zh: "进入第二幕", act: "act2_confrontation", nominalPosition: 0.23 },
  { id: "b_story", index: 7, en: "B Story", zh: "B 故事", act: "act2_confrontation", nominalPosition: 0.27 },
  { id: "fun_and_games", index: 8, en: "Fun and Games", zh: "游戏时光", act: "act2_confrontation", nominalPosition: 0.38 },
  { id: "midpoint", index: 9, en: "Midpoint", zh: "中点", act: "act2_confrontation", nominalPosition: 0.5 },
  { id: "bad_guys_close_in", index: 10, en: "Bad Guys Close In", zh: "坏人逼近", act: "act2_confrontation", nominalPosition: 0.59 },
  { id: "all_is_lost", index: 11, en: "All Is Lost", zh: "一无所有", act: "act2_confrontation", nominalPosition: 0.68 },
  { id: "dark_night_of_the_soul", index: 12, en: "Dark Night of the Soul", zh: "灵魂黑夜", act: "act2_confrontation", nominalPosition: 0.72 },
  { id: "break_into_three", index: 13, en: "Break into Three", zh: "进入第三幕", act: "act3_resolution", nominalPosition: 0.77 },
  { id: "finale", index: 14, en: "Finale", zh: "结局", act: "act3_resolution", nominalPosition: 0.88 },
  { id: "final_image", index: 15, en: "Final Image", zh: "终场画面", act: "act3_resolution", nominalPosition: 1.0 },
]

/** 15-beat 总数（注册表自检不变量，spec 断言 == 15）。 */
export const SNYDER_BEAT_COUNT = SNYDER_BEATS.length

// ============================================================================
// BeatModel（T27 quantifyThrill 输入契约）
// ============================================================================

/** 单条 Snyder beat 摆放记录（edges.beat_label 标签级标注的模型层投影，R6）。 */
export interface BeatPlacement {
  /** Snyder beat 标识（注册表取值）。 */
  beatId: SnyderBeatId
  /** 在全书中的位置比例 [0,1]（摄取实测值，优先于名义锚点）。 */
  positionRatio: number
}

/**
 * 节拍模型（蓝图 §4 `quantifyThrill(model: BeatModel, ...)` 输入契约）。
 *
 * 两路输入正交：
 *   - beats：Snyder 标签级标注（结构性节拍，R6「标签级」口径）；
 *   - hits：爽点声明/兑现记录（episodes.beat_hits 结构化列投影，含闭环语义）。
 */
export interface BeatModel {
  /** 项目级叙事口径（F-26；缺省视为未配置，桥接默认归 T28 注册表）。 */
  narrativeMode?: NarrativeMode | null
  /** Snyder beat 摆放（长篇连载同一 beat 可多次出现，允许重复标签）。 */
  beats: BeatPlacement[]
  /** 爽点命中记录（snake_case wire shape，见 canon-craft-fields.ts {@link BeatHit}）。 */
  hits: BeatHit[]
}

// ============================================================================
// 机械守卫与查询（零 LLM 纯函数）
// ============================================================================

/** 是否合法 SnyderBeatId（edges.beat_label 写前兜底校验用）。 */
export function isSnyderBeatId(value: unknown): value is SnyderBeatId {
  return (
    typeof value === "string" &&
    SNYDER_BEATS.some((beat) => beat.id === value)
  )
}

/** 按 id 取 beat 定义。 */
export function getBeatById(id: SnyderBeatId): SnyderBeatDef | undefined {
  return SNYDER_BEATS.find((beat) => beat.id === id)
}

/** 按幕 id 取幕定义。 */
export function getActById(id: ThreeActId): ThreeActDef | undefined {
  return THREE_ACTS.find((act) => act.id === id)
}

/**
 * 位置比例 → 所属幕（左闭右开，末幕含 1；越界输入按截断归属：
 * <0 归第一幕、>1 归第三幕，不抛错——连载增量摄取中越界属脏数据，
 * 由 {@link validateBeatModel} 报告而非此处中断）。
 */
export function resolveAct(positionRatio: number): ThreeActId {
  if (!Number.isFinite(positionRatio)) {
    throw new TypeError(`resolveAct: positionRatio 必须是有限数字，实际=${String(positionRatio)}`)
  }
  for (const act of THREE_ACTS) {
    const [start, end] = act.range
    const isLast = act.id === THREE_ACTS[THREE_ACTS.length - 1].id
    if (positionRatio >= start && (positionRatio < end || (isLast && positionRatio <= end))) {
      return act.id
    }
  }
  // 截断语义：range 已无缝覆盖 [0,1]，仅越界值会走到这里。
  return positionRatio < 0 ? THREE_ACTS[0].id : THREE_ACTS[THREE_ACTS.length - 1].id
}

/** 创建空节拍模型（beats/hits 双空数组，便于增量装配）。 */
export function createEmptyBeatModel(): BeatModel {
  return { narrativeMode: null, beats: [], hits: [] }
}

// ============================================================================
// BeatModel 校验（机械检查，零 LLM）
// ============================================================================

/** {@link validateBeatModel} 的单条违规描述。 */
export interface BeatModelViolation {
  path: string
  message: string
}

/** 校验结果：ok=false 时 violations 非空。 */
export interface BeatModelValidation {
  ok: boolean
  violations: BeatModelViolation[]
}

/**
 * 校验节拍模型（机械范围/注册表检查，零 LLM）：
 *   - narrativeMode（若提供）必须是合法 NarrativeMode；
 *   - 每个 beat.beatId 必须在 Snyder 注册表内；
 *   - 每个 beat.positionRatio / hit.position_ratio 必须是 [0,1] 内有限数字；
 *   - 每个 hit.intensity 必须是 [0,1] 内有限数字；
 *   - 每个 hit.closure_state 必须是合法 ClosureState。
 *
 * 允许（不报错）：空 beats/hits（增量装配中间态）；重复 beatId（长篇连载同拍多现）；
 * hit.arc_id 缺省。
 */
export function validateBeatModel(model: BeatModel): BeatModelValidation {
  const violations: BeatModelViolation[] = []

  if (model.narrativeMode != null && !isNarrativeMode(model.narrativeMode)) {
    violations.push({
      path: "narrativeMode",
      message: `narrativeMode 非法：${String(model.narrativeMode)}`,
    })
  }

  model.beats.forEach((placement, i) => {
    if (!isSnyderBeatId(placement.beatId)) {
      violations.push({
        path: `beats[${i}].beatId`,
        message: `beatId 不在 Snyder 15-beat 注册表内：${String(placement.beatId)}`,
      })
    }
    if (
      typeof placement.positionRatio !== "number" ||
      !Number.isFinite(placement.positionRatio) ||
      placement.positionRatio < 0 ||
      placement.positionRatio > 1
    ) {
      violations.push({
        path: `beats[${i}].positionRatio`,
        message: `positionRatio 必须是 [0,1] 内有限数字，实际=${String(placement.positionRatio)}`,
      })
    }
  })

  model.hits.forEach((hit, i) => {
    if (typeof hit.intensity !== "number" || !Number.isFinite(hit.intensity) || hit.intensity < 0 || hit.intensity > 1) {
      violations.push({
        path: `hits[${i}].intensity`,
        message: `intensity 必须是 [0,1] 内有限数字，实际=${String(hit.intensity)}`,
      })
    }
    if (
      typeof hit.position_ratio !== "number" ||
      !Number.isFinite(hit.position_ratio) ||
      hit.position_ratio < 0 ||
      hit.position_ratio > 1
    ) {
      violations.push({
        path: `hits[${i}].position_ratio`,
        message: `position_ratio 必须是 [0,1] 内有限数字，实际=${String(hit.position_ratio)}`,
      })
    }
    if (!isClosureState(hit.closure_state)) {
      violations.push({
        path: `hits[${i}].closure_state`,
        message: `closure_state 非法：${String(hit.closure_state)}（合法值 open|closed，R6）`,
      })
    }
  })

  return { ok: violations.length === 0, violations }
}
