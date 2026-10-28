/** C4 冒烟覆盖：src/lib/llm-request-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { MAX_LLM_REQUEST_CACHE_TRACES, buildLlmRequestPrefixDescriptor, buildLlmRequestCacheTrace, LlmRequestTraceCollector, copyLlmRequestCacheTrace, isLlmRequestCacheTrace } from "./llm-request-trace"
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
