import { STABLE_PREFIX_VERSION } from "./stable-prefix"
/** C4 冒烟覆盖：src/lib/llm-request-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import {
  CACHE_HIT_TARGET_MAIN_CHAT_PCT,
  CACHE_HIT_TARGET_REVIEW_REUSE_PCT,
  formatCacheHitReport,
  longestCommonPrefixLength,
  measurePrefixReuse,
  runCacheHitHarness,
} from "./cache-hit-harness"
import {
  MAX_LLM_REQUEST_CACHE_TRACES,
  buildLlmRequestPrefixDescriptor,
  buildLlmRequestCacheTrace,
  LlmRequestTraceCollector,
  copyLlmRequestCacheTrace,
  isLlmRequestCacheTrace,
  summarizeLlmCacheHits,
  summarizeLlmCacheHitsByProvider,
} from "./llm-request-trace"
import type { LlmConfig } from "@/stores/wiki-store"
describe("llm-request-trace.ts smoke", () => {
  it("exports MAX_LLM_REQUEST_CACHE_TRACES", () => {
    expect(MAX_LLM_REQUEST_CACHE_TRACES).toBeDefined()
  })
  it("exports buildLlmRequestPrefixDescriptor", () => {
    expect(buildLlmRequestPrefixDescriptor).toBeDefined()
  })
  it("exports buildLlmRequestCacheTrace", () => {
    expect(buildLlmRequestCacheTrace).toBeDefined()
  })
  it("exports LlmRequestTraceCollector", () => {
    expect(LlmRequestTraceCollector).toBeDefined()
  })
  it("exports copyLlmRequestCacheTrace", () => {
    expect(copyLlmRequestCacheTrace).toBeDefined()
  })
  it("exports isLlmRequestCacheTrace", () => {
    expect(isLlmRequestCacheTrace).toBeDefined()
  })
})

/**
 * collector 行为：gap 计算、乱序完成、纯读 snapshot、reset 隔离。
 *
 * 这些行为此前完全没有测试（本文件原只有「导出存在」冒烟）。而 gap 是
 * 区分「缓存没命中」与「缓存已过期」的唯一依据，算错会让缓存分析整体失真。
 */
describe("LlmRequestTraceCollector", () => {
  const trace = (startedAt: number, finishedAt: number, fingerprint = "a".repeat(64)) => ({
    provider: "anthropic" as const,
    model: "claude-sonnet-4-5",
    apiMode: "anthropic_messages",
    prefixFingerprint: fingerprint,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    status: "success" as const,
  })

  it("record 直接返回带 gap 的记录（无需 snapshot 回读）", () => {
    const c = new LlmRequestTraceCollector()
    const first = c.record(trace(1_000, 2_000))
    expect(first.startGapMs).toBeUndefined()
    expect(first.idleGapMs).toBeUndefined()

    const second = c.record(trace(5_000, 6_000))
    expect(second.startGapMs).toBe(4_000)
    expect(second.idleGapMs).toBe(3_000)
  })

  it("不同前缀不配对 gap", () => {
    const c = new LlmRequestTraceCollector()
    c.record(trace(1_000, 2_000, "a".repeat(64)))
    const other = c.record(trace(5_000, 6_000, "b".repeat(64)))
    expect(other.startGapMs).toBeUndefined()
    expect(other.idleGapMs).toBeUndefined()
  })

  it("乱序完成时仍按 startedAt 找真正的前一次（不是队尾）", () => {
    const c = new LlmRequestTraceCollector()
    // B 先完成先记录，但 A 的 startedAt 更早
    c.record(trace(100, 200)) // A
    c.record(trace(300, 400)) // B
    // C 的 startedAt 落在 A 与 B 之间，后完成
    const cTrace = c.record(trace(250, 500))
    // 正确的前一次是 A(100) 而非队尾 B(300)：gap = 250-100 = 150
    expect(cTrace.startGapMs).toBe(150)
    expect(cTrace.idleGapMs).toBe(50) // 250 - A.finishedAt(200)
  })

  it("snapshot 是纯读：重复调用结果一致且不修改缓冲", () => {
    const c = new LlmRequestTraceCollector()
    c.record(trace(1_000, 2_000))
    c.record(trace(5_000, 6_000))
    const a = c.snapshot()
    const b = c.snapshot()
    expect(a).toEqual(b)
    expect(a.requests[1]?.startGapMs).toBe(4_000)
  })

  it("reset 清空缓冲与 omitted，后续记录不再与旧数据配对", () => {
    const c = new LlmRequestTraceCollector()
    c.record(trace(1_000, 2_000))
    c.reset()
    expect(c.snapshot().requests).toHaveLength(0)
    expect(c.snapshot().omittedRequestCount).toBe(0)
    // 重置后第一次记录不应有 gap（否则就是串到了上一个用例/项目的数据）
    const fresh = c.record(trace(9_000, 10_000))
    expect(fresh.startGapMs).toBeUndefined()
    expect(fresh.idleGapMs).toBeUndefined()
  })

  it("超过上限时丢弃最旧并累计 omitted", () => {
    const c = new LlmRequestTraceCollector()
    for (let i = 0; i < MAX_LLM_REQUEST_CACHE_TRACES + 3; i += 1) {
      c.record(trace(i * 1_000, i * 1_000 + 500))
    }
    const snap = c.snapshot()
    expect(snap.requests).toHaveLength(MAX_LLM_REQUEST_CACHE_TRACES)
    expect(snap.omittedRequestCount).toBe(3)
  })
})

/**
 * G4b (TASK-006) F1: 命中统计字段读写。
 *
 * `cacheHit` / `savedTokens` 是「降费」结论的唯一机器可读来源：命中与否必须由
 * usage 决定，不能靠 `cacheReadTokens > 0` 之类的隐式推断在消费方各自重算。
 * `stablePrefixVersion` 接的是 TASK-005（stable-prefix.ts）的版本占位。
 */
describe("G4b 命中统计字段（cacheHit / savedTokens / 稳定前缀版本）", () => {
  const config: LlmConfig = {
    provider: "anthropic",
    apiKey: "k",
    model: "claude-sonnet-4-5",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 204_800,
  }
  const base = { config, startedAt: 1_000, finishedAt: 2_000, status: "success" as const }

  it("cachedInputTokens > 0 → cacheHit=true 且 savedTokens = 命中 token", () => {
    const trace = buildLlmRequestCacheTrace({
      ...base,
      usage: { inputTokens: 20_000, cachedInputTokens: 19_000 },
    })
    expect(trace.cacheHit).toBe(true)
    expect(trace.savedTokens).toBe(19_000)
    expect(trace.cacheReadTokens).toBe(19_000)
  })

  it("cachedInputTokens = 0 → cacheHit=false 且 savedTokens=0（未命中是已知结论）", () => {
    const trace = buildLlmRequestCacheTrace({
      ...base,
      usage: { inputTokens: 20_000, cachedInputTokens: 0 },
    })
    expect(trace.cacheHit).toBe(false)
    expect(trace.savedTokens).toBe(0)
  })

  it("无 usage（失败请求）→ 两个字段都不写，避免把「未知」记成「未命中」", () => {
    const trace = buildLlmRequestCacheTrace(base)
    expect(trace.cacheHit).toBeUndefined()
    expect(trace.savedTokens).toBeUndefined()
  })

  it("stablePrefix 占位：版本 + 哈希 + token 估算一次写全（TASK-005 对接）", () => {
    const trace = buildLlmRequestCacheTrace({
      ...base,
      stablePrefix: {
        version: 7,
        prefixFingerprint: "c".repeat(64),
        prefixEstimatedTokens: 812,
      },
    })
    expect(trace.stablePrefixVersion).toBe(7)
    expect(trace.prefixFingerprint).toBe("c".repeat(64))
    expect(trace.prefixEstimatedTokens).toBe(812)
  })

  it("显式 prefixFingerprint 优先于 stablePrefix（同一组字段，不产生双轨）", () => {
    const trace = buildLlmRequestCacheTrace({
      ...base,
      prefixFingerprint: "d".repeat(64),
      prefixEstimatedTokens: 100,
      stablePrefix: {
        version: 1,
        prefixFingerprint: "c".repeat(64),
        prefixEstimatedTokens: 812,
      },
    })
    expect(trace.prefixFingerprint).toBe("d".repeat(64))
    expect(trace.prefixEstimatedTokens).toBe(100)
    expect(trace.stablePrefixVersion).toBe(1)
  })

  it("copyLlmRequestCacheTrace 保留三个新字段（快照不丢命中信息）", () => {
    const trace = buildLlmRequestCacheTrace({
      ...base,
      stablePrefix: { version: 3, prefixFingerprint: "e".repeat(64), prefixEstimatedTokens: 42 },
      usage: { inputTokens: 900, cachedInputTokens: 600 },
    })
    const copy = copyLlmRequestCacheTrace(trace)
    expect(copy.cacheHit).toBe(true)
    expect(copy.savedTokens).toBe(600)
    expect(copy.stablePrefixVersion).toBe(3)
    expect(copy).toEqual(trace)
  })

  it("isLlmRequestCacheTrace 校验新字段类型（合法通过 / 非法拒绝）", () => {
    const valid = buildLlmRequestCacheTrace({
      ...base,
      stablePrefix: { version: 1, prefixFingerprint: "f".repeat(64), prefixEstimatedTokens: 10 },
      usage: { inputTokens: 100, cachedInputTokens: 90 },
    })
    expect(isLlmRequestCacheTrace(valid)).toBe(true)
    expect(isLlmRequestCacheTrace({ ...valid, cacheHit: "yes" })).toBe(false)
    expect(isLlmRequestCacheTrace({ ...valid, savedTokens: -1 })).toBe(false)
    expect(isLlmRequestCacheTrace({ ...valid, stablePrefixVersion: Number.NaN })).toBe(false)
  })
})

describe("G4b summarizeLlmCacheHits（单一口径汇总）", () => {
  const config: LlmConfig = {
    provider: "anthropic",
    apiKey: "k",
    model: "claude-sonnet-4-5",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 204_800,
  }
  const make = (cached: number | undefined, inputTokens: number, provider?: LlmConfig["provider"]) =>
    buildLlmRequestCacheTrace({
      config: provider ? { ...config, provider } : config,
      startedAt: 1_000,
      finishedAt: 2_000,
      status: "success",
      usage: {
        inputTokens,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      },
    })

  it("只统计有命中判定的请求（失败请求不算未命中）", () => {
    const stats = summarizeLlmCacheHits([make(900, 1_000), make(0, 500), make(undefined, 800)])
    expect(stats.requests).toBe(2)
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.hitRatePct).toBe(50)
    // inputTokens 仍包含失败请求的已知输入量（成本口径按真实发送量）
    expect(stats.inputTokens).toBe(2_300)
    expect(stats.savedTokens).toBe(900)
    expect(stats.savedInputPct).toBeCloseTo((900 / 2_300) * 100, 6)
  })

  it("空输入返回全零（不产生 NaN）", () => {
    const stats = summarizeLlmCacheHits([])
    expect(stats).toMatchObject({ requests: 0, hits: 0, hitRatePct: 0, savedInputPct: 0 })
  })

  it("按 provider 分组汇总（不同通道的命中语义不混算）", () => {
    const grouped = summarizeLlmCacheHitsByProvider([
      make(900, 1_000, "anthropic"),
      make(0, 1_000, "anthropic"),
      make(500, 1_000, "openai"),
    ])
    expect(grouped.anthropic?.hitRatePct).toBe(50)
    expect(grouped.openai?.hitRatePct).toBe(100)
    expect(Object.keys(grouped).sort()).toEqual(["anthropic", "openai"])
  })
})

/**
 * G4b (TASK-006) F2: 命中率 harness 的目标回归线。
 *
 * 目标线是**下限**，实测值原样钉在断言里（99.62% / 99.43%）。数字变化只有两种
 * 原因：请求组装变了（前缀不再复用）或体量参数变了（历史 : 新增 的比例变了）——
 * 两种都该让这里红，然后人工确认是优化还是回归。
 */
describe("G4b cache-hit harness（可重复实测）", () => {
  it("场景一 主对话二轮前缀复用：实测 99.62% ≥ 目标 99.6%", async () => {
    const report = await runCacheHitHarness()
    const main = report.scenarios[0]
    expect(main?.id).toBe("main-chat-second-turn")
    expect(main?.targetHitRatePct).toBe(CACHE_HIT_TARGET_MAIN_CHAT_PCT)
    expect(CACHE_HIT_TARGET_MAIN_CHAT_PCT).toBe(99.6)
    // 实测值（回归钉）：复用 47482 / 本轮输入 47665 tokens
    expect(main?.reusedTokens).toBe(47_482)
    expect(main?.currentTokens).toBe(47_665)
    expect(main?.hitRatePct).toBeCloseTo(99.616, 2)
    expect(main?.meetsTarget).toBe(true)
    expect(main?.gapPct).toBeGreaterThan(0)
  })

  it("场景二 审稿复用写作前缀：实测 99.43% ≥ 目标 99.3%", async () => {
    const report = await runCacheHitHarness()
    const review = report.scenarios[1]
    expect(review?.id).toBe("review-reuses-writing-prefix")
    expect(review?.targetHitRatePct).toBe(CACHE_HIT_TARGET_REVIEW_REUSE_PCT)
    expect(CACHE_HIT_TARGET_REVIEW_REUSE_PCT).toBe(99.3)
    // 实测值（回归钉）：复用 15869 / 本轮输入 15960 tokens
    expect(review?.reusedTokens).toBe(15_869)
    expect(review?.currentTokens).toBe(15_960)
    expect(review?.hitRatePct).toBeCloseTo(99.43, 2)
    expect(review?.meetsTarget).toBe(true)
  })

  it("重复跑两次得到同一组数字（harness 不读时钟、不依赖外部状态）", async () => {
    const first = await runCacheHitHarness()
    const second = await runCacheHitHarness()
    expect(second.scenarios).toEqual(first.scenarios)
    expect(second.measured).toEqual(first.measured)
    expect(second.simulated.stats).toEqual(first.simulated.stats)
  })

  it("落成的 trace 带稳定前缀版本、不带自测的缓存读数（禁止自证）", async () => {
    const report = await runCacheHitHarness()
    expect(report.traces).toHaveLength(2)
    for (const trace of report.traces) {
      // harness 不联网 → 没有上游 usage → 缓存读数字段必须缺席。
      expect(trace.cacheReadTokens).toBeUndefined()
      expect(trace.cacheHit).toBeUndefined()
      expect(trace.savedTokens).toBeUndefined()
      // G6 把 canonRules 纳入缓存段 → 版本 bump 到 2（版本真源在 stable-prefix.ts）
      expect(trace.stablePrefixVersion).toBe(STABLE_PREFIX_VERSION)
      expect(trace.prefixFingerprint).toMatch(/^[a-f0-9]{64}$/)
    }
    // 模拟层显式标注：数字是推演值，不是上游回报。
    expect(report.simulated.simulated).toBe(true)
    expect(report.simulated.stats.hits).toBe(2)
    const text = formatCacheHitReport(report)
    expect(text).toContain("99.6%")
    expect(text).toContain("99.3%")
    expect(text).toContain("实测汇总")
    expect(text).toContain("模拟汇总")
    expect(text).toContain("达标")
  })

  it("前缀复用测量是字节级的（差一个字符就不再算命中）", () => {
    expect(longestCommonPrefixLength("abcdef", "abcXef")).toBe(3)
    expect(measurePrefixReuse("abcdef", "abcXef").reusedChars).toBe(3)
    expect(measurePrefixReuse("abcdef", "abcdef").hitRatePct).toBe(100)
    expect(measurePrefixReuse("abcdef", "abcdef").currentChars).toBe(6)
  })
})
