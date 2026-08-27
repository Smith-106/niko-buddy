/**
 * bidirectional-likelihood.spec.ts — v2.6.4 V-02/V-03 验收
 *
 * 覆盖：LLR 数学正确性（手工 logits fixture）/ 对称聚合 / 降级语义 / 因子注册
 */
import { describe, expect, it } from "vitest"
import {
  DiagnosticFactorRegistry,
  computeLLR,
  evaluateBidirectionalLikelihood,
  symmetricAggregate,
  type BidirectionalModel,
} from "./bidirectional-likelihood"

/** 手工 logits fixture（确定性——数学正确性证据）。 */
const fixtureModel: BidirectionalModel = {
  forwardLogLikelihood: (t) => (t.length > 0 ? -2.5 : 0),
  backwardLogLikelihood: (t) => (t.length > 0 ? -4.0 : 0),
}

describe("V-02 双向似然 — LLR 数学正确性（手工 fixture）", () => {
  it("LLR = forward - backward（纯数学）", () => {
    expect(computeLLR(-2.5, -4.0)).toBeCloseTo(1.5, 10)
    expect(computeLLR(0, 0)).toBe(0)
    expect(computeLLR(-1, -3)).toBeCloseTo(2, 10)
  })

  it("对称聚合 = 两 LLR 均值", () => {
    expect(symmetricAggregate(1.5, 0.5)).toBeCloseTo(1.0, 10)
    expect(symmetricAggregate(-1, 1)).toBe(0)
  })

  it("有模型 → llr/symmetricScore 计算正确 + degraded=false", () => {
    const r = evaluateBidirectionalLikelihood({ textA: "原文", textB: "改写", model: fixtureModel })
    expect(r.modelAvailable).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.llr).toBeCloseTo(1.5, 10)
    expect(r.symmetricScore).toBeCloseTo(1.5, 10)
  })
})

describe("V-02 双向似然 — 降级语义", () => {
  it("无模型 → model_available=false / llr=null / degraded=true / fallback_reason", () => {
    const r = evaluateBidirectionalLikelihood({ textA: "a", textB: "b", model: null })
    expect(r.modelAvailable).toBe(false)
    expect(r.llr).toBeNull()
    expect(r.symmetricScore).toBeNull()
    expect(r.degraded).toBe(true)
    expect(r.fallbackReason).toContain("模型句柄未注入")
  })

  it("降级结果不崩、不静默通过（显式 degraded 位）", () => {
    const r = evaluateBidirectionalLikelihood({ textA: "a", textB: "b", model: null })
    expect(r.degraded).toBe(true)
    expect(r.llr).toBeNull() // 无模拟分
  })
})

describe("V-02 诊断因子注册 — 与 sentenceEntropy 同级扩展点", () => {
  it("注册/查询/枚举（字典序稳定）", () => {
    const reg = new DiagnosticFactorRegistry()
    expect(reg.register({ id: "bidirectionalLikelihood", weight: 1, compute: () => ({ factorId: "x", llr: 0, reliability: 1, degraded: false }), modelDependency: true })).toBe(true)
    expect(reg.register({ id: "sentenceEntropy", weight: 1, compute: () => ({ factorId: "y", llr: 0, reliability: 1, degraded: false }), modelDependency: false })).toBe(true)
    expect(reg.size).toBe(2)
    expect(reg.list().map((f) => f.id)).toEqual(["bidirectionalLikelihood", "sentenceEntropy"])
    expect(reg.get("sentenceEntropy")?.modelDependency).toBe(false)
  })

  it("重名注册拒绝", () => {
    const reg = new DiagnosticFactorRegistry()
    const d = { id: "dup", weight: 1, compute: () => ({ factorId: "d", llr: 0, reliability: 1, degraded: false }), modelDependency: false }
    expect(reg.register(d)).toBe(true)
    expect(reg.register(d)).toBe(false)
  })

  it("注销后不可查询", () => {
    const reg = new DiagnosticFactorRegistry()
    reg.register({ id: "tmp", weight: 1, compute: () => ({ factorId: "t", llr: 0, reliability: 1, degraded: false }), modelDependency: false })
    expect(reg.unregister("tmp")).toBe(true)
    expect(reg.get("tmp")).toBeUndefined()
  })
})
