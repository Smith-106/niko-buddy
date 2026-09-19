/**
 * ore-pricing.spec.ts — B4 矿脉计价骨架（批准计划 r3 §T7）。
 *
 * 断言面：
 *   1. 三候选模型边界（per-token / per-entry / subscription 各自计量量与单位）；
 *   2. 纯函数性：同输入 → 同输出（无副作用、无内部状态）；不内置默认价（费率必传）；
 *   3. 配额边界（预算内 / 恰好用尽 / 超额；跨币种 fail-loud）；
 *   4. 骨架≠可用：`pricingDecided` 恒 false；ORE 契约 `status:"pending"` / `enabled:false` /
 *      `isOrePipelineUsable()===false` 三重钉死。
 *
 * @license MIT © Niko Buddy
 */
import { describe, expect, it } from "vitest"
import {
  ORE_COST_ESTIMATE_SCHEMA,
  ORE_PRICING_MODEL_CANDIDATES,
  ORE_PRICING_MODEL_IDS,
  ORE_PRICING_MODEL_SCHEMA,
  OrePricingError,
  checkOreQuota,
  estimateOreCost,
  formatOrePricingSkeleton,
} from "./ore-pricing"
import {
  ORE_PIPELINE_CONTRACT_PLACEHOLDER,
  ORE_PIPELINE_CONTRACT_SCHEMA,
  isOrePipelineUsable,
} from "./retrieval-scale-placeholders"

describe("B4 矿脉计价骨架（estimateOreCost / checkOreQuota）", () => {
  it("三候选模型：计量量与单位各随其模型（费率由调用方给）", () => {
    const usage = { tokens: 1_000_000, entries: 250, periods: 3 }
    const token = estimateOreCost({ id: "per-token", rate: 0.002, currency: "CNY" }, usage)
    expect(token.quantity).toBe(1_000_000)
    expect(token.unit).toBe("token")
    expect(token.cost).toBeCloseTo(2000, 6)

    const entry = estimateOreCost({ id: "per-entry", rate: 1.5, currency: "CNY" }, usage)
    expect(entry.quantity).toBe(250)
    expect(entry.unit).toBe("entry")
    expect(entry.cost).toBeCloseTo(375, 6)

    const sub = estimateOreCost({ id: "subscription", rate: 99, currency: "CNY" }, usage)
    expect(sub.quantity).toBe(3)
    expect(sub.unit).toBe("period")
    expect(sub.cost).toBeCloseTo(297, 6)

    for (const est of [token, entry, sub]) {
      expect(ORE_COST_ESTIMATE_SCHEMA.safeParse(est).success).toBe(true)
      expect(est.pricingDecided).toBe(false)
      expect(est.breakdown).toContain("候选未拍板")
    }
  })

  it("候选清单冻结：三 id / decided=false / 无任何内置单价", () => {
    expect(ORE_PRICING_MODEL_IDS).toEqual(["per-token", "per-entry", "subscription"])
    expect(ORE_PRICING_MODEL_CANDIDATES.map((c) => c.id)).toEqual([...ORE_PRICING_MODEL_IDS])
    for (const c of ORE_PRICING_MODEL_CANDIDATES) expect(c.decided).toBe(false)
    expect(formatOrePricingSkeleton()).toContain("骨架不等于可用")
    // 元数据面不含 rate/price 字段（单价不得写死进代码）
    for (const c of ORE_PRICING_MODEL_CANDIDATES) {
      expect(Object.keys(c)).toEqual(["id", "label", "unit", "fit", "decided"])
    }
  })

  it("纯函数性：同输入同输出（重复调用结果字节相同、无隐藏状态）", () => {
    const a = estimateOreCost({ id: "per-entry", rate: 2, currency: "USD" }, { entries: 7 })
    const b = estimateOreCost({ id: "per-entry", rate: 2, currency: "USD" }, { entries: 7 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const q1 = checkOreQuota(a, { budget: 10, currency: "USD" })
    const q2 = checkOreQuota(a, { budget: 10, currency: "USD" })
    expect(JSON.stringify(q1)).toBe(JSON.stringify(q2))
  })

  it("配额边界：预算内 / 恰好用尽 / 超额（remaining 符号自明）", () => {
    const est = estimateOreCost({ id: "per-entry", rate: 2, currency: "CNY" }, { entries: 5 }) // cost=10
    const within = checkOreQuota(est, { budget: 100, currency: "CNY" })
    expect(within.within).toBe(true)
    expect(within.remaining).toBe(90)
    const exact = checkOreQuota(est, { budget: 10, currency: "CNY" })
    expect(exact.within).toBe(true)
    expect(exact.remaining).toBe(0)
    const over = checkOreQuota(est, { budget: 4, currency: "CNY" })
    expect(over.within).toBe(false)
    expect(over.remaining).toBe(-6)
    expect(over.note).toContain("超预算")
    expect(over.note).toContain("不得据此启用矿脉管道")
  })

  it("跨币种 / 非法入参 fail-loud（不静默降级）", () => {
    const est = estimateOreCost({ id: "per-token", rate: 1, currency: "CNY" }, { tokens: 10 })
    expect(() => checkOreQuota(est, { budget: 100, currency: "USD" })).toThrow(OrePricingError)
    expect(() => estimateOreCost({ id: "per-token", rate: -1, currency: "CNY" } as never, { tokens: 1 })).toThrow(
      OrePricingError,
    )
    expect(() => estimateOreCost({ id: "nope", rate: 1, currency: "CNY" } as never, { tokens: 1 })).toThrow(
      OrePricingError,
    )
    expect(() => estimateOreCost({ id: "per-token", rate: 1, currency: "CNY", extra: 1 } as never, {})).toThrow(
      OrePricingError,
    )
    expect(ORE_PRICING_MODEL_SCHEMA.safeParse({ id: "per-token", rate: 1 }).success).toBe(false)
    // 用量缺省按 0 计（不报错）：成本为 0
    expect(estimateOreCost({ id: "per-token", rate: 9, currency: "CNY" }, {}).cost).toBe(0)
  })

  it("骨架≠可用：pricing 三候选清单入契约（decided=false），状态仍 pending/disabled", () => {
    const pricing = ORE_PIPELINE_CONTRACT_PLACEHOLDER.pricing
    expect(pricing.status).toBe("pending")
    expect(pricing.unitPrice).toBeUndefined()
    expect(ORE_PIPELINE_CONTRACT_PLACEHOLDER.enabled).toBe(false)
    expect(isOrePipelineUsable(ORE_PIPELINE_CONTRACT_PLACEHOLDER)).toBe(false)
    expect(ORE_PIPELINE_CONTRACT_SCHEMA.safeParse(ORE_PIPELINE_CONTRACT_PLACEHOLDER).success).toBe(true)
    const models = pricing.models ?? []
    expect(models.map((m) => m.id)).toEqual([...ORE_PRICING_MODEL_IDS])
    for (const m of models) expect(m.decided).toBe(false)
    expect(pricing.note).toContain("待定")
  })
})
