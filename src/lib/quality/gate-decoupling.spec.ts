/**
 * gate-decoupling.spec.ts — v2.7.0 解耦证明验收
 *
 * 覆盖：决策级一致率 / CI 下限 / 翻转红线 / 最小样本
 */
import { describe, expect, it } from "vitest"
import { DECOUPLING_MIN_N, DECOUPLING_RATE, evaluateDecoupling } from "./gate-decoupling"

const trio = (v: "pass" | "fail") => [
  { model: "m1", verdict: v },
  { model: "m2", verdict: v },
  { model: "m3", verdict: v },
]

describe("解耦证明 — 决策级一致率", () => {
  it("≥95% 且 CI 下限 ≥90% 且零翻转 → 证明通过", () => {
    const decisions = Array.from({ length: 40 }, () => trio("pass"))
    const r = evaluateDecoupling(decisions)
    expect(r.rate).toBe(1)
    expect(r.flips).toBe(0)
    expect(r.proven).toBe(true)
  })

  it("存在结论翻转 → 红线触发（证明失败）", () => {
    const decisions = Array.from({ length: 39 }, () => trio("pass"))
    decisions.push([
      { model: "m1", verdict: "pass" },
      { model: "m2", verdict: "fail" },
      { model: "m3", verdict: "pass" },
    ])
    const r = evaluateDecoupling(decisions)
    expect(r.flips).toBe(1)
    expect(r.proven).toBe(false)
  })

  it("样本不足（N<30）不判", () => {
    expect(evaluateDecoupling(Array.from({ length: 10 }, () => trio("pass"))).proven).toBe(false)
    expect(DECOUPLING_MIN_N).toBe(30)
  })

  it("阈值冻结", () => {
    expect(DECOUPLING_RATE).toBe(0.95)
  })

  it("三模型阵列不满 3 条时不参与计票（既不记一致也不记翻转）", () => {
    const decisions = Array.from({ length: 29 }, () => trio("pass"))
    // 残缺投票（只回 2 个模型）：既不能当一致，也不得当翻转——直接跳过
    decisions.push([
      { model: "m1", verdict: "pass" },
      { model: "m2", verdict: "fail" },
    ])
    // 另一条仅 1 个模型且与残缺票同向，用于证明「短票不翻转」不是巧合
    decisions.push([{ model: "m1", verdict: "fail" }])

    const r = evaluateDecoupling(decisions)

    expect(decisions).toHaveLength(31)
    // 分母仍是全部决策组数（N），一致数只含满 3 条的 29 组
    expect(r.rate).toBeCloseTo(29 / 31, 10)
    expect(r.flips).toBe(0)
  })
})
