/**
 * severity-gate.spec.ts — v2.6.5 D1 验收
 *
 * 覆盖：severity 枚举 / degraded×severity 降级封顶 / 维度清单状态机
 */
import { describe, expect, it } from "vitest"
import {
  DimensionManifest,
  evaluateSeverity,
  type DimensionEntry,
} from "./severity-gate"

describe("D1 severity — 枚举与降级封顶", () => {
  it("正常路径：severity 原样返回", () => {
    expect(evaluateSeverity("hard_block", "ok").severity).toBe("hard_block")
    expect(evaluateSeverity("suggestion", "ok").severity).toBe("suggestion")
  })

  it("降级封顶：degraded + hard_block → 钳制为 suggestion + cappedReason", () => {
    const v = evaluateSeverity("hard_block", "degraded")
    expect(v.severity).toBe("suggestion")
    expect(v.degraded).toBe("degraded")
    expect(v.cappedReason).toContain("降级封顶")
  })

  it("降级 + suggestion → 保持 suggestion（不抬高）", () => {
    const v = evaluateSeverity("suggestion", "degraded")
    expect(v.severity).toBe("suggestion")
    expect(v.cappedReason).toBeUndefined()
  })

  it("降级永不触发硬否决（封顶 ≤ 阈值-1 语义）", () => {
    // 穷举：degraded 状态下任何输入都不得产出 hard_block
    for (const raw of ["hard_block", "suggestion"] as const) {
      expect(evaluateSeverity(raw, "degraded").severity).not.toBe("hard_block")
    }
  })
})

describe("D1 维度清单 manifest — 状态机", () => {
  const makeInitial = (): DimensionEntry[] => [
    { id: "author_fingerprint", threshold: "Drift≤0.3", state: "pending" },
    { id: "judge_pool", threshold: "待定", state: "pending" },
    { id: "l9_gate", threshold: "六维中位≥9.0", state: "pending" },
    { id: "anti_ai", threshold: "P1 门", state: "pending" },
  ]

  it("合法迁移链：pending→comparing→passed→final", () => {
    const m = new DimensionManifest(makeInitial())
    m.transition("l9_gate", "comparing")
    m.transition("l9_gate", "passed")
    m.transition("l9_gate", "final")
    expect(m.get("l9_gate")?.state).toBe("final")
  })

  it("非法迁移 throw（passed→comparing 不允许）", () => {
    const m = new DimensionManifest(makeInitial())
    m.transition("anti_ai", "comparing")
    m.transition("anti_ai", "passed")
    expect(() => m.transition("anti_ai", "comparing")).toThrow(/非法迁移/)
  })

  it("未知维度 throw", () => {
    const m = new DimensionManifest(makeInitial())
    expect(() => m.transition("unknown" as never, "final")).toThrow(/未知维度/)
  })

  it("全终态判定 + 清单顺序稳定", () => {
    const m = new DimensionManifest(makeInitial())
    expect(m.allFinal()).toBe(false)
    for (const id of ["author_fingerprint", "judge_pool", "l9_gate", "anti_ai"] as const) {
      m.transition(id, "comparing")
      m.transition(id, "passed")
      m.transition(id, "final")
    }
    expect(m.allFinal()).toBe(true)
    expect(m.list().map((e) => e.id)).toEqual(["author_fingerprint", "judge_pool", "l9_gate", "anti_ai"])
  })
})
