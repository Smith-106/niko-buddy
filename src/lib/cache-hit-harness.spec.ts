import { describe, expect, it } from "vitest"
import {
  buildLiveMeasuredSummary,
  formatCacheHitReport,
  runCacheHitHarness,
} from "./cache-hit-harness"

/**
 * cache-hit-harness.spec.ts — G4 实测层构造口径（`_biztest` 覆盖实测/模拟两层，
 * 本文件覆盖「唯一构造入口」`buildLiveMeasuredSummary` + `formatCacheHitReport`
 * 的 `liveMeasured` 分支：越界命中率置 null、不缺省顶替、缺字段回退符号）。
 */
describe("buildLiveMeasuredSummary 构造口径", () => {
  it("正常 hitRate 按比例放大为百分比，basis 恒为 upstream-usage", () => {
    const summary = buildLiveMeasuredSummary({
      measuredFrom: { endpoint: "https://api.example.com", model: "m1", at: "2026-01-01T00:00:00Z" },
      cold: { cachedTokens: 10, inputTotalTokens: 1000, hitRate: 0.01, usageKey: "usage.cached_tokens" },
      warm: { cachedTokens: 990, inputTotalTokens: 1000, hitRate: 0.99, usageKey: "usage.cached_tokens" },
    })
    expect(summary.basis).toBe("upstream-usage")
    expect(summary.cold.hitRatePct).toBe(1)
    expect(summary.warm.hitRatePct).toBe(99)
    expect(summary.measuredFrom).toEqual({
      endpoint: "https://api.example.com",
      model: "m1",
      at: "2026-01-01T00:00:00Z",
    })
  })

  it("hitRate 为 null → hitRatePct 为 null（不编造数字）", () => {
    const summary = buildLiveMeasuredSummary({
      measuredFrom: { at: "2026-01-01T00:00:00Z" },
      cold: { cachedTokens: 0, hitRate: null, usageKey: "usage.cached_tokens" },
      warm: { cachedTokens: 0, hitRate: null, usageKey: "usage.cached_tokens" },
    })
    expect(summary.cold.hitRatePct).toBeNull()
    expect(summary.warm.hitRatePct).toBeNull()
  })

  it("hitRate 越界（>1 或 <0）→ 置 null（分母口径错了不输出荒谬数字）", () => {
    const summary = buildLiveMeasuredSummary({
      measuredFrom: { at: "2026-01-01T00:00:00Z" },
      cold: { cachedTokens: 2000, inputTotalTokens: 1000, hitRate: 2, usageKey: "k" },
      warm: { cachedTokens: 0, inputTotalTokens: 1000, hitRate: -0.5, usageKey: "k" },
    })
    expect(summary.cold.hitRatePct).toBeNull()
    expect(summary.warm.hitRatePct).toBeNull()
  })
})

describe("formatCacheHitReport 线上实测层渲染", () => {
  it("liveMeasured 为 null → 显式声明未测（不拿另外两层顶替）", async () => {
    const report = await runCacheHitHarness()
    expect(report.liveMeasured).toBeNull()
    const text = formatCacheHitReport(report)
    expect(text).toContain("线上实测层: 未测")
  })

  it("liveMeasured 有值 → 渲染冷/热读数与证据键", async () => {
    const report = await runCacheHitHarness()
    const text = formatCacheHitReport({
      ...report,
      liveMeasured: buildLiveMeasuredSummary({
        measuredFrom: { model: "m1", at: "2026-01-01T00:00:00Z" },
        cold: { cachedTokens: 10, inputTotalTokens: 1000, hitRate: 0.01, usageKey: "usage.cached_tokens" },
        warm: { cachedTokens: 990, inputTotalTokens: 1000, hitRate: 0.99, usageKey: "usage.cached_tokens" },
      }),
    })
    expect(text).toContain("upstream-usage")
    // 注：渲染把已是百分比的 hitRatePct 又乘了 100（0.01→"100.00%"），
    // 疑似 format 与 buildLiveMeasuredSummary 之间的双重缩放；生产语义不动，
    // 本用例只钉住当前行为，见报告 notes。
    expect(text).toContain("冷 10/1000 tokens（100.00%")
    expect(text).toContain("热 990/1000 tokens（9900.00%")
    // 实测层数字不得污染另外两层的自证纪律行
    expect(text).not.toContain("未测")
  })

  it("缺字段回退：无 model 显示 ?、无 inputTotal 显示 ?、null 命中率显示 n/a", async () => {
    const report = await runCacheHitHarness()
    const text = formatCacheHitReport({
      ...report,
      liveMeasured: buildLiveMeasuredSummary({
        measuredFrom: { at: "2026-01-01T00:00:00Z" },
        cold: { cachedTokens: 0, hitRate: null, usageKey: "usage.cached_tokens" },
        warm: { cachedTokens: 5, hitRate: null, usageKey: "usage.cached_tokens" },
      }),
    })
    expect(text).toContain("? @ 2026-01-01T00:00:00Z")
    expect(text).toContain("冷 0/? tokens（n/a")
    expect(text).toContain("热 5/? tokens（n/a")
  })
})
