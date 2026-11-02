/**
 * cache-hit-harness_biztest.spec.ts — 业务验收 B5（缓存降费：两场景实测数字）。
 *
 * 用户视角的问题：「说降费，到底省了多少？能不能重复跑出同一个数？」
 *
 * 这里不做任何口径发明：数字分两层。
 *   - **实测层**：请求体由真实稳定前缀组装函数拼出，复用按
 *     `serializeLlmRequestPayload` 的**字节级最长公共前缀**测量（`report.measured` /
 *     场景级 `hitRatePct`）；
 *   - **模拟层**（`report.simulated`，显式 `simulated: true`）：假设上游把实测复用量
 *     原样回报时的汇总，**不是**线上命中率；真实 trace 不带自测的缓存读数。
 * 目标线是**下限**，差距为负照实输出（不允许改口径凑数）。
 */
import { describe, expect, it } from "vitest"
import {
  CACHE_HIT_TARGET_MAIN_CHAT_PCT,
  CACHE_HIT_TARGET_REVIEW_REUSE_PCT,
  formatCacheHitReport,
  longestCommonPrefixLength,
  measurePrefixReuse,
  runCacheHitHarness,
} from "./cache-hit-harness"

describe("B5 场景一 · 主对话二轮前缀复用（目标 ≥ 99.6%）", () => {
  it("实测命中率达到 99.6% 目标线", async () => {
    const report = await runCacheHitHarness()
    const main = report.scenarios.find((scenario) => scenario.id === "main-chat-second-turn")
    expect(main).toBeDefined()

    // 可复现的实测数字（命令输出里原样打印，便于人工核对）。
    console.log(
      `[B5] 场景一 ${main!.hitRatePct.toFixed(2)}%`
        + `（目标 ≥ ${CACHE_HIT_TARGET_MAIN_CHAT_PCT}%）`
        + ` 复用 ${main!.reusedTokens}/${main!.currentTokens} tokens`
        + ` gap ${main!.gapPct.toFixed(2)}pp`,
    )

    expect(CACHE_HIT_TARGET_MAIN_CHAT_PCT).toBe(99.6)
    expect(main!.targetHitRatePct).toBe(99.6)
    expect(main!.meetsTarget).toBe(true)
    expect(main!.hitRatePct).toBeGreaterThanOrEqual(99.6)
    // 命中率是「复用 token / 本轮输入 token」，不能大于 100%（口径自洽）。
    expect(main!.reusedTokens).toBeLessThanOrEqual(main!.currentTokens)
  })
})

describe("B5 场景二 · 审稿复用写作前缀（目标 ≥ 99.3%）", () => {
  it("实测命中率达到 99.3% 目标线", async () => {
    const report = await runCacheHitHarness()
    const review = report.scenarios.find((scenario) => scenario.id === "review-reuses-writing-prefix")
    expect(review).toBeDefined()

    console.log(
      `[B5] 场景二 ${review!.hitRatePct.toFixed(2)}%`
        + `（目标 ≥ ${CACHE_HIT_TARGET_REVIEW_REUSE_PCT}%）`
        + ` 复用 ${review!.reusedTokens}/${review!.currentTokens} tokens`
        + ` gap ${review!.gapPct.toFixed(2)}pp`,
    )

    expect(CACHE_HIT_TARGET_REVIEW_REUSE_PCT).toBe(99.3)
    expect(review!.meetsTarget).toBe(true)
    expect(review!.hitRatePct).toBeGreaterThanOrEqual(99.3)
  })
})

describe("B5 可重复性与汇总（数字不是手写的）", () => {
  it("连跑两次得到同一组数字（不读时钟、不依赖外部状态）", async () => {
    const first = await runCacheHitHarness()
    const second = await runCacheHitHarness()
    expect(second.scenarios).toEqual(first.scenarios)
    expect(second.measured).toEqual(first.measured)
    expect(second.simulated.stats).toEqual(first.simulated.stats)
    expect(second.averageHitRatePct).toBe(first.averageHitRatePct)
  })

  it("实测层汇总只由字节级 LCP 得出（口径自洽，不冒充上游命中率）", async () => {
    const report = await runCacheHitHarness()
    expect(report.measured.basis).toBe("byte-lcp")
    expect(report.measured.requests).toBe(4) // 两个场景 × 2 条
    expect(report.measured.reusedTokens).toBeGreaterThan(0)
    expect(report.measured.reusedTokens).toBeLessThanOrEqual(report.measured.currentTokens)
    expect(report.measured.hitRatePct).toBeGreaterThan(99)
  })

  it("真实 trace 不带自测的缓存读数（禁止自证循环）", async () => {
    const report = await runCacheHitHarness()
    expect(report.traces.length).toBe(2)
    for (const trace of report.traces) {
      // harness 不联网 → 没有上游 usage → 缓存读数字段必须缺席。
      expect(trace.cacheReadTokens).toBeUndefined()
      expect(trace.cacheHit).toBeUndefined()
      expect(trace.savedTokens).toBeUndefined()
      // 能确认的量仍然落账（本轮输入 token）。
      expect(trace.inputTokens).toBeGreaterThan(0)
    }
  })

  it("模拟层显式标注 simulated，且与实测层分开报告", async () => {
    const report = await runCacheHitHarness()
    expect(report.simulated.simulated).toBe(true)
    expect(report.simulated.note.length).toBeGreaterThan(0)
    expect(report.simulated.stats.requests).toBe(2)
    expect(report.simulated.stats.hits).toBe(2)
    expect(report.simulated.stats.savedInputPct).toBeGreaterThan(99)

    // 交付物里贴的就是这一份可读输出（两层都写清口径）。
    const text = formatCacheHitReport(report)
    expect(text).toContain("场景一")
    expect(text).toContain("场景二")
    expect(text).toContain("实测汇总")
    expect(text).toContain("模拟汇总")
    expect(text).toContain("simulated")
    expect(text).toMatch(/99\.\d+%/)
    expect(text).toContain("达标")
  })

  it("复用口径是字节级前缀（同字节才命中，差一个字符就断）", () => {
    expect(longestCommonPrefixLength("abcdef", "abcxyz")).toBe(3)
    expect(longestCommonPrefixLength("same", "same")).toBe(4)
    expect(longestCommonPrefixLength("", "abc")).toBe(0)
    const measurement = measurePrefixReuse("prefix-A-tail", "prefix-B-tail")
    expect(measurement.reusedChars).toBe(7) // "prefix-"
    expect(measurement.currentChars).toBe("prefix-B-tail".length)
  })
})

/**
 * G4 实测层（`report.liveMeasured`）的边界纪律。
 *
 * harness 不联网、拿不到上游 `usage`，所以 `runCacheHitHarness()` 的实测层
 * **必须恒为 null**。这条用例存在的意义：如果有人为了让报告「好看」而拿
 * byte-lcp 或 simulated 的数字去填 liveMeasured，这里会立刻变红。
 */
describe("G4 实测层：未测时为空，且报告不得出现实测命中率数字", () => {
  it("runCacheHitHarness 的 liveMeasured 恒为 null", async () => {
    const report = await runCacheHitHarness()
    expect(report.liveMeasured).toBeNull()
  })

  it("人读报告不把实测层写成有数字的结论", async () => {
    const report = await runCacheHitHarness()
    const text = formatCacheHitReport(report)
    // 报告里可以出现 byte-lcp / simulated 的数字，但不得宣称「上游实测命中率」。
    expect(text).not.toMatch(/上游实测命中率[:：]\s*\d/)
    expect(text).not.toMatch(/liveMeasured[:：]\s*\d/)
  })
})
