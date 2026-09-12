/**
 * rerank-rubric.ts — F-003 前置门禁的 **rubric 定义**（TASK-009）。
 *
 * ## 边界（这份文件刻意不做的事）
 * - **不含采样逻辑**：不生成候选、不调用模型、不跑 N 路择优。
 * - **不含评分器**（INV-4）：本文件只声明「用哪些既有判据、权重怎么来、rubric 怎么钉版本」。
 *   真正的打分仍是 `dimension-review-adapter.ts` 的 `runSixDimensionReview` +
 *   `review-scoring.ts` 的 `scoreReviewResults`——没有任何第二套评分实现。
 * - **不发明判据**：六维判据集合来自 `SIX_REVIEW_DIMENSION_ORDER`，反 AI 味判据来自
 *   `quickAntiAiAnalysis`，分数归一来自 `normalizeDimensionScore`。三者都以**函数引用**
 *   的形式挂在 [`RERANK_REUSED_SOURCES`] 上：上游改名会让这里编译失败，而不是静默分叉。
 *
 * ## 为什么权重不能继承 `CALIBRATED_DIMENSION_WEIGHTS`
 * `review-scoring.ts:75` 的标定权重键是 `{plot, character, world, pacing, facts, compliance}`，
 * 而六维评审经 `dimension-review-adapter.ts:71` 的 `DIM_TO_GATE_TYPE` 落到的门类型是
 * `{plot, consistency, character_consistency, timeline}`。两套分类只共享 `plot`，**不存在
 * 机械可算的对应关系**——硬凑一张对照表就是发明权重。
 *
 * 因此权重来源改为项目**既有不变量的优先级**（`Consistency(P0) > Anti-AI(P1) > Quality(P2)`）：
 * 类间按固定比例，类内均分。类内均分这个数（以及下面两个成本门阈值）是本任务的**提案**，
 * 已在决策日志登记为待人工批准项；`rubric_hash` 覆盖权重表，所以任何批准后的改动都会
 * 产生新的 hash，旧结论自动失效。
 */

import {
  DIM_TO_GATE_TYPE,
  SIX_REVIEW_DIMENSION_ORDER,
  normalizeDimensionScore,
  runSixDimensionReview,
  type SixReviewDimensionKey,
} from "./dimension-review-adapter"
import { quickAntiAiAnalysis } from "./anti-ai-candidate-pool"
import {
  DEFAULT_TOKEN_HARD_CAP_TOKENS,
  DEFAULT_TOKEN_SOFT_WARN_TOKENS,
  WALLCLOCK_BUDGET_PER_CHAPTER_MS,
  type TokenBudgetConfig,
} from "./budget-counters"
import { fingerprintText } from "./book-analysis/content-fingerprint"

/** rubric 版本（任何判据 / 权重 / 归一方式变动都必须升版）。 */
export const RERANK_RUBRIC_VERSION = "rerank-rubric/1"

/** 归一方式标识（钉进 hash，防止换归一函数而 hash 不变）。 */
export const RERANK_SCORE_NORMALIZER_ID = "normalizeDimensionScore@0..10/1dp"

/**
 * 被复用的既有判据来源（**实函数引用**，不是字符串名）。
 *
 * 这既是复用声明，也是编译期护栏：上游改了导出名，本文件编译失败。
 */
export const RERANK_REUSED_SOURCES = {
  /** 六维评审执行器（唯一 scorer 入口）。 */
  reviewRunner: runSixDimensionReview,
  /** 维度分数归一（唯一归一入口）。 */
  scoreNormalizer: normalizeDimensionScore,
  /** 反 AI 味分析（指纹判据来源）。 */
  antiAiAnalyzer: quickAntiAiAnalysis,
} as const

/** 权重优先级类（与门控不变量的 P0/P1/P2 同源）。 */
export type RerankWeightClass = "P0" | "P1" | "P2"

/** 类间权重：类内均分。P0 独占过半，保证 Consistency 永不被文学分掩盖。 */
export const RERANK_CLASS_WEIGHTS: Record<RerankWeightClass, number> = {
  P0: 0.5,
  P1: 0.3,
  P2: 0.2,
}

/**
 * 六维 → 权重类。
 *
 * `consistency`（设定自治）与 `continuity`（时间线/前后一致）都属一致性类：
 * `DIM_TO_GATE_TYPE` 给出 `consistency → consistency`、`continuity → timeline`，
 * 二者都是「真值一致性」担忧，正是 P0 门控的语义。
 * 其余四维（爽感 / 节奏 / 角色 / 追读）是文学质量，属 P2。
 */
export const RERANK_DIMENSION_CLASS: Record<SixReviewDimensionKey, RerankWeightClass> = {
  consistency: "P0",
  continuity: "P0",
  thrill: "P2",
  pacing: "P2",
  character: "P2",
  pull: "P2",
}

/** 反 AI 味指纹判据的 id（P1 类，独立于六维）。 */
export const RERANK_ANTI_AI_CRITERION_ID = "anti_ai_fingerprint"

/** 一个 rerank 判据：只有既有判据才允许出现在这里。 */
export interface RerankCriterion {
  /** 判据 id（进 hash）。 */
  id: string
  /** 权重类。 */
  weightClass: RerankWeightClass
  /** 权重（类内均分后的结果）。 */
  weight: number
  /** 判据来源（既有实现的白名单键）。 */
  source: "reviewRunner" | "scoreNormalizer" | "antiAiAnalyzer"
  /** 该判据落在哪个门类型（六维判据有；反 AI 味判据没有，留 `null`）。 */
  gateType: string | null
}

function classMembers(weightClass: RerankWeightClass): number {
  const dimensionCount = Object.values(RERANK_DIMENSION_CLASS).filter(
    (value) => value === weightClass,
  ).length
  // 反 AI 味判据独占 P1；P0/P2 只有六维成员。
  return weightClass === "P1" ? 1 : dimensionCount
}

/** 类内均分权重（`类权重 / 类成员数`）。 */
export function classUnitWeight(weightClass: RerankWeightClass): number {
  return RERANK_CLASS_WEIGHTS[weightClass] / classMembers(weightClass)
}

/** 六维判据权重（顺序与 `SIX_REVIEW_DIMENSION_ORDER` 一致）。 */
export const RERANK_DIMENSION_WEIGHTS: Record<SixReviewDimensionKey, number> =
  Object.fromEntries(
    SIX_REVIEW_DIMENSION_ORDER.map((key) => [key, classUnitWeight(RERANK_DIMENSION_CLASS[key])]),
  ) as Record<SixReviewDimensionKey, number>

/** 完整判据集合（六维 + 反 AI 味指纹）。 */
export const RERANK_RUBRIC_CRITERIA: readonly RerankCriterion[] = [
  ...SIX_REVIEW_DIMENSION_ORDER.map((key) => ({
    id: key,
    weightClass: RERANK_DIMENSION_CLASS[key],
    weight: RERANK_DIMENSION_WEIGHTS[key],
    source: "reviewRunner" as const,
    gateType: DIM_TO_GATE_TYPE[key],
  })),
  {
    id: RERANK_ANTI_AI_CRITERION_ID,
    weightClass: "P1" as const,
    weight: classUnitWeight("P1"),
    source: "antiAiAnalyzer" as const,
    gateType: null,
  },
]

/** 归一入口（转发到既有 `normalizeDimensionScore`，不另起一套）。 */
export function normalizeRerankScore(value: unknown): number {
  return RERANK_REUSED_SOURCES.scoreNormalizer(value)
}

/**
 * `rubric_hash`：对「版本 + 归一方式 + 判据集合（id/类/权重/门类型）」取 FNV-1a 64。
 *
 * 复用书稿指纹的 FNV-1a（浏览器可用、纯函数、无 Node 依赖）。它是**版本钉定指纹**，
 * 不是密码学摘要——用途是让「换了权重却沿用旧结论」这件事在机械层面不可能发生。
 */
export function computeRubricHash(
  criteria: readonly RerankCriterion[] = RERANK_RUBRIC_CRITERIA,
  version: string = RERANK_RUBRIC_VERSION,
): string {
  const payload = [
    version,
    RERANK_SCORE_NORMALIZER_ID,
    ...criteria
      .map(
        (criterion) =>
          `${criterion.id}:${criterion.weightClass}:${criterion.weight.toFixed(6)}:${criterion.source}:${criterion.gateType ?? "-"}`,
      )
      .sort(),
  ].join("|")
  return fingerprintText(payload)
}

/** 当前 rubric 的 hash（写入报告与决策日志，供「结论是否过期」机械比对）。 */
export const RERANK_RUBRIC_HASH = computeRubricHash()

/** 不变量自检：返回违反项（空数组即通过）。 */
export function assertRerankRubricInvariants(): string[] {
  const violations: string[] = []
  if (RERANK_RUBRIC_VERSION.trim().length === 0) violations.push("rubric version must not be empty")

  const total = RERANK_RUBRIC_CRITERIA.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (Math.abs(total - 1) > 1e-9) {
    violations.push(`criterion weights must sum to 1, got ${total}`)
  }
  for (const criterion of RERANK_RUBRIC_CRITERIA) {
    if (criterion.weight <= 0) violations.push(`criterion ${criterion.id} must carry a positive weight`)
    if (!(criterion.source in RERANK_REUSED_SOURCES)) {
      violations.push(`criterion ${criterion.id} has no reused source`)
    }
  }
  // 六维必须与既有维度顺序一一对应（少一维或多一维都必须暴露）。
  const dimensionIds = RERANK_RUBRIC_CRITERIA.filter((c) => c.source === "reviewRunner").map(
    (c) => c.id,
  )
  if (dimensionIds.join(",") !== SIX_REVIEW_DIMENSION_ORDER.join(",")) {
    violations.push("review-runner criteria must mirror SIX_REVIEW_DIMENSION_ORDER exactly")
  }
  // P0 类权重必须独占过半：Consistency 不得被文学分覆盖。
  const p0 = RERANK_RUBRIC_CRITERIA.filter((c) => c.weightClass === "P0").reduce(
    (sum, c) => sum + c.weight,
    0,
  )
  if (p0 < 0.5) violations.push(`P0 class weight must be at least 0.5, got ${p0}`)
  return violations
}

// ── F-003 成本门禁（C-014）────────────────────────────────────────────────

/** 最少采样章数（卡片要求「采样 ≥5 章」）。 */
export const F003_MIN_CHAPTER_SAMPLES = 5

/**
 * 可接受的 N=3 / N=1 成本倍数上限（**提案值，待人工批准**）。
 *
 * 取 2.5 而不是 3.0：三路生成共享同一前缀，若前缀缓存完全生效，prompt 侧增量应显著
 * 低于线性；2.5 表示「允许 prompt 侧几乎不省，但完成侧不得额外膨胀」。
 */
export const F003_MAX_COST_MULTIPLE = 2.5

/**
 * 前缀缓存复用率下限（**提案值，待人工批准**）。
 *
 * 复用率 = `cache_read_tokens / prompt_tokens`。低于 0.5 时，三路分摊的共享前缀不足一半，
 * 说明前缀在实际上没有共享（缓存未命中或前缀不稳定），此时 N=3 的成本近似线性增长，
 * 墙钟预算会成为更紧的约束。
 */
export const F003_MIN_PREFIX_CACHE_REUSE = 0.5

/** 单臂实测（N=1 或 N=3 的聚合）。 */
export interface F003ArmMeasurement {
  /** 输入 token（含被缓存命中的部分）。 */
  prompt_tokens: number
  /** 输出 token。 */
  completion_tokens: number
  /** 其中由前缀缓存命中而免计费的输入 token（provider 口径）。 */
  cache_read_tokens: number
  /** 墙钟时延（ms）。 */
  latency_ms: number
}

/** 门禁输入。 */
export interface F003CostGateInput {
  /** 实际采样的章数（少于 [`F003_MIN_CHAPTER_SAMPLES`] 即不足）。 */
  chaptersSampled: number
  /** N=1 单路基线。 */
  singleArm: F003ArmMeasurement
  /** N=3 三路聚合。 */
  threeArm: F003ArmMeasurement
  /** 预算覆盖（默认取 `budget-counters` 的既有值）。 */
  tokenBudget?: TokenBudgetConfig
  wallclockBudgetMs?: number
  maxCostMultiple?: number
  minPrefixCacheReuse?: number
}

/** 门禁判定。`blocked` 表示 F-003 **不得**进入实施波次。 */
export interface F003GateVerdict {
  decision: "pass" | "blocked"
  /** 成本倍数（N=3 总 token / N=1 总 token）。 */
  costMultiple: number
  /** 前缀缓存复用率（N=3 的 `cache_read_tokens / prompt_tokens`）。 */
  prefixCacheReuse: number
  /** 被使用的阈值（便于复核）。 */
  thresholds: {
    chapters: number
    hardCapTokens: number
    softWarnTokens: number
    wallclockBudgetMs: number
    maxCostMultiple: number
    minPrefixCacheReuse: number
  }
  /** 未通过的理由（空数组即通过）。 */
  reasons: string[]
  /** 是否处于「无实测」状态（采样为 0）。 */
  unmeasured: boolean
}

function totalTokens(arm: F003ArmMeasurement): number {
  return arm.prompt_tokens + arm.completion_tokens
}

/**
 * 机械门禁判定（C-014）。
 *
 * 「无实测 → blocked」是刻意的默认：门禁的存在意义就是不允许在缺数据时凭判断放行。
 */
export function evaluateF003CostGate(input: F003CostGateInput): F003GateVerdict {
  const thresholds = {
    chapters: F003_MIN_CHAPTER_SAMPLES,
    hardCapTokens: input.tokenBudget?.hardCapTokens ?? DEFAULT_TOKEN_HARD_CAP_TOKENS,
    softWarnTokens: input.tokenBudget?.softWarnTokens ?? DEFAULT_TOKEN_SOFT_WARN_TOKENS,
    wallclockBudgetMs: input.wallclockBudgetMs ?? WALLCLOCK_BUDGET_PER_CHAPTER_MS,
    maxCostMultiple: input.maxCostMultiple ?? F003_MAX_COST_MULTIPLE,
    minPrefixCacheReuse: input.minPrefixCacheReuse ?? F003_MIN_PREFIX_CACHE_REUSE,
  }

  const baseline = totalTokens(input.singleArm)
  const threeWay = totalTokens(input.threeArm)
  const costMultiple = baseline > 0 ? threeWay / baseline : Number.POSITIVE_INFINITY
  const prefixCacheReuse =
    input.threeArm.prompt_tokens > 0
      ? input.threeArm.cache_read_tokens / input.threeArm.prompt_tokens
      : 0

  const reasons: string[] = []
  if (input.chaptersSampled < thresholds.chapters) {
    reasons.push(
      `insufficient samples: ${input.chaptersSampled} chapter(s) measured, need >= ${thresholds.chapters}`,
    )
  }
  if (!Number.isFinite(costMultiple)) {
    reasons.push("cannot compute a cost multiple: the N=1 baseline carries no tokens")
  } else if (costMultiple > thresholds.maxCostMultiple) {
    reasons.push(
      `cost multiple ${costMultiple.toFixed(3)}x exceeds the affordable ceiling ${thresholds.maxCostMultiple}x`,
    )
  }
  if (threeWay > thresholds.hardCapTokens) {
    reasons.push(
      `N=3 total ${threeWay} tokens exceeds the hard cap ${thresholds.hardCapTokens}`,
    )
  } else if (threeWay > thresholds.softWarnTokens) {
    reasons.push(
      `N=3 total ${threeWay} tokens crosses the soft warning line ${thresholds.softWarnTokens}`,
    )
  }
  if (input.threeArm.latency_ms > thresholds.wallclockBudgetMs) {
    reasons.push(
      `N=3 wallclock ${input.threeArm.latency_ms}ms exceeds the per-chapter budget ${thresholds.wallclockBudgetMs}ms`,
    )
  }
  if (prefixCacheReuse < thresholds.minPrefixCacheReuse) {
    reasons.push(
      `prefix cache reuse ${prefixCacheReuse.toFixed(3)} is below the floor ${thresholds.minPrefixCacheReuse}`,
    )
  }

  return {
    decision: reasons.length === 0 ? "pass" : "blocked",
    costMultiple,
    prefixCacheReuse,
    thresholds,
    reasons,
    unmeasured: input.chaptersSampled === 0,
  }
}

/** 可读摘要（写入报告）。 */
export function formatF003GateVerdict(verdict: F003GateVerdict): string {
  const head = `F-003 cost gate: ${verdict.decision.toUpperCase()} (rubric ${RERANK_RUBRIC_HASH})`
  const metrics = `cost multiple ${Number.isFinite(verdict.costMultiple) ? verdict.costMultiple.toFixed(3) : "n/a"}x; prefix cache reuse ${verdict.prefixCacheReuse.toFixed(3)}`
  if (verdict.reasons.length === 0) return `${head}\n${metrics}`
  return `${head}\n${metrics}\n${verdict.reasons.map((reason) => `- ${reason}`).join("\n")}`
}
