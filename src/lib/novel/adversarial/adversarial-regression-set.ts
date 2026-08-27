/**
 * adversarial-regression-set.ts — v2.6.4 V-01/V-04: 对抗回归集框架（TS 纯函数）
 *
 * 蓝图 `docs/p0/blueprint-v264-20260826.md` V-01：
 *   对抗回归集 = 改写攻击样本集（PADBen 三层结构 × 难度分层），用于量测检测器
 *   在改写攻击下的召回衰减（攻击面覆盖审计范式——替代闭集满分口径）。
 *
 * 本模块为纯函数逻辑层（ADR-19 零 LLM / 零 IO）：
 *   - 样本 schema 校验（六字段）
 *   - 分层召回计算（类型 × 难度）
 *   - 诚实报告生成（data_status: "measured" | "stub"——stub 不产模拟分）
 *
 * 执行纪律:
 *   - 禁止模拟数据（假数据 = 假绿灯）；数据不足时 data_status="stub" 如实声明
 *   - Draft-first (ADR-08)：不写入运行时会话状态文件
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 改写攻击类型（PADBen 三层结构）。 */
export const ATTACK_TYPES = ["paraphrase", "homoglyph", "llm_rewrite"] as const
export type AttackType = (typeof ATTACK_TYPES)[number]

/** 难度分层（L1 轻改写 → L3 深度改写）。 */
export const DIFFICULTY_LEVELS = ["L1", "L2", "L3"] as const
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number]

/** 回归集样本（六字段 schema）。 */
export interface AdversarialSample {
  /** 样本唯一 id。 */
  id: string
  /** 原文（真源——gold 220 / 人工改写）。 */
  original: string
  /** 改写后文本。 */
  rewritten: string
  /** 改写类型。 */
  attackType: AttackType
  /** 难度分层。 */
  difficulty: DifficultyLevel
  /** 来源（PADBen / gold220 / 人工）。 */
  source: string
}

/** 分层召回结果。 */
export interface StratumRecall {
  attackType: AttackType
  difficulty: DifficultyLevel
  total: number
  recalled: number
  recall: number
}

/** 诚实报告（data_status 区分实测/stub）。 */
export interface AdversarialReport {
  dataStatus: "measured" | "stub"
  /** 样本总数。 */
  totalSamples: number
  /** 分层召回明细。 */
  strata: StratumRecall[]
  /** 宏平均召回（各层等权）。 */
  macroRecall: number
  /** 加权召回（按样本数）。 */
  weightedRecall: number
  /** stub 原因（data_status="stub" 时必填）。 */
  stubReason?: string
  /** 生成时间（epoch ms——仅报告元数据，不参与计算）。 */
  generatedAt: number
}

// ============================================================================
// 样本校验（纯函数）
// ============================================================================

/** 校验样本 schema（六字段）。返回错误清单。 */
export function validateSample(sample: AdversarialSample): string[] {
  const errors: string[] = []
  if (!sample.id || sample.id.length === 0) errors.push("id 不能为空")
  if (!sample.original || sample.original.trim().length === 0) errors.push("original 不能为空")
  if (!sample.rewritten || sample.rewritten.trim().length === 0) errors.push("rewritten 不能为空")
  if (!ATTACK_TYPES.includes(sample.attackType)) errors.push(`attackType 非法: ${sample.attackType}`)
  if (!DIFFICULTY_LEVELS.includes(sample.difficulty)) errors.push(`difficulty 非法: ${sample.difficulty}`)
  if (!sample.source || sample.source.trim().length === 0) errors.push("source 不能为空")
  return errors
}

// ============================================================================
// 分层召回计算（纯函数）
// ============================================================================

/**
 * 计算分层召回：按 (attackType × difficulty) 分组，每组 recall = recalled/total。
 * 检测器判定函数由调用方注入（本模块零 LLM——判定结果来自外部检测器）。
 */
export function computeStratifiedRecall(
  samples: AdversarialSample[],
  isDetected: (sample: AdversarialSample) => boolean,
): { strata: StratumRecall[]; macroRecall: number; weightedRecall: number } {
  const groups = new Map<string, { attackType: AttackType; difficulty: DifficultyLevel; total: number; recalled: number }>()
  for (const s of samples) {
    const key = `${s.attackType}:${s.difficulty}`
    const g = groups.get(key) ?? { attackType: s.attackType, difficulty: s.difficulty, total: 0, recalled: 0 }
    g.total += 1
    if (isDetected(s)) g.recalled += 1
    groups.set(key, g)
  }
  const strata: StratumRecall[] = [...groups.values()].map((g) => ({
    attackType: g.attackType,
    difficulty: g.difficulty,
    total: g.total,
    recalled: g.recalled,
    recall: g.total > 0 ? g.recalled / g.total : 0,
  }))
  const macroRecall = strata.length > 0 ? strata.reduce((a, s) => a + s.recall, 0) / strata.length : 0
  const total = samples.length
  const weightedRecall = total > 0 ? samples.filter((s) => isDetected(s)).length / total : 0
  return { strata, macroRecall, weightedRecall }
}

// ============================================================================
// 诚实报告生成（纯函数）
// ============================================================================

/**
 * 生成诚实报告：
 *   - 有实测判定 → data_status="measured"
 *   - 无判定数据（stub）→ data_status="stub" + stubReason——**不产模拟分**
 */
export function buildAdversarialReport(
  samples: AdversarialSample[],
  isDetected: ((sample: AdversarialSample) => boolean) | null,
  stubReason?: string,
): AdversarialReport {
  if (isDetected === null) {
    return {
      dataStatus: "stub",
      totalSamples: samples.length,
      strata: [],
      macroRecall: 0,
      weightedRecall: 0,
      stubReason: stubReason ?? "无检测器判定数据（待运营期回填）",
      generatedAt: Date.now(),
    }
  }
  const { strata, macroRecall, weightedRecall } = computeStratifiedRecall(samples, isDetected)
  return {
    dataStatus: "measured",
    totalSamples: samples.length,
    strata,
    macroRecall,
    weightedRecall,
    generatedAt: Date.now(),
  }
}
