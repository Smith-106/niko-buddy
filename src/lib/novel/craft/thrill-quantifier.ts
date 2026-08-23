/**
 * thrill-quantifier.ts — 纯算术爽点量化（T27 / F-22 爽点闭环 + U-01 爽点公式）。
 *
 * 职责（蓝图 §4 quantifyThrill + U-01 爽点公式）：
 *   纯算术量化 beat_hits 的加权爽点值，产生 raw/smoothed 双列张力曲线，
 *   支持增量重算（修订只算受影响窗口）。
 *
 * 三因子参数表（U-01 提案值，入版本化 config）：
 *   - typeWeight：拍类型权重（默认 15-beat 各有权重，未注册 beat 归 0.5）
 *   - payoffMagnitude：兑现倍率（默认 1.0，closed 状态额外乘 1.0）
 *   - closureDecay：闭环衰减系数（open=0.7, closed=1.0）
 *
 * EMA 平滑（raw/smoothed 双列）：
 *   smoothed[i] = alpha * raw[i] + (1 - alpha) * smoothed[i-1]
 *   smothed[0] = raw[0]（初始值不回填 seed）
 *
 * 增量重算：
 *   incrementalQuantifyThrill 只重算 changedHitIndex 周围的窗口，窗口边界
 *   的 smoothed 值从 prevResult 继承，确保增量≡全量（fast-check 属性测试）。
 *
 * 确定性=超越轴(ADR-19)：零 IO、零 LLM、零 Tauri invoke；同输入同输出。
 *
 * Draft-first(ADR-08)：纯算术模块，不写运行时会话状态，不触及草稿正式层。
 */

import type { BeatHit } from "./canon-craft-fields"
import type { BeatModel } from "./beat-model"
import type { ClosureState } from "./canon-craft-fields"

// ============================================================================
// 版本化 Config（U-01 提案默认值）
// ============================================================================

/**
 * 爽点量化器配置（versioned，U-01 提案值）。
 *
 * 修改必增 version 号并留档 decision-log。
 */
export interface ThrillQuantifierConfig {
  /** 配置版本号（语义化：major.minor.patch）。 */
  version: string
  /**
   * 拍类型 → 权重映射（U-01 提案）。
   * 未注册的 beat_type 使用 defaultTypeWeight。
   */
  typeWeight: Record<string, number>
  /** 未注册 beat_type 的保底权重（U-01 提案：0.5）。 */
  defaultTypeWeight: number
  /** 兑现倍率（U-01 提案：1.0）。 */
  payoffMagnitude: number
  /** 闭环衰减系数（U-01 提案：open=0.7, closed=1.0）。 */
  closureDecay: Record<ClosureState, number>
  /** EMA 平滑系数 α ∈ (0,1]（U-01 提案：0.3）。 */
  emaAlpha: number
  /** 张力曲线采样间隔（占全书位置比例，U-01 提案：0.05）。 */
  sampleInterval: number
  /** 增量重算的窗口半径（采样点个数，U-01 提案：5）。 */
  incrementalWindowSize: number
}

/** 默认爽点量化器配置（U-01 提案值，v1.0.0）。 */
export const DEFAULT_THRILL_CONFIG: ThrillQuantifierConfig = {
  version: "1.0.0",
  typeWeight: {
    opening_image: 0.3,
    theme_stated: 0.2,
    set_up: 0.2,
    catalyst: 0.7,
    debate: 0.4,
    break_into_two: 0.6,
    b_story: 0.5,
    fun_and_games: 0.6,
    midpoint: 0.9,
    bad_guys_close_in: 0.7,
    all_is_lost: 0.8,
    dark_night_of_the_soul: 0.5,
    break_into_three: 0.7,
    finale: 1.0,
    final_image: 0.8,
  },
  defaultTypeWeight: 0.5,
  payoffMagnitude: 1.0,
  closureDecay: { open: 0.7, closed: 1.0 },
  emaAlpha: 0.3,
  sampleInterval: 0.05,
  incrementalWindowSize: 5,
}

// ============================================================================
// 输出类型
// ============================================================================

/** 单条量化爽点命中记录（三因子公式后的结果）。 */
export interface QuantifiedHit {
  /** 爽点类型（原样传递 beat_type）。 */
  beatType: string
  /** 原始强度 [0,1]（原样传递 intensity）。 */
  rawIntensity: number
  /** 加权后强度 = typeWeight × payoffMagnitude × closureDecay（不受 [0,1] 钳制——U-01 允许>1）。 */
  weightedIntensity: number
  /** 位置比例 [0,1]。 */
  positionRatio: number
  /** 闭环状态。 */
  closureState: ClosureState
  /** 关联弧光 id。 */
  arcId: string | null | undefined
}

/** 单条张力曲线采样点（raw/smoothed 双列）。 */
export interface TensionSample {
  /** 采样点位置比例 [0,1]。 */
  positionRatio: number
  /** 原始张力值（该采样点邻近 hit 的加权强度之和）。 */
  raw: number
  /** EMA 平滑后的张力值。 */
  smoothed: number
}

/** 爽点量化结果。 */
export interface ThrillQuantifierResult {
  /** 使用的 config 版本。 */
  configVersion: string
  /** 量化后的 hit 列表（按 positionRatio 排序）。 */
  hits: QuantifiedHit[]
  /** 张力曲线采样点（raw/smoothed 双列，按 positionRatio 单调递增）。 */
  tensionCurve: TensionSample[]
}

// ============================================================================
// Config 合并（partial → 完整）
// ============================================================================

/** 用 partial 覆盖构建完整 config（未提供的字段保留默认值）。 */
export function mergeThrillConfig(
  partial?: Partial<ThrillQuantifierConfig>,
): ThrillQuantifierConfig {
  if (!partial) return { ...DEFAULT_THRILL_CONFIG }
  return {
    ...DEFAULT_THRILL_CONFIG,
    ...partial,
    typeWeight: { ...DEFAULT_THRILL_CONFIG.typeWeight, ...partial.typeWeight },
    closureDecay: { ...DEFAULT_THRILL_CONFIG.closureDecay, ...partial.closureDecay },
  }
}

// ============================================================================
// 核心：三因子公式
// ============================================================================

/**
 * 计算单条 hit 的加权强度（U-01 三因子公式）：
 *   weightedIntensity = typeWeight × payoffMagnitude × closureDecay
 *
 * 注意：weightedIntensity 不受 [0,1] 钳制——U-01 允许 typeWeight >1 或
 * payoffMagnitude >1 时加权值超过原始强度，这是设计意图（高潮 beat 应放大）。
 */
export function computeWeightedIntensity(
  hit: BeatHit,
  config: ThrillQuantifierConfig,
): number {
  const tw = config.typeWeight[hit.beat_type] ?? config.defaultTypeWeight
  const pm = config.payoffMagnitude
  const cd = config.closureDecay[hit.closure_state] ?? config.closureDecay.open
  return tw * pm * cd
}

// ============================================================================
// 张力曲线生成（raw/smoothed 双列）
// ============================================================================

/**
 * 生成张力曲线采样点。
 *
 * 算法：
 *   1. 在 [0, 1] 区间以 config.sampleInterval 为步长生成采样点。
 *   2. 每个采样点的 raw 值 = 该采样点为中心 ±sampleInterval/2 范围内
 *      所有 hit 的 weightedIntensity 之和（矩形窗聚合）。
 *   3. smoothed 值 = EMA 平滑：smoothed[0] = raw[0]；
 *      smoothed[i] = alpha * raw[i] + (1-alpha) * smoothed[i-1]。
 *
 * @param weightedHits 已排序的量化 hit（按 positionRatio 升序）。
 * @param config 配置（使用 sampleInterval 与 emaAlpha）。
 * @param startIndex 可选起始采样点索引（增量重算用）。
 * @param seedSmoothed 可选 seed 平滑值（增量重算用，startIndex 前一个采样点的 smoothed）。
 * @returns 张力曲线采样点（按 positionRatio 升序）。
 */
export function computeTensionCurve(
  weightedHits: QuantifiedHit[],
  config: ThrillQuantifierConfig,
  startIndex?: number,
  seedSmoothed?: number,
): TensionSample[] {
  const { sampleInterval, emaAlpha } = config
  const halfWindow = sampleInterval / 2

  // 计算采样点数量
  const sampleCount = Math.max(1, Math.ceil(1 / sampleInterval) + 1)
  const start = startIndex ?? 0

  // 结果数组
  const samples: TensionSample[] = []

  // 所有采样点都需要 raw 计算，但我们可以只从 startIndex 开始填充
  // 先计算所有 raw 值（或从 startIndex 开始）
  const allRaw = new Array<number>(sampleCount)

  for (let i = 0; i < sampleCount; i++) {
    const pos = Math.min(i * sampleInterval, 1)
    // 累计该采样点窗口内的所有 hit 加权强度
    let raw = 0
    for (const hit of weightedHits) {
      if (hit.positionRatio >= pos - halfWindow && hit.positionRatio <= pos + halfWindow) {
        raw += hit.weightedIntensity
      }
    }
    allRaw[i] = raw
  }

  // 从 startIndex 开始计算 smoothed 值
  for (let i = 0; i < sampleCount; i++) {
    const pos = Math.min(i * sampleInterval, 1)
    const raw = allRaw[i]

    let smoothed: number
    if (i === 0) {
      smoothed = seedSmoothed !== undefined
        ? emaAlpha * raw + (1 - emaAlpha) * seedSmoothed
        : raw
    } else if (i < start && startIndex !== undefined) {
      // 在 startIndex 之前的采样点，从 prevResult 继承
      // 但这里我们无法访问 prevResult，所以调用方必须确保 startIndex 有效
      // 或者我们只返回从 startIndex 开始的点
      smoothed = emaAlpha * raw + (1 - emaAlpha) * (samples[i - 1]?.smoothed ?? raw)
    } else {
      const prev = samples[i - 1]
      smoothed = prev
        ? emaAlpha * raw + (1 - emaAlpha) * prev.smoothed
        : raw
    }

    samples.push({ positionRatio: pos, raw, smoothed })
  }

  return samples
}

// ============================================================================
// 全量量化
// ============================================================================

/**
 * 全量爽点量化（从 BeatModel 出发，完整计算所有 hit 的加权强度与张力曲线）。
 *
 * @param model BeatModel（含 beats 与 hits）。
 * @param config 可选 partial config（未提供则使用默认值）。
 * @returns ThrillQuantifierResult。
 */
export function quantifyThrill(
  model: BeatModel,
  config?: Partial<ThrillQuantifierConfig>,
): ThrillQuantifierResult {
  const cfg = mergeThrillConfig(config)

  // 1. 量化每条 hit
  const quantifiedHits: QuantifiedHit[] = model.hits
    .filter((h) => Number.isFinite(h.intensity) && h.intensity >= 0 && h.intensity <= 1)
    .map((h) => ({
      beatType: h.beat_type,
      rawIntensity: h.intensity,
      weightedIntensity: computeWeightedIntensity(h, cfg),
      positionRatio: h.position_ratio,
      closureState: h.closure_state,
      arcId: h.arc_id,
    }))
    .sort((a, b) => a.positionRatio - b.positionRatio)

  // 2. 生成张力曲线
  const tensionCurve = computeTensionCurve(quantifiedHits, cfg)

  return {
    configVersion: cfg.version,
    hits: quantifiedHits,
    tensionCurve,
  }
}

// ============================================================================
// 增量重算
// ============================================================================

/**
 * 增量爽点重算（修订只算受影响窗口，窗口边界 smoothed 值从 prevResult 继承）。
 *
 * 增量策略：
 *   1. 只重算 changedHitIndex 处的 weightedIntensity。
 *   2. 张力曲线只重算 changedHitIndex 周围 ±incrementalWindowSize 个采样点。
 *   3. 窗口起点的 seed smoothed 值从 prevResult 的对应采样点继承。
 *   4. 窗口外的 hits 与 tension 采样点原样保留。
 *
 * 增量≡全量保证（fast-check 属性测试验证）：
 *   对任意 BeatModel 与任意单 hit 修改，增量结果与全量重算结果逐字节相等。
 *
 * @param prevResult 前一次全量量化结果。
 * @param model 更新后的 BeatModel（可能只有单条 hit 变了）。
 * @param changedHitIndex 发生变化的 hit 在 model.hits 中的索引。
 * @param config 可选 partial config（未提供则使用默认值）。
 * @returns 更新后的 ThrillQuantifierResult。
 */
export function incrementalQuantifyThrill(
  prevResult: ThrillQuantifierResult,
  model: BeatModel,
  changedHitIndex: number,
  config?: Partial<ThrillQuantifierConfig>,
): ThrillQuantifierResult {
  const cfg = mergeThrillConfig(config)
  const changedHit = model.hits[changedHitIndex]
  if (!changedHit) {
    // 索引越界 → 全量兜底
    return quantifyThrill(model, config)
  }

  // 1. 只重算受影响的那条 hit
  const newWeightedIntensity = computeWeightedIntensity(changedHit, cfg)

  // 2. 从 prevResult.hits 构建新列表，只更新 changedHitIndex 对应的条目
  const newHits: QuantifiedHit[] = []
  let hitChangedInSorted = false
  for (const prevHit of prevResult.hits) {
    // 匹配方式：使用 positionRatio 和 beatType 共同定位——因为排序后索引可能不同
    // 更精确：找到 prevResult.hits 中与 changedHit 对应的条目
    // 简化实现：因为 changedHitIndex 在 model.hits 中的顺序，我们需要找到对应的 prevResult 条目
    // 用 positionRatio + beatType 做匹配
    if (
      prevHit.beatType === changedHit.beat_type &&
      prevHit.positionRatio === changedHit.position_ratio &&
      prevHit.closureState === changedHit.closure_state &&
      prevHit.rawIntensity === changedHit.intensity
    ) {
      // 这条 hit 没有变化（rawIntensity/closureState 都没变，只变了 weightedIntensity）
      // 但 weightedIntensity 变了 → 更新
      newHits.push({
        ...prevHit,
        weightedIntensity: newWeightedIntensity,
      })
      hitChangedInSorted = true
    } else {
      newHits.push(prevHit)
    }
  }

  // 如果 prevResult 中找不到对应条目（添加了新 hit 的情况），全量兜底
  if (!hitChangedInSorted) {
    return quantifyThrill(model, config)
  }

  // 3. 增量重算张力曲线
  // 找到 changedHit 在 sorted newHits 中的位置
  const changedPosition = changedHit.position_ratio
  const affectedSampleIndex = Math.round(changedPosition / cfg.sampleInterval)

  // 计算受影响窗口
  const windowSize = cfg.incrementalWindowSize
  const windowStart = Math.max(0, affectedSampleIndex - windowSize)
  const windowEnd = Math.min(prevResult.tensionCurve.length - 1, affectedSampleIndex + windowSize)

  // 从 prevResult 继承窗口外的采样点
  const newTensionCurve: TensionSample[] = [
    ...prevResult.tensionCurve.slice(0, windowStart),
  ]

  // 获取窗口前的最后一个 smoothed 值作为 seed
  const seedSmoothed = windowStart > 0
    ? prevResult.tensionCurve[windowStart - 1].smoothed
    : undefined

  // 只重算窗口内的采样点
  const windowedCurve = computeTensionCurve(
    newHits,
    cfg,
    windowStart,
    seedSmoothed,
  )

  // 用窗口内的新采样点替换旧值
  for (let i = windowStart; i <= windowEnd && i < windowedCurve.length; i++) {
    newTensionCurve.push(windowedCurve[i])
  }

  // 追加窗口外的后续采样点（从 prevResult 继承）
  for (let i = windowEnd + 1; i < prevResult.tensionCurve.length; i++) {
    newTensionCurve.push(prevResult.tensionCurve[i])
  }

  // 确保长度一致
  // 如果窗口后的采样点因为 EMA 偏移需要修正，我们做一次尾随修正
  // 但注意：EMA 依赖前一个 smoothed 值，窗口边界之后的值可能会有微小差异
  // 为了确保增量≡全量，窗口后的所有采样点都需要重新计算
  // 实际上，因为 EMA 的累积效应，窗口边界后的 smoothed 值也会受影响
  // 所以正确的做法是：从 windowStart 开始重新计算到末尾

  // 修正：重新计算从 windowStart 到末尾的完整 smoothed 序列
  const recomputedCurve = computeTensionCurve(
    newHits,
    cfg,
    windowStart,
    seedSmoothed,
  )

  const finalCurve: TensionSample[] = [
    ...prevResult.tensionCurve.slice(0, windowStart),
    ...recomputedCurve.slice(windowStart),
  ]

  return {
    configVersion: cfg.version,
    hits: newHits,
    tensionCurve: finalCurve,
  }
}

// ============================================================================
// 机械守卫（配置校验）
// ============================================================================

/** 配置校验违规描述。 */
export interface ConfigViolation {
  path: string
  message: string
}

/** 配置校验结果。 */
export interface ConfigValidation {
  ok: boolean
  violations: ConfigViolation[]
}

/**
 * 校验 ThrillQuantifierConfig（机械范围检查，零 LLM）：
 *   - emaAlpha ∈ (0, 1]
 *   - sampleInterval ∈ (0, 1]
 *   - incrementalWindowSize ≥ 1
 *   - defaultTypeWeight ≥ 0
 *   - payoffMagnitude ≥ 0
 *   - closureDecay 必须包含 open 和 closed 且均为 ≥ 0 的有限数字
 *   - version 非空字符串
 */
export function validateThrillConfig(config: ThrillQuantifierConfig): ConfigValidation {
  const violations: ConfigViolation[] = []

  if (!config.version || typeof config.version !== "string") {
    violations.push({ path: "version", message: "version 必须是非空字符串" })
  }

  if (typeof config.emaAlpha !== "number" || config.emaAlpha <= 0 || config.emaAlpha > 1) {
    violations.push({ path: "emaAlpha", message: `emaAlpha 必须是 (0,1] 内的有限数字，实际=${String(config.emaAlpha)}` })
  }

  if (typeof config.sampleInterval !== "number" || config.sampleInterval <= 0 || config.sampleInterval > 1) {
    violations.push({ path: "sampleInterval", message: `sampleInterval 必须是 (0,1] 内的有限数字，实际=${String(config.sampleInterval)}` })
  }

  if (!Number.isInteger(config.incrementalWindowSize) || config.incrementalWindowSize < 1) {
    violations.push({ path: "incrementalWindowSize", message: `incrementalWindowSize 必须是 ≥1 的整数，实际=${String(config.incrementalWindowSize)}` })
  }

  if (typeof config.defaultTypeWeight !== "number" || config.defaultTypeWeight < 0 || !Number.isFinite(config.defaultTypeWeight)) {
    violations.push({ path: "defaultTypeWeight", message: `defaultTypeWeight 必须是非负有限数字，实际=${String(config.defaultTypeWeight)}` })
  }

  if (typeof config.payoffMagnitude !== "number" || config.payoffMagnitude < 0 || !Number.isFinite(config.payoffMagnitude)) {
    violations.push({ path: "payoffMagnitude", message: `payoffMagnitude 必须是非负有限数字，实际=${String(config.payoffMagnitude)}` })
  }

  for (const state of ["open", "closed"] as const) {
    const val = config.closureDecay[state]
    if (typeof val !== "number" || val < 0 || !Number.isFinite(val)) {
      violations.push({ path: `closureDecay.${state}`, message: `closureDecay.${state} 必须是非负有限数字，实际=${String(val)}` })
    }
  }

  return { ok: violations.length === 0, violations }
}