/**
 * TASK-007 (PERF-011 + CORR-013): context-budget pure-function tests.
 *
 * computeContextBudget is already exercised indirectly by
 * context-engine.spec.ts ("TASK-003 chapterNumber 自适应预算"). This file
 * adds the TASK-007-specific assertions:
 *   (a) adaptive scaling is live — chapter 500 gets smaller index/page
 *       budgets than chapter 5 (the chapterAdaptiveScale curve is not dead
 *       code now that the read path wires it).
 *   (b) CORR-013 MIN_INDEX_FLOOR — tiny maxContextSize (10K) still yields an
 *       indexBudget >= 2000 so the wiki index summary can list every page
 *       title even on small-context models.
 *   (c) additive / backward compatible — for normal configs (200K) the floor
 *       sits below the scaled value, so the budget is unchanged by the floor.
 */
import { describe, expect, it } from "vitest"
import { computeContextBudget, selectContextStrategy } from "./context-budget"

describe("TASK-007 PERF-011 adaptive scaling on the read path", () => {
  it("(a) chapter 500 returns smaller indexBudget + pageBudget than chapter 5", () => {
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    // chapterAdaptiveScale(5)=1.0, chapterAdaptiveScale(500)≈0.654 — later
    // chapters get strictly smaller index/page budgets (wiki is larger).
    expect(late.indexBudget).toBeLessThan(early.indexBudget)
    expect(late.pageBudget).toBeLessThan(early.pageBudget)
    // Both stay positive (no budget collapses to zero under scaling).
    expect(late.indexBudget).toBeGreaterThan(0)
    expect(late.pageBudget).toBeGreaterThan(0)
  })

  it("responseReserve is NOT scaled by chapterNumber (LLM answer room is constant)", () => {
    // Guards against accidentally scaling the response reserve too.
    const early = computeContextBudget(204_800, 5)
    const late = computeContextBudget(204_800, 500)
    expect(late.responseReserve).toBe(early.responseReserve)
  })
})

describe("TASK-007 CORR-013 MIN_INDEX_FLOOR", () => {
  it("(b) tiny maxContextSize (10K) yields indexBudget >= 2000", () => {
    // Without the floor: 10000 * 0.05 * 1.0 = 500 chars — too small to list
    // every page's title in the wiki index summary. The floor lifts it to
    // 2000 so the index still fits titles.
    const tiny = computeContextBudget(10_000)
    expect(tiny.maxCtx).toBe(10_000)
    expect(tiny.indexBudget).toBeGreaterThanOrEqual(2000)
  })

  it("MIN_INDEX_FLOOR applies AFTER scaling (tiny config + late chapter still >= floor)", () => {
    // chapter 500 on a 10K config: scaled index would be 10000 * 0.05 * 0.654
    // ≈ 327 — the floor must still lift it to 2000 so even a long-form novel
    // on a small-context model lists page titles.
    const tinyLate = computeContextBudget(10_000, 500)
    expect(tinyLate.indexBudget).toBeGreaterThanOrEqual(2000)
  })

  it("(c) normal config (200K) is unaffected by the floor — additive / backward compatible", () => {
    // For a normal 200K config, the scaled indexBudget is 200000 * 0.05 * 1.0
    // = 10000 — well above the 2000 floor, so Math.max(floor, scaled) returns
    // the scaled value unchanged. This proves the floor is additive and does
    // not perturb existing behavior.
    const normal = computeContextBudget(204_800)
    const expectedScaled = Math.floor(204_800 * 0.05)
    expect(normal.indexBudget).toBe(expectedScaled)
    expect(normal.indexBudget).toBeGreaterThan(2000)
  })

  it("normal config + late chapter still above floor (floor invisible at scale)", () => {
    // 200K at chapter 500: scaled = 200000 * 0.05 * 0.654 ≈ 6540 — above floor.
    const normalLate = computeContextBudget(204_800, 500)
    expect(normalLate.indexBudget).toBeGreaterThan(2000)
  })
})

describe("TASK-004 active entities budget (compressible-with-floor)", () => {
  it("activeEntitiesBudget 字段含 rank0Floor/rank1CompressibleCap/rank2CompressibleCap 三子字段", () => {
    const b = computeContextBudget(204_800, 5)
    expect(b.activeEntitiesBudget).toBeDefined()
    expect(typeof b.activeEntitiesBudget.rank0Floor).toBe("number")
    expect(typeof b.activeEntitiesBudget.rank1CompressibleCap).toBe("number")
    expect(typeof b.activeEntitiesBudget.rank2CompressibleCap).toBe("number")
  })

  it("rank0 floor 全保: 任意 config (含 tiny) rank0Floor >= 8, 不受 scale 压缩", () => {
    const tiny = computeContextBudget(10_000)
    const tinyLate = computeContextBudget(10_000, 500)
    const normal = computeContextBudget(204_800, 5)
    const normalLate = computeContextBudget(204_800, 500)
    // rank0 floor 镜像 MIN_INDEX_FLOOR: 永不低于常数下限 (ACTIVE_ENTITY_FLOOR=8)
    expect(tiny.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    expect(tinyLate.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    expect(normal.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    expect(normalLate.activeEntitiesBudget.rank0Floor).toBeGreaterThanOrEqual(8)
    // 正常 config 的 rank0 floor 随 maxCtx 增大而增大 (scale 不降低 floor)
    expect(normal.activeEntitiesBudget.rank0Floor).toBeGreaterThan(tiny.activeEntitiesBudget.rank0Floor)
  })

  it("rank1/rank2 compressible cap 随 rank0 floor 计算 (正整数且 rank1 > rank2)", () => {
    const b = computeContextBudget(204_800, 5)
    expect(b.activeEntitiesBudget.rank1CompressibleCap).toBeGreaterThanOrEqual(2)
    expect(b.activeEntitiesBudget.rank2CompressibleCap).toBeGreaterThanOrEqual(1)
    expect(b.activeEntitiesBudget.rank1CompressibleCap).toBeGreaterThan(b.activeEntitiesBudget.rank2CompressibleCap)
  })

  it("canon baseline 不动: 既有 indexBudget/pageBudget 字段不受新字段影响", () => {
    const withField = computeContextBudget(204_800, 5)
    expect(withField.indexBudget).toBe(Math.floor(204_800 * 0.05))
    expect(withField.pageBudget).toBe(Math.floor(204_800 * 0.5))
  })
})

describe("F-008 ContextStrategy 三态策略枚举", () => {
  it("≤50 返回 full（默认 threshold）", () => {
    expect(selectContextStrategy(1)).toBe("full")
    expect(selectContextStrategy(25)).toBe("full")
    expect(selectContextStrategy(50)).toBe("full")
  })

  it("50-200 返回 sliding", () => {
    expect(selectContextStrategy(51)).toBe("sliding")
    expect(selectContextStrategy(100)).toBe("sliding")
    expect(selectContextStrategy(200)).toBe("sliding")
  })

  it(">200 返回 summary", () => {
    expect(selectContextStrategy(201)).toBe("summary")
    expect(selectContextStrategy(500)).toBe("summary")
    expect(selectContextStrategy(1000)).toBe("summary")
  })

  it("undefined/≤0 返回 full", () => {
    expect(selectContextStrategy(undefined)).toBe("full")
    expect(selectContextStrategy(0)).toBe("full")
    expect(selectContextStrategy(-1)).toBe("full")
  })

  it("自定义阈值覆盖", () => {
    expect(selectContextStrategy(30, { fullThreshold: 20, summaryThreshold: 100 })).toBe("sliding")
    expect(selectContextStrategy(30, { fullThreshold: 40 })).toBe("full")
    expect(selectContextStrategy(150, { summaryThreshold: 100 })).toBe("summary")
  })

  it("边界 50 与 200（默认阈值）", () => {
    // 边界 50: ≤50 为 full
    expect(selectContextStrategy(50)).toBe("full")
    expect(selectContextStrategy(51)).toBe("sliding")
    // 边界 200: ≤200 为 sliding
    expect(selectContextStrategy(200)).toBe("sliding")
    expect(selectContextStrategy(201)).toBe("summary")
  })

  it("computeContextBudget 返回 strategy 字段", () => {
    const full = computeContextBudget(204_800, 5)
    expect(full.strategy).toBe("full")
    const sliding = computeContextBudget(204_800, 100)
    expect(sliding.strategy).toBe("sliding")
    const summary = computeContextBudget(204_800, 500)
    expect(summary.strategy).toBe("summary")
  })

  it("strategy 不替换现有 budget 曲线（adaptiveScale 预算不变）", () => {
    // 保证 strategy 是 additive 上层选择器，不改变 budget 计算
    const ch5 = computeContextBudget(204_800, 5)
    const ch500 = computeContextBudget(204_800, 500)
    expect(ch500.indexBudget).toBeLessThan(ch5.indexBudget)
    expect(ch500.pageBudget).toBeLessThan(ch5.pageBudget)
    // strategy 反映不同态
    expect(ch5.strategy).toBe("full")
    expect(ch500.strategy).toBe("summary")
  })
})
