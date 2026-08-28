/**
 * attribution-feedback.spec.ts — v2.6.10 D7 验收（观测）
 *
 * 覆盖：回写率 / 观测不挡
 */
import { describe, expect, it } from "vitest"
import { evaluateAttributionFeedback, writebackRate, type AttributionRecord } from "./attribution-feedback"

const rec: AttributionRecord = { reviewId: "r1", editorId: "e1", attributionType: "structure", summary: "结构归因" }

describe("D7 归因反哺 — 回写率（观测）", () => {
  it("全量回写：100%", () => {
    expect(writebackRate([rec], [rec])).toBe(1)
  })

  it("部分回写：50%", () => {
    const rec2: AttributionRecord = { ...rec, reviewId: "r2" }
    expect(writebackRate([rec, rec2], [rec])).toBe(0.5)
  })

  it("空应回写：100%（无缺口）", () => {
    expect(writebackRate([], [])).toBe(1)
  })

  it("观测通道标记（不挡结案）", () => {
    const r = evaluateAttributionFeedback([rec], [rec])
    expect(r.observationOnly).toBe(true)
  })
})
