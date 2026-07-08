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
import { computeContextBudget } from "./context-budget"

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
