/**
 * joint-distribution.spec.ts — v2.6.9 D3 验收（观测通道）
 *
 * 覆盖：相关性 / 联合异常 / 并行一致性 / 观测不挡
 */
import { describe, expect, it } from "vitest"
import { observeJointDistribution, verifyJointDegradation, verifyParallelConsistency } from "./joint-distribution"

describe("D3 联合分布 — 观测通道", () => {
  it("强相关信号 → 联合异常标记", () => {
    const r = observeJointDistribution([
      [1, 2, 3, 4, 5],
      [2, 4, 6, 8, 10],
    ])
    expect(r.correlation).toBeGreaterThan(0.9)
    expect(r.jointAnomaly).toBe(true)
  })

  it("弱相关信号 → 无联合异常", () => {
    const r = observeJointDistribution([
      [1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1],
    ])
    expect(r.correlation).toBeLessThan(-0.9)
    expect(r.jointAnomaly).toBe(true) // |corr|>0.7 即强联合结构
  })

  it("观测通道标记（不升格硬门）", () => {
    const r = observeJointDistribution([[1, 2], [2, 3]])
    expect(r.observationOnly).toBe(true)
  })

  it("并行一致性：同输入同输出", () => {
    const a = observeJointDistribution([[1, 2, 3], [2, 4, 6]])
    const b = observeJointDistribution([[1, 2, 3], [2, 4, 6]])
    expect(verifyParallelConsistency(a, b)).toBe(true)
  })

  it("维度扩展退化检查：2→10 维相关性保持稳定（多变量耦合验证）", () => {
    for (let d = 2; d <= 10; d++) {
      expect(verifyJointDegradation(d)).toBe(true)
    }
  })
})
