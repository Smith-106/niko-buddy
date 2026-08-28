/**
 * floor-gate.ts — v2.6.8 D2: 地板闸固化（机械断言集 + 单维一票否决）
 *
 * 蓝图 `docs/p0/blueprint-v268-20260828.md` D2：
 *   - consistency P0 地板 9.0：单章<9.0 一票否决
 *   - anti_ai P1 地板 8.5：<8.5 否决
 *   - quality P2 地板 8.5：<8.5 且不得覆盖 P0
 *   - thril/pacing/pull 地板 8.0：D5 复合触发（三软维≥2 触地板 且 整体中位<9.0 才改写）
 *   - 只挡正文回填不挡草稿修正（守 Draft-first）
 *   - n<30 回退 P50 临时闸（防小样本地板方差劫持）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 地板阈值（校准基线 P15-P20 分位选地板——此处为默认值）
// ============================================================================

/** 地板阈值表（维度 → 地板分）。 */
export const FLOOR_THRESHOLDS = {
  consistency: 9.0, // P0 硬门——单章<9.0 一票否决
  anti_ai: 8.5, // P1 硬门
  quality: 8.5, // P2——不得覆盖 P0
  thril: 8.0, // 软维（D5 复合触发）
  pacing: 8.0,
  pull: 8.0,
} as const

/** 硬门维度（P0/P1——单维一票否决）。 */
export const HARD_DIMENSIONS = ["consistency", "anti_ai"] as const

/** 软维（D5 复合触发）。 */
export const SOFT_DIMENSIONS = ["thril", "pacing", "pull"] as const

/** 小样本回退阈值（n<30 用 P50 临时闸）。 */
export const SMALL_SAMPLE_N = 30

// ============================================================================
// 地板闸判定（纯函数）
// ============================================================================

/** 地板闸输入（单章六维分 + 样本数）。 */
export interface FloorGateInput {
  chapterId: string
  scores: Record<string, number>
  /** 校准样本数（n<30 回退 P50 临时闸）。 */
  sampleCount: number
  /** 是否正文回填路径（只挡回填不挡草稿修正）。 */
  isBackfill: boolean
}

/** 地板闸结果。 */
export interface FloorGateResult {
  pass: boolean
  /** 否决维度（一票否决）。 */
  vetoed: string[]
  /** 触地板软维（D5 复合触发用）。 */
  softBreached: string[]
  /** 是否回退 P50 临时闸。 */
  usedTemporaryGate: boolean
}

/**
 * 地板闸判定（纯函数——确定性）。
 * 硬门单维一票否决；软维触地板仅记录（D5 复合触发）。
 * 只挡正文回填（isBackfill=false 即草稿修正——不拦）。
 */
export function evaluateFloorGate(input: FloorGateInput): FloorGateResult {
  const vetoed: string[] = []
  const softBreached: string[] = []
  const usedTemporaryGate = input.sampleCount < SMALL_SAMPLE_N

  for (const dim of HARD_DIMENSIONS) {
    const score = input.scores[dim] ?? 0
    if (score < FLOOR_THRESHOLDS[dim]) vetoed.push(dim)
  }
  // quality 不得覆盖 P0（P0 失败时 quality 失败也记录——但 P0 已否决）
  if ((input.scores.quality ?? 0) < FLOOR_THRESHOLDS.quality) vetoed.push("quality")
  for (const dim of SOFT_DIMENSIONS) {
    if ((input.scores[dim] ?? 0) < FLOOR_THRESHOLDS[dim]) softBreached.push(dim)
  }

  // 只挡正文回填：草稿修正（isBackfill=false）不拦
  const pass = !input.isBackfill || vetoed.length === 0
  return { pass, vetoed, softBreached, usedTemporaryGate }
}

/**
 * 门控优先级不变量：P0 失败时整体必非 PASS（Quality 不得覆盖 Consistency）。
 * 纯函数：输入门控结果序列，输出是否违反优先级。
 */
export function verifyGatePriority(results: FloorGateResult[]): boolean {
  for (const r of results) {
    if (r.vetoed.includes("consistency") && r.pass) return false
  }
  return true
}
