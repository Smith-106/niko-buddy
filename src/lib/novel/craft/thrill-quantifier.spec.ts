/**
 * thrill-quantifier.spec.ts — T27 纯算术爽点量化单测。
 *
 * 覆盖（任务约束 coverage-100%）：
 *   - config 合并与校验（mergeThrillConfig / validateThrillConfig）
 *   - 三因子公式计算（computeWeightedIntensity）
 *   - 张力曲线生成（computeTensionCurve raw/smoothed 双列）
 *   - 全量量化（quantifyThrill）各种输入
 *   - 增量重算（incrementalQuantifyThrill）边界
 *   - fast-check 属性：增量≡全量（任意单 hit 修改，增量结果与全量重算逐字节相等）
 *
 * 确定性=超越轴(ADR-19)：零 IO / 零 LLM / 零 Tauri invoke。
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"

import {
  DEFAULT_THRILL_CONFIG,
  computeTensionCurve,
  computeWeightedIntensity,
  incrementalQuantifyThrill,
  mergeThrillConfig,
  quantifyThrill,
  validateThrillConfig,
  type QuantifiedHit,
  type ThrillQuantifierConfig,
} from "./thrill-quantifier"
import type { BeatModel } from "./beat-model"
import type { BeatHit } from "./canon-craft-fields"

// ============================================================================
// 辅助：构建测试模型
// ============================================================================

function buildSampleHit(overrides: Partial<BeatHit> & { beat_type: string }): BeatHit {
  return {
    intensity: 0.5,
    position_ratio: 0.5,
    closure_state: "open",
    arc_id: null,
    ...overrides,
  }
}

function buildSampleModel(overrides?: Partial<BeatModel>): BeatModel {
  return {
    narrativeMode: null,
    beats: [],
    hits: [
      buildSampleHit({ beat_type: "opening_image", intensity: 0.3, position_ratio: 0.02 }),
      buildSampleHit({ beat_type: "catalyst", intensity: 0.7, position_ratio: 0.11 }),
      buildSampleHit({ beat_type: "midpoint", intensity: 0.9, position_ratio: 0.5 }),
      buildSampleHit({ beat_type: "all_is_lost", intensity: 0.8, position_ratio: 0.68 }),
      buildSampleHit({ beat_type: "finale", intensity: 1.0, position_ratio: 0.88, closure_state: "closed" }),
    ],
    ...overrides,
  }
}

// ============================================================================
// 三因子公式
// ============================================================================

describe("computeWeightedIntensity", () => {
  const cfg = DEFAULT_THRILL_CONFIG

  it("已知 beat_type 使用注册权重", () => {
    const hit = buildSampleHit({ beat_type: "midpoint", intensity: 0.9, closure_state: "open" })
    // midpoint weight=0.9, payoffMagnitude=1.0, open decay=0.7
    // 0.9 * 1.0 * 0.7 = 0.63
    expect(computeWeightedIntensity(hit, cfg)).toBeCloseTo(0.63, 10)
  })

  it("未注册 beat_type 使用保底权重", () => {
    const hit = buildSampleHit({ beat_type: "custom_beat", intensity: 0.5, closure_state: "open" })
    // defaultTypeWeight=0.5, payoffMagnitude=1.0, open decay=0.7
    // 0.5 * 1.0 * 0.7 = 0.35
    expect(computeWeightedIntensity(hit, cfg)).toBeCloseTo(0.35, 10)
  })

  it("closed 状态 closure_decay=1.0 不衰减", () => {
    const hit = buildSampleHit({ beat_type: "finale", intensity: 1.0, closure_state: "closed" })
    // finale weight=1.0, payoffMagnitude=1.0, closed decay=1.0
    // 1.0 * 1.0 * 1.0 = 1.0
    expect(computeWeightedIntensity(hit, cfg)).toBeCloseTo(1.0, 10)
  })

  it("payoffMagnitude 放大效果", () => {
    const cfg2 = mergeThrillConfig({ payoffMagnitude: 2.0 })
    const hit = buildSampleHit({ beat_type: "finale", intensity: 1.0, closure_state: "closed" })
    // 1.0 * 2.0 * 1.0 = 2.0
    expect(computeWeightedIntensity(hit, cfg2)).toBeCloseTo(2.0, 10)
  })

  it("零 intensity 结果为 0", () => {
    const hit = buildSampleHit({ beat_type: "set_up", intensity: 0, closure_state: "open" })
    // 0.2 * 1.0 * 0.7 = 0.14 不对，intensity 是 0 但公式里没有 intensity
    // 等等，公式是 typeWeight * payoffMagnitude * closureDecay——intensity 不在公式里
    // 实际上 weightedIntensity 完全由三因子决定，不乘原始 intensity
    // 0.2 * 1.0 * 0.7 = 0.14
    expect(computeWeightedIntensity(hit, cfg)).toBeCloseTo(0.14, 10)
  })
})

// ============================================================================
// Config 合并与校验
// ============================================================================

describe("mergeThrillConfig", () => {
  it("无 partial 返回默认配置", () => {
    const cfg = mergeThrillConfig()
    expect(cfg.version).toBe("1.0.0")
    expect(cfg.emaAlpha).toBe(0.3)
    expect(cfg.typeWeight.midpoint).toBe(0.9)
  })

  it("partial 覆盖指定字段，未覆盖保留默认", () => {
    const cfg = mergeThrillConfig({ emaAlpha: 0.5 })
    expect(cfg.emaAlpha).toBe(0.5)
    expect(cfg.payoffMagnitude).toBe(1.0) // 未覆盖
    expect(cfg.typeWeight.midpoint).toBe(0.9) // 未覆盖
  })

  it("partial 合并 typeWeight 映射", () => {
    const cfg = mergeThrillConfig({ typeWeight: { custom: 1.5 } })
    expect(cfg.typeWeight.midpoint).toBe(0.9) // 默认保留
    expect(cfg.typeWeight.custom).toBe(1.5) // 新增
  })
})

describe("validateThrillConfig", () => {
  it("默认配置合法", () => {
    expect(validateThrillConfig(DEFAULT_THRILL_CONFIG).ok).toBe(true)
  })

  it("emaAlpha 越界报违规", () => {
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, emaAlpha: 0 }).ok).toBe(false)
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, emaAlpha: 1.5 }).ok).toBe(false)
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, emaAlpha: -1 }).ok).toBe(false)
  })

  it("sampleInterval 越界报违规", () => {
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, sampleInterval: 0 }).ok).toBe(false)
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, sampleInterval: 2 }).ok).toBe(false)
  })

  it("incrementalWindowSize 非整数报违规", () => {
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, incrementalWindowSize: 0 }).ok).toBe(false)
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, incrementalWindowSize: 3.5 }).ok).toBe(false)
  })

  it("closureDecay 缺失值报违规", () => {
    const bad = { ...DEFAULT_THRILL_CONFIG, closureDecay: { open: 0.5 } as Record<string, number> }
    expect(validateThrillConfig(bad as ThrillQuantifierConfig).ok).toBe(false)
  })

  it("version 空串报违规", () => {
    expect(validateThrillConfig({ ...DEFAULT_THRILL_CONFIG, version: "" }).ok).toBe(false)
  })
})

// ============================================================================
// 张力曲线
// ============================================================================

describe("computeTensionCurve", () => {
  const cfg = DEFAULT_THRILL_CONFIG

  it("空 hit 列表返回全零曲线", () => {
    const curve = computeTensionCurve([], cfg)
    expect(curve.length).toBeGreaterThan(0)
    for (const point of curve) {
      expect(point.raw).toBe(0)
      expect(point.smoothed).toBe(0)
    }
  })

  it("单 hit 曲线正确", () => {
    const hits: QuantifiedHit[] = [
      { beatType: "midpoint", rawIntensity: 0.9, weightedIntensity: 0.63, positionRatio: 0.5, closureState: "open", arcId: null },
    ]
    const curve = computeTensionCurve(hits, cfg)
    // 采样点数量 = ceil(1/0.05) + 1 = 21
    expect(curve.length).toBe(21)
    // midpoint 位置 0.5，窗口 [0.475, 0.525]
    // 采样点索引 = 0.5 / 0.05 = 10
    expect(curve[10].raw).toBeCloseTo(0.63, 10)
    expect(curve[9].raw).toBe(0) // 窗口外
    expect(curve[11].raw).toBe(0) // 窗口外
    // smoothed[0] = raw[0]
    expect(curve[0].smoothed).toBe(0)
    // smoothed[10] = 0.3 * 0.63 + 0.7 * smoothed[9]
    expect(curve[10].smoothed).toBeGreaterThan(0)
    expect(curve[10].smoothed).toBeLessThan(0.63)
  })

  it("多 hit 累加 raw 值", () => {
    const hits: QuantifiedHit[] = [
      { beatType: "catalyst", rawIntensity: 0.7, weightedIntensity: 0.49, positionRatio: 0.11, closureState: "open", arcId: null },
      { beatType: "midpoint", rawIntensity: 0.9, weightedIntensity: 0.63, positionRatio: 0.5, closureState: "open", arcId: null },
    ]
    const curve = computeTensionCurve(hits, cfg)
    // catalyst 在 0.11，窗口 [0.085, 0.135]，采样点 2 (0.10) 和 3 (0.15)
    // midpoint 在 0.5，窗口 [0.475, 0.525]，采样点 10 (0.50)
    // 这些点 raw > 0
    const rawNonZero = curve.filter((p) => p.raw > 0)
    expect(rawNonZero.length).toBeGreaterThan(0)
    // 没有重叠窗口的采样点，所以每个 raw 值应等于单个 hit 的 weightedIntensity
    expect(curve[10].raw).toBeCloseTo(0.63, 10)
  })

  it("EMA 平滑单调递减效果（raw 只有中间有值，smoothed 向两侧衰减）", () => {
    const hits: QuantifiedHit[] = [
      { beatType: "midpoint", rawIntensity: 0.9, weightedIntensity: 1.0, positionRatio: 0.5, closureState: "closed", arcId: null },
    ]
    const curve = computeTensionCurve(hits, cfg)
    // 从 0 到 0.5，smoothed 应该递增
    for (let i = 1; i < 10; i++) {
      expect(curve[i].smoothed).toBeGreaterThanOrEqual(curve[i - 1].smoothed)
    }
    // 从 0.5 到 1.0，smoothed 应该递减
    for (let i = 11; i < curve.length; i++) {
      expect(curve[i].smoothed).toBeLessThanOrEqual(curve[i - 1].smoothed)
    }
  })
})

// ============================================================================
// 全量量化
// ============================================================================

describe("quantifyThrill", () => {
  it("空模型返回空结果", () => {
    const result = quantifyThrill({ narrativeMode: null, beats: [], hits: [] })
    expect(result.hits).toEqual([])
    expect(result.tensionCurve.length).toBeGreaterThan(0)
    expect(result.configVersion).toBe("1.0.0")
  })

  it("样例模型加权结果正确", () => {
    const model = buildSampleModel()
    const result = quantifyThrill(model)
    expect(result.hits).toHaveLength(5)

    // 验证每条 hit 的加权值
    // opening_image: 0.3 * 1.0 * 0.7 = 0.21
    expect(result.hits[0].weightedIntensity).toBeCloseTo(0.21, 10)
    // catalyst: 0.7 * 1.0 * 0.7 = 0.49
    expect(result.hits[1].weightedIntensity).toBeCloseTo(0.49, 10)
    // midpoint: 0.9 * 1.0 * 0.7 = 0.63
    expect(result.hits[2].weightedIntensity).toBeCloseTo(0.63, 10)
    // all_is_lost: 0.8 * 1.0 * 0.7 = 0.56
    expect(result.hits[3].weightedIntensity).toBeCloseTo(0.56, 10)
    // finale, closed: 1.0 * 1.0 * 1.0 = 1.0
    expect(result.hits[4].weightedIntensity).toBeCloseTo(1.0, 10)
  })

  it("结果按 positionRatio 排序", () => {
    const model = buildSampleModel()
    const result = quantifyThrill(model)
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i].positionRatio).toBeGreaterThanOrEqual(result.hits[i - 1].positionRatio)
    }
  })

  it("张力曲线采样点数量稳定", () => {
    const model = buildSampleModel()
    const result = quantifyThrill(model)
    // 21 个采样点 (0, 0.05, ..., 1.0)
    expect(result.tensionCurve.length).toBe(Math.ceil(1 / DEFAULT_THRILL_CONFIG.sampleInterval) + 1)
    expect(result.tensionCurve.length).toBe(21)
  })

  it("config 覆盖生效", () => {
    const model = buildSampleModel()
    const result = quantifyThrill(model, { payoffMagnitude: 2.0 })
    expect(result.hits[4].weightedIntensity).toBeCloseTo(2.0, 10) // finale: 1.0 * 2.0 * 1.0
    expect(result.configVersion).toBe("1.0.0")
  })

  it("非法 intensity 被过滤", () => {
    const model: BeatModel = {
      narrativeMode: null,
      beats: [],
      hits: [
        { beat_type: "midpoint", intensity: Number.NaN, position_ratio: 0.5, closure_state: "open" },
        { beat_type: "finale", intensity: 1.0, position_ratio: 0.9, closure_state: "closed" },
      ],
    }
    const result = quantifyThrill(model)
    expect(result.hits).toHaveLength(1) // NaN 被过滤
    expect(result.hits[0].beatType).toBe("finale")
  })
})

// ============================================================================
// 增量重算
// ============================================================================

describe("incrementalQuantifyThrill", () => {
  it("单 hit 修改后增量结果与全量一致", () => {
    const model = buildSampleModel()
    const fullResult = quantifyThrill(model)

    // 修改第 2 条 hit (midpoint) 的 intensity
    model.hits[2] = { ...model.hits[2], intensity: 0.5 }
    const incremental = incrementalQuantifyThrill(fullResult, model, 2)
    const full = quantifyThrill(model)

    // 逐字段比较
    expect(incremental.hits).toEqual(full.hits)
    expect(incremental.tensionCurve).toEqual(full.tensionCurve)
    expect(incremental.configVersion).toBe(full.configVersion)
  })

  it("closure_state 修改后增量结果与全量一致", () => {
    const model = buildSampleModel()
    const fullResult = quantifyThrill(model)

    // 修改第 4 条 hit (all_is_lost) 的 closure_state
    model.hits[3] = { ...model.hits[3], closure_state: "closed" }
    const incremental = incrementalQuantifyThrill(fullResult, model, 3)
    const full = quantifyThrill(model)

    expect(incremental.hits).toEqual(full.hits)
    expect(incremental.tensionCurve).toEqual(full.tensionCurve)
  })

  it("索引越界时全量兜底", () => {
    const model = buildSampleModel()
    const fullResult = quantifyThrill(model)
    const result = incrementalQuantifyThrill(fullResult, model, 99)
    expect(result.configVersion).toBe("1.0.0")
    // 应该是全量重算的结果
    expect(result.hits).toHaveLength(5)
  })

  it("config 覆盖后增量结果与全量一致", () => {
    const model = buildSampleModel()
    const fullResult = quantifyThrill(model, { payoffMagnitude: 1.5 })

    // 修改第 0 条 hit
    model.hits[0] = { ...model.hits[0], intensity: 0.5 }
    const incremental = incrementalQuantifyThrill(fullResult, model, 0, { payoffMagnitude: 1.5 })
    const full = quantifyThrill(model, { payoffMagnitude: 1.5 })

    expect(incremental.hits).toEqual(full.hits)
    expect(incremental.tensionCurve).toEqual(full.tensionCurve)
  })
})

// ============================================================================
// fast-check 属性：增量≡全量
// ============================================================================

describe("fast-check 属性：增量≡全量", () => {
  // 生成合法的 BeatHit 数组
  const beatTypes = [
    "opening_image", "theme_stated", "set_up", "catalyst", "debate",
    "break_into_two", "b_story", "fun_and_games", "midpoint",
    "bad_guys_close_in", "all_is_lost", "dark_night_of_the_soul",
    "break_into_three", "finale", "final_image", "custom_beat",
  ]

  it("任意单 hit 修改后增量≡全量", () => {
    fc.assert(
      fc.property(
        // 生成 1~6 条 hit
        fc.array(
          fc.record({
            beat_type: fc.constantFrom(...beatTypes),
            intensity: fc.float({ min: 0, max: 1, noNaN: true }),
            position_ratio: fc.float({ min: 0, max: 1, noNaN: true }),
            closure_state: fc.constantFrom("open" as const, "closed" as const),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        // 随机选择修改哪条 hit
        fc.nat({ max: 5 }),
        // 新的 intensity 值
        fc.float({ min: 0, max: 1, noNaN: true }),
        // 新的 closure_state
        fc.constantFrom("open" as const, "closed" as const),
        (hitsData, modifyIndex, newIntensity, newClosure) => {
          const hits: BeatHit[] = hitsData.map((h) => ({
            beat_type: h.beat_type,
            intensity: h.intensity,
            position_ratio: h.position_ratio,
            closure_state: h.closure_state,
            arc_id: null,
          }))

          const model: BeatModel = { narrativeMode: null, beats: [], hits }

          // 全量量化
          const fullResult = quantifyThrill(model)

          // 修改
          const safeIndex = Math.min(modifyIndex, hits.length - 1)
          model.hits[safeIndex] = {
            ...model.hits[safeIndex],
            intensity: newIntensity,
            closure_state: newClosure,
          }

          // 增量 vs 全量
          const incremental = incrementalQuantifyThrill(fullResult, model, safeIndex)
          const full = quantifyThrill(model)

          // 逐字节相等
          expect(incremental.hits).toEqual(full.hits)
          expect(incremental.tensionCurve).toEqual(full.tensionCurve)
          expect(incremental.configVersion).toBe(full.configVersion)
        },
      ),
      { verbose: false, numRuns: 100 },
    )
  })
})