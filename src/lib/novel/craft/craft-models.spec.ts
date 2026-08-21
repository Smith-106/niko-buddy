/**
 * craft-models.spec.ts — T26 技法类型契约单测（canon-craft-fields + beat-model）。
 *
 * 覆盖（任务约束 coverage-100%）：
 *   - canon-craft-fields：四枚举注册表完整性、type guard 接受/拒绝、
 *     arc_fundamentals 机械范围校验、三表技法字段集可构造性；
 *   - beat-model：Snyder 15-beat 注册表不变量（15 拍/唯一 id/幕归属/锚点单调）、
 *     三段式区间无缝覆盖、resolveAct 边界语义、validateBeatModel 全违规路径。
 *
 * 纯类型契约测试：零 IO / 零 LLM / 零 Tauri invoke。
 */
import { describe, expect, it } from "vitest"

import {
  ARC_FUNDAMENTALS_SLOT_COUNT,
  ARC_STAGE_VALUES,
  CLOSURE_STATE_VALUES,
  CONFLICT_CALIBER_VALUES,
  NARRATIVE_MODE_VALUES,
  isArcStage,
  isClosureState,
  isConflictCaliber,
  isNarrativeMode,
  validateArcFundamentals,
  type ArcFundamentals,
  type EdgeCraftFields,
  type EntityCraftFields,
  type EpisodeCraftFields,
} from "./canon-craft-fields"
import {
  SNYDER_BEATS,
  SNYDER_BEAT_COUNT,
  THREE_ACTS,
  createEmptyBeatModel,
  getActById,
  getBeatById,
  isSnyderBeatId,
  resolveAct,
  validateBeatModel,
  type BeatModel,
} from "./beat-model"

// ============================================================================
// canon-craft-fields — 枚举注册表
// ============================================================================

describe("canon-craft-fields 枚举注册表", () => {
  it("ARC_STAGE_VALUES 为 U-04 提案 7 值且无重复", () => {
    expect(ARC_STAGE_VALUES).toHaveLength(7)
    expect(new Set(ARC_STAGE_VALUES).size).toBe(7)
    expect(ARC_STAGE_VALUES).toEqual([
      "ghost_exposed",
      "refusal",
      "commitment",
      "active",
      "crisis",
      "climax",
      "resolution",
    ])
  })

  it("CONFLICT_CALIBER_VALUES 为 U-07 提案三值", () => {
    expect([...CONFLICT_CALIBER_VALUES]).toEqual(["edgerton", "gerke", "snyder_long"])
  })

  it("NARRATIVE_MODE_VALUES 为 F-26 双值", () => {
    expect([...NARRATIVE_MODE_VALUES]).toEqual(["snyder_commercial", "longform_padding"])
  })

  it("CLOSURE_STATE_VALUES 为 R6 双值 open|closed", () => {
    expect([...CLOSURE_STATE_VALUES]).toEqual(["open", "closed"])
  })

  it("八项素质槽位上限为 8", () => {
    expect(ARC_FUNDAMENTALS_SLOT_COUNT).toBe(8)
  })
})

// ============================================================================
// canon-craft-fields — type guards
// ============================================================================

describe("canon-craft-fields type guards", () => {
  it("isArcStage 接受全部合法值并拒绝非法输入", () => {
    for (const value of ARC_STAGE_VALUES) expect(isArcStage(value)).toBe(true)
    expect(isArcStage("GHOST_EXPOSED")).toBe(false)
    expect(isArcStage("midpoint")).toBe(false)
    expect(isArcStage(7)).toBe(false)
    expect(isArcStage(null)).toBe(false)
    expect(isArcStage(undefined)).toBe(false)
  })

  it("isConflictCaliber 只接受三值", () => {
    expect(isConflictCaliber("edgerton")).toBe(true)
    expect(isConflictCaliber("gerke")).toBe(true)
    expect(isConflictCaliber("snyder_long")).toBe(true)
    expect(isConflictCaliber("snyder")).toBe(false)
    expect(isConflictCaliber("")).toBe(false)
  })

  it("isNarrativeMode 只接受双值", () => {
    expect(isNarrativeMode("snyder_commercial")).toBe(true)
    expect(isNarrativeMode("longform_padding")).toBe(true)
    expect(isNarrativeMode("episodic")).toBe(false)
    expect(isNarrativeMode(42)).toBe(false)
  })

  it("isClosureState 只接受 open|closed", () => {
    expect(isClosureState("open")).toBe(true)
    expect(isClosureState("closed")).toBe(true)
    expect(isClosureState("pending")).toBe(false)
    expect(isClosureState({})).toBe(false)
  })
})

// ============================================================================
// canon-craft-fields — arc_fundamentals 校验
// ============================================================================

describe("validateArcFundamentals", () => {
  it("null/undefined 视为合法（尚未摄取）", () => {
    expect(validateArcFundamentals(null).ok).toBe(true)
    expect(validateArcFundamentals(undefined).ok).toBe(true)
    expect(validateArcFundamentals(null).violations).toEqual([])
  })

  it("8 个 [0,1] 内槽位合法", () => {
    const full: ArcFundamentals = {
      conscious_desire: 1,
      unconscious_need: 0.5,
      ghost: 0.25,
      empathy: 0.9,
      self_awareness: 0,
      honest_perspective: 0.75,
      psychological_strength: 0.6,
      moral_fundamental: 0.4,
    }
    expect(validateArcFundamentals(full)).toEqual({ ok: true, violations: [] })
  })

  it("越界 / 非有限数字按键报告违规", () => {
    const result = validateArcFundamentals({ a: 1.5, b: -0.1, c: Number.NaN })
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.path).sort()).toEqual(["a", "b", "c"])
  })

  it("超过 8 槽位报槽位数违规", () => {
    const nine: ArcFundamentals = {}
    for (let i = 0; i < 9; i++) nine[`slot_${i}`] = 0.5
    const result = validateArcFundamentals(nine)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.path === "(slot count)")).toBe(true)
  })

  it("空字符串键名报违规", () => {
    const result = validateArcFundamentals({ "": 0.5 })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.path === "(empty key)")).toBe(true)
  })

  it("非数字类型值报违规", () => {
    const result = validateArcFundamentals({ bad: "high" as unknown as number })
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.path).toBe("bad")
  })
})

// ============================================================================
// canon-craft-fields — 三表技法字段集可构造性（wire shape 契约）
// ============================================================================

describe("canon-craft-fields 三表技法字段集", () => {
  it("EntityCraftFields 承载 F-21 人物弧光全字段", () => {
    const entity: EntityCraftFields = {
      wish: ["夺回宗门"],
      motive: ["师父被杀之仇"],
      wma_action: ["夜探藏经阁"],
      mckee_ghost: "幼年目睹灭门",
      mckee_conscious_desire: "报仇雪恨",
      mckee_unconscious_need: "学会放下",
      mckee_empathy_core: "护弱",
      arc_stage: "crisis",
      arc_fundamentals: { empathy: 0.8 },
      significant_details: ["断刃上的刻字"],
      visible_actions: [{ chapterNumber: 12, action: "单膝跪地扶起老仆" }],
      craft_meta: null,
    }
    expect(entity.arc_stage).toBe("crisis")
    expect(entity.wish).not.toEqual(entity.motive) // wish ≠ motive 结构独立（内容检查归 T28）
  })

  it("EdgeCraftFields 承载 R6 标签级标注与多米诺伏笔字段", () => {
    const edge: EdgeCraftFields = {
      beat_label: "catalyst",
      beat_hit: true,
      foreshadow_planted_at: 3,
      hook_type: "悬念钩",
      payoff_chapter: 17,
    }
    // beat_label 取值域由 Snyder 注册表约束（beat-model），此处只验证承载
    expect(edge.beat_label).toBe("catalyst")
    expect(edge.payoff_chapter).toBeGreaterThan(edge.foreshadow_planted_at ?? 0)
  })

  it("EpisodeCraftFields 承载 F-22 爽点闭环结构化列", () => {
    const episode: EpisodeCraftFields = {
      beat_hits: [
        { beat_type: "midpoint", intensity: 0.8, position_ratio: 0.5, arc_id: "arc-1", closure_state: "open" },
        { beat_type: "finale", intensity: 1, position_ratio: 0.9, arc_id: "arc-1", closure_state: "closed" },
      ],
      tension_curve: [0.2, 0.5, 0.9],
      arc_closure: [{ arc_id: "arc-1", state: "closed" }],
      hook_type: "危机钩",
      conflict_caliber: "edgerton",
      narrative_mode: "snyder_commercial",
      craft_meta: null,
    }
    expect(episode.beat_hits).toHaveLength(2)
    expect(episode.beat_hits?.[0].closure_state).toBe("open")
    expect(episode.arc_closure?.[0].state).toBe("closed")
  })
})

// ============================================================================
// beat-model — Snyder 15-beat 注册表不变量
// ============================================================================

describe("beat-model Snyder 15-beat 注册表", () => {
  it("恰好 15 拍且 id 唯一", () => {
    expect(SNYDER_BEAT_COUNT).toBe(15)
    expect(SNYDER_BEATS).toHaveLength(15)
    expect(new Set(SNYDER_BEATS.map((b) => b.id)).size).toBe(15)
  })

  it("index 连续 1..15 且顺序即叙事顺序", () => {
    SNYDER_BEATS.forEach((beat, i) => expect(beat.index).toBe(i + 1))
  })

  it("幕归属为第一幕 5 拍 / 第二幕 7 拍 / 第三幕 3 拍", () => {
    const byAct = (act: string) => SNYDER_BEATS.filter((b) => b.act === act)
    expect(byAct("act1_setup").map((b) => b.id)).toEqual([
      "opening_image",
      "theme_stated",
      "set_up",
      "catalyst",
      "debate",
    ])
    expect(byAct("act2_confrontation")).toHaveLength(7)
    expect(byAct("act3_resolution").map((b) => b.id)).toEqual([
      "break_into_three",
      "finale",
      "final_image",
    ])
    expect(byAct("act1_setup").length + byAct("act2_confrontation").length + byAct("act3_resolution").length).toBe(15)
  })

  it("名义锚点单调不减且落在 [0,1]，首拍 0 / 末拍 1", () => {
    expect(SNYDER_BEATS[0].nominalPosition).toBe(0)
    expect(SNYDER_BEATS[14].nominalPosition).toBe(1)
    for (let i = 1; i < SNYDER_BEATS.length; i++) {
      expect(SNYDER_BEATS[i].nominalPosition).toBeGreaterThanOrEqual(SNYDER_BEATS[i - 1].nominalPosition)
    }
    for (const beat of SNYDER_BEATS) {
      expect(beat.nominalPosition).toBeGreaterThanOrEqual(0)
      expect(beat.nominalPosition).toBeLessThanOrEqual(1)
    }
  })

  it("每拍的所属幕都存在于三幕注册表", () => {
    for (const beat of SNYDER_BEATS) {
      expect(getActById(beat.act)).toBeDefined()
    }
  })

  it("getBeatById / getActById 命中已知 id，未知名返回 undefined", () => {
    expect(getBeatById("midpoint")?.zh).toBe("中点")
    expect(getActById("act3_resolution")?.en).toBe("Act III — Resolution")
    expect(getBeatById("nonexistent" as never)).toBeUndefined()
    expect(getActById("act4" as never)).toBeUndefined()
  })

  it("isSnyderBeatId 接受注册表成员并拒绝未知标签", () => {
    for (const beat of SNYDER_BEATS) expect(isSnyderBeatId(beat.id)).toBe(true)
    expect(isSnyderBeatId("Opening Image")).toBe(false) // 大写原名不是注册表取值
    expect(isSnyderBeatId("mid_point")).toBe(false)
    expect(isSnyderBeatId(null)).toBe(false)
  })
})

// ============================================================================
// beat-model — 三段式结构
// ============================================================================

describe("beat-model 三段式结构", () => {
  it("恰好三幕且区间连续无缝覆盖 [0,1]", () => {
    expect(THREE_ACTS).toHaveLength(3)
    expect(THREE_ACTS[0].range[0]).toBe(0)
    expect(THREE_ACTS[2].range[1]).toBe(1)
    for (let i = 1; i < THREE_ACTS.length; i++) {
      expect(THREE_ACTS[i].range[0]).toBe(THREE_ACTS[i - 1].range[1])
    }
  })

  it("默认比例为经典 25/50/25（PROVISIONAL）", () => {
    expect(THREE_ACTS[0].range[1] - THREE_ACTS[0].range[0]).toBeCloseTo(0.25)
    expect(THREE_ACTS[1].range[1] - THREE_ACTS[1].range[0]).toBeCloseTo(0.5)
    expect(THREE_ACTS[2].range[1] - THREE_ACTS[2].range[0]).toBeCloseTo(0.25)
  })

  it("resolveAct 左闭右开边界语义正确", () => {
    expect(resolveAct(0)).toBe("act1_setup")
    expect(resolveAct(0.249)).toBe("act1_setup")
    expect(resolveAct(0.25)).toBe("act2_confrontation")
    expect(resolveAct(0.5)).toBe("act2_confrontation")
    expect(resolveAct(0.749)).toBe("act2_confrontation")
    expect(resolveAct(0.75)).toBe("act3_resolution")
    expect(resolveAct(1)).toBe("act3_resolution")
  })

  it("resolveAct 越界截断归属、非有限数字抛 TypeError", () => {
    expect(resolveAct(-0.5)).toBe("act1_setup")
    expect(resolveAct(1.5)).toBe("act3_resolution")
    expect(() => resolveAct(Number.NaN)).toThrow(TypeError)
    expect(() => resolveAct(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })
})

// ============================================================================
// beat-model — BeatModel 装配与校验
// ============================================================================

describe("createEmptyBeatModel", () => {
  it("返回双空数组模型且通过校验", () => {
    const model = createEmptyBeatModel()
    expect(model.beats).toEqual([])
    expect(model.hits).toEqual([])
    expect(validateBeatModel(model).ok).toBe(true)
  })
})

function buildSampleModel(): BeatModel {
  return {
    narrativeMode: "snyder_commercial",
    beats: [
      { beatId: "opening_image", positionRatio: 0.01 },
      { beatId: "midpoint", positionRatio: 0.52 },
      { beatId: "final_image", positionRatio: 0.99 },
    ],
    hits: [
      { beat_type: "fun_and_games", intensity: 0.6, position_ratio: 0.35, arc_id: null, closure_state: "open" },
      { beat_type: "finale", intensity: 1, position_ratio: 0.95, arc_id: "arc-main", closure_state: "closed" },
    ],
  }
}

describe("validateBeatModel", () => {
  it("样例模型合法", () => {
    expect(validateBeatModel(buildSampleModel())).toEqual({ ok: true, violations: [] })
  })

  it("未知 beatId 报违规并带索引路径", () => {
    const model = buildSampleModel()
    model.beats[1] = { beatId: "mid_point" as never, positionRatio: 0.5 }
    const result = validateBeatModel(model)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.path).toBe("beats[1].beatId")
  })

  it("positionRatio 越界报违规", () => {
    const model = buildSampleModel()
    model.beats[2].positionRatio = 1.2
    const result = validateBeatModel(model)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.path)).toContain("beats[2].positionRatio")
  })

  it("hit.intensity 越界 / 非有限数字报违规", () => {
    const model = buildSampleModel()
    model.hits[0].intensity = -0.1
    model.hits[1].intensity = Number.POSITIVE_INFINITY
    const result = validateBeatModel(model)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.path)).toEqual(["hits[0].intensity", "hits[1].intensity"])
  })

  it("hit.position_ratio 越界报违规", () => {
    const model = buildSampleModel()
    model.hits[0].position_ratio = 42
    const result = validateBeatModel(model)
    expect(result.violations[0]?.path).toBe("hits[0].position_ratio")
  })

  it("非法 closure_state 报违规（R6 open|closed）", () => {
    const model = buildSampleModel()
    model.hits[0].closure_state = "pending" as never
    const result = validateBeatModel(model)
    expect(result.ok).toBe(false)
    expect(result.violations[0]?.path).toBe("hits[0].closure_state")
  })

  it("非法 narrativeMode 报违规；null 视为未配置合法", () => {
    const bad = { ...buildSampleModel(), narrativeMode: "episodic" as never }
    expect(validateBeatModel(bad).violations[0]?.path).toBe("narrativeMode")

    const unset = { ...buildSampleModel(), narrativeMode: null }
    expect(validateBeatModel(unset).ok).toBe(true)
  })

  it("重复 beatId 允许（长篇连载同拍多现）且缺省 arc_id 合法", () => {
    const model: BeatModel = {
      beats: [
        { beatId: "catalyst", positionRatio: 0.1 },
        { beatId: "catalyst", positionRatio: 0.6 },
      ],
      hits: [{ beat_type: "debate", intensity: 0.3, position_ratio: 0.18, closure_state: "open" }],
    }
    expect(validateBeatModel(model)).toEqual({ ok: true, violations: [] })
  })

  it("多违规一次性全量报告", () => {
    const model: BeatModel = {
      narrativeMode: "nope" as never,
      beats: [{ beatId: "ghost_beat" as never, positionRatio: 2 }],
      hits: [{ beat_type: "x", intensity: 9, position_ratio: -1, closure_state: "half" as never }],
    }
    const result = validateBeatModel(model)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.path).sort()).toEqual([
      "beats[0].beatId",
      "beats[0].positionRatio",
      "hits[0].closure_state",
      "hits[0].intensity",
      "hits[0].position_ratio",
      "narrativeMode",
    ])
  })
})
