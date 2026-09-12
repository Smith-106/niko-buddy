/**
 * rerank-rubric.spec.ts — F-003 rubric 定义与成本门禁的契约测试（TASK-009）。
 *
 * 这组用例的核心是两个**机械护栏**：
 *   1. 复用即编译期绑定：rubric 必须指向既有的 `runSixDimensionReview` /
 *      `normalizeDimensionScore` / `quickAntiAiAnalysis` 函数实体，不允许出现第二套实现（INV-4）。
 *   2. 结论不可静默过期：权重/判据/归一方式任一变动都会换掉 `rubric_hash`。
 */

import { describe, expect, it } from "vitest"

import {
  DIM_TO_GATE_TYPE,
  SIX_REVIEW_DIMENSION_ORDER,
  normalizeDimensionScore,
  runSixDimensionReview,
} from "./dimension-review-adapter"
import * as antiAi from "./anti-ai-candidate-pool"
import { CALIBRATED_DIMENSION_WEIGHTS } from "./review-scoring"
import {
  DEFAULT_TOKEN_HARD_CAP_TOKENS,
  DEFAULT_TOKEN_SOFT_WARN_TOKENS,
  WALLCLOCK_BUDGET_PER_CHAPTER_MS,
} from "./budget-counters"
import * as rubric from "./rerank-rubric"
import {
  F003_MAX_COST_MULTIPLE,
  F003_MIN_CHAPTER_SAMPLES,
  F003_MIN_PREFIX_CACHE_REUSE,
  RERANK_ANTI_AI_CRITERION_ID,
  RERANK_CLASS_WEIGHTS,
  RERANK_DIMENSION_WEIGHTS,
  RERANK_REUSED_SOURCES,
  RERANK_RUBRIC_CRITERIA,
  RERANK_RUBRIC_HASH,
  RERANK_RUBRIC_VERSION,
  assertRerankRubricInvariants,
  computeRubricHash,
  evaluateF003CostGate,
  formatF003GateVerdict,
  normalizeRerankScore,
  type F003ArmMeasurement,
} from "./rerank-rubric"

const arm = (overrides: Partial<F003ArmMeasurement> = {}): F003ArmMeasurement => ({
  prompt_tokens: 40_000,
  completion_tokens: 6_000,
  cache_read_tokens: 28_000,
  latency_ms: 120_000,
  ...overrides,
})

describe("rubric composition", () => {
  it("satisfies its own invariants", () => {
    expect(assertRerankRubricInvariants()).toEqual([])
  })

  it("mirrors the six existing review dimensions in order, plus the anti-AI criterion", () => {
    const dimensionIds = RERANK_RUBRIC_CRITERIA.filter((c) => c.source === "reviewRunner").map(
      (c) => c.id,
    )
    expect(dimensionIds).toEqual(SIX_REVIEW_DIMENSION_ORDER)
    expect(RERANK_RUBRIC_CRITERIA).toHaveLength(SIX_REVIEW_DIMENSION_ORDER.length + 1)
    expect(RERANK_RUBRIC_CRITERIA[RERANK_RUBRIC_CRITERIA.length - 1]?.id).toBe(
      RERANK_ANTI_AI_CRITERION_ID,
    )
  })

  it("assigns every criterion a gate type from the existing mapping", () => {
    for (const criterion of RERANK_RUBRIC_CRITERIA) {
      if (criterion.source !== "reviewRunner") continue
      expect(criterion.gateType).toBe(DIM_TO_GATE_TYPE[criterion.id as never])
    }
  })

  it("keeps the priority invariant: P0 half, P1 anti-AI, P2 literary quality", () => {
    expect(RERANK_CLASS_WEIGHTS).toEqual({ P0: 0.5, P1: 0.3, P2: 0.2 })
    const total = RERANK_RUBRIC_CRITERIA.reduce((sum, c) => sum + c.weight, 0)
    expect(total).toBeCloseTo(1, 12)
    const p0 = RERANK_RUBRIC_CRITERIA.filter((c) => c.weightClass === "P0")
    expect(p0.map((c) => c.id).sort()).toEqual(["consistency", "continuity"])
    expect(p0.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(0.5, 12)
    expect(RERANK_DIMENSION_WEIGHTS.consistency).toBeCloseTo(0.25, 12)
    expect(RERANK_DIMENSION_WEIGHTS.continuity).toBeCloseTo(0.25, 12)
    for (const id of ["thrill", "pacing", "character", "pull"] as const) {
      expect(RERANK_DIMENSION_WEIGHTS[id]).toBeCloseTo(0.05, 12)
    }
    const antiAi = RERANK_RUBRIC_CRITERIA.find((c) => c.id === RERANK_ANTI_AI_CRITERION_ID)
    expect(antiAi?.weightClass).toBe("P1")
    expect(antiAi?.weight).toBeCloseTo(0.3, 12)
  })
})

describe("INV-4: criteria are reused, never re-implemented", () => {
  it("binds the rubric to the existing judge functions by identity", () => {
    expect(RERANK_REUSED_SOURCES.reviewRunner).toBe(runSixDimensionReview)
    expect(RERANK_REUSED_SOURCES.scoreNormalizer).toBe(normalizeDimensionScore)
    expect(RERANK_REUSED_SOURCES.antiAiAnalyzer).toBe(antiAi.quickAntiAiAnalysis)
  })

  it("delegates score normalization instead of defining its own", () => {
    for (const value of [0, 5.5, 9.87, 11.2, -3, Number.NaN, "7.3", 105]) {
      expect(normalizeRerankScore(value)).toBe(normalizeDimensionScore(value))
    }
  })

  it("exports no candidate scorer or sampler", () => {
    const exported = Object.keys(rubric)
    expect(exported.filter((name) => /^(score|rank|rerank|sample|generate)Candidates/.test(name))).toEqual(
      [],
    )
    expect(exported.filter((name) => /^(sample|generate)\w*Candidates$/.test(name))).toEqual([])
  })

  it("records that the calibrated gate-type weights cannot be inherited mechanically", () => {
    // 两套分类只共享 plot：硬凑对照表就是发明权重（INV-4）。若将来上游补齐缺口，
    // 本断言会失败，强制 rubric 改用标定权重，而不是继续用本任务的类内均分提案。
    const gateTypes = new Set(Object.values(DIM_TO_GATE_TYPE))
    const missing = [...gateTypes].filter((type) => !(type in CALIBRATED_DIMENSION_WEIGHTS)).sort()
    expect(missing).toEqual(["character_consistency", "consistency", "timeline"])
    expect(Object.keys(CALIBRATED_DIMENSION_WEIGHTS).sort()).toEqual([
      "character",
      "compliance",
      "facts",
      "pacing",
      "plot",
      "world",
    ])
  })
})

describe("rubric_hash", () => {
  it("is a stable 16-hex FNV-1a fingerprint of the current rubric", () => {
    expect(RERANK_RUBRIC_HASH).toMatch(/^[0-9a-f]{16}$/)
    expect(RERANK_RUBRIC_HASH).toBe(computeRubricHash())
    expect(RERANK_RUBRIC_HASH).toBe(computeRubricHash(RERANK_RUBRIC_CRITERIA))
    expect(RERANK_RUBRIC_VERSION).toBe("rerank-rubric/1")
  })

  it("changes when the rubric version changes", () => {
    expect(computeRubricHash(RERANK_RUBRIC_CRITERIA, "rerank-rubric/2")).not.toBe(
      RERANK_RUBRIC_HASH,
    )
  })

  it("changes when any weight, class, gate type or source changes", () => {
    const baseline = computeRubricHash()
    const mutated = [
      RERANK_RUBRIC_CRITERIA.map((c) =>
        c.id === "thrill" ? { ...c, weight: c.weight + 0.01 } : c,
      ),
      RERANK_RUBRIC_CRITERIA.map((c) =>
        c.id === "thrill" ? { ...c, weightClass: "P0" as const } : c,
      ),
      RERANK_RUBRIC_CRITERIA.map((c) =>
        c.id === "pull" ? { ...c, gateType: "quality" } : c,
      ),
      RERANK_RUBRIC_CRITERIA.map((c) =>
        c.id === RERANK_ANTI_AI_CRITERION_ID ? { ...c, source: "reviewRunner" as const } : c,
      ),
    ]
    for (const criteria of mutated) {
      expect(computeRubricHash(criteria)).not.toBe(baseline)
    }
  })

  it("is order-insensitive (canonical ordering)", () => {
    const reversed = [...RERANK_RUBRIC_CRITERIA].reverse()
    expect(computeRubricHash(reversed)).toBe(computeRubricHash())
  })
})

describe("F-003 cost gate (C-014)", () => {
  const chapterSample = (count: number) => ({
    chaptersSampled: count,
    singleArm: arm({ prompt_tokens: 40_000, completion_tokens: 6_000, cache_read_tokens: 0, latency_ms: 60_000 }),
    threeArm: arm({
      prompt_tokens: 52_000,
      completion_tokens: 18_000,
      cache_read_tokens: 28_000,
      latency_ms: 150_000,
    }),
  })

  it("blocks when nothing was measured", () => {
    const verdict = evaluateF003CostGate({
      chaptersSampled: 0,
      singleArm: arm({ prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, latency_ms: 0 }),
      threeArm: arm({ prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, latency_ms: 0 }),
    })
    expect(verdict.decision).toBe("blocked")
    expect(verdict.unmeasured).toBe(true)
    expect(verdict.reasons.join("|")).toContain("insufficient samples")
    expect(formatF003GateVerdict(verdict)).toContain("BLOCKED")
    expect(formatF003GateVerdict(verdict)).toContain(RERANK_RUBRIC_HASH)
  })

  it("blocks below the five-chapter sampling floor", () => {
    const verdict = evaluateF003CostGate(chapterSample(F003_MIN_CHAPTER_SAMPLES - 1))
    expect(verdict.decision).toBe("blocked")
    expect(verdict.unmeasured).toBe(false)
    expect(verdict.reasons.some((r) => r.includes("insufficient samples"))).toBe(true)
  })

  it("passes a measured run inside every budget", () => {
    const verdict = evaluateF003CostGate(chapterSample(F003_MIN_CHAPTER_SAMPLES))
    expect(verdict.reasons).toEqual([])
    expect(verdict.decision).toBe("pass")
    // 70_000 / 46_000 ≈ 1.52x，低于 2.5x 上限；复用率 28_000/52_000 ≈ 0.538，高于 0.5 下限。
    expect(verdict.costMultiple).toBeCloseTo(70_000 / 46_000, 12)
    expect(verdict.prefixCacheReuse).toBeCloseTo(28_000 / 52_000, 12)
    expect(verdict.thresholds.hardCapTokens).toBe(DEFAULT_TOKEN_HARD_CAP_TOKENS)
    expect(verdict.thresholds.softWarnTokens).toBe(DEFAULT_TOKEN_SOFT_WARN_TOKENS)
    expect(verdict.thresholds.wallclockBudgetMs).toBe(WALLCLOCK_BUDGET_PER_CHAPTER_MS)
  })

  it("blocks on a cost multiple beyond the affordable ceiling", () => {
    const input = chapterSample(F003_MIN_CHAPTER_SAMPLES)
    const verdict = evaluateF003CostGate({
      ...input,
      threeArm: arm({ prompt_tokens: 110_000, completion_tokens: 20_000, cache_read_tokens: 40_000, latency_ms: 150_000 }),
    })
    expect(verdict.costMultiple).toBeGreaterThan(F003_MAX_COST_MULTIPLE)
    expect(verdict.decision).toBe("blocked")
    expect(verdict.reasons.some((r) => r.includes("exceeds the affordable ceiling"))).toBe(true)
  })

  it("blocks when the shared prefix is not actually being reused", () => {
    const input = chapterSample(F003_MIN_CHAPTER_SAMPLES)
    const verdict = evaluateF003CostGate({
      ...input,
      threeArm: arm({ prompt_tokens: 110_000, completion_tokens: 18_000, cache_read_tokens: 0, latency_ms: 150_000 }),
    })
    expect(verdict.prefixCacheReuse).toBeLessThan(F003_MIN_PREFIX_CACHE_REUSE)
    expect(verdict.decision).toBe("blocked")
    expect(verdict.reasons.some((r) => r.includes("prefix cache reuse"))).toBe(true)
  })

  it("blocks on the hard cap, the soft warning line and the wallclock budget", () => {
    const input = chapterSample(F003_MIN_CHAPTER_SAMPLES)
    const overCap = evaluateF003CostGate({
      ...input,
      threeArm: arm({
        prompt_tokens: 300_000,
        completion_tokens: 20_000,
        cache_read_tokens: 250_000,
        latency_ms: 150_000,
      }),
    })
    expect(overCap.reasons.some((r) => r.includes("hard cap"))).toBe(true)

    const softWarn = evaluateF003CostGate({
      ...input,
      threeArm: arm({
        prompt_tokens: 140_000,
        completion_tokens: 20_000,
        cache_read_tokens: 120_000,
        latency_ms: 150_000,
      }),
    })
    expect(softWarn.reasons.some((r) => r.includes("soft warning line"))).toBe(true)

    const slow = evaluateF003CostGate({
      ...input,
      threeArm: arm({ latency_ms: WALLCLOCK_BUDGET_PER_CHAPTER_MS + 1 }),
    })
    expect(slow.reasons.some((r) => r.includes("wallclock"))).toBe(true)
  })

  it("blocks when the baseline carries no tokens (no computable multiple)", () => {
    const verdict = evaluateF003CostGate({
      chaptersSampled: F003_MIN_CHAPTER_SAMPLES,
      singleArm: arm({ prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, latency_ms: 0 }),
      threeArm: arm(),
    })
    expect(verdict.costMultiple).toBe(Number.POSITIVE_INFINITY)
    expect(verdict.decision).toBe("blocked")
    expect(verdict.reasons.some((r) => r.includes("no tokens"))).toBe(true)
  })

  it("honours caller-supplied thresholds (budget override path)", () => {
    const verdict = evaluateF003CostGate({
      ...chapterSample(F003_MIN_CHAPTER_SAMPLES),
      tokenBudget: { hardCapTokens: 1000, softWarnTokens: 500 },
      wallclockBudgetMs: 1000,
      maxCostMultiple: 100,
      minPrefixCacheReuse: 0,
    })
    expect(verdict.thresholds.hardCapTokens).toBe(1000)
    expect(verdict.thresholds.wallclockBudgetMs).toBe(1000)
    expect(verdict.reasons.some((r) => r.includes("hard cap 1000"))).toBe(true)
    expect(verdict.reasons.some((r) => r.includes("wallclock"))).toBe(true)
    expect(verdict.decision).toBe("blocked")
  })
})
