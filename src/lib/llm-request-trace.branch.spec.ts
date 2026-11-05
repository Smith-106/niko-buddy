import { describe, expect, it } from "vitest"
import { estimateChatMessagesTokens } from "@/lib/chat-request-budget"
import {
  buildLlmRequestCacheTrace,
  buildLlmRequestPrefixDescriptor,
  isLlmRequestCacheTrace,
  LlmRequestTraceCollector,
  serializeLlmRequestPayload,
  summarizeLlmCacheHits,
} from "./llm-request-trace"
import type { ChatMessage } from "./llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"

const baseConfig: LlmConfig = {
  provider: "anthropic",
  apiKey: "k",
  model: "claude-sonnet-4-5",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 204_800,
}

function traceAt(startedAt: number, finishedAt: number, fingerprint = "a".repeat(64)) {
  return {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-5",
    apiMode: "anthropic_messages",
    prefixFingerprint: fingerprint,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    status: "success" as const,
  }
}

/**
 * llm-request-trace.ts 分支补测（覆盖率战役第九批）。
 */
describe("llm-request-trace branch coverage", () => {
  it("custom 无 apiMode 回 chat_completions（73 右支）", () => {
    const t = buildLlmRequestCacheTrace({
      config: { ...baseConfig, provider: "custom" },
      startedAt: 1,
      finishedAt: 2,
      status: "success",
    })
    expect(t.apiMode).toBe("chat_completions")
  })

  it("google 走 gemini_generate_content（75 真支）", () => {
    const t = buildLlmRequestCacheTrace({
      config: { ...baseConfig, provider: "google" },
      startedAt: 1,
      finishedAt: 2,
      status: "success",
    })
    expect(t.apiMode).toBe("gemini_generate_content")
  })

  it("azure 走 azure_chat_completions（76 真支）", () => {
    const t = buildLlmRequestCacheTrace({
      config: { ...baseConfig, provider: "azure" },
      startedAt: 1,
      finishedAt: 2,
      status: "success",
    })
    expect(t.apiMode).toBe("azure_chat_completions")
  })

  it("prefix 描述器识别显式断点并切片（93/102 真支）", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "第一段" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "稳定前缀", cacheControl: true },
          { type: "text", text: "尾部增量" },
        ],
      },
    ]
    const desc = await buildLlmRequestPrefixDescriptor(
      { ...baseConfig, provider: "anthropic" },
      messages,
    )
    expect(desc.prefixFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(desc.prefixEstimatedTokens).toBeGreaterThan(0)
    // 断点必须精确停在最后一个**带 cacheControl 的文本块**：末尾无 cacheControl 的
    // 「尾部增量」不得进入前缀。只断言 tokens>0 对边界错误毫无断力——把 L93 的
    // `&&` 变异成 `||` 后，末尾块也会被算进前缀，token 估算变大，但那两条断言照样绿。
    const expectedPrefix: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "第一段" }] },
      { role: "user", content: [{ type: "text", text: "稳定前缀", cacheControl: true }] },
    ]
    expect(desc.prefixEstimatedTokens).toBe(estimateChatMessagesTokens(expectedPrefix))
  })

  it("serialize 保留 image 块与工具/推理字段（117/120-123 真支）", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          {
            type: "image",
            mediaType: "image/png",
            dataBase64: "aGVsbG8=",
          },
        ],
        tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }],
        tool_call_id: "tc1",
        name: "u1",
        reasoning_content: "想一想",
      },
    ]
    const payload = serializeLlmRequestPayload(messages)
    expect(payload).toContain("image/png")
    expect(payload).toContain("tool_calls")
    expect(payload).toContain("tool_call_id")
    expect(payload).toContain("u1")
    expect(payload).toContain("reasoning_content")
  })

  it("trace 无前缀估算时两字段都缺席（152 全空支）", () => {
    const t = buildLlmRequestCacheTrace({
      config: baseConfig,
      startedAt: 1,
      finishedAt: 2,
      status: "success",
    })
    expect(t.prefixEstimatedTokens).toBeUndefined()
    expect(t.prefixFingerprint).toBeUndefined()
  })

  it("同 startedAt 双记录命中 best 不更新支（251 假支）", () => {
    const c = new LlmRequestTraceCollector()
    c.record(traceAt(1_000, 1_100))
    c.record(traceAt(1_000, 1_150))
    const later = c.record(traceAt(2_000, 2_100))
    expect(later.startGapMs).toBe(1_000)
    expect(later.idleGapMs).toBe(900)
  })

  it("isLlmRequestCacheTrace 拒绝非对象（296 真支）", () => {
    expect(isLlmRequestCacheTrace(null)).toBe(false)
    expect(isLlmRequestCacheTrace("trace")).toBe(false)
    expect(isLlmRequestCacheTrace(42)).toBe(false)
  })

  it("isLlmRequestCacheTrace 接受 cancelled/network_error 并拒绝非法 status", () => {
    const ok = buildLlmRequestCacheTrace({
      config: baseConfig,
      startedAt: 1,
      finishedAt: 2,
      status: "success",
    })
    expect(isLlmRequestCacheTrace({ ...ok, status: "cancelled" })).toBe(true)
    expect(isLlmRequestCacheTrace({ ...ok, status: "network_error" })).toBe(true)
    expect(isLlmRequestCacheTrace({ ...ok, status: "weird" })).toBe(false)
  })

  it("summarize 无 inputTokens 的失败 trace 按 0 累加（378 右支）", () => {
    const stats = summarizeLlmCacheHits([
      {
        provider: "anthropic",
        model: "m",
        apiMode: "anthropic_messages",
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        status: "error",
      },
    ])
    expect(stats.inputTokens).toBe(0)
    expect(stats.requests).toBe(0)
  })

  it("summarize 回退 cacheReadTokens/0（383 右支）", () => {
    const withRead = {
      provider: "anthropic" as const,
      model: "m",
      apiMode: "anthropic_messages",
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      status: "success" as const,
      cacheHit: true as const,
      cacheReadTokens: 500,
    }
    const bareHit = {
      provider: "anthropic" as const,
      model: "m",
      apiMode: "anthropic_messages",
      startedAt: 3,
      finishedAt: 4,
      durationMs: 1,
      status: "success" as const,
      cacheHit: false as const,
    }
    const stats = summarizeLlmCacheHits([withRead, bareHit])
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.savedTokens).toBe(500)
    expect(stats.cachedInputTokens).toBe(500)
  })
})
