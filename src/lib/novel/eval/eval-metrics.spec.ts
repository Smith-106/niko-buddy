/**
 * eval-metrics.spec.ts — F1 G1 骨架：L1/L2/L3/aggregate 计算验证。
 */
import { describe, it, expect } from "vitest"
import { computeL1, computeL2, computeL3, aggregate, DEFAULT_THRESHOLDS } from "./eval-metrics"
import type { AssembledContextView } from "./eval-adapters"
import type { ContinuityFinding } from "../deterministic-continuity-engine"

function view(overrides: Partial<AssembledContextView> = {}): AssembledContextView {
  return {
    protectedCurrent: ["白砚 持有 轩辕剑", "苏未晞 位于 凌霄殿"],
    protectedFormer: ["墨渊 状态 重伤"],
    compressible: [],
    protectedLayerAssembled: true,
    ...overrides,
  }
}

describe("computeL1 (C5: protected-layer existence, not rank)", () => {
  it("hits when triple exists in protectedCurrent", () => {
    const r = computeL1(
      [{ id: "g", subject: "白砚", predicate: "持有", object: "轩辕剑", tier: "protected", expectedLayer: "protected" }],
      view(),
    )
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })

  it("misses when triple absent", () => {
    const r = computeL1(
      [{ id: "g", subject: "不存在", predicate: "持有", object: "轩辕剑", tier: "protected", expectedLayer: "protected" }],
      view(),
    )
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
  })

  it("fails fast when protected layer not assembled", () => {
    const r = computeL1([], view({ protectedLayerAssembled: false }))
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
  })

  it("empty goldChunks trivially passes", () => {
    const r = computeL1([], view())
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })
})

describe("computeL2 (poison must not land in protected)", () => {
  it("contradiction in protectedCurrent leaks", () => {
    const r = computeL2(
      [{ id: "p", subject: "白砚", predicate: "持有", object: "轩辕剑", poisonType: "contradiction", expectedLanding: "excluded" }],
      view(),
    )
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
  })

  it("former_as_current allowed in former layer, not protected", () => {
    const r = computeL2(
      [{ id: "p", subject: "墨渊", predicate: "状态", object: "重伤", poisonType: "former_as_current", expectedLanding: "former" }],
      view(),
    )
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })

  it("former_as_current leaking into protected fails", () => {
    const r = computeL2(
      [{ id: "p", subject: "白砚", predicate: "持有", object: "轩辕剑", poisonType: "former_as_current", expectedLanding: "former" }],
      view(),
    )
    expect(r.pass).toBe(false)
  })

  it("empty poisonChunks trivially passes", () => {
    const r = computeL2([], view())
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })
})

describe("computeL3 (C3: critical + consistency_mechanical only)", () => {
  function finding(overrides: Partial<ContinuityFinding> = {}): ContinuityFinding {
    return {
      type: "timeline_drift",
      subtype: "consistency_mechanical",
      severity: "critical",
      ref: "character:白砚",
      message: "drift",
      chapter: 1,
      ...overrides,
    } as ContinuityFinding
  }

  it("critical consistency_mechanical counts against L3", () => {
    const r = computeL3([finding()])
    expect(r.pass).toBe(false)
    expect(r.score).toBe(1)
  })

  it("warning severity does not count (C3)", () => {
    const r = computeL3([finding({ severity: "warning" })])
    expect(r.pass).toBe(true)
    expect(r.score).toBe(0)
  })

  it("data_gap subtype does not count (C3)", () => {
    const r = computeL3([finding({ subtype: "data_gap", missingField: "x" }) as ContinuityFinding])
    expect(r.pass).toBe(true)
    expect(r.score).toBe(0)
  })

  it("empty findings pass", () => {
    const r = computeL3([])
    expect(r.pass).toBe(true)
    expect(r.score).toBe(0)
  })
})

describe("aggregate (C1: L2>=0.99 > L1>=0.95 > L3<0.01)", () => {
  it("all pass → overall PASS", () => {
    const agg = aggregate(
      { layer: "L1", pass: true, score: 1, detail: {} },
      { layer: "L2", pass: true, score: 1, detail: {} },
      { layer: "L3", pass: true, score: 0, detail: {} },
    )
    expect(agg.overall).toBe(true)
    expect(agg.verdict).toBe("PASS")
  })

  it("L2 fail → overall FAIL regardless of L1/L3 (P0 gate priority)", () => {
    const agg = aggregate(
      { layer: "L1", pass: true, score: 1, detail: {} },
      { layer: "L2", pass: false, score: 0.5, detail: {} },
      { layer: "L3", pass: true, score: 0, detail: {} },
    )
    expect(agg.overall).toBe(false)
    expect(agg.verdict).toContain("L2")
  })

  it("thresholds are configurable", () => {
    const agg = aggregate(
      { layer: "L1", pass: true, score: 0.96, detail: {} },
      { layer: "L2", pass: true, score: 1, detail: {} },
      { layer: "L3", pass: true, score: 0, detail: {} },
      { l1Min: 0.9 },
    )
    expect(agg.overall).toBe(true)
    expect(DEFAULT_THRESHOLDS.l2Min).toBe(0.99)
  })
})
